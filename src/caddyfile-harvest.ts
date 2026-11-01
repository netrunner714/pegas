/**
 * Одноразовый харвест доменов из Caddyfile проекта: init копирует
 * факты (домен → сервис) в контракт литералами, после чего Caddyfile
 * проекта pegas-ом не читается. Контракт — единственный источник истины.
 *
 * Поддерживаемые формы (проверены на реальных Caddyfile):
 * - блок домен { reverse_proxy svc:port }                    → домены сервиса
 * - multi-доменный блок "a.com, b.com { reverse_proxy ... }"  → все домены сервиса
 * - handle-блоки с разными upstream: домен привязывается к
 *   catch-all upstream (handle без матчера); сплит-роутинг (/api/* → другой
 *   сервис) в контракте не выражается — остаётся ручной зоной
 * - чистые redirect-блоки (www.foo.com { redir }) — НЕ домены сервиса:
 *   www-redirect pegas генерирует сам, исходные редирект-домены не копируем
 * - respond-only блоки (cert endpoint) — без upstream, пропускаются
 */
import fs from "node:fs/promises";
import path from "node:path";

export const CADDYFILE_NAMES = ["Caddyfile", "caddyfile", "Caddyfile.prod", "Caddyfile.production"] as const;

export interface CaddyHarvest {
  /** домен → имя сервиса (из reverse_proxy upstream) */
  domainToService: Map<string, string>;
  /** домены, привязанные к сервису */
  serviceToDomains: Map<string, string[]>;
  /** блоки со сплит-роутингом (несколько разных upstream в одном блоке) — не скопированы */
  splitRoutingBlocks: string[];
}

/** Раскладывает Caddyfile на блоки "заголовок { тело }" (учёт вложенности скобок). */
function splitBlocks(content: string): { header: string; body: string }[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const blocks: { header: string; body: string }[] = [];

  let i = 0;
  while (i < normalized.length) {
    const open = normalized.indexOf("{", i);
    if (open === -1) break;

    // заголовок: текст от начала строки до {
    const lineStart = normalized.lastIndexOf("\n", open) + 1;
    const header = normalized.slice(lineStart, open).trim();

    // найти закрывающую } с учётом вложенности
    let depth = 1;
    let j = open + 1;
    while (j < normalized.length && depth > 0) {
      if (normalized[j] === "{") depth++;
      else if (normalized[j] === "}") depth--;
      j++;
    }
    const body = normalized.slice(open + 1, j - 1);

    if (header && !header.startsWith("(")) {
      // сниппеты (snippet) и импорты пропускаются
      blocks.push({ header, body });
    }
    i = j;
  }
  return blocks;
}

/** Домены из заголовка блока: "a.com, www.a.com {" → ["a.com", "www.a.com"]. */
function headerDomains(header: string): string[] {
  return header
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter((d) => /^[a-zA-Z0-9*._-]+$/.test(d) && d.includes("."))
    .map((d) => d.replace(/^https?:\/\//, "").replace(/:443$/, "").replace(/:80$/, ""));
}

/** Все reverse_proxy upstream'ы в теле блока (включая вложенные handle). */
function collectUpstreams(body: string): string[] {
  const upstreams: string[] = [];
  for (const m of body.matchAll(/reverse_proxy\s+([^\s{]+\s+=>\s+[^\s}]+|[^\s]+)/g)) {
    const raw = m[1].trim();
    if (raw.startsWith("(")) continue; // upstream-пул
    upstreams.push(raw);
  }
  return upstreams;
}

/**
 * Чистый redirect-блок: тело содержит только редирект (без проксирования и
 * раздачи файлов). Домены таких блоков к сервису не привязываются —
 * www-redirect и переезд доменов pegas генерирует сам из контракта.
 */
function isRedirectOnlyBlock(body: string): boolean {
  const hasProxy = /\breverse_proxy\b/.test(body);
  const hasFileServer = /\bfile_server\b/.test(body);
  const hasRedirect = /\b(redir|redirect)\b/.test(body);
  return !hasProxy && !hasFileServer && hasRedirect;
}

/** Парсит Caddyfile в харвест-данные. null — если файла нет / блоков нет. */
export function parseCaddyfile(content: string): CaddyHarvest | null {
  const blocks = splitBlocks(content);
  if (blocks.length === 0) return null;

  const domainToService = new Map<string, string>();
  const serviceToDomains = new Map<string, string[]>();
  const splitRoutingBlocks: string[] = [];

  for (const block of blocks) {
    const domains = headerDomains(block.header);
    if (domains.length === 0) continue;

    const upstreams = collectUpstreams(block.body);

    if (isRedirectOnlyBlock(block.body)) continue; // www/redirect-блоки pegas строит сам
    if (upstreams.length === 0) continue;          // respond-only и пр. — без сервиса

    // сервис и порт из upstream "svc:3000" / "svc"
    const parsed = upstreams.map((u) => parseUpstream(u));
    const distinct = [...new Set(parsed.map((p) => p.service))];

    if (distinct.length > 1) {
      // сплит-роутинг: возьмём catch-all (последний upstream в блоке —
      // обычно handle без матчера), остальное пометим как не скопированное
      splitRoutingBlocks.push(block.header);
    }

    const target = parsed[parsed.length - 1];
    if (!target) continue;

    for (const d of domains) {
      if (domainToService.has(d)) continue;
      domainToService.set(d, target.service);
      const list = serviceToDomains.get(target.service) || [];
      list.push(d);
      serviceToDomains.set(target.service, list);
    }
  }

  if (domainToService.size === 0) return null;
  return { domainToService, serviceToDomains, splitRoutingBlocks };
}

/** "svc:3000" → { service: "svc", port: 3000 }; "svc" → port undefined. */
function parseUpstream(raw: string): { service: string; port?: number } {
  const idx = raw.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
    return { service: raw.slice(0, idx), port: parseInt(raw.slice(idx + 1), 10) };
  }
  return { service: raw };
}

/**
 * Читает Caddyfile проекта (первый существующий из типовых имён) и
 * возвращает харвест-данные. null — файла нет или полезных блоков нет.
 */
export async function detectCaddyHarvest(projectDir: string): Promise<CaddyHarvest | null> {
  for (const f of CADDYFILE_NAMES) {
    try {
      const content = await fs.readFile(path.join(projectDir, f), "utf-8");
      const harvest = parseCaddyfile(content);
      if (harvest) return harvest;
    } catch {}
  }
  return null;
}
