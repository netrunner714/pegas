import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
import { withRuntimeLock } from "./runtime-lock.js";

const LOCK_DIR = path.join(os.tmpdir(), "pegas-runtime.lock");

describe("runtime lock", () => {
  it("runs the operation and releases the lock", async () => {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    const result = await withRuntimeLock(async () => 42);
    expect(result).toBe(42);
    expect(fs.existsSync(LOCK_DIR)).toBe(false);
  });

  it("serializes concurrent operations within one process", async () => {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    const order: string[] = [];
    // Лок гарантирует взаимное исключение, но не порядок захвата: стартуем
    // первую операцию и даём ей время захватить лок, и только потом вторую.
    const first = withRuntimeLock(async () => {
      order.push("first-enter");
      await new Promise((r) => setTimeout(r, 100));
      order.push("first-exit");
    });
    await new Promise((r) => setTimeout(r, 300));
    const second = withRuntimeLock(async () => {
      order.push("second-enter");
    }, 5_000);
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("times out waiting for a foreign lock held by a live process", async () => {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    // Create a genuine lock owned by a live sleep process.
    const holder = child_process.spawn("sleep", ["5"]);
    try {
      await new Promise<void>((resolve) => {
        if (holder.pid) {
          const stat = fs.readFileSync(`/proc/${holder.pid}/stat`, "utf8");
          const comm = fs.readFileSync(`/proc/${holder.pid}/comm`, "utf8").trim();
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const lockOwner = { pid: holder.pid, name: comm, start: fields[19], token: "foreign-token", createdAt: Date.now(), heartbeatAt: Date.now() };
          fs.mkdirSync(LOCK_DIR, { recursive: true });
          fs.writeFileSync(path.join(LOCK_DIR, "owner.json"), JSON.stringify(lockOwner));
        }
        resolve();
      });
      let message = "";
      try {
        await withRuntimeLock(async () => "never", 500);
      } catch (e: any) {
        message = e.message;
      }
      expect(message).toContain("Timed out waiting");
    } finally {
      holder.kill("SIGKILL");
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock whose owner is provably dead", async () => {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    // Spawn a short-lived process and wait for it to die: its PID is provably absent.
    const shortLived = child_process.spawnSync("true", []);
    const deadPid = shortLived.pid ?? 999999;
    const lockOwner = { pid: deadPid, name: "true", start: "12345", token: "dead-token", createdAt: Date.now(), heartbeatAt: Date.now() };
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCK_DIR, "owner.json"), JSON.stringify(lockOwner));

    const result = await withRuntimeLock(async () => "reclaimed");
    expect(result).toBe("reclaimed");
    expect(fs.existsSync(LOCK_DIR)).toBe(false);
  });

  it("refuses to run when a stale owner cannot be verified (missing owner data)", async () => {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    // Lock dir exists but owner.json is corrupt -> readOwner returns null ->
    // acquisition retries until timeout (an ownerless lock must never be silently reclaimed).
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCK_DIR, "owner.json"), "{ not json");
    let message = "";
    try {
      await withRuntimeLock(async () => "never", 400);
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toContain("Timed out waiting");
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  });
});