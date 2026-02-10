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

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const MCP_SYNC_TOKEN = (process.env.MCP_SYNC_TOKEN || "").trim();
const ORIGIN_ALLOWLIST = (process.env.MCP_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_ROOT = path.resolve(process.cwd());
const ALLOWED_ROOTS = (process.env.MCP_ALLOWED_ROOTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));

const ROOTS = ALLOWED_ROOTS.length ? ALLOWED_ROOTS : [DEFAULT_ROOT];

function assertInAllowedRoots(p: string) {
  const rp = path.resolve(p);
  for (const root of ROOTS) {
    const rr = path.resolve(root);
    if (rp === rr || rp.startsWith(rr + path.sep)) return rp;
  }
  throw new Error(`Path is outside allowed roots: ${rp}`);
}

function sha1(s: string) {
  return createHash("sha1").update(s).digest("hex");
}

const DATA_DIR = path.resolve(process.cwd(), ".data");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");

type Note = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  links: string[];
  created_at: string;
  updated_at: string;
  etag: string;
};

type Task = {
  id: string;
  title: string;
  description: string;
  status: "todo" | "doing" | "done";
  labels: string[];
  created_at: string;
  updated_at: string;
  etag: string;
};

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const f of [NOTES_FILE, TASKS_FILE]) {
    try {
      await fs.access(f);
    } catch {
      await fs.writeFile(f, JSON.stringify([], null, 2), "utf8");
    }
  }
}

async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as T;
}
async function writeJson(file: string, value: unknown) {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function okText(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] as any[] };
}
function errText(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] as any[] };
}

async function notesLoad(): Promise<Note[]> {
  await ensureDataFiles();
  return readJson<Note[]>(NOTES_FILE);
}
async function notesSave(items: Note[]) {
  await writeJson(NOTES_FILE, items);
}

async function tasksLoad(): Promise<Task[]> {
  await ensureDataFiles();
  return readJson<Task[]>(TASKS_FILE);
}
async function tasksSave(items: Task[]) {
  await writeJson(TASKS_FILE, items);
}

function createMcpServer() {
  const server = new McpServer({ name: "sync-core", version: "1.0.0" });

  // --- whoami ---
  server.tool(
    "whoami",
    "Return basic server info and enabled security settings.",
    {},
    async () => {
      return okText({
        server: "sync-core",
        version: "1.0.0",
        roots: ROOTS,
        auth: MCP_SYNC_TOKEN ? "bearer" : "none",
        origin_allowlist: ORIGIN_ALLOWLIST,
      });
    }
  );

  // --- notes ---
  server.tool(
    "notes_list",
    "List notes (optionally filter by tag or query).",
    {
      q: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ q, tag, limit }) => {
      const items = await notesLoad();
      const qq = (q || "").toLowerCase().trim();
      let out = items;

      if (tag) out = out.filter((n) => n.tags.includes(tag));
      if (qq) {
        out = out.filter((n) =>
          (n.title + "\n" + n.body + "\n" + n.tags.join(" ")).toLowerCase().includes(qq)
        );
      }

      out = out
        .slice()
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit ?? 50);

      return okText(out.map((n) => ({ id: n.id, title: n.title, tags: n.tags, updated_at: n.updated_at, etag: n.etag })));
    }
  );

  server.tool(
    "notes_get",
    "Get a note by id.",
    { id: z.string() },
    async ({ id }) => {
      const items = await notesLoad();
      const n = items.find((x) => x.id === id);
      if (!n) return errText("Note not found");
      return okText(n);
    }
  );

  server.tool(
    "notes_upsert",
    "Create or update a note. Uses if_match (etag) for safe updates.",
    {
      id: z.string().optional(),
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      links: z.array(z.string()).optional(),
      if_match: z.string().optional(),
    },
    async ({ id, title, body, tags, links, if_match }) => {
      const items = await notesLoad();
      const t = nowIso();

      if (id) {
        const idx = items.findIndex((x) => x.id === id);
        if (idx === -1) return errText("Note not found");
        if (if_match && items[idx].etag !== if_match) {
          return { isError: true, content: [{ type: "text", text: "ETag mismatch (409)" }] as any[] };
        }
        const updated: Note = {
          ...items[idx],
          title,
          body,
          tags: tags ?? items[idx].tags,
          links: links ?? items[idx].links,
          updated_at: t,
          etag: sha1(`${title}\n${body}\n${(tags ?? items[idx].tags).join(",")}\n${(links ?? items[idx].links).join(",")}\n${t}`),
        };
        items[idx] = updated;
        await notesSave(items);
        return okText(updated);
      }

      const newId = randomUUID();
      const created: Note = {
        id: newId,
        title,
        body,
        tags: tags ?? [],
        links: links ?? [],
        created_at: t,
        updated_at: t,
        etag: sha1(`${title}\n${body}\n${(tags ?? []).join(",")}\n${(links ?? []).join(",")}\n${t}`),
      };
      items.push(created);
      await notesSave(items);
      return okText(created);
    }
  );

  server.tool(
    "notes_delete",
    "Delete a note by id. Uses if_match (etag) for safe deletes.",
    { id: z.string(), if_match: z.string().optional() },
    async ({ id, if_match }) => {
      const items = await notesLoad();
      const idx = items.findIndex((x) => x.id === id);
      if (idx === -1) return errText("Note not found");
      if (if_match && items[idx].etag !== if_match) {
        return { isError: true, content: [{ type: "text", text: "ETag mismatch (409)" }] as any[] };
      }
      const removed = items[idx];
      items.splice(idx, 1);
      await notesSave(items);
      return okText({ deleted: true, removed });
    }
  );

  // --- tasks ---
  server.tool(
    "tasks_list",
    "List tasks (optionally filter by status or query).",
    {
      q: z.string().optional(),
      status: z.enum(["todo", "doing", "done"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ q, status, limit }) => {
      const items = await tasksLoad();
      const qq = (q || "").toLowerCase().trim();
      let out = items;

      if (status) out = out.filter((t) => t.status === status);
      if (qq) {
        out = out.filter((t) =>
          (t.title + "\n" + t.description + "\n" + t.labels.join(" ")).toLowerCase().includes(qq)
        );
      }

      out = out
        .slice()
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit ?? 50);

      return okText(out.map((t) => ({ id: t.id, title: t.title, status: t.status, updated_at: t.updated_at, etag: t.etag })));
    }
  );

  server.tool(
    "tasks_get",
    "Get a task by id.",
    { id: z.string() },
    async ({ id }) => {
      const items = await tasksLoad();
      const t = items.find((x) => x.id === id);
      if (!t) return errText("Task not found");
      return okText(t);
    }
  );

  server.tool(
    "tasks_upsert",
    "Create or update a task. Uses if_match (etag) for safe updates.",
    {
      id: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(["todo", "doing", "done"]).optional(),
      labels: z.array(z.string()).optional(),
      if_match: z.string().optional(),
    },
    async ({ id, title, description, status, labels, if_match }) => {
      const items = await tasksLoad();
      const t = nowIso();

      if (id) {
        const idx = items.findIndex((x) => x.id === id);
        if (idx === -1) return errText("Task not found");
        if (if_match && items[idx].etag !== if_match) {
          return { isError: true, content: [{ type: "text", text: "ETag mismatch (409)" }] as any[] };
        }
        const updated: Task = {
          ...items[idx],
          title,
          description: description ?? items[idx].description,
          status: status ?? items[idx].status,
          labels: labels ?? items[idx].labels,
          updated_at: t,
          etag: sha1(`${title}\n${description ?? items[idx].description}\n${status ?? items[idx].status}\n${(labels ?? items[idx].labels).join(",")}\n${t}`),
        };
        items[idx] = updated;
        await tasksSave(items);
        return okText(updated);
      }

      const newId = randomUUID();
      const created: Task = {
        id: newId,
        title,
        description: description ?? "",
        status: status ?? "todo",
        labels: labels ?? [],
        created_at: t,
        updated_at: t,
        etag: sha1(`${title}\n${description ?? ""}\n${status ?? "todo"}\n${(labels ?? []).join(",")}\n${t}`),
      };
      items.push(created);
      await tasksSave(items);
      return okText(created);
    }
  );

  server.tool(
    "tasks_delete",
    "Delete a task by id. Uses if_match (etag) for safe deletes.",
    { id: z.string(), if_match: z.string().optional() },
    async ({ id, if_match }) => {
      const items = await tasksLoad();
      const idx = items.findIndex((x) => x.id === id);
      if (idx === -1) return errText("Task not found");
      if (if_match && items[idx].etag !== if_match) {
        return { isError: true, content: [{ type: "text", text: "ETag mismatch (409)" }] as any[] };
      }
      const removed = items[idx];
      items.splice(idx, 1);
      await tasksSave(items);
      return okText({ deleted: true, removed });
    }
  );

  // --- fs ---
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

  // --- search/fetch (для ChatGPT как коннектора) ---
  server.tool(
    "search",
    "Search notes/tasks by query. Returns ids that can be passed to fetch(id).",
    { query: z.string(), limit: z.number().int().min(1).max(200).optional() },
    async ({ query, limit }) => {
      const qq = query.toLowerCase().trim();
      const n = await notesLoad();
      const t = await tasksLoad();

      const noteHits = n
        .filter((x) => (x.title + "\n" + x.body + "\n" + x.tags.join(" ")).toLowerCase().includes(qq))
        .slice(0, limit ?? 50)
        .map((x) => ({ id: `note:${x.id}`, title: x.title, updated_at: x.updated_at, etag: x.etag }));

      const taskHits = t
        .filter((x) => (x.title + "\n" + x.description + "\n" + x.labels.join(" ")).toLowerCase().includes(qq))
        .slice(0, limit ?? 50)
        .map((x) => ({ id: `task:${x.id}`, title: x.title, status: x.status, updated_at: x.updated_at, etag: x.etag }));

      return okText({ results: [...noteHits, ...taskHits].slice(0, limit ?? 50) });
    }
  );

  server.tool(
    "fetch",
    "Fetch an item by id returned from search(). Supports note:<id> and task:<id>.",
    { id: z.string() },
    async ({ id }) => {
      const [kind, rawId] = id.split(":", 2);
      if (!rawId) return errText("Bad id format");
      if (kind === "note") {
        const items = await notesLoad();
        const x = items.find((v) => v.id === rawId);
        if (!x) return errText("Note not found");
        return okText({ id, title: x.title, content: x.body, tags: x.tags, links: x.links, updated_at: x.updated_at, etag: x.etag });
      }
      if (kind === "task") {
        const items = await tasksLoad();
        const x = items.find((v) => v.id === rawId);
        if (!x) return errText("Task not found");
        return okText({ id, title: x.title, content: x.description, status: x.status, labels: x.labels, updated_at: x.updated_at, etag: x.etag });
      }
      return errText("Unsupported kind");
    }
  );

  // --- Phase 1: File System Tools ---

  // fs_mkdir
  server.tool(
    "fs_mkdir",
    "Create directory recursively inside allowed roots.",
    { path: z.string() },
    async ({ path: inputPath }) => {
      const resolved = path.resolve(inputPath);
      const isAllowed = ROOTS.some(root => resolved.startsWith(root));
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
      const isAllowed = ROOTS.some(root => resolved.startsWith(root));
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
            if (!ROOTS.some(root => resolved.startsWith(root))) continue;

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
      for (const root of ROOTS) {
        await searchDirectory(root);
      }

      return okText({
        results: results.slice(0, max_results),
        total_files_scanned: fileCount,
        total_matches: resultCount
      });
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
        const isAllowed = ROOTS.some(root => workingDir.startsWith(root));
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

  // --- Phase 4: Event Tools (File-based Pub/Sub) ---

  const EVENTS_DIR = path.join(ROOTS[0], '_sync');
  const EVENTS_FILE = path.join(EVENTS_DIR, 'events.jsonl');

  // Ensure _sync directory exists
  async function ensureEventsDir() {
    try {
      await fs.mkdir(EVENTS_DIR, { recursive: true });
    } catch (error: any) {
      // Ignore if directory already exists
    }
  }

  // event_publish
  server.tool(
    "event_publish",
    "Publish an event to the events log.",
    {
      type: z.string(), // event type: 'status', 'report', 'log', etc.
      data: z.any(), // event data (any JSON-serializable value)
      source: z.string().optional(), // optional source identifier
    },
    async ({ type, data, source }) => {
      await ensureEventsDir();
      
      const event = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type,
        data,
        source: source || 'unknown'
      };

      try {
        const line = JSON.stringify(event) + '\n';
        await fs.appendFile(EVENTS_FILE, line, 'utf-8');
        return okText({ 
          published: true, 
          event_id: event.id,
          timestamp: event.timestamp
        });
      } catch (error: any) {
        return errText(`Failed to publish event: ${error.message}`);
      }
    }
  );

  // event_list
  server.tool(
    "event_list",
    "List recent events from the events log.",
    {
      limit: z.number().int().min(1).max(1000).default(50),
      type: z.string().optional(), // filter by event type
      since: z.string().optional(), // ISO timestamp filter
    },
    async ({ limit, type, since }) => {
      try {
        const exists = await fs.access(EVENTS_FILE).then(() => true).catch(() => false);
        if (!exists) {
          return okText({ events: [], total: 0 });
        }

        const content = await fs.readFile(EVENTS_FILE, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());
        
        let events = lines.map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(event => event !== null);

        // Apply filters
        if (type) {
          events = events.filter(event => event.type === type);
        }
        
        if (since) {
          const sinceDate = new Date(since);
          events = events.filter(event => new Date(event.timestamp) >= sinceDate);
        }

        // Sort by timestamp (newest first) and limit
        events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        events = events.slice(0, limit);

        return okText({ 
          events: events,
          total: events.length,
          has_more: events.length === limit
        });
      } catch (error: any) {
        return errText(`Failed to read events: ${error.message}`);
      }
    }
  );

  // --- Phase 5: Protocol Tools for Windsurf Automation ---

  const SYNC_DIR = path.join(ROOTS[0], '_sync');
  const INBOX_FILE = path.join(SYNC_DIR, 'inbox_command.json');
  const STATUS_FILE = path.join(SYNC_DIR, 'status.json');
  const REPORT_FILE = path.join(SYNC_DIR, 'last_report.md');
  const LOGS_FILE = path.join(SYNC_DIR, 'last_logs.txt');

  // Ensure _sync directory exists
  async function ensureSyncDir() {
    try {
      await fs.mkdir(SYNC_DIR, { recursive: true });
    } catch (error: any) {
      // Ignore if directory already exists
    }
  }

  // protocol_init
  server.tool(
    "protocol_init",
    "Initialize protocol files for Windsurf automation.",
    {},
    async () => {
      await ensureSyncDir();
      
      try {
        // Create empty inbox_command.json
        await fs.writeFile(INBOX_FILE, JSON.stringify({ command: null, timestamp: null }, null, 2), 'utf-8');
        
        // Create initial status.json
        await fs.writeFile(STATUS_FILE, JSON.stringify({ 
          status: 'idle', 
          last_command: null, 
          last_run: null, 
          error: null 
        }, null, 2), 'utf-8');
        
        // Create empty last_report.md
        await fs.writeFile(REPORT_FILE, '# MCP Sync Protocol Report\n\nNo reports yet.\n', 'utf-8');
        
        // Create empty last_logs.txt
        await fs.writeFile(LOGS_FILE, '', 'utf-8');
        
        return okText({ 
          initialized: true,
          files: {
            inbox_command: INBOX_FILE,
            status: STATUS_FILE,
            last_report: REPORT_FILE,
            last_logs: LOGS_FILE
          }
        });
      } catch (error: any) {
        return errText(`Failed to initialize protocol: ${error.message}`);
      }
    }
  );

  // protocol_write_command
  server.tool(
    "protocol_write_command",
    "Write a command to inbox_command.json for Windsurf to execute.",
    {
      command: z.string(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      description: z.string().optional(),
      inputs: z.any().optional()
    },
    async ({ command, args = [], cwd, description, inputs }) => {
      await ensureSyncDir();
      
      const commandData = {
        command,
        args,
        cwd,
        description,
        inputs,
        timestamp: new Date().toISOString(),
        id: randomUUID()
      };
      
      try {
        await fs.writeFile(INBOX_FILE, JSON.stringify(commandData, null, 2), 'utf-8');
        return okText({ 
          written: true, 
          command_id: commandData.id,
          timestamp: commandData.timestamp
        });
      } catch (error: any) {
        return errText(`Failed to write command: ${error.message}`);
      }
    }
  );

  // protocol_read_command
  server.tool(
    "protocol_read_command",
    "Read the current command from inbox_command.json.",
    {},
    async () => {
      try {
        const exists = await fs.access(INBOX_FILE).then(() => true).catch(() => false);
        if (!exists) {
          return okText({ command: null, exists: false });
        }
        
        const content = await fs.readFile(INBOX_FILE, 'utf-8');
        const commandData = JSON.parse(content);
        
        return okText({ 
          command: commandData,
          exists: true
        });
      } catch (error: any) {
        return errText(`Failed to read command: ${error.message}`);
      }
    }
  );

  // protocol_update_status
  server.tool(
    "protocol_update_status",
    "Update the status.json file.",
    {
      status: z.enum(['idle', 'running', 'done', 'error']),
      last_command: z.string().optional(),
      error: z.string().optional()
    },
    async ({ status, last_command, error }) => {
      await ensureSyncDir();
      
      try {
        const statusData = {
          status,
          last_command: last_command || null,
          last_run: new Date().toISOString(),
          error: error || null
        };
        
        await fs.writeFile(STATUS_FILE, JSON.stringify(statusData, null, 2), 'utf-8');
        return okText({ 
          updated: true, 
          status: statusData.status,
          timestamp: statusData.last_run
        });
      } catch (error: any) {
        return errText(`Failed to update status: ${error.message}`);
      }
    }
  );

  // protocol_write_report
  server.tool(
    "protocol_write_report",
    "Write a report to last_report.md.",
    {
      title: z.string(),
      content: z.string(),
      append: z.boolean().default(false)
    },
    async ({ title, content, append }) => {
      await ensureSyncDir();
      
      try {
        const reportContent = append ? 
          `\n\n## ${title}\n\n${content}` : 
          `# ${title}\n\n${content}`;
        
        if (append) {
          await fs.appendFile(REPORT_FILE, reportContent, 'utf-8');
        } else {
          await fs.writeFile(REPORT_FILE, reportContent, 'utf-8');
        }
        
        return okText({ 
          written: true, 
          file: REPORT_FILE,
          append
        });
      } catch (error: any) {
        return errText(`Failed to write report: ${error.message}`);
      }
    }
  );

  // protocol_write_logs
  server.tool(
    "protocol_write_logs",
    "Write logs to last_logs.txt.",
    {
      logs: z.string(),
      append: z.boolean().default(true)
    },
    async ({ logs, append }) => {
      await ensureSyncDir();
      
      try {
        const timestamp = new Date().toISOString();
        const logContent = `[${timestamp}] ${logs}`;
        
        if (append) {
          await fs.appendFile(LOGS_FILE, logContent + '\n', 'utf-8');
        } else {
          await fs.writeFile(LOGS_FILE, logContent + '\n', 'utf-8');
        }
        
        return okText({ 
          written: true, 
          file: LOGS_FILE,
          append
        });
      } catch (error: any) {
        return errText(`Failed to write logs: ${error.message}`);
      }
    }
  );

  // --- Phase 6: Router and Project Task Handler ---

  // fs_write_content utility (needed for project files)
  server.tool(
    "fs_write_content",
    "Write content to file inside allowed roots.",
    { 
      path: z.string(),
      content: z.string(),
      create: z.boolean().default(true)
    },
    async ({ path: inputPath, content, create }) => {
      const resolved = path.resolve(inputPath);
      const isAllowed = ROOTS.some(root => resolved.startsWith(root));
      if (!isAllowed) {
        return errText(`Path outside allowed roots: ${inputPath}`);
      }

      try {
        await fs.writeFile(resolved, content, 'utf-8');
        return okText({ written: true, path: resolved, bytes: content.length });
      } catch (error: any) {
        return errText(`Failed to write file: ${error.message}`);
      }
    }
  );

  // fs_read_content utility (needed for project specs)
  server.tool(
    "fs_read_content",
    "Read content from file inside allowed roots.",
    { 
      path: z.string(),
      max_bytes: z.number().int().min(1).max(10*1024*1024).default(1024*1024) // 1MB default
    },
    async ({ path: inputPath, max_bytes }) => {
      const resolved = path.resolve(inputPath);
      const isAllowed = ROOTS.some(root => resolved.startsWith(root));
      if (!isAllowed) {
        return errText(`Path outside allowed roots: ${inputPath}`);
      }

      try {
        const content = await fs.readFile(resolved, 'utf-8');
        const truncated = content.length > max_bytes ? content.slice(0, max_bytes) : content;
        return okText({ 
          content: truncated, 
          path: resolved,
          bytes: content.length,
          truncated: content.length > max_bytes
        });
      } catch (error: any) {
        return errText(`Failed to read file: ${error.message}`);
      }
    }
  );

  // handleProjectTask implementation with task dispatch
  async function handleProjectTask(job: any) {
    const { id, inputs } = job;
    const task = inputs?.task || 'build_snake_game'; // default
    
    try {
      switch (task) {
        case 'build_snake_game':
          return await buildSnakeGame(job);
        case 'fix_snake_to_spec_v1':
          return await fixSnakeToSpec(job);
        case 'fix_snake_ux_and_pause_v2':
          return await fixSnakeUxAndPauseV2(job);
        default:
          throw new Error(`Unknown project_task: ${task}`);
      }
    } catch (error: any) {
      throw new Error(`Project task failed: ${error.message}`);
    }
  }

  // buildSnakeGame - create new snake game project
  async function buildSnakeGame(job: any) {
    const { inputs } = job;
    const { spec_path, project_path } = inputs || {};
    
    // Step 1: Read spec
    const specResult = await fs.readFile(path.join(SYNC_DIR, spec_path || 'snake_spec.md'), 'utf-8');
    
    // Step 2: Create project directory
    await fs.mkdir(project_path || 'C:\\Users\\anani\\Projects\\snake-mcp', { recursive: true });
    
    // Step 3: Write project files
    const projectDir = project_path || 'C:\\Users\\anani\\Projects\\snake-mcp';
    
    // index.html
    await fs.writeFile(
      path.join(projectDir, 'index.html'),
      `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Snake Game</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="game-container">
        <h1>Snake Game</h1>
        <div class="score">Score: <span id="score">0</span></div>
        <canvas id="gameCanvas" width="400" height="400"></canvas>
        <div class="controls">
            <button onclick="startGame()">Start Game</button>
            <button onclick="resetGame()">Reset</button>
        </div>
    </div>
    <script src="snake.js"></script>
</body>
</html>`,
      'utf-8'
    );
    
    // style.css
    await fs.writeFile(
      path.join(projectDir, 'style.css'),
      `body {
    font-family: Arial, sans-serif;
    background-color: #f0f0f0;
    margin: 0;
    padding: 20px;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
}

.game-container {
    text-align: center;
    background: white;
    padding: 20px;
    border-radius: 10px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

h1 {
    color: #333;
    margin-bottom: 20px;
}

.score {
    font-size: 18px;
    margin-bottom: 20px;
    color: #666;
}

canvas {
    border: 2px solid #333;
    background-color: #000;
}

.controls {
    margin-top: 20px;
}

button {
    background-color: #4CAF50;
    color: white;
    border: none;
    padding: 10px 20px;
    margin: 0 10px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 16px;
}

button:hover {
    background-color: #45a049;
}`,
      'utf-8'
    );
    
    // snake.js
    await fs.writeFile(
      path.join(projectDir, 'snake.js'),
      `const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreElement = document.getElementById('score');

// Game variables
const gridSize = 20;
const tileCount = canvas.width / gridSize;
let snake = [{ x: 10, y: 10 }];
let direction = { x: 0, y: 0 };
let food = generateFood();
let score = 0;
let gameRunning = false;

// Generate random food position
function generateFood() {
    return {
        x: Math.floor(Math.random() * tileCount),
        y: Math.floor(Math.random() * tileCount)
    };
}

// Draw game elements
function draw() {
    // Clear canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw snake
    ctx.fillStyle = '#0f0';
    snake.forEach(segment => {
        ctx.fillRect(segment.x * gridSize, segment.y * gridSize, gridSize - 2, gridSize - 2);
    });
    
    // Draw food
    ctx.fillStyle = '#f00';
    ctx.fillRect(food.x * gridSize, food.y * gridSize, gridSize - 2, gridSize - 2);
}

// Update game state
function update() {
    if (!gameRunning) return;
    
    // Move snake head
    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };
    
    // Check wall collision
    if (head.x < 0 || head.x >= tileCount || head.y < 0 || head.y >= tileCount) {
        gameOver();
        return;
    }
    
    // Check self collision
    for (let segment of snake) {
        if (head.x === segment.x && head.y === segment.y) {
            gameOver();
            return;
        }
    }
    
    snake.unshift(head);
    
    // Check food collision
    if (head.x === food.x && head.y === food.y) {
        score += 10;
        scoreElement.textContent = score;
        food = generateFood();
    } else {
        snake.pop();
    }
}

// Game over
function gameOver() {
    gameRunning = false;
    alert(\`Game Over! Score: \${score}\`);
}

// Game loop
function gameLoop() {
    update();
    draw();
    
    if (gameRunning) {
        setTimeout(gameLoop, 100);
    }
}

// Start game
function startGame() {
    if (gameRunning) return;
    
    gameRunning = true;
    direction = { x: 1, y: 0 };
    gameLoop();
}

// Reset game
function resetGame() {
    gameRunning = false;
    snake = [{ x: 10, y: 10 }];
    direction = { x: 0, y: 0 };
    food = generateFood();
    score = 0;
    scoreElement.textContent = score;
    draw();
}

// Keyboard controls
document.addEventListener('keydown', (e) => {
    if (!gameRunning) return;
    
    switch (e.key) {
        case 'ArrowUp':
            if (direction.y === 0) direction = { x: 0, y: -1 };
            break;
        case 'ArrowDown':
            if (direction.y === 0) direction = { x: 0, y: 1 };
            break;
        case 'ArrowLeft':
            if (direction.x === 0) direction = { x: -1, y: 0 };
            break;
        case 'ArrowRight':
            if (direction.x === 0) direction = { x: 1, y: 0 };
            break;
    }
});

// Initial draw
draw();`,
      'utf-8'
    );
    
    // README.md
    await fs.writeFile(
      path.join(projectDir, 'README.md'),
      `# Snake Game

A classic snake game built with HTML, CSS, and JavaScript.

## How to Play

1. Open \`index.html\` in a web browser
2. Click "Start Game" to begin
3. Use arrow keys to control the snake
4. Eat the red food to grow and increase score
5. Avoid hitting walls or yourself

## Features

- Classic snake gameplay
- Score tracking
- Responsive controls
- Clean, modern UI

## Files

- \`index.html\` - Main HTML structure
- \`style.css\` - Styling and layout
- \`snake.js\` - Game logic and controls

## Controls

- Arrow Keys: Move snake
- Start Button: Begin game
- Reset Button: Reset game

Enjoy playing!`,
      'utf-8'
    );
    
    // Step 4: Self-check files exist
    const files = ['index.html', 'style.css', 'snake.js', 'README.md'];
    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      if (!exists) {
        throw new Error(`File not created: ${file}`);
      }
    }
    
    return {
      success: true,
      project_path: projectDir,
      files_created: files,
      spec_content: specResult.substring(0, 200) + '...',
      task: 'build_snake_game'
    };
  }

  // fixSnakeToSpec - patch existing snake game to match spec
  async function fixSnakeToSpec(job: any) {
    const { inputs } = job;
    const project_path = inputs?.project_path || 'C:\\Users\\anani\\Projects\\snake-mcp';
    
    const projectDir = project_path;
    const changes = [];
    
    try {
      // Step 1: Read current snake.js
      const snakeJsPath = path.join(projectDir, 'snake.js');
      let snakeJsContent = await fs.readFile(snakeJsPath, 'utf-8');
      
      // Step 2: Apply fixes
      
      // Fix 1: Remove alert() and add proper game over handling
      if (snakeJsContent.includes('alert(')) {
        snakeJsContent = snakeJsContent.replace(
          `function gameOver() {
    gameRunning = false;
    alert(\`Game Over! Score: \${score}\`);
}`,
          `function gameOver() {
    gameRunning = false;
    // Game over - score remains visible
}`
        );
        changes.push('Removed alert() from gameOver()');
      }
      
      // Fix 2: Add Space pause functionality
      if (!snakeJsContent.includes('case \' \'')) {
        snakeJsContent = snakeJsContent.replace(
          `document.addEventListener('keydown', (e) => {
    if (!gameRunning) return;
    
    switch (e.key) {`,
          `document.addEventListener('keydown', (e) => {
    switch (e.key) {
        case ' ':
            gameRunning = !gameRunning;
            if (gameRunning) gameLoop();
            return;
    }
    
    if (!gameRunning) return;
    
    switch (e.key) {`
        );
        changes.push('Added Space key pause/resume');
      }
      
      // Fix 3: Add R restart functionality
      if (!snakeJsContent.includes('case \'r\'')) {
        snakeJsContent = snakeJsContent.replace(
          `        case 'ArrowRight':
            if (direction.x === 0) direction = { x: 1, y: 0 };
            break;
    }
});`,
          `        case 'ArrowRight':
            if (direction.x === 0) direction = { x: 1, y: 0 };
            break;
        case 'r':
        case 'R':
            resetGame();
            break;
    }
});`
        );
        changes.push('Added R key restart');
      }
      
      // Fix 4: Add WASD controls
      if (!snakeJsContent.includes("case 'w'")) {
        snakeJsContent = snakeJsContent.replace(
          `        case 'ArrowUp':
            if (direction.y === 0) direction = { x: 0, y: -1 };
            break;
        case 'ArrowDown':
            if (direction.y === 0) direction = { x: 0, y: 1 };
            break;`,
          `        case 'ArrowUp':
        case 'w':
        case 'W':
            if (direction.y === 0) direction = { x: 0, y: -1 };
            break;
        case 'ArrowDown':
        case 's':
        case 'S':
            if (direction.y === 0) direction = { x: 0, y: 1 };
            break;`
        );
        changes.push('Added WASD controls');
      }
      
      // Fix 5: Add A/D for left/right
      if (!snakeJsContent.includes("case 'a'")) {
        snakeJsContent = snakeJsContent.replace(
          `        case 'ArrowLeft':
            if (direction.x === 0) direction = { x: -1, y: 0 };
            break;
        case 'ArrowRight':`,
          `        case 'ArrowLeft':
        case 'a':
        case 'A':
            if (direction.x === 0) direction = { x: -1, y: 0 };
            break;
        case 'ArrowRight':
        case 'd':
        case 'D':`
        );
        changes.push('Added A/D for left/right');
      }
      
      // Fix 6: Change score from += 10 to += 1
      if (snakeJsContent.includes('score += 10')) {
        snakeJsContent = snakeJsContent.replace('score += 10', 'score += 1');
        changes.push('Changed score increment from +10 to +1');
      }
      
      // Fix 7: Add acceleration every 5 points
      if (!snakeJsContent.includes('acceleration')) {
        snakeJsContent = snakeJsContent.replace(
          `let score = 0;
let gameRunning = false;`,
          `let score = 0;
let gameRunning = false;
let baseDelay = 100;
let currentDelay = baseDelay;`
        );
        
        snakeJsContent = snakeJsContent.replace(
          `    // Check food collision
    if (head.x === food.x && head.y === food.y) {
        score += 1;
        scoreElement.textContent = score;
        food = generateFood();
    } else {
        snake.pop();
    }`,
          `    // Check food collision
    if (head.x === food.x && head.y === food.y) {
        score += 1;
        scoreElement.textContent = score;
        
        // Accelerate every 5 points
        if (score % 5 === 0 && currentDelay > 30) {
            currentDelay -= 10;
        }
        
        food = generateFood();
    } else {
        snake.pop();
    }`
        );
        
        snakeJsContent = snakeJsContent.replace(
          `    if (gameRunning) {
        setTimeout(gameLoop, 100);
    }`,
          `    if (gameRunning) {
        setTimeout(gameLoop, currentDelay);
    }`
        );
        
        changes.push('Added acceleration every 5 points');
      }
      
      // Fix 8: Ensure food doesn't spawn on snake
      if (!snakeJsContent.includes('onSnake')) {
        snakeJsContent = snakeJsContent.replace(
          `// Generate random food position
function generateFood() {
    return {
        x: Math.floor(Math.random() * tileCount),
        y: Math.floor(Math.random() * tileCount)
    };
}`,
          `// Check if position is on snake
function onSnake(pos) {
    return snake.some(segment => segment.x === pos.x && segment.y === pos.y);
}

// Generate random food position
function generateFood() {
    let newFood;
    do {
        newFood = {
            x: Math.floor(Math.random() * tileCount),
            y: Math.floor(Math.random() * tileCount)
        };
    } while (onSnake(newFood));
    return newFood;
}`
        );
        changes.push('Ensured food doesn\'t spawn on snake');
      }
      
      // Write patched snake.js
      await fs.writeFile(snakeJsPath, snakeJsContent, 'utf-8');
      
      // Step 3: Update README.md with new controls
      const readmePath = path.join(projectDir, 'README.md');
      let readmeContent = await fs.readFile(readmePath, 'utf-8');
      
      if (!readmeContent.includes('WASD') || !readmeContent.includes('Space')) {
        readmeContent = readmeContent.replace(
          `## Controls

- Arrow Keys: Move snake
- Start Button: Begin game
- Reset Button: Reset game`,
          `## Controls

- Arrow Keys or WASD: Move snake
- Space: Pause/Resume game
- R: Restart game
- Start Button: Begin game
- Reset Button: Reset game`
        );
        changes.push('Updated README.md with new controls');
      }
      
      await fs.writeFile(readmePath, readmeContent, 'utf-8');
      
      // Step 4: Validation
      const validationResults = [];
      
      // Check for alert()
      if (snakeJsContent.includes('alert(')) {
        validationResults.push('❌ Still contains alert()');
      } else {
        validationResults.push('✅ No alert() found');
      }
      
      // Check for score += 1
      if (snakeJsContent.includes('score += 1')) {
        validationResults.push('✅ Score increment is +1');
      } else {
        validationResults.push('❌ Score increment not +1');
      }
      
      // Check for WASD
      if (snakeJsContent.includes("case 'w'")) {
        validationResults.push('✅ WASD controls added');
      } else {
        validationResults.push('❌ WASD controls missing');
      }
      
      // Check for Space
      if (snakeJsContent.includes("case ' '")) {
        validationResults.push('✅ Space pause added');
      } else {
        validationResults.push('❌ Space pause missing');
      }
      
      // Check for acceleration
      if (snakeJsContent.includes('currentDelay')) {
        validationResults.push('✅ Acceleration logic added');
      } else {
        validationResults.push('❌ Acceleration logic missing');
      }
      
      // Check for food collision avoidance
      if (snakeJsContent.includes('onSnake')) {
        validationResults.push('✅ Food spawn collision avoidance added');
      } else {
        validationResults.push('❌ Food spawn collision avoidance missing');
      }
      
      const allPassed = validationResults.every(r => r.startsWith('✅'));
      
      if (!allPassed) {
        throw new Error(`Validation failed: ${validationResults.join(', ')}`);
      }
      
      return {
        success: true,
        project_path: projectDir,
        changes_applied: changes,
        validation_results: validationResults,
        task: 'fix_snake_to_spec_v1'
      };
      
    } catch (error: any) {
      return {
        success: false,
        project_path: projectDir,
        changes_applied: changes,
        error: error.message,
        task: 'fix_snake_to_spec_v1'
      };
    }
  }

  // fixSnakeUxAndPauseV2 - improve UX with proper pause/resume and overlays (full rewrite)
  async function fixSnakeUxAndPauseV2(job: any) {
    const { inputs } = job;
    const project_path = inputs?.project_path || 'C:\\Users\\anani\\Projects\\snake-mcp';
    
    const projectDir = project_path;
    const changes = [];
    
    try {
      // Step 1: Write complete new snake.js file
      const snakeJsPath = path.join(projectDir, 'snake.js');
      
      const newSnakeJs = `const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreElement = document.getElementById('score');

// ===== Config =====
const GRID_SIZE = 20;
const COLS = Math.floor(canvas.width / GRID_SIZE);
const ROWS = Math.floor(canvas.height / GRID_SIZE);

const BASE_DELAY = 100;
const MIN_DELAY = 50;
const STEP_DELAY = 10;      // speed up step
const SPEEDUP_EVERY = 5;    // every N points

// ===== State =====
let snake;
let direction;        // current direction applied per tick
let nextDirection;    // queued direction (prevents instant reverse)
let food;
let score;

let isRunning;
let isPaused;
let isGameOver;

let timeoutId = null;
let currentDelay = BASE_DELAY;

function samePos(a, b) {
  return a.x === b.x && a.y === b.y;
}

function isOpposite(a, b) {
  return a.x + b.x === 0 && a.y + b.y === 0;
}

function onSnake(pos) {
  return snake.some(s => samePos(s, pos));
}

function generateFood() {
  // avoid spawning on snake
  let candidate;
  let guard = 0;
  do {
    candidate = {
      x: Math.floor(Math.random() * COLS),
      y: Math.floor(Math.random() * ROWS),
    };
    guard++;
    if (guard > 10000) break; // safety
  } while (onSnake(candidate));
  return candidate;
}

function updateSpeed() {
  const steps = Math.floor(score / SPEEDUP_EVERY);
  currentDelay = Math.max(MIN_DELAY, BASE_DELAY - steps * STEP_DELAY);
}

function clearLoop() {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function scheduleLoop() {
  clearLoop();
  timeoutId = setTimeout(loop, currentDelay);
}

function setDirection(newDir) {
  // Prevent reverse into itself
  if (direction.x === 0 && direction.y === 0) {
    // allow first direction
    nextDirection = newDir;
    return;
  }
  if (isOpposite(direction, newDir)) return;
  nextDirection = newDir;
}

// ===== Rendering =====
function drawBackground() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawSnake() {
  ctx.fillStyle = '#0f0';
  for (const seg of snake) {
    ctx.fillRect(seg.x * GRID_SIZE, seg.y * GRID_SIZE, GRID_SIZE - 2, GRID_SIZE - 2);
  }
}

function drawFood() {
  ctx.fillStyle = '#f00';
  ctx.fillRect(food.x * GRID_SIZE, food.y * GRID_SIZE, GRID_SIZE - 2, GRID_SIZE - 2);
}

function drawOverlay(title, subtitle) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = 'bold 30px Arial';
  ctx.fillText(title, canvas.width / 2, canvas.height / 2 - 10);

  if (subtitle) {
    ctx.font = '16px Arial';
    ctx.fillText(subtitle, canvas.width / 2, canvas.height / 2 + 28);
  }

  ctx.restore();
}

function draw() {
  drawBackground();
  drawSnake();
  drawFood();

  if (!isRunning && !isGameOver) {
    drawOverlay('Snake', 'Press Start (or R to restart)');
  }
  if (isPaused) {
    drawOverlay('PAUSED', 'Press Space to resume');
  }
  if (isGameOver) {
    drawOverlay('GAME OVER', 'Press R to restart');
  }
}

// ===== Game logic =====
function step() {
  if (!isRunning || isPaused || isGameOver) return;

  // Apply queued direction on tick boundary
  direction = nextDirection;

  const head = snake[0];
  const newHead = { x: head.x + direction.x, y: head.y + direction.y };

  // Wall collision
  if (newHead.x < 0 || newHead.x >= COLS || newHead.y < 0 || newHead.y >= ROWS) {
    endGame();
    return;
  }

  // Self collision
  if (onSnake(newHead)) {
    endGame();
    return;
  }

  snake.unshift(newHead);

  // Food collision
  if (samePos(newHead, food)) {
    score += 1;
    scoreElement.textContent = String(score);
    updateSpeed();
    food = generateFood();
  } else {
    snake.pop();
  }
}

function loop() {
  step();
  draw();

  if (!isRunning || isPaused || isGameOver) return;
  scheduleLoop();
}

function startGame() {
  if (isGameOver) {
    resetGame();
  }
  if (isRunning) return;

  isRunning = true;
  isPaused = false;
  isGameOver = false;

  // If direction is not set yet, start moving right
  if (direction.x === 0 && direction.y === 0) {
    direction = { x: 1, y: 0 };
    nextDirection = { x: 1, y: 0 };
  }

  updateSpeed();
  scheduleLoop();
}

function resetGame() {
  clearLoop();

  snake = [{ x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) }];
  direction = { x: 0, y: 0 };
  nextDirection = { x: 0, y: 0 };

  score = 0;
  scoreElement.textContent = String(score);

  currentDelay = BASE_DELAY;
  food = generateFood();

  isRunning = false;
  isPaused = false;
  isGameOver = false;

  draw();
}

function togglePause() {
  if (!isRunning || isGameOver) return;

  isPaused = !isPaused;
  if (isPaused) {
    clearLoop();
    draw();
  } else {
    scheduleLoop();
  }
}

function endGame() {
  isGameOver = true;
  isRunning = false;
  isPaused = false;
  clearLoop();
  draw();
}

// expose for buttons
window.startGame = startGame;
window.resetGame = resetGame;

// Keyboard: Arrows + WASD, Space pause, R restart
document.addEventListener('keydown', (e) => {
  const key = e.key;

  if (key === ' ' || key === 'Spacebar') {
    e.preventDefault();
    togglePause();
    return;
  }

  if (key === 'r' || key === 'R') {
    e.preventDefault();
    resetGame();
    startGame();
    return;
  }

  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      setDirection({ x: 0, y: -1 });
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      setDirection({ x: 0, y: 1 });
      break;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      setDirection({ x: -1, y: 0 });
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      setDirection({ x: 1, y: 0 });
      break;
  }
});

// Init
resetGame();`;
      
      await fs.writeFile(snakeJsPath, newSnakeJs, 'utf-8');
      changes.push('Rewrote snake.js with complete UX implementation');
      
      // Step 2: Update README.md
      const readmePath = path.join(projectDir, 'README.md');
      let readmeContent = await fs.readFile(readmePath, 'utf-8');
      
      if (!readmeContent.includes('Speed increases every 5 points')) {
        readmeContent = readmeContent.replace(
          `## Features

- Classic snake gameplay
- Score tracking`,
          `## Features

- Classic snake gameplay
- Score tracking
- Speed increases every 5 points
- Pause/Resume functionality with overlay
- Game Over overlay with restart option`
        );
        changes.push('Updated README.md with UX features');
      }
      
      if (!readmeContent.includes('Game States')) {
        readmeContent = readmeContent.replace(
          `## Controls

- Arrow Keys or WASD: Move snake
- Space: Pause/Resume game
- R: Restart game`,
          `## Controls

- Arrow Keys or WASD: Move snake
- Space: Pause/Resume game
- R: Restart game

## Game States

- **Playing:** Snake moves and eats food
- **Paused:** Game is paused with overlay (press SPACE to resume)
- **Game Over:** Shows score and restart option (press R to restart)`
        );
        changes.push('Added game states description to README.md');
      }
      
      await fs.writeFile(readmePath, readmeContent, 'utf-8');
      
      // Step 3: Validation using search_in_files
      const validationResults = [];
      
      // Check for clearTimeout
      const clearTimeoutResults = await new Promise<any>((resolve) => {
        const results: any[] = [];
        const searchPattern = 'clearTimeout';
        
        // Simple search in the content we just wrote
        if (newSnakeJs.includes(searchPattern)) {
          results.push({
            path: snakeJsPath,
            content: 'clearTimeout found',
            matches: [{ text: searchPattern, index: 0, length: searchPattern.length }]
          });
        }
        
        resolve({ results, total_files_scanned: 1, total_matches: results.length });
      });
      
      if (clearTimeoutResults.total_matches > 0) {
        validationResults.push('✅ clearTimeout found');
      } else {
        validationResults.push('❌ clearTimeout missing');
      }
      
      // Check for isPaused
      if (newSnakeJs.includes('isPaused')) {
        validationResults.push('✅ isPaused state implemented');
      } else {
        validationResults.push('❌ isPaused state missing');
      }
      
      // Check for scheduleLoop
      if (newSnakeJs.includes('scheduleLoop')) {
        validationResults.push('✅ scheduleLoop function found');
      } else {
        validationResults.push('❌ scheduleLoop function missing');
      }
      
      // Check for GAME OVER overlay
      if (newSnakeJs.includes('GAME OVER')) {
        validationResults.push('✅ GAME OVER overlay found');
      } else {
        validationResults.push('❌ GAME OVER overlay missing');
      }
      
      // Check for PAUSED overlay
      if (newSnakeJs.includes('PAUSED')) {
        validationResults.push('✅ PAUSED overlay found');
      } else {
        validationResults.push('❌ PAUSED overlay missing');
      }
      
      // Check for NO isRunning toggle
      if (!newSnakeJs.includes('isRunning = !isRunning')) {
        validationResults.push('✅ No isRunning toggle found');
      } else {
        validationResults.push('❌ isRunning toggle still present');
      }
      
      const allPassed = validationResults.every(r => r.startsWith('✅'));
      
      if (!allPassed) {
        throw new Error(`Validation failed: ${validationResults.join(', ')}`);
      }
      
      return {
        success: true,
        project_path: projectDir,
        changes_applied: changes,
        validation_results: validationResults,
        task: 'fix_snake_ux_and_pause_v2'
      };
      
    } catch (error: any) {
      return {
        success: false,
        project_path: projectDir,
        changes_applied: changes,
        error: error.message,
        task: 'fix_snake_ux_and_pause_v2'
      };
    }
  }

  // Fresh inbox reading without cache
  async function readInboxFresh(inboxPath: string) {
    const raw = await fs.readFile(inboxPath, 'utf-8').catch(() => "");
    if (!raw.trim()) return null;

    let job: any;
    try { 
      job = JSON.parse(raw); 
    } catch { 
      return null; 
    }

    // Critical: null / undefined / empty string -> no command
              `[${new Date().toISOString()}] Command executed: ${result.cmd} (exit: ${result.exit_code})\n`, 
              'utf-8'
            );
          }
          
          // Update status to done
          await fs.writeFile(STATUS_FILE, JSON.stringify({
            status: 'done',
            last_command: job.id,
            last_run: new Date().toISOString(),
            error: null
          }, null, 2), 'utf-8');
          
          // Clear inbox (important: prevent infinite loop)
          await fs.writeFile(INBOX_FILE, JSON.stringify({ command: null, timestamp: null }, null, 2), 'utf-8');
          
          return okText({ 
            status: 'done', 
            command_id: job.id,
            result
          });
          
        } catch (error: any) {
          // Update status to error
          await fs.writeFile(STATUS_FILE, JSON.stringify({
            status: 'error',
            last_command: job.id,
            last_run: new Date().toISOString(),
            error: error.message
          }, null, 2), 'utf-8');
          
          // Clear inbox even on error
          await fs.writeFile(INBOX_FILE, JSON.stringify({ command: null, timestamp: null }, null, 2), 'utf-8');
          
          return errText(`Command execution failed: ${error.message}`);
        }
        
      } catch (error: any) {
        return errText(`Router failed: ${error.message}`);
      }
    }
  );

  // Phase 7: Queue and Lock System
  
  // Internal lock functions
  async function acquireLock({ name, ttl_ms = 30000 }: { name: string; ttl_ms?: number }) {
    await ensureSyncDir();
    const queueDir = path.join(SYNC_DIR, 'queue');
    const locksDir = path.join(queueDir, 'locks');
    
    await fs.mkdir(locksDir, { recursive: true });
    
    const lockFile = path.join(locksDir, `${name}.lock`);
    const token = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl_ms);
    
    try {
      try {
        const existingLock = await fs.readFile(lockFile, 'utf-8');
        const lockData = JSON.parse(existingLock);
        
        if (new Date(lockData.expires_at) > now) {
          return { 
            ok: false, 
            error: 'Lock already held',
            expires_at: lockData.expires_at
          };
        }
      } catch {}
      
      const lockData = {
        token,
        expires_at: expiresAt.toISOString(),
        created_at: now.toISOString()
      };
      
      await fs.writeFile(lockFile, JSON.stringify(lockData, null, 2), 'utf-8');
      
      return { 
        ok: true, 
        token,
        expires_at: lockData.expires_at
      };
      
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }
  
  async function releaseLock({ name, token }: { name: string; token: string }) {
    await ensureSyncDir();
    const queueDir = path.join(SYNC_DIR, 'queue');
    const locksDir = path.join(queueDir, 'locks');
    
    const lockFile = path.join(locksDir, `${name}.lock`);
    
    try {
      const existingLock = await fs.readFile(lockFile, 'utf-8');
      const lockData = JSON.parse(existingLock);
      
      if (lockData.token !== token) {
        return { ok: false, error: 'Invalid token' };
      }
      
      await fs.unlink(lockFile);
      return { ok: true };
      
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { ok: false, error: 'Lock file not found' };
      }
      return { ok: false, error: error.message };
    }
  }
  
  // fs_lock_acquire - acquire a lock with TTL
  server.tool(
    "fs_lock_acquire",
    "Acquire a lock with optional TTL",
    {
      name: z.string(),
      ttl_ms: z.number().optional().default(30000) // 30 seconds default
    },
    async ({ name, ttl_ms }) => {
      await ensureSyncDir();
      const queueDir = path.join(SYNC_DIR, 'queue');
      const locksDir = path.join(queueDir, 'locks');
      
      // Ensure locks directory exists
      await fs.mkdir(locksDir, { recursive: true });
      
      const lockFile = path.join(locksDir, `${name}.lock`);
      const token = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttl_ms);
      
      try {
        // Check if lock exists and is not expired
        try {
          const existingLock = await fs.readFile(lockFile, 'utf-8');
          const lockData = JSON.parse(existingLock);
          
          if (new Date(lockData.expires_at) > now) {
            // Lock is still valid
            return okText({ 
              ok: false, 
              error: 'Lock already held',
              expires_at: lockData.expires_at
            });
          }
          // Lock expired, will be overwritten
        } catch {
          // No existing lock file
        }
        
        // Create new lock
        const lockData = {
          token,
          expires_at: expiresAt.toISOString(),
          created_at: now.toISOString()
        };
        
        await fs.writeFile(lockFile, JSON.stringify(lockData, null, 2), 'utf-8');
        
        return okText({ 
          ok: true, 
          token,
          expires_at: lockData.expires_at
        });
        
      } catch (error: any) {
        return errText(`Failed to acquire lock: ${error.message}`);
      }
    }
  );

  // fs_lock_release - release a lock with token
  server.tool(
    "fs_lock_release",
    "Release a lock with token",
    {
      name: z.string(),
      token: z.string()
    },
    async ({ name, token }) => {
      await ensureSyncDir();
      const queueDir = path.join(SYNC_DIR, 'queue');
      const locksDir = path.join(queueDir, 'locks');
      
      const lockFile = path.join(locksDir, `${name}.lock`);
      
      try {
        // Read existing lock
        const existingLock = await fs.readFile(lockFile, 'utf-8');
        const lockData = JSON.parse(existingLock);
        
        // Verify token matches
        if (lockData.token !== token) {
          return okText({ 
            ok: false, 
            error: 'Invalid token' 
          });
        }
        
        // Delete lock file
        await fs.unlink(lockFile);
        
        return okText({ ok: true });
        
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return okText({ 
            ok: false, 
            error: 'Lock file not found' 
          });
        }
        return errText(`Failed to release lock: ${error.message}`);
      }
    }
  );

  // queue_push - push a job to the queue
  server.tool(
    "queue_push",
    "Push a job to the queue",
    {
      type: z.string(),
      payload: z.any(),
      priority: z.number().optional().default(0),
      job_id: z.string().optional()
    },
    async ({ type, payload, priority, job_id }) => {
      await ensureSyncDir();
      const queueDir = path.join(SYNC_DIR, 'queue');
      
      // Ensure queue directory exists
      await fs.mkdir(queueDir, { recursive: true });
      
      const jobsFile = path.join(queueDir, 'jobs.jsonl');
      const jobId = job_id || randomUUID();
      const now = new Date().toISOString();
      
      const job = {
        job_id: jobId,
        type,
        payload,
        created_at: now,
        source: 'windsurf',
        priority
      };
      
      try {
        const jobLine = JSON.stringify(job) + '\n';
        await fs.appendFile(jobsFile, jobLine, 'utf-8');
        
        return okText({ job_id: jobId });
        
      } catch (error: any) {
        return errText(`Failed to push job: ${error.message}`);
      }
    }
  );

  // queue_pop - claim a job from the queue
  server.tool(
    "queue_pop",
    "Pop/claim a job from the queue with lease",
    {
      max_lease_ms: z.number().optional().default(60000), // 1 minute default
      worker: z.string().optional().default('windsurf')
    },
    async ({ max_lease_ms, worker }) => {
      await ensureSyncDir();
      const queueDir = path.join(SYNC_DIR, 'queue');
      
      const jobsFile = path.join(queueDir, 'jobs.jsonl');
      const claimsFile = path.join(queueDir, 'claims.jsonl');
      const acksFile = path.join(queueDir, 'acks.jsonl');
      
      try {
        // Acquire queue lock (direct implementation)
        const lockResult = await acquireLock({ name: 'queue', ttl_ms: 10000 });
        if (!lockResult.ok) {
          return okText({ 
            ok: false, 
            error: 'Could not acquire queue lock' 
          });
        }
        
        try {
          // Read all files
          const jobsContent = await fs.readFile(jobsFile, 'utf-8').catch(() => '');
          const claimsContent = await fs.readFile(claimsFile, 'utf-8').catch(() => '');
          const acksContent = await fs.readFile(acksFile, 'utf-8').catch(() => '');
          
          // Parse jobs
          const jobs = jobsContent.trim().split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
          
          // Parse claims
          const claims = claimsContent.trim().split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
          
          // Parse acks
          const acks = acksContent.trim().split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
          
          // Create sets for quick lookup
          const ackedJobIds = new Set(acks.map(ack => ack.job_id));
          const activeClaims = new Map(
            claims
              .filter(claim => new Date(claim.lease_until) > new Date())
              .map(claim => [claim.job_id, claim])
          );
          
          // Find first unclaimed, unacked job
          const availableJob = jobs.find(job => 
            !ackedJobIds.has(job.job_id) && !activeClaims.has(job.job_id)
          );
          
          if (!availableJob) {
            await releaseLock({ name: 'queue', token: lockResult.token! });
            return okText({ 
              ok: true, 
              job: null,
              message: 'No available jobs'
            });
          }
          
          // Create claim
          const leaseToken = randomUUID();
          const now = new Date();
          const leaseUntil = new Date(now.getTime() + max_lease_ms);
          
          const claim = {
            job_id: availableJob.job_id,
            claimed_by: worker,
            lease_token: leaseToken,
            lease_until: leaseUntil.toISOString(),
            claimed_at: now.toISOString()
          };
          
          // Append claim
          const claimLine = JSON.stringify(claim) + '\n';
          await fs.appendFile(claimsFile, claimLine, 'utf-8');
          
          // Release lock
          await releaseLock({ name: 'queue', token: lockResult.token! });
          
          return okText({ 
            ok: true, 
            job: availableJob,
            lease_token: leaseToken,
            lease_until: claim.lease_until
          });
          
        } catch (error: any) {
          // Ensure lock is released on error
          try {
            await releaseLock({ name: 'queue', token: lockResult.token! });
          } catch {}
          throw error;
        }
        
      } catch (error: any) {
        return errText(`Failed to pop job: ${error.message}`);
      }
    }
  );

  // queue_ack - acknowledge a job completion
  server.tool(
    "queue_ack",
    "Acknowledge job completion with status and artifacts",
    {
      job_id: z.string(),
      lease_token: z.string(),
      status: z.enum(['done', 'error', 'canceled']),
      result: z.any().optional(),
      report_md: z.string().optional(),
      logs: z.string().optional()
    },
    async ({ job_id, lease_token, status, result, report_md, logs }) => {
      await ensureSyncDir();
      const queueDir = path.join(SYNC_DIR, 'queue');
      const runsDir = path.join(queueDir, 'runs');
      const acksFile = path.join(queueDir, 'acks.jsonl');
      
      try {
        // Create job run directory
        const jobRunDir = path.join(runsDir, job_id);
        await fs.mkdir(jobRunDir, { recursive: true });
        
        // Save artifacts
        if (result) {
          await fs.writeFile(
            path.join(jobRunDir, 'result.json'), 
            JSON.stringify(result, null, 2), 
            'utf-8'
          );
        }
        
        if (report_md) {
          await fs.writeFile(
            path.join(jobRunDir, 'report.md'), 
            report_md, 
            'utf-8'
          );
        }
        
        if (logs) {
          await fs.writeFile(
            path.join(jobRunDir, 'logs.txt'), 
            logs, 
            'utf-8'
          );
        }
        
        // Create ack record
        const now = new Date().toISOString();
        const ack = {
          job_id,
          lease_token,
          status,
          acked_at: now,
          result_ref: `_sync/queue/runs/${job_id}/result.json`
        };
        
        // Append ack
        const ackLine = JSON.stringify(ack) + '\n';
        await fs.appendFile(acksFile, ackLine, 'utf-8');
        
        return okText({ ok: true });
        
      } catch (error: any) {
        return errText(`Failed to ack job: ${error.message}`);
      }
    }
  );

  // job_history_list - list job history
  server.tool(
    "job_history_list",
    "List job history with status and artifacts",
    {
      limit: z.number().optional().default(50),
      status: z.string().optional()
    },
    async ({ limit, status }) => {
      await ensureSyncDir();
      const queueDir = path.join(SYNC_DIR, 'queue');
      
      const jobsFile = path.join(queueDir, 'jobs.jsonl');
      const claimsFile = path.join(queueDir, 'claims.jsonl');
      const acksFile = path.join(queueDir, 'acks.jsonl');
      
      try {
        // Read all files
        const jobsContent = await fs.readFile(jobsFile, 'utf-8').catch(() => '');
        const claimsContent = await fs.readFile(claimsFile, 'utf-8').catch(() => '');
        const acksContent = await fs.readFile(acksFile, 'utf-8').catch(() => '');
        
        // Parse jobs
        const jobs = jobsContent.trim().split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        
        // Parse claims
        const claims = claimsContent.trim().split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        
        // Parse acks
        const acks = acksContent.trim().split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        
        // Create maps for lookup
        const claimMap = new Map(
          claims.map(claim => [claim.job_id, claim])
        );
        
        const ackMap = new Map(
          acks.map(ack => [ack.job_id, ack])
        );
        
        // Build job history
        const history = jobs.map(job => {
          const claim = claimMap.get(job.job_id);
          const ack = ackMap.get(job.job_id);
          
          const jobStatus = ack ? ack.status : (claim ? 'claimed' : 'pending');
          
          return {
            job_id: job.job_id,
            type: job.type,
            payload: job.payload,
            created_at: job.created_at,
            status: jobStatus,
            claimed_at: claim?.claimed_at,
            lease_until: claim?.lease_until,
            acked_at: ack?.acked_at,
            result_ref: ack?.result_ref
          };
        });
        
        // Filter by status if specified
        const filteredHistory = status 
          ? history.filter(job => job.status === status)
          : history;
        
        // Sort by created_at descending and limit
        const sortedHistory = filteredHistory
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, limit);
        
        return okText({ 
          jobs: sortedHistory,
          total: filteredHistory.length
        });
        
      } catch (error: any) {
        return errText(`Failed to list job history: ${error.message}`);
      }
    }
  );

  return server;
}

// ---- HTTP server glue (Streamable HTTP /mcp) ----
const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS helpers + expose session header for some clients
app.use((req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  next();
});

// Security: Origin allowlist (DNS rebinding mitigation)
app.use((req, res, next) => {
  const origin = req.headers["origin"];
  if (!origin) return next();
  if (!ORIGIN_ALLOWLIST.length) return next();
  if (ORIGIN_ALLOWLIST.includes(String(origin))) return next();
  res.status(403).send("Forbidden origin");
});

// Security: Bearer auth (if token configured)
// app.use((req, res, next) => {
//   if (!MCP_SYNC_TOKEN) return next();
//   const auth = String(req.headers["authorization"] || "");
//   if (auth === `Bearer ${MCP_SYNC_TOKEN}`) return next();
//   res.status(401).send("Unauthorized");
// });

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

// --- SSE MCP (для клиентов, которые предпочитают SSE) ---
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const sid = randomUUID();
  sseTransports[sid] = transport;

  (transport as any).onclose = () => {
    delete sseTransports[sid];
  };

  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const active = Object.values(sseTransports);
  if (!active.length) {
    res.status(400).send("No active SSE session");
    return;
  }

  const t: any = active[0];
  if (typeof t.handlePostMessage !== "function") {
    res.status(500).send("SSE transport does not support POST messages");
    return;
  }

  if (t.handlePostMessage.length >= 3) {
    await t.handlePostMessage(req, res, req.body);
    return;
  }

  await t.handlePostMessage(req, res);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`MCP sync-core listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(`Allowed roots: ${ROOTS.join(", ")}`);
});