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
- \`npx @netrunner714/pegas init\` — Initialize project with \`pegas.json\` contract and dev scripts.
- \`npx pegas dev\` — Start local HTTPS proxy for \`*.localhost\` domains.
- \`npx pegas dev -- <command>\` — Local HTTPS proxy + app command in one process (e.g. \`pegas dev -- next dev\`).
- \`npx pegas deploy <environment>\` — Declaratively deploy containers and configure Caddy routes (e.g. \`pegas deploy production\`, \`pegas deploy stage\`).
- \`npx pegas down\` — Tear down project containers and unbind Caddy routes.
- \`npx pegas status [--json]\` — Unified dashboard for Caddy health, container states, and active project routes.
- \`npx pegas update [--latest]\` — Update Pegas CLI in package.json.
- \`npx pegas ca install\` — Install local Root CA for trusted dev HTTPS (clean URLs on port 443).
- \`npx pegas ca remove\` — Remove local Root CA from OS trust store.
- \`npx pegas llms\` — Print machine-readable LLM context.

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
