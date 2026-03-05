import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "../locks.js";
import { safeAppendLine, safeAtomicWrite } from "../fs_atomic.js";
import {
  AGENT_REGISTRY,
  AgentRole,
  AgentProfile,
  DomainSizeCategory,
  normalizeAdaptiveProfile,
  normalizeAdaptiveProfilesByDomain,
  normalizeMetaAdaptiveProfile
} from "./registry.js";

type AgentMetrics = {
  success_count: number;
  failure_count: number;
  avg_completion_time_ms: number;
  total_completion_time_ms: number;
  iterations_per_task: number;
  critic_score: number;
  runs_count: number;
  last_run_at?: string;
  research_stats?: ResearchStats;
  research_fitness?: number;
};

export type ResearchStats = {
  experiments_count: number;
  avg_improvement_delta: number;
  avg_convergence_steps: number;
  exploration_efficiency: number;
  best_score_trend: number;
  stagnation_rate: number;
  variance_stability: number;
  meta_stability_index: number;
  long_term_improvement_trend: number;
  strategy_volatility: number;
  mutation_effectiveness_ratio: number;
  avg_domain_complexity_factor: number;
  domain_stats: Record<DomainSizeCategory, ResearchDomainStats>;
  last_experiment_id?: string;
  last_updated_at?: string;
};

export type ResearchDomainProfile = {
  size_category: DomainSizeCategory;
  metric_noise: "low" | "medium" | "high";
  search_complexity: "low" | "high";
  param_count: number;
};

export type ResearchDomainStats = {
  experiments_count: number;
  avg_improvement_delta: number;
  avg_convergence_steps: number;
  exploration_efficiency: number;
  best_score_trend: number;
  stagnation_rate: number;
  variance_stability: number;
  avg_domain_complexity_factor: number;
  last_experiment_id?: string;
  last_updated_at?: string;
};

export type ResearchImpactSample = {
  experiment_id: string;
  improvement_delta: number;
  convergence_steps: number;
  exploration_efficiency: number;
  best_score_trend: number;
  stagnation_rate: number;
  variance_stability: number;
  domain_profile?: ResearchDomainProfile;
  domain_complexity_factor?: number;
};

export type ResearchFitnessWeights = {
  improvement_weight: number;
  convergence_weight: number;
  exploration_weight: number;
  stability_weight: number;
  stagnation_penalty: number;
  w1?: number;
  w2?: number;
  w3?: number;
  w4?: number;
};

export type EvolutionGovernanceConfig = {
  max_versions_per_role: number;
  max_shadow_per_role: number;
  evolution_cooldown_ms: number;
  min_replay_runs: number;
  promotion_margin_min: number;
  discard_on_instability: boolean;
  max_evolution_attempts_per_day: number;
  stability_success_variance_max: number;
  stability_completion_time_variance_max: number;
  rollback_eval_runs: number;
  rollback_failure_delta: number;
  rollback_critic_delta: number;
};

export type AgentVersionRecord = {
  agent_id: string;
  role: AgentRole;
  version: number;
  active: boolean;
  parent_version?: number;
  created_at: string;
  updated_at: string;
  profile: AgentProfile;
  metrics: AgentMetrics;
  promotion_reason?: string;
  rollback_flag?: boolean;
  promoted_from_version?: number;
};

type AgentStore = {
  version: 1;
  updated_at: string;
  agents: AgentVersionRecord[];
};

const DEFAULT_GOVERNANCE: EvolutionGovernanceConfig = {
  max_versions_per_role: 5,
  max_shadow_per_role: 1,
  evolution_cooldown_ms: 3_600_000,
  min_replay_runs: 3,
  promotion_margin_min: 0.05,
  discard_on_instability: true,
  max_evolution_attempts_per_day: 10,
  stability_success_variance_max: 0.04,
  stability_completion_time_variance_max: 0.35,
  rollback_eval_runs: 3,
  rollback_failure_delta: 0.2,
  rollback_critic_delta: 0.15,
};

function isoNow() {
  return new Date().toISOString();
}

function agentsDir(syncDir: string) {
  return path.join(syncDir, "agents");
}

function agentsFile(syncDir: string) {
  return path.join(agentsDir(syncDir), "registry.json");
}

function governanceFile(syncDir: string) {
  return path.join(agentsDir(syncDir), "governance.json");
}

function historyFile(syncDir: string) {
  return path.join(agentsDir(syncDir), "evolution_history.jsonl");
}

function locksDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

function emptyMetrics(): AgentMetrics {
  return {
    success_count: 0,
    failure_count: 0,
    avg_completion_time_ms: 0,
    total_completion_time_ms: 0,
    iterations_per_task: 0,
    critic_score: 0,
    runs_count: 0,
    research_stats: emptyResearchStats(),
    research_fitness: 0,
  };
}

function emptyResearchStats(): ResearchStats {
  return {
    experiments_count: 0,
    avg_improvement_delta: 0,
    avg_convergence_steps: 0,
    exploration_efficiency: 0,
    best_score_trend: 0,
    stagnation_rate: 1,
    variance_stability: 1,
    meta_stability_index: 1,
    long_term_improvement_trend: 0,
    strategy_volatility: 0,
    mutation_effectiveness_ratio: 0,
    avg_domain_complexity_factor: 1,
    domain_stats: {
      small: emptyResearchDomainStats(),
      medium: emptyResearchDomainStats(),
      large: emptyResearchDomainStats(),
    },
  };
}

function emptyResearchDomainStats(): ResearchDomainStats {
  return {
    experiments_count: 0,
    avg_improvement_delta: 0,
    avg_convergence_steps: 0,
    exploration_efficiency: 0,
    best_score_trend: 0,
    stagnation_rate: 1,
    variance_stability: 1,
    avg_domain_complexity_factor: 1,
  };
}

function normalizeDomainSizeCategory(input: unknown): DomainSizeCategory {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "medium";
  if (raw === "small" || raw === "medium" || raw === "large") return raw;
  return "medium";
}

function normalizeDomainProfile(input?: Partial<ResearchDomainProfile>): ResearchDomainProfile {
  return {
    size_category: normalizeDomainSizeCategory(input?.size_category),
    metric_noise: (input?.metric_noise === "low" || input?.metric_noise === "medium" || input?.metric_noise === "high")
      ? input.metric_noise
      : "medium",
    search_complexity: input?.search_complexity === "high" ? "high" : "low",
    param_count: Math.max(0, Math.trunc(Number(input?.param_count ?? 0))),
  };
}

function normalizeDomainComplexityFactor(input: unknown): number {
  const v = Number(input);
  if (!Number.isFinite(v)) return 1;
  return clampFloat(v, 0.75, 1.75);
}

function normalizeResearchDomainStats(input?: Partial<ResearchDomainStats>): ResearchDomainStats {
  const base = emptyResearchDomainStats();
  if (!input || typeof input !== "object") return base;
  return {
    experiments_count: Math.max(0, Math.trunc(input.experiments_count ?? base.experiments_count)),
    avg_improvement_delta: Number(input.avg_improvement_delta ?? base.avg_improvement_delta),
    avg_convergence_steps: Math.max(0, Number(input.avg_convergence_steps ?? base.avg_convergence_steps)),
    exploration_efficiency: Number(input.exploration_efficiency ?? base.exploration_efficiency),
    best_score_trend: Number(input.best_score_trend ?? base.best_score_trend),
    stagnation_rate: clampFloat(Number(input.stagnation_rate ?? base.stagnation_rate), 0, 1),
    variance_stability: clampFloat(Number(input.variance_stability ?? base.variance_stability), 0, 1),
    avg_domain_complexity_factor: normalizeDomainComplexityFactor(input.avg_domain_complexity_factor ?? base.avg_domain_complexity_factor),
    last_experiment_id: typeof input.last_experiment_id === "string" ? input.last_experiment_id : undefined,
    last_updated_at: typeof input.last_updated_at === "string" ? input.last_updated_at : undefined,
  };
}

function normalizeResearchStats(input?: Partial<ResearchStats>): ResearchStats {
  const base = emptyResearchStats();
  if (!input || typeof input !== "object") return base;
  const rawDomainStats = (input.domain_stats && typeof input.domain_stats === "object")
    ? input.domain_stats as Partial<Record<DomainSizeCategory, Partial<ResearchDomainStats>>>
    : {};
  return {
    experiments_count: Math.max(0, Math.trunc(input.experiments_count ?? base.experiments_count)),
    avg_improvement_delta: Number(input.avg_improvement_delta ?? base.avg_improvement_delta),
    avg_convergence_steps: Math.max(0, Number(input.avg_convergence_steps ?? base.avg_convergence_steps)),
    exploration_efficiency: Number(input.exploration_efficiency ?? base.exploration_efficiency),
    best_score_trend: Number(input.best_score_trend ?? base.best_score_trend),
    stagnation_rate: clampFloat(Number(input.stagnation_rate ?? base.stagnation_rate), 0, 1),
    variance_stability: clampFloat(Number(input.variance_stability ?? base.variance_stability), 0, 1),
    meta_stability_index: clampFloat(Number(input.meta_stability_index ?? base.meta_stability_index), 0, 1),
    long_term_improvement_trend: Number(input.long_term_improvement_trend ?? base.long_term_improvement_trend),
    strategy_volatility: clampFloat(Number(input.strategy_volatility ?? base.strategy_volatility), 0, 1),
    mutation_effectiveness_ratio: clampFloat(Number(input.mutation_effectiveness_ratio ?? base.mutation_effectiveness_ratio), -10, 10),
    avg_domain_complexity_factor: normalizeDomainComplexityFactor(input.avg_domain_complexity_factor ?? base.avg_domain_complexity_factor),
    domain_stats: {
      small: normalizeResearchDomainStats(rawDomainStats.small),
      medium: normalizeResearchDomainStats(rawDomainStats.medium),
      large: normalizeResearchDomainStats(rawDomainStats.large),
    },
    last_experiment_id: typeof input.last_experiment_id === "string" ? input.last_experiment_id : undefined,
    last_updated_at: typeof input.last_updated_at === "string" ? input.last_updated_at : undefined,
  };
}

function normalizeAgentMetrics(input?: Partial<AgentMetrics>): AgentMetrics {
  const base = emptyMetrics();
  return {
    success_count: Math.max(0, Math.trunc(input?.success_count ?? base.success_count)),
    failure_count: Math.max(0, Math.trunc(input?.failure_count ?? base.failure_count)),
    avg_completion_time_ms: Math.max(0, Math.trunc(input?.avg_completion_time_ms ?? base.avg_completion_time_ms)),
    total_completion_time_ms: Math.max(0, Math.trunc(input?.total_completion_time_ms ?? base.total_completion_time_ms)),
    iterations_per_task: Number(input?.iterations_per_task ?? base.iterations_per_task),
    critic_score: Number(input?.critic_score ?? base.critic_score),
    runs_count: Math.max(0, Math.trunc(input?.runs_count ?? base.runs_count)),
    last_run_at: typeof input?.last_run_at === "string" ? input.last_run_at : undefined,
    research_stats: normalizeResearchStats(input?.research_stats),
    research_fitness: Number(input?.research_fitness ?? base.research_fitness ?? 0),
  };
}

function normalizeAgentProfile(input: AgentProfile): AgentProfile {
  if (input.role !== "research") return input;
  const adaptive = normalizeAdaptiveProfile(input.adaptive_profile);
  return {
    ...input,
    adaptive_profile: adaptive,
    adaptive_profiles_by_domain: normalizeAdaptiveProfilesByDomain(input.adaptive_profiles_by_domain, adaptive),
    meta_profile: normalizeMetaAdaptiveProfile(input.meta_profile),
  };
}

function clampInt(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function clampFloat(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function normalizeGovernance(input?: Partial<EvolutionGovernanceConfig>): EvolutionGovernanceConfig {
  const raw = { ...DEFAULT_GOVERNANCE, ...(input ?? {}) };
  return {
    max_versions_per_role: clampInt(raw.max_versions_per_role, 1, 100),
    max_shadow_per_role: clampInt(raw.max_shadow_per_role, 1, 10),
    evolution_cooldown_ms: clampInt(raw.evolution_cooldown_ms, 0, 7 * 24 * 60 * 60 * 1000),
    min_replay_runs: clampInt(raw.min_replay_runs, 1, 500),
    promotion_margin_min: clampFloat(raw.promotion_margin_min, 0, 1),
    discard_on_instability: !!raw.discard_on_instability,
    max_evolution_attempts_per_day: clampInt(raw.max_evolution_attempts_per_day, 1, 1000),
    stability_success_variance_max: clampFloat(raw.stability_success_variance_max, 0, 1),
    stability_completion_time_variance_max: clampFloat(raw.stability_completion_time_variance_max, 0, 5),
    rollback_eval_runs: clampInt(raw.rollback_eval_runs, 1, 50),
    rollback_failure_delta: clampFloat(raw.rollback_failure_delta, 0, 1),
    rollback_critic_delta: clampFloat(raw.rollback_critic_delta, 0, 1),
  };
}

async function ensureTextFile(p: string, content = "") {
  try {
    await fs.stat(p);
  } catch {
    await fs.writeFile(p, content, "utf8");
  }
}

async function loadGovernance(syncDir: string): Promise<EvolutionGovernanceConfig> {
  const file = governanceFile(syncDir);
  await ensureTextFile(file, JSON.stringify(DEFAULT_GOVERNANCE, null, 2));
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<EvolutionGovernanceConfig>;
    return normalizeGovernance(parsed);
  } catch {
    return normalizeGovernance();
  }
}

async function saveGovernance(syncDir: string, config: EvolutionGovernanceConfig) {
  await safeAtomicWrite({
    targetPath: governanceFile(syncDir),
    content: JSON.stringify(config, null, 2),
    retries: 12,
    baseDelayMs: 20,
    useLockFile: true,
  });
}

async function appendHistory(syncDir: string, entry: any) {
  await safeAppendLine({
    targetPath: historyFile(syncDir),
    line: JSON.stringify({ ts: isoNow(), ...entry }),
    retries: 12,
    baseDelayMs: 20,
    useLockFile: true,
  });
}

async function readHistory(syncDir: string): Promise<any[]> {
  try {
    const raw = await fs.readFile(historyFile(syncDir), "utf8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function ensureStore(syncDir: string) {
  await fs.mkdir(agentsDir(syncDir), { recursive: true });
  await ensureTextFile(historyFile(syncDir), "");
  await ensureTextFile(governanceFile(syncDir), JSON.stringify(DEFAULT_GOVERNANCE, null, 2));
  const file = agentsFile(syncDir);
  try {
    await fs.stat(file);
  } catch {
    const now = isoNow();
    const bootstrap: AgentVersionRecord[] = Object.values(AGENT_REGISTRY).map((p) => ({
      agent_id: randomUUID(),
      role: p.role,
      version: 1,
      active: true,
      created_at: now,
      updated_at: now,
      profile: p,
      metrics: emptyMetrics(),
    }));
    const init: AgentStore = {
      version: 1,
      updated_at: now,
      agents: bootstrap,
    };
    await fs.writeFile(file, JSON.stringify(init, null, 2), "utf8");
  }
}

async function loadStore(syncDir: string): Promise<AgentStore> {
  await ensureStore(syncDir);
  const raw = await fs.readFile(agentsFile(syncDir), "utf8");
  const parsed = JSON.parse(raw) as Partial<AgentStore>;
  const agentsRaw = Array.isArray(parsed.agents) ? parsed.agents as AgentVersionRecord[] : [];
  const agents = agentsRaw.map((a) => ({
    ...a,
    profile: normalizeAgentProfile(a.profile),
    metrics: normalizeAgentMetrics(a.metrics),
  }));
  return {
    version: 1,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : isoNow(),
    agents,
  };
}

async function saveStore(syncDir: string, store: AgentStore) {
  store.updated_at = isoNow();
  await safeAtomicWrite({
    targetPath: agentsFile(syncDir),
    content: JSON.stringify(store, null, 2),
    retries: 12,
    baseDelayMs: 20,
    useLockFile: true,
  });
}

async function withLock<T>(syncDir: string, fn: (store: AgentStore) => Promise<T>): Promise<T> {
  const lock = await acquireLock({
    locksDir: locksDir(syncDir),
    name: "agent_registry",
    ttl_ms: 10_000,
  });
  if (!lock.ok || !lock.token) throw new Error("agent_registry lock busy");
  try {
    const store = await loadStore(syncDir);
    const result = await fn(store);
    await saveStore(syncDir, store);
    return result;
  } finally {
    await releaseLock({
      locksDir: locksDir(syncDir),
      name: "agent_registry",
      token: lock.token,
    });
  }
}

export async function agentRegistryList(syncDir: string, role?: AgentRole) {
  const store = await loadStore(syncDir);
  const items = role ? store.agents.filter((a) => a.role === role) : store.agents;
  return { items };
}

export async function governanceGet(syncDir: string) {
  return { governance: await loadGovernance(syncDir) };
}

export async function governanceSet(syncDir: string, patch: Partial<EvolutionGovernanceConfig>) {
  return withLock(syncDir, async () => {
    const current = await loadGovernance(syncDir);
    const merged = normalizeGovernance({ ...current, ...patch });
    await saveGovernance(syncDir, merged);
    await appendHistory(syncDir, { type: "governance.update", governance: merged });
    return { governance: merged };
  });
}

export async function agentGetActiveByRole(syncDir: string, role: AgentRole): Promise<AgentVersionRecord> {
  const store = await loadStore(syncDir);
  const active = store.agents
    .filter((a) => a.role === role && a.active)
    .sort((a, b) => b.version - a.version)[0];
  if (active) return active;
  const latest = store.agents
    .filter((a) => a.role === role)
    .sort((a, b) => b.version - a.version)[0];
  if (!latest) throw new Error(`No agent profile for role: ${role}`);
  return latest;
}

export async function agentMetricsRecordRun(opts: {
  syncDir: string;
  role: AgentRole;
  version: number;
  success: boolean;
  duration_ms: number;
  iterations_per_task?: number;
  critic_score?: number;
}) {
  const governance = await loadGovernance(opts.syncDir);
  return withLock(opts.syncDir, async (store) => {
    const agent = store.agents.find((a) => a.role === opts.role && a.version === opts.version);
    if (!agent) throw new Error(`Agent not found for role=${opts.role} version=${opts.version}`);

    const m = agent.metrics;
    m.runs_count += 1;
    if (opts.success) m.success_count += 1;
    else m.failure_count += 1;
    m.total_completion_time_ms += Math.max(0, Math.trunc(opts.duration_ms));
    m.avg_completion_time_ms = Math.round(m.total_completion_time_ms / Math.max(1, m.runs_count));
    const iter = opts.iterations_per_task ?? 1;
    m.iterations_per_task = ((m.iterations_per_task * (m.runs_count - 1)) + iter) / Math.max(1, m.runs_count);
    if (typeof opts.critic_score === "number" && Number.isFinite(opts.critic_score)) {
      m.critic_score = ((m.critic_score * (m.runs_count - 1)) + opts.critic_score) / Math.max(1, m.runs_count);
    }
    m.last_run_at = isoNow();
    agent.updated_at = isoNow();

    // Safe rollback protection for newly promoted versions.
    if (agent.active && agent.parent_version && m.runs_count >= governance.rollback_eval_runs) {
      const parent = store.agents.find((a) => a.role === agent.role && a.version === agent.parent_version);
      if (parent) {
        const childFailureRate = m.runs_count > 0 ? m.failure_count / m.runs_count : 0;
        const parentFailureRate = parent.metrics.runs_count > 0 ? parent.metrics.failure_count / parent.metrics.runs_count : 0;
        const childCritic = m.critic_score ?? 0;
        const parentCritic = parent.metrics.critic_score ?? 0;
        const failureDegraded = childFailureRate > parentFailureRate + governance.rollback_failure_delta;
        const criticDegraded = childCritic < parentCritic - governance.rollback_critic_delta;
        if (failureDegraded || criticDegraded) {
          agent.active = false;
          agent.rollback_flag = true;
          parent.active = true;
          parent.updated_at = isoNow();
          await appendHistory(opts.syncDir, {
            type: "rollback.auto",
            role: agent.role,
            from_version: agent.version,
            to_version: parent.version,
            reason: failureDegraded ? "failure_rate_degraded" : "critic_score_degraded",
          });
        }
      }
    }

    return { agent };
  });
}

const DEFAULT_RESEARCH_FITNESS_WEIGHTS: ResearchFitnessWeights = {
  improvement_weight: 0.45,
  convergence_weight: 0.2,
  exploration_weight: 0.2,
  stability_weight: 0.15,
  stagnation_penalty: 0.1,
};

function weightedAverage(currentAvg: number, count: number, nextValue: number) {
  if (count <= 0) return nextValue;
  return ((currentAvg * count) + nextValue) / (count + 1);
}

function normalizeResearchFitnessWeights(weights?: Partial<ResearchFitnessWeights>): ResearchFitnessWeights {
  const merged = { ...DEFAULT_RESEARCH_FITNESS_WEIGHTS, ...(weights ?? {}) };
  if (typeof merged.w1 === "number") merged.improvement_weight = merged.w1;
  if (typeof merged.w2 === "number") merged.convergence_weight = merged.w2;
  if (typeof merged.w3 === "number") {
    merged.exploration_weight = merged.w3;
    merged.stability_weight = merged.w3;
  }
  if (typeof merged.w4 === "number") merged.stagnation_penalty = merged.w4;
  return {
    improvement_weight: clampFloat(merged.improvement_weight, 0, 2),
    convergence_weight: clampFloat(merged.convergence_weight, 0, 2),
    exploration_weight: clampFloat(merged.exploration_weight, 0, 2),
    stability_weight: clampFloat(merged.stability_weight, 0, 2),
    stagnation_penalty: clampFloat(merged.stagnation_penalty, 0, 2),
  };
}

function computeResearchFitness(stats: ResearchStats, weights?: Partial<ResearchFitnessWeights>) {
  const w = normalizeResearchFitnessWeights(weights);
  const convergenceTerm = stats.avg_convergence_steps > 0 ? (1 / stats.avg_convergence_steps) : 0;
  const raw =
    (w.improvement_weight * stats.avg_improvement_delta) +
    (w.convergence_weight * convergenceTerm) +
    (w.exploration_weight * stats.exploration_efficiency) +
    (w.stability_weight * stats.variance_stability) -
    (w.stagnation_penalty * stats.stagnation_rate);
  const domainWeighted = raw * normalizeDomainComplexityFactor(stats.avg_domain_complexity_factor);
  return Number(domainWeighted.toFixed(6));
}

export async function agentMetricsRecordResearchImpact(opts: {
  syncDir: string;
  role?: AgentRole;
  version?: number;
  sample: ResearchImpactSample;
  fitness_weights?: Partial<ResearchFitnessWeights>;
}) {
  const role = opts.role ?? "research";
  return withLock(opts.syncDir, async (store) => {
    let agent = typeof opts.version === "number"
      ? store.agents.find((a) => a.role === role && a.version === opts.version)
      : undefined;
    if (!agent) {
      agent = store.agents
        .filter((a) => a.role === role && a.active)
        .sort((a, b) => b.version - a.version)[0];
    }
    if (!agent) throw new Error(`Agent not found for role=${role}${typeof opts.version === "number" ? ` version=${opts.version}` : ""}`);

    const m = agent.metrics;
    const s = normalizeResearchStats(m.research_stats);
    const count = s.experiments_count;

    s.avg_improvement_delta = Number(weightedAverage(s.avg_improvement_delta, count, opts.sample.improvement_delta).toFixed(6));
    s.avg_convergence_steps = Number(weightedAverage(s.avg_convergence_steps, count, opts.sample.convergence_steps).toFixed(6));
    s.exploration_efficiency = Number(weightedAverage(s.exploration_efficiency, count, opts.sample.exploration_efficiency).toFixed(6));
    s.best_score_trend = Number(weightedAverage(s.best_score_trend, count, opts.sample.best_score_trend).toFixed(6));
    s.stagnation_rate = Number(clamp(weightedAverage(s.stagnation_rate, count, opts.sample.stagnation_rate), 0, 1).toFixed(6));
    s.variance_stability = Number(clamp(weightedAverage(s.variance_stability, count, opts.sample.variance_stability), 0, 1).toFixed(6));
    s.long_term_improvement_trend = Number(weightedAverage(s.long_term_improvement_trend, count, opts.sample.best_score_trend).toFixed(6));
    s.meta_stability_index = Number(clamp(s.variance_stability * (1 - s.stagnation_rate), 0, 1).toFixed(6));
    s.strategy_volatility = Number(clamp((1 - s.variance_stability) + (0.25 * s.stagnation_rate), 0, 1).toFixed(6));
    s.mutation_effectiveness_ratio = Number(clamp(
      (s.avg_improvement_delta / Math.max(1, s.avg_convergence_steps)) * Math.max(0, s.exploration_efficiency),
      -10,
      10
    ).toFixed(6));
    s.avg_domain_complexity_factor = Number(weightedAverage(
      s.avg_domain_complexity_factor,
      count,
      normalizeDomainComplexityFactor(opts.sample.domain_complexity_factor ?? 1)
    ).toFixed(6));
    s.experiments_count = count + 1;
    s.last_experiment_id = opts.sample.experiment_id;
    s.last_updated_at = isoNow();
    const domainProfile = normalizeDomainProfile(opts.sample.domain_profile);
    const domainBucket = domainProfile.size_category;
    const ds = normalizeResearchDomainStats(s.domain_stats[domainBucket]);
    const domainCount = ds.experiments_count;
    ds.avg_improvement_delta = Number(weightedAverage(ds.avg_improvement_delta, domainCount, opts.sample.improvement_delta).toFixed(6));
    ds.avg_convergence_steps = Number(weightedAverage(ds.avg_convergence_steps, domainCount, opts.sample.convergence_steps).toFixed(6));
    ds.exploration_efficiency = Number(weightedAverage(ds.exploration_efficiency, domainCount, opts.sample.exploration_efficiency).toFixed(6));
    ds.best_score_trend = Number(weightedAverage(ds.best_score_trend, domainCount, opts.sample.best_score_trend).toFixed(6));
    ds.stagnation_rate = Number(clamp(weightedAverage(ds.stagnation_rate, domainCount, opts.sample.stagnation_rate), 0, 1).toFixed(6));
    ds.variance_stability = Number(clamp(weightedAverage(ds.variance_stability, domainCount, opts.sample.variance_stability), 0, 1).toFixed(6));
    ds.avg_domain_complexity_factor = Number(weightedAverage(
      ds.avg_domain_complexity_factor,
      domainCount,
      normalizeDomainComplexityFactor(opts.sample.domain_complexity_factor ?? 1)
    ).toFixed(6));
    ds.experiments_count = domainCount + 1;
    ds.last_experiment_id = opts.sample.experiment_id;
    ds.last_updated_at = s.last_updated_at;
    s.domain_stats[domainBucket] = ds;

    m.research_stats = s;
    const profileWeights = role === "research" ? agent.profile.meta_profile?.fitness_weights : undefined;
    m.research_fitness = computeResearchFitness(s, { ...(profileWeights ?? {}), ...(opts.fitness_weights ?? {}) });
    m.last_run_at = s.last_updated_at;
    agent.updated_at = isoNow();

    await appendHistory(opts.syncDir, {
      type: "research.impact",
      role,
      version: agent.version,
      sample: opts.sample,
      domain_profile: domainProfile,
      domain_complexity_factor: normalizeDomainComplexityFactor(opts.sample.domain_complexity_factor ?? 1),
      research_stats: s,
      research_fitness: m.research_fitness,
    });

    return { agent, research_fitness: m.research_fitness, research_stats: s };
  });
}

export async function agentVersionCreate(opts: {
  syncDir: string;
  role: AgentRole;
  model?: string;
  temperature?: number;
  system_prompt?: string;
  activate?: boolean;
  parent_version?: number;
}) {
  return withLock(opts.syncDir, async (store) => {
    const roleAgents = store.agents.filter((a) => a.role === opts.role);
    const base = roleAgents.sort((a, b) => b.version - a.version)[0];
    if (!base) throw new Error(`No base agent for role: ${opts.role}`);
    const nextVersion = base.version + 1;
    if (opts.activate ?? true) {
      for (const a of roleAgents) a.active = false;
    }
    const now = isoNow();
    const created: AgentVersionRecord = {
      agent_id: randomUUID(),
      role: opts.role,
      version: nextVersion,
      active: opts.activate ?? true,
      parent_version: opts.parent_version ?? base.version,
      created_at: now,
      updated_at: now,
      profile: {
        ...base.profile,
        model: opts.model ?? base.profile.model,
        temperature: typeof opts.temperature === "number" ? opts.temperature : base.profile.temperature,
        system_prompt: opts.system_prompt ?? base.profile.system_prompt,
        adaptive_profile: base.profile.role === "research"
          ? normalizeAdaptiveProfile(base.profile.adaptive_profile)
          : base.profile.adaptive_profile,
        adaptive_profiles_by_domain: base.profile.role === "research"
          ? normalizeAdaptiveProfilesByDomain(
            base.profile.adaptive_profiles_by_domain,
            normalizeAdaptiveProfile(base.profile.adaptive_profile)
          )
          : base.profile.adaptive_profiles_by_domain,
        meta_profile: base.profile.role === "research"
          ? normalizeMetaAdaptiveProfile(base.profile.meta_profile)
          : base.profile.meta_profile,
      },
      metrics: emptyMetrics(),
    };
    store.agents.push(created);
    await appendHistory(opts.syncDir, {
      type: "version.create",
      role: created.role,
      version: created.version,
      parent_version: created.parent_version ?? null,
      active: created.active,
    });
    return { agent: created };
  });
}

export async function agentMetricsSnapshot(syncDir: string, role?: AgentRole) {
  const store = await loadStore(syncDir);
  const items = (role ? store.agents.filter((a) => a.role === role) : store.agents).map((a) => ({
    role: a.role,
    version: a.version,
    active: a.active,
    profile_id: a.profile.profile_id,
    model: a.profile.model,
    metrics: a.metrics,
    success_rate: a.metrics.runs_count > 0 ? a.metrics.success_count / a.metrics.runs_count : 0,
    failure_rate: a.metrics.runs_count > 0 ? a.metrics.failure_count / a.metrics.runs_count : 0,
  }));
  return { items };
}

export async function agentVersionActivate(opts: {
  syncDir: string;
  role: AgentRole;
  version: number;
  reason?: string;
}) {
  return withLock(opts.syncDir, async (store) => {
    const roleAgents = store.agents.filter((a) => a.role === opts.role);
    const target = roleAgents.find((a) => a.version === opts.version);
    if (!target) throw new Error(`Agent version not found for role=${opts.role} version=${opts.version}`);
    const prevActive = roleAgents.find((a) => a.active);
    for (const a of roleAgents) a.active = false;
    target.active = true;
    target.promoted_from_version = prevActive?.version;
    if (opts.reason) target.promotion_reason = opts.reason;
    target.rollback_flag = false;
    target.updated_at = isoNow();
    await appendHistory(opts.syncDir, {
      type: "version.activate",
      role: target.role,
      version: target.version,
      from_version: prevActive?.version ?? null,
      reason: opts.reason ?? null,
      pre_promotion_snapshot: prevActive ? {
        role: prevActive.role,
        version: prevActive.version,
        metrics: prevActive.metrics,
        profile: prevActive.profile,
      } : null,
    });
    return { agent: target };
  });
}

export async function agentShadowDiscard(opts: {
  syncDir: string;
  role: AgentRole;
  version: number;
}) {
  return withLock(opts.syncDir, async (store) => {
    const idx = store.agents.findIndex((a) => a.role === opts.role && a.version === opts.version);
    if (idx < 0) throw new Error(`Agent shadow not found for role=${opts.role} version=${opts.version}`);
    const target = store.agents[idx];
    if (target.active) throw new Error("Cannot discard active version");
    if (!target.parent_version) throw new Error("Can only discard shadow version with parent_version");
    store.agents.splice(idx, 1);
    await appendHistory(opts.syncDir, {
      type: "shadow.discard",
      role: opts.role,
      version: opts.version,
      parent_version: target.parent_version,
    });
    return { discarded: { role: opts.role, version: opts.version } };
  });
}

export async function agentMetricsOverwrite(opts: {
  syncDir: string;
  role: AgentRole;
  version: number;
  metrics: Partial<AgentMetrics> & { runs_count: number };
  if_empty_only?: boolean;
}) {
  return withLock(opts.syncDir, async (store) => {
    const target = store.agents.find((a) => a.role === opts.role && a.version === opts.version);
    if (!target) throw new Error(`Agent not found for role=${opts.role} version=${opts.version}`);
    if ((opts.if_empty_only ?? true) && target.metrics.runs_count > 0) {
      return { updated: false, reason: "metrics_not_empty" as const, agent: target };
    }
    const m = target.metrics;
    m.success_count = Math.max(0, Math.trunc(opts.metrics.success_count ?? m.success_count));
    m.failure_count = Math.max(0, Math.trunc(opts.metrics.failure_count ?? m.failure_count));
    m.total_completion_time_ms = Math.max(0, Math.trunc(opts.metrics.total_completion_time_ms ?? m.total_completion_time_ms));
    m.avg_completion_time_ms = Math.max(0, Math.trunc(opts.metrics.avg_completion_time_ms ?? m.avg_completion_time_ms));
    m.iterations_per_task = Number(opts.metrics.iterations_per_task ?? m.iterations_per_task);
    m.critic_score = Number(opts.metrics.critic_score ?? m.critic_score);
    m.runs_count = Math.max(0, Math.trunc(opts.metrics.runs_count));
    m.last_run_at = opts.metrics.last_run_at ?? m.last_run_at ?? isoNow();
    m.research_fitness = Number(opts.metrics.research_fitness ?? m.research_fitness ?? 0);
    if (opts.metrics.research_stats && typeof opts.metrics.research_stats === "object") {
      m.research_stats = normalizeResearchStats({
        ...(m.research_stats ?? emptyResearchStats()),
        ...opts.metrics.research_stats,
      });
    } else if (!m.research_stats) {
      m.research_stats = emptyResearchStats();
    }
    target.updated_at = isoNow();
    return { updated: true, agent: target };
  });
}

export async function researchProfileGovernanceTune(opts: {
  syncDir: string;
  adaptive_patch?: Partial<NonNullable<AgentProfile["adaptive_profile"]>>;
  meta_patch?: Partial<NonNullable<AgentProfile["meta_profile"]>>;
}) {
  return withLock(opts.syncDir, async (store) => {
    const target = store.agents
      .filter((a) => a.role === "research" && a.active)
      .sort((a, b) => b.version - a.version)[0];
    if (!target) throw new Error("Active research profile not found");

    const currentAdaptive = normalizeAdaptiveProfile(target.profile.adaptive_profile);
    const currentDomainAdaptive = normalizeAdaptiveProfilesByDomain(
      target.profile.adaptive_profiles_by_domain,
      currentAdaptive
    );
    const currentMeta = normalizeMetaAdaptiveProfile(target.profile.meta_profile);

    const nextAdaptive = opts.adaptive_patch && typeof opts.adaptive_patch === "object"
      ? normalizeAdaptiveProfile({
        ...currentAdaptive,
        ...opts.adaptive_patch,
      })
      : currentAdaptive;
    const nextMeta = opts.meta_patch && typeof opts.meta_patch === "object"
      ? normalizeMetaAdaptiveProfile({
        ...currentMeta,
        ...opts.meta_patch,
      })
      : currentMeta;

    const adaptiveChanged = JSON.stringify(nextAdaptive) !== JSON.stringify(currentAdaptive);
    const metaChanged = JSON.stringify(nextMeta) !== JSON.stringify(currentMeta);
    if (!adaptiveChanged && !metaChanged) {
      return {
        updated: false as const,
        reason: "no_change",
        role: target.role,
        version: target.version,
        adaptive_profile: currentAdaptive,
        adaptive_profiles_by_domain: currentDomainAdaptive,
        meta_profile: currentMeta,
      };
    }

    target.profile = {
      ...target.profile,
      adaptive_profile: nextAdaptive,
      adaptive_profiles_by_domain: normalizeAdaptiveProfilesByDomain(
        target.profile.adaptive_profiles_by_domain,
        nextAdaptive
      ),
      meta_profile: nextMeta,
    };
    target.updated_at = isoNow();
    await appendHistory(opts.syncDir, {
      type: "research.profile.tuned",
      role: "research",
      version: target.version,
      adaptive_changed: adaptiveChanged,
      meta_changed: metaChanged,
      adaptive_patch: opts.adaptive_patch ?? null,
      meta_patch: opts.meta_patch ?? null,
    });
    return {
      updated: true as const,
      role: target.role,
      version: target.version,
      adaptive_profile: target.profile.adaptive_profile,
      adaptive_profiles_by_domain: target.profile.adaptive_profiles_by_domain,
      meta_profile: target.profile.meta_profile,
    };
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mutateTemperature(role: AgentRole, current: number, reasons: string[]) {
  let delta = 0;
  if (reasons.includes("failure_rate")) delta += role === "research" ? -0.05 : -0.1;
  if (reasons.includes("critic_score")) delta += role === "research" ? 0.05 : -0.05;
  if (reasons.includes("avg_completion_time_ms")) delta += role === "research" ? -0.05 : -0.1;
  if (reasons.includes("research_fitness")) delta += role === "research" ? 0.08 : 0;
  if (reasons.includes("stagnation_rate")) delta += role === "research" ? 0.05 : 0;
  if (reasons.includes("convergence_speed")) delta += role === "research" ? -0.03 : 0;
  if (delta === 0) delta = role === "research" ? 0.05 : -0.05;
  return clamp(Number((current + delta).toFixed(2)), 0, 2);
}

function mutateSystemPrompt(base: string, reasons: string[]) {
  const additions: string[] = [];
  if (reasons.includes("failure_rate")) additions.push("Prioritize robustness and explicit validation before completion.");
  if (reasons.includes("critic_score")) additions.push("Strengthen quality checks and explain key trade-offs succinctly.");
  if (reasons.includes("avg_completion_time_ms")) additions.push("Favor shorter plans and faster converging steps.");
  if (reasons.includes("research_fitness")) additions.push("Optimize search-space quality using stronger signal from adaptive experiment feedback.");
  if (reasons.includes("stagnation_rate")) additions.push("Reduce unproductive trials; bias toward diverse, high-information exploration steps.");
  if (reasons.includes("convergence_speed")) additions.push("Prioritize faster convergence in adaptive search while preserving stability.");
  const dedup = Array.from(new Set(additions));
  if (dedup.length === 0) return base;
  return `${base}\n[EVOLUTION_NOTE]\n${dedup.join(" ")}`.trim();
}

type AdaptiveWeakness =
  | "slow_convergence"
  | "stagnation"
  | "high_variance"
  | "weak_improvement_delta";

type AdaptiveMutationThresholds = {
  convergence_steps_gt: number;
  stagnation_rate_gt: number;
  variance_stability_lt: number;
  improvement_delta_lt: number;
};

function detectWeaknesses(stats: ResearchStats, thresholds: AdaptiveMutationThresholds): AdaptiveWeakness[] {
  const weaknesses: AdaptiveWeakness[] = [];
  if (stats.avg_convergence_steps > thresholds.convergence_steps_gt) weaknesses.push("slow_convergence");
  if (stats.stagnation_rate > thresholds.stagnation_rate_gt) weaknesses.push("stagnation");
  if (stats.variance_stability < thresholds.variance_stability_lt) weaknesses.push("high_variance");
  if (stats.avg_improvement_delta < thresholds.improvement_delta_lt) weaknesses.push("weak_improvement_delta");
  return weaknesses;
}

function boundAdaptiveMutation(input: ReturnType<typeof normalizeAdaptiveProfile>) {
  return {
    ...input,
    bootstrap_min: clampInt(input.bootstrap_min, 1, 10),
    narrowing_factor: Number(clampFloat(input.narrowing_factor, 0.5, 1.5).toFixed(4)),
    patience: clampInt(input.patience, 1, 10),
    exploration_bias: Number(clampFloat(input.exploration_bias, 0, 1).toFixed(4)),
    variance_sensitivity: Number(clampFloat(input.variance_sensitivity, 0.01, 0.5).toFixed(4)),
  };
}

type MetaWindowSignals = {
  sample_count: number;
  meta_stability_index: number;
  long_term_improvement_trend: number;
  strategy_volatility: number;
  mutation_effectiveness_ratio: number;
};

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function variance(values: number[]) {
  if (values.length <= 1) return 0;
  const mean = average(values);
  return values.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / values.length;
}

function computeMetaWindowSignals(history: any[], role: AgentRole, windowSize: number): MetaWindowSignals {
  const items = history
    .filter((h) => h?.type === "research.impact" && h?.role === role)
    .slice(-windowSize);
  if (items.length === 0) {
    return {
      sample_count: 0,
      meta_stability_index: 1,
      long_term_improvement_trend: 0,
      strategy_volatility: 0,
      mutation_effectiveness_ratio: 0,
    };
  }

  const improvements = items.map((h) => Number(h?.sample?.improvement_delta ?? 0)).filter((v) => Number.isFinite(v));
  const convergence = items.map((h) => Number(h?.sample?.convergence_steps ?? 0)).filter((v) => Number.isFinite(v));
  const trends = items.map((h) => Number(h?.sample?.best_score_trend ?? 0)).filter((v) => Number.isFinite(v));
  const stagnation = items.map((h) => Number(h?.sample?.stagnation_rate ?? 1)).filter((v) => Number.isFinite(v));
  const stability = items.map((h) => Number(h?.sample?.variance_stability ?? 1)).filter((v) => Number.isFinite(v));
  const exploration = items.map((h) => Number(h?.sample?.exploration_efficiency ?? 0)).filter((v) => Number.isFinite(v));
  const convAvg = Math.max(1, average(convergence));
  const effRatio = (average(improvements) / convAvg) * Math.max(0, average(exploration));
  const trendVariance = variance(trends);
  const strategyVolatility = clampFloat(trendVariance + (0.2 * average(stagnation)) + (0.5 * (1 - average(stability))), 0, 1);

  return {
    sample_count: items.length,
    meta_stability_index: Number(clampFloat(average(stability) * (1 - average(stagnation)), 0, 1).toFixed(6)),
    long_term_improvement_trend: Number(average(trends).toFixed(6)),
    strategy_volatility: Number(strategyVolatility.toFixed(6)),
    mutation_effectiveness_ratio: Number(clampFloat(effRatio, -10, 10).toFixed(6)),
  };
}

function countRecentIneffectiveImpacts(history: any[], role: AgentRole, limit: number) {
  const items = history
    .filter((h) => h?.type === "research.impact" && h?.role === role)
    .slice(-limit)
    .reverse();
  let streak = 0;
  for (const item of items) {
    const improvement = Number(item?.sample?.improvement_delta ?? 0);
    const trend = Number(item?.sample?.best_score_trend ?? 0);
    const convergence = Number(item?.sample?.convergence_steps ?? 0);
    const ineffective = (improvement <= 0.0001 && trend <= 0.0001) || convergence >= 20;
    if (!ineffective) break;
    streak += 1;
  }
  return streak;
}

function hasMetaMutationCooldown(history: any[], role: AgentRole, cooldownMs: number) {
  const latest = history
    .filter((h) => h?.type === "meta.mutation" && h?.role === role)
    .sort((a, b) => Date.parse(String(b?.ts ?? "")) - Date.parse(String(a?.ts ?? "")))[0];
  if (!latest) return false;
  const ts = Date.parse(String(latest.ts ?? ""));
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) < cooldownMs;
}

function mutateMetaProfile(
  current: AgentProfile,
  stats: ResearchStats,
  signals: MetaWindowSignals,
  thresholds: { stagnation_rate_gt: number; meta_window: number; patience: number; ineffective_streak: number }
) {
  const next = normalizeMetaAdaptiveProfile(current.meta_profile);
  const reasons: string[] = [];
  if (signals.sample_count < thresholds.meta_window) {
    return { meta_profile: next, mutation_reason: null as Record<string, any> | null };
  }

  const ineffective = signals.mutation_effectiveness_ratio <= 0.01 || signals.long_term_improvement_trend <= 0;
  const unstable = signals.strategy_volatility > (0.35 + (0.25 * next.mutation_sensitivity)) || signals.meta_stability_index < 0.45;
  const stagnant = stats.stagnation_rate > thresholds.stagnation_rate_gt || signals.long_term_improvement_trend < 0.0001;
  if (ineffective && thresholds.ineffective_streak < thresholds.patience) {
    return { meta_profile: next, mutation_reason: null as Record<string, any> | null };
  }

  if (!(ineffective || unstable || stagnant)) {
    return { meta_profile: next, mutation_reason: null as Record<string, any> | null };
  }

  if (unstable) {
    next.mutation_intensity = Number((next.mutation_intensity * 0.8).toFixed(4));
    next.mutation_sensitivity = Number((next.mutation_sensitivity * 0.95).toFixed(4));
    next.exploration_vs_exploitation_bias = Number((next.exploration_vs_exploitation_bias - 0.05).toFixed(4));
    next.fitness_weights.stability_weight = Number((next.fitness_weights.stability_weight * 1.1).toFixed(4));
    reasons.push("meta:unstable_reduce_intensity");
  }

  if (ineffective || stagnant) {
    next.mutation_intensity = Number((next.mutation_intensity * 1.1).toFixed(4));
    next.mutation_sensitivity = Number((next.mutation_sensitivity * 1.05).toFixed(4));
    next.exploration_vs_exploitation_bias = Number((next.exploration_vs_exploitation_bias + 0.05).toFixed(4));
    next.fitness_weights.improvement_weight = Number((next.fitness_weights.improvement_weight * 1.1).toFixed(4));
    next.fitness_weights.exploration_weight = Number((next.fitness_weights.exploration_weight * 1.05).toFixed(4));
    next.fitness_weights.stagnation_penalty = Number((next.fitness_weights.stagnation_penalty * 1.05).toFixed(4));
    reasons.push(ineffective ? "meta:ineffective_increase_intensity" : "meta:stagnant_increase_intensity");
  }

  const bounded = normalizeMetaAdaptiveProfile(next);
  return {
    meta_profile: bounded,
    mutation_reason: {
      reasons,
      signals,
      thresholds,
      patience_state: {
        required: thresholds.patience,
      },
    },
  };
}

function mutateAdaptiveProfile(
  role: AgentRole,
  current: AgentProfile,
  stats: ResearchStats,
  thresholds: Pick<AdaptiveMutationThresholds, "convergence_steps_gt" | "stagnation_rate_gt">,
  metaProfile?: AgentProfile["meta_profile"]
) {
  if (role !== "research") {
    return {
      adaptive_profile: current.adaptive_profile,
      adaptive_profiles_by_domain: current.adaptive_profiles_by_domain,
      mutation_reason: null as Record<string, any> | null,
    };
  }

  const next = normalizeAdaptiveProfile(current.adaptive_profile);
  const meta = normalizeMetaAdaptiveProfile(metaProfile);
  const mutationScale = clampFloat(meta.mutation_intensity * meta.mutation_sensitivity, 0.1, 2);
  const exploreScale = clampFloat(0.5 + meta.exploration_vs_exploitation_bias, 0.5, 1.5);
  const exploitScale = clampFloat(1.5 - meta.exploration_vs_exploitation_bias, 0.5, 1.5);
  const st = normalizeResearchStats(stats);
  const weaknessThresholds: AdaptiveMutationThresholds = {
    convergence_steps_gt: thresholds.convergence_steps_gt,
    stagnation_rate_gt: thresholds.stagnation_rate_gt,
    variance_stability_lt: 0.65,
    improvement_delta_lt: Math.max(0, next.improvement_threshold),
  };
  const weaknesses = detectWeaknesses(st, weaknessThresholds);
  const appliedMutations: string[] = [];

  for (const weakness of weaknesses) {
    if (weakness === "slow_convergence") {
      const narrowingFactorDelta = (0.8 - 1) * mutationScale * exploitScale;
      next.narrowing_factor = Number((next.narrowing_factor * (1 + narrowingFactorDelta)).toFixed(4));
      next.bootstrap_min = Math.trunc(next.bootstrap_min - Math.max(1, Math.round(mutationScale)));
      appliedMutations.push(`slow_convergence:narrowing_factor*=1${narrowingFactorDelta >= 0 ? "+" : ""}${Number(narrowingFactorDelta.toFixed(4))}`);
      appliedMutations.push("slow_convergence:bootstrap_min-=scaled_step");
      continue;
    }

    if (weakness === "stagnation") {
      next.exploration_bias = Number((next.exploration_bias + (0.1 * mutationScale * exploreScale)).toFixed(4));
      next.bootstrap_min = Math.trunc(next.bootstrap_min + Math.max(1, Math.round(mutationScale)));
      appliedMutations.push("stagnation:exploration_bias+=scaled_step");
      appliedMutations.push("stagnation:bootstrap_min+=scaled_step");
      continue;
    }

    if (weakness === "high_variance") {
      next.patience = Math.trunc(next.patience + Math.max(1, Math.round(mutationScale * exploitScale)));
      next.variance_sensitivity = Number((next.variance_sensitivity + (0.05 * mutationScale * exploitScale)).toFixed(4));
      appliedMutations.push("high_variance:patience+=scaled_step");
      appliedMutations.push("high_variance:variance_sensitivity+=scaled_step");
      continue;
    }

    if (weakness === "weak_improvement_delta") {
      const wideningFactorDelta = (1.05 - 1) * mutationScale * exploreScale;
      next.narrowing_factor = Number((next.narrowing_factor * (1 + wideningFactorDelta)).toFixed(4));
      next.exploration_bias = Number((next.exploration_bias + (0.05 * mutationScale * exploreScale)).toFixed(4));
      appliedMutations.push(`weak_improvement_delta:narrowing_factor*=1+${Number(wideningFactorDelta.toFixed(4))}`);
      appliedMutations.push("weak_improvement_delta:exploration_bias+=scaled_step");
      continue;
    }
  }

  const bounded = normalizeAdaptiveProfile(boundAdaptiveMutation(next));
  const domainProfiles = {
    ...normalizeAdaptiveProfilesByDomain(current.adaptive_profiles_by_domain, bounded),
    medium: bounded,
  };
  if (weaknesses.length === 0) {
    return {
      adaptive_profile: bounded,
      adaptive_profiles_by_domain: domainProfiles,
      mutation_reason: null as Record<string, any> | null,
    };
  }
  return {
    adaptive_profile: bounded,
    adaptive_profiles_by_domain: domainProfiles,
    mutation_reason: {
      weaknesses,
      applied_mutations: appliedMutations,
      thresholds: weaknessThresholds,
    },
  };
}

export async function agentEvolutionTick(opts: {
  syncDir: string;
  role?: AgentRole;
  min_runs?: number;
  failure_rate_gt?: number;
  critic_score_lt?: number;
  avg_completion_time_ms_gt?: number;
  research_fitness_lt?: number;
  stagnation_rate_gt?: number;
  convergence_steps_gt?: number;
  max_new_versions?: number;
  shadow_mode?: boolean;
}) {
  const governance = await loadGovernance(opts.syncDir);
  const history = await readHistory(opts.syncDir);
  return withLock(opts.syncDir, async (store) => {
    const minRuns = Math.max(1, Math.min(opts.min_runs ?? governance.min_replay_runs, 10_000));
    const failureRateGt = clamp(opts.failure_rate_gt ?? 0.4, 0, 1);
    const criticScoreLt = clamp(opts.critic_score_lt ?? 0.6, 0, 1);
    const avgCompletionMsGt = Math.max(0, opts.avg_completion_time_ms_gt ?? 3000);
    const researchFitnessLt = Number(opts.research_fitness_lt ?? 0.02);
    const stagnationRateGt = clamp(opts.stagnation_rate_gt ?? 0.8, 0, 1);
    const convergenceStepsGt = Math.max(1, Number(opts.convergence_steps_gt ?? 10));
    const metaWindow = Math.max(8, minRuns * 2);
    const metaPatience = Math.max(2, Math.ceil(minRuns / 2));
    const metaCooldownMs = Math.max(governance.evolution_cooldown_ms * 2, 6 * 60 * 60 * 1000);
    const maxNew = Math.max(1, Math.min(opts.max_new_versions ?? 20, 1000));
    const shadowMode = opts.shadow_mode ?? true;

    const roles = opts.role ? [opts.role] : (["planner", "dev", "research", "critic"] as AgentRole[]);
    const created: AgentVersionRecord[] = [];
    const skipped: Array<{ role: AgentRole; reason: string }> = [];

    for (const role of roles) {
      if (created.length >= maxNew) break;
      const roleAgents = store.agents.filter((a) => a.role === role);
      if (roleAgents.length >= governance.max_versions_per_role) {
        skipped.push({ role, reason: "version_cap_reached" });
        continue;
      }
      const active = roleAgents
        .filter((a) => a.active)
        .sort((a, b) => b.version - a.version)[0];
      if (!active) {
        skipped.push({ role, reason: "no_active_version" });
        continue;
      }
      const m = active.metrics;
      const researchStats = normalizeResearchStats(m.research_stats);
      const researchExperiments = m.research_stats?.experiments_count ?? 0;
      const activityCount = role === "research" && researchExperiments > 0
        ? researchExperiments
        : (m.runs_count ?? 0);
      if (activityCount < minRuns) {
        skipped.push({ role, reason: "insufficient_runs" });
        continue;
      }
      const failureRate = m.runs_count > 0 ? m.failure_count / m.runs_count : 0;
      const reasons: string[] = [];
      if (failureRate > failureRateGt) reasons.push("failure_rate");
      if ((m.critic_score ?? 0) < criticScoreLt) reasons.push("critic_score");
      if ((m.avg_completion_time_ms ?? 0) > avgCompletionMsGt) reasons.push("avg_completion_time_ms");
      if (role === "research") {
        const windowSignals = computeMetaWindowSignals(history, role, metaWindow);
        researchStats.meta_stability_index = windowSignals.meta_stability_index;
        researchStats.long_term_improvement_trend = windowSignals.long_term_improvement_trend;
        researchStats.strategy_volatility = windowSignals.strategy_volatility;
        researchStats.mutation_effectiveness_ratio = windowSignals.mutation_effectiveness_ratio;
        m.research_stats = researchStats;
        const fitnessWeights = active.profile.meta_profile?.fitness_weights;
        const fitness = computeResearchFitness(researchStats, fitnessWeights);
        m.research_fitness = fitness;
        if (researchStats.experiments_count >= minRuns && fitness < researchFitnessLt) reasons.push("research_fitness");
        if (researchStats.experiments_count >= minRuns && researchStats.stagnation_rate > stagnationRateGt) reasons.push("stagnation_rate");
        if (researchStats.experiments_count >= minRuns && researchStats.avg_convergence_steps > convergenceStepsGt) reasons.push("convergence_speed");
      }
      if (reasons.length === 0) {
        skipped.push({ role, reason: "no_trigger" });
        continue;
      }

      const existingShadow = roleAgents.some((a) => !a.active && a.parent_version === active.version);
      const totalShadows = roleAgents.filter((a) => !a.active && !!a.parent_version).length;
      if (shadowMode && (existingShadow || totalShadows >= governance.max_shadow_per_role)) {
        skipped.push({ role, reason: "shadow_already_exists_for_active_parent" });
        continue;
      }

      const now = Date.now();
      const lastCreate = history
        .filter((h) => h.type === "version.create" && h.role === role)
        .sort((a, b) => Date.parse(String(b.ts)) - Date.parse(String(a.ts)))[0];
      if (lastCreate && now - Date.parse(String(lastCreate.ts)) < governance.evolution_cooldown_ms) {
        skipped.push({ role, reason: "cooldown_active" });
        continue;
      }

      const today = new Date().toISOString().slice(0, 10);
      const todayAttempts = history.filter((h) => h.type === "version.create" && h.role === role && String(h.ts).startsWith(today)).length;
      if (todayAttempts >= governance.max_evolution_attempts_per_day) {
        skipped.push({ role, reason: "evolution_budget_exceeded" });
        continue;
      }

      const nextVersion = roleAgents.reduce((acc, a) => Math.max(acc, a.version), 0) + 1;
      if (!shadowMode) {
        for (const a of roleAgents) a.active = false;
      }
      const nowIso = isoNow();
      const metaSignals = role === "research"
        ? computeMetaWindowSignals(history, role, metaWindow)
        : null;
      const ineffectiveStreak = role === "research"
        ? countRecentIneffectiveImpacts(history, role, metaPatience)
        : 0;
      const metaCooldownActive = role === "research" && hasMetaMutationCooldown(history, role, metaCooldownMs);
      const metaMutation = role === "research" && !metaCooldownActive
        ? mutateMetaProfile(active.profile, researchStats, metaSignals!, {
          stagnation_rate_gt: stagnationRateGt,
          meta_window: metaWindow,
          patience: metaPatience,
          ineffective_streak: ineffectiveStreak,
        })
        : { meta_profile: active.profile.meta_profile, mutation_reason: null as Record<string, any> | null };
      const adaptiveMutation = mutateAdaptiveProfile(role, active.profile, researchStats, {
        convergence_steps_gt: convergenceStepsGt,
        stagnation_rate_gt: stagnationRateGt,
      }, metaMutation.meta_profile);
      const mutated: AgentVersionRecord = {
        agent_id: randomUUID(),
        role,
        version: nextVersion,
        active: !shadowMode,
        parent_version: active.version,
        created_at: nowIso,
        updated_at: nowIso,
        profile: {
          ...active.profile,
          temperature: mutateTemperature(role, active.profile.temperature, reasons),
          system_prompt: mutateSystemPrompt(active.profile.system_prompt, reasons),
          adaptive_profile: adaptiveMutation.adaptive_profile,
          adaptive_profiles_by_domain: adaptiveMutation.adaptive_profiles_by_domain,
          meta_profile: role === "research"
            ? normalizeMetaAdaptiveProfile(metaMutation.meta_profile)
            : active.profile.meta_profile,
        },
        metrics: emptyMetrics(),
      };
      store.agents.push(mutated);
      created.push(mutated);
      if (role === "research" && metaMutation.mutation_reason) {
        await appendHistory(opts.syncDir, {
          type: "meta.mutation",
          role,
          from_version: active.version,
          to_version: mutated.version,
          meta_mutation_reason: metaMutation.mutation_reason,
          cooldown_ms: metaCooldownMs,
          meta_window: metaWindow,
        });
      }
      await appendHistory(opts.syncDir, {
        type: "version.create",
        role: mutated.role,
        version: mutated.version,
        parent_version: mutated.parent_version ?? null,
        active: mutated.active,
        trigger_reasons: reasons,
        mutation_reason: adaptiveMutation.mutation_reason,
        meta_mutation_reason: metaMutation.mutation_reason,
      });
    }

    return {
      shadow_mode: shadowMode,
      created,
      skipped,
      governance,
      thresholds: {
        min_runs: minRuns,
        failure_rate_gt: failureRateGt,
        critic_score_lt: criticScoreLt,
        avg_completion_time_ms_gt: avgCompletionMsGt,
        research_fitness_lt: researchFitnessLt,
        stagnation_rate_gt: stagnationRateGt,
        convergence_steps_gt: convergenceStepsGt,
        meta_window: metaWindow,
        meta_patience: metaPatience,
        meta_cooldown_ms: metaCooldownMs,
      },
    };
  });
}
