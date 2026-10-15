import { env } from "cloudflare:workers";
import { z } from "zod";
import { ReportTemplateService } from "@/server/features/reports/services/ReportTemplateService";
import { AppError } from "@/server/lib/errors";
import type {
  ReportRunJob,
  ReportRunOptions,
} from "@/types/schemas/report-runs";
import { reportRunJobSchema } from "@/types/schemas/report-runs";

// Bowst: hands a "Run report" job to the report runner on the Docker host
// (bowst/report-runner), which writes the report with Claude Code over MCP and
// saves it back through save_report. The app only queues and reads status.

function runnerConfig() {
  const url = env.REPORT_RUNNER_URL?.trim();
  const token = env.REPORT_RUNNER_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function callRunner(path: string, init?: RequestInit): Promise<unknown> {
  const config = runnerConfig();
  if (!config) {
    throw new AppError("VALIDATION_ERROR", "The report runner is not set up.");
  }
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
    });
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "The report runner is not answering. Check the launchd agent on the host.",
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = z.object({ error: z.string() }).safeParse(body);
    throw new AppError(
      "VALIDATION_ERROR",
      message.success
        ? `Report runner: ${message.data.error}`
        : `Report runner answered ${response.status}.`,
    );
  }
  return body;
}

type RunnerStatus = "unconfigured" | "unreachable" | "ready";

// Never throws for a runner that is down: the Reports page polls this, and a
// stopped runner should show as a notice, not break the page.
async function listRuns(
  projectId: string,
): Promise<{ runner: RunnerStatus; jobs: ReportRunJob[] }> {
  if (!runnerConfig()) return { runner: "unconfigured", jobs: [] };
  try {
    const body = await callRunner(
      `/jobs?projectId=${encodeURIComponent(projectId)}`,
    );
    const parsed = z.object({ jobs: z.array(reportRunJobSchema) }).parse(body);
    return { runner: "ready", jobs: parsed.jobs };
  } catch {
    return { runner: "unreachable", jobs: [] };
  }
}

async function startRun(params: {
  project: { id: string; name: string; domain: string | null };
  templateId: string;
  options: Omit<ReportRunOptions, "startUrl">;
}): Promise<ReportRunJob> {
  if (!params.project.domain) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Set this project's website before running a report.",
    );
  }
  // The full brief: MCP's list_report_templates only returns a preview, so the
  // runner cannot fetch the instructions itself.
  const template = await ReportTemplateService.getReportTemplate(
    params.project.id,
    params.templateId,
  );
  const domain = params.project.domain.replace(/^https?:\/\//, "");
  const body = await callRunner("/jobs", {
    method: "POST",
    body: JSON.stringify({
      projectId: params.project.id,
      projectName: params.project.name,
      templateId: template.id,
      templateName: template.name,
      instructions: template.instructions,
      options: { ...params.options, startUrl: `https://${domain}` },
    }),
  });
  return z.object({ job: reportRunJobSchema }).parse(body).job;
}

export const ReportRunService = { listRuns, startRun } as const;
