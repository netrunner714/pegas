import { installCa, removeCa, type CaInstallOptions, type CaRemoveOptions } from "../ca.js";

export async function handleCa(options: CaInstallOptions & CaRemoveOptions & { action?: string } = {}): Promise<boolean> {
  const action = options.action;
  const json = options.json ?? false;

  if (action !== "install" && action !== "remove") {
    const message = "Не указано действие: 'pegas ca install' или 'pegas ca remove'.";
    if (json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(`❌ ${message}`);
    }
    if (!options.noExit) {
      process.exit(1);
    }
    return false;
  }

  if (action === "install") {
    return await installCa({
      json,
      dryRun: options.dryRun,
      noExit: options.noExit,
      paths: (options as CaInstallOptions).paths,
      caddyPath: (options as CaInstallOptions).caddyPath,
      skipTrust: (options as CaInstallOptions).skipTrust,
    });
  }

  return await removeCa({
    json,
    dryRun: options.dryRun,
    noExit: options.noExit,
    paths: (options as CaRemoveOptions).paths,
  });
}