export type AgentRole = "planner" | "dev" | "research" | "critic";
export type DomainSizeCategory = "small" | "medium" | "large";

export type AdaptiveStrategyProfile = {
  bootstrap_min: number;
  narrowing_factor: number;
  patience: number;
  improvement_threshold: number;
  exploration_bias: number;
  variance_sensitivity: number;
};

export type MetaFitnessWeights = {
  improvement_weight: number;
  convergence_weight: number;
  exploration_weight: number;
  stability_weight: number;
  stagnation_penalty: number;
};

export type MetaAdaptiveProfile = {
  fitness_weights: MetaFitnessWeights;
  mutation_intensity: number;
  mutation_sensitivity: number;
  exploration_vs_exploitation_bias: number;
};

export type AgentProfile = {
  role: AgentRole;
  profile_id: string;
  model: string;
  temperature: number;
  system_prompt: string;
  adaptive_profile?: AdaptiveStrategyProfile;
  adaptive_profiles_by_domain?: Record<DomainSizeCategory, AdaptiveStrategyProfile>;
  meta_profile?: MetaAdaptiveProfile;
};

const DEFAULT_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5";
export const DEFAULT_RESEARCH_ADAPTIVE_PROFILE: AdaptiveStrategyProfile = {
  bootstrap_min: 5,
  narrowing_factor: 1,
  patience: 4,
  improvement_threshold: 0.0005,
  exploration_bias: 0.5,
  variance_sensitivity: 0.5,
};

export const DEFAULT_META_FITNESS_WEIGHTS: MetaFitnessWeights = {
  improvement_weight: 0.45,
  convergence_weight: 0.2,
  exploration_weight: 0.2,
  stability_weight: 0.15,
  stagnation_penalty: 0.1,
};

export const DEFAULT_RESEARCH_META_PROFILE: MetaAdaptiveProfile = {
  fitness_weights: DEFAULT_META_FITNESS_WEIGHTS,
  mutation_intensity: 1,
  mutation_sensitivity: 0.6,
  exploration_vs_exploitation_bias: 0.5,
};

function deriveDomainAdaptiveProfile(
  size: DomainSizeCategory,
  base: AdaptiveStrategyProfile
): AdaptiveStrategyProfile {
  if (size === "small") {
    return normalizeAdaptiveProfile({
      ...base,
      narrowing_factor: base.narrowing_factor * 0.92,
      patience: base.patience - 1,
      exploration_bias: base.exploration_bias - 0.08,
    });
  }
  if (size === "large") {
    return normalizeAdaptiveProfile({
      ...base,
      narrowing_factor: base.narrowing_factor * 1.06,
      patience: base.patience + 1,
      exploration_bias: base.exploration_bias + 0.1,
    });
  }
  return normalizeAdaptiveProfile(base);
}

function clampInt(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function clampFloat(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function normalizeAdaptiveProfile(input?: Partial<AdaptiveStrategyProfile>): AdaptiveStrategyProfile {
  const raw = { ...DEFAULT_RESEARCH_ADAPTIVE_PROFILE, ...(input ?? {}) };
  return {
    bootstrap_min: clampInt(raw.bootstrap_min, 1, 10),
    narrowing_factor: Number(clampFloat(raw.narrowing_factor, 0.5, 1.5).toFixed(4)),
    patience: clampInt(raw.patience, 1, 10),
    improvement_threshold: Number(clampFloat(raw.improvement_threshold, 0.0000001, 10).toFixed(8)),
    exploration_bias: Number(clampFloat(raw.exploration_bias, 0, 1).toFixed(4)),
    variance_sensitivity: Number(clampFloat(raw.variance_sensitivity, 0.01, 0.5).toFixed(4)),
  };
}

export function normalizeAdaptiveProfilesByDomain(
  input?: Partial<Record<DomainSizeCategory, Partial<AdaptiveStrategyProfile>>>,
  baseInput?: Partial<AdaptiveStrategyProfile>
): Record<DomainSizeCategory, AdaptiveStrategyProfile> {
  const base = normalizeAdaptiveProfile(baseInput);
  const raw = input ?? {};
  return {
    small: normalizeAdaptiveProfile({
      ...deriveDomainAdaptiveProfile("small", base),
      ...(raw.small ?? {}),
    }),
    medium: normalizeAdaptiveProfile({
      ...deriveDomainAdaptiveProfile("medium", base),
      ...(raw.medium ?? {}),
    }),
    large: normalizeAdaptiveProfile({
      ...deriveDomainAdaptiveProfile("large", base),
      ...(raw.large ?? {}),
    }),
  };
}

export function normalizeMetaAdaptiveProfile(input?: Partial<MetaAdaptiveProfile>): MetaAdaptiveProfile {
  const raw = { ...DEFAULT_RESEARCH_META_PROFILE, ...(input ?? {}) };
  const fitnessRaw = { ...DEFAULT_META_FITNESS_WEIGHTS, ...(raw.fitness_weights ?? {}) };
  return {
    fitness_weights: {
      improvement_weight: Number(clampFloat(fitnessRaw.improvement_weight, 0, 2).toFixed(4)),
      convergence_weight: Number(clampFloat(fitnessRaw.convergence_weight, 0, 2).toFixed(4)),
      exploration_weight: Number(clampFloat(fitnessRaw.exploration_weight, 0, 2).toFixed(4)),
      stability_weight: Number(clampFloat(fitnessRaw.stability_weight, 0, 2).toFixed(4)),
      stagnation_penalty: Number(clampFloat(fitnessRaw.stagnation_penalty, 0, 2).toFixed(4)),
    },
    mutation_intensity: Number(clampFloat(raw.mutation_intensity, 0.5, 1.5).toFixed(4)),
    mutation_sensitivity: Number(clampFloat(raw.mutation_sensitivity, 0.1, 1).toFixed(4)),
    exploration_vs_exploitation_bias: Number(clampFloat(raw.exploration_vs_exploitation_bias, 0, 1).toFixed(4)),
  };
}

export const AGENT_REGISTRY: Record<AgentRole, AgentProfile> = {
  planner: {
    role: "planner",
    profile_id: "planner.default.v1",
    model: DEFAULT_MODEL,
    temperature: 0.2,
    system_prompt: "You are PlannerAgent. Break goals into concrete, dependency-aware tasks.",
  },
  dev: {
    role: "dev",
    profile_id: "dev.default.v1",
    model: DEFAULT_MODEL,
    temperature: 0.1,
    system_prompt: "You are DevAgent. Implement reliable code changes and validate with tests/build.",
  },
  research: {
    role: "research",
    profile_id: "research.default.v1",
    model: DEFAULT_MODEL,
    temperature: 0.5,
    system_prompt: "You are ResearchAgent. Propose options, compare trade-offs, and summarize evidence.",
    adaptive_profile: normalizeAdaptiveProfile(),
    adaptive_profiles_by_domain: normalizeAdaptiveProfilesByDomain(),
    meta_profile: normalizeMetaAdaptiveProfile(),
  },
  critic: {
    role: "critic",
    profile_id: "critic.default.v1",
    model: DEFAULT_MODEL,
    temperature: 0.2,
    system_prompt: "You are CriticAgent. Evaluate outcomes against criteria and identify gaps/risks.",
  },
};

export function getAgentProfile(role: AgentRole): AgentProfile {
  return AGENT_REGISTRY[role];
}

export function listAgentProfiles() {
  return Object.values(AGENT_REGISTRY);
}
