import fs from "node:fs/promises";
import path from "node:path";

import { normalizeDomain } from "./contract.js";

/**
 * Аудит `allowedDevOrigins` в конфиге Next.js (issue #28).
 *
 * Зачем: Pegas публикует локальные сервисы на доменах `<project>.localhost` и
 * `<service>.<project>.localhost`. Next.js защищает dev-ресурсы (`/_next/*`,
 * `/__nextjs*`) от cross-origin обращений: hostname из `Origin`/`Referer`
 * сравнивается со списком разрешённых, и домен шлюза в него может не попасть.
 * Итог — предупреждение или 403 на HMR-сокете, что выглядит как проблема CORS
 * на стороне шлюза.
 *
 * Модуль рид-онли и без побочных эффектов: читает `package.json`,
 * `next.config.*` и (если есть) `node_modules/next/package.json`, возвращает
 * результат аудита. Вызывается из `pegas check`.
 *
 * Ограничения (честно: сторонних парсеров JS/TS в проекте нет и не будет —
 * AGENTS.md, «ноль сторонних зависимостей»):
 * - конфиг разбирается текстовой эвристикой, а не AST: плоский массив строк
 *   распознаётся, вычисляемые значения (переменные, спреды, вызовы функций,
 *   интерполяция `${...}`) — нет, в этом случае возвращается статус
 *   `indeterminate` и мягкая подсказка вместо ложного предупреждения;
 * - просматривается только корень проекта. Монорепо с Next-приложением в
 *   `apps/web` аудитор не увидит: он промолчит, а не предупредит (молчание
 *   безопаснее ложного срабатывания);
 * - Next-конфиг, собранный из нескольких файлов (`...require('./base')`),
 *   разбирается только в части исходного файла.
 *
 * Факты о Next.js сверены с исходниками тегов v14.2.30, v14.2.33, v15.3.0,
 * v15.5.0, v16.0.0, v16.2.0, v16.3.0, v16.4.5:
 * - `packages/next/src/server/config-schema.ts` — опция `allowedDevOrigins`
 *   (`z.array(z.string()).optional()`) появилась в 15.3.0 и в 14.2.30 (backport
 *   в ветку 14.2); в 14.2.29 и ниже, в 15.0–15.2 её нет;
 * - `packages/next/src/shared/lib/constants.ts` (CONFIG_FILES) — порядок
 *   загрузки: `next.config.js`, `.mjs`, `.ts`, далее `.mts`;
 * - `packages/next/src/server/app-render/csrf-protection.ts` — сопоставление
 *   hostname с шаблоном: `*` — ровно одна метка, `**` — одна и более и только
 *   первым сегментом; в ветке 14.2 действует дополнительное ограничение
 *   (`depth < 2`): две последние метки шаблона обязаны быть литералами, поэтому
 *   там не работают ни `*.localhost`, ни `**.localhost`;
 * - `packages/next/src/server/lib/router-utils/block-cross-site.ts` (до 16.1) и
 *   `block-cross-site-dev.ts` (с 16.2) — встроенный список всегда содержит
 *   `localhost`, до 16.2 также `*.localhost`, с 16.3 — `**.localhost`;
 *   до 16.1 при незаданной опции Next только предупреждает, с 16.2 — блокирует
 *   (403) независимо от настройки.
 */

/** Порядок поиска конфига: сначала то, что реально загружает Next (CONFIG_FILES),
 *  затем запасные варианты, которые проект может держать (`.cjs` Next не читает). */
const CONFIG_FILE_ORDER = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.mts",
  "next.config.cjs",
];

/** Путь к публичному гайду — печатается в предупреждении. */
export const NEXTJS_GUIDE_PATH = "docs/how-to/nextjs.md";

/**
 * Канонические формы dev-доменов Pegas: используются, когда вызывающий код не
 * передал домены (контракт недоступен) — аудит проверяет покрытие обеих форм.
 */
const GENERIC_PEGAS_DOMAINS = ["pegas-app.localhost", "pegas-svc.pegas-app.localhost"];

/** Итог аудита. */
export type NextjsDevOriginsStatus =
  /** Next.js в package.json не обнаружен — аудит не применяется. */
  | "not-detected"
  /** Версия Next.js не знает опцию allowedDevOrigins (до 15.3.0 / до 14.2.30). */
  | "unsupported"
  /** Dev-домены проекта не используют зону *.localhost — предупреждать не о чем. */
  | "not-applicable"
  /** Все проверяемые dev-домены покрыты (конфигом и/или встроенным списком). */
  | "ok"
  /** Next.js установлен, но файла next.config.* нет и покрытие неполное. */
  | "missing-config"
  /** Конфиг есть, ключа allowedDevOrigins нет и покрытие неполное. */
  | "missing-option"
  /** Ключ есть, но часть dev-доменов Pegas не покрыта. */
  | "not-covered"
  /** Значение ключа вычисляется динамически либо конфиг не читается. */
  | "indeterminate";

export interface NextjsAuditOptions {
  /**
   * Dev-домены проекта из контракта (сценарий `development`).
   *
   * - `undefined` — домены неизвестны: аудит не блокируется и проверяет
   *   канонические формы `GENERIC_PEGAS_DOMAINS`;
   * - массив без единого домена зоны `.localhost` — аудит не применяется:
   *   проект не публикует dev-сервисы на доменах шлюза Pegas, шуметь не о чем.
   */
  devDomains?: string[];
}

export interface NextjsAuditFinding {
  /** Итоговый статус аудита (машиночитаемо, для --json потребителей). */
  status: NextjsDevOriginsStatus;
  /** true, если Next.js вообще обнаружен в package.json проекта. */
  nextjsDetected: boolean;
  /** Версия Next.js: из node_modules, иначе объявленный диапазон; null — не определена. */
  nextVersion: string | null;
  /** Найденный файл конфига относительно корня проекта (или null). */
  configFile: string | null;
  /** Найден ли ключ allowedDevOrigins. */
  hasAllowedDevOrigins: boolean;
  /** Покрывают ли значение и встроенный список Next dev-домены Pegas. */
  coversPegasOrigins: boolean;
  /** Домены, которые проверялись (нормализованные). */
  checkedDomains: string[];
  /** true — домены взяты из контракта; false — канонические формы-плейсхолдеры. */
  domainsFromContract: boolean;
  /** Домены, не покрытые ни конфигом, ни встроенным списком. */
  uncoveredDomains: string[];
  /** Строки, разобранные из массива allowedDevOrigins (что удалось прочитать). */
  configuredOrigins: string[];
  /** Встроенный в Next.js список разрешённых origin для этой версии. */
  builtinOrigins: string[];
  /** Готовый список значений, покрывающий dev-домены проекта. */
  recommendedOrigins: string[];
  /** Текст предупреждения для вывода (null — проблемы нет). */
  warning: string | null;
  /** Мягкая подсказка (статус indeterminate): проверить конфиг вручную. */
  hint: string | null;
}

/** Разобранная semver-тройка. */
interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Достаёт первую semver-тройку из строки версии или диапазона
 * (`^15.5.0` → 15.5.0, `14.2.33` → 14.2.33, `latest`/`*` → null).
 */
export function parseSemverLoose(raw: string | null | undefined): SemVer | null {
  if (!raw) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Поддерживает ли версия Next.js опцию `allowedDevOrigins`: 15.3.0+ и
 * backport 14.2.30+ в ветке 14.2 (проверено по `config-schema.ts`).
 * Неизвестная версия трактуется как поддерживающая: лучше предупредить,
 * чем промолчать о реально заблокированном HMR.
 */
export function supportsAllowedDevOrigins(version: string | null): boolean {
  const v = parseSemverLoose(version);
  if (!v) return true;
  if (v.major >= 15) return v.major > 15 || v.minor >= 3;
  if (v.major === 14) return v.minor > 2 || (v.minor === 2 && v.patch >= 30);
  return false;
}

/**
 * Ветка 14.2 использует более строгий сопоставитель шаблонов
 * (`csrf-protection.ts` с ограничением `depth < 2`): метка-подстановка в двух
 * последних сегментах hostname запрещена, поэтому там не работают ни
 * `*.localhost`, ни `**.localhost` — только точные имена и шаблоны выше уровня
 * `<project>.localhost`.
 */
export function usesLegacyWildcardMatcher(version: string | null): boolean {
  const v = parseSemverLoose(version);
  return v !== null && v.major === 14;
}

/**
 * Встроенный в Next.js список разрешённых dev-origin для версии:
 * `localhost` — всегда; `*.localhost` — до 16.2 включительно; `**.localhost` —
 * с 16.3. Неизвестная версия трактуется как `*.localhost` (средний случай:
 * не занижаем покрытие и не завышаем его до `**`).
 */
export function builtinDevOrigins(version: string | null): string[] {
  const v = parseSemverLoose(version);
  if (v && (v.major > 16 || (v.major === 16 && v.minor >= 3))) return ["**.localhost", "localhost"];
  return ["*.localhost", "localhost"];
}

/**
 * Как Next.js отреагирует на dev-запрос с непокрытого origin:
 * - 16.2+ — блокирует (HTTP 403) всегда, независимо от наличия опции;
 * - 14.2.30–16.1 — блокирует, только если `allowedDevOrigins` задан; без опции
 *   печатает предупреждение и пропускает запрос
 *   (`mode = typeof allowedDevOrigins === 'undefined' ? 'warn' : 'block'`).
 */
export function blocksUnlistedDevOrigin(version: string | null, optionDefined: boolean): boolean {
  const v = parseSemverLoose(version);
  if (!v) return true; // версия неизвестна — считаем худшим случаем (современный Next)
  if (v.major > 16 || (v.major === 16 && v.minor >= 2)) return true;
  return optionDefined;
}

/**
 * Сопоставление hostname с шаблоном — семантика Next.js 15.3+:
 * `*` заменяет ровно одну метку, `**` — одну и более и только первым сегментом;
 * частичная подстановка внутри метки не поддерживается.
 */
export function matchWildcardDomain(domain: string, pattern: string): boolean {
  const domainParts = domain.split(".");
  const patternParts = pattern.split(".");
  if (patternParts.length < 1) return false;
  if (domainParts.length < patternParts.length) return false;
  // Шаблон из одной метки-подстановки (`*`, `**`) не должен матчить весь домен.
  if (patternParts.length === 1 && (patternParts[0] === "*" || patternParts[0] === "**")) return false;

  while (patternParts.length) {
    const patternPart = patternParts.pop();
    const domainPart = domainParts.pop();
    switch (patternPart) {
      case "":
        return false;
      case "*":
        if (domainPart) continue;
        return false;
      case "**":
        // `**` допустим только первым сегментом шаблона.
        if (patternParts.length > 0) return false;
        return domainPart !== undefined;
      default:
        if (domainPart !== patternPart) return false;
    }
  }
  return domainParts.length === 0;
}

/**
 * Сопоставление hostname с шаблоном — семантика ветки Next.js 14.2:
 * две последние метки шаблона обязаны быть литералами, подстановка разрешена
 * только выше уровня домена. `*.localhost` и `**.localhost` здесь не работают.
 */
export function matchWildcardDomainLegacy(domain: string, pattern: string): boolean {
  const domainParts = domain.split(".");
  const patternParts = pattern.split(".");
  if (patternParts.length < 1) return false;
  if (domainParts.length < patternParts.length) return false;

  let depth = 0;
  while (patternParts.length && depth++ < 2) {
    const patternPart = patternParts.pop();
    const domainPart = domainParts.pop();
    switch (patternPart) {
      case "":
      case "*":
      case "**":
        return false;
      default:
        if (domainPart !== patternPart) return false;
    }
  }

  while (patternParts.length) {
    const patternPart = patternParts.pop();
    const domainPart = domainParts.pop();
    switch (patternPart) {
      case "":
        return false;
      case "*":
        if (domainPart) continue;
        return false;
      case "**":
        if (patternParts.length > 0) return false;
        return domainPart !== undefined;
      default:
        if (domainPart !== patternPart) return false;
    }
  }
  return domainParts.length === 0;
}

/**
 * Покрыт ли dev-домен списком `allowedDevOrigins`. `localhost` разрешён Next.js
 * всегда (плюс hostname, с которым запущен dev-сервер), поэтому он здесь
 * рассматривается отдельно, чтобы не зависеть от списка.
 */
export function isDevOriginCovered(domain: string, entries: string[], legacyMatcher = false): boolean {
  const target = String(domain ?? "").trim().toLowerCase();
  if (target === "localhost") return true;
  return entries.some((raw) => {
    const entry = String(raw ?? "").trim().toLowerCase();
    if (!entry) return false;
    if (entry === target) return true;
    return legacyMatcher ? matchWildcardDomainLegacy(target, entry) : matchWildcardDomain(target, entry);
  });
}

/**
 * Список значений `allowedDevOrigins`, покрывающий dev-домены проекта на всех
 * версиях Next.js, где опция существует: для каждого корня зоны
 * (`<project>.localhost`) — точное имя и рекурсивный шаблон. Точное имя нужно,
 * потому что `**.<zone>` не соответствует самому корню зоны, а работать это
 * обязано и в ветке 14.2, где `**.localhost` не сопоставляется.
 */
export function recommendedDevOrigins(devDomains?: string[]): string[] {
  const roots = new Set<string>();
  for (const raw of devDomains ?? []) {
    const domain = normalizeDomain(String(raw ?? ""));
    if (!domain.endsWith(".localhost")) continue;
    const labels = domain.split(".");
    if (labels.length < 2) continue;
    roots.add(labels.slice(-2).join("."));
  }
  if (roots.size === 0) return ["**.localhost"];
  const out: string[] = [];
  for (const root of [...roots].sort()) {
    out.push(root, `**.${root}`);
  }
  return out;
}

/** Очищенный исходник плюс маска «символ находится внутри строкового литерала». */
export interface StrippedSource {
  /** Код без комментариев и regex-литералов; строки сохранены дословно. */
  code: string;
  /** Маска по индексам `code`: true — внутри строкового литерала. */
  inString: boolean[];
}

/**
 * Убирает из исходника комментарии и regex-литералы, сохраняя строковые
 * литералы дословно, и помечает, какие символы попали внутрь строк: дальше по
 * очищенному тексту ищется ключ и его значение, а маска защищает от ложных
 * находок (слово `allowedDevOrigins` внутри строки или комментария — не ключ).
 *
 * Regex-литералы пропускать обязательно: в конфигах Next часто встречаются
 * правила вида `/https?:\/\//`, и наивный поиск `//` принял бы их за начало
 * комментария и «съел» бы остаток файла.
 */
export function stripSource(source: string): StrippedSource {
  let out = "";
  const inString: boolean[] = [];
  let i = 0;
  const n = source.length;
  // Последний значимый символ и последнее слово — чтобы отличить regex от деления.
  let prevChar = "";
  let prevWord = "";

  const push = (text: string, insideString: boolean): void => {
    out += text;
    for (let k = 0; k < text.length; k++) inString.push(insideString);
  };

  const regexAllowed = (): boolean => {
    if (prevChar === "") return true;
    if ("(,=:[!&|?{};+-*%~^<>".includes(prevChar)) return true;
    return ["return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await"].includes(prevWord);
  };

  while (i < n) {
    const c = source[i];

    // Строковый литерал: копируем дословно, включая экранированные символы.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let literal = quote;
      i++;
      while (i < n) {
        const d = source[i];
        literal += d;
        if (d === "\\") {
          literal += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        i++;
        if (d === quote) break;
      }
      push(literal, true);
      prevChar = quote;
      prevWord = "";
      continue;
    }

    // Строчный комментарий.
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      push(" ", false);
      prevChar = " ";
      prevWord = "";
      continue;
    }
    // Блочный комментарий.
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      push(" ", false);
      prevChar = " ";
      prevWord = "";
      continue;
    }
    // Regex-литерал: пропускаем целиком (с классами `[...]` и флагами).
    if (c === "/" && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n) {
        const d = source[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "\n") break; // незакрытый литерал — не regex, прекращаем
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          i++;
          break;
        }
        i++;
      }
      while (i < n && /[dgimsuvy]/.test(source[i])) i++;
      push(" ", false);
      prevChar = "/";
      prevWord = "";
      continue;
    }

    push(c, false);
    // Пробел токеном не является, но и «слово» не разрывает: `return /re/`
    // обязан определяться как regex.
    if (!/\s/.test(c)) {
      prevChar = c;
      if (/[A-Za-z0-9_$]/.test(c)) prevWord += c;
      else prevWord = "";
    }
    i++;
  }
  return { code: out, inString };
}

/** Очищенный от комментариев и regex-литералов исходник (без маски строк). */
export function stripComments(source: string): string {
  return stripSource(source).code;
}

/** Результат разбора значения `allowedDevOrigins`. */
export interface ParsedDevOrigins {
  /** Ключ найден (в любом виде). */
  found: boolean;
  /** Строковые литералы, которые удалось прочитать. */
  entries: string[];
  /** Значение разобрано полностью: нет вычисляемых частей. */
  complete: boolean;
  /**
   * Слово `allowedDevOrigins` в файле встречается, но ключ со значением не
   * распознан (вычисляемый ключ вида `{ [ORIGINS_KEY]: [...] }`, нестандартная
   * форма записи). Значение опции неизвестно — это неоднозначность, а не
   * доказанное отсутствие.
   */
  ambiguous?: boolean;
}

/** Слова, встречающиеся в литеральных конфигах и не означающие вычислимое значение. */
const NOISE_WORDS = new Set(["as", "const", "satisfies", "true", "false", "null", "undefined"]);

/**
 * Ищет ключ `allowedDevOrigins` и разбирает его значение.
 *
 * Поддерживаемые формы записи: `module.exports = { allowedDevOrigins: [...] }`,
 * `export default { allowedDevOrigins: [...] }`, `defineNextConfig({ ... })`,
 * `const nextConfig = { allowedDevOrigins: [...] }`, `"allowedDevOrigins": [...]`,
 * `nextConfig.allowedDevOrigins = [...]`.
 *
 * Ключом не считаются: `allowedDevOrigins?: string[]` (аннотация типа TS),
 * `other.allowedDevOrigins: [...]` (чтение чужого свойства без присваивания),
 * упоминание слова в комментарии или внутри произвольной строки
 * (`"см. allowedDevOrigins: ..."` — не ключ).
 */
export function parseAllowedDevOrigins(source: string): ParsedDevOrigins {
  const { code, inString } = stripSource(source);
  const keyRe = /allowedDevOrigins/g;
  let match: RegExpExecArray | null;
  let ambiguous = false;

  while ((match = keyRe.exec(code)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    if (inString[start]) {
      // Строковый литерал, целиком равный слову, — это либо ключ объекта в
      // кавычках (`"allowedDevOrigins": [...]`), либо значение, например имя
      // вычисляемого ключа (`const K = "allowedDevOrigins"; { [K]: [...] }`).
      const open = code[start - 1];
      const close = code[end];
      if ((open !== '"' && open !== "'") || close !== open) continue; // слово внутри текста
      const afterQuote = code.slice(end + 1);
      if (/^\s*[:=]/.test(afterQuote)) return parseValueExpression(afterQuote.replace(/^\s*[:=]\s*/, ""));
      ambiguous = true; // строка — значение, опция задаётся через неё
      continue;
    }

    const prevNonSpace = code.slice(Math.max(0, start - 24), start).replace(/\s+$/, "");
    const prevChar = prevNonSpace.slice(-1);
    if (prevChar === ".") {
      // Допустима только форма присваивания: `cfg.allowedDevOrigins = [...]`.
      if (!/^\s*=([^=])/.test(code.slice(end))) continue; // чтение чужого свойства
    } else if (/[A-Za-z0-9_$]/.test(prevChar)) {
      continue; // часть другого идентификатора
    }

    const after = code.slice(end);
    const valueStart = /^\s*(\??)\s*([:=])/.exec(after);
    if (!valueStart) continue;
    if (valueStart[1] === "?") continue; // аннотация типа: `allowedDevOrigins?: string[]`

    return parseValueExpression(after.slice(valueStart[0].length).replace(/^\s+/, ""));
  }

  // Ключ со значением не распознан, хотя опция упоминается как значение
  // (вычисляемый ключ): утверждать «опции нет» нельзя.
  return { found: false, entries: [], complete: false, ambiguous };
}

/** Разбор выражения значения: массив строк, одиночная строка либо «не разобрано». */
function parseValueExpression(text: string): ParsedDevOrigins {
  const first = text[0] ?? "";

  // Одиночная строка: схема Next требует массив, но проект мог написать строку.
  if (first === '"' || first === "'" || first === "`") {
    const literal = readStringLiteral(text, 0);
    if (literal && !literal.interpolated) return { found: true, entries: [literal.value], complete: true };
    return { found: true, entries: [], complete: false };
  }

  if (first !== "[") {
    // Переменная, вызов функции, spread, тернарник — достоверно не разобрать.
    return { found: true, entries: [], complete: false };
  }

  const entries: string[] = [];
  let complete = true;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const literal = readStringLiteral(text, i);
      if (!literal) {
        complete = false;
        break;
      }
      if (literal.interpolated) complete = false;
      else if (depth === 1) entries.push(literal.value);
      i = literal.end;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") {
      depth++;
      if (depth > 1) complete = false; // вложенные структуры — не плоский список строк
      continue;
    }
    if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (c === "]" && depth === 0) break;
      continue;
    }
    if (c === "." && text[i + 1] === "." && text[i + 2] === ".") {
      complete = false; // spread: часть значений приходит извне
      i += 2;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      const word = /^[A-Za-z0-9_$]+/.exec(text.slice(i))?.[0] ?? "";
      if (word && !NOISE_WORDS.has(word)) complete = false; // идентификатор/вызов
      i += Math.max(0, word.length - 1);
      continue;
    }
  }
  return { found: true, entries, complete };
}

/** Прочитанный строковый литерал. */
interface StringLiteral {
  value: string;
  /** Индекс последнего символа литерала (включая закрывающую кавычку). */
  end: number;
  /** Есть ли интерполяция `${...}` — такое значение недостоверно. */
  interpolated: boolean;
}

function readStringLiteral(text: string, start: number): StringLiteral | null {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  let interpolated = false;
  let i = start + 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      value += text[i + 1] ?? "";
      i++;
      continue;
    }
    if (quote === "`" && c === "$" && text[i + 1] === "{") {
      interpolated = true;
      let nested = 1;
      i += 2;
      while (i < text.length && nested > 0) {
        if (text[i] === "{") nested++;
        else if (text[i] === "}") nested--;
        i++;
      }
      i--;
      continue;
    }
    if (c === quote) return { value, end: i, interpolated };
    value += c;
  }
  return null; // незакрытая строка
}

/**
 * Формулировка последствия для текста предупреждения: Next.js либо блокирует
 * запрос (403), либо пока только печатает предупреждение — поведение зависит от
 * версии и от того, задана ли опция вовсе.
 */
function effectPhrase(version: string | null, optionDefined: boolean): string {
  return blocksUnlistedDevOrigin(version, optionDefined)
    ? "dev-ресурсы Next.js (HMR, /_next/*) возвращают 403"
    : "dev-ресурсы Next.js (HMR, /_next/*) помечаются как cross-origin: Next.js печатает предупреждение, " +
      "а в следующих мажорных версиях блокирует их";
}

/** Короткий список доменов для текста предупреждения: длинный нечитаем. */
function formatDomains(domains: string[], max = 4): string {
  if (domains.length === 0) return "";
  if (domains.length <= max) return domains.join(", ");
  return `${domains.slice(0, max).join(", ")} и ещё ${domains.length - max}`;
}

/** Литерал списка значений для вставки в текст: `['a', '**.a']`. */
function formatEntries(entries: string[]): string {
  return `[${entries.map((e) => `'${e}'`).join(", ")}]`;
}

function emptyFinding(): NextjsAuditFinding {
  return {
    status: "not-detected",
    nextjsDetected: false,
    nextVersion: null,
    configFile: null,
    hasAllowedDevOrigins: false,
    coversPegasOrigins: false,
    checkedDomains: [],
    domainsFromContract: false,
    uncoveredDomains: [],
    configuredOrigins: [],
    builtinOrigins: [],
    recommendedOrigins: [],
    warning: null,
    hint: null,
  };
}

/** Читает JSON, не бросая исключение: битый файл — это null, а не падение аудита. */
async function readJsonSafe(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Аудит `allowedDevOrigins` для проекта. Исключений не бросает: любая ошибка
 * чтения трактуется как «данных нет», и аудит либо молчит, либо даёт мягкую
 * подсказку — но не падает и не мешает `pegas check`.
 */
export async function auditNextjsDevOrigins(
  projectRoot: string,
  options: NextjsAuditOptions = {}
): Promise<NextjsAuditFinding> {
  const finding = emptyFinding();
  let root: string;
  try {
    root = path.resolve(projectRoot);
  } catch {
    return finding;
  }

  // 1. Next.js объявлен в package.json (dependencies или devDependencies)?
  const pkg = await readJsonSafe(path.join(root, "package.json"));
  const deps = pkg?.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : null;
  const devDeps = pkg?.devDependencies && typeof pkg.devDependencies === "object" ? pkg.devDependencies : null;
  const declared: string | null =
    (deps && typeof deps.next === "string" && deps.next) ||
    (devDeps && typeof devDeps.next === "string" && devDeps.next) ||
    null;
  if (!declared) return finding;

  // 2. Установленная версия важнее объявленного диапазона: `^14.2.0` может
  //    развернуться и в 14.2.20 (опции нет), и в 14.2.33 (опция есть).
  const installed = await readJsonSafe(path.join(root, "node_modules", "next", "package.json"));
  finding.nextjsDetected = true;
  finding.nextVersion =
    (installed && typeof installed.version === "string" && installed.version) || declared;

  // 3. Область аудита: dev-домены проекта в зоне .localhost.
  const domainsProvided = Array.isArray(options.devDomains);
  const normalized = (options.devDomains ?? []).map((d) => normalizeDomain(String(d ?? ""))).filter(Boolean);
  const localhostDomains = normalized.filter((d) => d === "localhost" || d.endsWith(".localhost"));
  if (domainsProvided && localhostDomains.length === 0) {
    finding.status = "not-applicable";
    return finding;
  }
  finding.domainsFromContract = domainsProvided;
  // `localhost` разрешён Next.js всегда — проверять его смысла нет.
  // Если контракт доменов не дал, покрытие проверяется на канонических формах
  // Pegas: это внутренние пробы, в результат они не попадают (выдавать их за
  // реальные домены проекта было бы неправдой).
  const probeDomains = (domainsProvided ? localhostDomains : GENERIC_PEGAS_DOMAINS).filter((d) => d !== "localhost");
  if (probeDomains.length === 0) {
    finding.status = "not-applicable";
    return finding;
  }
  finding.checkedDomains = domainsProvided ? probeDomains : [];
  finding.recommendedOrigins = recommendedDevOrigins(domainsProvided ? localhostDomains : undefined);

  // 4. Версия Next.js знает опцию? До 15.3.0/14.2.30 её нет: советовать
  //    бессмысленно, а её наличие в конфиге Next отметит как неизвестную опцию.
  if (!supportsAllowedDevOrigins(finding.nextVersion)) {
    finding.status = "unsupported";
    return finding;
  }

  // 5. Файл конфига: порядок загрузки Next.js, только корень проекта.
  // Существование и чтение разделены: файл, который не читается (права, EISDIR),
  // обязан давать мягкую подсказку, а не утверждение «опции нет».
  let configText: string | null = null;
  for (const name of CONFIG_FILE_ORDER) {
    const file = path.join(root, name);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue; // файла нет — пробуем следующий
    }
    if (!stat.isFile()) continue;
    finding.configFile = name;
    try {
      configText = await fs.readFile(file, "utf-8");
    } catch {
      configText = null;
    }
    break;
  }

  const legacy = usesLegacyWildcardMatcher(finding.nextVersion);
  finding.builtinOrigins = builtinDevOrigins(finding.nextVersion);
  // Без контракта имя проекта неизвестно: рецепт даётся плейсхолдерами,
  // инструмент не выдумывает реальные hostname.
  if (!domainsProvided) {
    finding.recommendedOrigins = legacy
      ? ["<project>.localhost", "**.<project>.localhost"]
      : ["**.localhost"];
  }
  const recipe = formatEntries(finding.recommendedOrigins);
  // Середина сообщения — цельное предложение «где и что происходит». С
  // конкретными доменами из контракта это утверждение; без контракта реальные
  // имена неизвестны, поэтому факт публикации dev-сервисов на доменах шлюза
  // подаётся как условие — чтобы не обвинять проект, у которого таких доменов
  // может вовсе не быть.
  const consequence = (domains: string[], optionDefined: boolean): string => {
    const effect = effectPhrase(finding.nextVersion, optionDefined);
    return domainsProvided
      ? `На доменах шлюза Pegas (${formatDomains(domains)}) ${effect}.`
      : `Если проект публикует dev-сервисы на доменах шлюза Pegas вида ` +
        `<service>.<project>.localhost, ${effect}.`;
  };

  // Встроенный список Next.js — часть эффективного покрытия: если он уже
  // разрешает домены проекта, предупреждение было бы ложным.
  if (probeDomains.every((d) => isDevOriginCovered(d, finding.builtinOrigins, legacy))) {
    finding.status = "ok";
    finding.coversPegasOrigins = true;
    return finding;
  }

  if (finding.configFile === null) {
    finding.status = "missing-config";
    finding.uncoveredDomains = domainsProvided
      ? probeDomains.filter((d) => !isDevOriginCovered(d, finding.builtinOrigins, legacy))
      : [];
    finding.warning =
      `Next.js: next.config.* не найден. ${consequence(finding.uncoveredDomains, false)} ` +
      `Создайте next.config.ts с allowedDevOrigins: ${recipe} и перезапустите dev-сервер (${NEXTJS_GUIDE_PATH}).`;
    return finding;
  }

  if (configText === null) {
    // Файл существует, но прочитать его не удалось: не утверждаем, что опции нет.
    finding.status = "indeterminate";
    const names = domainsProvided ? ` (${formatDomains(finding.checkedDomains)})` : "";
    finding.hint =
      `Next.js: не удалось прочитать ${finding.configFile} — проверьте вручную, что allowedDevOrigins покрывает ` +
      `домены шлюза Pegas${names} (${NEXTJS_GUIDE_PATH}).`;
    return finding;
  }

  // 6. Ключ и его значение.
  const parsed = parseAllowedDevOrigins(configText);
  finding.hasAllowedDevOrigins = parsed.found;
  finding.configuredOrigins = parsed.entries;

  const effective = [...finding.builtinOrigins, ...parsed.entries];
  const uncovered = probeDomains.filter((d) => !isDevOriginCovered(d, effective, legacy));
  if (uncovered.length === 0) {
    finding.status = "ok";
    finding.coversPegasOrigins = true;
    return finding;
  }
  finding.uncoveredDomains = domainsProvided ? uncovered : [];
  const uncoveredPhrase = domainsProvided ? ` (${formatDomains(uncovered)})` : "";

  if (!parsed.found) {
    // Опция упоминается, но разобрать её не удалось (например, вычисляемый
    // ключ объекта): неоднозначность вместо обвинения.
    if (parsed.ambiguous) {
      finding.status = "indeterminate";
      finding.hint =
        `Next.js: не удалось разобрать allowedDevOrigins в ${finding.configFile} — проверьте вручную, что значение ` +
        `покрывает домены шлюза Pegas${uncoveredPhrase} (${NEXTJS_GUIDE_PATH}).`;
      return finding;
    }
    finding.status = "missing-option";
    finding.warning =
      `Next.js: в ${finding.configFile} отсутствует allowedDevOrigins. ${consequence(uncovered, false)} ` +
      `Добавьте allowedDevOrigins: ${recipe} и перезапустите dev-сервер (${NEXTJS_GUIDE_PATH}).`;
    return finding;
  }

  // Значение вычисляемое: часть списка могла прийти из переменной или спреда —
  // ложное предупреждение хуже подсказки проверить конфиг руками.
  if (!parsed.complete) {
    finding.status = "indeterminate";
    finding.hint =
      `Next.js: значение allowedDevOrigins в ${finding.configFile} вычисляется динамически — pegas check не может ` +
      `проверить покрытие доменов шлюза${uncoveredPhrase}. Убедитесь, что список содержит их${
        domainsProvided ? "" : " (или шаблоны зоны .localhost)"
      } (${NEXTJS_GUIDE_PATH}).`;
    return finding;
  }

  finding.status = "not-covered";
  // Частая ловушка: `*.localhost` соответствует ровно одному уровню поддомена и
  // не покрывает `<service>.<project>.localhost`, а в ветке 14.2 не работает вовсе.
  const hasSingleStar = parsed.entries.some((e) => e.trim().toLowerCase() === "*.localhost");
  const trap = hasSingleStar
    ? legacy
      ? " В Next.js 14.2 шаблоны `*.localhost` и `**.localhost` не сопоставляются — нужны точное имя зоны и `**.<project>.localhost`."
      : " Шаблон `*.localhost` соответствует одному уровню поддомена и не покрывает `<service>.<project>.localhost`."
    : "";
  // Опция задана — значит Next.js работает в режиме block на всех версиях,
  // где опция существует: непокрытый origin получает 403.
  finding.warning =
    `Next.js: allowedDevOrigins в ${finding.configFile} не покрывает часть dev-доменов. ` +
    `${consequence(uncovered, true)}${trap} Добавьте allowedDevOrigins: ${recipe} ` +
    `и перезапустите dev-сервер (${NEXTJS_GUIDE_PATH}).`;
  return finding;
}

