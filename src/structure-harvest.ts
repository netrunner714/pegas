/**
 * Структурный харвест: сигналы деплойности из дерева проекта, ещё до
 * (и независимо от) docker-compose. Папки apps/* и per-app Dockerfile —
 * маркеры сервисов; EXPOSE в Dockerfile — порт; packages/* — исключение
 * (библиотеки, не сервисы). Контракт после init источник не читает.
 *
 * Роль — подтверждать и дополнять, а не генерировать сервисы из воздуха:
 * папка без Dockerfile — лишь кандидат (extension/admin — UI-артефакты,
 * не обязательно контейнеры), в контракт сама по себе не попадает.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface AppDirCandidate {
  /** имя каталога в apps/ */
  name: string;
  /** package.json name (без npm-scope), если есть */
  packageName?: string;
  /** apps/<name>/Dockerfile существует */
  hasDockerfile: boolean;
  /** порт из EXPOSE (первое число) */
  exposePort?: number;
}

export interface RootDockerfileStages {
  /** имена runtime-стейджей (FROM ... AS x): builder/deps-подобные отфильтрованы */
  runtimeStages: string[];
  file: string;
}

export interface StructureHarvest {
  /** источник каталога-кандидатов: "apps" | "services" | null */
  appsDir: "apps" | "services" | null;
  candidates: AppDirCandidate[];
  /** стейджи корневого multi-target Dockerfile, если он есть */
  rootDockerfile: RootDockerfileStages | null;
}

const APPS_DIRS = ["apps", "services"] as const;

/** runtime-стейдж — не builder и не deps: эвристика по имени. */
function isRuntimeStage(name: string): boolean {
  const n = name.toLowerCase();
  if (n === "deps" || n === "base" || n === "builder") return false;
  if (n.endsWith("-builder") || n.endsWith("-build") || n.endsWith("-deps")) return false;
  if (n.startsWith("build") || n.startsWith("dep")) return false;
  return true;
}

/** Первое EXPOSE-число из Dockerfile. */
async function extractExpose(dockerfilePath: string): Promise<number | undefined> {
  try {
    const content = await fs.readFile(dockerfilePath, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.trim().match(/^EXPOSE\s+(\d+)(?:\/\w+)?/);
      if (m) return parseInt(m[1], 10);
    }
  } catch {}
  return undefined;
}

/**
 * Читает структурные сигналы проекта. Никогда не бросает: нет signals —
 * пустой харвест (candidates: [], appsDir: null).
 */
export async function detectStructureHarvest(projectDir: string): Promise<StructureHarvest> {
  const harvest: StructureHarvest = { appsDir: null, candidates: [], rootDockerfile: null };

  // каталог кандидатов: apps/ или services/ (первый существующий)
  for (const dir of APPS_DIRS) {
    const dirPath = path.join(projectDir, dir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    harvest.appsDir = dir;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const appPath = path.join(dirPath, entry.name);
      const dockerfilePath = path.join(appPath, "Dockerfile");
      let hasDockerfile = false;
      try {
        hasDockerfile = (await fs.stat(dockerfilePath)).isFile();
      } catch {}
      let packageName: string | undefined;
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(appPath, "package.json"), "utf-8"));
        if (typeof pkg?.name === "string") {
          packageName = pkg.name.replace(/^@[^/]+\//, ""); // срез npm-scope
        }
      } catch {}
      harvest.candidates.push({
        name: entry.name,
        packageName,
        hasDockerfile,
        exposePort: hasDockerfile ? await extractExpose(dockerfilePath) : undefined,
      });
    }
    break;
  }

  // корневой multi-target Dockerfile: FROM ... AS <name>
  try {
    const rootDockerfile = path.join(projectDir, "Dockerfile");
    const content = await fs.readFile(rootDockerfile, "utf-8");
    const stages: string[] = [];
    for (const line of content.split("\n")) {
      const m = line.trim().match(/^FROM\s+\S+(?:\s+AS\s+([a-zA-Z0-9._-]+))?/i);
      if (m?.[1] && isRuntimeStage(m[1]) && !stages.includes(m[1])) {
        stages.push(m[1]);
      }
    }
    if (stages.length > 0) {
      harvest.rootDockerfile = { runtimeStages: stages, file: "Dockerfile" };
    }
  } catch {}

  return harvest;
}
