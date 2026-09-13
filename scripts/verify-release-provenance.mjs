#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateManifest } from "./release-provenance.mjs";

const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = 1_048_576;

function npmCommand(args) {
  if (process.platform !== "win32") {
    return { executable: "npm", args };
  }

  return {
    executable: process.execPath,
    args: [
      resolve(
        dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
      ...args,
    ],
  };
}

function packageArtifactName(packageName, version) {
  return `${packageName.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

async function command(executable, args, cwd) {
  return execute(executable, args, {
    cwd,
    windowsHide: true,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

async function gitOutput(repository, args) {
  return (await command("git", args, repository)).stdout.trim();
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}

async function requireCleanCheckout(repository) {
  const status = await gitOutput(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error(
      "release provenance verification requires a clean checkout",
    );
  }
}

async function actualInputs(repository, artifactPath) {
  await requireCleanCheckout(repository);
  const commit = await gitOutput(repository, ["rev-parse", "HEAD"]);
  const origin = await gitOutput(repository, ["remote", "get-url", "origin"]);
  const packageManifest = JSON.parse(
    await readFile(resolve(repository, "package.json"), "utf8"),
  );
  const npm = npmCommand(["--version"]);
  const npmVersion = (
    await command(npm.executable, npm.args, repository)
  ).stdout.trim();

  return {
    repository: origin,
    commit,
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
    },
    lockfile: await hashFile(resolve(repository, "package-lock.json")),
    artifact: {
      name: packageArtifactName(packageManifest.name, packageManifest.version),
      ...(await hashFile(artifactPath)),
    },
    runtime: {
      node: process.version,
      npm: npmVersion,
    },
  };
}

function parseArguments(argumentsValue) {
  let manifest;
  let artifact;
  let repository;
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "--manifest") {
      manifest = argumentsValue[++index];
    } else if (argument === "--artifact") {
      artifact = argumentsValue[++index];
    } else if (argument === "--repository") {
      repository = argumentsValue[++index];
    } else {
      throw new Error(
        "Usage: node scripts/verify-release-provenance.mjs --manifest ABSOLUTE_MANIFEST --artifact ABSOLUTE_TGZ [--repository ABSOLUTE_CHECKOUT]",
      );
    }
  }

  if (
    typeof manifest !== "string" ||
    typeof artifact !== "string" ||
    !isAbsolute(manifest) ||
    !isAbsolute(artifact)
  ) {
    throw new Error(
      "Usage: node scripts/verify-release-provenance.mjs --manifest ABSOLUTE_MANIFEST --artifact ABSOLUTE_TGZ [--repository ABSOLUTE_CHECKOUT]",
    );
  }

  return {
    manifest: resolve(manifest),
    artifact: resolve(artifact),
    repository: resolve(
      repository ?? dirname(fileURLToPath(import.meta.url)),
      "..",
    ),
  };
}

export async function main(argumentsValue = process.argv.slice(2)) {
  const argumentsParsed = parseArguments(argumentsValue);
  const manifest = JSON.parse(await readFile(argumentsParsed.manifest, "utf8"));
  const actual = await actualInputs(
    argumentsParsed.repository,
    argumentsParsed.artifact,
  );
  validateManifest(manifest, actual);
  process.stdout.write("release provenance verified\n");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "release provenance verification failed"}\n`,
    );
    process.exitCode = 1;
  });
}
