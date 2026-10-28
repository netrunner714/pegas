import { describe, it, expect } from "bun:test";
import { runCommand, checkDocker, checkDockerCompose } from "./docker.js";

describe("docker helper functions", () => {
  it("runCommand executes command and returns success, stdout, stderr", async () => {
    const res = await runCommand("node", ["-e", "console.log('HELLO_DOCKER')"]);
    expect(res.success).toBe(true);
    expect(res.stdout).toBe("HELLO_DOCKER");
    expect(res.stderr).toBe("");
  });

  it("runCommand captures failure cleanly without unhandled rejections", async () => {
    const res = await runCommand("node", ["-e", "console.error('ERR'); process.exit(1)"]);
    expect(res.success).toBe(false);
    expect(res.stderr).toBe("ERR");
  });

  it("checkDocker returns boolean", async () => {
    const isDocker = await checkDocker();
    expect(typeof isDocker).toBe("boolean");
  });

  it("checkDockerCompose returns boolean", async () => {
    const isCompose = await checkDockerCompose();
    expect(typeof isCompose).toBe("boolean");
  });
});
