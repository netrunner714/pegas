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

export interface PortProbe {
  available: boolean;
  /** EACCES = порт запрещён политикой ОС, EADDRINUSE = занят процессом */
  errorCode?: "EACCES" | "EADDRINUSE";
}

/**
 * Зонд порта с классификацией причины недоступности.
 * EACCES важен отдельно: на WSL (mirrored networking) Windows может исключать
 * низкие порты из bind-диапазона WSL — это не «порт занят», а политика ОС,
 * и подсказка должна быть другой (не «кто-то слушает», а «порт исключён ОС»).
 */
export function probePort(port: number, host?: string): Promise<PortProbe> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve({
        available: false,
        errorCode: err.code === "EACCES" ? "EACCES" : "EADDRINUSE",
      });
    });

    const options: net.ListenOptions = { port };
    if (host) {
      options.host = host;
    }

    server.listen(options, () => {
      server.close(() => {
        resolve({ available: true });
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
