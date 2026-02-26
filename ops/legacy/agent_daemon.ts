// LEGACY FILE (kept for reference)
//
// This was an early file-based task daemon prototype.
// It is NOT used by the current MCP server pipeline (queue_* + task_graph + orchestrator_tick).
//
// Original location: src/agent/agent_daemon.ts
// Reason moved: reduces confusion; avoids accidental execution against ../_sync.
//

import { setTimeout } from "timers/promises";
import { promises as fs } from "node:fs";
import path from "node:path";

// Simple file-based daemon that monitors and processes tasks
const SYNC_DIR = path.resolve(process.cwd(), "../_sync");
const TASKS_FILE = path.join(SYNC_DIR, "tasks.json");
const QUEUE_FILE = path.join(SYNC_DIR, "queue.json");
const STATUS_FILE = path.join(SYNC_DIR, "daemon_status.json");

interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done";
  created_at: string;
  updated_at: string;
}

interface QueueItem {
  id: string;
  type: string;
  taskId: string;
  title: string;
  description: string;
  added_at: string;
}

// Simple file operations
async function readTasks(): Promise<Task[]> {
  try {
    const content = await fs.readFile(TASKS_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function writeTasks(tasks: Task[]): Promise<void> {
  await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

async function readQueue(): Promise<QueueItem[]> {
  try {
    const content = await fs.readFile(QUEUE_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueueItem[]): Promise<void> {
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

async function updateStatus(status: any): Promise<void> {
  await fs.writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        ...status,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

// Simple exec simulation
async function simulateExec(cmd: string, args: string[] = []): Promise<any> {
  console.log(`🔧 Executing: ${cmd} ${args.join(" ")}`);

  // Simulate different commands
  if (cmd === "taskkill" && args.includes("cloudflared.exe")) {
    console.log("✅ Simulated: cloudflared.exe killed");
    return { success: true, stdout: "SUCCESS", stderr: "", exit_code: 0 };
  }

  if (cmd === "npm" && args.includes("start")) {
    console.log("✅ Simulated: npm start executed");
    return { success: true, stdout: "MCP Server started", stderr: "", exit_code: 0 };
  }

  return { success: true, stdout: `Executed ${cmd}`, stderr: "", exit_code: 0 };
}

// Process queue items
async function processQueue(queue: QueueItem[]): Promise<void> {
  const remaining: QueueItem[] = [];

  for (const item of queue) {
    try {
      console.log(`⚙️ Processing: ${item.title}`);

      // Simulate task execution
      await simulateExec("echo", [item.title]);

      // Update task status to done
      const tasks = await readTasks();
      const task = tasks.find((t) => t.id === item.taskId);
      if (task) {
        task.status = "done";
        task.updated_at = new Date().toISOString();
        await writeTasks(tasks);
        console.log(`✅ Task completed: ${task.title}`);
      }
    } catch (e: any) {
      console.error(`❌ Failed to process ${item.title}:`, e.message);
      remaining.push(item);
    }
  }

  if (remaining.length > 0) {
    await writeQueue(remaining);
  } else {
    await writeQueue([]);
  }
}

// Health check simulation
async function healthCheck(): Promise<{ errors: number; status: string }> {
  // Simulate health check
  const errors = Math.random() > 0.8 ? 5 : 0; // 20% chance of errors

  return {
    errors,
    status: errors > 3 ? "unhealthy" : "healthy",
  };
}

// Auto-recovery
async function autoRecovery(): Promise<void> {
  console.warn("⚠️ Auto-recovery triggered!");

  await simulateExec("taskkill", ["/F", "/IM", "cloudflared.exe"]);
  await simulateExec("npm", ["start"]);

  console.log("🔄 Auto-recovery completed");
}

// =======================
// CORE LOOP
// =======================

async function mainLoop() {
  console.log("🤖 Agent Daemon started (file-based mode)");

  // Ensure sync directory exists
  await fs.mkdir(SYNC_DIR, { recursive: true });

  while (true) {
    try {
      // 1. Get tasks
      const tasks = await readTasks();
      const todo = tasks.filter((t) => t.status === "todo");

      // 2. Push to queue
      if (todo.length) {
        const queue = await readQueue();

        for (const task of todo) {
          console.log("📌 Scheduling:", task.title);

          // Add to queue
          queue.push({
            id: `queue-${Date.now()}-${Math.random()}`,
            type: "task",
            taskId: task.id,
            title: task.title,
            description: task.description,
            added_at: new Date().toISOString(),
          });

          // Mark as in-progress
          task.status = "in_progress";
          task.updated_at = new Date().toISOString();
        }

        await writeTasks(tasks);
        await writeQueue(queue);
      }

      // 3. Process queue
      const queue = await readQueue();
      if (queue.length > 0) {
        await processQueue(queue);
      }

      // 4. Health check
      const health = await healthCheck();

      if (health.status === "unhealthy") {
        await autoRecovery();
      }

      // 5. Update status
      await updateStatus({
        daemon_running: true,
        tasks_total: tasks.length,
        tasks_todo: tasks.filter((t) => t.status === "todo").length,
        tasks_in_progress: tasks.filter((t) => t.status === "in_progress").length,
        tasks_done: tasks.filter((t) => t.status === "done").length,
        queue_size: (await readQueue()).length,
        health_status: health.status,
        errors_count: health.errors,
      });
    } catch (err) {
      console.error("🔥 Daemon error:", err);
    }

    // 10 sec sleep
    await setTimeout(10000);
  }
}

mainLoop();
