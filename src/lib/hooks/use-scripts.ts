"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

/**
 * Per-job script files. The file content lives in SQLite, is delivered in the
 * /next run payload, and is materialized to disk by the runner into the job's
 * scripts_dir right before the command runs. The command strings reference each
 * file by bare name (e.g. `./prerun.sh`, `python3 check_health.py`).
 */
export type JobScript = {
  id: string;
  job_id: string;
  filename: string;
  content: string;
  executable: number;
  created_at: number;
  updated_at: number;
};

export function useJobScripts(jobId: string, opts?: { enabled?: boolean }) {
  return useQuery<JobScript[]>({
    queryKey: qk.jobs.scripts(jobId),
    queryFn: () => apiFetch<JobScript[]>(`/api/jobs/${jobId}/scripts`),
    enabled: (opts?.enabled ?? true) && !!jobId,
  });
}

export function useCreateJobScript(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { filename: string; content?: string; executable?: boolean }) =>
      apiFetch<JobScript>(`/api/jobs/${jobId}/scripts`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs.scripts(jobId) }),
  });
}

export function useUpdateJobScript(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      scriptId: string;
      body: { filename?: string; content?: string; executable?: boolean };
    }) =>
      apiFetch<JobScript>(`/api/jobs/${jobId}/scripts/${vars.scriptId}`, {
        method: "PUT",
        body: vars.body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs.scripts(jobId) }),
  });
}

export function useDeleteJobScript(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scriptId: string) =>
      apiFetch(`/api/jobs/${jobId}/scripts/${scriptId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs.scripts(jobId) }),
  });
}
