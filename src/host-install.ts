import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseDocument, stringify, type Document } from "yaml";
import type { SupportedHost } from "./hosts.js";

export interface HostInstallResult {
  changed: boolean;
  backupPath?: string;
}

export async function installHost(
  host: SupportedHost,
  configPath: string,
  command: string,
  args: string[],
): Promise<HostInstallResult> {
  return withConfigLock(configPath, async () => {
    const shape = shapeFor(host, command, args);
    const state = await readConfig(configPath, shape.kind);
    const existing = getServer(state.value, shape.path);
    if (existing !== undefined) {
      if (sameServer(existing, command, args)) return { changed: false };
      throw new Error(
        "The existing Gossip host entry conflicts with the requested command or args.",
      );
    }
    setServer(state.value, shape.path, { command, args: [...args] });
    state.document?.setIn(shape.path, { command, args: [...args] });
    return writeConfig(configPath, shape.kind, state);
  });
}

export async function uninstallHost(
  host: SupportedHost,
  configPath: string,
  command: string,
  args: string[],
): Promise<HostInstallResult> {
  return withConfigLock(configPath, async () => {
    const shape = shapeFor(host, command, args);
    const state = await readConfig(configPath, shape.kind);
    const existing = getServer(state.value, shape.path);
    if (existing === undefined || !sameServer(existing, command, args))
      return { changed: false };
    removeServer(state.value, shape.path);
    state.document?.deleteIn(shape.path);
    return writeConfig(configPath, shape.kind, state);
  });
}

type Kind = "yaml" | "json";
type Config = Record<string, unknown>;
type Path = string[];
type ConfigState = { value: Config; document?: Document.Parsed };

function shapeFor(
  host: SupportedHost,
  command: string,
  args: string[],
): { kind: Kind; path: Path } {
  if (host !== "hermes" && host !== "openclaw" && host !== "grok-bot") {
    throw new Error(`Unsupported host: ${host}`);
  }
  if (host === "grok-bot")
    throw new Error(
      "Grok Bot installation uses the agent-only AddMcpServer API. Run host-config --host grok-bot and pass its emitted arguments to that host tool.",
    );
  if (typeof command !== "string" || command.trim() === "")
    throw new Error("A non-empty host command is required.");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new Error("Host command args must be strings.");
  return host === "hermes"
    ? { kind: "yaml", path: ["mcp_servers", "gossip"] }
    : { kind: "json", path: ["mcp", "servers", "gossip"] };
}

async function readConfig(path: string, kind: Kind): Promise<ConfigState> {
  await assertSafePath(path);
  try {
    const text = await readFile(path, "utf8");
    if (kind === "yaml") {
      const document = parseDocument(text);
      if (document.errors.length > 0)
        throw new Error(
          `Malformed YAML host config: ${document.errors[0]!.message}`,
        );
      const value = document.toJSON() as unknown;
      if (!isRecord(value))
        throw new Error("Host config root must be an object.");
      return { value, document };
    }
    const value: unknown = JSON.parse(text);
    if (!isRecord(value))
      throw new Error("Host config root must be an object.");
    return { value };
  } catch (error) {
    if (isMissing(error))
      return kind === "yaml"
        ? { value: {}, document: parseDocument("") }
        : { value: {} };
    throw error;
  }
}

async function writeConfig(
  path: string,
  kind: Kind,
  state: ConfigState,
): Promise<HostInstallResult> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backupPath = `${path}.gossip-backup-${Date.now()}-${randomUUID()}`;
  let hasBackup = false;
  try {
    await copyFile(path, backupPath, 1);
    hasBackup = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const tempPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    const text =
      kind === "yaml"
        ? state.document!.toString()
        : `${JSON.stringify(state.value, null, 2)}\n`;
    await writeFile(tempPath, text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    return hasBackup ? { changed: true, backupPath } : { changed: true };
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function assertSafePath(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Host config path must be absolute.");
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink())
      throw new Error("Refusing to modify a symlinked host config.");
    if (!stats.isFile())
      throw new Error("Host config path must be a regular file.");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function getServer(config: Config, path: Path): unknown {
  let current: unknown = config;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setServer(config: Config, path: Path, server: Config): void {
  let current = config;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (next === undefined) current[key] = {};
    else if (!isRecord(next))
      throw new Error(
        `Host config path ${path.join(".")} contains a non-object value.`,
      );
    current = current[key] as Config;
  }
  current[path[path.length - 1]!] = server;
}

function removeServer(config: Config, path: Path): void {
  const parent = getServer(config, path.slice(0, -1));
  if (isRecord(parent)) delete parent[path[path.length - 1]!];
}

function sameServer(value: unknown, command: string, args: string[]): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.command === command &&
    Array.isArray(value.args) &&
    value.args.length === args.length &&
    value.args.every((arg, index) => arg === args[index])
  );
}

function isRecord(value: unknown): value is Config {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function withConfigLock<T>(
  configPath: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!isAbsolute(configPath))
    throw new Error("Host config path must be absolute.");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${configPath}.gossip-lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(
        "Another Gossip host configuration update is in progress.",
      );
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}
