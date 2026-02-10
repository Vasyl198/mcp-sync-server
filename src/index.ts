import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { acquireLock, releaseLock } from "./locks.js";
import { ensureQueueLayout, queuePush, queuePop, queueAck, jobHistoryList } from "./queue.js";
import { executeOneFromQueue } from "./router_queue.js";

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const MCP_SYNC_TOKEN = (process.env.MCP_SYNC_TOKEN || "").trim();
const ORIGIN_ALLOWLIST = (process.env.MCP_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ROOTS = (process.env.MCP_ALLOWED_ROOTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SYNC_DIR = "C:\\Users\\anani\\Projects\\_sync";
const INBOX_FILE = path.join(SYNC_DIR, 'inbox_command.json');
const STATUS_FILE = path.join(SYNC_DIR, 'status.json');
const REPORT_FILE = path.join(SYNC_DIR, 'last_report.md');
const LOGS_FILE = path.join(SYNC_DIR, 'last_logs.txt');
const EVENTS_FILE = path.join(SYNC_DIR, 'events.jsonl');

// Helper functions
function okText(content: any) {
  return { content: [{ type: "text", text: JSON.stringify(content) }] };
}

function errText(message: string) {
  return { 
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true 
  };
}

async function ensureSyncDir() {
  await fs.mkdir(SYNC_DIR, { recursive: true });
  // Initialize queue layout
  await ensureQueueLayout(SYNC_DIR);
}

// Create MCP server
function createMcpServer() {
  const server = new McpServer(
    {
      name: "mcp-sync-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Basic tools
  server.tool(
    "whoami",
    "Get server info and available roots",
    {},
    async () => {
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify({
            server: "mcp-sync-server",
            version: "1.0.0",
            auth: MCP_SYNC_TOKEN ? "enabled" : "disabled",
            roots: ROOTS,
            sync_dir: SYNC_DIR
          })
        }]
      };
    }
  );

  // Simple router for now
  server.tool(
    "router_execute_command",
    "Execute command from inbox",
    {},
    async () => {
      await ensureSyncDir();
      
      try {
        const raw = await fs.readFile(INBOX_FILE, 'utf-8').catch(() => "");
        if (!raw.trim()) {
          return {
            content: [{ 
              type: "text" as const, 
              text: JSON.stringify({ 
                message: "No command to execute", 
                status: "idle" 
              })
            }]
          };
        }

        let job: any;
        try { 
          job = JSON.parse(raw); 
        } catch { 
          return {
            content: [{ 
              type: "text" as const, 
              text: JSON.stringify({ 
                message: "Invalid command format", 
                status: "error" 
              })
            }]
          };
        }

        if (!job.command || !job.id) {
          return {
            content: [{ 
              type: "text" as const, 
              text: JSON.stringify({ 
                message: "Invalid job structure", 
                status: "error" 
              })
            }]
          };
        }

        // Clear inbox
        await fs.writeFile(INBOX_FILE, JSON.stringify({ command: null, timestamp: null }), 'utf-8');

        // Execute based on command type
        let result;
        if (job.command === 'exec') {
          // Simple exec implementation
          const { cmd, args = [], cwd } = job;
          result = { 
            success: true, 
            stdout: `Executed ${cmd} ${args.join(' ')}`,
            stderr: "",
            exit_code: 0 
          };
        } else {
          result = { 
            success: false, 
            error: `Unknown command: ${job.command}` 
          };
        }

        // Update status
        await fs.writeFile(STATUS_FILE, JSON.stringify({
          status: "done",
          last_command: job.id,
          last_run: new Date().toISOString(),
          error: null
        }, null, 2), 'utf-8');

        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              status: "done",
              command_id: job.id,
              result
            })
          }]
        };
        
      } catch (error: any) {
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({ error: `Router failed: ${error.message}` })
          }],
          isError: true
        };
      }
    }
  );

  // Queue system tools
  server.tool(
    "fs_lock_acquire",
    "Acquire a lock with optional TTL",
    {
      name: z.string(),
      ttl_ms: z.number().optional().default(30000)
    },
    async ({ name, ttl_ms }) => {
      const result = await acquireLock({
        locksDir: path.join(SYNC_DIR, 'queue', 'locks'),
        name,
        ttl_ms
      });
      
      if (result.ok) {
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              ok: true,
              token: result.token,
              expires_at: result.expires_at
            })
          }]
        };
      } else {
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              ok: false,
              reason: result.reason,
              expires_at: result.expires_at
            })
          }]
        };
      }
    }
  );

  server.tool(
    "fs_lock_release",
    "Release a lock with token",
    {
      name: z.string(),
      token: z.string()
    },
    async ({ name, token }) => {
      const result = await releaseLock({
        locksDir: path.join(SYNC_DIR, 'queue', 'locks'),
        name,
        token
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  server.tool(
    "queue_push",
    "Push a job to queue",
    {
      type: z.enum(["exec", "project_task", "custom"]),
      payload: z.any(),
      priority: z.number().optional().default(0),
      job_id: z.string().optional()
    },
    async ({ type, payload, priority, job_id }) => {
      const result = await queuePush({
        syncDir: SYNC_DIR,
        type,
        payload,
        priority,
        job_id,
        source: 'windsurf'
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  server.tool(
    "queue_pop",
    "Pop/claim a job from queue with lease",
    {
      worker: z.string().optional().default("windsurf"),
      max_lease_ms: z.number().optional().default(60000)
    },
    async ({ worker, max_lease_ms }) => {
      const result = await queuePop({
        syncDir: SYNC_DIR,
        worker,
        max_lease_ms
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  server.tool(
    "queue_ack",
    "Acknowledge job completion with status and artifacts",
    {
      job_id: z.string(),
      lease_token: z.string(),
      status: z.enum(["done", "error", "canceled"]),
      result: z.any().optional(),
      report_md: z.string().optional(),
      logs: z.string().optional()
    },
    async ({ job_id, lease_token, status, result, report_md, logs }) => {
      const ackResult = await queueAck({
        syncDir: SYNC_DIR,
        job_id,
        lease_token,
        status,
        result,
        report_md,
        logs
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(ackResult)
        }]
      };
    }
  );

  server.tool(
    "job_history_list",
    "List job history with status and artifacts",
    {
      limit: z.number().optional().default(50),
      status: z.enum(["pending", "running", "done", "error", "canceled"]).optional()
    },
    async ({ limit, status }) => {
      const result = await jobHistoryList({
        syncDir: SYNC_DIR,
        limit,
        status
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  // Internal exec function for queue router
  async function runExecInternal(payload: any) {
    const { cmd, args = [], cwd, timeout_ms = 120000 } = payload;
    
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: cwd || undefined,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({
          success: false,
          exit_code: -1,
          stdout,
          stderr: 'Command timed out'
        });
      }, timeout_ms);
      
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          success: code === 0,
          exit_code: code || 0,
          stdout,
          stderr
        });
      });
    });
  }

  // Mock project task handler for now
  async function handleProjectTask(payload: any) {
    return {
      success: true,
      task: payload.task,
      project_path: payload.project_path,
      report_md: `# Project Task\n\nTask: ${payload.task}\nPath: ${payload.project_path}\n`,
      logs: `Project task completed: ${payload.task}`
    };
  }

  // New queue-based router
  server.tool(
    "router_execute_from_queue",
    "Execute one job from queue",
    {},
    async () => {
      const result = await executeOneFromQueue({
        syncDir: SYNC_DIR,
        worker: "windsurf-router",
        max_lease_ms: 60000,
        runExecInternal,
        handleProjectTask
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  return server;
}

// HTTP server setup
const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  next();
});

// Bearer auth middleware (disabled for now)
app.use((req, res, next) => {
  next();
});

const transports: Record<string, StreamableHTTPServerTransport> = {};
const sseTransports: Record<string, SSEServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
    return;
  }

  const transport = new StreamableHTTPServerTransport("/messages", res);
  const sid = randomUUID();
  transports[sid] = transport;

  transport.onclose = () => {
    if (transport.sessionId) delete transports[transport.sessionId];
  };

  const server = createMcpServer();
  await server.connect(transport);
});

app.listen(PORT, () => {
  console.log(`MCP Sync Server listening on port ${PORT}`);
  console.log(`Auth: ${MCP_SYNC_TOKEN ? 'enabled' : 'disabled'}`);
  console.log(`Sync dir: ${SYNC_DIR}`);
});
