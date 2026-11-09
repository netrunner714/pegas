import { describe, it, expect } from "bun:test";
import { composeProjectName, containerName, runtimeVolumeName } from "./naming.js";

const parts = { projectName: "815records", scenario: "development", runtimeId: "0a1b0e24d9" };

describe("naming: схема имён Pegas (issue #27)", () => {
  describe("composeProjectName", () => {
    it("pegas-<проект>-<сценарий>-<runtimeId>", () => {
      expect(composeProjectName(parts)).toBe("pegas-815records-development-0a1b0e24d9");
    });

    it("префикс pegas- есть всегда: единый неймспейс экосистемы", () => {
      expect(composeProjectName(parts).startsWith("pegas-")).toBe(true);
    });

    it("runtimeId остаётся суффиксом: защита от коллизий checkout'ов", () => {
      const a = composeProjectName({ ...parts, runtimeId: "aaaaaaaaaa" });
      const b = composeProjectName({ ...parts, runtimeId: "bbbbbbbbbb" });
      expect(a).not.toBe(b);
      expect(a.endsWith("aaaaaaaaaa")).toBe(true);
    });

    it("сценарий различает проекты одного деплоя", () => {
      expect(composeProjectName({ ...parts, scenario: "production" }))
        .toBe("pegas-815records-production-0a1b0e24d9");
    });

    it("нечистые символы приводятся к алфавиту Docker", () => {
      expect(composeProjectName({ ...parts, projectName: "My App!" }))
        .toBe("pegas-my-app-development-0a1b0e24d9");
    });

    it("имя начинается с буквы или цифры (не с дефиса)", () => {
      const name = composeProjectName({ ...parts, projectName: "-weird-" });
      expect(name).toMatch(/^[a-z0-9]/);
      expect(name.includes("--")).toBe(false);
    });

    it("пустые части не дают двойных дефисов", () => {
      expect(composeProjectName({ ...parts, scenario: "" }).includes("--")).toBe(false);
    });
  });

  describe("containerName", () => {
    it("pegas-<проект>-<сервис>-<сценарий>-<runtimeId>", () => {
      expect(containerName({ ...parts, service: "db" }))
        .toBe("pegas-815records-db-development-0a1b0e24d9");
    });

    it("из docker ps видны проект, сервис и сценарий (цель issue #27)", () => {
      const name = containerName({ ...parts, service: "db" });
      expect(name).toContain("815records");
      expect(name).toContain("db");
      expect(name).toContain("development");
      expect(name.startsWith("pegas-")).toBe(true);
    });

    it("сервис с подчёркиванием: символ сохраняется (валиден для Docker)", () => {
      expect(containerName({ ...parts, service: "redis_queue" }))
        .toBe("pegas-815records-redis_queue-development-0a1b0e24d9");
    });

    it("два сервиса одного проекта не коллизируют", () => {
      const db = containerName({ ...parts, service: "db" });
      const cache = containerName({ ...parts, service: "cache" });
      expect(db).not.toBe(cache);
    });

    it("имена детерминированы: одинаковые входы — одинаковое имя (идемпотентность up)", () => {
      expect(containerName({ ...parts, service: "db" })).toBe(containerName({ ...parts, service: "db" }));
    });

    it("нечистое имя сервиса нормализуется", () => {
      expect(containerName({ ...parts, service: "My Svc" }))
        .toBe("pegas-815records-my-svc-development-0a1b0e24d9");
    });

    it("длина имени не превышает предел DNS-метки (63 символа, RFC 1035)", () => {
      const long = containerName({
        projectName: "a-very-long-project-name-here",
        service: "another-quite-long-service-name",
        scenario: "development",
        runtimeId: "0a1b0e24d9",
      });
      // Имя длиннее метки перестаёт резолвиться встроенным DNS Docker,
      // хотя docker create его принимает — предел проверяется эмпирически.
      expect(long.length).toBeLessThanOrEqual(63);
      expect(long.startsWith("pegas-")).toBe(true);
      expect(long.includes("--")).toBe(false);
    });

    it("усечение детерминировано: одинаковые входы — одинаковое имя", () => {
      const parts = {
        projectName: "a-very-long-project-name-here",
        service: "another-quite-long-service-name",
        scenario: "development",
        runtimeId: "0a1b0e24d9",
      };
      expect(containerName(parts)).toBe(containerName(parts));
    });

    it("усечение не схлопывает разные сервисы в одно имя", () => {
      const base = {
        projectName: "a-very-long-project-name-here",
        scenario: "development",
        runtimeId: "0a1b0e24d9",
      };
      const a = containerName({ ...base, service: "another-quite-long-service-name" });
      const b = containerName({ ...base, service: "another-quite-long-other-service" });
      expect(a.length).toBeLessThanOrEqual(63);
      expect(b.length).toBeLessThanOrEqual(63);
      expect(a).not.toBe(b);
    });

    it("усечение не схлопывает разные проекты и сценарии", () => {
      const base = { service: "another-quite-long-service-name", runtimeId: "0a1b0e24d9" };
      const p1 = containerName({ ...base, projectName: "a-very-long-project-name-here", scenario: "development" });
      const p2 = containerName({ ...base, projectName: "a-very-long-project-name-there", scenario: "development" });
      const p3 = containerName({ ...base, projectName: "a-very-long-project-name-here", scenario: "production" });
      expect(new Set([p1, p2, p3]).size).toBe(3);
      for (const name of [p1, p2, p3]) expect(name.length).toBeLessThanOrEqual(63);
    });

    it("короткие имена не усекаются", () => {
      expect(containerName({ ...parts, service: "db" }))
        .toBe("pegas-815records-db-development-0a1b0e24d9");
    });
  });

  describe("предел длины compose-проекта", () => {
    it("длинное projectName усекается до предела DNS-метки", () => {
      const name = composeProjectName({
        projectName: "an-extremely-long-project-name-that-exceeds-the-label-limit",
        scenario: "development",
        runtimeId: "0a1b0e24d9",
      });
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name.startsWith("pegas-")).toBe(true);
      expect(name.endsWith("0a1b0e24d9")).toBe(true);
    });

    it("runtimeId не усекается: якорь уникальности checkout'а сохраняется", () => {
      const name = composeProjectName({
        projectName: "an-extremely-long-project-name-that-exceeds-the-label-limit",
        scenario: "development",
        runtimeId: "0a1b0e24d9",
      });
      expect(name.endsWith("0a1b0e24d9")).toBe(true);
    });

    it("разные длинные имена проекта дают разные compose-проекты", () => {
      const a = composeProjectName({
        projectName: "an-extremely-long-project-name-that-exceeds-the-label-limit",
        scenario: "development",
        runtimeId: "0a1b0e24d9",
      });
      const b = composeProjectName({
        projectName: "an-extremely-long-project-name-that-exceeds-the-label-limit2",
        scenario: "development",
        runtimeId: "0a1b0e24d9",
      });
      expect(a).not.toBe(b);
    });
  });

  describe("runtimeVolumeName", () => {
    it("совпадает с исторической схемой: <runtimeId>-<scenario>_<том>", () => {
      expect(runtimeVolumeName({ runtimeId: "0a1b0e24d9", scenario: "development", volume: "815records-pgdata" }))
        .toBe("0a1b0e24d9-development_815records-pgdata");
    });

    it("префикс не содержит pegas-: плоскость данных не следует cosmetic-неймингу", () => {
      const name = runtimeVolumeName({ runtimeId: "0a1b0e24d9", scenario: "production", volume: "pgdata" });
      expect(name.startsWith("pegas-")).toBe(false);
      expect(name).toBe("0a1b0e24d9-production_pgdata");
    });

    it("сценарий изолирует тома: development и production не пересекаются", () => {
      const dev = runtimeVolumeName({ runtimeId: "abc", scenario: "development", volume: "pgdata" });
      const prod = runtimeVolumeName({ runtimeId: "abc", scenario: "production", volume: "pgdata" });
      expect(dev).not.toBe(prod);
    });
  });
});
