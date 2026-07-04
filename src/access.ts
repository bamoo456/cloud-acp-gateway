import type os from "node:os";

export interface AccessUrlsOptions {
  listen: string;
  path: string;
  scheme: string;
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

interface ListenParts {
  host: string;
  port: string;
}

export function accessUrls(opts: AccessUrlsOptions): string[] {
  const listen = parseListen(opts.listen);
  const hosts = accessHosts(listen.host, opts.interfaces);
  const path = normalizePath(opts.path);
  return hosts.map((host) => `${opts.scheme}://${formatHost(host)}:${listen.port}${path}`);
}

function parseListen(listen: string): ListenParts {
  const raw = listen.trim();
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close >= 0) {
      const host = raw.slice(1, close);
      const port = raw.slice(close + 1).replace(/^:/, "") || "8080";
      return { host: host || "::", port };
    }
  }

  const split = raw.lastIndexOf(":");
  if (split >= 0) {
    return {
      host: raw.slice(0, split) || "0.0.0.0",
      port: raw.slice(split + 1) || "8080",
    };
  }
  return { host: raw || "0.0.0.0", port: "8080" };
}

function accessHosts(host: string, interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  if (!isWildcardHost(host)) return [host];

  const hosts = new Set<string>(["127.0.0.1"]);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!isUsableIPv4(entry)) continue;
      hosts.add(entry.address);
    }
  }
  return [...hosts];
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "*";
}

function isUsableIPv4(entry: os.NetworkInterfaceInfo): boolean {
  const family = String(entry.family);
  return (
    (family === "IPv4" || family === "4") &&
    !entry.internal &&
    !entry.address.startsWith("169.254.")
  );
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizePath(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}
