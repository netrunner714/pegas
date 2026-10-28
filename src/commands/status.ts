import { findGatewayDir, listRoutes } from "../gateway.js";
import {
  checkDocker,
  checkDockerCompose,
  getGatewayContainerStatus,
  runCommand,
} from "../docker.js";

export async function handleStatus(options: { gatewayDir?: string; json?: boolean }): Promise<void> {
  const isJson = options.json ?? false;

  const dockerOk = await checkDocker();
  const composeOk = await checkDockerCompose();
  const gatewayDir = await findGatewayDir(options.gatewayDir);

  const netInspect = await runCommand("docker", ["network", "inspect", "pegas-network"]);
  const networkOk = netInspect.success;

  const containerStatus = await getGatewayContainerStatus(gatewayDir);
  const isRunning = containerStatus.success && containerStatus.stdout.includes("caddy");

  const routes = await listRoutes(gatewayDir);

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          docker: dockerOk,
          compose: composeOk,
          gatewayDir,
          network: { name: "pegas-network", exists: networkOk },
          container: { running: isRunning, details: containerStatus.stdout },
          activeRoutesCount: routes.length,
        },
        null,
        2
      )
    );
    return;
  }

  console.log("\n📡 Pegas Gateway Status:\n");
  console.log(`  Docker Engine:      ${dockerOk ? "✓ Active" : "✗ Offline"}`);
  console.log(`  Docker Compose:     ${composeOk ? "✓ Available" : "✗ Missing"}`);
  console.log(`  Docker Network:     ${networkOk ? "✓ 'pegas-network' exists" : "✗ 'pegas-network' missing"}`);
  console.log(`  Gateway Location:   ${gatewayDir}`);
  console.log(`  Caddy Container:    ${isRunning ? "✓ Running" : "✗ Stopped or not found"}`);
  console.log(`  Configured Routes:  ${routes.length} domain(s)`);
  console.log("\n");
}
