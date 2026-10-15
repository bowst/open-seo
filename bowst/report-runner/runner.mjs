#!/usr/bin/env node
// Bowst report runner. The OpenSEO app's "Run report" button posts a job here;
// the runner writes the report with a headless Claude Code session that works
// through the openseo MCP and saves it with save_report. One job at a time.
//
// Runs on the Docker host (the mini) as a launchd agent; see install.sh. No
// dependencies beyond Node itself.

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = process.env.RUNNER_HOST || "127.0.0.1";
const PORT = Number(process.env.RUNNER_PORT || 4319);
const TOKEN = process.env.RUNNER_TOKEN || "";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const HOME = process.env.RUNNER_HOME || join(homedir(), "Library/Application Support/seo-report-runner");
const JOB_TIMEOUT_MS = Number(process.env.RUNNER_JOB_TIMEOUT_MIN || 90) * 60_000;
const KEEP_JOBS = 200;

if (!TOKEN) {
  console.error("RUNNER_TOKEN is not set; refusing to start.");
  process.exit(1);
}

const WORK_DIR = join(HOME, "work");
const LOG_DIR = join(HOME, "logs");
const JOBS_FILE = join(HOME, "jobs.json");
for (const dir of [HOME, WORK_DIR, LOG_DIR]) mkdirSync(dir, { recursive: true });

/** @type {Array<Record<string, any>>} newest last */
let jobs = existsSync(JOBS_FILE) ? JSON.parse(readFileSync(JOBS_FILE, "utf8")) : [];
// A job still marked active belonged to a runner that died mid-run.
for (const job of jobs) {
  if (job.status === "running" || job.status === "queued") {
    job.status = "failed";
    job.error = "The runner restarted before this job finished.";
    job.finishedAt = new Date().toISOString();
  }
}
saveJobs();

function saveJobs() {
  jobs = jobs.slice(-KEEP_JOBS);
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

/** What the app sees: never the prompt or the template text. */
function publicJob(job) {
  const { instructions: _instructions, ...rest } = job;
  return rest;
}

// ---------------------------------------------------------------- prompt

const AUDIT_LINES = {
  reuse: () =>
    "Site audit: use the project's most recent completed site audit (list_site_audits, then get_audit_issues and get_audit_pages). Do not start a new crawl.",
  new: (o) =>
    `Site audit: start a new site audit of ${o.startUrl} with run_site_audit, maxPages ${o.maxPages}, runLighthouse ${o.lighthouse}, renderJavaScript ${o.renderJavaScript}. ` +
    "Poll get_audit_status, waiting with the Bash command sleep 120 between checks. If Lighthouse has not finished 20 minutes after crawling ends, continue without it. " +
    "Read the results with get_audit_issues and get_audit_pages. If the crawl stops at the page cap, say so in the report's data limits.",
  none: () => "Site audit: do not use one.",
};

function buildPrompt(job) {
  const o = job.options;
  const lines = [
    `You are writing an SEO report for the OpenSEO project "${job.projectName}" (projectId ${job.projectId}, website ${o.startUrl}).`,
    "Work only through the openseo MCP tools. Nobody is watching this session: do not ask questions. Make reasonable choices and state them in the report's data limits.",
    "",
    `Follow the report template "${job.templateName}" (templateId ${job.templateId}). Its instructions replace any default report format:`,
    "<template>",
    job.instructions,
    "</template>",
    "",
    "Inputs chosen for this run:",
    "- " + AUDIT_LINES[o.audit](o),
    `- Search Console and Google Analytics window: ${o.dateRange}.`,
    `- Credit budget: spend at most ${o.creditBudget} OpenSEO credits on paid research tools. Use the free sources first (get_project_context, Search Console, Google Analytics, audit reads).`,
  ];
  if (o.focus) lines.push(`- Focus from the person who started this run: ${o.focus}`);
  lines.push(
    "",
    "Rules:",
    "- Call get_project_context first and ground the report in it.",
    "- Quote organic positions as rank_group, never rank_absolute.",
    "- SERP results confirm a People Also Ask box but return no question text. Do not invent questions.",
    "- The audit's inSitemap match is incomplete on large sites. Do not report orphan pages from it.",
    "- Links to /cdn-cgi/l/email-protection show as 404s but work for visitors. Ignore them.",
    "- Lighthouse scores are not exposed over MCP. Do not state scores you could not read.",
    "- Writing: plain language, American spelling, and no em dashes anywhere (recast with a comma, colon, parentheses or a full stop).",
    "- The HTML must be one self-contained document with inline CSS and no external requests. It must contain no backticks and no dollar sign followed by an opening brace.",
    `- Save it with save_report as a new report: a specific title that names the report type and the full date, a summary with the verdict, the single top action and the key numbers, skill "report-runner", and templateId ${job.templateId}.`,
    "- Your final message is one line: the report URL that save_report returned.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------- queue

let active = null;

function pump() {
  if (active) return;
  const next = jobs.find((job) => job.status === "queued");
  if (!next) return;
  active = next;
  run(next).finally(() => {
    active = null;
    pump();
  });
}

function run(job) {
  return new Promise((resolve) => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    saveJobs();

    const log = createWriteStream(join(LOG_DIR, `${job.id}.log`));
    const prompt = buildPrompt(job);
    log.write(`--- prompt\n${prompt}\n--- output\n`);

    const child = spawn(
      CLAUDE_BIN,
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--allowedTools",
        "mcp__openseo",
        "Bash(sleep:*)",
      ],
      { cwd: WORK_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => log.write(chunk));

    const timer = setTimeout(() => {
      job.error = `Stopped after ${JOB_TIMEOUT_MS / 60_000} minutes.`;
      child.kill("SIGTERM");
    }, JOB_TIMEOUT_MS);

    const finish = (code) => {
      clearTimeout(timer);
      log.end();
      let result = null;
      try {
        result = JSON.parse(stdout);
      } catch {}
      const text = typeof result?.result === "string" ? result.result : "";
      const reportUrl = text.match(/https?:\/\/\S+\/reports\/[0-9a-f-]{36}/)?.[0] ?? null;

      job.finishedAt = new Date().toISOString();
      job.reportUrl = reportUrl;
      if (code === 0 && result && !result.is_error && reportUrl) {
        job.status = "done";
      } else {
        job.status = "failed";
        job.error ??=
          text.slice(0, 500) ||
          `Claude Code exited with code ${code}. See ${join(LOG_DIR, `${job.id}.log`)}.`;
      }
      saveJobs();
      resolve();
    };
    child.on("error", (error) => {
      job.error = `Could not start Claude Code (${CLAUDE_BIN}): ${error.message}`;
      finish(-1);
    });
    child.on("close", finish);
  });
}

// ---------------------------------------------------------------- http

const AUDIT_MODES = new Set(["reuse", "new", "none"]);

/** Returns an error string, or null when the body is a valid job. */
function validate(body) {
  const o = body?.options;
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  for (const key of ["projectId", "projectName", "templateId", "templateName", "instructions"]) {
    if (typeof body[key] !== "string" || !body[key].trim()) return `${key} is required.`;
  }
  if (!o || typeof o !== "object") return "options is required.";
  if (!AUDIT_MODES.has(o.audit)) return "options.audit must be reuse, new or none.";
  if (typeof o.startUrl !== "string" || !/^https?:\/\//.test(o.startUrl)) return "options.startUrl must be a URL.";
  if (!Number.isInteger(o.maxPages) || o.maxPages < 10 || o.maxPages > 10000) return "options.maxPages must be 10 to 10,000.";
  if (!Number.isInteger(o.creditBudget) || o.creditBudget < 0) return "options.creditBudget must be a whole number.";
  if (typeof o.dateRange !== "string") return "options.dateRange is required.";
  return null;
}

function authorized(req) {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("Body too large.");
  }
  return JSON.parse(raw);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://runner");
  if (url.pathname === "/health") return send(res, 200, { ok: true, active: active?.id ?? null });
  if (!authorized(req)) return send(res, 401, { error: "Unauthorized." });

  if (url.pathname === "/jobs" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId");
    const list = jobs
      .filter((job) => !projectId || job.projectId === projectId)
      .slice(-10)
      .reverse()
      .map(publicJob);
    return send(res, 200, { jobs: list });
  }

  if (url.pathname === "/jobs" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: "Body must be JSON under 200 KB." });
    }
    const error = validate(body);
    if (error) return send(res, 400, { error });

    const job = {
      id: randomUUID(),
      projectId: body.projectId,
      projectName: body.projectName,
      templateId: body.templateId,
      templateName: body.templateName,
      instructions: body.instructions,
      options: body.options,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    jobs.push(job);
    saveJobs();
    pump();
    return send(res, 202, { job: publicJob(job) });
  }

  send(res, 404, { error: "Not found." });
}).listen(PORT, HOST, () => {
  console.log(`report runner listening on http://${HOST}:${PORT} (claude: ${CLAUDE_BIN})`);
});
