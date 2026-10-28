import { describe, it, expect } from "bun:test";
import net from "node:net";
import { isPortAvailable, findAvailablePort } from "./ports.js";

describe("port allocation", () => {
  it("detects available and occupied ports", async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as net.AddressInfo;
        resolve(address.port);
      });
    });

    const isFree = await isPortAvailable(port);
    expect(isFree).toBe(false);

    await new Promise((resolve) => server.close(resolve));

    const isFreeAfterClose = await isPortAvailable(port);
    expect(isFreeAfterClose).toBe(true);
  });

  it("findAvailablePort skips excluded ports and finds next available", async () => {
    const freePort = await findAvailablePort(10000, [10000, 10001]);
    expect(freePort).toBeGreaterThanOrEqual(10002);
  });
});
