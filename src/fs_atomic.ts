import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRenameContentionError(error: any) {
  const code = String(error?.code ?? "");
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

type WriteLockHandle = {
  path: string;
  active: boolean;
};

async function acquireWriteLock(lockPath: string, retries: number, baseDelayMs: number): Promise<WriteLockHandle> {
  const staleMs = 60_000;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.writeFile(`${process.pid}:${Date.now()}`);
      await fh.close();
      return { path: lockPath, active: true };
    } catch (e: any) {
      const code = String(e?.code ?? "");
      if (code !== "EEXIST") {
        if (attempt === retries) throw e;
      } else {
        try {
          const st = await fs.stat(lockPath);
          if ((Date.now() - st.mtimeMs) > staleMs) {
            await fs.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {}
        if (attempt === retries) {
          const busyErr: any = new Error(`write lock busy:${path.basename(lockPath)}`);
          busyErr.code = "LOCK_BUSY";
          busyErr.retryable = true;
          throw busyErr;
        }
      }
      const backoff = Math.min(1_000, baseDelayMs * (2 ** Math.min(attempt, 6)));
      await sleep(backoff);
    }
  }
  return { path: lockPath, active: false };
}

async function releaseWriteLock(lock: WriteLockHandle) {
  if (!lock.active) return;
  await fs.unlink(lock.path).catch(() => {});
}

export async function safeAtomicWrite(opts: {
  targetPath: string;
  content: string;
  retries?: number;
  baseDelayMs?: number;
  useLockFile?: boolean;
}) {
  const retries = Math.max(0, Math.min(20, Math.trunc(Number(opts.retries ?? 8))));
  const baseDelayMs = Math.max(1, Math.min(1000, Math.trunc(Number(opts.baseDelayMs ?? 20))));
  const useLockFile = opts.useLockFile ?? true;
  const dir = path.dirname(opts.targetPath);
  const base = path.basename(opts.targetPath);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, `${base}.write.lock`);
  const lock = useLockFile
    ? await acquireWriteLock(lockPath, retries, baseDelayMs)
    : { path: lockPath, active: false };

  let tmp = "";
  let lastError: any = null;
  try {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      tmp = path.join(dir, `${base}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
      await fs.writeFile(tmp, opts.content, "utf8");
      try {
        await fs.rename(tmp, opts.targetPath);
        return;
      } catch (e: any) {
        lastError = e;
        if (!isRenameContentionError(e) || attempt === retries) break;
        const backoff = Math.min(1_000, baseDelayMs * (2 ** Math.min(attempt, 6)));
        await sleep(backoff);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }

    // Windows fallback for stubborn EPERM/EACCES/EBUSY: copy then remove tmp.
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      tmp = path.join(dir, `${base}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
      await fs.writeFile(tmp, opts.content, "utf8");
      try {
        await fs.copyFile(tmp, opts.targetPath);
        return;
      } catch (e: any) {
        lastError = e;
        if (!isRenameContentionError(e) || attempt === retries) break;
        const backoff = Math.min(1_000, baseDelayMs * (2 ** Math.min(attempt, 6)));
        await sleep(backoff);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }
    throw lastError ?? new Error(`safeAtomicWrite failed for ${opts.targetPath}`);
  } finally {
    await releaseWriteLock(lock);
  }
}

export async function safeAppendLine(opts: {
  targetPath: string;
  line: string;
  retries?: number;
  baseDelayMs?: number;
  useLockFile?: boolean;
}) {
  const dir = path.dirname(opts.targetPath);
  await fs.mkdir(dir, { recursive: true });
  let current = "";
  try {
    current = await fs.readFile(opts.targetPath, "utf8");
  } catch {}
  const suffix = opts.line.endsWith("\n") ? opts.line : `${opts.line}\n`;
  await safeAtomicWrite({
    targetPath: opts.targetPath,
    content: `${current}${suffix}`,
    retries: opts.retries,
    baseDelayMs: opts.baseDelayMs,
    useLockFile: opts.useLockFile,
  });
}
