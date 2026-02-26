import * as fs from "node:fs/promises";
import * as path from "node:path";

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function readJsonlSafe(filePath: string): Promise<any[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function loadTelemetryContext(syncDir: string) {
  const agentsDir = path.join(syncDir, "agents");
  const eventsPath = path.join(syncDir, "events.jsonl");
  const [memory, registry, evolutionHistory, events] = await Promise.all([
    readJsonSafe<any>(path.join(agentsDir, "research_memory.json"), { items: [] }),
    readJsonSafe<any>(path.join(agentsDir, "registry.json"), { agents: [] }),
    readJsonlSafe(path.join(agentsDir, "evolution_history.jsonl")),
    readJsonlSafe(eventsPath),
  ]);

  return {
    memoryItems: Array.isArray(memory?.items) ? memory.items : [],
    agents: Array.isArray(registry?.agents) ? registry.agents : [],
    history: evolutionHistory,
    events,
  };
}

type GihiPoint = {
  ts: number;
  ts_iso: string;
  gihi: number;
  campaign_id: string;
  tick_index: number;
};

async function readCampaignGihiSeries(syncDir: string): Promise<GihiPoint[]> {
  const campaignsDir = path.join(syncDir, "campaigns");
  try {
    const files = await fs.readdir(campaignsDir, { withFileTypes: true });
    const pointMap = new Map<string, GihiPoint>();
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const campaignPath = path.join(campaignsDir, file.name);
      const campaign = await readJsonSafe<any>(campaignPath, {});
      const history = Array.isArray(campaign?.history) ? campaign.history : [];
      const campaignId = String(campaign?.campaign_id ?? file.name.replace(/\.json$/i, ""));
      let tickCounter = 0;
      for (const item of history) {
        if (item?.type !== "campaign.tick") continue;
        const gihi = Number(item?.data?.gihi ?? NaN);
        if (!Number.isFinite(gihi)) continue;
        const tickIndexRaw = Number(item?.data?.tick_index ?? NaN);
        tickCounter = Number.isFinite(tickIndexRaw) && tickIndexRaw > 0
          ? Math.trunc(tickIndexRaw)
          : tickCounter + 1;
        const tsIso = String(item?.ts ?? "");
        const ts = Date.parse(String(item?.ts ?? ""));
        const point: GihiPoint = {
          ts: Number.isFinite(ts) ? ts : Date.now(),
          ts_iso: tsIso,
          gihi,
          campaign_id: campaignId,
          tick_index: tickCounter,
        };
        const key = `${campaignId}:${tickCounter}`;
        const prev = pointMap.get(key);
        if (!prev || point.ts >= prev.ts) {
          pointMap.set(key, point);
        }
      }
    }
    const points = Array.from(pointMap.values());
    points.sort((a, b) => a.ts - b.ts);
    return points;
  } catch {
    return [];
  }
}

function selectCampaignScopedWindow(points: GihiPoint[], window: number) {
  if (points.length === 0) return points;
  const latestPoint = points[points.length - 1];
  const latestCampaignId = String(latestPoint?.campaign_id ?? "");
  if (!latestCampaignId) return points.slice(-window);
  const scoped = points.filter((p) => p.campaign_id === latestCampaignId);
  if (scoped.length >= 2) return scoped.slice(-window);
  return points.slice(-window);
}

function markdown(title: string, lines: string[]) {
  return [`# ${title}`, "", ...lines].join("\n");
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((acc, n) => acc + n, 0) / values.length;
}

function variance(values: number[]) {
  if (values.length < 2) return 0;
  const mu = average(values);
  const acc = values.reduce((sum, n) => sum + ((n - mu) ** 2), 0);
  return acc / values.length;
}

function safeVariance(xs: number[]): number | null {
  const vals = xs.filter((v) => Number.isFinite(v));
  const n = vals.length;
  if (n < 2) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sse = vals.reduce((acc, v) => acc + ((v - mean) * (v - mean)), 0);
  return sse / (n - 1);
}

function safeMin(xs: number[]): number | null {
  const vals = xs.filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return Math.min(...vals);
}

function safeMax(xs: number[]): number | null {
  const vals = xs.filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return Math.max(...vals);
}

function coerceObservations(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const cands: unknown[] = [
      o.observations,
      o.count,
      o.n,
      o.total,
      o.value,
      Array.isArray(o.items) ? o.items.length : null,
    ];
    for (const c of cands) {
      const n = coerceObservations(c);
      if (n != null) return n;
    }
  }
  return null;
}

function linearRegressionSlope(values: number[]) {
  if (values.length < 2) return 0;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    numerator += dx * (values[i] - meanY);
    denominator += dx * dx;
  }
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

function percentile(sortedValues: number[], p: number) {
  if (sortedValues.length === 0) return 0;
  const clamped = Math.max(0, Math.min(1, p));
  const idx = (sortedValues.length - 1) * clamped;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const t = idx - lo;
  return (sortedValues[lo] * (1 - t)) + (sortedValues[hi] * t);
}

function winsorize(values: number[], trimRatio = 0.1) {
  const clean = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (clean.length < 3) {
    return {
      values: clean,
      lowerBound: clean[0] ?? 0,
      upperBound: clean[clean.length - 1] ?? 0,
      clippedCount: 0,
    };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const lowerBound = percentile(sorted, trimRatio);
  const upperBound = percentile(sorted, 1 - trimRatio);
  let clippedCount = 0;
  const out = clean.map((v) => {
    if (v < lowerBound) {
      clippedCount += 1;
      return lowerBound;
    }
    if (v > upperBound) {
      clippedCount += 1;
      return upperBound;
    }
    return v;
  });
  return { values: out, lowerBound, upperBound, clippedCount };
}

function gihiWindowStats(points: GihiPoint[]) {
  const n = points.length;
  const startPoint = points[0];
  const endPoint = points[n - 1];
  const start = Number(startPoint?.gihi ?? 0);
  const end = Number(endPoint?.gihi ?? 0);
  return {
    n,
    start: Number(start.toFixed(6)),
    end: Number(end.toFixed(6)),
    delta: Number((end - start).toFixed(6)),
    start_ts: String(startPoint?.ts_iso ?? ""),
    end_ts: String(endPoint?.ts_iso ?? ""),
    start_campaign_id: String(startPoint?.campaign_id ?? ""),
    end_campaign_id: String(endPoint?.campaign_id ?? ""),
    start_tick_index: Number(startPoint?.tick_index ?? 0),
    end_tick_index: Number(endPoint?.tick_index ?? 0),
  };
}

function normalizedEntropy(rawWeights: number[]) {
  const weights = rawWeights.map((v) => Math.max(0, Number(v))).filter((v) => Number.isFinite(v));
  if (weights.length <= 1) return 0;
  const total = weights.reduce((acc, n) => acc + n, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const w of weights) {
    const p = w / total;
    if (p > 0) entropy += -(p * Math.log(p));
  }
  const maxEntropy = Math.log(weights.length);
  return maxEntropy > 0 ? clamp01(entropy / maxEntropy) : 0;
}

function effectiveStrategyCount(rawWeights: number[]) {
  const weights = rawWeights.map((v) => Math.max(0, Number(v))).filter((v) => Number.isFinite(v));
  const total = weights.reduce((acc, n) => acc + n, 0);
  if (total <= 0) return 0;
  const sumSquares = weights.reduce((acc, w) => {
    const p = w / total;
    return acc + (p * p);
  }, 0);
  if (sumSquares <= 0) return 0;
  return 1 / sumSquares;
}

function strategyWeightForEntropy(strategy: any) {
  const alloc = Number(strategy?.allocation_weight);
  if (Number.isFinite(alloc) && alloc > 0) return alloc;
  const selected = Number(strategy?.selection_count_window);
  if (Number.isFinite(selected) && selected > 0) return selected;
  return Number(strategy?.fitness ?? 0);
}

function extractEvidenceGateFromPayload(payload: any) {
  if (payload?.evidence_gate && typeof payload.evidence_gate === "object") {
    return payload.evidence_gate;
  }
  if (payload?.transfer_memory_update?.evidence_gate && typeof payload.transfer_memory_update.evidence_gate === "object") {
    return payload.transfer_memory_update.evidence_gate;
  }
  return null;
}

function domainSignatureFromProfile(profile: any): string | null {
  if (!profile || typeof profile !== "object") return null;
  const size = String(profile.size_category ?? "").trim();
  const complexity = String(profile.search_complexity ?? "").trim();
  const noise = String(profile.metric_noise ?? "").trim();
  const paramCount = Number(profile.param_count ?? NaN);
  if (!size || !complexity || !noise || !Number.isFinite(paramCount)) return null;
  const bucket =
    paramCount <= 2 ? "p2" :
      paramCount <= 5 ? "p5" :
        paramCount <= 8 ? "p8" : "p9p";
  return `${size}|${complexity}|${noise}|${bucket}`;
}

function isEvidenceGateSchemaV2(payload: any) {
  const gate = extractEvidenceGateFromPayload(payload);
  const schemaVersion = Number(gate?.schema_version ?? NaN);
  return Number.isFinite(schemaVersion) && schemaVersion >= 2;
}

function summarizeDomainWinnerEvents(events: any[]) {
  const winnerMap = new Map<string, Map<string, number>>();
  for (const ev of events) {
    if (ev?.type !== "strategy_arena_evaluated") continue;
    const payload = ev?.payload ?? {};
    const domain = String(payload?.domain_signature ?? "").trim();
    const winner = String(payload?.winner_strategy_id ?? "").trim();
    if (!domain || !winner) continue;
    const byStrategy = winnerMap.get(domain) ?? new Map<string, number>();
    byStrategy.set(winner, (byStrategy.get(winner) ?? 0) + 1);
    winnerMap.set(domain, byStrategy);
  }
  return winnerMap;
}

function buildPerDomainTransferStatsWithDiagnostics(events: any[]) {
  const EVIDENCE_RECENT_WINDOW = 200;
  const EVIDENCE_EWMA_ALPHA = 0.2;
  const map = new Map<string, {
    outcomes: number[];
    match_confidences: number[];
    evidence_confidences: number[];
    evidence_observations: number[];
    applied_micro_scales: number[];
    applied_micro_variance_signals: number[];
    applied_micro_variance_signal_names: string[];
    total: number;
    initialized: number;
    impact_applied: number;
    impact_applied_micro: number;
    impact_applied_micro_with_signal: number;
    memory_updated: number;
    evidence_events_seen: number;
    evidence_events_accepted: number;
    evidence_drop_reason_last: string | null;
    evidence_drop_reason_recent_last: string | null;
    evidence_drop_reasons_recent: Array<string | null>;
    evidence_observations_before: number;
    evidence_observations_after: number;
    evidence_observations_recent: number[];
    evidence_observations_recent_sum: number;
    evidence_observations_latest: number | null;
    evidence_observations_ewma: number | null;
  }>();
  const evidenceDiagnostics = {
    events_scanned: 0,
    evidence_events_seen: 0,
    evidence_events_accepted: 0,
    drop_reason_breakdown: {} as Record<string, number>,
    samples: [] as Array<{
      event_id: string | null;
      ts: string | null;
      campaign_id: string | null;
      tick_id: string | null;
      tick_index: number | null;
      experiment_id: string | null;
      domain_signature: string;
      domain_profile: any | null;
      evidence_events_seen: number;
      evidence_events_accepted: number;
      evidence_observations_before: number;
      evidence_observations_after: number;
      drop_reason: string | null;
    }>,
  };
  const incDropReason = (reason: string) => {
    const key = String(reason || "unknown");
    evidenceDiagnostics.drop_reason_breakdown[key] = (evidenceDiagnostics.drop_reason_breakdown[key] ?? 0) + 1;
  };

  for (const ev of events) {
    if (ev?.type !== "experiment_complete") continue;
    evidenceDiagnostics.events_scanned += 1;
    const payload = ev?.payload ?? {};
    const gate = extractEvidenceGateFromPayload(payload);
    const domainFromTransfer = String(payload?.metrics?.transfer_context?.domain_signature ?? "").trim();
    const domainFromProfile = domainSignatureFromProfile(payload?.metrics?.domain_profile);
    const domainFromGate = String(gate?.domain_signature ?? "").trim();
    const domain = domainFromGate || domainFromProfile || domainFromTransfer || "unknown";
    const initialized = Boolean(payload?.metrics?.transfer_context?.transfer_initialized);
    const matchConfidence = Number(payload?.metrics?.transfer_context?.transfer_confidence ?? NaN);
    const evidenceConfidence = Number(gate?.evidence_confidence ?? NaN);
    const evidenceObs = coerceObservations(gate?.observations);
    const impactApplied = payload?.transfer_memory_update?.impact_applied === true ? 1 : 0;
    const impactLevelRaw = String(gate?.impact_level ?? "none");
    const impactLevel = impactApplied ? impactLevelRaw : "none";
    const impactScale = Number(gate?.impact_scale ?? NaN);
    const effectProxy = Number(gate?.effect_proxy ?? NaN);
    const impactAppliedMicro = (impactApplied === 1 && impactLevel === "micro") ? 1 : 0;
    const memoryUpdated = (
      payload?.transfer_memory_update?.memory_updated === true
      || payload?.transfer_memory_update?.updated === true
    ) ? 1 : 0;
    const agg = map.get(domain) ?? {
      outcomes: [],
      match_confidences: [],
      evidence_confidences: [],
      evidence_observations: [],
      applied_micro_scales: [],
      applied_micro_variance_signals: [],
      applied_micro_variance_signal_names: [],
      total: 0,
      initialized: 0,
      impact_applied: 0,
      impact_applied_micro: 0,
      impact_applied_micro_with_signal: 0,
      memory_updated: 0,
      evidence_events_seen: 0,
      evidence_events_accepted: 0,
      evidence_drop_reason_last: null,
      evidence_drop_reason_recent_last: null,
      evidence_drop_reasons_recent: [],
      evidence_observations_before: 0,
      evidence_observations_after: 0,
      evidence_observations_recent: [],
      evidence_observations_recent_sum: 0,
      evidence_observations_latest: null,
      evidence_observations_ewma: null,
    };
    const evidenceObsBefore = agg.evidence_observations.length > 0
      ? Math.max(...agg.evidence_observations.map((x) => Math.max(0, Math.trunc(Number(x)))))
      : 0;
    let evidenceSeen = 0;
    let evidenceAccepted = 0;
    let evidenceDropReason: string | null = null;
    agg.total += 1;
    if (gate && typeof gate === "object") {
      evidenceSeen = 1;
      agg.evidence_events_seen += 1;
      evidenceDiagnostics.evidence_events_seen += 1;
    } else {
      evidenceDropReason = "no_evidence_gate";
    }
    if (initialized) {
      agg.initialized += 1;
      agg.outcomes.push(impactApplied);
      agg.impact_applied += impactApplied;
      agg.impact_applied_micro += impactAppliedMicro;
      agg.memory_updated += memoryUpdated;
      if (impactAppliedMicro === 1 && Number.isFinite(impactScale)) {
        agg.applied_micro_scales.push(impactScale);
      }
      if (impactAppliedMicro === 1) {
        let varianceSignalName = "transfer_confidence";
        let varianceSignal = matchConfidence;
        if (Number.isFinite(effectProxy)) {
          varianceSignalName = "effect_proxy";
          varianceSignal = effectProxy;
        } else if (!Number.isFinite(varianceSignal)) {
          varianceSignalName = "impact_scale_x_confidence";
          varianceSignal = (Number.isFinite(impactScale) && Number.isFinite(matchConfidence))
            ? (impactScale * matchConfidence)
            : NaN;
        }
        if (Number.isFinite(varianceSignal)) {
          agg.applied_micro_variance_signals.push(varianceSignal);
          agg.applied_micro_variance_signal_names.push(varianceSignalName);
          agg.impact_applied_micro_with_signal += 1;
        }
      }
      if (Number.isFinite(matchConfidence)) agg.match_confidences.push(matchConfidence);
      if (Number.isFinite(evidenceConfidence)) agg.evidence_confidences.push(evidenceConfidence);
      if (evidenceSeen === 1) {
        if (evidenceObs != null) {
          agg.evidence_observations.push(evidenceObs);
          agg.evidence_events_accepted += 1;
          evidenceDiagnostics.evidence_events_accepted += 1;
          evidenceAccepted = 1;
          agg.evidence_observations_latest = evidenceObs;
          agg.evidence_observations_ewma = agg.evidence_observations_ewma == null
            ? evidenceObs
            : ((1 - EVIDENCE_EWMA_ALPHA) * agg.evidence_observations_ewma) + (EVIDENCE_EWMA_ALPHA * evidenceObs);
          agg.evidence_observations_recent.push(evidenceObs);
          agg.evidence_observations_recent_sum += evidenceObs;
          if (agg.evidence_observations_recent.length > EVIDENCE_RECENT_WINDOW) {
            const removed = agg.evidence_observations_recent.shift();
            if (Number.isFinite(removed)) {
              agg.evidence_observations_recent_sum -= Number(removed);
            }
          }
        } else {
          evidenceDropReason = "evidence_observations_missing_or_non_numeric";
        }
      }
    } else if (evidenceSeen === 1) {
      evidenceDropReason = "transfer_not_initialized";
    }
    if (evidenceSeen === 1 && evidenceAccepted === 0 && !evidenceDropReason) {
      evidenceDropReason = "evidence_filtered_unknown";
    }
    if (evidenceDropReason) {
      agg.evidence_drop_reason_last = evidenceDropReason;
      incDropReason(evidenceDropReason);
    }
    agg.evidence_drop_reasons_recent.push(evidenceDropReason);
    if (agg.evidence_drop_reasons_recent.length > EVIDENCE_RECENT_WINDOW) {
      agg.evidence_drop_reasons_recent.shift();
    }
    const recentLastNonNull = [...agg.evidence_drop_reasons_recent]
      .reverse()
      .find((x) => typeof x === "string" && x.length > 0) ?? null;
    agg.evidence_drop_reason_recent_last = recentLastNonNull;
    const evidenceObsAfter = agg.evidence_observations.length > 0
      ? Math.max(...agg.evidence_observations.map((x) => Math.max(0, Math.trunc(Number(x)))))
      : evidenceObsBefore;
    agg.evidence_observations_before = evidenceObsBefore;
    agg.evidence_observations_after = evidenceObsAfter;
    const sampleItem = {
      event_id: typeof ev?.event_id === "string" ? ev.event_id : null,
      ts: typeof ev?.ts === "string" ? ev.ts : null,
      campaign_id: typeof payload?.campaign_id === "string"
        ? payload.campaign_id
        : (typeof payload?.strategy_context?.campaign_id === "string" ? payload.strategy_context.campaign_id : null),
      tick_id: typeof payload?.strategy_context?.tick_id === "string"
        ? payload.strategy_context.tick_id
        : null,
      tick_index: Number.isFinite(Number(gate?.tick_index))
        ? Math.trunc(Number(gate.tick_index))
        : (Number.isFinite(Number(payload?.strategy_context?.tick_index))
          ? Math.trunc(Number(payload.strategy_context.tick_index))
          : null),
      experiment_id: typeof payload?.experiment_id === "string" ? payload.experiment_id : null,
      domain_signature: domain,
      domain_profile: payload?.metrics?.domain_profile ?? null,
      evidence_events_seen: evidenceSeen,
      evidence_events_accepted: evidenceAccepted,
      evidence_observations_before: evidenceObsBefore,
      evidence_observations_after: evidenceObsAfter,
      evidence_observations_raw_value_type: typeof gate?.observations_raw_value_type === "string"
        ? gate.observations_raw_value_type
        : (gate?.observations == null
          ? "nullish"
          : (Array.isArray(gate?.observations) ? "array" : typeof gate?.observations)),
      drop_reason: evidenceDropReason,
    };
    evidenceDiagnostics.samples.push(sampleItem);
    if (evidenceDiagnostics.samples.length > 60) {
      evidenceDiagnostics.samples.shift();
    }
    map.set(domain, agg);
  }
  const perDomain = Array.from(map.entries()).map(([domain_signature, agg]) => {
    const successRate = agg.outcomes.length > 0 ? average(agg.outcomes) : 0;
    const varianceVal = agg.outcomes.length > 1 ? variance(agg.outcomes) : 0;
    const varianceAppliedMicro = safeVariance(agg.applied_micro_variance_signals);
    const varianceAppliedMicroMin = safeMin(agg.applied_micro_variance_signals);
    const varianceAppliedMicroMax = safeMax(agg.applied_micro_variance_signals);
    const varianceSignalMode = (() => {
      if (agg.applied_micro_variance_signal_names.length === 0) return null;
      const counts = new Map<string, number>();
      for (const n of agg.applied_micro_variance_signal_names) {
        counts.set(n, (counts.get(n) ?? 0) + 1);
      }
      return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    })();
    const avgMatchConfidence = agg.match_confidences.length > 0 ? average(agg.match_confidences) : 0;
    const avgEvidenceConfidence = agg.evidence_confidences.length > 0 ? average(agg.evidence_confidences) : 0;
    const avgImpactScaleMicro = agg.applied_micro_scales.length > 0 ? average(agg.applied_micro_scales) : 0;
    const latestEvidenceObs = agg.evidence_observations.length > 0
      ? Math.max(...agg.evidence_observations.map((x) => Math.max(0, Math.trunc(Number(x)))))
      : 0;
    const recentN = agg.evidence_observations_recent.length;
    const recentMax = recentN > 0 ? Math.max(...agg.evidence_observations_recent) : null;
    const recentMean = recentN > 0 ? (agg.evidence_observations_recent_sum / recentN) : null;
    return {
      domain_signature,
      experiments_total: agg.total,
      transfer_initialized: agg.initialized,
      confidence_observations: agg.match_confidences.length,
      evidence_observations: latestEvidenceObs,
      evidence_observations_latest: agg.evidence_observations_latest == null ? null : Number(agg.evidence_observations_latest.toFixed(6)),
      evidence_observations_recent_n: recentN,
      evidence_observations_recent_max: recentMax == null ? null : Number(recentMax.toFixed(6)),
      evidence_observations_recent_mean: recentMean == null ? null : Number(recentMean.toFixed(6)),
      evidence_observations_recent_ewma: agg.evidence_observations_ewma == null ? null : Number(agg.evidence_observations_ewma.toFixed(6)),
      evidence_events_seen: agg.evidence_events_seen,
      evidence_events_accepted: agg.evidence_events_accepted,
      evidence_observations_before: agg.evidence_observations_before,
      evidence_observations_after: agg.evidence_observations_after,
      evidence_drop_reason_last: agg.evidence_drop_reason_last,
      evidence_drop_reason_recent_last: agg.evidence_drop_reason_recent_last,
      transfer_success_rate: Number(successRate.toFixed(6)),
      transfer_variance: Number(varianceVal.toFixed(6)),
      transfer_variance_applied_micro: varianceAppliedMicro,
      transfer_variance_applied_micro_n: agg.applied_micro_variance_signals.length,
      transfer_variance_applied_micro_applied: agg.impact_applied_micro_with_signal,
      transfer_variance_applied_micro_signal: varianceSignalMode,
      transfer_variance_applied_micro_min: varianceAppliedMicroMin,
      transfer_variance_applied_micro_max: varianceAppliedMicroMax,
      average_transfer_confidence: Number(avgMatchConfidence.toFixed(6)),
      average_transfer_evidence_confidence: Number(avgEvidenceConfidence.toFixed(6)),
      average_impact_scale_micro: Number(avgImpactScaleMicro.toFixed(6)),
      impact_applied_share: Number((agg.initialized > 0 ? agg.impact_applied / agg.initialized : 0).toFixed(6)),
      impact_applied_share_micro: Number((agg.initialized > 0 ? agg.impact_applied_micro / agg.initialized : 0).toFixed(6)),
      memory_updated_share: Number((agg.initialized > 0 ? agg.memory_updated / agg.initialized : 0).toFixed(6)),
    };
  }).sort((a, b) => b.transfer_variance - a.transfer_variance);
  return {
    perDomain,
    evidenceDiagnostics,
  };
}

function buildPerDomainTransferStats(events: any[]) {
  return buildPerDomainTransferStatsWithDiagnostics(events).perDomain;
}

export async function arenaTelemetrySnapshot(opts: {
  syncDir: string;
  limit_domains?: number;
}) {
  const { memoryItems, events } = await loadTelemetryContext(opts.syncDir);
  const winnerMap = summarizeDomainWinnerEvents(events);
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(opts.limit_domains ?? 100))));

  const domains = memoryItems.slice(0, limit).map((entry: any) => {
    const domainSignature = String(entry?.domain_signature ?? "unknown");
    const strategies = Array.isArray(entry?.strategy_pool) ? entry.strategy_pool : [];
    const winners = winnerMap.get(domainSignature) ?? new Map<string, number>();
    const totalWins = Array.from(winners.values()).reduce((acc, n) => acc + n, 0);
    const transferUsageCount = strategies.reduce((acc: number, s: any) => {
      const te = Number(s?.transfer_effectiveness ?? 0);
      return acc + (te > 0.5 ? 1 : 0);
    }, 0);
    const strategyWeights = strategies.map((s: any) => strategyWeightForEntropy(s));
    const activeWeights = strategies
      .filter((s: any) => String(s?.status ?? "") === "active")
      .map((s: any) => strategyWeightForEntropy(s));
    const shadowWeights = strategies
      .filter((s: any) => String(s?.status ?? "") === "shadow")
      .map((s: any) => strategyWeightForEntropy(s));
    const totalWeight = strategyWeights.reduce((acc: number, w: number) => acc + Math.max(0, Number(w ?? 0)), 0);
    const shadowWeightTotal = shadowWeights.reduce((acc: number, w: number) => acc + Math.max(0, Number(w ?? 0)), 0);
    const topActiveWeight = activeWeights.length > 0 ? Math.max(...activeWeights.map((w: number) => Math.max(0, Number(w ?? 0)))) : 0;
    const sortedAllWeights = strategyWeights
      .map((w: number) => Math.max(0, Number(w ?? 0)))
      .filter((w: number) => Number.isFinite(w) && w > 0)
      .sort((a: number, b: number) => b - a);
    const top1Weight = sortedAllWeights.length > 0 ? sortedAllWeights[0] : 0;
    const top3Weight = sortedAllWeights.slice(0, 3).reduce((acc: number, w: number) => acc + w, 0);
    const weightsVectorTail = strategies
      .map((s: any) => Number(strategyWeightForEntropy(s) ?? 0))
      .filter((v: number) => Number.isFinite(v) && v > 0)
      .sort((a: number, b: number) => b - a)
      .slice(0, 4)
      .map((v: number) => Number(v.toFixed(6)));
    const lineageCounts = new Map<string, number>();
    for (const s of strategies) {
      const lineageId = String(s?.lineage_id ?? "");
      if (!lineageId) continue;
      lineageCounts.set(lineageId, (lineageCounts.get(lineageId) ?? 0) + 1);
    }
    const lineageWeights = Array.from(lineageCounts.values()).map((n) => Number(n));

    return {
      domain_signature: domainSignature,
      domain_profile: entry?.domain_profile ?? null,
      strategy_count: strategies.length,
      active_count: strategies.filter((s: any) => String(s?.status ?? "") === "active").length,
      shadow_count: strategies.filter((s: any) => String(s?.status ?? "") === "shadow").length,
      inactive_count: strategies.filter((s: any) => String(s?.status ?? "") === "inactive").length,
      strategy_entropy: Number(normalizedEntropy(strategyWeights).toFixed(6)),
      domain_entropy: Number(normalizedEntropy(strategyWeights).toFixed(6)),
      effective_num_strategies: Number(effectiveStrategyCount(strategyWeights).toFixed(6)),
      lineage_entropy: Number(normalizedEntropy(lineageWeights).toFixed(6)),
      shadow_share: Number((totalWeight > 0 ? (shadowWeightTotal / totalWeight) : 0).toFixed(6)),
      top1_share: Number((totalWeight > 0 ? (top1Weight / totalWeight) : 0).toFixed(6)),
      top3_share: Number((totalWeight > 0 ? (top3Weight / totalWeight) : 0).toFixed(6)),
      top_active_share: Number((totalWeight > 0 ? (topActiveWeight / totalWeight) : 0).toFixed(6)),
      weights_vector_tail: weightsVectorTail,
      strategies: strategies
        .map((s: any) => {
          const strategyId = String(s?.strategy_id ?? "unknown");
          const wins = winners.get(strategyId) ?? 0;
          const winRate = totalWins > 0 ? wins / totalWins : 0;
          return {
            strategy_id: strategyId,
            version_id: String(s?.version_id ?? ""),
            fitness: Number(s?.fitness ?? 0),
            status: String(s?.status ?? "active"),
            win_rate: Number(winRate.toFixed(6)),
            convergence_speed: Number((1 / Math.max(1, Number(s?.avg_convergence_steps ?? 0))).toFixed(6)),
            variance_stability: Number(s?.avg_variance_stability ?? 1),
            transfer_usage: Number(clamp01(Number(s?.transfer_effectiveness ?? 0)).toFixed(6)),
            allocation_weight: Number(strategyWeightForEntropy(s).toFixed(6)),
            selection_count_window: Math.max(0, Math.trunc(Number(s?.selection_count_window ?? 0))),
          };
        })
        .sort((a: any, b: any) => b.fitness - a.fitness),
      transfer_usage_pct: strategies.length > 0
        ? Number(((transferUsageCount / strategies.length) * 100).toFixed(2))
        : 0,
      arena_state: entry?.arena_state ?? null,
    };
  });

  return {
    snapshot: {
      generated_at: new Date().toISOString(),
      domains_count: domains.length,
      domains,
    },
    report_md: markdown("Arena Telemetry Snapshot", [
      `- Domains scanned: ${domains.length}`,
      `- Top domain by strategy count: ${domains[0]?.domain_signature ?? "n/a"}`,
    ]),
  };
}

export async function mutationEffectivenessSnapshot(opts: { syncDir: string }) {
  const { agents, history } = await loadTelemetryContext(opts.syncDir);
  const byRoleVersion = new Map<string, any>();
  for (const a of agents) {
    byRoleVersion.set(`${a.role}:${a.version}`, a);
  }

  const mutationEvents = history.filter((h) => h?.type === "version.create");
  let adaptiveTotal = 0;
  let adaptiveImproved = 0;
  let metaTotal = 0;
  let metaImproved = 0;

  for (const ev of mutationEvents) {
    const role = String(ev?.role ?? "");
    const version = Number(ev?.version ?? NaN);
    const parentVersion = Number(ev?.parent_version ?? NaN);
    if (!role || !Number.isFinite(version) || !Number.isFinite(parentVersion)) continue;
    const child = byRoleVersion.get(`${role}:${version}`);
    const parent = byRoleVersion.get(`${role}:${parentVersion}`);
    if (!child || !parent) continue;
    const childFitness = Number(child?.metrics?.research_fitness ?? 0);
    const parentFitness = Number(parent?.metrics?.research_fitness ?? 0);
    const improved = childFitness > parentFitness;

    if (ev?.mutation_reason) {
      adaptiveTotal += 1;
      if (improved) adaptiveImproved += 1;
    }
    if (ev?.meta_mutation_reason) {
      metaTotal += 1;
      if (improved) metaImproved += 1;
    }
  }

  const adaptiveRatio = adaptiveTotal > 0 ? adaptiveImproved / adaptiveTotal : 0;
  const metaRatio = metaTotal > 0 ? metaImproved / metaTotal : 0;
  const totalMut = adaptiveTotal + metaTotal;
  const totalImproved = adaptiveImproved + metaImproved;

  return {
    snapshot: {
      generated_at: new Date().toISOString(),
      adaptive_mutation: {
        total_mutations: adaptiveTotal,
        improved_after_mutation: adaptiveImproved,
        mutation_effectiveness_ratio: Number(adaptiveRatio.toFixed(6)),
      },
      meta_mutation: {
        total_mutations: metaTotal,
        improved_after_mutation: metaImproved,
        mutation_effectiveness_ratio: Number(metaRatio.toFixed(6)),
      },
      overall: {
        total_mutations: totalMut,
        improved_after_mutation: totalImproved,
        mutation_effectiveness_ratio: Number((totalMut > 0 ? totalImproved / totalMut : 0).toFixed(6)),
      },
    },
    report_md: markdown("Mutation Effectiveness", [
      `- Adaptive: ${adaptiveImproved}/${adaptiveTotal}`,
      `- Meta: ${metaImproved}/${metaTotal}`,
      `- Overall ratio: ${Number((totalMut > 0 ? totalImproved / totalMut : 0).toFixed(4))}`,
    ]),
  };
}

export async function transferDiagnosticsSnapshot(opts: { syncDir: string }) {
  const { memoryItems, events } = await loadTelemetryContext(opts.syncDir);
  const complete = events.filter((ev) => ev?.type === "experiment_complete");
  const anomaly = events.filter((ev) => ev?.type === "experiment_anomaly");
  const completeWithEvidenceGate = complete.filter((ev) => Boolean(extractEvidenceGateFromPayload(ev?.payload)));
  const completeWithEvidenceGateSchemaV2 = completeWithEvidenceGate.filter((ev) => isEvidenceGateSchemaV2(ev?.payload));
  const completeWithEvidenceGateLegacy = completeWithEvidenceGate.filter((ev) => !isEvidenceGateSchemaV2(ev?.payload));
  const recentWindowSize = 2000;
  const completeRecent = complete.slice(-recentWindowSize);
  const completeRecentWithEvidenceGate = completeRecent.filter((ev) => Boolean(extractEvidenceGateFromPayload(ev?.payload)));
  const completeRecentWithEvidenceGateSchemaV2 = completeRecentWithEvidenceGate.filter((ev) => isEvidenceGateSchemaV2(ev?.payload));
  const completeRecentWithEvidenceGateLegacy = completeRecentWithEvidenceGate.filter((ev) => !isEvidenceGateSchemaV2(ev?.payload));
  const transferRecentEvents = completeRecent.filter((ev) => Boolean(ev?.payload?.metrics?.transfer_context?.transfer_initialized));
  const transferRecentWithEvidenceGate = transferRecentEvents.filter((ev) => Boolean(extractEvidenceGateFromPayload(ev?.payload)));
  const transferRecentWithEvidenceGateSchemaV2 = transferRecentWithEvidenceGate.filter((ev) => isEvidenceGateSchemaV2(ev?.payload));
  const transferRecentWithEvidenceGateLegacy = transferRecentWithEvidenceGate.filter((ev) => !isEvidenceGateSchemaV2(ev?.payload));
  const recentMissingEvidenceGateCount = transferRecentEvents.filter((ev) => {
    const gate = extractEvidenceGateFromPayload(ev?.payload);
    const impactApplied = ev?.payload?.transfer_memory_update?.impact_applied === true;
    return !gate && !impactApplied;
  }).length;
  const recentAppliedMicro = transferRecentWithEvidenceGateSchemaV2.filter((ev) => {
    const gate = extractEvidenceGateFromPayload(ev?.payload);
    const level = String(gate?.impact_level ?? "none");
    return ev?.payload?.transfer_memory_update?.impact_applied === true && level === "micro";
  }).length;
  const recentMicroBlockedByBudget = transferRecentWithEvidenceGateSchemaV2.filter((ev) => {
    const gate = extractEvidenceGateFromPayload(ev?.payload);
    return gate?.micro_throttled_by_budget === true;
  }).length;
  const recentMicroNotConsideredByBudget = transferRecentWithEvidenceGateSchemaV2.filter((ev) => {
    const gate = extractEvidenceGateFromPayload(ev?.payload);
    return gate?.micro_not_considered_due_to_budget === true;
  }).length;

  const transferEvents = complete.filter((ev) => Boolean(ev?.payload?.metrics?.transfer_context?.transfer_initialized));
  const successTransfer = transferEvents.filter((ev) => ev?.payload?.transfer_memory_update?.impact_applied === true);
  const matchConfidences = transferEvents
    .map((ev) => Number(ev?.payload?.metrics?.transfer_context?.transfer_confidence ?? NaN))
    .filter((v) => Number.isFinite(v));
  const evidenceConfidences = transferEvents
    .map((ev) => Number(extractEvidenceGateFromPayload(ev?.payload)?.evidence_confidence ?? NaN))
    .filter((v) => Number.isFinite(v));
  const appliedTransferEvents = transferEvents.filter((ev) => ev?.payload?.transfer_memory_update?.impact_applied === true);
  const appliedMicroTransferEvents = transferEvents.filter((ev) => {
    const update = ev?.payload?.transfer_memory_update;
    const gate = extractEvidenceGateFromPayload(ev?.payload);
    const level = String(gate?.impact_level ?? "none");
    return update?.impact_applied === true && level === "micro" && isEvidenceGateSchemaV2(ev?.payload);
  });
  const appliedConfidences = appliedTransferEvents
    .map((ev) => Number(extractEvidenceGateFromPayload(ev?.payload)?.evidence_confidence ?? NaN))
    .filter((v) => Number.isFinite(v));
  const appliedMatchConfidences = appliedTransferEvents
    .map((ev) => Number(ev?.payload?.metrics?.transfer_context?.transfer_confidence ?? NaN))
    .filter((v) => Number.isFinite(v));
  const appliedMicroImpactScales = appliedMicroTransferEvents
    .map((ev) => Number(extractEvidenceGateFromPayload(ev?.payload)?.impact_scale ?? NaN))
    .filter((v) => Number.isFinite(v));
  const effectProxySignals = appliedMicroTransferEvents
    .map((ev) => Number(extractEvidenceGateFromPayload(ev?.payload)?.effect_proxy ?? NaN))
    .filter((v) => Number.isFinite(v));
  const confidenceSignals = appliedMicroTransferEvents
    .map((ev) => Number(ev?.payload?.metrics?.transfer_context?.transfer_confidence ?? NaN))
    .filter((v) => Number.isFinite(v));
  let appliedMicroVarianceSignalName = "transfer_confidence";
  let appliedMicroVarianceSignals = confidenceSignals;
  if (effectProxySignals.length > 0) {
    appliedMicroVarianceSignalName = "effect_proxy";
    appliedMicroVarianceSignals = effectProxySignals;
  } else if (confidenceSignals.length === 0) {
    appliedMicroVarianceSignalName = "impact_scale_x_confidence";
    appliedMicroVarianceSignals = appliedMicroTransferEvents
      .map((ev) => {
        const gate = extractEvidenceGateFromPayload(ev?.payload);
        const impactScale = Number(gate?.impact_scale ?? NaN);
        const transferConfidence = Number(ev?.payload?.metrics?.transfer_context?.transfer_confidence ?? NaN);
        if (!Number.isFinite(impactScale) || !Number.isFinite(transferConfidence)) return NaN;
        return impactScale * transferConfidence;
      })
      .filter((v) => Number.isFinite(v));
  }
  let microGateBlocked = 0;
  let obsGateBlocked = 0;
  let transferWithEvidenceGate = 0;
  let transferWithEvidenceGateSchemaV2 = 0;
  let transferWithEvidenceGateLegacy = 0;
  let missingEvidenceGateCount = 0;
  let evidenceGateFlagInvalidCount = 0;
  let microGatePassed = 0;
  let microGatePassedStrict = 0;
  let microSuccessBlocked = 0;
  let successSignalFullTrue = 0;
  let successSignalMicroTrue = 0;
  let impactLevelNone = 0;
  let impactLevelMicro = 0;
  let impactLevelFull = 0;
  let impactScaleMicroSum = 0;
  let impactScaleMicroCount = 0;
  const impactScaleMicroValues: number[] = [];
  let microThrottledCount = 0;
  let microThrottledByBudgetCount = 0;
  let microCooldownActiveCount = 0;
  let microDomainTickCooldownCount = 0;
  let impactAllowedMicroCount = 0;
  let microDomainTickCooldownWhenAllowedCount = 0;
  let microAttemptedCount = 0;
  let microNotConsideredDueToBudgetCount = 0;
  let microBlockedByDomainTickCooldownCount = 0;
  let microBlockedByBudgetCount = 0;
  let microBlockedByOtherGatesCount = 0;
  let impactAttemptedCount = 0;
  const impactSkipReasonBreakdown: Record<string, number> = {};
  const incSkipReason = (reason: string) => {
    const key = String(reason || "unknown");
    impactSkipReasonBreakdown[key] = (impactSkipReasonBreakdown[key] ?? 0) + 1;
  };
  for (const ev of transferEvents) {
    const gate = extractEvidenceGateFromPayload(ev?.payload);
    const transferUpdate = ev?.payload?.transfer_memory_update;
    const impactApplied = transferUpdate?.impact_applied === true;
    if (!gate) {
      if (!impactApplied) missingEvidenceGateCount += 1;
      continue;
    }
    transferWithEvidenceGate += 1;
    if (!isEvidenceGateSchemaV2(ev?.payload)) {
      transferWithEvidenceGateLegacy += 1;
      continue;
    }
    transferWithEvidenceGateSchemaV2 += 1;
    const matchFailedRaw = gate?.match_gate_failed;
    const obsFailedRaw = gate?.observations_gate_failed;
    const microFailedRaw = gate?.micro_confidence_gate_failed;
    const confFailedRaw = gate?.confidence_gate_failed;
    const allGateFlagsBoolean = [matchFailedRaw, obsFailedRaw, microFailedRaw, confFailedRaw]
      .every((v) => typeof v === "boolean");
    if (!allGateFlagsBoolean) evidenceGateFlagInvalidCount += 1;

    const matchFailed = matchFailedRaw === true;
    const obsFailed = obsFailedRaw === true;
    const microFailed = microFailedRaw === true;

    if (microFailed) microGateBlocked += 1;
    if (obsFailed) obsGateBlocked += 1;

    const microPassed = !matchFailed && !obsFailed && !microFailed;
    const microPassedStrict = allGateFlagsBoolean && microPassed;
    if (microPassed) microGatePassed += 1;
    if (microPassedStrict) {
      microGatePassedStrict += 1;
      if (gate?.impact_allowed_micro === false) microSuccessBlocked += 1;
    }
    if (gate?.transfer_success_signal_full === true) successSignalFullTrue += 1;
    if (gate?.transfer_success_signal_micro === true) successSignalMicroTrue += 1;
    const impactLevel = String(gate?.impact_level ?? "none");
    const impactScale = Number(gate?.impact_scale ?? NaN);
    const microThrottledByCooldown = gate?.micro_throttled_by_cooldown === true;
    const microThrottledByVariance = gate?.micro_throttled_by_variance === true;
    const microThrottledByBudget = gate?.micro_throttled_by_budget === true;
    const microThrottledByDomainTickCooldown = gate?.micro_throttled_by_domain_tick_cooldown === true;
    const microNotConsideredDueToBudget = gate?.micro_not_considered_due_to_budget === true;
    const microDomainTickCooldown = gate?.micro_domain_tick_cooldown === true;
    const impactAllowedMicro = gate?.impact_allowed_micro === true;
    const microCooldownTicksRemaining = Number(gate?.micro_cooldown_ticks_remaining ?? NaN);
    if (microThrottledByCooldown || microThrottledByVariance || microThrottledByBudget) microThrottledCount += 1;
    if (microThrottledByBudget) microThrottledByBudgetCount += 1;
    if (microDomainTickCooldown) microDomainTickCooldownCount += 1;
    if (impactAllowedMicro) {
      impactAllowedMicroCount += 1;
      if (microDomainTickCooldown) microDomainTickCooldownWhenAllowedCount += 1;
    }
    if (Number.isFinite(microCooldownTicksRemaining) && microCooldownTicksRemaining > 0) microCooldownActiveCount += 1;
    const attempted = impactLevel === "micro" || impactLevel === "full" || (Number.isFinite(impactScale) && impactScale > 0);
    if (attempted) impactAttemptedCount += 1;
    const microAttempted = gate?.micro_attempted === true;
    if (microAttempted) {
      microAttemptedCount += 1;
      if (microDomainTickCooldown || microThrottledByDomainTickCooldown) {
        microBlockedByDomainTickCooldownCount += 1;
      } else if (microThrottledByBudget) {
        microBlockedByBudgetCount += 1;
      } else if (!impactApplied && impactLevel !== "micro") {
        microBlockedByOtherGatesCount += 1;
      }
    }
    if (microNotConsideredDueToBudget) {
      microNotConsideredDueToBudgetCount += 1;
    }

    if (impactLevel === "micro") {
      impactLevelMicro += 1;
      if (Number.isFinite(impactScale)) {
        impactScaleMicroSum += impactScale;
        impactScaleMicroCount += 1;
        impactScaleMicroValues.push(impactScale);
      }
    } else if (impactLevel === "full") {
      impactLevelFull += 1;
    } else {
      impactLevelNone += 1;
    }

    if (!impactApplied) {
      if (!allGateFlagsBoolean) incSkipReason("evidence_gate_flags_invalid");
      else if (matchFailed) incSkipReason("match_gate_failed");
      else if (obsFailed) incSkipReason("observations_gate_failed");
      else if (microFailed) incSkipReason("micro_confidence_gate_failed");
      else if (microDomainTickCooldown) incSkipReason("micro_domain_tick_cooldown");
      else if (impactLevel === "none" && gate?.impact_allowed_micro === false) incSkipReason("impact_allowed_micro_false");
      else if (impactLevel === "none") incSkipReason("impact_level_none");
      else if (!Number.isFinite(impactScale) || impactScale <= 0) incSkipReason("impact_scale_zero");
      else incSkipReason(String(transferUpdate?.reason ?? "not_applied_unknown"));
    }
  }
  let belowConfMinAmongApplied = 0;
  let belowConfMinDenominator = 0;
  for (const ev of appliedMicroTransferEvents) {
    const gate = extractEvidenceGateFromPayload(ev?.payload);
    const signalValue = Number(gate?.micro_gate_signal_value ?? NaN);
    const threshold = Number(gate?.micro_gate_threshold ?? NaN);
    if (!Number.isFinite(signalValue) || !Number.isFinite(threshold)) {
      evidenceGateFlagInvalidCount += 1;
      continue;
    }
    belowConfMinDenominator += 1;
    if (signalValue < threshold) belowConfMinAmongApplied += 1;
  }
  const similarities: number[] = [];
  for (const item of memoryItems) {
    const ts = Number(item?.last_transfer_confidence ?? NaN);
    if (Number.isFinite(ts)) similarities.push(ts);
  }

  let blocked = 0;
  let totalStrategies = 0;
  for (const entry of memoryItems) {
    const pool = Array.isArray(entry?.strategy_pool) ? entry.strategy_pool : [];
    totalStrategies += pool.length;
    for (const s of pool) {
      const bu = Date.parse(String(s?.reuse_blocked_until ?? ""));
      if (Number.isFinite(bu) && bu > Date.now()) blocked += 1;
    }
  }

  const transferSuccessRate = transferEvents.length > 0 ? successTransfer.length / transferEvents.length : 0;
  const avgMatchConfidence = matchConfidences.length > 0 ? matchConfidences.reduce((a, b) => a + b, 0) / matchConfidences.length : 0;
  const avgEvidenceConfidence = evidenceConfidences.length > 0 ? evidenceConfidences.reduce((a, b) => a + b, 0) / evidenceConfidences.length : 0;
  const avgAppliedConfidence = appliedConfidences.length > 0
    ? appliedConfidences.reduce((a, b) => a + b, 0) / appliedConfidences.length
    : 0;
  const avgAppliedMatchConfidence = appliedMatchConfidences.length > 0
    ? appliedMatchConfidences.reduce((a, b) => a + b, 0) / appliedMatchConfidences.length
    : 0;
  const transferVarianceAppliedMicro = safeVariance(appliedMicroVarianceSignals);
  const transferVarianceAppliedMicroDisplay = transferVarianceAppliedMicro == null
    ? null
    : (Math.abs(transferVarianceAppliedMicro) < 1e-6
      ? transferVarianceAppliedMicro.toExponential(6)
      : Number(transferVarianceAppliedMicro.toFixed(6)).toString());
  const transferVarianceAppliedMicroMin = safeMin(appliedMicroVarianceSignals);
  const transferVarianceAppliedMicroMax = safeMax(appliedMicroVarianceSignals);
  const appliedMicroSignalsSample = appliedMicroVarianceSignals.slice(0, 12);
  const shareBelowConfMinAmongApplied = belowConfMinDenominator > 0
    ? belowConfMinAmongApplied / belowConfMinDenominator
    : 0;
  const avgSimilarity = similarities.length > 0 ? similarities.reduce((a, b) => a + b, 0) / similarities.length : 0;
  const reuseBlockRate = totalStrategies > 0 ? blocked / totalStrategies : 0;
  const anomalyRate = complete.length > 0 ? anomaly.length / complete.length : 0;
  const perDomainTransferDetailed = buildPerDomainTransferStatsWithDiagnostics(events);
  const perDomainTransfer = perDomainTransferDetailed.perDomain;
  const evidenceObservationDiagnostics = perDomainTransferDetailed.evidenceDiagnostics;
  const highVarianceDomains = perDomainTransfer.filter((d) => d.transfer_variance >= 0.12).slice(0, 5);
  const highVarianceDomainsTop2 = perDomainTransfer.slice(0, 2);
  const lowConfidenceDomains = perDomainTransfer
    .filter((d) => d.average_transfer_evidence_confidence > 0 && d.average_transfer_evidence_confidence < 0.18)
    .slice(0, 5);
  const lowConfidenceDomainShare = perDomainTransfer.length > 0
    ? lowConfidenceDomains.length / perDomainTransfer.length
    : 0;
  const impactAppliedShare = transferEvents.length > 0
    ? successTransfer.length / transferEvents.length
    : 0;
  const microGateBlockShare = transferWithEvidenceGateSchemaV2 > 0
    ? microGateBlocked / transferWithEvidenceGateSchemaV2
    : 0;
  const obsGateBlockShare = transferWithEvidenceGateSchemaV2 > 0
    ? obsGateBlocked / transferWithEvidenceGateSchemaV2
    : 0;
  const microGatePassShare = transferWithEvidenceGateSchemaV2 > 0
    ? microGatePassed / transferWithEvidenceGateSchemaV2
    : 0;
  const microGatePassShareStrict = transferWithEvidenceGateSchemaV2 > 0
    ? microGatePassedStrict / transferWithEvidenceGateSchemaV2
    : 0;
  const microSuccessBlockShare = microGatePassedStrict > 0
    ? microSuccessBlocked / microGatePassedStrict
    : 0;
  const transferSuccessSignalFullShare = transferWithEvidenceGateSchemaV2 > 0
    ? successSignalFullTrue / transferWithEvidenceGateSchemaV2
    : 0;
  const transferSuccessSignalMicroShare = transferWithEvidenceGateSchemaV2 > 0
    ? successSignalMicroTrue / transferWithEvidenceGateSchemaV2
    : 0;
  const impactLevelShare = transferWithEvidenceGateSchemaV2 > 0
    ? {
      none: Number((impactLevelNone / transferWithEvidenceGateSchemaV2).toFixed(6)),
      micro: Number((impactLevelMicro / transferWithEvidenceGateSchemaV2).toFixed(6)),
      full: Number((impactLevelFull / transferWithEvidenceGateSchemaV2).toFixed(6)),
    }
    : { none: 0, micro: 0, full: 0 };
  const avgImpactScaleMicro = impactScaleMicroCount > 0
    ? impactScaleMicroSum / impactScaleMicroCount
    : 0;
  const sortedImpactScaleMicroValues = impactScaleMicroValues
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const p95ImpactScaleMicro = sortedImpactScaleMicroValues.length > 0
    ? percentile(sortedImpactScaleMicroValues, 0.95)
    : 0;
  const microImpactThrottledShare = transferWithEvidenceGateSchemaV2 > 0
    ? microThrottledCount / transferWithEvidenceGateSchemaV2
    : 0;
  const microCooldownActiveShare = transferWithEvidenceGateSchemaV2 > 0
    ? microCooldownActiveCount / transferWithEvidenceGateSchemaV2
    : 0;
  const microThrottledByBudgetShare = transferWithEvidenceGateSchemaV2 > 0
    ? microThrottledByBudgetCount / transferWithEvidenceGateSchemaV2
    : 0;
  const microDomainTickCooldownShare = impactAllowedMicroCount > 0
    ? microDomainTickCooldownWhenAllowedCount / impactAllowedMicroCount
    : 0;
  const microAttemptedShare = transferWithEvidenceGateSchemaV2 > 0
    ? microAttemptedCount / transferWithEvidenceGateSchemaV2
    : 0;
  const microBlockedByDomainTickCooldownShare = microAttemptedCount > 0
    ? microBlockedByDomainTickCooldownCount / microAttemptedCount
    : 0;
  const microBlockedByBudgetShare = microAttemptedCount > 0
    ? microBlockedByBudgetCount / microAttemptedCount
    : 0;
  const microBlockedByOtherGatesShare = microAttemptedCount > 0
    ? microBlockedByOtherGatesCount / microAttemptedCount
    : 0;
  const microNotConsideredDueToBudgetShare = transferWithEvidenceGateSchemaV2 > 0
    ? microNotConsideredDueToBudgetCount / transferWithEvidenceGateSchemaV2
    : 0;
  const microAppliedShare = transferWithEvidenceGateSchemaV2 > 0
    ? appliedMicroTransferEvents.length / transferWithEvidenceGateSchemaV2
    : 0;

  return {
    snapshot: {
      generated_at: new Date().toISOString(),
      transfer_success_rate: Number(transferSuccessRate.toFixed(6)),
      average_similarity: Number(avgSimilarity.toFixed(6)),
      average_transfer_confidence: Number(avgMatchConfidence.toFixed(6)),
      average_transfer_match_confidence: Number(avgMatchConfidence.toFixed(6)),
      average_transfer_evidence_confidence: Number(avgEvidenceConfidence.toFixed(6)),
      average_transfer_confidence_applied: Number(avgAppliedConfidence.toFixed(6)),
      average_transfer_match_confidence_applied: Number(avgAppliedMatchConfidence.toFixed(6)),
      transfer_variance_applied_micro: transferVarianceAppliedMicro == null ? null : Number(transferVarianceAppliedMicro.toFixed(6)),
      transfer_variance_applied_micro_raw: transferVarianceAppliedMicro,
      transfer_variance_applied_micro_display: transferVarianceAppliedMicroDisplay,
      transfer_variance_applied_micro_n: appliedMicroVarianceSignals.length,
      transfer_variance_applied_micro_applied: appliedMicroTransferEvents.length,
      transfer_variance_applied_micro_signal: appliedMicroVarianceSignalName,
      transfer_variance_applied_micro_min: transferVarianceAppliedMicroMin == null ? null : Number(transferVarianceAppliedMicroMin.toFixed(6)),
      transfer_variance_applied_micro_max: transferVarianceAppliedMicroMax == null ? null : Number(transferVarianceAppliedMicroMax.toFixed(6)),
      applied_micro_signals_sample: appliedMicroSignalsSample.map((v) => Number(v.toFixed(6))),
      share_conf_below_confmin_among_applied: Number(shareBelowConfMinAmongApplied.toFixed(6)),
      reuse_block_rate: Number(reuseBlockRate.toFixed(6)),
      anomaly_rate: Number(anomalyRate.toFixed(6)),
      impact_applied_share: Number(impactAppliedShare.toFixed(6)),
      micro_gate_block_share: Number(microGateBlockShare.toFixed(6)),
      obs_gate_block_share: Number(obsGateBlockShare.toFixed(6)),
      micro_gate_pass_share: Number(microGatePassShare.toFixed(6)),
      micro_gate_pass_share_strict: Number(microGatePassShareStrict.toFixed(6)),
      micro_success_block_share: Number(microSuccessBlockShare.toFixed(6)),
      micro_impact_throttled_share: Number(microImpactThrottledShare.toFixed(6)),
      micro_impact_throttled_by_budget_share: Number(microThrottledByBudgetShare.toFixed(6)),
      micro_cooldown_active_share: Number(microCooldownActiveShare.toFixed(6)),
      micro_domain_tick_cooldown_share: Number(microDomainTickCooldownShare.toFixed(6)),
      micro_attempted_share: Number(microAttemptedShare.toFixed(6)),
      micro_blocked_by_domain_tick_cooldown_count: microBlockedByDomainTickCooldownCount,
      micro_blocked_by_domain_tick_cooldown_share: Number(microBlockedByDomainTickCooldownShare.toFixed(6)),
      micro_blocked_by_budget_count: microBlockedByBudgetCount,
      micro_blocked_by_budget_share: Number(microBlockedByBudgetShare.toFixed(6)),
      micro_not_considered_due_to_budget_count: microNotConsideredDueToBudgetCount,
      micro_not_considered_due_to_budget_share: Number(microNotConsideredDueToBudgetShare.toFixed(6)),
      micro_blocked_by_other_gates_count: microBlockedByOtherGatesCount,
      micro_blocked_by_other_gates_share: Number(microBlockedByOtherGatesShare.toFixed(6)),
      micro_applied_share: Number(microAppliedShare.toFixed(6)),
      evidence_gate_flag_invalid_count: evidenceGateFlagInvalidCount,
      impact_attempted_count: impactAttemptedCount,
      impact_skip_reason_breakdown: impactSkipReasonBreakdown,
      missing_evidence_gate_count: missingEvidenceGateCount,
      transfer_success_signal_full_share: Number(transferSuccessSignalFullShare.toFixed(6)),
      transfer_success_signal_micro_share: Number(transferSuccessSignalMicroShare.toFixed(6)),
      impact_level_share: impactLevelShare,
      avg_impact_scale_micro: Number(avgImpactScaleMicro.toFixed(6)),
      cap_micro_used_avg: Number(avgImpactScaleMicro.toFixed(6)),
      cap_micro_used_p95: Number(p95ImpactScaleMicro.toFixed(6)),
      low_confidence_domain_share: Number(lowConfidenceDomainShare.toFixed(6)),
      evidence_observations_diagnostics: {
        events_scanned: evidenceObservationDiagnostics.events_scanned,
        evidence_events_seen: evidenceObservationDiagnostics.evidence_events_seen,
        evidence_events_accepted: evidenceObservationDiagnostics.evidence_events_accepted,
        drop_reason_breakdown: evidenceObservationDiagnostics.drop_reason_breakdown,
        samples: evidenceObservationDiagnostics.samples,
      },
      counts: {
        experiments_completed: complete.length,
        experiment_complete_with_evidence_gate: completeWithEvidenceGate.length,
        experiment_complete_with_evidence_gate_schema_v2: completeWithEvidenceGateSchemaV2.length,
        experiment_complete_with_evidence_gate_legacy: completeWithEvidenceGateLegacy.length,
        transfer_initialized: transferEvents.length,
        transfer_successful: successTransfer.length,
        transfer_with_evidence_gate: transferWithEvidenceGate,
        transfer_with_evidence_gate_schema_v2: transferWithEvidenceGateSchemaV2,
        transfer_with_evidence_gate_legacy: transferWithEvidenceGateLegacy,
      },
      recent_window: {
        events_considered: completeRecent.length,
        experiment_complete_with_evidence_gate: completeRecentWithEvidenceGate.length,
        experiment_complete_with_evidence_gate_schema_v2: completeRecentWithEvidenceGateSchemaV2.length,
        experiment_complete_with_evidence_gate_legacy: completeRecentWithEvidenceGateLegacy.length,
        transfer_initialized: transferRecentEvents.length,
        transfer_with_evidence_gate: transferRecentWithEvidenceGate.length,
        transfer_with_evidence_gate_schema_v2: transferRecentWithEvidenceGateSchemaV2.length,
        transfer_with_evidence_gate_legacy: transferRecentWithEvidenceGateLegacy.length,
        missing_evidence_gate_count: recentMissingEvidenceGateCount,
        missing_evidence_gate_share: transferRecentEvents.length > 0
          ? Number((recentMissingEvidenceGateCount / transferRecentEvents.length).toFixed(6))
          : 0,
        micro_applied_share: transferRecentWithEvidenceGateSchemaV2.length > 0
          ? Number((recentAppliedMicro / transferRecentWithEvidenceGateSchemaV2.length).toFixed(6))
          : 0,
        micro_blocked_by_budget_share: transferRecentWithEvidenceGateSchemaV2.length > 0
          ? Number((recentMicroBlockedByBudget / transferRecentWithEvidenceGateSchemaV2.length).toFixed(6))
          : 0,
        micro_not_considered_due_to_budget_share: transferRecentWithEvidenceGateSchemaV2.length > 0
          ? Number((recentMicroNotConsideredByBudget / transferRecentWithEvidenceGateSchemaV2.length).toFixed(6))
          : 0,
      },
      per_domain_transfer: perDomainTransfer,
      stressed_driver_breakdown: {
        high_variance_domains: highVarianceDomains,
        high_variance_domains_top2: highVarianceDomainsTop2,
        low_confidence_domains: lowConfidenceDomains,
      },
    },
    report_md: markdown("Transfer Diagnostics", [
      `- Transfer success rate: ${Number(transferSuccessRate.toFixed(4))}`,
      `- Avg transfer confidence (match): ${Number(avgMatchConfidence.toFixed(4))}`,
      `- Avg transfer confidence (evidence): ${Number(avgEvidenceConfidence.toFixed(4))}`,
      `- Reuse block rate: ${Number(reuseBlockRate.toFixed(4))}`,
      `- Anomaly rate: ${Number(anomalyRate.toFixed(4))}`,
      `- High variance domains: ${highVarianceDomains.length}`,
      `- Low confidence domains: ${lowConfidenceDomains.length}`,
    ]),
  };
}

export async function intelligenceHealthSnapshot(opts: { syncDir: string }) {
  const { agents, history, events } = await loadTelemetryContext(opts.syncDir);
  const researchActive = agents
    .filter((a: any) => a?.role === "research" && a?.active)
    .sort((a: any, b: any) => Number(b?.version ?? 0) - Number(a?.version ?? 0))[0];

  const globalFitnessRaw = Number(researchActive?.metrics?.research_fitness ?? 0);
  const globalFitness = clamp01(globalFitnessRaw);
  const stability = clamp01(Number(researchActive?.metrics?.research_stats?.meta_stability_index ?? 0));

  const mutation = await mutationEffectivenessSnapshot({ syncDir: opts.syncDir });
  const transfer = await transferDiagnosticsSnapshot({ syncDir: opts.syncDir });

  const mutationEff = Number(mutation.snapshot.overall.mutation_effectiveness_ratio ?? 0);
  const transferEff = Number(transfer.snapshot.transfer_success_rate ?? 0);
  const anomalyRate = Number(transfer.snapshot.anomaly_rate ?? 0);

  const weights = {
    w1: 0.3,
    w2: 0.25,
    w3: 0.2,
    w4: 0.15,
    w5: 0.1,
  };

  const gihiRaw =
    (weights.w1 * globalFitness) +
    (weights.w2 * stability) +
    (weights.w3 * transferEff) +
    (weights.w4 * mutationEff) -
    (weights.w5 * anomalyRate);
  const gihi = clamp01(gihiRaw);

  const trajectory = history
    .filter((h) => h?.type === "research.impact")
    .map((h) => ({
      ts: String(h?.ts ?? ""),
      research_fitness: Number(h?.research_fitness ?? 0),
      meta_stability_index: Number(h?.research_stats?.meta_stability_index ?? 0),
      domain_size: String(h?.sample?.domain_profile?.size_category ?? "unknown"),
    }))
    .slice(-200);

  const globalTrajectory = events
    .filter((ev) => ev?.type === "experiment_complete")
    .map((ev) => ({
      ts: String(ev?.ts ?? ""),
      global_research_fitness: Number(ev?.payload?.research_fitness ?? 0),
      domain_signature: String(ev?.payload?.metrics?.transfer_context?.domain_signature ?? ""),
    }))
    .slice(-200);

  return {
    snapshot: {
      generated_at: new Date().toISOString(),
      global_intelligence_health_index: Number(gihi.toFixed(6)),
      components: {
        normalized_global_fitness: Number(globalFitness.toFixed(6)),
        stability_index: Number(stability.toFixed(6)),
        transfer_effectiveness: Number(transferEff.toFixed(6)),
        mutation_effectiveness: Number(mutationEff.toFixed(6)),
        anomaly_rate: Number(anomalyRate.toFixed(6)),
      },
      weights,
      fitness_trajectory: {
        global: globalTrajectory,
        research_impact: trajectory,
      },
    },
    report_md: markdown("Global Intelligence Health", [
      `- GIHI: ${Number(gihi.toFixed(4))}`,
      `- Fitness: ${Number(globalFitness.toFixed(4))}`,
      `- Stability: ${Number(stability.toFixed(4))}`,
      `- Transfer effectiveness: ${Number(transferEff.toFixed(4))}`,
      `- Mutation effectiveness: ${Number(mutationEff.toFixed(4))}`,
      `- Anomaly rate: ${Number(anomalyRate.toFixed(4))}`,
    ]),
  };
}

export async function intelligenceMetaSnapshot(opts: {
  syncDir: string;
  mutation_window?: number;
  transfer_window?: number;
  gihi_window?: number;
  campaign_id?: string;
}) {
  const mutationWindow = Math.max(5, Math.min(500, Math.trunc(Number(opts.mutation_window ?? 40))));
  const transferWindow = Math.max(5, Math.min(500, Math.trunc(Number(opts.transfer_window ?? 60))));
  const gihiWindow = Math.max(5, Math.min(500, Math.trunc(Number(opts.gihi_window ?? 40))));
  const { memoryItems, agents, history, events } = await loadTelemetryContext(opts.syncDir);

  const domainEntropies: number[] = [];
  const strategyFitnessByVersion = new Map<string, number[]>();
  for (const entry of memoryItems) {
    const pool = Array.isArray(entry?.strategy_pool) ? entry.strategy_pool : [];
    const activePool = pool.filter((s: any) => s?.status !== "inactive");
    const weights = activePool.map((s: any) => strategyWeightForEntropy(s));
    domainEntropies.push(normalizedEntropy(weights));
    for (const strategy of activePool) {
      const strategyKey = String(strategy?.version_id ?? strategy?.strategy_id ?? "");
      if (!strategyKey) continue;
      const list = strategyFitnessByVersion.get(strategyKey) ?? [];
      list.push(Number(strategy?.fitness ?? 0));
      strategyFitnessByVersion.set(strategyKey, list);
    }
  }
  const arenaEntropy = average(domainEntropies);

  const specializationVariance: number[] = [];
  for (const values of strategyFitnessByVersion.values()) {
    if (values.length < 2) continue;
    specializationVariance.push(variance(values));
  }
  const domainSpecializationIndex = clamp01(average(specializationVariance));

  const byRoleVersion = new Map<string, any>();
  for (const agent of agents) byRoleVersion.set(`${agent.role}:${agent.version}`, agent);
  const deltas: number[] = [];
  for (const ev of history.filter((h) => h?.type === "version.create")) {
    const role = String(ev?.role ?? "");
    const version = Number(ev?.version ?? NaN);
    const parentVersion = Number(ev?.parent_version ?? NaN);
    if (!role || !Number.isFinite(version) || !Number.isFinite(parentVersion)) continue;
    const child = byRoleVersion.get(`${role}:${version}`);
    const parent = byRoleVersion.get(`${role}:${parentVersion}`);
    if (!child || !parent) continue;
    const delta = Number(child?.metrics?.research_fitness ?? 0) - Number(parent?.metrics?.research_fitness ?? 0);
    if (Number.isFinite(delta)) deltas.push(delta);
  }
  const mutationRoiSeries = deltas.slice(-mutationWindow);
  const mutationRoiTrend = linearRegressionSlope(mutationRoiSeries);

  const transferFlags = events
    .filter((ev) => ev?.type === "experiment_complete")
    .map((ev) => {
      const initialized = Boolean(ev?.payload?.metrics?.transfer_context?.transfer_initialized);
      if (!initialized) return null;
      return ev?.payload?.transfer_memory_update?.impact_applied === true ? 1 : 0;
    })
    .filter((v) => v === 0 || v === 1) as number[];
  const transferSeries = transferFlags.slice(-transferWindow);
  const transferVariance = variance(transferSeries);
  const transferWindowHalf = Math.max(2, Math.floor(transferSeries.length / 2));
  const transferPrev = transferSeries.slice(Math.max(0, transferSeries.length - (transferWindowHalf * 2)), Math.max(0, transferSeries.length - transferWindowHalf));
  const transferRecent = transferSeries.slice(-transferWindowHalf);
  const transferVarianceTrend = Number((variance(transferRecent) - variance(transferPrev)).toFixed(6));
  const perDomainTransfer = buildPerDomainTransferStats(events);
  const highVarianceDomains = perDomainTransfer.filter((d) => d.transfer_variance >= 0.12).slice(0, 5);
  const lowConfidenceDomains = perDomainTransfer
    .filter((d) => d.average_transfer_evidence_confidence > 0 && d.average_transfer_evidence_confidence < 0.18)
    .slice(0, 5);
  const completeEvents = events.filter((ev) => ev?.type === "experiment_complete");
  const anomalyEvents = events.filter((ev) => ev?.type === "experiment_anomaly");
  const anomalyRate = completeEvents.length > 0 ? anomalyEvents.length / completeEvents.length : 0;

  const gihiPoints = await readCampaignGihiSeries(opts.syncDir);
  const gihiSeriesRaw = gihiPoints.map((p) => Number(p.gihi));
  const shortWindow = Math.max(5, Math.min(gihiWindow, 12));
  const longWindow = Math.max(gihiWindow, 40);
  const targetCampaignId = typeof opts.campaign_id === "string" && opts.campaign_id.trim()
    ? opts.campaign_id.trim()
    : "";
  const scopedSeries = targetCampaignId
    ? gihiPoints.filter((p) => p.campaign_id === targetCampaignId)
    : selectCampaignScopedWindow(gihiPoints, Math.max(shortWindow, 12));
  const shortBase = scopedSeries.length >= 2 ? scopedSeries : gihiPoints;
  const gihiPointsShort = shortBase.slice(-shortWindow);
  const gihiPointsLong = gihiPoints.slice(-longWindow);
  const gihiPointsUltra = shortBase.slice(-4);
  const gihiSeriesShort = gihiPointsShort.map((p) => Number(p.gihi));
  const gihiSeriesLong = gihiPointsLong.map((p) => Number(p.gihi));
  const gihiSeriesUltra = gihiPointsUltra.map((p) => Number(p.gihi));
  const shortWinsor = winsorize(gihiSeriesShort, 0.1);
  const gihiSlopeShort = linearRegressionSlope(gihiSeriesShort);
  const gihiSlopeShortRobust = linearRegressionSlope(shortWinsor.values);
  const gihiSlopeLong = linearRegressionSlope(gihiSeriesLong);
  const firstShort = gihiSeriesShort[0] ?? 0;
  const lastShort = gihiSeriesShort[gihiSeriesShort.length - 1] ?? 0;
  const gihiDeltaShort = lastShort - firstShort;
  const firstLong = gihiSeriesLong[0] ?? 0;
  const lastLong = gihiSeriesLong[gihiSeriesLong.length - 1] ?? 0;
  const gihiDeltaLong = lastLong - firstLong;
  const firstUltra = gihiSeriesUltra[0] ?? 0;
  const lastUltra = gihiSeriesUltra[gihiSeriesUltra.length - 1] ?? 0;
  const gihiDeltaUltra = lastUltra - firstUltra;
  const worseningShort = gihiDeltaShort < -0.0005;
  const improvingShort = gihiDeltaShort > 0.0005;
  const highDiversity = arenaEntropy >= 0.45;
  const nearFlatShort = Math.abs(gihiSlopeShortRobust) < 0.0009;
  const gihiSpikeFlag =
    shortWinsor.clippedCount > 0 &&
    Math.abs(gihiSlopeShort - gihiSlopeShortRobust) >= 0.0008;
  const stableByPositiveDeltas =
    arenaEntropy >= 0.7 &&
    gihiDeltaUltra > 0 &&
    gihiDeltaShort > 0 &&
    transferVarianceTrend <= 0.01 &&
    anomalyRate <= 0.02;
  const gihiWindows = {
    short: gihiWindowStats(gihiPointsShort),
    ultra: gihiWindowStats(gihiPointsUltra),
    long: gihiWindowStats(gihiPointsLong),
  };
  const gihiSeriesTail = gihiPoints.slice(-6).map((p) => ({
    ts: p.ts_iso,
    campaign_id: p.campaign_id,
    tick_index: p.tick_index,
    gihi: Number(Number(p.gihi).toFixed(6)),
  }));

  const metaTicks = events
    .filter((ev) => ev?.type === "meta.governance.tick")
    .map((ev) => String(ev?.payload?.meta_state ?? ""))
    .filter(Boolean);
  let priorDegeneratingStreak = 0;
  for (let i = metaTicks.length - 1; i >= 0; i -= 1) {
    if (metaTicks[i] !== "degenerating") break;
    priorDegeneratingStreak += 1;
  }
  const degeneratingSignal =
    gihiSlopeShortRobust < -0.0015
    || (gihiSlopeShortRobust < -0.0009 && worseningShort && (gihiSlopeLong < -0.0007 || transferVariance > 0.10));
  const degeneratingAllowedByDelta = gihiDeltaUltra < 0 && gihiSlopeShortRobust < -0.0009;
  const degeneratingAllowedByConsecutive = degeneratingSignal && priorDegeneratingStreak >= 1;

  let metaState: "stressed" | "stable" | "converging" | "degenerating" = "stable";
  if (degeneratingSignal && (degeneratingAllowedByDelta || degeneratingAllowedByConsecutive)) {
    metaState = "degenerating";
  } else if (stableByPositiveDeltas) {
    metaState = "stable";
  } else if (
    (gihiSlopeShortRobust > 0.001 || improvingShort)
    && gihiSlopeLong >= -0.0003
    && transferVariance < 0.07
    && mutationRoiTrend >= 0
  ) {
    metaState = "converging";
  } else if (
    transferVariance > 0.12
    || mutationRoiTrend < -0.001
    || arenaEntropy < 0.2
    || (gihiSlopeShortRobust < -0.0009 && !improvingShort)
  ) {
    metaState = "stressed";
  } else if (highDiversity && (improvingShort || nearFlatShort)) {
    metaState = "stable";
  }

  const currentStableSignal =
    arenaEntropy <= 0.88
    && transferVarianceTrend <= 0
    && gihiDeltaUltra >= 0;
  const currentStressedSignal =
    arenaEntropy > 0.9
    || transferVarianceTrend > 0
    || gihiDeltaUltra < 0;
  const priorMetaTick = [...events]
    .filter((ev) => ev?.type === "meta.governance.tick")
    .slice(-1)[0];
  const priorPayload = priorMetaTick?.payload ?? {};
  const priorArenaEntropy = Number(priorPayload?.arena_entropy ?? NaN);
  const priorTransferVarianceTrend = Number(priorPayload?.transfer_variance_trend ?? NaN);
  const priorGihiDeltaUltra = Number(priorPayload?.gihi_delta_ultra ?? NaN);
  const priorStableSignal =
    Number.isFinite(priorArenaEntropy)
    && Number.isFinite(priorTransferVarianceTrend)
    && Number.isFinite(priorGihiDeltaUltra)
    && priorArenaEntropy <= 0.88
    && priorTransferVarianceTrend <= 0
    && priorGihiDeltaUltra >= 0;
  const priorStressedSignal =
    Number.isFinite(priorArenaEntropy)
    && Number.isFinite(priorTransferVarianceTrend)
    && Number.isFinite(priorGihiDeltaUltra)
    && (priorArenaEntropy > 0.9 || priorTransferVarianceTrend > 0 || priorGihiDeltaUltra < 0);
  if (currentStableSignal && priorStableSignal) {
    metaState = "stable";
  } else if (currentStressedSignal && priorStressedSignal) {
    metaState = "stressed";
  }

  return {
    snapshot: {
      generated_at: new Date().toISOString(),
      arena_entropy: Number(arenaEntropy.toFixed(6)),
      domain_specialization_index: Number(domainSpecializationIndex.toFixed(6)),
      mutation_roi_trend: Number(mutationRoiTrend.toFixed(6)),
      transfer_variance: Number(transferVariance.toFixed(6)),
      transfer_variance_trend: Number(transferVarianceTrend.toFixed(6)),
      gihi_slope: Number(gihiSlopeShort.toFixed(6)),
      gihi_slope_short: Number(gihiSlopeShort.toFixed(6)),
      gihi_slope_short_robust: Number(gihiSlopeShortRobust.toFixed(6)),
      gihi_slope_long: Number(gihiSlopeLong.toFixed(6)),
      gihi_spike_flag: gihiSpikeFlag,
      gihi_delta_short: Number(gihiDeltaShort.toFixed(6)),
      gihi_delta_long: Number(gihiDeltaLong.toFixed(6)),
      gihi_delta_ultra: Number(gihiDeltaUltra.toFixed(6)),
      gihi_window_trim_info: {
        method: "winsorize",
        trim_ratio: 0.1,
        clipped_points_count: shortWinsor.clippedCount,
        lower_bound: Number(shortWinsor.lowerBound.toFixed(6)),
        upper_bound: Number(shortWinsor.upperBound.toFixed(6)),
        points_count: gihiSeriesShort.length,
      },
      gihi_windows: gihiWindows,
      gihi_series_scope: targetCampaignId || (shortBase[0]?.campaign_id ?? "global"),
      gihi_series_len: gihiPoints.length,
      gihi_series_tail: gihiSeriesTail,
      per_domain_transfer: perDomainTransfer,
      stressed_driver_breakdown: {
        high_variance_domains: highVarianceDomains,
        low_confidence_domains: lowConfidenceDomains,
        transfer_variance_trend: Number(transferVarianceTrend.toFixed(6)),
        anomaly_rate: Number(anomalyRate.toFixed(6)),
        prior_degenerating_streak: priorDegeneratingStreak,
        degenerating_signal: degeneratingSignal,
        degenerating_allowed_by_delta: degeneratingAllowedByDelta,
        degenerating_allowed_by_consecutive: degeneratingAllowedByConsecutive,
      },
      meta_state: metaState,
      windows: {
        mutation_window: mutationWindow,
        transfer_window: transferWindow,
        gihi_window: gihiWindow,
        gihi_short_window: shortWindow,
        gihi_long_window: longWindow,
        gihi_ultra_window: gihiSeriesUltra.length,
      },
      counts: {
        domains: memoryItems.length,
        mutation_events: mutationRoiSeries.length,
        transfer_events: transferSeries.length,
        gihi_points: gihiSeriesShort.length,
      },
    },
    report_md: markdown("Intelligence Meta Snapshot", [
      `- meta_state: ${metaState}`,
      `- arena_entropy: ${Number(arenaEntropy.toFixed(4))}`,
      `- domain_specialization_index: ${Number(domainSpecializationIndex.toFixed(4))}`,
      `- mutation_roi_trend: ${Number(mutationRoiTrend.toFixed(4))}`,
      `- transfer_variance: ${Number(transferVariance.toFixed(4))}`,
      `- transfer_variance_trend: ${Number(transferVarianceTrend.toFixed(4))}`,
      `- gihi_slope_short: ${Number(gihiSlopeShort.toFixed(4))}`,
      `- gihi_slope_short_robust: ${Number(gihiSlopeShortRobust.toFixed(4))}`,
      `- gihi_slope_long: ${Number(gihiSlopeLong.toFixed(4))}`,
      `- gihi_delta_short: ${Number(gihiDeltaShort.toFixed(4))}`,
      `- gihi_delta_long: ${Number(gihiDeltaLong.toFixed(4))}`,
      `- gihi_delta_ultra: ${Number(gihiDeltaUltra.toFixed(4))}`,
      `- gihi_spike_flag: ${gihiSpikeFlag}`,
    ]),
  };
}

export async function lineageSnapshot(opts: {
  syncDir: string;
  role?: "planner" | "dev" | "research" | "critic";
  limit?: number;
}) {
  const { agents, history, events } = await loadTelemetryContext(opts.syncDir);
  const roleFilter = opts.role;
  const limit = Math.max(1, Math.min(5000, Math.trunc(Number(opts.limit ?? 500))));

  const byRoleVersion = new Map<string, any>();
  for (const a of agents) byRoleVersion.set(`${a.role}:${a.version}`, a);

  const createEvents = history
    .filter((h) => h?.type === "version.create")
    .filter((h) => !roleFilter || h?.role === roleFilter)
    .slice(-limit);

  const survivalByRole = new Map<string, number>();
  for (const ev of events) {
    if (ev?.type !== "agent.completed") continue;
    const role = String(ev?.payload?.role ?? "");
    if (!role) continue;
    survivalByRole.set(role, (survivalByRole.get(role) ?? 0) + 1);
  }

  const nodes = createEvents.map((ev) => {
    const role = String(ev?.role ?? "unknown");
    const version = Number(ev?.version ?? 0);
    const parentVersion = Number(ev?.parent_version ?? 0);
    const record = byRoleVersion.get(`${role}:${version}`);
    return {
      role,
      version,
      parent_version: Number.isFinite(parentVersion) ? parentVersion : null,
      mutation_reason: ev?.mutation_reason ?? null,
      meta_mutation_reason: ev?.meta_mutation_reason ?? null,
      trigger_reasons: ev?.trigger_reasons ?? [],
      active: Boolean(record?.active),
      research_fitness: Number(record?.metrics?.research_fitness ?? 0),
      survival_count: survivalByRole.get(role) ?? 0,
      created_at: String(ev?.ts ?? ""),
    };
  });

  return {
    snapshot: {
      generated_at: new Date().toISOString(),
      role: roleFilter ?? "all",
      nodes_count: nodes.length,
      nodes,
    },
    report_md: markdown("Strategy Lineage Snapshot", [
      `- Role: ${roleFilter ?? "all"}`,
      `- Nodes: ${nodes.length}`,
      `- Latest node: ${nodes[nodes.length - 1]?.role ?? "n/a"}.v${nodes[nodes.length - 1]?.version ?? "?"}`,
    ]),
  };
}
