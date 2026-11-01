/**
 * Полная инвентаризация сервисов из docker-compose — для авто-заполнения
 * контракта pegas init. В отличие от detectComposeWebService (главный сервис),
 * собирает ВСЕ сервисы со всеми обнаруживаемыми признаками.
 *
 * Парсер лайновый (без YAML-зависимостей, ноль npm-пакетов): разбирает
 * только уровень services: и один уровень вложенности каждого сервиса.
 * Списки (ports, volumes, environment, command) и хэш-ключи (build.context,
 * depends_on, healthcheck) собираются построчно; значения с подстановками
 * ${VAR} помечаются как unresolved и не попадают в контракт как литералы.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { isInfraService, isProxyService } from "./compose.js";

export const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;

export interface ComposeBuildInfo {
  context?: string;
  dockerfile?: string;
  target?: string;
}

export interface ComposeServiceInfo {
  name: string;
  /** app | infra | proxy | profile (под profiles: — не входит в контракт) */
  kind: "app" | "infra" | "proxy" | "profile";
  build?: ComposeBuildInfo;
  image?: string;
  /** Контейнерные порты из expose: и ports: (без хостовой части) */
  ports: number[];
  /** Порты, пробрасываемые на хост ("80:80") — конфликт с общим шлюзом */
  hostPorts: number[];
  envFile?: string;
  /** Несекретные environment (KEY=VALUE или KEY: VALUE) */
  env: Record<string, string>;
  volumes: string[];
  profiles: string[];
  hasHealthcheck: boolean;
  dependsOn: string[];
}

export interface ComposeInventory {
  file: string;
  services: ComposeServiceInfo[];
}

/** Убирает кавычки и хвостовые комментарии из YAML-значения. */
function cleanValue(raw: string): string {
  let v = raw.trim();
  // кавычки
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  // хвостовой комментарий (только вне кавычек — после снятия кавычек грубая эвристика)
  const idx = v.indexOf(" #");
  if (idx > 0) v = v.slice(0, idx);
  return v.trim();
}

/** true, если значение содержит подстановку ${VAR} — не литерал. */
function isUnresolved(v: string): boolean {
  return /\$\{[^}]+\}/.test(v) || /\$[A-Z_]+/.test(v);
}

/**
 * Парсит содержимое compose-файла в полную карту сервисов.
 * Возвращает null, если секция services: не найдена.
 */
export function parseComposeServices(content: string): ComposeServiceInfo[] | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  interface RawSvc {
    name: string;
    lines: string[];
    profiles: string[];
  }

  const raw: RawSvc[] = [];
  let inServices = false;
  let serviceIndent: number | null = null;
  let currentSvc: RawSvc | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.search(/\S/);

    // пустые строки и комментарии верхнего уровня
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (indent === 0 && /^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }

    // конец секции services (другой ключ верхнего уровня: volumes:, networks:)
    if (indent === 0 && inServices && /^\S+:/.test(line)) {
      if (currentSvc) {
        raw.push(currentSvc);
        currentSvc = null;
      }
      inServices = false;
      continue;
    }

    if (!inServices) continue;

    if (serviceIndent === null && indent > 0 && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
      serviceIndent = indent;
    }

    // заголовок сервиса: имя: на уровне отступа сервисов
    if (serviceIndent !== null && indent === serviceIndent && /^[a-zA-Z0-9._-]+:\s*$/.test(trimmed)) {
      if (currentSvc) raw.push(currentSvc);
      currentSvc = { name: trimmed.replace(/:\s*$/, ""), lines: [], profiles: [] };
      continue;
    }

    if (currentSvc) {
      currentSvc.lines.push(line);
    }
  }

  if (currentSvc) raw.push(currentSvc);
  if (raw.length === 0) return null;

  return raw.map((svc) => parseOneService(svc));
}

/** Разбирает строки одного сервиса в ComposeServiceInfo. */
function parseOneService(svc: { name: string; lines: string[] }): ComposeServiceInfo {
  const info: ComposeServiceInfo = {
    name: svc.name,
    kind: "app",
    ports: [],
    hostPorts: [],
    env: {},
    volumes: [],
    profiles: [],
    hasHealthcheck: false,
    dependsOn: [],
  };

  let inBuild = false;
  let buildIndent = 0;

  for (const line of svc.lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.search(/\S/);

    // выход из блока build:
    if (inBuild && indent <= buildIndent) {
      inBuild = false;
    }

    // build: с инлайн-значением: build: .
    if (/^build:\s*\S/.test(trimmed)) {
      const v = cleanValue(trimmed.replace(/^build:\s*/, ""));
      if (v && !isUnresolved(v)) info.build = { context: v };
      continue;
    }

    if (/^build:\s*$/.test(trimmed)) {
      inBuild = true;
      buildIndent = indent;
      info.build = {};
      continue;
    }

    if (inBuild) {
      const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
      if (m) {
        const key = m[1].toLowerCase();
        const v = cleanValue(m[2]);
        if (v && !isUnresolved(v)) {
          if (key === "context") info.build!.context = v;
          else if (key === "dockerfile") info.build!.dockerfile = v;
          else if (key === "target") info.build!.target = v;
        }
      }
      continue;
    }

    // image:
    const imageMatch = trimmed.match(/^image:\s*(.+)$/);
    if (imageMatch) {
      const v = cleanValue(imageMatch[1]);
      if (v && !isUnresolved(v)) info.image = v;
      continue;
    }

    // env_file:
    const envFileMatch = trimmed.match(/^env_file:\s*(.+)$/);
    if (envFileMatch) {
      const v = cleanValue(envFileMatch[1]);
      // список или путь; берём первый путь
      if (v.startsWith("-")) {
        const first = v.replace(/^-\s*/, "").trim();
        info.envFile = cleanValue(first) || undefined;
      } else if (v && !isUnresolved(v)) {
        // env_file с вложенной map (path:) — грубо: взять path:
        const pathM = v.match(/path:\s*(\S+)/);
        info.envFile = pathM ? cleanValue(pathM[1]) : v;
      }
      continue;
    }

    // environment: KEY=VALUE / KEY: VALUE / список -
    if (/^environment:\s*$/.test(trimmed)) {
      continue; // элементы пойдут как строки ниже
    }
    const envListMatch = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (envListMatch) {
      const v = cleanValue(envListMatch[2]);
      if (!isUnresolved(v)) info.env[envListMatch[1]] = v;
      continue;
    }
    const envMapMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(\S.*)$/);
    if (envMapMatch && isEnvContext(svc.lines, trimmed, indent)) {
      const v = cleanValue(envMapMatch[2]);
      if (!isUnresolved(v)) info.env[envMapMatch[1]] = v;
      continue;
    }

    // ports: - "80:80" / - "3000"
    const portItem = trimmed.match(/^-\s*["']?(\d+)(?::(\d+))?["']?\s*$/);
    if (portItem) {
      const container = parseInt(portItem[2] || portItem[1], 10);
      if (container) {
        info.ports.push(container);
        if (portItem[2]) info.hostPorts.push(parseInt(portItem[1], 10));
      }
      continue;
    }

    // expose: - "3000"
    const exposeItem = trimmed.match(/^-\s*["']?(\d+)["']?\s*$/);
    if (exposeItem) {
      const p = parseInt(exposeItem[1], 10);
      if (p) info.ports.push(p);
      continue;
    }

    // volumes:
    const volItem = trimmed.match(/^-\s*(\S.*)$/);
    if (volItem && inVolumesContext(svc.lines, trimmed, indent)) {
      const v = cleanValue(volItem[1]);
      if (v && !isUnresolved(v)) info.volumes.push(v);
      continue;
    }

    // profiles: — инлайн-массив profiles: ["a", "b"] или блочный список
    const profileInline = trimmed.match(/^profiles:\s*\[([^\]]*)\]\s*$/);
    if (profileInline) {
      for (const item of profileInline[1].split(",")) {
        const v = cleanValue(item);
        if (v) info.profiles.push(v);
      }
      continue;
    }
    const profileItem = trimmed.match(/^-\s*([a-zA-Z0-9_-]+)\s*$/);
    if (profileItem && inProfilesContext(svc.lines, trimmed, indent)) {
      info.profiles.push(profileItem[1]);
      continue;
    }

    // healthcheck: (наличие)
    if (/^healthcheck:\s*$/.test(trimmed)) {
      info.hasHealthcheck = true;
      continue;
    }

    // depends_on:
    if (/^depends_on:\s*$/.test(trimmed)) {
      continue;
    }
    const depItem = trimmed.match(/^-\s*([a-zA-Z0-9_.-]+)\s*$/);
    if (depItem && inDependsOnContext(svc.lines, trimmed, indent)) {
      info.dependsOn.push(depItem[1]);
      continue;
    }
    // depends_on: блочная map-форма (name: без дефиса, с вложенным condition:)
    const depMapItem = trimmed.match(/^-\s*([a-zA-Z0-9_.-]+):\s*$/);
    if (depMapItem && inDependsOnContext(svc.lines, trimmed, indent)) {
      info.dependsOn.push(depMapItem[1]);
      continue;
    }
    const depMapNoDash = trimmed.match(/^([a-zA-Z0-9_.-]+):\s*$/);
    if (depMapNoDash && inDependsOnContext(svc.lines, trimmed, indent)) {
      info.dependsOn.push(depMapNoDash[1]);
      continue;
    }
  }

  // Классификация
  if (info.profiles.length > 0) {
    info.kind = "profile";
  } else if (isProxyService(svc.name, svc.lines)) {
    info.kind = "proxy";
  } else if (isInfraService(svc.name, svc.lines)) {
    info.kind = "infra";
  }

  return info;
}

/**
 * Проверяет, что строка KEY: value принадлежит блоку environment, а не
 * произвольному хэш-ключу сервиса. Лайновая эвристика: ищем ближайший
 * заголовок environment: выше по отступу.
 */
function isEnvContext(lines: string[], target: string, targetIndent: number): boolean {
  return findBlockHeader(lines, target, targetIndent) === "environment";
}

function inVolumesContext(lines: string[], target: string, targetIndent: number): boolean {
  return findBlockHeader(lines, target, targetIndent) === "volumes";
}

function inProfilesContext(lines: string[], target: string, targetIndent: number): boolean {
  return findBlockHeader(lines, target, targetIndent) === "profiles";
}

function inDependsOnContext(lines: string[], target: string, targetIndent: number): boolean {
  const h = findBlockHeader(lines, target, targetIndent);
  return h === "depends_on";
}

/** Находит ближайший блок-заголовок для строки с данным отступом. */
function findBlockHeader(lines: string[], target: string, targetIndent: number): string | null {
  const idx = lines.findIndex((l) => l.trim() === target && l.search(/\S/) === targetIndent);
  if (idx === -1) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent < targetIndent) {
      const m = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*$/);
      if (m) return m[1].toLowerCase();
    }
  }
  return null;
}

/**
 * Читает первый существующий compose-файл проекта и возвращает полную
 * инвентаризацию сервисов. null — если compose-файла нет или services: пуст.
 */
export async function detectComposeInventory(projectDir: string): Promise<ComposeInventory | null> {
  for (const f of COMPOSE_FILES) {
    try {
      const content = await fs.readFile(path.join(projectDir, f), "utf-8");
      const services = parseComposeServices(content);
      if (services && services.length > 0) {
        return { file: f, services };
      }
    } catch {}
  }
  return null;
}
