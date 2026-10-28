import { execFile } from "node:child_process";
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
  const inspect = await runCommand("docker", ["network", "inspect", networkName]);
  if (inspect.success) {
    return true;
  }
  const create = await runCommand("docker", ["network", "create", networkName]);
  return create.success;
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
