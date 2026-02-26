import { z } from "zod";
import { createHash } from "node:crypto";
import {
  LLM_HELPER_ALLOWED_TOOL_COMMANDS,
  LLM_HELPER_DRY_RUN,
  LLM_HELPER_ENABLE_GOVERNANCE,
  LLM_HELPER_ENABLE_TASKS,
  LLM_HELPER_ENABLE_TOOLS,
  LLM_HELPER_MAX_ACTIONS,
} from "../config.js";
import { notesUpsert } from "../notes.js";
import { tasksUpsert } from "../tasks.js";
import { queuePush } from "../queue.js";

const MAX_TEXT_CAPTURE = 4000;

const GovernanceAdjustActionSchema = z.object({
  type: z.literal("governance_adjust"),
  knob: z.string().min(1),
  delta: z.number(),
  ttl_ticks: z.number().int(),
  reason: z.string().min(1),
});

const NoteActionSchema = z.object({
  type: z.literal("note"),
  title: z.string().min(1),
  body: z.string().min(1),
});

const TaskCreateActionSchema = z.object({
  type: z.literal("task_create"),
  title: z.string().min(1),
  description: z.string().min(1),
  labels: z.array(z.string().min(1)).optional(),
  priority: z.enum(["p1", "p2", "p3"]).optional(),
});

const ToolCallActionSchema = z.object({
  type: z.literal("tool_call"),
  command: z.string().min(1),
  args: z.record(z.any()).optional(),
  reason: z.string().min(1).optional(),
});

const ActionSchema = z.union([NoteActionSchema, TaskCreateActionSchema, GovernanceAdjustActionSchema, ToolCallActionSchema]);

const AssistantEnvelopeSchema = z.object({
  observations: z.array(z.string()).default([]),
  actions: z.array(ActionSchema).default([]),
});

type AssistantEnvelope = z.infer<typeof AssistantEnvelopeSchema>;
type AssistantAction = z.infer<typeof ActionSchema>;

const AgendaTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  labels: z.array(z.string().min(1)).optional(),
  priority: z.enum(["p1", "p2", "p3"]).optional(),
});

const AgendaEnvelopeSchema = z.object({
  hypotheses: z.array(z.string()).default([]),
  goal: z.string().optional(),
  why_now: z.string().optional(),
  target_domains: z.array(z.string()).optional(),
  metrics: z.record(z.any()).optional(),
  experiments: z.array(z.any()).optional(),
  tasks: z.array(AgendaTaskSchema).default([]),
  stop_conditions: z.record(z.any()).optional(),
  risks: z.array(z.string()).optional(),
});

const PromptPatchDiffSchema = z
  .object({
    system_prompt: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.system_prompt && !value.model && typeof value.temperature !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prompt_patch.diff requires at least one of system_prompt/model/temperature",
      });
    }
  });

const PatchEnvelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt_patch"),
    scope: z.string().regex(/^agent:(planner|dev|research|critic)$/),
    diff: PromptPatchDiffSchema,
    rationale: z.string().min(1),
    risk: z.enum(["low", "med", "high"]).default("low"),
    tests: z.array(z.string().min(1)).default([]),
    success_metrics: z.array(z.string().min(1)).default([]),
    rollback_plan: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("repo_patch"),
    scope: z.string().min(1),
    diff: z.string().min(1),
    rationale: z.string().min(1),
    risk: z.enum(["low", "med", "high"]).default("low"),
    tests: z.array(z.string().min(1)).default([]),
    success_metrics: z.array(z.string().min(1)).default([]),
    rollback_plan: z.string().min(1).optional(),
  }),
]);

const PatchEnvelopeBatchSchema = z.object({
  patches: z.array(PatchEnvelopeSchema).min(1).max(2),
  summary: z.string().optional(),
});

type PatchEnvelope = z.infer<typeof PatchEnvelopeSchema>;
type PatchEnvelopeBatch = z.infer<typeof PatchEnvelopeBatchSchema>;

function normalizeAgendaEnvelope(input: z.infer<typeof AgendaEnvelopeSchema>): AssistantEnvelope {
  const observations: string[] = [];
  for (const h of input.hypotheses.slice(0, 3)) observations.push(h);
  if (input.why_now && observations.length < 3) observations.push(`why_now: ${input.why_now}`);

  const actions: AssistantAction[] = [];
  for (const task of input.tasks.slice(0, LLM_HELPER_MAX_ACTIONS)) {
    actions.push({
      type: "task_create",
      title: task.title,
      description: task.description,
      labels: task.labels,
      priority: task.priority,
    } as AssistantAction);
  }
  if (actions.length === 0) {
    actions.push({
      type: "note",
      title: "agenda_no_tasks",
      body: "Agenda response did not include executable tasks.",
    } as AssistantAction);
  }
  return { observations, actions };
}

function clampDelta(value: number): number {
  return Math.max(-0.05, Math.min(0.05, value));
}

function clampTtlTicks(value: number): number {
  return Math.max(1, Math.min(3, Math.trunc(value)));
}

function truncateText(text: string, max = MAX_TEXT_CAPTURE): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[TRUNCATED ${text.length - max} chars]`;
}

function hashId(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function sanitizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const allowed = labels
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter((x) => x.length > 0)
    .filter((x) => x === "agenda" || x === "llm" || x === "assistant" || x.startsWith("domain:") || x.startsWith("prio:"));
  return Array.from(new Set(allowed)).slice(0, 6);
}

function extractJsonCandidate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  try {
    JSON.parse(text);
    return text;
  } catch {
    // continue
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    try {
      JSON.parse(fenced);
      return fenced;
    } catch {
      // continue
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = text.slice(start, end + 1);
    try {
      JSON.parse(sliced);
      return sliced;
    } catch {
      return null;
    }
  }
  return null;
}

function buildNoteBody(args: {
  responseId: string;
  conversationId: string;
  envelope?: AssistantEnvelope;
  rawText: string;
  parseError?: string;
  applied: string[];
  dryRun: boolean;
  proposedActionsCount?: number;
  proposedTasksCount?: number;
  createdTasksCount?: number;
}): string {
  const lines: string[] = [];
  lines.push(`response_id: ${args.responseId}`);
  lines.push(`conversation_id: ${args.conversationId}`);
  lines.push(`agenda_id: ${args.responseId}`);
  lines.push(`dry_run: ${args.dryRun}`);
  if (typeof args.proposedActionsCount === "number") lines.push(`proposed_actions: ${args.proposedActionsCount}`);
  if (typeof args.proposedTasksCount === "number") lines.push(`proposed_tasks: ${args.proposedTasksCount}`);
  if (typeof args.createdTasksCount === "number") lines.push(`created_tasks: ${args.createdTasksCount}`);
  if (args.parseError) lines.push(`parse_error: ${args.parseError}`);
  lines.push("");

  if (args.envelope) {
    lines.push("observations:");
    for (const obs of args.envelope.observations.slice(0, 3)) {
      lines.push(`- ${obs}`);
    }
    lines.push("");
    lines.push("actions:");
    for (const action of args.envelope.actions.slice(0, LLM_HELPER_MAX_ACTIONS)) {
      lines.push(`- ${JSON.stringify(action)}`);
    }
    lines.push("");
  }

  lines.push("applied:");
  if (args.applied.length === 0) lines.push("- none");
  for (const item of args.applied) lines.push(`- ${item}`);
  lines.push("");
  lines.push("raw_response:");
  lines.push(truncateText(args.rawText));
  return lines.join("\n");
}

async function applyAction(
  syncDir: string,
  action: AssistantAction,
  applied: string[],
  context: { responseId: string; conversationId: string; createdTasksCount: { value: number } }
): Promise<void> {
  if (action.type === "note") {
    await notesUpsert({
      syncDir,
      title: action.title,
      content: action.body,
      tags: ["llm", "assistant", "note"],
    });
    applied.push(`note:${action.title}`);
    return;
  }

  if (action.type === "task_create") {
    if (!LLM_HELPER_ENABLE_TASKS) {
      applied.push(`task_create:skipped(disabled):${action.title}`);
      return;
    }
    const labels = sanitizeLabels((action as any).labels);
    const priority = (action as any).priority as ("p1" | "p2" | "p3" | undefined);
    // Keep task id stable across repeated agenda responses in the same conversation.
    // This prevents duplicate task spam when agenda ticks are retried.
    const deterministicId = `llm-task-${hashId(`${context.conversationId}|${action.title}|${action.description}`)}`;
    await tasksUpsert({
      syncDir,
      id: deterministicId,
      title: action.title,
      description: action.description,
      status: "todo",
      labels: ["llm", "assistant", "agenda", ...labels, ...(priority ? [`prio:${priority}`] : [])],
    });
    context.createdTasksCount.value += 1;
    applied.push(`task_create:${action.title}${(action as any).priority ? `:prio=${(action as any).priority}` : ""}`);
    return;
  }

  if (action.type !== "governance_adjust") {
    applied.push(`action:skipped(unsupported):${(action as any).type ?? "unknown"}`);
    return;
  }

  if (!LLM_HELPER_ENABLE_GOVERNANCE) {
    applied.push(`governance_adjust:skipped(disabled):${action.knob}`);
    return;
  }

  const clampedDelta = clampDelta(action.delta);
  const clampedTtl = clampTtlTicks(action.ttl_ticks);
  // Governance apply intentionally deferred for safety; logged as note-level action.
  applied.push(
    `governance_adjust:proposed:${action.knob}:delta=${clampedDelta}:ttl_ticks=${clampedTtl}:reason=${action.reason}`
  );
}

async function applyToolCallAction(
  syncDir: string,
  action: z.infer<typeof ToolCallActionSchema>,
  applied: string[],
  context: { responseId: string; conversationId: string }
): Promise<void> {
  if (!LLM_HELPER_ENABLE_TOOLS) {
    applied.push(`tool_call:skipped(disabled):${action.command}`);
    return;
  }

  const allowed = new Set(
    (LLM_HELPER_ALLOWED_TOOL_COMMANDS ?? [])
      .map((x) => String(x).trim())
      .filter(Boolean)
  );
  if (!allowed.has(action.command)) {
    applied.push(`tool_call:skipped(disallowed):${action.command}`);
    return;
  }

  const args =
    action.args && typeof action.args === "object" && !Array.isArray(action.args)
      ? action.args
      : {};

  const payload = {
    command: action.command,
    ...args,
    llm_source: {
      response_id: context.responseId,
      conversation_id: context.conversationId,
      reason: action.reason ?? null,
    },
  };

  const queued = await queuePush({
    syncDir,
    type: "project_task",
    logical_queue: "project_task",
    source: "llm-tool-call",
    priority: 0,
    payload,
  });

  applied.push(`tool_call:queued:${action.command}:job=${queued.job_id}`);
}

export function buildJsonOnlyInstruction(): string {
  return [
    "You are a helper for training/governance.",
    "Return ONLY valid JSON. No extra text.",
    "Schema:",
    "{",
    '  "observations": string[],',
    '  "actions": [',
    '    {"type":"note","title":string,"body":string}',
    '    | {"type":"task_create","title":string,"description":string}',
    '    | {"type":"governance_adjust","knob":string,"delta":number,"ttl_ticks":number,"reason":string}',
    '    | {"type":"tool_call","command":string,"args":object,"reason":string}',
    "  ]",
    "}",
    "Rules: max 3 observations, max 3 actions. delta clamp [-0.05,0.05], ttl_ticks 1..3.",
    `tool_call allowlist: ${LLM_HELPER_ALLOWED_TOOL_COMMANDS.join(", ")}`,
    'If unsure: actions=[{"type":"note","title":"insufficient_data","body":"not enough data"}].',
  ].join("\n");
}

export function buildAgendaJsonInstruction(): string {
  return [
    "You are a research agenda assistant for autonomous training.",
    "Return ONLY valid JSON. No extra text.",
    "Schema:",
    "{",
    '  "hypotheses": string[],',
    '  "goal": string,',
    '  "why_now": string,',
    '  "target_domains": string[],',
    '  "metrics": object,',
    '  "experiments": object[],',
    '  "tasks": [{"title":string,"description":string,"labels":string[],"priority":"p1"|"p2"|"p3"}],',
    '  "stop_conditions": object,',
    '  "risks": string[]',
    "}",
    "Rules: max 5 hypotheses, max 5 tasks, concise and actionable.",
    "Each task must include measurable stop_condition in description and one risk note.",
    "Never include governance actions in this mode.",
    "Example tasks: [{\"title\":\"Reduce p5 transfer variance\",\"description\":\"Run 8 ticks on domain medium|high|low|p5; stop_condition: variance<0.18; risk: entropy overshoot\",\"labels\":[\"agenda\",\"domain:medium|high|low|p5\"],\"priority\":\"p1\"}]",
  ].join("\n");
}

export function buildPatchJsonInstruction(): string {
  return [
    "You are a patch proposal assistant.",
    "Return ONLY valid JSON. No extra text.",
    "Schema:",
    "{",
    '  "patches": [',
    "    {",
    '      "kind": "prompt_patch" | "repo_patch",',
    '      "scope": string,',
    '      "diff": object | string,',
    '      "rationale": string,',
    '      "risk": "low" | "med" | "high",',
    '      "tests": string[],',
    '      "success_metrics": string[],',
    '      "rollback_plan": string',
    "    }",
    "  ],",
    '  "summary": string',
    "}",
    "Rules: max 2 patches, prefer prompt_patch, low-risk first.",
    "For prompt_patch: scope MUST be agent:planner|agent:dev|agent:research|agent:critic.",
    "For prompt_patch: diff MUST be JSON object with any of {system_prompt, model, temperature}.",
    "For repo_patch: diff MUST be unified diff string.",
    "tests must be command strings, success_metrics must be string array.",
    "If unsure, return one conservative prompt_patch.",
  ].join("\n");
}

function normalizePatchBatch(input: unknown): PatchEnvelopeBatch {
  const batch = PatchEnvelopeBatchSchema.safeParse(input);
  if (batch.success) return batch.data;
  const single = PatchEnvelopeSchema.parse(input);
  return { patches: [single] };
}

export async function applyAssistantResponse(opts: {
  syncDir: string;
  responseId: string;
  conversationId: string;
  text: string;
}): Promise<void> {
  const rawText = opts.text ?? "";
  const jsonCandidate = extractJsonCandidate(rawText);
  const applied: string[] = [];
  const isPatchConversation = String(opts.conversationId ?? "").startsWith("patch_proposal");

  async function upsertPatchInvalid(parseError: string) {
    await notesUpsert({
      syncDir: opts.syncDir,
      id: `patch-proposal-invalid:${opts.responseId}`,
      title: `patch_proposal_invalid:${opts.responseId}`,
      content: JSON.stringify(
        {
          response_id: opts.responseId,
          conversation_id: opts.conversationId,
          parse_error: parseError,
          raw_response: truncateText(rawText),
        },
        null,
        2
      ),
      tags: ["llm", "patch", "invalid"],
    });
  }

  if (!jsonCandidate) {
    if (isPatchConversation) {
      await upsertPatchInvalid("json_not_found");
      return;
    }
    await notesUpsert({
      syncDir: opts.syncDir,
      title: `LLM response (invalid JSON): ${opts.responseId}`,
      content: buildNoteBody({
        responseId: opts.responseId,
        conversationId: opts.conversationId,
        rawText,
        parseError: "json_not_found",
        applied,
        dryRun: LLM_HELPER_DRY_RUN,
      }),
      tags: ["llm", "assistant", "invalid_json"],
    });
    return;
  }

  let parsed: AssistantEnvelope | null = null;
  let patchBatch: PatchEnvelopeBatch | null = null;
  try {
    const parsedAny = JSON.parse(jsonCandidate);
    if (isPatchConversation) {
      patchBatch = normalizePatchBatch(parsedAny);
    } else {
    const isObj = parsedAny && typeof parsedAny === "object" && !Array.isArray(parsedAny);
    const hasPatchShape =
      isObj && ("patches" in (parsedAny as Record<string, unknown>) || "kind" in (parsedAny as Record<string, unknown>));

    if (hasPatchShape) {
      patchBatch = normalizePatchBatch(parsedAny);
    } else {
      const primary = AssistantEnvelopeSchema.safeParse(parsedAny);
      if (primary.success) {
        parsed = primary.data;
      } else {
        const agenda = AgendaEnvelopeSchema.safeParse(parsedAny);
        if (agenda.success) {
          parsed = normalizeAgendaEnvelope(agenda.data);
        } else {
          patchBatch = normalizePatchBatch(parsedAny);
        }
      }
    }
    }
  } catch (error: any) {
    if (isPatchConversation) {
      await upsertPatchInvalid(String(error?.message ?? error));
      return;
    }
    await notesUpsert({
      syncDir: opts.syncDir,
      title: `LLM response (schema mismatch): ${opts.responseId}`,
      content: buildNoteBody({
        responseId: opts.responseId,
        conversationId: opts.conversationId,
        rawText,
        parseError: String(error?.message ?? error),
        applied,
        dryRun: LLM_HELPER_DRY_RUN,
      }),
      tags: ["llm", "assistant", "schema_mismatch"],
    });
    return;
  }

  if (patchBatch) {
    const patches = patchBatch.patches.slice(0, 2);
    const proposalId = `patch-proposal:${opts.responseId}`;
    await notesUpsert({
      syncDir: opts.syncDir,
      id: proposalId,
      title: `patch_proposal:${opts.responseId}`,
      content: JSON.stringify({
        response_id: opts.responseId,
        conversation_id: opts.conversationId,
        summary: patchBatch.summary ?? null,
        patches,
        raw_response: truncateText(rawText),
      }, null, 2),
      tags: ["llm", "patch", "proposal"],
    });
    return;
  }
  if (isPatchConversation) {
    await upsertPatchInvalid("patch_envelope_not_found");
    return;
  }
  if (!parsed) {
    await notesUpsert({
      syncDir: opts.syncDir,
      title: `LLM response (schema mismatch): ${opts.responseId}`,
      content: buildNoteBody({
        responseId: opts.responseId,
        conversationId: opts.conversationId,
        rawText,
        parseError: "schema_not_supported",
        applied,
        dryRun: LLM_HELPER_DRY_RUN,
      }),
      tags: ["llm", "assistant", "schema_mismatch"],
    });
    return;
  }

  const limitedActions = parsed.actions.slice(0, Math.max(1, LLM_HELPER_MAX_ACTIONS));
  const proposedTasksCount = limitedActions.filter((a) => a.type === "task_create").length;
  const createdTasksCount = { value: 0 };
  if (!LLM_HELPER_DRY_RUN) {
    for (const action of limitedActions) {
      if (action.type === "tool_call") {
        await applyToolCallAction(opts.syncDir, action, applied, {
          responseId: opts.responseId,
          conversationId: opts.conversationId,
        });
      } else {
        await applyAction(opts.syncDir, action, applied, {
          responseId: opts.responseId,
          conversationId: opts.conversationId,
          createdTasksCount,
        });
      }
    }
  } else {
    for (const action of limitedActions) {
      applied.push(`dry_run:${action.type}`);
    }
  }

  await notesUpsert({
    syncDir: opts.syncDir,
    title: `LLM response (journal): ${opts.responseId}`,
    content: buildNoteBody({
      responseId: opts.responseId,
      conversationId: opts.conversationId,
      envelope: {
        observations: parsed.observations.slice(0, 3),
        actions: limitedActions,
      },
      rawText,
      applied,
      dryRun: LLM_HELPER_DRY_RUN,
      proposedActionsCount: limitedActions.length,
      proposedTasksCount,
      createdTasksCount: createdTasksCount.value,
    }),
    tags: ["llm", "assistant", "journal"],
  });
}
