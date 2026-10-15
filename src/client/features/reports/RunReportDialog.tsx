import { revalidateLogic, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { reportTemplatesQueryKey } from "@/client/features/reports/shared";
import { listReportTemplates } from "@/serverFunctions/reportTemplates";
import { startReportRun } from "@/serverFunctions/reportRuns";
import { REPORT_RUN_DATE_RANGES } from "@/types/schemas/report-runs";

// Bowst: starts a report on the report runner (Claude Code on the Docker host).
// Every option here becomes a line in the runner's prompt.

export const reportRunsQueryKey = (projectId: string) =>
  ["report-runs", projectId] as const;

const AUDIT_ITEMS = [
  { value: "reuse", label: "Reuse the latest site audit" },
  { value: "new", label: "Run a new site audit" },
  { value: "none", label: "No site audit" },
] as const;

const DATE_ITEMS = REPORT_RUN_DATE_RANGES.map((range) => ({
  value: range,
  label: range[0].toUpperCase() + range.slice(1),
}));

const BUDGET_ITEMS = [
  { value: "0", label: "0 (free sources only)" },
  { value: "500", label: "Up to 500 credits" },
  { value: "1000", label: "Up to 1,000 credits" },
  { value: "2000", label: "Up to 2,000 credits" },
] as const;

const formSchema = z.object({
  templateId: z.string().min(1, "Pick a template."),
  audit: z.enum(["reuse", "new", "none"]),
  maxPages: z
    .string()
    .regex(/^\d+$/, "A whole number.")
    .refine((value) => {
      const pages = Number(value);
      return pages >= 10 && pages <= 10_000;
    }, "Between 10 and 10,000."),
  lighthouse: z.boolean(),
  renderJavaScript: z.boolean(),
  dateRange: z.enum(REPORT_RUN_DATE_RANGES),
  creditBudget: z.enum(["0", "500", "1000", "2000"]),
  focus: z.string().max(2_000, "Keep it under 2,000 characters."),
});

type FormValues = z.infer<typeof formSchema>;

export function RunReportDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<FormValues | null>(null);

  const templatesQuery = useQuery({
    queryKey: reportTemplatesQueryKey(projectId),
    queryFn: () => listReportTemplates({ data: { projectId } }),
    staleTime: 0,
  });
  const templates = templatesQuery.data?.templates ?? [];
  const templateItems = templates.map((t) => ({ value: t.id, label: t.name }));

  const startMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const result = await startReportRun({
        data: {
          projectId,
          templateId: values.templateId,
          options: {
            audit: values.audit,
            maxPages: Number(values.maxPages),
            lighthouse: values.lighthouse,
            renderJavaScript: values.renderJavaScript,
            dateRange: values.dateRange,
            creditBudget: Number(values.creditBudget),
            focus: values.focus.trim(),
          },
        },
      });
      if (!result.ok) throw new Error(result.message);
      return result.job;
    },
    onSuccess: () => {
      toast.success("Report queued. It appears here when the runner saves it.");
      void queryClient.invalidateQueries({
        queryKey: reportRunsQueryKey(projectId),
      });
      onClose();
    },
    onSettled: () => setPending(null),
  });

  const form = useAppForm({
    defaultValues: {
      templateId: "",
      audit: "reuse",
      maxPages: "500",
      lighthouse: false,
      renderJavaScript: false,
      dateRange: "last 28 days",
      creditBudget: "1000",
      focus: "",
    } as FormValues,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: formSchema },
    // The confirm step spends credits and Claude Code time; submit only opens it.
    onSubmit: ({ value }) => setPending(value),
  });
  const values = useStore(form.store, (state) => state.values);
  const templateName = templates.find(
    (t) => t.id === pending?.templateId,
  )?.name;

  if (pending) {
    return (
      <ConfirmDialog
        title="Run this report?"
        confirmLabel="Run report"
        pending={startMutation.isPending}
        onClose={() => setPending(null)}
        onConfirm={() => startMutation.mutate(pending)}
      >
        Claude Code on the mini writes "{templateName}" and saves it to this
        project, usually in 10 to 40 minutes.{" "}
        {pending.audit === "new"
          ? `It starts a new ${Number(pending.maxPages).toLocaleString()}-page crawl first. `
          : null}
        {pending.creditBudget === "0"
          ? "It uses free sources only."
          : `It may spend up to ${Number(pending.creditBudget).toLocaleString()} OpenSEO credits.`}
      </ConfirmDialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <form.AppForm>
          <form.Form className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Run report</DialogTitle>
              <DialogDescription>
                Claude Code writes it from a template and saves it here.
              </DialogDescription>
            </DialogHeader>

            <form.AppField name="templateId">
              {(field) => (
                <field.SelectField
                  label="Template"
                  items={templateItems}
                  disabled={templatesQuery.isPending}
                  description={
                    templatesQuery.isSuccess && templates.length === 0
                      ? "This project has no templates yet. Add one under Templates."
                      : undefined
                  }
                />
              )}
            </form.AppField>

            <form.AppField name="audit">
              {(field) => (
                <field.SelectField label="Site audit" items={AUDIT_ITEMS} />
              )}
            </form.AppField>

            {values.audit === "new" ? (
              <div className="grid gap-4 rounded-md border p-3">
                <form.AppField name="maxPages">
                  {(field) => (
                    <field.TextField
                      label="Pages to crawl"
                      type="number"
                      min={10}
                      max={10_000}
                      description="Crawling is free. Large sites take about a minute per 50 pages."
                    />
                  )}
                </form.AppField>
                <form.AppField name="lighthouse">
                  {(field) => (
                    <field.CheckboxField label="Run Lighthouse on a sample of pages (adds several minutes)" />
                  )}
                </form.AppField>
                <form.AppField name="renderJavaScript">
                  {(field) => (
                    <field.CheckboxField label="Render JavaScript (slower, max 1,000 pages)" />
                  )}
                </form.AppField>
              </div>
            ) : null}

            <form.AppField name="dateRange">
              {(field) => (
                <field.SelectField
                  label="Search Console and Analytics window"
                  items={DATE_ITEMS}
                />
              )}
            </form.AppField>

            <form.AppField name="creditBudget">
              {(field) => (
                <field.SelectField
                  label="Credit budget"
                  items={BUDGET_ITEMS}
                  description="The most the run may spend on paid research such as keyword and SERP data."
                />
              )}
            </form.AppField>

            <form.AppField name="focus">
              {(field) => (
                <field.TextareaField
                  label="Focus (optional)"
                  className="h-24"
                  placeholder="Seed keywords, competitors to compare, pages or questions to cover."
                />
              )}
            </form.AppField>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <form.SubmitButton>Continue</form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
