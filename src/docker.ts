import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  cmd: string,
  args: string[],
  cwd?: string
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    return {
      success: false,
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || err.message || "").toString().trim(),
    };
  }
}

export async function checkDocker(): Promise<boolean> {
  const res = await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return res.success;
}

export async function checkDockerCompose(): Promise<boolean> {
  const res = await runCommand("docker", ["compose", "version"]);
  return res.success;
}

export async function ensureDockerNetwork(networkName = "pegas-network"): Promise<boolean> {
  const inspectNetwork = async (): Promise<boolean> => {
    const inspect = await runCommand("docker", ["network", "inspect", networkName]);
    if (!inspect.success) return false;
    try {
      const networks = JSON.parse(inspect.stdout);
      return Array.isArray(networks) && networks.length > 0 && networks[0].Driver === "bridge" && !networks[0].Internal;
    } catch {
      return false;
    }
  };

  if (await inspectNetwork()) return true;
  const create = await runCommand("docker", ["network", "create", "--driver", "bridge", "--label", "pegas.managed=true", networkName]);
  if (create.success) return true;
  // Another process may have created the shared network between inspect/create.
  return await inspectNetwork();
}

export async function validateCaddyConfig(gatewayDir: string): Promise<CommandResult> {
  return await runCommand(
    "docker",
    ["compose", "exec", "-T", "caddy", "caddy", "validate", "--config", "/etc/caddy/Caddyfile"],
    gatewayDir
  );
}

export async function reloadCaddyConfig(gatewayDir: string): Promise<CommandResult> {
  return await runCommand(
    "docker",
    ["compose", "exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
    gatewayDir
  );
}

export async function startGatewayContainer(gatewayDir: string): Promise<CommandResult> {
  return await runCommand("docker", ["compose", "up", "-d"], gatewayDir);
}

export async function getGatewayContainerStatus(gatewayDir: string): Promise<CommandResult> {
  return await runCommand("docker", ["compose", "ps", "--format", "json"], gatewayDir);
}

async function findGatewayComposeFile(gatewayDir: string): Promise<string | null> {
  for (const file of ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"]) {
    try {
      await fs.access(path.join(gatewayDir, file));
      return file;
    } catch {}
  }
  return null;
}

/**
 * Starts the machine-wide Caddy service and attaches it to the shared network.
 * The Compose override is passed through stdin and never persisted.
 */
export async function ensureGatewayContainer(gatewayDir: string): Promise<CommandResult> {
  const networkReady = await ensureDockerNetwork("pegas-network");
  if (!networkReady) {
    return { success: false, stdout: "", stderr: "Could not create or inspect the shared Docker network 'pegas-network'." };
  }

  const composeFile = await findGatewayComposeFile(gatewayDir);
  if (!composeFile) {
    return { success: false, stdout: "", stderr: `No Compose file found in shared Gateway directory: ${gatewayDir}` };
  }

  const override = JSON.stringify({
    services: {
      caddy: {
        labels: { "pegas.gateway": "true" },
        networks: { "pegas-network": { aliases: ["pegas-gateway"] } },
      },
    },
    networks: {
      "pegas-network": { external: true, name: "pegas-network" },
    },
  });

  try {
    execFileSync("docker", [
      "compose", "--project-directory", gatewayDir,
      "-f", composeFile, "-f", "-", "up", "-d", "caddy",
    ], {
      cwd: gatewayDir,
      input: override,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true, stdout: "", stderr: "" };
  } catch (error: any) {
    const stdout = (error?.stdout || "").toString().trim();
    const stderr = (error?.stderr || error?.message || "Failed to start shared Gateway.").toString().trim();
    if (/port is already allocated|address already in use|failed to bind|bind: permission denied/i.test(stderr)) {
      return { success: false, stdout, stderr: "Shared Caddy Gateway cannot bind host port 80 or 443. Free the conflicting port and retry. Docker reported: " + stderr };
    }
    return { success: false, stdout, stderr };
  }
}

/**
 * A stopped project still holds the Gateway dependency. Only when no
 * containers (running or stopped) carry pegas.project may the Gateway stop.
 */
export async function stopGatewayIfUnused(gatewayDir: string): Promise<CommandResult> {
  const holders = await runCommand("docker", [
    "ps", "-aq", "--filter", "label=pegas.project",
  ]);
  if (!holders.success) return holders;
  if (holders.stdout.trim()) return { success: true, stdout: "Gateway retained: other Pegas project containers still exist.", stderr: "" };

  const gatewayContainers = await runCommand("docker", [
    "ps", "-q", "--filter", "label=pegas.gateway=true",
  ]);
  if (!gatewayContainers.success) return gatewayContainers;
  if (!gatewayContainers.stdout.trim()) return { success: true, stdout: "Gateway is already stopped.", stderr: "" };

  const stopped = await runCommand("docker", ["stop", ...gatewayContainers.stdout.split(/\s+/).filter(Boolean)]);
  if (!stopped.success) return stopped;
  return { success: true, stdout: "Shared Gateway stopped: no Pegas projects depend on it.", stderr: "" };
}
