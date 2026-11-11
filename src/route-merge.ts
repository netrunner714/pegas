import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseCaddyTopLevelBlocks } from "./commands/status.js";
import { parseRouteMeta, serializeRouteMeta, type RouteMeta } from "./route-meta.js";

/**
 * issue #24: merge маршрутов по доменам в общем файле проекта.
 *
 * Файл `conf.d/<project>-<scenario>.caddy` — общий для владельцев процесса:
 * connect (host-сервисы, upstream `host.docker.internal:<port>`) и deploy
 * (docker-сервисы, upstream `<runtimeId>-<env>-<service>:<port>`). Каждая
 * команда перезаписывает только принадлежащие ей блоки; чужие сохраняются
 * дословно. Правило «владелец маршрута = владелец процесса» из #23 остаётся
 * источником истины для разметки владельцев.
 */

/** Владелец блока маршрутов. */
export type RouteOwner = "connect" | "deploy" | "unknown";

export interface RouteBlock {
  /** Заголовок блока (первая строка перед `{`). */
  header: string;
  /** Тело блока (без внешних скобок). */
  body: string;
  /** Полный исходный текст блока, включая скобки. */
  raw: string;
  /** Комментарий метаданных `# pegas:...`, прикреплённый к блоку (null — его нет). */
  metaComment: string | null;
  /** Текст блока вместе с комментарием метаданных — то, что переносится дословно. */
  rawWithMeta: string;
  /** Домены из заголовка блока. */
  domains: string[];
  /** Первый upstream `reverse_proxy` из тела. */
  upstream: string | null;
  /** Разобранные метаданные маршрута (issue #30); null — строки метаданных нет. */
  meta: RouteMeta | null;
}

/** Разбивает содержимое route-файла на топ-левел блоки с исходным текстом. */
export function splitRouteBlocks(content: string): RouteBlock[] {
  const blocks: RouteBlock[] = [];
  const top = parseCaddyTopLevelBlocks(content);

  // parseCaddyTopLevelBlocks не сохраняет позиции; реконструируем raw-текст по
  // header+body — этого достаточно для посимвильного переноса чужих блоков,
  // потому что генератор pegas пишет блоки в каноническом виде.
  for (const block of top) {
    const domains = block.header
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter((d) => Boolean(d) && !d.startsWith("#"));
    const proxyMatch = bodyReverseProxy(block.body);
    const raw = `${block.header} {${block.body}}`;
    const meta = parseRouteMeta(block.leadingComments);
    // К блоку переносится только его собственная строка метаданных. Прочие
    // ведущие комментарии (шапка файла, рукописные пометки) принадлежат файлу:
    // mergeRouteFile пишет шапку заново, и их перенос дал бы дубликаты.
    const metaComment = meta ? serializeRouteMeta(meta) : null;
    blocks.push({
      header: block.header,
      body: block.body,
      raw,
      metaComment,
      rawWithMeta: metaComment ? `${metaComment}\n${raw}` : raw,
      domains,
      upstream: proxyMatch,
      meta,
    });
  }
  return blocks;
}

function bodyReverseProxy(body: string): string | null {
  const m = body.match(/reverse_proxy\s+([^\s\n{}]+)/);
  return m ? m[1].trim() : null;
}

/**
 * Определяет владельца блока по upstream (правило #23: владелец маршрута =
 * владелец процесса).
 * - `host.docker.internal:<port>` → connect (host-процессы);
 * - хост начинается с `<prefix>` (`<runtimeId>-<env>-`) → deploy;
 * - прочее (внешние/легаси-маршруты, редиректы) → unknown, сохраняется как есть.
 */
export function detectRouteOwner(block: RouteBlock, deployUpstreamPrefix: string): RouteOwner {
  // Метаданные — источник истины: connect теперь пишет и docker-маршруты
  // (scoped-upstream), поэтому эвристика по upstream больше не различает владельца.
  if (block.meta?.owner === "connect" || block.meta?.owner === "deploy") {
    return block.meta.owner;
  }
  const host = block.upstream?.split(":")[0] || "";
  if (host === "host.docker.internal") return "connect";
  if (deployUpstreamPrefix && host.startsWith(`${deployUpstreamPrefix}-`)) return "deploy";
  return "unknown";
}

/**
 * Результат слияния route-файла.
 *
 * `content` — новое содержимое файла (null, если блоков не осталось и файл
 * нужно удалить). `removedDomains` — домены чужих владельцев, которые были
 * заменены (для предупреждений); `keptOther` — количество сохранённых чужих блоков.
 */
export interface MergeResult {
  content: string | null;
  removedDomains: string[];
  keptOther: number;
}

/**
 * Собирает новое содержимое route-файла: шапка проекта + свои сниппеты + чужие
 * блоки (владельцы ≠ owner) в исходном виде.
 *
 * @param existingContent текущее содержимое файла (null/пусто — файла нет)
 * @param owner команд-владелец, от имени которой идёт запись
 * @param deployUpstreamPrefix префикс scoped-upstream deploy (`<runtimeId>-<env>`)
 * @param ownSnippets сниппеты Caddyfile, сгенерированные командой-owner
 */
export function mergeRouteFile(
  existingContent: string | null,
  headerComments: string[],
  owner: "connect" | "deploy",
  deployUpstreamPrefix: string,
  ownSnippets: string[],
): MergeResult {
  const removedDomains: string[] = [];
  const otherBlocks: RouteBlock[] = [];

  // Домены, которые команда объявляет в этом вызове. Блок с тем же доменом
  // заменяется независимо от прежнего владельца: после перехода на модель
  // «connect владеет всеми маршрутами» старые deploy-блоки не должны дублироваться.
  const ownDomains = new Set<string>();
  for (const snippet of ownSnippets) {
    const header = snippet.match(/^(?!#)([^\n{]+)\{/m)?.[1];
    if (!header) continue;
    for (const d of header.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
      ownDomains.add(d);
    }
  }

  if (existingContent) {
    for (const block of splitRouteBlocks(existingContent)) {
      const blockOwner = detectRouteOwner(block, deployUpstreamPrefix);
      if (blockOwner === owner) {
        // Свои старые блоки уйдут: на их место встают fresh-сниппеты.
        continue;
      }
      if (block.domains.some((d) => ownDomains.has(d))) {
        // Домен перерегистрируется этой командой — старый блок (в т.ч. deploy)
        // заменяется, иначе Caddy получил бы два одинаковых site-блока.
        removedDomains.push(...block.domains);
        continue;
      }
      if (blockOwner === "unknown") {
        // Легаси/внешний блок: домен может пересекаться с тем, что пишет
        // команда, — фиксируем для предупреждения, блок сохраняем как есть.
        removedDomains.push(...block.domains);
      }
      otherBlocks.push(block);
    }
  }

  const own = ownSnippets.filter((s) => s.trim().length > 0).map((s) => s.trim().replace(/\n+$/, ""));
  if (own.length === 0 && otherBlocks.length === 0) {
    return { content: null, removedDomains, keptOther: 0 };
  }

  const parts: string[] = [];
  for (const comment of headerComments) {
    parts.push(comment);
  }
  if (own.length > 0) parts.push(own.join("\n\n"));
  for (const block of otherBlocks) {
    if (parts.length > 0 && parts[parts.length - 1] !== "") parts.push("");
    // rawWithMeta: метаданные маршрута (`# pegas:...`) принадлежат блоку и
    // обязаны переживать merge — иначе status теряет сервис/сценарий/драйвер.
    parts.push(block.rawWithMeta);
  }
  let content = parts.join("\n");
  if (!content.endsWith("\n")) content += "\n";
  return { content, removedDomains, keptOther: otherBlocks.length };
}

/** Replace a route file atomically so Caddy never observes a partial write. */
export async function writeRouteFileAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf-8", mode: 0o644, flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

/**
 * Удаляет из route-файла блоки указанного владельца. Возвращает новое
 * содержимое (null — блоков не осталось, файл удалить) и список снятых доменов.
 */
export function stripOwnerBlocks(
  existingContent: string | null,
  owner: "connect" | "deploy",
  deployUpstreamPrefix: string,
): { content: string | null; removedDomains: string[] } {
  if (!existingContent) return { content: null, removedDomains: [] };
  const blocks = splitRouteBlocks(existingContent);
  // Файл без топ-левел блоков (пустой/только комментарии) не может хранить
  // чужих маршрутов: удаляется целиком, чтобы не оставлять мусор в conf.d.
  if (blocks.length === 0) return { content: null, removedDomains: [] };
  const removedDomains: string[] = [];
  const kept: RouteBlock[] = [];
  for (const block of blocks) {
    if (detectRouteOwner(block, deployUpstreamPrefix) === owner) {
      removedDomains.push(...block.domains);
      continue;
    }
    kept.push(block);
  }
  if (kept.length === 0) return { content: null, removedDomains };
  const content = kept.map((b) => b.rawWithMeta).join("\n\n") + "\n";
  return { content, removedDomains };
}
