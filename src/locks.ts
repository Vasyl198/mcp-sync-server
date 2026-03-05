import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

type LockFile = {
  token: string;
  expires_at: string; // ISO
  created_at: string; // ISO
  name: string;
};

const LOCK_STALE_MS = 60_000;

function isoNow() {
  return new Date().toISOString();
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function fileExists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readLockFile(lockPath: string): Promise<LockFile | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw) as LockFile;
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function unlinkOrStaleRename(lockPath: string): Promise<boolean> {
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (e: any) {
    if (e?.code === "ENOENT") return true;
    if (e?.code !== "EPERM" && e?.code !== "EACCES") return false;
  }
  try {
    const stalePath = `${lockPath}.stale.${Date.now()}.${randomUUID()}`;
    await fs.rename(lockPath, stalePath);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(opts: {
  locksDir: string;
  name: string;
  ttl_ms?: number;
}): Promise<{ ok: boolean; token?: string; expires_at?: string; reason?: string }> {
  const ttl = Math.max(1000, opts.ttl_ms ?? 30_000);
  await fs.mkdir(opts.locksDir, { recursive: true });

  const lockPath = path.join(opts.locksDir, `${safeName(opts.name)}.lock.json`);
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + ttl).toISOString();

  // Try create exclusive
  try {
    const fh = await fs.open(lockPath, "wx");
    try {
      const body: LockFile = {
        token,
        expires_at: expiresAt,
        created_at: isoNow(),
        name: opts.name,
      };
      await fh.writeFile(JSON.stringify(body, null, 2), "utf8");
    } finally {
      await fh.close();
    }
    return { ok: true, token, expires_at: expiresAt };
  } catch (e: any) {
    if (e?.code !== "EEXIST") {
      return { ok: false, reason: `lock_create_failed:${String(e?.message ?? e)}` };
    }
  }

  // Exists: check expiry
  const existing = await readLockFile(lockPath);
  if (!existing) {
    // Corrupt lock: remove and retry once
    await unlinkOrStaleRename(lockPath);
  } else {
    const expired = Date.parse(existing.expires_at) <= Date.now();
    const staleByAge = Date.now() - Date.parse(existing.created_at) > LOCK_STALE_MS;
    if (!expired && !staleByAge) {
      return { ok: false, reason: "locked", expires_at: existing.expires_at };
    }
    // Expired: remove and retry once
    await unlinkOrStaleRename(lockPath);
  }

  // Retry once
  if (await fileExists(lockPath)) {
    return { ok: false, reason: "locked" };
  }

  try {
    const fh = await fs.open(lockPath, "wx");
    try {
      const body: LockFile = {
        token,
        expires_at: expiresAt,
        created_at: isoNow(),
        name: opts.name,
      };
      await fh.writeFile(JSON.stringify(body, null, 2), "utf8");
    } finally {
      await fh.close();
    }
    return { ok: true, token, expires_at: expiresAt };
  } catch (e: any) {
    return { ok: false, reason: `lock_retry_failed:${String(e?.message ?? e)}` };
  }
}

export async function releaseLock(opts: {
  locksDir: string;
  name: string;
  token: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const lockPath = path.join(opts.locksDir, `${safeName(opts.name)}.lock.json`);
  const existing = await readLockFile(lockPath);
  if (!existing) {
    return { ok: true };
  }

  const expired = Date.parse(existing.expires_at) <= Date.now();
  const tokenMatches = existing.token === opts.token;

  if (!expired && !tokenMatches) {
    return { ok: false, reason: "token_mismatch" };
  }

  for (let i = 0; i < 4; i++) {
    const ok = await unlinkOrStaleRename(lockPath);
    if (ok) return { ok: true };
    await sleep(25 * (i + 1));
  }
  // Best-effort release on Windows file locking quirks.
  return { ok: true, reason: "best_effort_release_failed" };
}
