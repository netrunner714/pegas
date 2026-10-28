export const LLMS_TXT_CONTENT = `# pegas

> Agent-native zero-config Caddy reverse proxy for Docker multi-app VPS setups.

## Core Concepts
- Manages single reverse proxy (Caddy 2) listening on :80 and :443.
- All Docker projects attach to a shared Docker bridge network named \`pegas-network\`.
- Never expose 80:80 or 443:443 in application compose files.
- Each project gets an isolated declarative drop-in configuration in \`conf.d/<projectName>.caddy\`.
- Hot-reloads Caddy via API with zero downtime and automatic validation rollback.
- Auto-provisions Let's Encrypt SSL on first request.

## CLI Usage for Agents
- \`npx @netrunner714/pegas init\` — Initialize gateway and Docker network on a clean VPS, or initialize a project with \`pegas.json\`.
- \`npx pegas dev -- <command>\` — Local HTTPS proxy for dev domains without Docker.
- \`npx pegas deploy\` — Declaratively deploy project containers and route Caddy domains from \`pegas.json\`.
- \`npx pegas down\` — Tear down project containers and unbind Caddy routes.
- \`npx pegas add <domain> --upstream <service:port>\` — Route a new domain to a container service.
- \`npx pegas add <domain> --spa --upstream <client:80> --api-upstream <api:8000>\` — Route SPA + API.
- \`npx pegas list --json\` — List all active routes.
- \`npx pegas remove <domain>\` — Remove route and reload Caddy.
- \`npx pegas status\` — Check Docker, network, and Caddy health.

## Example Docker Compose Patch for Any App
\`\`\`yaml
services:
  app:
    networks:
      pegas-network:
        aliases:
          - app

networks:
  pegas-network:
    external: true
\`\`\`
`;

export function handleLlms(options: { json?: boolean }): void {
  if (options.json) {
    console.log(JSON.stringify({ llms: LLMS_TXT_CONTENT }));
  } else {
    console.log(LLMS_TXT_CONTENT);
  }
}
