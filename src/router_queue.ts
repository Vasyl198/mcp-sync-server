import { queuePop, queueAck, QueueJob } from "./queue.js";

type ExecPayload = {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  max_output_bytes?: number;
};

type ProjectTaskPayload = {
  task: string;
  project_path: string;
  spec_path?: string;
  [k: string]: any;
};

export async function executeOneFromQueue(opts: {
  syncDir: string;
  worker?: string;
  max_lease_ms?: number;
  runExecInternal: (payload: ExecPayload) => Promise<any>;
  handleProjectTask: (payload: ProjectTaskPayload) => Promise<any>;
}): Promise<any> {
  const popped = await queuePop({
    syncDir: opts.syncDir,
    worker: opts.worker ?? "windsurf-router",
    max_lease_ms: opts.max_lease_ms ?? 60_000,
  });

  if (!popped.job || !popped.lease_token) {
    return { message: "No command to execute", status: "idle" };
  }

  const job: QueueJob = popped.job;
  const leaseToken = popped.lease_token;

  try {
    let result: any;
    let report = "";
    let logs = "";

    if (job.type === "exec") {
      const payload = job.payload as ExecPayload;
      result = await opts.runExecInternal(payload);
      logs =
        `cmd=${payload.cmd} args=${JSON.stringify(payload.args ?? [])}\n` +
        `cwd=${payload.cwd ?? ""}\n` +
        `exit=${result?.exit_code ?? "?"}\n` +
        `stdout:\n${result?.stdout ?? ""}\n` +
        `stderr:\n${result?.stderr ?? ""}\n`;
      report =
        `# Exec job\n\n` +
        `**job_id:** ${job.job_id}\n\n` +
        `**cmd:** ${payload.cmd}\n\n` +
        `**exit_code:** ${result?.exit_code ?? "?"}\n`;
    } else if (job.type === "project_task") {
      const payload = job.payload as ProjectTaskPayload;
      result = await opts.handleProjectTask(payload);
      report = result?.report_md ?? `# Project task\n\n**task:** ${payload.task}\n\n**job_id:** ${job.job_id}\n`;
      logs = result?.logs ?? "";
    } else {
      throw new Error(`Unknown job.type: ${String(job.type)}`);
    }

    await queueAck({
      syncDir: opts.syncDir,
      job_id: job.job_id,
      lease_token: leaseToken,
      status: "done",
      result,
      report_md: report,
      logs,
    });

    return { status: "done", job_id: job.job_id, result, lease_until: popped.lease_until ?? null };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await queueAck({
      syncDir: opts.syncDir,
      job_id: job.job_id,
      lease_token: leaseToken,
      status: "error",
      result: { error: msg },
      report_md: `# Error\n\njob_id: ${job.job_id}\n\n${msg}\n`,
      logs: msg,
    });
    return { status: "error", job_id: job.job_id, error: msg };
  }
}
