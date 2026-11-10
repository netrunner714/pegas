/**
 * Runtime SDK Pegas (столп 6 RFC v3): типизированный доступ к контексту
 * оркестрации из кода приложения. Транспорт — env PEGAS_CONTEXT (инжектируется
 * в каждый контейнер pegas-манифестом) либо файл .pegas/context.json
 * (host-сервисы, локальный запуск). Ноль зависимостей.
 *
 *   import { currentService, services, getContext } from "@netrunner714/pegas/runtime";
 *
 * Вычисления (internalUrl, url, rootDomain) — та же семантика, что pegas://
 * в env-контракте: единственный источник истины.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Контекст одного сервиса сценария (см. buildSdkContext в runtime-compose). */
export interface SdkServiceInfo {
  driver: "docker" | "bun";
  port?: number;
  alias?: string;
  scheme: string;
  internalUrl?: string;
  domains?: string[];
  url?: string;
}

/** Контекст проекта для текущего сценария. */
export interface SdkContext {
  project: string;
  projectId: string;
  scenario: string;
  service: string;
  services: Record<string, SdkServiceInfo>;
  /** Несекретный конфиг текущего сервиса из services.<name>.env контракта, уже развёрнутый по сценарию. */
  env?: Record<string, string>;
}

/** Информация о текущем сервисе — собственный port, домены и их производные. */
export interface CurrentService {
  name: string;
  scenario: string;
  port?: number;
  domains: string[];
  /** Первый домен с https:// (актуальная публичная ссылка). */
  url?: string;
  /**
   * Корень домена для cookie: базовый registrable-домен первого домена.
   * "localhost" в dev, ".example.com" в prod.
   */
  rootDomain: string;
}

let cached: SdkContext | undefined;

/** Сброс кэша (только для тестов: контекст инжектится один раз за жизнь процесса). */
export function _resetForTests(): void {
  cached = undefined;
}

/** Ошибка запуска SDK вне pegas-оркестрации — с инструкцией, что делать. */
export class PegasRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PegasRuntimeError";
  }
}

function parseContext(raw: string, source: string): SdkContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PegasRuntimeError(source + " содержит невалидный JSON.");
  }
  const ctx = parsed as SdkContext;
  if (!ctx || typeof ctx !== "object" || typeof ctx.service !== "string" || !ctx.services) {
    throw new PegasRuntimeError(source + " не выглядит контекстом Pegas (нет service/services).");
  }
  return ctx;
}

/**
 * Загружает контекст один раз и кэширует: env PEGAS_CONTEXT приоритетнее,
 * затем .pegas/context.json относительно cwd или модуля.
 */
export function getContext(): SdkContext {
  if (cached) return cached;
  const fromEnv = process.env.PEGAS_CONTEXT;
  if (fromEnv) {
    cached = parseContext(fromEnv, "PEGAS_CONTEXT");
    return cached;
  }
  const candidates = [
    path.join(process.cwd(), ".pegas", "context.json"),
    path.join(fileURLToPath(new URL(".", import.meta.url)), ".pegas", "context.json"),
  ];
  for (const file of candidates) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    cached = parseContext(raw, file);
    return cached;
  }
  throw new PegasRuntimeError(
    "Контекст Pegas не найден: нет env PEGAS_CONTEXT и файла .pegas/context.json. " +
      "Код исполняется вне pegas-оркестрации — запустите сервис через pegas (deploy/dev) или добавьте PEGAS_CONTEXT."
  );
}

/** Карта всех сервисов текущего сценария: name → адреса. */
export function services(): Record<string, SdkServiceInfo> {
  return getContext().services;
}

/**
 * Текущий сервис: port для listen, rootDomain для cookie.
 * Генерирует ошибку с подсказкой, если контекст не инжектирован.
 */
export function currentService(): CurrentService {
  const ctx = getContext();
  const info = ctx.services[ctx.service];
  if (!info) {
    throw new PegasRuntimeError(
      'Сервис "' + ctx.service + '" отсутствует в PEGAS_CONTEXT.services — контракт изменён после генерации манифеста?'
    );
  }
  return {
    name: ctx.service,
    scenario: ctx.scenario,
    port: info.port,
    domains: info.domains ?? [],
    url: info.url,
    rootDomain: rootDomainOf(info.domains?.[0] ?? "localhost"),
  };
}

/**
 * Корень домена для cookie: ".example.com" от "app.example.com",
 * "localhost" от "app.localhost". Публичные суффиксы из двух частей
 * (example.com) считаются корнем; трёхчастные (app.example.co.uk) —
 * упрощённо отрезают последнюю метку тройного уровня.
 */
export function rootDomainOf(domain: string): string {
  const host = domain.replace(/^https?:\/\//, "").split(":")[0];
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  return "." + parts.slice(-2).join(".");
}

/** Опциональный секрет: string | undefined без ошибки — для секретов, осознанно
 * не заданных в части сценариев (например, интеграции, выключенные в dev).
 * Обязательность проверяет приложение своей логикой валидации.
 */
export function optionalSecret(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Читает секрет из env с понятной ошибкой (список ожидаемых — в PEGAS_SECRETS). */
export function secret(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    const expected = process.env.PEGAS_SECRETS;
    throw new PegasRuntimeError(
      'Секрет "' + name + '" не задан.' +
        (expected ? " Ожидались: " + expected + "." : " Проверьте .pegas или CI-хранилище.")
    );
  }
  return value;
}

/**
 * Типизированный доступ к несекретному конфигу из services.<name>.env контракта.
 * Источник — PEGAS_CONTEXT.env (уже развёрнут по сценарию, pegas:// — во внутренний
 * адрес); для старых манифестов без env в контексте — фолбэк на process.env,
 * куда манифест тоже инжектит env-карту. Секреты через config() не читают.
 */
export function optionalConfig(name: string): string | undefined {
  try {
    const ctx = getContext();
    if (ctx.env !== undefined) {
      const v = ctx.env[name];
      return v === undefined || v === "" ? undefined : v;
    }
  } catch {
    // нет контекста — фолбэк на process.env ниже
  }
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Читает несекретный конфиг с понятной ошибкой, если ключ не объявлен в контракте. */
export function config(name: string): string {
  const value = optionalConfig(name);
  if (value === undefined) {
    throw new PegasRuntimeError(
      'Конфиг "' + name + '" не задан. Объявите его в pegas.json (services.<сервис>.env) для текущего сценария.'
    );
  }
  return value;
}
