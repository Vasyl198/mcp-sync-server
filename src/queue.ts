import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { acquireLock, releaseLock } from "./locks.js";

export type JobType = "exec" | "project_task" | "custom";
export type LogicalQueueName = "default" | "exec" | "campaign" | "research" | "meta" | string;

export type QueueJob = {
  job_id: string;
  type: JobType;
  payload: any;
  created_at: string; // ISO
  source: string;
  priority: number;
  logical_queue: LogicalQueueName;
};

type Claim = {
  job_id: string;
  claimed_by: string;
  lease_token: string;
  lease_until: string; // ISO
  claimed_at: string; // ISO
  heartbeat_at?: string; // ISO
};

type Ack = {
  job_id: string;
  lease_token: string;
  status: "done" | "error" | "canceled";
  acked_at: string; // ISO
  result_ref: string;
};

export type QueuePaths = {
  baseDir: string;
  jobsPath: string;
  claimsPath: string;
  acksPath: string;
  locksDir: string;
  runsDir: string;
};

function isoNow() {
  return new Date().toISOString();
}

export function queueRunDirName(jobId: string): string {
  const normalized = String(jobId ?? "").trim() || "unknown";
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 20);
  return `j_${digest}`;
}

export function queueRunDirLegacyName(jobId: string): string {
  return String(jobId ?? "").replace(/\|/g, "_");
}

export function queueRunDirCandidates(jobId: string): string[] {
  const primary = queueRunDirName(jobId);
  const legacy = queueRunDirLegacyName(jobId);
  return primary === legacy ? [primary] : [primary, legacy];
}

async function ensureFile(p: string) {
  try {
    await fs.stat(p);
  } catch {
    await fs.writeFile(p, "", "utf8");
  }
}

export async function ensureQueueLayout(syncDir: string): Promise<QueuePaths> {
  const baseDir = path.join(syncDir, "queue");
  const locksDir = path.join(baseDir, "locks");
  const runsDir = path.join(baseDir, "runs");

  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(locksDir, { recursive: true });
  await fs.mkdir(runsDir, { recursive: true });

  const jobsPath = path.join(baseDir, "jobs.jsonl");
  const claimsPath = path.join(baseDir, "claims.jsonl");
  const acksPath = path.join(baseDir, "acks.jsonl");

  await ensureFile(jobsPath);
  await ensureFile(claimsPath);
  await ensureFile(acksPath);

  return { baseDir, jobsPath, claimsPath, acksPath, locksDir, runsDir };
}

async function appendJsonl(filePath: string, obj: any) {
  const line = JSON.stringify(obj) + "\n";
  await fs.appendFile(filePath, line, "utf8");
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out: T[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line) as T); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function inferLogicalQueue(type: JobType, payload: any, source?: string): LogicalQueueName {
  if (type === "exec" || source === "execution-bind") return "exec";
  if (type === "project_task") {
    const taskName = String(payload?.task ?? payload?.command ?? payload?.type ?? "").trim().toLowerCase();
    if (taskName.includes("campaign")) return "campaign";
    if (
      taskName.includes("meta") ||
      taskName.includes("intelligence") ||
      taskName.includes("arena") ||
      taskName.includes("transfer") ||
      taskName.includes("mutation") ||
      taskName.includes("lineage")
    ) {
      return "meta";
    }
    return "research";
  }
  return "default";
}

function normalizeJob(job: any): QueueJob {
  const type: JobType = (job?.type === "exec" || job?.type === "project_task" || job?.type === "custom")
    ? job.type
    : "custom";
  const logicalQueueRaw = typeof job?.logical_queue === "string" ? job.logical_queue.trim() : "";
  const logicalQueue = logicalQueueRaw || inferLogicalQueue(type, job?.payload, job?.source);
  return {
    job_id: String(job?.job_id ?? ""),
    type,
    payload: job?.payload,
    created_at: String(job?.created_at ?? new Date(0).toISOString()),
    source: String(job?.source ?? "unknown"),
    priority: Number.isFinite(Number(job?.priority)) ? Number(job.priority) : 0,
    logical_queue: logicalQueue,
  };
}

function getNotBeforeTs(job: QueueJob): number | null {
  const payload = job.payload;
  if (!payload || typeof payload !== "object") return null;
  const raw = typeof payload.not_before_ts === "string" ? payload.not_before_ts : null;
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function pickNextJob(
  jobs: QueueJob[],
  activeClaims: Map<string, Claim>,
  acked: Set<string>,
  allowedQueues?: Set<string>,
) {
  const now = Date.now();
  const candidates = jobs.filter((j) => {
    if (acked.has(j.job_id) || activeClaims.has(j.job_id)) return false;
    const notBefore = getNotBeforeTs(j);
    if (notBefore != null && notBefore > now) return false;
    if (!allowedQueues || allowedQueues.size === 0) return true;
    return allowedQueues.has(j.logical_queue);
  });
  candidates.sort((a, b) => {
    // higher priority first, then older first
    if (b.priority !== a.priority) return b.priority - a.priority;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
  return candidates[0] ?? null;
}

function buildActiveClaims(claims: Claim[]): Map<string, Claim> {
  const latest = buildLatestClaims(claims);
  const active = new Map<string, Claim>();
  for (const [jobId, c] of latest.entries()) {
    if (Date.parse(c.lease_until) > Date.now()) {
      active.set(jobId, c);
    }
  }
  return active;
}

function buildLatestClaims(claims: Claim[]): Map<string, Claim> {
  const latest = new Map<string, Claim>();
  for (const c of claims) {
    const prev = latest.get(c.job_id);
    if (!prev || Date.parse(c.claimed_at) > Date.parse(prev.claimed_at)) {
      latest.set(c.job_id, c);
    }
  }
  return latest;
}

function buildAckedSet(acks: Ack[]): Set<string> {
  const s = new Set<string>();
  for (const a of acks) s.add(a.job_id);
  return s;
}

export async function queuePush(opts: {
  syncDir: string;
  type: JobType;
  payload: any;
  priority?: number;
  job_id?: string;
  source?: string;
  logical_queue?: LogicalQueueName;
}): Promise<{ job_id: string }> {
  const paths = await ensureQueueLayout(opts.syncDir);

  const job: QueueJob = {
    job_id: opts.job_id ?? randomUUID(),
    type: opts.type,
    payload: opts.payload,
    created_at: isoNow(),
    source: opts.source ?? "chatgpt",
    priority: opts.priority ?? 0,
    logical_queue: (typeof opts.logical_queue === "string" && opts.logical_queue.trim())
      ? opts.logical_queue.trim()
      : inferLogicalQueue(opts.type, opts.payload, opts.source),
  };

  await appendJsonl(paths.jobsPath, job);
  return { job_id: job.job_id };
}

export async function queuePop(opts: {
  syncDir: string;
  worker?: string;
  max_lease_ms?: number;
  logical_queue?: string | string[];
}): Promise<{ job?: QueueJob; lease_token?: string; lease_until?: string }> {
  const paths = await ensureQueueLayout(opts.syncDir);
  const worker = opts.worker ?? "windsurf-router";
  const leaseMs = Math.max(1000, opts.max_lease_ms ?? 60_000);

  const lock = await acquireLock({ locksDir: paths.locksDir, name: "queue", ttl_ms: 15_000 });
  if (!lock.ok || !lock.token) return {};

  try {
    const jobsRaw = await readJsonl<any>(paths.jobsPath);
    const jobs = jobsRaw.map(normalizeJob);
    const claims = await readJsonl<Claim>(paths.claimsPath);
    const acks = await readJsonl<Ack>(paths.acksPath);

    const activeClaims = buildActiveClaims(claims);
    const acked = buildAckedSet(acks);

    const allowedQueues = Array.isArray(opts.logical_queue)
      ? new Set(opts.logical_queue.map((q) => String(q).trim()).filter(Boolean))
      : (typeof opts.logical_queue === "string" && opts.logical_queue.trim()
        ? new Set([opts.logical_queue.trim()])
        : undefined);
    const next = pickNextJob(jobs, activeClaims, acked, allowedQueues);
    if (!next) return {};

    const leaseToken = randomUUID();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();

    const claim: Claim = {
      job_id: next.job_id,
      claimed_by: worker,
      lease_token: leaseToken,
      lease_until: leaseUntil,
      claimed_at: isoNow(),
    };

    await appendJsonl(paths.claimsPath, claim);

    return { job: next, lease_token: leaseToken, lease_until: leaseUntil };
  } finally {
    await releaseLock({ locksDir: paths.locksDir, name: "queue", token: lock.token });
  }
}

export async function queueAck(opts: {
  syncDir: string;
  job_id: string;
  lease_token: string;
  status: "done" | "error" | "canceled";
  result?: any;
  report_md?: string;
  logs?: string;
}): Promise<{ ok: boolean; already_acked?: boolean; result_ref?: string }> {
  const paths = await ensureQueueLayout(opts.syncDir);

  const lock = await acquireLock({ locksDir: paths.locksDir, name: "queue", ttl_ms: 15_000 });
  if (!lock.ok || !lock.token) return { ok: false };

  try {
    const acks = await readJsonl<Ack>(paths.acksPath);
    if (acks.some(a => a.job_id === opts.job_id)) {
      return { ok: true, already_acked: true };
    }

    // Write run artifacts
    const runDir = path.join(paths.runsDir, queueRunDirName(opts.job_id));
    await fs.mkdir(runDir, { recursive: true });

    const reportPath = path.join(runDir, "report.md");
    const logsPath = path.join(runDir, "logs.txt");
    const resultPath = path.join(runDir, "result.json");

    if (opts.report_md != null) await fs.writeFile(reportPath, opts.report_md, "utf8");
    if (opts.logs != null) await fs.writeFile(logsPath, opts.logs, "utf8");
    await fs.writeFile(resultPath, JSON.stringify(opts.result ?? {}, null, 2), "utf8");

    const resultRef = path.relative(opts.syncDir, resultPath).replace(/\\\\/g, "/");

    const ack: Ack = {
      job_id: opts.job_id,
      lease_token: opts.lease_token,
      status: opts.status,
      acked_at: isoNow(),
      result_ref: resultRef,
    };

    await appendJsonl(paths.acksPath, ack);

    return { ok: true, result_ref: resultRef };
  } finally {
    await releaseLock({ locksDir: paths.locksDir, name: "queue", token: lock.token });
  }
}

export async function queueLeaseRenew(opts: {
  syncDir: string;
  job_id: string;
  lease_token: string;
  extend_ms?: number;
  worker?: string;
}): Promise<{ ok: boolean; lease_until?: string; reason?: string }> {
  const paths = await ensureQueueLayout(opts.syncDir);
  const lock = await acquireLock({ locksDir: paths.locksDir, name: "queue", ttl_ms: 15_000 });
  if (!lock.ok || !lock.token) return { ok: false, reason: "queue_lock_busy" };
  try {
    const claims = await readJsonl<Claim>(paths.claimsPath);
    const latest = buildLatestClaims(claims).get(opts.job_id);
    if (!latest) return { ok: false, reason: "claim_not_found" };
    if (latest.lease_token !== opts.lease_token) return { ok: false, reason: "lease_token_mismatch" };
    const acks = await readJsonl<Ack>(paths.acksPath);
    if (acks.some((a) => a.job_id === opts.job_id)) {
      return { ok: false, reason: "already_acked" };
    }
    const extendMs = Math.max(1000, Math.min(5 * 60_000, Math.trunc(Number(opts.extend_ms ?? 60_000))));
    const leaseUntil = new Date(Date.now() + extendMs).toISOString();
    const renewed: Claim = {
      job_id: opts.job_id,
      claimed_by: opts.worker ?? latest.claimed_by,
      lease_token: opts.lease_token,
      lease_until: leaseUntil,
      claimed_at: isoNow(),
      heartbeat_at: isoNow(),
    };
    await appendJsonl(paths.claimsPath, renewed);
    return { ok: true, lease_until: leaseUntil };
  } finally {
    await releaseLock({ locksDir: paths.locksDir, name: "queue", token: lock.token });
  }
}

export async function queueCleanupExpiredRunning(opts: {
  syncDir: string;
  max_attempts?: number;
}): Promise<{
  scanned_running: number;
  expired_detected: number;
  requeued_pending: number;
  marked_error: number;
  items: Array<{ job_id: string; attempts: number; action: "requeued_pending" | "marked_error" }>;
}> {
  const paths = await ensureQueueLayout(opts.syncDir);
  const lock = await acquireLock({ locksDir: paths.locksDir, name: "queue", ttl_ms: 15_000 });
  if (!lock.ok || !lock.token) {
    return {
      scanned_running: 0,
      expired_detected: 0,
      requeued_pending: 0,
      marked_error: 0,
      items: [],
    };
  }
  try {
    const maxAttempts = Math.max(1, Math.trunc(Number(opts.max_attempts ?? 5)));
    const claims = await readJsonl<Claim>(paths.claimsPath);
    const latestClaims = buildLatestClaims(claims);
    const acks = await readJsonl<Ack>(paths.acksPath);
    const acked = buildAckedSet(acks);
    const now = Date.now();
    const items: Array<{ job_id: string; attempts: number; action: "requeued_pending" | "marked_error" }> = [];
    let expiredDetected = 0;
    let requeuedPending = 0;
    let markedError = 0;

    for (const [jobId, claim] of latestClaims.entries()) {
      if (acked.has(jobId)) continue;
      if (Date.parse(claim.lease_until) > now) continue;
      expiredDetected += 1;
      const attempts = claims.filter((c) => c.job_id === jobId).length;
      if (attempts >= maxAttempts) {
        const runDir = path.join(paths.runsDir, queueRunDirName(jobId));
        await fs.mkdir(runDir, { recursive: true });
        const resultPath = path.join(runDir, "result.json");
        const reportPath = path.join(runDir, "report.md");
        const logsPath = path.join(runDir, "logs.txt");
        const payload = {
          error: "lease_expired_max_attempts",
          attempts,
          max_attempts: maxAttempts,
          lease_until: claim.lease_until,
        };
        await fs.writeFile(resultPath, JSON.stringify(payload, null, 2), "utf8");
        await fs.writeFile(reportPath, `# Lease Expired\n\njob_id: ${jobId}\nattempts: ${attempts}\n`, "utf8");
        await fs.writeFile(logsPath, `lease_expired job_id=${jobId} attempts=${attempts}`, "utf8");
        const ack: Ack = {
          job_id: jobId,
          lease_token: claim.lease_token,
          status: "error",
          acked_at: isoNow(),
          result_ref: path.relative(opts.syncDir, resultPath).replace(/\\\\/g, "/"),
        };
        await appendJsonl(paths.acksPath, ack);
        markedError += 1;
        items.push({ job_id: jobId, attempts, action: "marked_error" });
      } else {
        // Expired claims are treated as pending by queuePop/buildActiveClaims; record for telemetry.
        requeuedPending += 1;
        items.push({ job_id: jobId, attempts, action: "requeued_pending" });
      }
    }

    return {
      scanned_running: latestClaims.size,
      expired_detected: expiredDetected,
      requeued_pending: requeuedPending,
      marked_error: markedError,
      items,
    };
  } finally {
    await releaseLock({ locksDir: paths.locksDir, name: "queue", token: lock.token });
  }
}

export async function jobHistoryList(opts: {
  syncDir: string;
  limit?: number;
  status?: "pending" | "running" | "done" | "error" | "canceled";
  logical_queue?: string;
}): Promise<{ items: any[] }> {
  const paths = await ensureQueueLayout(opts.syncDir);

  const jobsRaw = await readJsonl<any>(paths.jobsPath);
  const jobs = jobsRaw.map(normalizeJob);
  const claims = await readJsonl<Claim>(paths.claimsPath);
  const acks = await readJsonl<Ack>(paths.acksPath);

  const activeClaims = buildActiveClaims(claims);
  const ackById = new Map<string, Ack>();
  for (const a of acks) ackById.set(a.job_id, a);

  const items = jobs
    .slice()
    .reverse()
    .map(j => {
      const ack = ackById.get(j.job_id);
      const claim = activeClaims.get(j.job_id);

      let st: string = "pending";
      if (ack) st = ack.status;
      else if (claim) st = "running";

      return {
        job_id: j.job_id,
        type: j.type,
        created_at: j.created_at,
        priority: j.priority,
        source: j.source,
        logical_queue: j.logical_queue,
        status: st,
        lease_until: claim?.lease_until ?? null,
        result_ref: ack?.result_ref ?? null,
      };
    });

  const queueFiltered = opts.logical_queue
    ? items.filter((i) => i.logical_queue === opts.logical_queue)
    : items;
  const statusFiltered = opts.status ? queueFiltered.filter(i => i.status === opts.status) : queueFiltered;
  return { items: statusFiltered.slice(0, opts.limit ?? 50) };
}

export async function queueDepth(opts: {
  syncDir: string;
  logical_queue?: string;
}): Promise<{ pending: number; running: number; done: number; error: number; canceled: number; total: number }> {
  const paths = await ensureQueueLayout(opts.syncDir);
  const jobsRaw = await readJsonl<any>(paths.jobsPath);
  const jobs = jobsRaw.map(normalizeJob);
  const claims = await readJsonl<Claim>(paths.claimsPath);
  const acks = await readJsonl<Ack>(paths.acksPath);

  const activeClaims = buildActiveClaims(claims);
  const ackById = new Map<string, Ack>();
  for (const a of acks) ackById.set(a.job_id, a);

  const filtered = opts.logical_queue
    ? jobs.filter((j) => j.logical_queue === opts.logical_queue)
    : jobs;

  const out = {
    pending: 0,
    running: 0,
    done: 0,
    error: 0,
    canceled: 0,
    total: filtered.length,
  };

  for (const j of filtered) {
    const ack = ackById.get(j.job_id);
    if (ack) {
      if (ack.status === "done") out.done += 1;
      else if (ack.status === "error") out.error += 1;
      else out.canceled += 1;
      continue;
    }
    if (activeClaims.has(j.job_id)) out.running += 1;
    else out.pending += 1;
  }

  return out;
}

export async function queueHasLiveCampaignJob(opts: {
  syncDir: string;
  campaign_id: string;
  exclude_job_id?: string;
}): Promise<{ has_live: boolean; pending: number; running: number }> {
  const paths = await ensureQueueLayout(opts.syncDir);
  const jobsRaw = await readJsonl<any>(paths.jobsPath);
  const jobs = jobsRaw.map(normalizeJob);
  const claims = await readJsonl<Claim>(paths.claimsPath);
  const acks = await readJsonl<Ack>(paths.acksPath);

  const activeClaims = buildActiveClaims(claims);
  const acked = buildAckedSet(acks);
  const targetCampaignId = String(opts.campaign_id ?? "").trim();
  const excludeJobId = String(opts.exclude_job_id ?? "").trim();

  let pending = 0;
  let running = 0;

  for (const j of jobs) {
    if (j.logical_queue !== "campaign") continue;
    if (excludeJobId && j.job_id === excludeJobId) continue;
    if (acked.has(j.job_id)) continue;
    const payload = (j.payload && typeof j.payload === "object") ? j.payload : {};
    const command = String(payload.command ?? payload.task ?? payload.type ?? "").trim().toLowerCase();
    const campaignId = String(payload.campaign_id ?? "").trim();
    if (command !== "campaign_tick") continue;
    if (!campaignId || campaignId !== targetCampaignId) continue;
    if (activeClaims.has(j.job_id)) running += 1;
    else pending += 1;
  }

  return {
    has_live: (pending + running) > 0,
    pending,
    running,
  };
}

export async function queueHasLiveShadowEvaluationRetry(opts: {
  syncDir: string;
  role: string;
  version: number;
  exclude_job_id?: string;
}): Promise<{ has_live: boolean; pending: number; running: number }> {
  const paths = await ensureQueueLayout(opts.syncDir);
  const jobsRaw = await readJsonl<any>(paths.jobsPath);
  const jobs = jobsRaw.map(normalizeJob);
  const claims = await readJsonl<Claim>(paths.claimsPath);
  const acks = await readJsonl<Ack>(paths.acksPath);

  const activeClaims = buildActiveClaims(claims);
  const acked = buildAckedSet(acks);
  const targetRole = String(opts.role ?? "").trim();
  const targetVersion = Math.trunc(Number(opts.version ?? 0));
  const excludeJobId = String(opts.exclude_job_id ?? "").trim();
  const legacyPrefix = `shadow-eval:retry:${targetRole}:v${targetVersion}:`;

  let pending = 0;
  let running = 0;

  for (const j of jobs) {
    if (j.logical_queue !== "meta") continue;
    if (excludeJobId && j.job_id === excludeJobId) continue;
    if (acked.has(j.job_id)) continue;
    const payload = (j.payload && typeof j.payload === "object") ? j.payload : {};
    const command = String(payload.command ?? payload.task ?? payload.type ?? "").trim().toLowerCase();
    if (command !== "shadow_evaluation_tick") continue;
    const payloadRole = String(payload.role ?? "").trim();
    if (!payloadRole || payloadRole !== targetRole) continue;
    const payloadVersionRaw = Number(payload.version ?? NaN);
    const payloadVersion = Number.isFinite(payloadVersionRaw) ? Math.trunc(payloadVersionRaw) : NaN;
    const versionMatches = Number.isFinite(payloadVersion)
      ? payloadVersion === targetVersion
      : j.job_id.startsWith(legacyPrefix);
    if (!versionMatches) continue;
    if (activeClaims.has(j.job_id)) running += 1;
    else pending += 1;
  }

  return {
    has_live: (pending + running) > 0,
    pending,
    running,
  };
}
