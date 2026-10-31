import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";

interface ProcessIdentity {
  name: string;
  start: string;
}

interface LockOwner extends ProcessIdentity {
  pid: number;
  token: string;
  createdAt: number;
  heartbeatAt: number;
}

const LOCK_NAME = "pegas-runtime.lock";
const RECOVERY_NAME = "pegas-runtime.lock.recovery";
const HEARTBEAT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns null only when the PID is proven absent, and undefined when the
 * platform does not let us establish identity. Undefined is never treated as
 * proof that a lock is stale.
 */
async function getProcessIdentity(pid: number): Promise<ProcessIdentity | null | undefined> {
  if (process.platform === "linux") {
    try {
      const [stat, name] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, "utf8"),
        fs.readFile(`/proc/${pid}/comm`, "utf8"),
      ]);
      const closingParen = stat.lastIndexOf(")");
      if (closingParen < 0) return undefined;
      const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
      const start = fields[19];
      if (!start) return undefined;
      return { name: name.trim(), start };
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
      return undefined;
    }
  }

  if (process.platform === "win32") {
    try {
      const output = childProcess.execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          `$p = Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ($p.StartTime.ToUniversalTime().Ticks.ToString() + "|" + $p.ProcessName)`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }
      ).trim();
      const separator = output.indexOf("|");
      if (separator < 1) return undefined;
      return { start: output.slice(0, separator), name: output.slice(separator + 1) };
    } catch (error: any) {
      if (error?.status === 1 || /Cannot find a process|No process/.test(String(error?.stderr || ""))) return null;
      return undefined;
    }
  }

  try {
    const output = childProcess.execFileSync(
      "ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }
    ).trim();
    if (!output) return null;
    const parts = output.split(/\s+/);
    return { start: parts.slice(0, 5).join(" "), name: parts.slice(5).join(" ") };
  } catch (error: any) {
    if (error?.status === 1) return null;
    return undefined;
  }
}

async function writeOwner(lockDir: string, owner: LockOwner): Promise<void> {
  const temporary = path.join(lockDir, `owner.${owner.token}.tmp`);
  const target = path.join(lockDir, "owner.json");
  await fs.writeFile(temporary, JSON.stringify({ ...owner, heartbeatAt: Date.now() }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, target);
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8"));
    if (
      !Number.isInteger(parsed.pid) ||
      typeof parsed.name !== "string" ||
      typeof parsed.start !== "string" ||
      typeof parsed.token !== "string"
    ) return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

async function reclaimIfOwnerIsDead(lockDir: string, recoveryDir: string): Promise<boolean> {
  let recoveryAcquired = false;
  try {
    await fs.mkdir(recoveryDir, { mode: 0o700 });
    recoveryAcquired = true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }

  try {
    const owner = await readOwner(lockDir);
    if (!owner) return false;
    const liveIdentity = await getProcessIdentity(owner.pid);
    if (liveIdentity === undefined) {
      throw new Error("Cannot safely verify the process holding the Pegas runtime lock; refusing to reclaim it.");
    }
    const isDead = liveIdentity === null ||
      liveIdentity.start !== owner.start ||
      liveIdentity.name !== owner.name;
    if (!isDead) return false;

    const staleDir = `${lockDir}.stale-${owner.token}`;
    try {
      await fs.rename(lockDir, staleDir);
      await fs.rm(staleDir, { recursive: true, force: true });
      return true;
    } catch (error: any) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  } finally {
    if (recoveryAcquired) await fs.rm(recoveryDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Serializes machine-wide operations that can create or remove shared Gateway
 * resources. Stale locks are reclaimed only when PID identity proves the old
 * owner is gone; missing or unverifiable owner data fails closed.
 */
export async function withRuntimeLock<T>(
  operation: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const lockDir = path.join(os.tmpdir(), LOCK_NAME);
  const recoveryDir = path.join(os.tmpdir(), RECOVERY_NAME);
  const startedAt = Date.now();
  const identity = await getProcessIdentity(process.pid);
  if (!identity) {
    throw new Error("Pegas cannot establish its own process identity; refusing to start a shared runtime operation.");
  }

  const token = randomUUID();
  const owner: LockOwner = {
    pid: process.pid,
    name: identity.name,
    start: identity.start,
    token,
    createdAt: Date.now(),
    heartbeatAt: Date.now(),
  };

  let acquired = false;
  while (!acquired) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      acquired = true;
      await writeOwner(lockDir, owner);
    } catch (error: any) {
      if (acquired) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;

      const existingOwner = await readOwner(lockDir);
      if (existingOwner) {
        const liveIdentity = await getProcessIdentity(existingOwner.pid);
        if (liveIdentity === undefined) {
          throw new Error("Cannot safely verify the process holding the Pegas runtime lock; refusing to continue.");
        }
        if (liveIdentity === null || liveIdentity.start !== existingOwner.start || liveIdentity.name !== existingOwner.name) {
          await reclaimIfOwnerIsDead(lockDir, recoveryDir);
          continue;
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Timed out waiting for the Pegas shared runtime lock. Another deploy/down operation may still be running.");
      }
      await sleep(250);
    }
  }

  let released = false;
  const cleanupSync = () => {
    if (released) return;
    released = true;
    try {
      const raw = fsSync.readFileSync(path.join(lockDir, "owner.json"), "utf8");
      const current = JSON.parse(raw);
      if (current.token === token && current.pid === process.pid) {
        fsSync.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {}
  };
  process.once("exit", cleanupSync);

  const heartbeat = setInterval(() => {
    void writeOwner(lockDir, owner).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    process.removeListener("exit", cleanupSync);
    cleanupSync();
  }
}
