import * as fs from "node:fs/promises";
import * as path from "node:path";

import { okText, errText } from "./index.js";
import { SYNC_DIR } from "./config.js";

const INBOX_FILE = path.join(SYNC_DIR, "inbox_command.json");
const STATUS_FILE = path.join(SYNC_DIR, "status.json");
const REPORT_FILE = path.join(SYNC_DIR, "last_report.md");
const LOGS_FILE = path.join(SYNC_DIR, "last_logs.txt");

async function ensureSyncDir() {
  try {
    await fs.mkdir(SYNC_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

export async function protocolInit() {
  await ensureSyncDir();
  try {
    await fs.writeFile(
      INBOX_FILE,
      JSON.stringify({ command: null, timestamp: null }, null, 2),
      "utf-8"
    );

    await fs.writeFile(
      STATUS_FILE,
      JSON.stringify(
        { status: "idle", last_command: null, last_run: null, error: null },
        null,
        2
      ),
      "utf-8"
    );

    await fs.writeFile(
      REPORT_FILE,
      "# MCP Sync Protocol Report\n\nNo reports yet.\n",
      "utf-8"
    );

    await fs.writeFile(LOGS_FILE, "", "utf-8");

    return okText({
      initialized: true,
      files: {
        inbox_command: INBOX_FILE,
        status: STATUS_FILE,
        last_report: REPORT_FILE,
        last_logs: LOGS_FILE,
      },
    });
  } catch (error: any) {
    return errText(`Failed to initialize protocol: ${error?.message ?? String(error)}`);
  }
}

export async function protocolWriteCommand(command: string) {
  await ensureSyncDir();
  try {
    const timestamp = new Date().toISOString();
    let commandData: any;

    const tryParseEnvelope = (raw: string): any | null => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.command === "string") {
          return parsed;
        }
      } catch {
        // ignore
      }
      return null;
    };

    try {
      let parsed = tryParseEnvelope(command);

      // Support escaped JSON payloads like: {\"id\":\"...\",\"command\":\"sync_status\"}
      if (!parsed && command.includes("\\\"")) {
        const unescaped = command.replace(/\\"/g, "\"");
        parsed = tryParseEnvelope(unescaped);
      }

      if (parsed) {
        commandData = {
          id: typeof parsed.id === "string" && parsed.id.trim()
            ? parsed.id
            : `protocol-${Date.now()}`,
          ...parsed,
          timestamp,
        };
      } else {
        commandData = {
          id: `protocol-${Date.now()}`,
          command,
          timestamp,
        };
      }
    } catch {
      commandData = {
        id: `protocol-${Date.now()}`,
        command,
        timestamp,
      };
    }

    await fs.writeFile(INBOX_FILE, JSON.stringify(commandData, null, 2), "utf-8");

    return okText({
      written: true,
      command: commandData.command,
      command_id: commandData.id,
      timestamp: commandData.timestamp,
      file: INBOX_FILE,
    });
  } catch (error: any) {
    return errText(`Failed to write command: ${error?.message ?? String(error)}`);
  }
}

export async function protocolReadCommand() {
  try {
    const content = await fs.readFile(INBOX_FILE, "utf-8");
    const commandData = JSON.parse(content);

    return okText({
      command: commandData.command,
      timestamp: commandData.timestamp,
      file: INBOX_FILE,
    });
  } catch (error: any) {
    return errText(`Failed to read command: ${error?.message ?? String(error)}`);
  }
}

export async function protocolUpdateStatus(status: "idle" | "running" | "done" | "error", error?: string) {
  await ensureSyncDir();
  try {
    let currentStatus: any = { last_command: null, last_run: null };

    try {
      const content = await fs.readFile(STATUS_FILE, "utf-8");
      currentStatus = JSON.parse(content);
    } catch {
      // ignore
    }

    const statusData = {
      status,
      last_command: currentStatus.last_command ?? null,
      last_run: new Date().toISOString(),
      error: error || null,
    };

    await fs.writeFile(STATUS_FILE, JSON.stringify(statusData, null, 2), "utf-8");

    return okText({
      updated: true,
      status,
      timestamp: statusData.last_run,
      file: STATUS_FILE,
    });
  } catch (e: any) {
    return errText(`Failed to update status: ${e?.message ?? String(e)}`);
  }
}

export async function protocolWriteReport(title: string, content: string) {
  await ensureSyncDir();
  try {
    const timestamp = new Date().toISOString();
    const report = `# ${title}\n\n*Generated: ${timestamp}*\n\n${content}`;

    await fs.writeFile(REPORT_FILE, report, "utf-8");

    return okText({
      written: true,
      title,
      timestamp,
      file: REPORT_FILE,
    });
  } catch (e: any) {
    return errText(`Failed to write report: ${e?.message ?? String(e)}`);
  }
}

export async function protocolWriteLogs(logs: string) {
  await ensureSyncDir();
  try {
    const timestamp = new Date().toISOString();
    const logContent = `=== Logs from ${timestamp} ===\n${logs}\n\n`;

    await fs.appendFile(LOGS_FILE, logContent, "utf-8");

    return okText({
      written: true,
      timestamp,
      file: LOGS_FILE,
    });
  } catch (e: any) {
    return errText(`Failed to write logs: ${e?.message ?? String(e)}`);
  }
}
