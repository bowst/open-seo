import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Badge } from "@/client/components/ui/badge";
import { formatRelativeTime } from "@/client/lib/relative-time";
import { reportRunsQueryKey } from "@/client/features/reports/RunReportDialog";
import { reportsQueryKey } from "@/client/features/reports/shared";
import { listReportRuns } from "@/serverFunctions/reportRuns";
import type { ReportRunJob } from "@/types/schemas/report-runs";

// Bowst: recent "Run report" jobs for this project. Polls while one is active
// and refreshes the reports list when a job finishes.

const ACTIVE = new Set<ReportRunJob["status"]>(["queued", "running"]);

const STATUS_LABEL: Record<ReportRunJob["status"], string> = {
  queued: "Queued",
  running: "Writing",
  done: "Saved",
  failed: "Failed",
};

export function useReportRuns(projectId: string) {
  return useQuery({
    queryKey: reportRunsQueryKey(projectId),
    queryFn: () => listReportRuns({ data: { projectId } }),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.jobs.some((job) => ACTIVE.has(job.status))
        ? 15_000
        : false,
  });
}

export function ReportRunsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const runsQuery = useReportRuns(projectId);
  const data = runsQuery.data;

  // A job leaving the active set means a report may have just been saved.
  const activeCount =
    data?.jobs.filter((job) => ACTIVE.has(job.status)).length ?? 0;
  const previousActive = useRef(activeCount);
  useEffect(() => {
    if (activeCount < previousActive.current) {
      void queryClient.invalidateQueries({
        queryKey: reportsQueryKey(projectId),
      });
    }
    previousActive.current = activeCount;
  }, [activeCount, projectId, queryClient]);

  if (!data || data.runner === "unconfigured") return null;
  if (data.runner === "unreachable") {
    return (
      <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
        The report runner is not answering, so Run report is unavailable. Check
        the seo-report-runner launchd agent on the mini.
      </p>
    );
  }
  // Only the last day's runs: older ones are already in the list below.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = data.jobs.filter(
    (job) => ACTIVE.has(job.status) || Date.parse(job.createdAt) > dayAgo,
  );
  if (recent.length === 0) return null;

  return (
    <div className="rounded-md border">
      <div className="border-b px-3 py-2 text-sm font-medium">Report runs</div>
      <ul className="divide-y">
        {recent.map((job) => (
          <li
            key={job.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          >
            <Badge
              variant={
                job.status === "failed"
                  ? "destructive"
                  : job.status === "done"
                    ? "success"
                    : "soft"
              }
            >
              {STATUS_LABEL[job.status]}
            </Badge>
            <span className="font-medium">{job.templateName}</span>
            <span className="text-muted-foreground">
              {formatRelativeTime(job.startedAt ?? job.createdAt)}
            </span>
            {job.status === "done" && job.reportUrl ? (
              <ReportLink projectId={projectId} url={job.reportUrl} />
            ) : null}
            {job.status === "failed" && job.error ? (
              <span className="basis-full text-xs text-muted-foreground">
                {job.error}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportLink({ projectId, url }: { projectId: string; url: string }) {
  const reportId = url.match(/\/reports\/([0-9a-f-]{36})/)?.[1];
  if (!reportId) return null;
  return (
    <Link
      to="/p/$projectId/reports/$reportId"
      params={{ projectId, reportId }}
      className="text-primary underline-offset-4 hover:underline"
    >
      Open report
    </Link>
  );
}
