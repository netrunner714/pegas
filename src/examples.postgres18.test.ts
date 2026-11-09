import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * issue #26: образы postgres:18+ хранят данные в каталогах по мажорным версиям
 * и ожидают единое монтирование в /var/lib/postgresql. Том на .../data (путь для
 * 17 и старше) приводит к рестарт-лупу контейнера, поэтому примеры в репозитории
 * обязаны использовать путь 18+ — тест фиксирует это и ловит регрессию.
 */

const LEGACY_PGDATA = "/var/lib/postgresql/data";
const PG18_MOUNT = "/var/lib/postgresql";

/** Том в compose short syntax: "pgdata:/var/lib/postgresql/data" → "/var/lib/postgresql/data". */
function mountOf(volume: string): string | undefined {
  const parts = volume.split(":");
  return parts.length >= 2 ? parts[1] : undefined;
}

/** Все значения томов из JSON-документа: ключ volumes → массив строк (или объект таких массивов). */
function collectVolumeValues(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectVolumeValues(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "volumes") {
        if (Array.isArray(value)) {
          for (const entry of value) if (typeof entry === "string") out.push(entry);
        } else if (value && typeof value === "object") {
          for (const list of Object.values(value)) {
            if (Array.isArray(list)) {
              for (const entry of list) if (typeof entry === "string") out.push(entry);
            }
          }
        }
      }
      collectVolumeValues(value, out);
    }
  }
  return out;
}

describe("примеры: путь тома postgres:18+ (issue #26)", () => {
  it("JSON-артефакты не монтируют legacy-путь .../data", async () => {
    for (const artifact of ["example.json", "schemas/pegas.json"]) {
      const raw = await fs.readFile(path.join(process.cwd(), artifact), "utf-8");
      const legacy = collectVolumeValues(JSON.parse(raw)).filter((v) => mountOf(v) === LEGACY_PGDATA);
      expect({ artifact, legacy }).toEqual({ artifact, legacy: [] });
    }
  });

  it("README и llms.txt: ни одного примера тома с legacy-путём", async () => {
    for (const artifact of ["README.md", "llms.txt"]) {
      const raw = await fs.readFile(path.join(process.cwd(), artifact), "utf-8");
      // Примеры томов в текстах — в кавычках JSON: ловим именно их, не прозу.
      expect(raw.includes(`"${LEGACY_PGDATA}`)).toBe(false);
      expect(raw.includes(`${LEGACY_PGDATA}"`)).toBe(false);
    }
  });

  it("example.json: postgres:18-сервис монтирует том в /var/lib/postgresql", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "example.json"), "utf-8");
    const contract = JSON.parse(raw);
    const pg18 = Object.entries<any>(contract.services).filter(([, svc]) =>
      Object.values<any>(svc.image ?? {}).some((img: string) => String(img).startsWith("postgres:18"))
    );
    expect(pg18.length).toBeGreaterThan(0);
    for (const [name, svc] of pg18) {
      const volumes: string[][] = Object.values(svc.volumes ?? {});
      expect(volumes.length).toBeGreaterThan(0);
      for (const list of volumes) {
        for (const entry of list) {
          expect({ service: name, mount: mountOf(entry) }).toEqual({ service: name, mount: PG18_MOUNT });
        }
      }
    }
  });

  it("schemas/pegas.json: примеры volumes используют путь 18+", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "schemas/pegas.json"), "utf-8");
    const volumes = collectVolumeValues(JSON.parse(raw)).filter((v) => v.startsWith("pgdata:"));
    expect(volumes.length).toBeGreaterThan(0);
    for (const entry of volumes) {
      expect(mountOf(entry)).toBe(PG18_MOUNT);
    }
  });
});
