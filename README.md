# pegas

> **Agent-native zero-config L7 reverse proxy orchestrator for Docker.**  
> Host unlimited websites and APIs on a single VPS with zero port conflicts, automatic Let's Encrypt SSL, and zero-downtime hot reloads. Built specifically to be rock-solid for human developers and autonomous AI coding agents (Cursor, Claude Code, Cline, Copilot).

[![npm version](https://img.shields.io/npm/v/@netrunner714/pegas.svg?color=cb3837)](https://www.npmjs.com/package/@netrunner714/pegas)
[![CI](https://github.com/netrunner714/pegas/actions/workflows/ci.yml/badge.svg)](https://github.com/netrunner714/pegas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-black.svg)](package.json)

---

## ⚡ The Problem: VPS Port Collisions & Dev Chaos

When hosting multiple Dockerized web projects on a single VPS ($5–20/mo):

* **The 80/443 Port Trap**: Every application's `docker-compose.yml` tries to bind `ports: - "80:80"` and `"443:443"`. The first app succeeds; every subsequent app crashes with `bind: address already in use`.
* **DNS Split-Brain Collisions**: When multiple projects share an external Docker network with generic service names (like `web` or `app`), Docker's embedded DNS round-robins requests across completely unrelated projects.
* **Cold Starts & 502 Bad Gateway**: Deploying an app that takes 10–30s to boot (Prisma migrations, Next.js build) causes immediate 502 errors if reverse proxy routes are updated prematurely.
* **Domain Hijacking**: Project B accidentally configures a domain already owned by Project A in its compose/caddy files, breaking routing.
* **Disk Exhaustion**: Unbounded Docker container logs silently fill the server disk until Docker crashes.
* **Dev Sprawl**: Developers juggle 3 terminal tabs for local development: one for Docker databases, one for Vite/Next.js, and one for local HTTPS / ngrok.

---

## 💡 The Pegas Architecture

Pegas standardizes your multi-app VPS around a unified, ultra-lightweight **Caddy 2** gateway:

```
                  Internet (HTTP :80 / HTTPS :443)
                                  │
                                  ▼
                   ┌─────────────────────────────┐
                   │    Pegas Caddy Gateway        │ (~30 MB RAM)
                   │  (Auto Let's Encrypt SSL)   │
                   └──────────────┬──────────────┘
                                  │
                  Docker Network: │ pegas-network
          ┌───────────────────────┴───────────────────────┐
          ▼                                               ▼
┌──────────────────┐                            ┌──────────────────┐
│  Project Alpha   │                            │   Project Beta   │
│  alias:          │                            │  alias:          │
│  alpha-web:3000  │                            │  beta-web:8080   │
└──────────────────┘                            └──────────────────┘
```

1. **Ultra-Lightweight**: Uses **~30 MB of RAM** for the entire reverse proxy gateway (vs 1–2 GB for Coolify or Dokku).
2. **Zero Port Collisions**: Only the Pegas gateway binds host ports `80` and `443`. Containers communicate internally over `pegas-network`.
3. **Project-Scoped DNS Aliases**: Automatically scopes container aliases (`<projectName>-<service>`), preventing round-robin split-brain collisions.
4. **Readiness Probe**: Waits for containers to become healthy before reloading Caddy — zero 502 Bad Gateway errors on deploy.
5. **Domain Anti-Hijacking**: Validates that target domains are not already claimed by another project on the server.
6. **Automatic Docker Log Rotation**: Configures `max-size: 50m` / `max-file: 3` to keep server disks clean.
7. **Smart Local Dev (`pegas dev`)**: Native HTTPS proxy on unprivileged ports (8443+) with optional automatic database boot and teardown.
8. **Zero Dependencies**: 100% standard Node.js stdlib. No heavy npm dependency trees.

---

## 🚀 Quickstart (30 Seconds)

### Step 1: Initialize in Your Project

Run inside any web application directory with a `package.json` or `docker-compose.yml`:

```bash
npx @netrunner714/pegas init
# or: pnpm add -D @netrunner714/pegas && pnpm pegas init
```

**What `pegas init` does automatically:**
- 🔍 **Discovers Services**: Detects web and infra services from your `docker-compose.yml` (e.g. `web:3000` or `8080:80`).
- ✂️ **Compose Surgery**:
  - Removes public web port mappings (`80:80`, `3000:3000`) to eliminate host port conflicts.
  - Preserves infrastructure ports (Postgres `5432:5432`, Redis `6379:6379`).
  - Injects `expose` directives for internal proxying.
  - Attaches the web service to `pegas-network` with a project-scoped alias (`<projectName>-web`).
  - Injects Docker logging rotation (`max-size: 50m`, `max-file: 3`).
- 📜 **Scaffolds `pegas.json`**: Creates a declarative contract with slug-derived dev (`<project>.localhost`) and prod (`<project>.com`) domains.
- ⚡ **Injects Scripts**: Wraps `npm run dev` with `pegas dev` and adds `npm run deploy` (`pegas deploy`) in `package.json`.
- 🛡️ **Protects VCS**: Adds `.pegas` to `.gitignore`.

---

### Step 2: Local Development with Smart Infra Boot

```bash
npm run dev
# or: npx pegas dev -- next dev
```

* **Zero-Config Local HTTPS**: Starts local native Caddy on standard ports (`https://<project>.localhost` — чистый URL без порта) с graceful fallback на 8443+.
* **Trusted Local CA (`pegas ca install`)**: One command installs a local Root CA into the OS trust store — green browser lock, no `NET::ERR_CERT_AUTHORITY_INVALID`, no third-party mkcert. Linux (Debian & RHEL families), macOS, Windows and WSL are supported; on WSL the CA is installed into **both** sides (Windows browser store + Linux-side system bundle). `pegas dev` also propagates `NODE_EXTRA_CA_CERTS` to your dev server so Node/Bun `fetch()` trusts local HTTPS.
* **Smart Infra Boot (Optional)**: Automatically starts databases (Postgres, Redis, MongoDB, MySQL) via `docker compose up -d <services>` when enabled:
  ```bash
  npx pegas dev --infra -- npm run dev
  ```
  *(Or enable permanently for the team via `"bootInfra": true` in `pegas.json`).*
* **Graceful Teardown**: Pressing `Ctrl+C` safely stops databases (`docker compose stop`) without deleting volumes or losing data.

---

### Step 3: Deploy to VPS

Commit your code and pull it onto your VPS, then run:

```bash
npm run deploy
# or: npx pegas deploy
```

```text
🚀 [1/3] Starting project containers with Docker Compose...
⏳ Checking container readiness for: web...
  🟢 Service 'web' is ready to accept traffic
📄 [2/3] Generated route config: /etc/caddy/conf.d/shop.caddy
🔄 [3/3] Validating and hot-reloading Caddy gateway...
🎉 Project 'shop' successfully deployed to Pegas gateway!
```

* **Readiness Verification**: Verifies container is running and healthy before updating routes.
* **DNS Pre-Flight Check**: Checks DNS A-records against server public IP to protect Let's Encrypt rate limits (`--strict-dns` in CI).
* **Anti-Hijacking Check**: Rejects deployment if another project on the server already claims the domain.
* **Zero-Downtime Hot Reload**: Replaces routes atomically with instant rollback if configuration validation fails.

---

## 📊 Global Server Dashboard: `pegas ls`

Inspect all active projects deployed on the server with real-time Docker container states:

```bash
npx pegas ls
```

```text
🚀 Pegas Global Dashboard — Active Projects in /home/user/gateway:

┌───────────────┬──────────────────────────────────────────┬──────────────────────┬─────────────────┐
│ PROJECT       │ DOMAINS                                  │ UPSTREAM             │ STATUS          │
├───────────────┼──────────────────────────────────────────┼──────────────────────┼─────────────────┤
│ project-alpha │ project-alpha.com, www.project-alpha.com │ project-alpha-web:80 │ 🟢 Up 2 hours   │
│ project-beta  │ project-beta.com, www.project-beta.com   │ project-beta-web:80  │ 🟢 Up 45 minutes│
│ my-blog       │ blog.example.com                         │ my-blog-web:3000     │ 🔴 Exited (1)   │
└───────────────┴──────────────────────────────────────────┴──────────────────────┴─────────────────┘

Total: 3 active projects
```

---

## 📄 The Declarative Contract: `pegas.json`

The `pegas.json` file is version-controlled in your repository:

```json
{
  "$schema": "https://netrunner714.ru/schemas/pegas.json",
  "projectName": "my-cool-app",
  "bootInfra": true,
  "services": {
    "web": {
      "upstream": "web:3000",
      "domains": {
        "dev": [
          "my-cool-app.localhost"
        ],
        "prod": [
          "mycoolapp.com",
          "www.mycoolapp.com",
          "магазин.рф"
        ]
      }
    },
    "api": {
      "upstream": "backend:8000",
      "domains": {
        "dev": [
          "api.my-cool-app.localhost"
        ],
        "prod": [
          "api.mycoolapp.com"
        ]
      }
    }
  }
}
```

### Key Contract Options:
* **`projectName`**: Scopes network aliases (`<projectName>-web:3000`) and route files (`conf.d/<projectName>.caddy`).
* **`bootInfra`**: (Boolean) When `true`, `pegas dev` automatically boots Docker Compose databases and infrastructure services.
* **`domains.dev`**: Local domains routed by `pegas dev` to `localhost:<port>`.
* **`domains.prod`**: Production domains routed by `pegas deploy` to `<projectName>-<service>:<port>`.
* **IDN / Cyrillic Support**: Full native support for non-Latin domains (e.g. `магазин.рф`). Converted safely to Punycode (`xn--...`) for filesystem compatibility while Caddy handles TLS certificates automatically.

---

## 🛡️ SRE Protections & Reliability

| Feature | Protection | Behavior |
| :--- | :--- | :--- |
| **Readiness Probe** | Prevents `502 Bad Gateway` | Polls Docker container state and Docker Healthcheck before updating Caddy routes. |
| **Domain Anti-Hijacking** | Prevents Route Collision | Scans existing project configs in `conf.d/` and halts if another project already owns the domain. |
| **DNS Pre-Flight** | Prevents ACME Rate Limits | Resolves A-records before deployment; alerts developer if DNS has not propagated to this server (`--strict-dns` in CI). |
| **Docker Log Rotation** | Prevents VPS Disk Full | Automatically configures `driver: json-file`, `max-size: 50m`, `max-file: 3` for all services. |
| **Local Delegation** | Prevents CLI Version Drift | Global CLI automatically delegates execution to local `node_modules/pegas` when present in project root. |

---

## 🛠️ CLI Reference

```
pegas <command> [options]

COMMANDS:
  init                     Init Pegas in current project
  dev [-- <command>]       Run local dev HTTPS proxy and start dev command (e.g. pegas dev -- next dev)
  ca install               Install local Root CA into OS trust store (trusted green-lock HTTPS)
  ca remove                Remove local Root CA from OS trust store
  deploy                   Declarative deploy: configure Caddy routes & start containers
  down                     Tear down project containers and remove Caddy routes
  add <domain> [options]   Imperatively route a domain to an internal container upstream
  list, ls                 List all active domain routes and Docker container health
  remove, rm <domain>      Delete route and reload Caddy
  reload                   Validate and hot-reload Caddy configuration
  status                   Check Docker and gateway health
  llms                     Print machine-readable LLM context

OPTIONS FOR 'init':
      --dry-run            Print planned project files without writing to disk

OPTIONS FOR 'dev':
      --infra              Boot infrastructure services defined in docker-compose.yml
      --no-infra           Do not boot infrastructure services even if enabled in pegas.json

OPTIONS FOR 'deploy':
      --strict-dns         Abort deployment if DNS records do not match server IP
      --skip-dns-check     Bypass DNS pre-flight verification
      --skip-readiness     Skip container readiness check

GLOBAL OPTIONS:
      --gateway-dir <path> Override path to gateway directory
      --dry-run            Print generated configs without applying
      --json               Output machine-readable JSON (ideal for AI agents)
  -h, --help               Show help
  -v, --version            Show version
```

---

## 🤖 Built for AI Coding Agents

Pegas is designed from the ground up for **Agent-Driven Development**:

* **Machine-Readable CLI**: Every command supports `--json` for structured input/output.
* **Deterministic Configuration**: No interactive prompts that cause agents to hang.
* **Project Guidelines**: Generates `docs/pegas.md` in initialized projects and provides `npx pegas llms` / `llms.txt` so tools like Cursor, Claude Code, Cline, and GitHub Copilot immediately understand how to deploy without modifying host Nginx or breaking other containers.

---

## 🔒 Security & Best Practices

* **No Docker Socket in Gateway**: Unlike Traefik, Pegas does not mount `/var/run/docker.sock` into the web-facing proxy container, eliminating privilege escalation vulnerabilities.
* **Default Security Headers**: Automatically applies `Strict-Transport-Security` (HSTS), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`.
* **Rootless Local Dev**: `pegas dev` runs in user space; `pegas ca install` grants Caddy `cap_net_bind_service` on Linux (one-time `sudo`) and unprivileged fallback ports (8443+) otherwise.
* **Automatic Rollback**: If syntax validation fails during reload, the previous configuration is immediately restored.

---

## 📄 License

MIT © [NETRUNNER714](https://netrunner714.ru)
