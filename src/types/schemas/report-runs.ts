import { z } from "zod";

// Bowst: the "Run report" form and the report runner's job shape.

export const REPORT_RUN_DATE_RANGES = [
  "last 28 days",
  "last 3 months",
  "last 6 months",
  "last 12 months",
] as const;

export const reportRunOptionsSchema = z.object({
  audit: z.enum(["reuse", "new", "none"]),
  maxPages: z.number().int().min(10).max(10_000),
  lighthouse: z.boolean(),
  renderJavaScript: z.boolean(),
  dateRange: z.enum(REPORT_RUN_DATE_RANGES),
  creditBudget: z.number().int().min(0).max(10_000),
  focus: z.string().trim().max(2_000),
  startUrl: z.string(),
});

export type ReportRunOptions = z.infer<typeof reportRunOptionsSchema>;

export const reportRunJobSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  templateName: z.string(),
  options: reportRunOptionsSchema.partial(),
  status: z.enum(["queued", "running", "done", "failed"]),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  reportUrl: z.string().nullable().optional(),
  error: z.string().optional(),
});

export type ReportRunJob = z.infer<typeof reportRunJobSchema>;
