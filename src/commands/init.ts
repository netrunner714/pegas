import fs from "node:fs/promises";
import path from "node:path";
import type { InitOptions } from "../types.js";

/**
 * pegas init v3 — тонкий детерминированный scaffolder, «первое касание»
 * (RFC_UX_V3.md, §3). Один раз на проект; идемпотентен; без харвестов,
 * без сети, без env-генерации, без starter-Dockerfile, без версионных
 * проверок. Контракт pegas.json НЕ создаётся и НЕ трогается — его пишет
 * LLM/пользователь по схеме и эталону.
 */

/** Канонический блок правил Pegas для AGENTS.md (единый для всех репо). */
export const PEGAS_AGENT_RULES = `<!-- BEGIN:pegas-rules -->
## Pegas
- Этот репозиторий ОБЯЗАН следовать стандарту Pegas v3 (L7-шлюз Caddy + контракт pegas.json). Отклонение — баг.
- Перед работой с топологией, роутингом или окружениями: сначала \`pegas.json\`, потом \`docs/pegas.md\`.
- Контракт — единственный источник истины о топологии: не клонировать в код и не обходить. Изменил топологию — правь pegas.json, \`pegas check\` обязан быть зелёным.
- Секреты: только имена в \`services.<name>.secrets\`, значения — в .env. Секрет в контракте или в git — инцидент.
- Домены — только HTTP-сервисы; не-HTTP наружу — \`ports\` + \`publicHost\`. Ветвления по средам в коде запрещены: сценарий выбирает запуск, код читает готовые значения.
- Схема контракта: https://pegas.netrunner714.ru/schemas/pegas.json
<!-- END:pegas-rules -->`;

export const PEGAS_AGENT_RULES_MARKER_REGEX = /<!-- BEGIN:pegas-rules -->[\s\S]*?<!-- END:pegas-rules -->/;

/** Канонический docs/pegas.md проекта (единый для всех репо, кроме имени проекта). */
/**
 * Канонический docs/pegas.md проекта: суть Pegas (что исчезает из репо), контракт,
 * интеграция через import, команды, dev-цикл. Единый для всех репо, кроме имени проекта.
 */
export function docsPegasMd(projectName: string): string {
  return `# Pegas

Проект работает на **Pegas** — L7-шлюзе и оркестраторе локальной инфраструктуры.
Pegas заменяет собой всю инфраструктурную обвязку, которая обычно копится в репо.

## Что исчезает из репозитория

- **docker-compose.yml** — не нужен: манифест генерируется из \`pegas.json\` на каждый деплой (эфемерный, не хранится).
- **Caddyfile / конфиги обратного прокси** — не нужны: маршруты и TLS шлюз строит из \`domains\` контракта.
- **Ручные списки CORS-доменов** — не нужны: пегас знает все домены проекта и сам настраивает заголовки (\`services.<name>.cors\`).
- **Переменные окружения «про топологию»** (порты, адреса соседей, NODE_ENV) — вычисляются пегасом, код не дублирует.

Единственный источник истины о топологии — \`pegas.json\` в корне репо.

## Контракт pegas.json

- Схема (с IDE-подсказками): https://pegas.netrunner714.ru/schemas/pegas.json
- Сервисы, драйверы (\`docker\`/\`bun\`), порты, домены, сценарии (development/stage/production),
  secrets — всё в одном декларативном файле. Сценарные карты заполняются без пропусков (Zero Scalars).
- Секреты: имена в \`services.<name>.secrets\`; значения — в .env (не коммитится, .gitignore: \`.env*\`, шаблон \`!.env.example\` коммитится) или в CI-хранилище.
- Валидация и аудит: \`pegas check\` (рид-онли: контракт, паритет секретов, git-гигиена, свежесть доки).

## Доктрина доступа к конфигурации

Pegas — не только инструмент деплоя, но и ориентир разработки: сценарий — это флаг запуска (\`pegas connect -s <scenario>\` объявляет маршруты, \`pegas deploy -s <scenario>\` поднимает docker-сервисы), а не ветвление в коде. Код никогда не решает, в какой он среде, — он читает уже готовые значения для текущего сценария.

Env — транспорт инъекции, а не источник знания о топологии. Три слоя:

| Слой | Где живёт значение | Как читает код |
|---|---|---|
| **Топология** (порт, домены, адреса соседей, сценарий) | \`pegas.json\` | SDK: \`currentService()\`, \`services()\` — никогда \`process.env.PORT\` |
| **Секреты** | .env / CI-хранилище (инжектируются деплоем) | SDK: \`secret("KEY")\` — с понятной ошибкой |
| **Несекретный app-конфиг** | \`services.<name>.env\` контракта | SDK: \`config("KEY")\` / \`optionalConfig("KEY")\` — значение текущего сценария; прямой \`process.env\` — только легаси-фолбэк |

Запрещены в коде: PORT, APP_DOMAIN, CLIENT_ORIGINS, ветвления по NODE_ENV / PEGAS_ENV — например \`if (process.env.NODE_ENV === "development") { ... } else { ... }\` — всё это выводится платформой. Сценарий можно использовать только для логов и меток, но не для переключения поведения.

Зависимость: если код импортирует \`@netrunner714/pegas/runtime\`, пакет обязан быть в \`dependencies\` (runtime нужен в боевом коде). Если импорта нет — только в \`devDependencies\`.

## Интеграция в код приложения

Пегас не только поднимает контейнеры — его можно импортировать:

\`\`\`ts
import { currentService, services, secret } from "@netrunner714/pegas/runtime";

const port = currentService().port;              // порт из контракта
const api = services().api.internalUrl;          // адрес соседнего сервиса (service discovery)
const key = secret("API_KEY");                   // секрет из .env с понятной ошибкой
\`\`\`

Контекст (\`currentService\`/\`services\`) инжектится в контейнер переменной \`PEGAS_CONTEXT\` —
код не парсит \`process.env\` руками и не ветвится по средам: сценарий выбирает запуск, код читает готовые значения.
В env-контракте доступны ссылки \`pegas://<имя-сервиса>\` — разворачиваются во внутренние адреса сети при деплое
(для приложений без импорта, например статических Next.js-образов).

## Команды

- \`pegas connect -s <scenario>\` / \`pegas disconnect -s <scenario>\` — объявить/снять маршруты сценария в шлюзе
- \`pegas deploy -s <scenario>\` — поднять docker-сервисы сценария; маршруты не пишет (host-сервисы запускает сам разработчик)
- \`pegas down -s <scenario>\` — остановить контейнеры; маршруты connect сохраняются
- \`pegas logs -f [service]\` — логи контейнеров
- \`pegas status\` — дашборд шлюза: контейнеры, маршруты, домены
- \`pegas check\` — аудит контракта и секретов (перед коммитом/деплоем)
- \`pegas init\` — сгенерировать/обновить артефакты пегаса в репо (этот файл, AGENTS-блок, .gitignore)
- \`pegas ca install\` — доверенный локальный HTTPS (один раз на машину)
- \`pegas update\` — обновить pegas (\`--latest\` для мажоров)

## Dev-цикл

\`\`\`bash
pegas check                     # аудит контракта и секретов
pegas connect -s development    # маршруты всех сервисов сценария
pegas deploy -s development     # docker-контейнеры сценария
bun run dev                     # host-сервисы (driver: "bun") — когда нужно
\`\`\`

Проект: \`${projectName}\`

Документация: https://netrunner714.ru/pegas`;
}

/** Идемпотентное дополнение .gitignore (только отсутствующие строки). */
export async function setupGitignore(projectDir: string, dryRun = false): Promise<string | null> {
  const gitignorePath = path.join(projectDir, ".gitignore");
  // Env-маска одним правилом: .env* (покрывает .env, .env.local, .env.*),
  // с явным исключением !.env.example — шаблон секретов коммитится.
  // Репо с парой (.env + .env.*) уже покрыты: дублей не добавляем.
  const needed = [".pegas", ".env*", "!.env.example"];
  const covers = (existing: string[], entry: string): boolean => {
    if (entry === "!.env.example") {
      return existing.some((l) => l === "!.env.example" || l === "!.env*");
    }
    if (entry === ".env*") {
      // Покрытие — только маска (.env* / .env.*) или пара (.env + .env.*):
      // голый .env НЕ покрывает .env.local/.env.production — расширяем до маски.
      const exact = existing.some((l) => l === ".env*" || l === ".env.*" || l.startsWith(".env*."));
      const pair = existing.includes(".env") && existing.includes(".env.*");
      return exact || pair;
    }
    return existing.includes(entry) || existing.includes(entry + "/");
  };
  try {
    const content = await fs.readFile(gitignorePath, "utf-8");
    const lines = content.split("\n").map((line) => line.trim());
    const toAdd = needed.filter((entry) => !covers(lines, entry));
    if (toAdd.length === 0) return null;
    const suffix = toAdd.join("\n") + "\n";
    const updated = content.endsWith("\n") ? `${content}${suffix}` : `${content}\n${suffix}`;
    if (!dryRun) await fs.writeFile(gitignorePath, updated, "utf-8");
    return `Добавлена запись ${toAdd.join(", ")} в .gitignore`;
  } catch {
    if (!dryRun) await fs.writeFile(gitignorePath, `${needed.join("\n")}\n`, "utf-8");
    return `Создан .gitignore с записями ${needed.join(", ")}`;
  }
}

/** Идемпотентный маркер-блок правил Pegas в AGENTS.md. */
export async function setupAgentsMd(projectDir: string, dryRun = false): Promise<string | null> {
  const agentsPath = path.join(projectDir, "AGENTS.md");
  const regex = PEGAS_AGENT_RULES_MARKER_REGEX;
  try {
    const content = await fs.readFile(agentsPath, "utf-8");
    if (regex.test(content)) {
      const updated = content.replace(regex, PEGAS_AGENT_RULES);
      if (updated === content) return null;
      const withNl = updated.endsWith("\n") ? updated : updated + "\n";
      if (!dryRun) await fs.writeFile(agentsPath, withNl, "utf-8");
      return "Обновлен блок правил Pegas в AGENTS.md";
    }
    const trimmed = content.trimEnd();
    const updated = trimmed.length > 0 ? `${trimmed}\n\n${PEGAS_AGENT_RULES}\n` : `${PEGAS_AGENT_RULES}\n`;
    if (!dryRun) await fs.writeFile(agentsPath, updated, "utf-8");
    return "Добавлен блок правил Pegas в AGENTS.md";
  } catch {
    if (!dryRun) await fs.writeFile(agentsPath, `${PEGAS_AGENT_RULES}\n`, "utf-8");
    return "Создан AGENTS.md с правилами Pegas";
  }
}

/**
 * docs/pegas.md — генерируемый артефакт пегаса (как AGENTS-блок): создатся при отсутствии
 * и перезаписывается каноном при отличии. Это делает pegas init обновлением доки при
 * обновлении зависимости (check детектор подскажет, если забыли).
 */
export async function setupDocsPegasMd(projectDir: string, projectName: string, dryRun = false): Promise<string | null> {
  const docsPath = path.join(projectDir, "docs", "pegas.md");
  const canonical = docsPegasMd(projectName);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(docsPath, "utf-8");
  } catch {}
  if (existing === canonical) return null;
  if (!dryRun) {
    await fs.mkdir(path.dirname(docsPath), { recursive: true });
    await fs.writeFile(docsPath, canonical, "utf-8");
  }
  return existing === null ? "Создан docs/pegas.md" : "Обновлён docs/pegas.md (канон установленного pegas)";
}

/** Создаёт .pegas/ (рантайм-каталог проекта, гитигнорится). */
export async function setupPegasDir(projectDir: string, dryRun = false): Promise<string | null> {
  const dir = path.join(projectDir, ".pegas");
  try {
    await fs.access(dir);
    return null;
  } catch {}
  if (!dryRun) await fs.mkdir(dir, { recursive: true });
  return "Создан каталог .pegas/";
}

export async function handleInit(options: InitOptions = {}): Promise<void> {
  const isJson = options.json ?? false;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const dryRun = options.dryRun ?? false;

  // Источник имени — pegas.json (projectName контракта); fallback — package.json, затем имя каталога.
  // Единый источник важен: check сверяет docs/pegas.md с каноном именно по имени контракта.
  const projectName = (() => {
    const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
    try {
      const contract = JSON.parse(require("node:fs").readFileSync(path.join(cwd, "pegas.json"), "utf-8"));
      if (typeof contract.projectName === "string" && contract.projectName.trim()) {
        return sanitize(contract.projectName);
      }
    } catch {}
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync(path.join(cwd, "package.json"), "utf-8"));
      return sanitize((pkg.name || path.basename(cwd)).replace(/^@[^\/]+\//, ""));
    } catch {
      return sanitize(path.basename(cwd));
    }
  })();

  const actions: string[] = [];
  const a1 = await setupGitignore(cwd, dryRun); if (a1) actions.push(a1);
  const a2 = await setupAgentsMd(cwd, dryRun); if (a2) actions.push(a2);
  const a3 = await setupDocsPegasMd(cwd, projectName, dryRun); if (a3) actions.push(a3);
  const a4 = await setupPegasDir(cwd, dryRun); if (a4) actions.push(a4);

  if (isJson) {
    console.log(JSON.stringify({ status: dryRun ? "dry-run" : "ok", project: projectName, actions }));
    return;
  }

  console.log(`\n🧰 Pegas init — первое касание (${dryRun ? "dry-run" : cwd})\n`);
  for (const a of actions) console.log(`  ✓ ${a}`);
  if (actions.length === 0) console.log(`  ℹ️ Всё уже на месте (идемпотентность)`);
  console.log(`\nЧто дальше:`);
  console.log(`  1. Напишите pegas.json по схеме https://pegas.netrunner714.ru/schemas/pegas.json`);
  console.log(`     (контекст для агента: bunx pegas llms; эталон — в пакете и на сайте)`);
  console.log(`  2. pegas check — проверьте контракт`);
  console.log(`  3. pegas connect + pegas deploy -s development — начать работу\n`);
}


/**
 * Свежесть артефактов репо (детектор вместо мутатора): маркер-блок AGENTS.md и
 * docs/pegas.md обязаны совпадать с каноном установленного пегаса. Рассинхрон —
 * признак обновления зависимости без pegas init; рецепт — pegas init (идемпотентен).
 */
export async function auditProjectArtifacts(
  projectDir: string,
  projectName: string
): Promise<string[]> {
  const issues: string[] = [];
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const agentsPath = path.join(projectDir, "AGENTS.md");
  try {
    const raw = await fs.readFile(agentsPath, "utf-8");
    const match = raw.match(PEGAS_AGENT_RULES_MARKER_REGEX);
    if (!match) {
      issues.push("AGENTS.md: маркер-блок pegas-rules не найден (pegas init добавит).");
    } else if (match[0] !== PEGAS_AGENT_RULES) {
      issues.push("AGENTS.md: блок правил Pegas устарел — pegas init обновит (зависимость обновлялась без init).");
    }
  } catch {
    issues.push("AGENTS.md: файла нет — pegas init создаст с блоком правил Pegas.");
  }

  const docsPath = path.join(projectDir, "docs", "pegas.md");
  try {
    const raw = await fs.readFile(docsPath, "utf-8");
    if (raw !== docsPegasMd(projectName)) {
      issues.push("docs/pegas.md: устарел относительно установленного пегаса — pegas init обновит.");
    }
  } catch {
    issues.push("docs/pegas.md: файла нет — pegas init создаст.");
  }
  return issues;
}
