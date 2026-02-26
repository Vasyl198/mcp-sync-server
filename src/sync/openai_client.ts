import {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
  OPENAI_TIMEOUT_MS,
  SYNC_MOCK_MODE,
} from "../config.js";
import { OpenAIResponseSummary, OpenAIResponseSummarySchema } from "./types.js";

type OpenAIClientOptions = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
};

type CreateResponseInput = {
  inputText: string;
  conversationId: string;
  dedupeKey?: string | null;
  previousResponseId?: string | null;
  metadata?: Record<string, unknown>;
};

function extractOutputText(raw: any): string {
  if (typeof raw?.output_text === "string") return raw.output_text;
  if (Array.isArray(raw?.output)) {
    const chunks: string[] = [];
    for (const item of raw.output) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block?.text === "string") chunks.push(block.text);
      }
    }
    return chunks.join("\n").trim();
  }
  return "";
}

function buildMetadata(input: CreateResponseInput): Record<string, unknown> {
  const md: Record<string, unknown> = {
    local_conversation_id: input.conversationId,
    ...(input.metadata ?? {}),
  };
  // LM Studio (and some OpenAI-compatible servers) reject null here.
  if (typeof input.dedupeKey === "string" && input.dedupeKey.trim()) {
    md.dedupe_key = input.dedupeKey;
  }
  return md;
}

function isValidPreviousResponseId(id: unknown): id is string {
  // LM Studio expects real response ids (typically starting with "resp_").
  return typeof id === "string" && /^resp_[A-Za-z0-9]/.test(id);
}

export class OpenAIClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly mockMode: boolean;

  constructor(opts: OpenAIClientOptions = {}) {
    this.apiKey = (opts.apiKey ?? OPENAI_API_KEY).trim();
    this.model = (opts.model ?? OPENAI_MODEL).trim();
    this.baseUrl = (opts.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? OPENAI_TIMEOUT_MS);
    this.mockMode = SYNC_MOCK_MODE;
  }

  private assertConfigured() {
    if (this.mockMode) return;
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is empty");
    }
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    this.assertConfigured();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });

      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(
          `OpenAI request failed: ${response.status} ${response.statusText} ${JSON.stringify(body)}`
        );
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async createResponse(input: CreateResponseInput): Promise<OpenAIResponseSummary> {
    if (this.mockMode) {
      const ts = Date.now();
      const responseId = `mock-${ts}`;
      const raw = {
        id: responseId,
        model: this.model || "mock-model",
        conversation_id: input.conversationId,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "[MOCK RESPONSE] Sync pipeline is working.",
              },
            ],
          },
        ],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
        metadata: buildMetadata(input),
      };
      return OpenAIResponseSummarySchema.parse({
        response_id: responseId,
        conversation_id: input.conversationId,
        output_text: "[MOCK RESPONSE] Sync pipeline is working.",
        raw,
      });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: input.inputText }],
        },
      ],
      metadata: buildMetadata(input),
    };

    // Prevent legacy mock chains from breaking OpenAI-compatible servers.
    if (isValidPreviousResponseId(input.previousResponseId)) {
      body.previous_response_id = input.previousResponseId;
    }

    const raw = await this.request("/responses", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return OpenAIResponseSummarySchema.parse({
      response_id: String(raw?.id ?? ""),
      conversation_id:
        typeof raw?.conversation_id === "string" && raw.conversation_id.trim()
          ? raw.conversation_id
          : null,
      output_text: extractOutputText(raw),
      raw,
    });
  }

  async getResponse(responseId: string): Promise<OpenAIResponseSummary> {
    if (this.mockMode) {
      const raw = {
        id: responseId,
        model: this.model || "mock-model",
        conversation_id: null,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "[MOCK FOLLOWUP RESPONSE]",
              },
            ],
          },
        ],
      };
      return OpenAIResponseSummarySchema.parse({
        response_id: responseId,
        conversation_id: null,
        output_text: "[MOCK FOLLOWUP RESPONSE]",
        raw,
      });
    }

    const raw = await this.request(`/responses/${encodeURIComponent(responseId)}`, {
      method: "GET",
    });

    return OpenAIResponseSummarySchema.parse({
      response_id: String(raw?.id ?? responseId),
      conversation_id:
        typeof raw?.conversation_id === "string" && raw.conversation_id.trim()
          ? raw.conversation_id
          : null,
      output_text: extractOutputText(raw),
      raw,
    });
  }
}
