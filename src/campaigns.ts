import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "./locks.js";
import { safeAtomicWrite } from "./fs_atomic.js";

export type CampaignStatus = "draft" | "running" | "completed" | "stopped" | "failed";

export type CampaignStopConditions = {
  convergence_detected: boolean;
  min_gihi: number;
  max_experiments: number;
  stagnation_rate_gt: number;
  max_ticks: number;
  gihi_grace_ticks: number;
};

export type CampaignRecord = {
  campaign_id: string;
  goal: string;
  objective: any;
  constraints?: Record<string, any>;
  max_experiments: number;
  stop_conditions: CampaignStopConditions;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  stop_reason?: string;
  primary_experiment_id?: string;
  experiment_ids: string[];
  tick_count: number;
  experiments_run: number;
  last_metrics?: {
    gihi?: number;
    transfer_success_rate?: number;
    mutation_effectiveness_ratio?: number;
    arena_domains?: number;
    stagnation_rate?: number;
  };
  history: Array<{
    ts: string;
    type: string;
    data?: any;
  }>;
};

export type CampaignPreparedTickRecord = {
  tick_id: string;
  tick_index: number;
  ts: string;
  data: Record<string, any>;
};

function isoNow() {
  return new Date().toISOString();
}

function campaignsDir(syncDir: string) {
  return path.join(syncDir, "campaigns");
}

function reportsDir(syncDir: string) {
  return path.join(campaignsDir(syncDir), "reports");
}

function preparedTicksRootDir(syncDir: string) {
  return path.join(syncDir, "campaign_ticks");
}

function preparedTicksCampaignDir(syncDir: string, campaignId: string) {
  return path.join(preparedTicksRootDir(syncDir), campaignId);
}

function preparedTickFile(syncDir: string, campaignId: string, tickId: string) {
  const safeName = tickId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(preparedTicksCampaignDir(syncDir, campaignId), `${safeName}.json`);
}

function campaignFile(syncDir: string, campaignId: string) {
  return path.join(campaignsDir(syncDir), `${campaignId}.json`);
}

function lockDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

async function ensureLayout(syncDir: string) {
  await fs.mkdir(campaignsDir(syncDir), { recursive: true });
  await fs.mkdir(reportsDir(syncDir), { recursive: true });
  await fs.mkdir(preparedTicksRootDir(syncDir), { recursive: true });
}

function normalizeStopConditions(input: Partial<CampaignStopConditions> | undefined, maxExperiments: number): CampaignStopConditions {
  const rawMinGihi = Number(
    (input as any)?.min_gihi ??
    (input as any)?.gihi_below_threshold ??
    0.15
  );
  return {
    convergence_detected: input?.convergence_detected ?? true,
    min_gihi: Math.max(0, Math.min(1, rawMinGihi)),
    max_experiments: Math.max(1, Math.min(10000, Math.trunc(Number(input?.max_experiments ?? maxExperiments)))),
    stagnation_rate_gt: Math.max(0, Math.min(1, Number(input?.stagnation_rate_gt ?? 0.92))),
    max_ticks: Math.max(1, Math.min(100000, Math.trunc(Number(input?.max_ticks ?? 2000)))),
    gihi_grace_ticks: Math.max(0, Math.min(1000, Math.trunc(Number((input as any)?.gihi_grace_ticks ?? 2)))),
  };
}

function normalizeCampaign(input: Partial<CampaignRecord>): CampaignRecord {
  const now = isoNow();
  const maxExperiments = Math.max(1, Math.min(10000, Math.trunc(Number(input.max_experiments ?? 30))));
  const stopConditions = normalizeStopConditions(input.stop_conditions, maxExperiments);
  return {
    campaign_id: typeof input.campaign_id === "string" && input.campaign_id.trim()
      ? input.campaign_id
      : `cmp_${randomUUID()}`,
    goal: typeof input.goal === "string" ? input.goal : "",
    objective: input.objective ?? "maximize score",
    constraints: (input.constraints && typeof input.constraints === "object") ? input.constraints : undefined,
    max_experiments: maxExperiments,
    stop_conditions: stopConditions,
    status: input.status ?? "draft",
    created_at: typeof input.created_at === "string" ? input.created_at : now,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : now,
    started_at: typeof input.started_at === "string" ? input.started_at : undefined,
    completed_at: typeof input.completed_at === "string" ? input.completed_at : undefined,
    stop_reason: typeof input.stop_reason === "string" ? input.stop_reason : undefined,
    primary_experiment_id: typeof input.primary_experiment_id === "string" ? input.primary_experiment_id : undefined,
    experiment_ids: Array.isArray(input.experiment_ids) ? input.experiment_ids.map((x) => String(x)) : [],
    tick_count: Math.max(0, Math.trunc(Number(input.tick_count ?? 0))),
    experiments_run: Math.max(0, Math.trunc(Number(input.experiments_run ?? 0))),
    last_metrics: (input.last_metrics && typeof input.last_metrics === "object")
      ? {
        gihi: Number(input.last_metrics.gihi ?? NaN),
        transfer_success_rate: Number(input.last_metrics.transfer_success_rate ?? NaN),
        mutation_effectiveness_ratio: Number(input.last_metrics.mutation_effectiveness_ratio ?? NaN),
        arena_domains: Number(input.last_metrics.arena_domains ?? NaN),
        stagnation_rate: Number(input.last_metrics.stagnation_rate ?? NaN),
      }
      : undefined,
    history: Array.isArray(input.history)
      ? input.history.map((h: any) => ({
        ts: typeof h?.ts === "string" ? h.ts : now,
        type: typeof h?.type === "string" ? h.type : "unknown",
        data: h?.data,
      }))
      : [],
  };
}

async function withCampaignLock<T>(syncDir: string, campaignId: string, fn: () => Promise<T>): Promise<T> {
  await ensureLayout(syncDir);
  const lockName = `campaign:${campaignId}`;
  const lock = await acquireLock({
    locksDir: lockDir(syncDir),
    name: lockName,
    ttl_ms: 10_000,
  });
  if (!lock.ok || !lock.token) throw new Error("campaign lock busy");
  try {
    return await fn();
  } finally {
    await releaseLock({
      locksDir: lockDir(syncDir),
      name: lockName,
      token: lock.token,
    });
  }
}

export async function campaignGet(opts: {
  syncDir: string;
  campaign_id: string;
}) {
  await ensureLayout(opts.syncDir);
  const p = campaignFile(opts.syncDir, opts.campaign_id);
  const raw = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(raw);
  return { campaign: normalizeCampaign(parsed) };
}

export async function campaignSave(opts: {
  syncDir: string;
  campaign: CampaignRecord;
}) {
  return withCampaignLock(opts.syncDir, opts.campaign.campaign_id, async () => {
    const campaign = normalizeCampaign(opts.campaign);
    campaign.updated_at = isoNow();
    const p = campaignFile(opts.syncDir, campaign.campaign_id);
    await safeAtomicWrite({
      targetPath: p,
      content: JSON.stringify(campaign, null, 2),
      retries: 6,
      baseDelayMs: 30,
    });
    return { campaign };
  });
}

export async function campaignCreate(opts: {
  syncDir: string;
  campaign_id?: string;
  goal: string;
  objective: any;
  constraints?: Record<string, any>;
  max_experiments?: number;
  stop_conditions?: Partial<CampaignStopConditions>;
}) {
  const now = isoNow();
  const campaignId = (typeof opts.campaign_id === "string" && opts.campaign_id.trim())
    ? opts.campaign_id.trim()
    : `cmp_${randomUUID()}`;
  return withCampaignLock(opts.syncDir, campaignId, async () => {
    const maxExperiments = Math.max(1, Math.min(10000, Math.trunc(Number(opts.max_experiments ?? 30))));
    const stopConditions = normalizeStopConditions(opts.stop_conditions, maxExperiments);

    const campaign: CampaignRecord = normalizeCampaign({
      campaign_id: campaignId,
      goal: opts.goal,
      objective: opts.objective ?? "maximize score",
      constraints: opts.constraints,
      max_experiments: maxExperiments,
      stop_conditions: stopConditions,
      status: "draft",
      created_at: now,
      updated_at: now,
      experiment_ids: [],
      tick_count: 0,
      experiments_run: 0,
      history: [
        {
          ts: now,
          type: "campaign.created",
          data: {
            max_experiments: maxExperiments,
            stop_conditions: stopConditions,
          },
        },
      ],
    });

    const p = campaignFile(opts.syncDir, campaignId);
    await safeAtomicWrite({
      targetPath: p,
      content: JSON.stringify(campaign, null, 2),
      retries: 6,
      baseDelayMs: 30,
    });

    return { campaign };
  });
}

export async function campaignList(opts: {
  syncDir: string;
  limit?: number;
  status?: CampaignStatus;
}) {
  await ensureLayout(opts.syncDir);
  const files = await fs.readdir(campaignsDir(opts.syncDir), { withFileTypes: true });
  const items: CampaignRecord[] = [];
  for (const f of files) {
    if (!f.isFile()) continue;
    if (!f.name.endsWith(".json")) continue;
    const p = path.join(campaignsDir(opts.syncDir), f.name);
    try {
      const raw = await fs.readFile(p, "utf8");
      const parsed = normalizeCampaign(JSON.parse(raw));
      if (opts.status && parsed.status !== opts.status) continue;
      items.push(parsed);
    } catch {
      // ignore invalid files
    }
  }
  items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return {
    items: items.slice(0, Math.max(1, Math.min(1000, Math.trunc(Number(opts.limit ?? 100))))),
  };
}

export async function campaignAppendHistory(opts: {
  syncDir: string;
  campaign_id: string;
  type: string;
  data?: any;
}) {
  return withCampaignLock(opts.syncDir, opts.campaign_id, async () => {
    const current = await campaignGet({ syncDir: opts.syncDir, campaign_id: opts.campaign_id });
    const campaign = current.campaign;
    campaign.history.push({
      ts: isoNow(),
      type: opts.type,
      data: opts.data,
    });
    campaign.updated_at = isoNow();
    const p = campaignFile(opts.syncDir, campaign.campaign_id);
    await safeAtomicWrite({
      targetPath: p,
      content: JSON.stringify(campaign, null, 2),
      retries: 6,
      baseDelayMs: 30,
    });
    return { campaign };
  });
}

export async function campaignReportGenerate(opts: {
  syncDir: string;
  campaign_id: string;
  snapshot: Record<string, any>;
}) {
  return withCampaignLock(opts.syncDir, opts.campaign_id, async () => {
    const current = await campaignGet({ syncDir: opts.syncDir, campaign_id: opts.campaign_id });
    const campaign = current.campaign;
    const now = isoNow();

    const reportMd = [
      `# Campaign Report: ${campaign.campaign_id}`,
      "",
      `## Goal`,
      campaign.goal,
      "",
      `## Objective`,
      "```json",
      JSON.stringify(campaign.objective ?? {}, null, 2),
      "```",
      "",
      `## Summary`,
      `- Status: ${campaign.status}`,
      `- Experiments planned max: ${campaign.max_experiments}`,
      `- Experiments run: ${campaign.experiments_run}`,
      `- Ticks: ${campaign.tick_count}`,
      `- Stop reason: ${campaign.stop_reason ?? "n/a"}`,
      "",
      `## Best Strategy Per Domain`,
      "```json",
      JSON.stringify(opts.snapshot.best_strategy_per_domain ?? [], null, 2),
      "```",
      "",
      `## Best Parameters`,
      "```json",
      JSON.stringify(opts.snapshot.best_parameters ?? [], null, 2),
      "```",
      "",
      `## Convergence Summary`,
      "```json",
      JSON.stringify(opts.snapshot.convergence_summary ?? {}, null, 2),
      "```",
      "",
      `## Evolution Summary`,
      "```json",
      JSON.stringify(opts.snapshot.evolution_summary ?? {}, null, 2),
      "```",
      "",
      `## Transfer Summary`,
      "```json",
      JSON.stringify(opts.snapshot.transfer_summary ?? {}, null, 2),
      "```",
      "",
      `## Intelligence Health Trajectory`,
      "```json",
      JSON.stringify(opts.snapshot.intelligence_health_trajectory ?? [], null, 2),
      "```",
      "",
      `## Recommendations`,
      "```json",
      JSON.stringify(opts.snapshot.recommendations ?? [], null, 2),
      "```",
      "",
      `Generated at: ${now}`,
    ].join("\n");

    const reportJson = {
      generated_at: now,
      campaign,
      snapshot: opts.snapshot,
    };

    const base = path.join(reportsDir(opts.syncDir), campaign.campaign_id);
    const mdPath = `${base}.md`;
    const jsonPath = `${base}.json`;
    await safeAtomicWrite({
      targetPath: mdPath,
      content: reportMd,
      retries: 6,
      baseDelayMs: 30,
    });
    await safeAtomicWrite({
      targetPath: jsonPath,
      content: JSON.stringify(reportJson, null, 2),
      retries: 6,
      baseDelayMs: 30,
    });

    campaign.history.push({
      ts: now,
      type: "campaign.report.generated",
      data: { md_path: mdPath, json_path: jsonPath },
    });
    campaign.updated_at = now;
    const p = campaignFile(opts.syncDir, campaign.campaign_id);
    await safeAtomicWrite({
      targetPath: p,
      content: JSON.stringify(campaign, null, 2),
      retries: 6,
      baseDelayMs: 30,
    });

    return {
      campaign,
      report: {
        md_path: mdPath,
        json_path: jsonPath,
        markdown: reportMd,
        snapshot: reportJson,
      },
    };
  });
}

function parseTickIndex(entry: any, fallbackIndex: number): number {
  const fromData = Number(entry?.data?.tick_index ?? NaN);
  if (Number.isFinite(fromData) && fromData > 0) return Math.trunc(fromData);
  return fallbackIndex;
}

function normalizeCampaignFromHistory(campaign: CampaignRecord): CampaignRecord {
  const tickEntries = (campaign.history ?? [])
    .filter((h: any) => h?.type === "campaign.tick")
    .map((h: any, idx: number) => ({
      entry: h,
      idx: parseTickIndex(h, idx + 1),
      tickId: typeof h?.data?.tick_id === "string" ? h.data.tick_id : "",
    }))
    .sort((a, b) => a.idx - b.idx);

  const deduped: typeof tickEntries = [];
  const seenTickIds = new Set<string>();
  const seenIdx = new Set<number>();
  for (const item of tickEntries) {
    if (item.tickId && seenTickIds.has(item.tickId)) continue;
    if (seenIdx.has(item.idx)) continue;
    if (item.tickId) seenTickIds.add(item.tickId);
    seenIdx.add(item.idx);
    deduped.push(item);
  }

  const otherHistory = (campaign.history ?? []).filter((h: any) => h?.type !== "campaign.tick");
  const rebuiltTicks = deduped.map((x) => ({
    ts: typeof x.entry?.ts === "string" ? x.entry.ts : isoNow(),
    type: "campaign.tick",
    data: {
      ...(x.entry?.data && typeof x.entry.data === "object" ? x.entry.data : {}),
      tick_index: x.idx,
      tick_id: (x.entry?.data?.tick_id && typeof x.entry.data.tick_id === "string")
        ? x.entry.data.tick_id
        : `${campaign.campaign_id}:${x.idx}`,
    },
  }));

  campaign.history = [...otherHistory, ...rebuiltTicks]
    .sort((a, b) => Date.parse(String(a?.ts ?? "")) - Date.parse(String(b?.ts ?? "")));
  campaign.tick_count = deduped.length;

  if ((campaign.status === "draft" || !campaign.status) && campaign.tick_count > 0) {
    campaign.status = "running";
    campaign.started_at = campaign.started_at ?? isoNow();
  }

  const maxTicks = Number(campaign.stop_conditions?.max_ticks ?? Number.MAX_SAFE_INTEGER);
  const maxExperiments = Number(campaign.stop_conditions?.max_experiments ?? campaign.max_experiments ?? Number.MAX_SAFE_INTEGER);
  if (campaign.tick_count >= maxTicks || Number(campaign.experiments_run ?? 0) >= maxExperiments) {
    if (campaign.status !== "completed" && campaign.status !== "stopped" && campaign.status !== "failed") {
      campaign.status = "completed";
    }
    campaign.completed_at = campaign.completed_at ?? isoNow();
    if (!campaign.stop_reason) {
      campaign.stop_reason = campaign.tick_count >= maxTicks ? "max_ticks_reached" : "max_experiments_reached";
    }
  }

  campaign.updated_at = isoNow();
  return campaign;
}

function sumCreatedRunsFromHistory(campaign: CampaignRecord): number {
  let total = 0;
  for (const h of campaign.history ?? []) {
    if (h?.type !== "campaign.tick") continue;
    const created = Number((h as any)?.data?.created_runs ?? 0);
    if (Number.isFinite(created) && created > 0) total += Math.trunc(created);
  }
  return total;
}

async function listPreparedTickRecords(syncDir: string, campaignId: string): Promise<CampaignPreparedTickRecord[]> {
  const dir = preparedTicksCampaignDir(syncDir, campaignId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: CampaignPreparedTickRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const p = path.join(dir, entry.name);
      try {
        const raw = await fs.readFile(p, "utf8");
        const parsed = JSON.parse(raw) as CampaignPreparedTickRecord;
        if (
          parsed &&
          typeof parsed.tick_id === "string" &&
          Number.isFinite(Number(parsed.tick_index)) &&
          typeof parsed.ts === "string" &&
          parsed.data &&
          typeof parsed.data === "object"
        ) {
          out.push({
            tick_id: parsed.tick_id,
            tick_index: Math.max(1, Math.trunc(Number(parsed.tick_index))),
            ts: parsed.ts,
            data: parsed.data,
          });
        }
      } catch {
        // ignore invalid record
      }
    }
    out.sort((a, b) => a.tick_index - b.tick_index || Date.parse(a.ts) - Date.parse(b.ts));
    return out;
  } catch {
    return [];
  }
}

function applyPreparedTicksToCampaign(campaign: CampaignRecord, prepared: CampaignPreparedTickRecord[]): CampaignRecord {
  if (prepared.length === 0) return campaign;
  const existingTickIds = new Set(
    (campaign.history ?? [])
      .filter((h: any) => h?.type === "campaign.tick")
      .map((h: any) => String(h?.data?.tick_id ?? ""))
      .filter(Boolean),
  );
  for (const tick of prepared) {
    if (existingTickIds.has(tick.tick_id)) continue;
    campaign.history.push({
      ts: tick.ts,
      type: "campaign.tick",
      data: {
        ...(tick.data ?? {}),
        tick_id: tick.tick_id,
        tick_index: tick.tick_index,
      },
    });
    existingTickIds.add(tick.tick_id);
  }
  return campaign;
}

export async function campaignTickRecordWrite(opts: {
  syncDir: string;
  campaign_id: string;
  tick_record: CampaignPreparedTickRecord;
}) {
  await ensureLayout(opts.syncDir);
  await fs.mkdir(preparedTicksCampaignDir(opts.syncDir, opts.campaign_id), { recursive: true });
  const p = preparedTickFile(opts.syncDir, opts.campaign_id, opts.tick_record.tick_id);
  await safeAtomicWrite({
    targetPath: p,
    content: JSON.stringify({
      tick_id: opts.tick_record.tick_id,
      tick_index: Math.max(1, Math.trunc(Number(opts.tick_record.tick_index))),
      ts: opts.tick_record.ts,
      data: opts.tick_record.data ?? {},
    }, null, 2),
    retries: 6,
    baseDelayMs: 30,
  });
  return { ok: true, path: p };
}

export async function campaignMarkRunning(opts: {
  syncDir: string;
  campaign_id: string;
}) {
  return withCampaignLock(opts.syncDir, opts.campaign_id, async () => {
    const current = await campaignGet({ syncDir: opts.syncDir, campaign_id: opts.campaign_id });
    const campaign = current.campaign;
    if (campaign.status === "draft") {
      campaign.status = "running";
      campaign.started_at = campaign.started_at ?? isoNow();
      campaign.updated_at = isoNow();
      await safeAtomicWrite({
        targetPath: campaignFile(opts.syncDir, campaign.campaign_id),
        content: JSON.stringify(campaign, null, 2),
        retries: 6,
        baseDelayMs: 30,
      });
    }
    return { campaign };
  });
}

export async function campaignCommitPreparedTick(opts: {
  syncDir: string;
  campaign_id: string;
  tick_id: string;
  tick_index: number;
}) {
  return withCampaignLock(opts.syncDir, opts.campaign_id, async () => {
    const current = await campaignGet({ syncDir: opts.syncDir, campaign_id: opts.campaign_id });
    const campaign = current.campaign;
    const prepared = await listPreparedTickRecords(opts.syncDir, campaign.campaign_id);
    const record = prepared.find((x) => x.tick_id === opts.tick_id) ?? prepared.find((x) => x.tick_index === opts.tick_index);
    if (!record) {
      return { campaign, committed: false, reason: "prepared_tick_not_found" as const };
    }

    const duplicate = (campaign.history ?? []).some((h: any) =>
      h?.type === "campaign.tick" &&
      (
        String(h?.data?.tick_id ?? "") === record.tick_id ||
        Number(h?.data?.tick_index ?? NaN) === record.tick_index
      )
    );
    if (duplicate) {
      const normalized = normalizeCampaignFromHistory(campaign);
      normalized.experiments_run = Math.max(Number(normalized.experiments_run ?? 0), sumCreatedRunsFromHistory(normalized));
      await safeAtomicWrite({
        targetPath: campaignFile(opts.syncDir, normalized.campaign_id),
        content: JSON.stringify(normalized, null, 2),
        retries: 6,
        baseDelayMs: 30,
      });
      return { campaign: normalized, committed: false, reason: "idempotent_noop" as const };
    }

    if (campaign.status === "draft") {
      campaign.status = "running";
      campaign.started_at = campaign.started_at ?? isoNow();
    }
    campaign.history.push({
      ts: record.ts,
      type: "campaign.tick",
      data: {
        ...(record.data ?? {}),
        tick_id: record.tick_id,
        tick_index: record.tick_index,
      },
    });
    if (record.data && typeof record.data === "object") {
      campaign.last_metrics = {
        ...(campaign.last_metrics ?? {}),
        gihi: Number((record.data as any).gihi ?? campaign.last_metrics?.gihi ?? NaN),
        transfer_success_rate: Number((record.data as any).transfer_success_rate ?? campaign.last_metrics?.transfer_success_rate ?? NaN),
        mutation_effectiveness_ratio: Number((record.data as any).mutation_effectiveness_ratio ?? campaign.last_metrics?.mutation_effectiveness_ratio ?? NaN),
        arena_domains: Number((record.data as any).arena_evaluated ?? campaign.last_metrics?.arena_domains ?? NaN),
        stagnation_rate: Number((record.data as any).stagnation_rate ?? campaign.last_metrics?.stagnation_rate ?? NaN),
      };
      const recordStatus = String((record.data as any).status ?? "");
      if (recordStatus === "running" || recordStatus === "completed" || recordStatus === "stopped" || recordStatus === "failed") {
        campaign.status = recordStatus as CampaignStatus;
      }
      const stopReason = (record.data as any).stop_reason;
      if (typeof stopReason === "string" && stopReason.trim()) {
        campaign.stop_reason = stopReason.trim();
      }
      if (campaign.status === "completed" || campaign.status === "stopped" || campaign.status === "failed") {
        campaign.completed_at = campaign.completed_at ?? isoNow();
      }
    }
    const normalized = normalizeCampaignFromHistory(campaign);
    normalized.experiments_run = Math.max(Number(normalized.experiments_run ?? 0), sumCreatedRunsFromHistory(normalized));

    await safeAtomicWrite({
      targetPath: campaignFile(opts.syncDir, normalized.campaign_id),
      content: JSON.stringify(normalized, null, 2),
      retries: 6,
      baseDelayMs: 30,
    });
    return { campaign: normalized, committed: true };
  });
}

export async function campaignReconcile(opts: {
  syncDir: string;
  campaign_id: string;
}) {
  return withCampaignLock(opts.syncDir, opts.campaign_id, async () => {
    const current = await campaignGet({ syncDir: opts.syncDir, campaign_id: opts.campaign_id });
    const prepared = await listPreparedTickRecords(opts.syncDir, current.campaign.campaign_id);
    const merged = applyPreparedTicksToCampaign(current.campaign, prepared);
    const normalized = normalizeCampaignFromHistory(merged);
    normalized.experiments_run = Math.max(Number(normalized.experiments_run ?? 0), sumCreatedRunsFromHistory(normalized));
    const p = campaignFile(opts.syncDir, normalized.campaign_id);
    await safeAtomicWrite({
      targetPath: p,
      content: JSON.stringify(normalized, null, 2),
      retries: 6,
      baseDelayMs: 30,
    });
    return {
      campaign: normalized,
      changed: true,
    };
  });
}

export async function campaignReconcileAll(opts: {
  syncDir: string;
  limit?: number;
}) {
  const list = await campaignList({
    syncDir: opts.syncDir,
    limit: Math.max(1, Math.min(1000, Math.trunc(Number(opts.limit ?? 200)))),
  });
  const results: Array<{ campaign_id: string; status: string }> = [];
  for (const item of list.items) {
    try {
      const rec = await campaignReconcile({
        syncDir: opts.syncDir,
        campaign_id: item.campaign_id,
      });
      results.push({
        campaign_id: rec.campaign.campaign_id,
        status: rec.campaign.status,
      });
    } catch {
      // continue best-effort
    }
  }
  return {
    scanned: list.items.length,
    reconciled: results.length,
    items: results,
  };
}
