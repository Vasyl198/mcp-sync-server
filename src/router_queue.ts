import { queuePop, queueAck, queueLeaseRenew, queuePush, queueHasLiveCampaignJob, QueueJob } from "./queue.js";

type ExecPayload = {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  max_output_bytes?: number;
};

type ProjectTaskPayload = {
  task?: string;
  command?: string;
  type?: string;
  project_path?: string;
  args?: Record<string, any>;
  input?: Record<string, any>;
  spec_path?: string;
  [k: string]: any;
};

export async function executeOneFromQueue(opts: {
  syncDir: string;
  worker?: string;
  max_lease_ms?: number;
  logical_queue?: string | string[];
  runExecInternal: (payload: ExecPayload) => Promise<any>;
  handleProjectTask: (payload: ProjectTaskPayload) => Promise<any>;
  onExecFinished?: (ctx: {
    job: QueueJob;
    payload: ExecPayload;
    result: any;
    ack_status: "done" | "error" | "canceled";
  }) => Promise<void>;
}): Promise<any> {
  const isLockBusyMessage = (message: string) => {
    const msg = String(message ?? "").toLowerCase();
    return (
      msg.includes("lock busy") ||
      msg.includes("write lock busy") ||
      msg.includes("write_lock_busy") ||
      msg.includes("elock") ||
      msg.includes("ebusy") ||
      msg.includes("eperm")
    );
  };

  const popped = await queuePop({
    syncDir: opts.syncDir,
    worker: opts.worker ?? "windsurf-router",
    max_lease_ms: opts.max_lease_ms ?? 60_000,
    logical_queue: opts.logical_queue,
  });

  if (!popped.job || !popped.lease_token) {
    return { message: "No command to execute", status: "idle" };
  }

  const job: QueueJob = popped.job;
  const leaseToken = popped.lease_token;
  const heartbeatMs = 20_000;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const startHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      void queueLeaseRenew({
        syncDir: opts.syncDir,
        job_id: job.job_id,
        lease_token: leaseToken,
        extend_ms: Math.max((opts.max_lease_ms ?? 60_000), 60_000),
        worker: opts.worker ?? "windsurf-router",
      }).catch(() => {});
    }, heartbeatMs);
  };
  const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  try {
    let result: any;
    let report = "";
    let logs = "";
    let routedAsExec = false;
    startHeartbeat();

    if (job.type === "exec") {
      const payload = job.payload as ExecPayload;
      routedAsExec = true;
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
    } else if (job.type === "custom") {
      const raw = (job.payload && typeof job.payload === "object") ? (job.payload as Record<string, any>) : {};
      const hasExecShape = typeof raw.cmd === "string" && raw.cmd.trim().length > 0;
      const hasTaskShape =
        typeof raw.task === "string" ||
        typeof raw.command === "string" ||
        typeof raw.type === "string";
      if (hasExecShape) {
        const payload = raw as ExecPayload;
        routedAsExec = true;
        result = await opts.runExecInternal(payload);
        logs =
          `routed_from=custom\n` +
          `cmd=${payload.cmd} args=${JSON.stringify(payload.args ?? [])}\n` +
          `cwd=${payload.cwd ?? ""}\n` +
          `exit=${result?.exit_code ?? "?"}\n` +
          `stdout:\n${result?.stdout ?? ""}\n` +
          `stderr:\n${result?.stderr ?? ""}\n`;
        report =
          `# Custom job routed to exec\n\n` +
          `**job_id:** ${job.job_id}\n\n` +
          `**cmd:** ${payload.cmd}\n\n` +
          `**exit_code:** ${result?.exit_code ?? "?"}\n`;
      } else if (hasTaskShape) {
        const payload = raw as ProjectTaskPayload;
        result = await opts.handleProjectTask(payload);
        report = result?.report_md ?? `# Custom job routed to project_task\n\n**job_id:** ${job.job_id}\n`;
        logs = result?.logs ?? "";
      } else {
        // Backward-compatible noop for legacy custom jobs without executable payload.
        result = { ok: true, skipped: true, reason: "custom_noop_no_supported_payload_shape" };
        report = `# Custom job (noop)\n\njob_id: ${job.job_id}\n\nreason: payload has no exec/project_task shape\n`;
        logs = "custom job skipped: no cmd/task/command/type";
      }
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

    if ((job.type === "exec" || routedAsExec) && opts.onExecFinished) {
      try {
        await opts.onExecFinished({
          job,
          payload: job.payload as ExecPayload,
          result,
          ack_status: "done",
        });
      } catch {}
    }

    return { status: "done", job_id: job.job_id, result, lease_until: popped.lease_until ?? null };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (job.type === "project_task" && isLockBusyMessage(msg)) {
      const payload = (job.payload && typeof job.payload === "object")
        ? { ...job.payload }
        : {};
      const retryCount = Math.max(0, Math.trunc(Number(payload.retry_count ?? 0))) + 1;
      const delayMs = Math.min(20_000, 500 + retryCount * 500 + Math.floor(Math.random() * 500));
      payload.retry_count = retryCount;
      payload.not_before_ts = new Date(Date.now() + delayMs).toISOString();

      // Coalesce retry storms for campaign_tick: if another live job already exists for this campaign,
      // do not enqueue another retry (avoid starving other campaigns).
      const command = String(payload.command ?? payload.task ?? payload.type ?? "").trim().toLowerCase();
      const campaignId = String(payload.campaign_id ?? "").trim();
      if (command === "campaign_tick" && campaignId) {
        try {
          const live = await queueHasLiveCampaignJob({
            syncDir: opts.syncDir,
            campaign_id: campaignId,
            exclude_job_id: job.job_id,
          });
          if (live.has_live) {
            await queueAck({
              syncDir: opts.syncDir,
              job_id: job.job_id,
              lease_token: leaseToken,
              status: "canceled",
              result: { retryable: true, coalesced: true, error: msg, live, retry_count: retryCount },
              report_md:
                `# Retryable Lock Busy (Coalesced)\n\n` +
                `job_id: ${job.job_id}\n\n` +
                `reason: ${msg}\n\n` +
                `retry_count: ${retryCount}\n\n` +
                `live_pending: ${live.pending} live_running: ${live.running}\n`,
              logs: `lock busy coalesced job_id=${job.job_id} campaign_id=${campaignId} retry=${retryCount}`,
            });
            return { status: "canceled", job_id: job.job_id, retryable: true, coalesced: true, error: msg, live };
          }
        } catch {
          // best-effort: if live-check fails, fall through to enqueue a retry
        }
      }

      // Penalize retry jobs priority to prevent starvation of other campaigns / fresh work.
      const basePriority = Number.isFinite(Number(job.priority)) ? Number(job.priority) : 0;
      const retryPriority = basePriority - 5;

      const requeued = await queuePush({
        syncDir: opts.syncDir,
        type: "project_task",
        payload,
        priority: retryPriority,
        source: `${job.source ?? "router"}-retry`,
        logical_queue: job.logical_queue,
      });
      await queueAck({
        syncDir: opts.syncDir,
        job_id: job.job_id,
        lease_token: leaseToken,
        status: "canceled",
        result: { retryable: true, error: msg, requeued, retry_count: retryCount, priority: retryPriority },
        report_md: `# Retryable Lock Busy\n\njob_id: ${job.job_id}\n\nreason: ${msg}\n\nretry_count: ${retryCount}\n`,
        logs: `lock busy requeued job_id=${job.job_id} retry=${retryCount} priority=${retryPriority}`,
      });
      return { status: "canceled", job_id: job.job_id, retryable: true, error: msg, requeued };
    }
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
  } finally {
    stopHeartbeat();
  }
}
