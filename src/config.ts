import dotenv from "dotenv";
import path from "node:path";

// Capture launcher-provided values before dotenv overrides (.env.local uses override=true below).
const BOOTSTRAP_PORT = process.env.PORT;
const BOOTSTRAP_MCP_PORT = process.env.MCP_PORT;

dotenv.config();
const labModeRaw = (process.env.LAB_MODE ?? "").trim().toLowerCase();
const labMode = labModeRaw === "offline" || labModeRaw === "online" ? labModeRaw : "";
if (labMode) {
  dotenv.config({ path: `.env.${labMode}`, override: true });
}
dotenv.config({ path: ".env.local", override: true });
dotenv.config({ path: ".env.local.secret", override: true });

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseCsvEnv(value: string | undefined, fallback: string[]): string[] {
  const raw = (value ?? "").trim();
  if (!raw) return [...fallback];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const runtimePortRaw =
  BOOTSTRAP_MCP_PORT ??
  BOOTSTRAP_PORT ??
  process.env.MCP_PORT ??
  process.env.PORT;
export const PORT = parseNumberEnv(runtimePortRaw, 3000);
const syncDirRaw = (process.env.SYNC_DIR ?? "./_sync").trim();
export const SYNC_DIR = path.isAbsolute(syncDirRaw)
  ? syncDirRaw
  : path.resolve(process.cwd(), syncDirRaw);
export const LAB_MODE = labMode || "default";

export const OPENAI_API_KEY = (process.env.OPENAI_API_KEY ?? "").trim();
export const OPENAI_MODEL = (process.env.OPENAI_MODEL ?? "gpt-5").trim();
export const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
const openaiTimeoutRaw = (process.env.OPENAI_TIMEOUT_MS ?? "").trim();
export const OPENAI_TIMEOUT_MS = openaiTimeoutRaw === "0"
  ? 0
  : parseNumberEnv(process.env.OPENAI_TIMEOUT_MS, 30_000);
export const SYNC_MOCK_MODE = parseBooleanEnv(process.env.SYNC_MOCK_MODE, false);
export const SYNC_POLL_MS = parseNumberEnv(process.env.SYNC_POLL_MS, 3000);
export const SYNC_BATCH_SIZE = parseNumberEnv(process.env.SYNC_BATCH_SIZE, 50);
export const SYNC_ENABLED = parseBooleanEnv(process.env.SYNC_ENABLED, false);

// LLM helper action pipeline (safe-by-default).
export const LLM_HELPER_DRY_RUN = parseBooleanEnv(process.env.LLM_HELPER_DRY_RUN, true);
export const LLM_HELPER_ENABLE_TASKS = parseBooleanEnv(process.env.LLM_HELPER_ENABLE_TASKS, false);
export const LLM_HELPER_ENABLE_GOVERNANCE = parseBooleanEnv(process.env.LLM_HELPER_ENABLE_GOVERNANCE, false);
export const LLM_HELPER_ENABLE_TOOLS = parseBooleanEnv(process.env.LLM_HELPER_ENABLE_TOOLS, false);
export const LLM_HELPER_MAX_ACTIONS = parseNumberEnv(process.env.LLM_HELPER_MAX_ACTIONS, 3);
export const LLM_HELPER_ALLOWED_TOOL_COMMANDS = parseCsvEnv(
  process.env.LLM_HELPER_ALLOWED_TOOL_COMMANDS,
  [
    "sync_status",
    "intelligence_meta_snapshot",
    "intelligence_health_snapshot",
    "arena_telemetry_snapshot",
    "transfer_diagnostics",
    "mutation_effectiveness_snapshot",
    "lineage_snapshot",
    "research_agenda_tick",
    "patch_proposal_tick",
    "patch_test_tick",
    "patch_governance_tick",
  ]
);

// Tool exposure mode:
// false (default): expose compact multiplexer tools, keep legacy hidden
// true: expose legacy tool surface for backward compatibility/debug
export const EXPOSE_LEGACY_TOOLS = parseBooleanEnv(process.env.EXPOSE_LEGACY_TOOLS, false);
