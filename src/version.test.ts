import { describe, it, expect } from "bun:test";
import { VERSION, parseSemver, compareSemver, isSameMajor } from "./version.js";

describe("version utilities", () => {
  it("exports valid VERSION string from package.json", () => {
    expect(typeof VERSION).toBe("string");
    expect(/^\d+\.\d+\.\d+/.test(VERSION)).toBe(true);
  });

  it("parseSemver parses versions correctly with prefixes and pre-releases", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("^1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("~1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v2.9.1")).toEqual([2, 9, 1]);
    expect(parseSemver(">=1.0.0")).toEqual([1, 0, 0]);
    expect(parseSemver("1.0.0-beta.1")).toEqual([1, 0, 0]);
    expect(parseSemver("invalid")).toEqual([0, 0, 0]);
    expect(parseSemver("")).toEqual([0, 0, 0]);
  });

  it("compareSemver compares versions correctly", () => {
    expect(compareSemver("1.1.1", "1.1.0")).toBeGreaterThan(0);
    expect(compareSemver("1.1.1", "^1.1.0")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);

    expect(compareSemver("1.1.0", "1.1.1")).toBeLessThan(0);
    expect(compareSemver("1.1.1", "1.2.0")).toBeLessThan(0);

    expect(compareSemver("1.1.1", "1.1.1")).toBe(0);
    expect(compareSemver("1.1.1", "^1.1.1")).toBe(0);
  });

  it("isSameMajor checks if versions share the same major version", () => {
    expect(isSameMajor("1.1.0", "1.1.1")).toBe(true);
    expect(isSameMajor("^1.0.0", "1.99.9")).toBe(true);
    expect(isSameMajor("1.1.1", "2.0.0")).toBe(false);
    expect(isSameMajor("2.1.0", "1.9.9")).toBe(false);
  });
});
