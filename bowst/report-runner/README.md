# Report runner (Bowst)

Backs the **Run report** button on a project's Reports page. The app posts a
job (template, full instructions, options); the runner writes the report with a
headless Claude Code session (`claude -p`) that works through the `openseo` MCP
and saves it with `save_report`. One job at a time; jobs persist in
`~/Library/Application Support/seo-report-runner/jobs.json`, logs per job in
`logs/<job id>.log` beside it.

## Install on the Docker host

Requirements: `node` and a logged-in `claude` on PATH, with the `openseo` MCP
configured at user scope (`claude mcp list` shows it).

```sh
bowst/report-runner/install.sh
```

It creates a token, installs the `com.bowst.seo-report-runner` launchd agent
(loopback, port 4319) and prints three lines for OpenSEO's `.env`:

```
REPORT_RUNNER_URL=http://host.docker.internal:4319
REPORT_RUNNER_TOKEN=...
REPORT_AUTHOR_LABEL=Bowst
```

Add them, rebuild the image, and `docker compose up -d`. The button appears
only when `REPORT_RUNNER_URL` and `REPORT_RUNNER_TOKEN` are set.

## API

All but `/health` need `Authorization: Bearer <token>`.

- `GET /health`
- `GET /jobs?projectId=` — last 10 jobs, newest first
- `POST /jobs` — `{ projectId, projectName, templateId, templateName, instructions, options }`

The prompt, including the lessons from the manual runs, is `buildPrompt` in
`runner.mjs`.
