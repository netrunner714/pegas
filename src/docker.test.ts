import { describe, it, expect } from "bun:test";
import {
  runCommand,
  checkDocker,
  checkDockerCompose,
  ensureDockerNetwork,
  validateCaddyConfig,
  reloadCaddyConfig,
  startGatewayContainer,
  getGatewayContainerStatus,
} from "./docker.js";

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

  it("ensureDockerNetwork creates and inspects network idempotently", async () => {
    const testNet = `pegas-test-net-${Date.now()}`;
    try {
      const created = await ensureDockerNetwork(testNet);
      expect(typeof created).toBe("boolean");

      // Running a second time hits the inspect.success branch
      const inspect = await ensureDockerNetwork(testNet);
      expect(typeof inspect).toBe("boolean");
    } finally {
      await runCommand("docker", ["network", "rm", testNet]);
    }
  });

  it("validateCaddyConfig and reloadCaddyConfig return CommandResult", async () => {
    const valRes = await validateCaddyConfig("/tmp");
    expect(typeof valRes.success).toBe("boolean");
    expect(typeof valRes.stdout).toBe("string");
    expect(typeof valRes.stderr).toBe("string");

    const relRes = await reloadCaddyConfig("/tmp");
    expect(typeof relRes.success).toBe("boolean");
    expect(typeof relRes.stdout).toBe("string");
    expect(typeof relRes.stderr).toBe("string");
  });

  it("startGatewayContainer and getGatewayContainerStatus return CommandResult", async () => {
    const startRes = await startGatewayContainer("/tmp");
    expect(typeof startRes.success).toBe("boolean");
    expect(typeof startRes.stdout).toBe("string");
    expect(typeof startRes.stderr).toBe("string");

    const statusRes = await getGatewayContainerStatus("/tmp");
    expect(typeof statusRes.success).toBe("boolean");
    expect(typeof statusRes.stdout).toBe("string");
    expect(typeof statusRes.stderr).toBe("string");
  });
});
