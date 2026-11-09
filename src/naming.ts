import { createHash } from "node:crypto";

/**
 * Нейминг Docker-сущностей Pegas (issue #27).
 *
 * До 3.2.0 compose-проект задавался как `${runtimeId}-${scenario}`, из-за чего
 * Docker генерировал имена вида `0a1b0e24d9-development-db-1`: в `docker ps`
 * нельзя было определить ни проект, ни сервис, ни принадлежность к Pegas.
 *
 * Схема 3.2.0:
 * - контейнер:      `pegas-<проект>-<сервис>-<сценарий>-<runtimeId>`
 * - compose-проект: `pegas-<проект>-<сценарий>-<runtimeId>`
 *
 * `runtimeId` остаётся в имени и защищает от коллизий: одно projectName на
 * машину может встречаться в нескольких checkout'ах, и хэш каталога различает их.
 * Он же удерживает имена стабильными между деплоями — детерминированное имя
 * даёт идемпотентность `compose up`.
 *
 * Сетевые алиасы (`<runtimeId>-<scenario>-<service>`) намеренно НЕ меняются:
 * на них ссылаются upstream'ы маршрутных файлов шлюза и развёрнутые значения
 * `pegas://` в контейнерах.
 */

/**
 * Предел длины DNS-метки (RFC 1035): имя контейнера длиннее 63 символов
 * перестаёт резолвиться встроенным DNS Docker, хотя `docker create` его
 * принимает. Проверено: 76 символов → getent не находит хост, 43 → находит.
 * compose-проект ограничен тем же значением для согласованности.
 */
const MAX_DNS_LABEL = 63;

/** Длина хвоста, добавляемого при усечении длинной части имени. */
const DIGEST_LEN = 6;

/** Приведение части имени к допустимому для Docker алфавиту. */
function slug(part: string): string {
  return part
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * Усечение с сохранением различимости: голова значения плюс короткий дайджест
 * полного исходника. Дайджест детерминирован, поэтому имя стабильно между
 * деплоями, а разные длинные имена не схлопываются в одно.
 */
function truncateWithDigest(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, DIGEST_LEN);
  const head = value.slice(0, Math.max(1, budget - DIGEST_LEN - 1)).replace(/[-_]+$/g, "");
  return `${head}-${digest}`;
}

/**
 * Сборка имени из частей с гарантией предела DNS-метки.
 *
 * `shrinkOrder` — индексы частей в `segments`, которые можно укорачивать,
 * от менее значимой к более значимой. Индексы относятся к исходному массиву:
 * пустые части пропускаются при склейке, но позиции остальных не сдвигаются.
 * Незатронутые части (префикс, runtimeId) сохраняются целиком: runtimeId —
 * якорь уникальности, его усечение вернуло бы риск коллизий.
 */
function fitToDnsLabel(segments: string[], shrinkOrder: number[]): string {
  const join = (list: string[]) => list.filter((s) => s.length > 0).join("-");
  const mutable = [...segments];
  if (join(mutable).length <= MAX_DNS_LABEL) return join(mutable);

  for (const index of shrinkOrder) {
    if (join(mutable).length <= MAX_DNS_LABEL) break;
    const current = mutable[index] ?? "";
    if (current.length === 0) continue;
    const overflow = join(mutable).length - MAX_DNS_LABEL;
    const budget = Math.max(DIGEST_LEN + 2, current.length - overflow);
    mutable[index] = truncateWithDigest(current, budget);
  }

  const name = join(mutable);
  if (name.length <= MAX_DNS_LABEL) return name;

  // Страховка от превышения при экстремальных входах: укорачиваем усекаемые
  // части до минимума в порядке значимости (runtimeId не трогаем — уникальность).
  for (const index of shrinkOrder) {
    if (join(mutable).length <= MAX_DNS_LABEL) break;
    const current = mutable[index] ?? "";
    if (current.length <= DIGEST_LEN + 2) continue;
    mutable[index] = truncateWithDigest(current, DIGEST_LEN + 2);
  }

  const fitted = join(mutable);
  if (fitted.length <= MAX_DNS_LABEL) return fitted;

  // Последний рубеж: неусекаемые части сами длиннее предела. Отрезаем голову,
  // а не хвост — в хвосте runtimeId, то есть уникальность имени.
  const tail = fitted.slice(fitted.length - MAX_DNS_LABEL);
  return tail.replace(/^[-_]+/, "") || tail;
}

export interface ComposeProjectNameParts {
  /** `projectName` из контракта. */
  projectName: string;
  /** Имя сценария (`development`, `stage`, `production`, …). */
  scenario: string;
  /** Идентификатор рантайм-инсталляции (`getProjectRuntimeId`). */
  runtimeId: string;
}

export interface ContainerNameParts extends ComposeProjectNameParts {
  /** Имя сервиса из контракта. */
  service: string;
}

/**
 * Имя compose-проекта сценария: `pegas-<проект>-<сценарий>-<runtimeId>`.
 *
 * Сервис в имя проекта не входит — проект содержит все сервисы сценария,
 * а compose подставляет их сам (`container_name` задаётся явно).
 */
export function composeProjectName(parts: ComposeProjectNameParts): string {
  const segments = ["pegas", slug(parts.projectName), slug(parts.scenario), slug(parts.runtimeId)];
  // Усекается projectName: сценарий и runtimeId короче и значимее для различения.
  return fitToDnsLabel(segments, [1]);
}

/**
 * Имя контейнера сервиса: `pegas-<проект>-<сервис>-<сценарий>-<runtimeId>`.
 *
 * Задаётся в манифесте через `container_name`, поэтому `docker ps` показывает
 * проект, сервис, сценарий и checkout — без случайных хешей в начале.
 */
export function containerName(parts: ContainerNameParts): string {
  const segments = [
    "pegas",
    slug(parts.projectName),
    slug(parts.service),
    slug(parts.scenario),
    slug(parts.runtimeId),
  ];
  // Порядок усечения: сценарий → сервис → проект. Проект и сервис — то, ради
  // чего имена читаемы (issue #27), поэтому сохраняются последними; сценарий
  // дублируется именем compose-проекта и меткой pegas.scenario.
  return fitToDnsLabel(segments, [3, 2, 1]);
}

/**
 * Имя Docker-тома, закреплённое в манифесте явно.
 *
 * Совпадает с тем, что compose создавал до переименования проекта
 * (`<runtimeId>-<scenario>_<том>`): без явного `name:` том получил бы префикс
 * нового проекта, а существующие тома с данными остались бы сиротами.
 * Идентичность тома — часть плоскости данных и не должна меняться вместе
 * с cosmetic-переименованием проекта.
 */
export function runtimeVolumeName(parts: { runtimeId: string; scenario: string; volume: string }): string {
  return `${parts.runtimeId}-${parts.scenario}_${parts.volume}`;
}
