import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { acquireLock, releaseLock } from "./locks.js";
import { ensureQueueLayout, queuePush, queuePop, queueAck, jobHistoryList } from "./queue.js";
import { executeOneFromQueue } from "./router_queue.js";

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const MCP_SYNC_TOKEN = (process.env.MCP_SYNC_TOKEN || "").trim();
const ORIGIN_ALLOWLIST = (process.env.MCP_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Use Projects directory as root
const PROJECTS_ROOT = "C:\\Users\\anani\\Projects";
const ALLOWED_ROOTS = (process.env.MCP_ALLOWED_ROOTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.isAbsolute(p) ? p : path.resolve(PROJECTS_ROOT, p));

const ROOTS_FINAL = ALLOWED_ROOTS.length ? ALLOWED_ROOTS : [PROJECTS_ROOT];

function assertInAllowedRoots(p: string) {
  const rp = path.resolve(p);
  for (const root of ROOTS_FINAL) {
    const rr = path.resolve(root);
    if (rp === rr || rp.startsWith(rr + path.sep)) return rp;
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

// Use Projects directory for SYNC_DIR
const SYNC_DIR = path.resolve(PROJECTS_ROOT, '_sync');
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
              "exec"
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
  const body = req.body;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, body);
});

const handleSessionRequest = async (req: any, res: any) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

// SSE MCP endpoint
app.get("/sse", async (req, res) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    const sid = randomUUID();
    sseTransports[sid] = transport;

    (transport as any).onclose = () => {
      delete sseTransports[sid];
    };

    const server = createMcpServer();
    await server.connect(transport);
  } catch (error: any) {
    console.error('SSE endpoint error:', error);
    res.status(500).json({ error: 'SSE initialization failed' });
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

app.listen(PORT, () => {
  console.log(`MCP Sync Server listening on port ${PORT}`);
  console.log(`Auth: ${MCP_SYNC_TOKEN ? 'enabled' : 'disabled'}`);
  console.log(`Sync dir: ${SYNC_DIR}`);
});
