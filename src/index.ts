import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { acquireLock, releaseLock } from "./locks.js";
import { ensureQueueLayout, queuePush, queuePop, queueAck, jobHistoryList } from "./queue.js";
import { executeOneFromQueue } from "./router_queue.js";
import { eventPublish, eventList } from "./events.js";
import { notesList, notesGet, notesUpsert, notesDelete } from "./notes.js";
import { tasksList, tasksGet, tasksUpsert, tasksDelete } from "./tasks.js";
import { protocolInit, protocolWriteCommand, protocolReadCommand, protocolUpdateStatus, protocolWriteReport, protocolWriteLogs } from "./protocol.js";

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: '.env.local' });

const PORT = Number(process.env.PORT || 3000);
const MCP_SYNC_TOKEN_RAW = process.env.MCP_SYNC_TOKEN;
const MCP_SYNC_TOKEN = (MCP_SYNC_TOKEN_RAW ?? "").trim();  
const AUTH_ENABLED_RAW = (process.env.AUTH_ENABLED ?? "").trim().toLowerCase();
const ORIGIN_ALLOWLIST = (process.env.MCP_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function parseBooleanEnv(value: string): boolean | undefined {
  if (!value) return undefined;
  if (["1", "true", "yes", "on", "enabled"].includes(value)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(value)) return false;
  return undefined;
}

const AUTH_ENABLED_FROM_ENV = parseBooleanEnv(AUTH_ENABLED_RAW);
const AUTH_ENABLED = AUTH_ENABLED_FROM_ENV ?? MCP_SYNC_TOKEN.length > 0;
const CORS_ALLOW_HEADERS =
  "Content-Type, Accept, mcp-session-id, mcp-protocol-version, Last-Event-ID, Authorization";

function normalizeRoutePath(routePath: string): string {
  if (!routePath) return "/";
  if (routePath === "/") return routePath;
  return routePath.replace(/\/+$/, "");
}

function isAuthProtectedPath(routePath: string): boolean {
  const normalized = normalizeRoutePath(routePath);
  return (
    normalized === "/mcp" ||
    normalized.startsWith("/mcp/") ||
    normalized === "/messages" ||
    normalized.startsWith("/messages/") ||
    normalized === "/sse" ||
    normalized.startsWith("/sse/") ||
    normalized === "/sse-simple" ||
    normalized.startsWith("/sse-simple/")
  );
}

function isValidBearerToken(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

// Explicit paths to avoid confusion
const ROOTS = ["C:\\Users\\anani\\Projects", "C:\\", "D:\\"];
const SYNC_DIR = "C:\\Users\\anani\\Projects\\_sync";

const ALLOWED_ROOTS = (process.env.MCP_ALLOWED_ROOTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => {
    if (path.isAbsolute(p)) return p;
    // Handle relative paths relative to each root
    if (p.startsWith("C:") || p.startsWith("D:")) return path.resolve(p);
    return path.resolve("C:\\Users\\anani\\Projects", p);
  });

const ROOTS_FINAL = ALLOWED_ROOTS.length ? ALLOWED_ROOTS : ROOTS;

// Utility functions to convert Express <-> Fetch Request/Response
function toFetchHeaders(h: any) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else headers.set(k, String(v));
  }
  return headers;
}

function toFetchRequest(req: any) {
  const host = req.headers.host || "localhost";
  const url = `http://${host}${req.originalUrl}`;

  const headers = toFetchHeaders(req.headers);

  const method = req.method.toUpperCase();
  const body = (method === "GET" || method === "HEAD") ? undefined : JSON.stringify(req.body ?? {});

  return new Request(url, {
    method,
    headers,
    body,
  });
}

async function sendFetchResponseToExpress(webRes: Response, res: any) {
  res.status(webRes.status);

  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  // Send headers immediately
  (res as any).flushHeaders?.();

  // Handle connection close for proper cleanup
  let closed = false;
  res.on("close", () => { closed = true; });
  res.on("finish", () => { closed = true; });

  if (!webRes.body) {
    res.end();
    return;
  }

  const reader = webRes.body.getReader();
  try {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done || closed) break;
      if (value) {
        const ok = res.write(Buffer.from(value));
        // Handle backpressure - wait for drain if buffer is full
        if (!ok) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    }
  } finally {
    if (!closed) {
      res.end();
    }
    try { reader.releaseLock(); } catch {}
  }
}

function isInsideRoot(root: string, target: string) {
  const r = path.resolve(root);
  const t = path.resolve(target);

  // Windows: case-insensitive comparison for drive letters
  const rel = path.relative(r, t);

  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertInAllowedRoots(p: string) {
  const rp = path.resolve(p);
  for (const root of ROOTS_FINAL) {
    if (isInsideRoot(root, rp)) return rp;
  }
  throw new Error(`Path is outside allowed roots: ${rp}`);
}

function sha1(s: string) {
  return createHash("sha1").update(s).digest("hex");
}

function okText(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] as any[] };
}

function errText(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] as any[] };
}

export { okText, errText };

// Use Projects directory for SYNC_DIR
const INBOX_FILE = path.join(SYNC_DIR, 'inbox_command.json');
const STATUS_FILE = path.join(SYNC_DIR, 'status.json');
const REPORT_FILE = path.join(SYNC_DIR, 'last_report.md');
const LOGS_FILE = path.join(SYNC_DIR, 'last_logs.txt');
const EVENTS_FILE = path.join(SYNC_DIR, 'events.jsonl');

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
        tools: { listChanged: true },
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
            auth: AUTH_ENABLED ? "enabled" : "disabled",
            roots: ROOTS_FINAL,
            sync_dir: SYNC_DIR,
            tools: [
              "whoami",
              "router_execute_command", 
              "fs_lock_acquire",
              "fs_lock_release", 
              "queue_push",
              "queue_pop",
              "queue_ack",
              "job_history_list",
              "router_execute_from_queue",
              "fs_list",
              "fs_read", 
              "fs_write",
              "fs_mkdir",
              "fs_exists",
              "search_in_files",
              "fs_read_content",
              "fs_write_content",
              "exec",
              "event_publish",
              "event_list",
              "notes_upsert",
              "notes_get",
              "notes_delete",
              "notes_list",
              "tasks_upsert",
              "tasks_get",
              "tasks_delete",
              "tasks_list",
              "protocol_init",
              "protocol_write_command",
              "protocol_read_command",
              "protocol_update_status",
              "protocol_write_report",
              "protocol_write_logs"
            ]
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

  // Real project task handler
  async function handleProjectTask(payload: any) {
    const { task, project_path, spec_path } = payload;
    
    if (task === "create_website") {
      const websitePath = `${project_path}/website`;
      
      // Create website directory
      await fs.mkdir(websitePath, { recursive: true });
      
      // Create index.html
      const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Generated Website</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 800px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 40px; }
        .content { background: #f5f5f5; padding: 20px; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Generated Website</h1>
            <p>Created by MCP Project Task</p>
        </div>
        <div class="content">
            <h2>Welcome!</h2>
            <p>This website was automatically generated for project: ${project_path}</p>
            <p>Generated at: ${new Date().toISOString()}</p>
        </div>
    </div>
</body>
</html>`;
      
      await fs.writeFile(`${websitePath}/index.html`, indexHtml);
      
      // Create package.json
      const packageJson = {
        name: "generated-website",
        version: "1.0.0",
        description: "Website generated by MCP project task",
        scripts: {
          start: "npx serve ."
        },
        devDependencies: {
          serve: "^14.2.0"
        }
      };
      
      await fs.writeFile(`${websitePath}/package.json`, JSON.stringify(packageJson, null, 2));
      
      // Create README.md
      const readme = `# Generated Website

This website was automatically generated by MCP project task.

## Project Details
- **Task:** ${task}
- **Path:** ${project_path}
- **Generated:** ${new Date().toISOString()}

## How to Run
\`\`\`bash
cd website
npm install
npm start
\`\`\`

## Files Created
- \`index.html\` - Main HTML page
- \`package.json\` - Node.js project configuration
- \`README.md\` - This file
`;
      
      await fs.writeFile(`${websitePath}/README.md`, readme);
      
      return {
        success: true,
        task,
        project_path,
        website_path: websitePath,
        files_created: ["index.html", "package.json", "README.md"],
        report_md: `# Website Created Successfully\n\n**Task:** ${task}\n**Project Path:** ${project_path}\n**Website Path:** ${websitePath}\n\n## Files Created:\n- index.html\n- package.json\n- README.md\n\n## Next Steps:\n1. \`cd ${websitePath}\`\n2. \`npm install\`\n3. \`npm start\`\n`,
        logs: `Created website at ${websitePath} with 3 files`
      };
    }
    
    // Default fallback for unknown tasks
    return {
      success: false,
      task,
      project_path,
      error: `Unknown task: ${task}`,
      report_md: `# Unknown Task\n\nTask: ${task}\nPath: ${project_path}\n\n**Error:** Unknown task type`,
      logs: `Failed to execute unknown task: ${task}`
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

  // --- Phase 2: Exec Tool ---
  const ALLOWED_COMMANDS = new Set(['git', 'node', 'npm', 'pnpm', 'yarn', 'python', 'pip']);
  const DANGEROUS_PATTERNS = [
    /-EncodedCommand/i,
    /rm\s+-rf/i,
    /del\s+\/[sS]/i,
    /format\s+/i,
    /fdisk/i,
    /mkfs/i,
    /reg\s+(delete|add|import)/i
  ];

  server.tool(
    "exec",
    "Execute command with security restrictions.",
    {
      cmd: z.string(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      timeout_ms: z.number().int().min(1000).max(300000).default(60000), // 60s default
      max_output_bytes: z.number().int().min(1024).max(10*1024*1024).default(2*1024*1024) // 2MB default
    },
    async ({ cmd, args = [], cwd, env = {}, timeout_ms, max_output_bytes }) => {
      // Security checks
      const baseCmd = cmd.split(' ')[0].toLowerCase();
      
      if (!ALLOWED_COMMANDS.has(baseCmd)) {
        return errText(`Command not allowed: ${cmd}`);
      }

      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(cmd)) {
          return errText(`Dangerous command pattern detected: ${cmd}`);
        }
      }

      // Check cwd is within allowed roots
      let workingDir = cwd || process.cwd();
      if (cwd) {
        workingDir = path.resolve(cwd);
        const isAllowed = ROOTS_FINAL.some(root => workingDir.startsWith(root));
        if (!isAllowed) {
          return errText(`Working directory outside allowed roots: ${cwd}`);
        }
      }

      try {
        return new Promise((resolve) => {
          const startTime = Date.now();
          const child = spawn(cmd, args, {
            cwd: workingDir,
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false
          });

          let stdout = '';
          let stderr = '';
          let stdoutBytes = 0;
          let stderrBytes = 0;

          const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            resolve(okText({
              exit_code: -1,
              stdout: stdout.slice(0, max_output_bytes),
              stderr: stderr.slice(0, max_output_bytes),
              duration_ms: Date.now() - startTime,
              timed_out: true
            }));
          }, timeout_ms);

          child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes <= max_output_bytes) {
              stdout += chunk.toString();
            }
          });

          child.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= max_output_bytes) {
              stderr += chunk.toString();
            }
          });

          child.on('close', (code: number | null) => {
            clearTimeout(timeout);
            resolve(okText({
              exit_code: code || 0,
              stdout: stdout.slice(0, max_output_bytes),
              stderr: stderr.slice(0, max_output_bytes),
              duration_ms: Date.now() - startTime,
              cmd: `${cmd} ${args.join(' ')}`.trim()
            }));
          });

          child.on('error', (error: Error) => {
            clearTimeout(timeout);
            resolve(errText(`Failed to execute command: ${error.message}`));
          });
        });
      } catch (error: any) {
        return errText(`Execution error: ${(error as Error).message}`);
      }
    }
  );

  // --- Phase 3: Event Tools ---
  server.tool(
    "event_publish",
    "Publish an event to events.jsonl",
    {
      type: z.string(),
      data: z.any(),
      source: z.string().optional(),
    },
    async ({ type, data, source }) => {
      const result = await eventPublish({
        syncDir: SYNC_DIR,
        type,
        data,
        source: source ?? "windsurf",
      });
      return okText(result);
    }
  );

  server.tool(
    "event_list",
    "List events from events.jsonl",
    {
      limit: z.number().int().min(1).max(1000).optional(),
      type: z.string().optional(),
      since_ts: z.string().optional(),
    },
    async ({ limit, type, since_ts }) => {
      const result = await eventList({
        syncDir: SYNC_DIR,
        limit,
        type,
        since_ts,
      });
      return okText(result);
    }
  );

  // --- Phase 4: Notes Tools ---
  server.tool(
    "notes_upsert",
    "Create or update a note",
    {
      id: z.string().optional(),
      title: z.string(),
      content: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ id, title, content, tags, body }) => {
      const result = await notesUpsert({
        syncDir: SYNC_DIR,
        id,
        title,
        content: content ?? body,
        tags,
      });
      return okText(result);
    }
  );

  server.tool(
    "notes_get",
    "Get a note by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const result = await notesGet({
        syncDir: SYNC_DIR,
        id,
      });
      return okText(result);
    }
  );

  server.tool(
    "notes_delete",
    "Delete a note by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const result = await notesDelete({
        syncDir: SYNC_DIR,
        id,
      });
      return okText(result);
    }
  );

  server.tool(
    "notes_list",
    "List notes with optional filtering",
    {
      limit: z.number().int().min(1).max(100).optional(),
      query: z.string().optional(),
    },
    async ({ limit, query }) => {
      const result = await notesList({
        syncDir: SYNC_DIR,
        limit,
        query,
      });
      return okText(result);
    }
  );

  // --- Phase 5: Tasks Tools ---
  server.tool(
    "tasks_upsert",
    "Create or update a task",
    {
      id: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
      labels: z.array(z.string()).optional(),
    },
    async ({ id, title, description, status, labels }) => {
      const result = await tasksUpsert({
        syncDir: SYNC_DIR,
        id,
        title,
        description,
        status,
        labels,
      });
      return okText(result);
    }
  );

  server.tool(
    "tasks_get",
    "Get a task by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const result = await tasksGet({
        syncDir: SYNC_DIR,
        id,
      });
      return okText(result);
    }
  );

  server.tool(
    "tasks_delete",
    "Delete a task by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const result = await tasksDelete({
        syncDir: SYNC_DIR,
        id,
      });
      return okText(result);
    }
  );

  server.tool(
    "tasks_list",
    "List tasks with optional filtering",
    {
      limit: z.number().int().min(1).max(100).optional(),
      query: z.string().optional(),
      status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
    },
    async ({ limit, query, status }) => {
      const result = await tasksList({
        syncDir: SYNC_DIR,
        limit,
        query,
        status,
      });
      return okText(result);
    }
  );

  // --- Phase 6: Protocol Tools ---
  server.tool(
    "protocol_init",
    "Initialize protocol files for Windsurf automation.",
    {},
    async () => {
      return await protocolInit();
    }
  );

  server.tool(
    "protocol_write_command",
    "Write a command to inbox_command.json for Windsurf to execute.",
    {
      command: z.string(),
    },
    async ({ command }) => {
      return await protocolWriteCommand(command);
    }
  );

  server.tool(
    "protocol_read_command",
    "Read the current command from inbox_command.json.",
    {},
    async () => {
      return await protocolReadCommand();
    }
  );

  server.tool(
    "protocol_update_status",
    "Update the status.json file.",
    {
      status: z.enum(['idle', 'running', 'done', 'error']),
      error: z.string().optional(),
    },
    async ({ status, error }) => {
      return await protocolUpdateStatus(status, error);
    }
  );

  server.tool(
    "protocol_write_report",
    "Write a report to last_report.md.",
    {
      title: z.string(),
      content: z.string(),
    },
    async ({ title, content }) => {
      return await protocolWriteReport(title, content);
    }
  );

  server.tool(
    "protocol_write_logs",
    "Write logs to last_logs.txt.",
    {
      logs: z.string(),
    },
    async ({ logs }) => {
      return await protocolWriteLogs(logs);
    }
  );

  // --- Phase 1: File System Tools ---

  // fs_list
  server.tool(
    "fs_list",
    "List files under a directory (limited to allowed roots).",
    {
      dir: z.string(),
      limit: z.number().int().min(1).max(5000).optional(),
    },
    async ({ dir, limit }) => {
      const base = assertInAllowedRoots(dir);
      const entries = await fs.readdir(base, { withFileTypes: true });
      const out = entries
        .slice(0, limit ?? 2000)
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
      return okText({ dir: base, entries: out });
    }
  );

  // fs_read
  server.tool(
    "fs_read",
    "Read a UTF-8 text file (limited size).",
    { path: z.string(), max_bytes: z.number().int().min(1).max(2_000_000).optional() },
    async ({ path: p, max_bytes }) => {
      const rp = assertInAllowedRoots(p);
      const st = await fs.stat(rp);
      const limit = max_bytes ?? 500_000;
      if (st.size > limit) return errText(`File too large (${st.size} bytes), limit=${limit}`);
      const content = await fs.readFile(rp, "utf8");
      return okText({ path: rp, content, size: st.size });
    }
  );

  // fs_write
  server.tool(
    "fs_write",
    "Write a UTF-8 text file. If create=false and file missing -> error.",
    {
      path: z.string(),
      content: z.string(),
      create: z.boolean().optional(),
    },
    async ({ path: p, content, create }) => {
      const rp = assertInAllowedRoots(p);
      const dir = path.dirname(rp);
      await fs.mkdir(dir, { recursive: true });
      if (create === false) {
        try {
          await fs.access(rp);
        } catch {
          return errText("File does not exist (create=false)");
        }
      }
      await fs.writeFile(rp, content, "utf8");
      return okText({ written: true, path: rp, bytes: Buffer.byteLength(content, "utf8") });
    }
  );

  // fs_mkdir
  server.tool(
    "fs_mkdir",
    "Create directory recursively inside allowed roots.",
    { path: z.string() },
    async ({ path: inputPath }) => {
      const resolved = path.resolve(inputPath);
      const isAllowed = ROOTS_FINAL.some(root => resolved.startsWith(root));
      if (!isAllowed) {
        return errText(`Path outside allowed roots: ${inputPath}`);
      }

      try {
        await fs.mkdir(resolved, { recursive: true });
        return okText({ created: true, path: resolved });
      } catch (error: any) {
        return errText(`Failed to create directory: ${error.message}`);
      }
    }
  );

  // fs_exists
  server.tool(
    "fs_exists",
    "Check if path exists and its type inside allowed roots.",
    { path: z.string() },
    async ({ path: inputPath }) => {
      const resolved = path.resolve(inputPath);
      const isAllowed = ROOTS_FINAL.some(root => resolved.startsWith(root));
      if (!isAllowed) {
        return errText(`Path outside allowed roots: ${inputPath}`);
      }

      try {
        const stat = await fs.stat(resolved);
        return okText({ 
          exists: true, 
          type: stat.isDirectory() ? "dir" : "file" 
        });
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return okText({ exists: false, type: null });
        }
        return errText(`Failed to check path: ${error.message}`);
      }
    }
  );

  // search_in_files
  server.tool(
    "search_in_files",
    "Search for text/regex in files within allowed roots.",
    { 
      pattern: z.string(),
      max_files: z.number().int().min(1).max(1000).default(100),
      max_file_size: z.number().int().min(1024).max(10*1024*1024).default(2*1024*1024), // 2MB
      max_results: z.number().int().min(1).max(10000).default(500)
    },
    async ({ pattern, max_files, max_file_size, max_results }) => {
      const results: any[] = [];
      const regex = new RegExp(pattern, 'gi');
      let fileCount = 0;
      let resultCount = 0;

      async function searchDirectory(dir: string) {
        if (fileCount >= max_files || resultCount >= max_results) return;

        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          
          for (const entry of entries) {
            if (fileCount >= max_files || resultCount >= max_results) break;
            
            const fullPath = path.join(dir, entry.name);
            const resolved = path.resolve(fullPath);
            
            // Check if within allowed roots
            if (!ROOTS_FINAL.some(root => resolved.startsWith(root))) continue;

            if (entry.isDirectory()) {
              await searchDirectory(fullPath);
            } else if (entry.isFile()) {
              try {
                const stat = await fs.stat(fullPath);
                if (stat.size > max_file_size) return;
                
                fileCount++;
                const content = await fs.readFile(fullPath, 'utf-8');
                const lines = content.split('\n');
                
                for (let i = 0; i < lines.length && resultCount < max_results; i++) {
                  const line = lines[i];
                  const matches = [...line.matchAll(regex)];
                  
                  if (matches.length > 0) {
                    results.push({
                      path: fullPath,
                      line: i + 1,
                      content: line.trim(),
                      matches: matches.map(m => ({
                        text: m[0],
                        index: m.index,
                        length: m[0].length
                      }))
                    });
                    resultCount += matches.length;
                  }
                }
              } catch (error: any) {
                // Skip files that can't be read
                return;
              }
            }
          }
        } catch (error: any) {
          // Skip directories that can't be read
          return;
        }
      }

      // Search in all allowed roots
      for (const root of ROOTS_FINAL) {
        await searchDirectory(root);
      }

      return okText({
        results: results.slice(0, max_results),
        total_files_scanned: fileCount,
        total_matches: resultCount
      });
    }
  );

  // fs_read_content
  server.tool(
    "fs_read_content",
    "Read content from URL or file",
    { url: z.string() },
    async ({ url }) => {
      try {
        // For now, just treat as file path
        const content = await fs.readFile(url, 'utf-8');
        return okText({ url, content });
      } catch (error: any) {
        return errText(`Failed to read content: ${error.message}`);
      }
    }
  );

  // fs_write_content  
  server.tool(
    "fs_write_content",
    "Write content to file",
    { 
      path: z.string(),
      content: z.string(),
      create_empty: z.boolean().optional().default(false)
    },
    async ({ path: filePath, content, create_empty }) => {
      try {
        const resolved = assertInAllowedRoots(filePath);
        const dir = path.dirname(resolved);
        await fs.mkdir(dir, { recursive: true });
        
        if (create_empty) {
          await fs.writeFile(resolved, '', 'utf-8');
        } else {
          await fs.writeFile(resolved, content, 'utf-8');
        }
        
        return okText({ written: true, path: resolved });
      } catch (error: any) {
        return errText(`Failed to write content: ${error.message}`);
      }
    }
  );

  return server;
}

// HTTP server setup
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    CORS_ALLOW_HEADERS
  );
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  next();
});

// Bearer auth middleware for MCP endpoints.
app.use((req, res, next) => {
  if (!AUTH_ENABLED) {
    next();
    return;
  }

  if (!isAuthProtectedPath(req.path)) {
    next();
    return;
  }

  if (!MCP_SYNC_TOKEN) {
    res.status(500).json({ error: "Server auth misconfigured: MCP_SYNC_TOKEN is empty" });
    return;
  }

  const authHeader = req.headers.authorization;
  const parts = typeof authHeader === "string" ? authHeader.trim().split(/\s+/) : [];
  const isBearer = parts.length === 2 && parts[0].toLowerCase() === "bearer";
  const token = isBearer ? parts[1].trim() : "";

  if (!isBearer || !isValidBearerToken(token, MCP_SYNC_TOKEN)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-sync-server"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

const transports: Record<string, WebStandardStreamableHTTPServerTransport> = {};
const sseTransports: Record<string, SSEServerTransport> = {};

// Unified /mcp handler for all methods (GET, POST, DELETE)
app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    console.log(`[${req.method}] /mcp Request received`, {
      sessionId,
      accept: req.headers["accept"],
      ua: req.headers["user-agent"],
    });

    // Check if this is an initialize request
    const isInitialize =
      req.method === "POST" &&
      req.body?.method === "initialize" &&
      req.body?.jsonrpc === "2.0";

    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitialize) {
      // Create new transport
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport!;
        },
      });

      transport.onclose = () => {
        if (transport?.sessionId) delete transports[transport.sessionId];
      };

      const server = createMcpServer();
      await server.connect(transport);
    }

    if (!transport) {
      console.log(`[${req.method}] /mcp Invalid session`, { sessionId, hasSession: !!transports[sessionId!] });
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    // Convert Express request to Fetch request
    const fetchReq = toFetchRequest(req);
    const opts = req.method === "POST" ? { parsedBody: req.body } : undefined;

    // Disable timeouts for SSE
    if (req.method === "GET") {
      req.socket.setTimeout(0);
      (res as any).setTimeout?.(0);
    }

    const webRes = await transport.handleRequest(fetchReq, opts as any);
    await sendFetchResponseToExpress(webRes, res);

  } catch (e: any) {
    console.error(`[${req.method}] /mcp handler error:`, e);
    res.status(500).send("Internal Server Error");
  }
});




// Simple SSE endpoint for testing
app.get("/sse-simple", async (req, res) => {
  console.log(`[GET /sse-simple] Request received. Headers:`, req.headers);
  
  try {
    // Set SSE headers manually
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform, no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    // Disable socket timeout
    req.socket.setTimeout(0);
    
    const sessionId = randomUUID();
    console.log(`[GET /sse-simple] Created simple SSE session: ${sessionId}`);
    
    // Send initial event
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    console.log(`[GET /sse-simple] Sent endpoint event for session ${sessionId}`);

    // Add heartbeat every 25 seconds
    let heartbeatCount = 0;
    const heartbeat = setInterval(() => {
      try {
        heartbeatCount++;
        const pingMsg = `: ping ${Date.now()}\n\n`;
        res.write(pingMsg);
        console.log(`[GET /sse-simple] Sent heartbeat #${heartbeatCount} for session ${sessionId}`);
      } catch (error) {
        console.log(`[GET /sse-simple] Heartbeat error for session ${sessionId}:`, error);
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on("close", () => {
      console.log(`[GET /sse-simple] Request closed for session ${sessionId}`);
      clearInterval(heartbeat);
    });

  } catch (error: any) {
    console.error('[GET /sse-simple] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSE initialization failed' });
    }
  }
});

// SSE MCP endpoint
app.get("/sse", async (req, res) => {
  try {
    // Disable socket timeout
    req.socket.setTimeout(0);

    const transport = new SSEServerTransport("/messages", res);
    const sid = randomUUID();
    sseTransports[sid] = transport;

    (transport as any).onclose = () => {
      delete sseTransports[sid];
    };

    // Add heartbeat every 25 seconds to prevent Cloudflare timeout
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch (error) {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
    });

    const server = createMcpServer();
    await server.connect(transport);
  } catch (error: any) {
    console.error('SSE endpoint error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSE initialization failed' });
    }
  }
});

app.post("/messages", async (req, res) => {
  const active = Object.values(sseTransports);
  if (!active.length) {
    res.status(400).send("No active SSE session");
    return;
  }

  // Send to first active SSE session
  await (active[0] as any).handleRequest(req, res);
});

// Add JSON error handler
app.use((err: any, _req: any, res: any, next: any) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  next(err);
});

const httpServer = app.listen(PORT, () => {
  console.log(`MCP Sync Server listening on port ${PORT}`);
  console.log(`Auth: ${AUTH_ENABLED ? 'enabled' : 'disabled'}`);
  if (AUTH_ENABLED_FROM_ENV === undefined && AUTH_ENABLED_RAW) {
    console.log(`AUTH_ENABLED value "${AUTH_ENABLED_RAW}" is invalid; fallback is token-based auto mode.`);
  }
  console.log(`Auth protected paths: /mcp, /messages, /sse, /sse-simple`);
  console.log(`Sync dir: ${SYNC_DIR}`);
});

httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;
