#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const IDENTITY_FILE = ".gossip-install.json";
const INSTALL_TIMEOUT_MS = 600_000;

function usage() {
  return "Usage: node scripts/install.mjs --artifact /absolute/path/package.tgz --sha256 <64-hex> --destination /absolute/empty/path";
}

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      !argument?.startsWith("--") ||
      !argv[index + 1] ||
      argv[index + 1].startsWith("--")
    ) {
      throw new Error(usage());
    }
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (
    Object.keys(values).length !== 3 ||
    !values.artifact ||
    !values.sha256 ||
    !values.destination
  ) {
    throw new Error(usage());
  }
  return {
    artifact: values.artifact,
    sha256: values.sha256,
    destination: values.destination,
  };
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDirectory(path) {
  return (await readdir(path)).length === 0;
}

async function runNpm(args, cwd) {
  const executable = process.platform === "win32" ? process.execPath : "npm";
  const npmArgs =
    process.platform === "win32"
      ? [
          join(
            dirname(process.execPath),
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
          ...args,
        ]
      : args;
  await new Promise((resolveProcess, reject) => {
    const child = spawn(executable, npmArgs, {
      cwd,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("npm install timed out"));
    }, INSTALL_TIMEOUT_MS);
    child.once("error", () => reject(new Error("npm could not be started")));
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveProcess();
      else
        reject(
          new Error(
            `npm install failed${signal ? ` (${signal})` : ` (exit ${code ?? "unknown"})`}`,
          ),
        );
    });
  });
}

async function packageIdentity(stagingPath) {
  try {
    const manifestPath = join(
      stagingPath,
      "node_modules",
      "@gossip",
      "agent-kit",
      "package.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await stat(
      join(
        stagingPath,
        "node_modules",
        "@gossip",
        "agent-kit",
        "dist",
        "cli.js",
      ),
    );
    if (manifest.name && manifest.version)
      return { name: manifest.name, version: manifest.version };
  } catch {
    // An incomplete install is never valid idempotence evidence.
  }
  return undefined;
}

export async function installArtifact({
  artifact,
  sha256: expectedSha256,
  destination,
  runner = runNpm,
}) {
  if (!isAbsolute(artifact) || !isAbsolute(destination))
    throw new Error("artifact and destination must be absolute paths");
  if (!artifact.endsWith(".tgz"))
    throw new Error("artifact must be a local .tgz file");
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256))
    throw new Error("sha256 must be a 64-character hexadecimal digest");

  const artifactPath = resolve(artifact);
  const destinationPath = resolve(destination);
  let artifactStats;
  try {
    artifactStats = await stat(artifactPath);
  } catch {
    throw new Error("artifact file does not exist");
  }
  if (!artifactStats.isFile())
    throw new Error("artifact must be a regular file");

  const parent = dirname(destinationPath);
  await mkdir(parent, { recursive: true });
  const stagingPath = join(parent, `.gossip-install-${randomUUID()}`);
  await mkdir(stagingPath, { mode: 0o700 });
  try {
    const stagedArtifactPath = join(stagingPath, "artifact.tgz");
    await copyFile(artifactPath, stagedArtifactPath);
    const stagedSha256 = await sha256(stagedArtifactPath);
    if (stagedSha256 !== expectedSha256.toLowerCase())
      throw new Error("artifact SHA-256 does not match the expected digest");
    const actualSha256 = stagedSha256;
    if (await exists(destinationPath)) {
      const destinationLink = await lstat(destinationPath);
      if (destinationLink.isSymbolicLink())
        throw new Error("destination must be an absolute empty directory");
      const destinationStats = await stat(destinationPath);
      if (!destinationStats.isDirectory())
        throw new Error("destination must be an absolute empty directory");
      if (await isEmptyDirectory(destinationPath))
        throw new Error("destination must not already exist");
      try {
        const marker = JSON.parse(
          await readFile(join(destinationPath, IDENTITY_FILE), "utf8"),
        );
        const installedIdentity = await packageIdentity(destinationPath);
        if (
          marker.artifactSha256 === actualSha256 &&
          installedIdentity &&
          marker.package?.name === installedIdentity.name &&
          marker.package?.version === installedIdentity.version
        ) {
          return {
            installed: false,
            alreadyInstalled: true,
            artifactSha256: actualSha256,
          };
        }
      } catch {
        // Treat missing or malformed identity evidence as an occupied destination.
      }
      throw new Error(
        "destination is occupied and has no matching Gossip artifact identity",
      );
    }
    await runner(
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        stagingPath,
        stagedArtifactPath,
      ],
      parent,
    );
    const identity = await packageIdentity(stagingPath);
    if (!identity)
      throw new Error("installed artifact did not contain the Gossip kit");
    await writeFile(
      join(stagingPath, IDENTITY_FILE),
      JSON.stringify(
        { artifactSha256: actualSha256, package: identity },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await rename(stagingPath, destinationPath);
    return {
      installed: true,
      alreadyInstalled: false,
      artifactSha256: actualSha256,
    };
  } catch (error) {
    throw error instanceof Error ? error : new Error("installation failed");
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    const result = await installArtifact(parseArguments(process.argv.slice(2)));
    console.log(
      result.alreadyInstalled
        ? "Gossip artifact is already installed."
        : "Gossip artifact installed successfully.",
    );
  } catch (error) {
    console.error(
      `Installation failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}
