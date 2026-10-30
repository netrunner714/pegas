import net from "node:net";

/**
 * Checks whether a given TCP port is available on the machine.
 */
export function isPortAvailable(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", () => {
      resolve(false);
    });

    const options: net.ListenOptions = { port };
    if (host) {
      options.host = host;
    }

    server.listen(options, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Finds the first available port starting from startPort, skipping any excluded ports.
 */
export async function findAvailablePort(startPort: number, exclude: number[] = []): Promise<number> {
  let port = startPort;
  while (port < 65535) {
    if (!exclude.includes(port)) {
      const free = await isPortAvailable(port);
      if (free) {
        return port;
      }
    }
    port++;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
