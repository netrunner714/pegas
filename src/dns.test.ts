import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isPublicDomain, getPublicIp, validateDomains } from "./dns.js";

describe("DNS pre-flight validation", () => {
  const origEnv = process.env.PEGAS_SERVER_IP;

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.PEGAS_SERVER_IP = origEnv;
    } else {
      delete process.env.PEGAS_SERVER_IP;
    }
  });

  describe("isPublicDomain", () => {
    it("identifies public production domains", () => {
      expect(isPublicDomain("example.com")).toBe(true);
      expect(isPublicDomain("api.my-app.co.uk")).toBe(true);
      expect(isPublicDomain("магазин.рф")).toBe(true);
    });

    it("filters out local development domains, IPs, and placeholders", () => {
      expect(isPublicDomain("localhost")).toBe(false);
      expect(isPublicDomain("app.localhost")).toBe(false);
      expect(isPublicDomain("test.local")).toBe(false);
      expect(isPublicDomain("service.test")).toBe(false);
      expect(isPublicDomain("127.0.0.1")).toBe(false);
      expect(isPublicDomain("192.168.1.10")).toBe(false);
      expect(isPublicDomain("yourdomain.com")).toBe(false);
      expect(isPublicDomain("")).toBe(false);
    });
  });

  describe("getPublicIp", () => {
    it("respects PEGAS_SERVER_IP environment variable override", async () => {
      process.env.PEGAS_SERVER_IP = "198.51.100.42";
      const ip = await getPublicIp();
      expect(ip).toBe("198.51.100.42");
    });
  });

  describe("validateDomains", () => {
    it("skips validation when skipDnsCheck is true", async () => {
      const res = await validateDomains(["nonexistent-123456789.com"], {
        skipDnsCheck: true,
      });
      expect(res.valid).toBe(true);
      expect(res.warnings.length).toBe(0);
    });

    it("skips non-public / localhost domains automatically", async () => {
      const res = await validateDomains(["localhost", "dev.localhost", "127.0.0.1"], {
        serverIp: "1.1.1.1",
        strictDns: true,
      });
      expect(res.valid).toBe(true);
      expect(res.warnings.length).toBe(0);
    });

    it("detects IP mismatch against known public domain", async () => {
      // dns.google resolves to 8.8.8.8 / 8.8.4.4
      const res = await validateDomains(["dns.google"], {
        serverIp: "192.0.2.1", // dummy documentation IP
        strictDns: false,
        json: true,
      });
      expect(res.valid).toBe(false);
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.warnings[0]).toContain("resolves to");
      expect(res.warnings[0]).toContain("this server's public IP is 192.0.2.1");
    });

    it("detects ENOTFOUND for non-existent domains", async () => {
      const bogusDomain = "bogus-random-subdomain-xyz-987654321.com";
      const res = await validateDomains([bogusDomain], {
        serverIp: "192.0.2.1",
        strictDns: false,
        json: true,
      });
      expect(res.valid).toBe(false);
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.warnings[0]).toContain("ENOTFOUND");
    });

    it("fails with strictDns when domain does not match server IP", async () => {
      const res = await validateDomains(["dns.google"], {
        serverIp: "192.0.2.99",
        strictDns: true,
        json: true,
      });
      expect(res.valid).toBe(false);
    });

    it("passes when domain resolves to the matching server IP", async () => {
      // dns.google resolves to 8.8.8.8
      const res = await validateDomains(["dns.google"], {
        serverIp: "8.8.8.8",
        strictDns: true,
        json: true,
      });
      expect(res.valid).toBe(true);
      expect(res.warnings.length).toBe(0);
    });
  });
});
