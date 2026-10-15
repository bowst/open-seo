import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ReportRunService } from "@/server/features/reports/services/ReportRunService";
import { AppError } from "@/server/lib/errors";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { reportRunOptionsSchema } from "@/types/schemas/report-runs";

// Bowst: the "Run report" button. The `projectId` field in each validator is
// what triggers project authorization (ADR 0001).

const projectScopeSchema = z.object({ projectId: z.string().min(1) });

const startSchema = z.object({
  projectId: z.string().min(1),
  templateId: z.string().min(1),
  options: reportRunOptionsSchema.omit({ startUrl: true }),
});

export const listReportRuns = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopeSchema)
  .handler(async ({ context }) => ReportRunService.listRuns(context.projectId));

export const startReportRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startSchema)
  .handler(async ({ data, context }) => {
    try {
      const job = await ReportRunService.startRun({
        project: context.project,
        templateId: data.templateId,
        options: data.options,
      });
      return { ok: true as const, job };
    } catch (error) {
      // Thrown errors reach the client stripped to their code; a refusal is
      // the answer the form shows.
      if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
        return { ok: false as const, message: error.message };
      }
      throw error;
    }
  });
