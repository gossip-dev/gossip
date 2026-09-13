#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(repository, "package.json");
const lockfilePath = resolve(repository, "package-lock.json");
const REQUIRED_CHECKS = ["install", "typecheck", "test", "build", "pack"];
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

async function command(executable, args, options = {}) {
  try {
    return await execute(executable, args, {
      cwd: repository,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      ...options,
    });
  } catch (error) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("A provenance subprocess exceeded its output limit.");
    }

    throw error;
  }
}

async function gitOutput(args) {
  return (await command("git", args)).stdout.trim();
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}

function ensureAbsoluteOutsideRepository(path, label) {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }

  const resolved = resolve(path);
  const relativePath = relative(repository, resolved);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  ) {
    throw new Error(`${label} must be outside the source checkout`);
  }

  return resolved;
}

async function requireMissing(path, label) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  throw new Error(`${label} already exists`);
}

async function requireCleanCheckout() {
  const status = await gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error("release provenance requires a clean checkout");
  }
}

async function sourceInputs() {
  const commit = await gitOutput(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("could not resolve a full source commit");
  }

  const origin = await gitOutput(["remote", "get-url", "origin"]);
  const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
  if (
    typeof packageManifest.name !== "string" ||
    typeof packageManifest.version !== "string"
  ) {
    throw new Error("package.json must declare a package name and version");
  }

  return {
    repository: origin,
    commit,
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
    },
    lockfile: await hashFile(lockfilePath),
  };
}

async function runtimeInputs() {
  const npm = npmCommand(["--version"]);
  const npmVersion = (await command(npm.executable, npm.args)).stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(npmVersion)) {
    throw new Error("could not measure npm version");
  }

  return {
    node: process.version,
    npm: npmVersion,
  };
}

async function runCheck(name, executable, args, options = {}) {
  try {
    await command(executable, args, options);
    return { name, status: "passed" };
  } catch (error) {
    return {
      name,
      status: "failed",
      error: error instanceof Error ? error.message : "subprocess failed",
    };
  }
}

async function runNpmCheck(name, args) {
  const npm = npmCommand(args);
  return runCheck(name, npm.executable, npm.args);
}

function packageArtifactName(packageName, version) {
  return `${packageName.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

function validateChecks(checks) {
  if (!Array.isArray(checks) || checks.length !== REQUIRED_CHECKS.length) {
    throw new Error("provenance check set is incomplete");
  }

  const names = checks.map((check) => check.name);
  if (
    names.some((name) => typeof name !== "string") ||
    new Set(names).size !== REQUIRED_CHECKS.length ||
    REQUIRED_CHECKS.some((name) => !names.includes(name))
  ) {
    throw new Error("provenance check names are invalid");
  }

  for (const check of checks) {
    if (check.status !== "passed" && check.status !== "failed") {
      throw new Error(`invalid provenance status for ${check.name}`);
    }
  }
}

export function validateManifest(manifest, actual) {
  if (manifest.schema !== "gossip.release-provenance.v1") {
    throw new Error("unsupported provenance manifest schema");
  }

  if (
    manifest.result !== "passed" ||
    manifest.source?.commit !== actual.commit ||
    manifest.source?.repository !== actual.repository ||
    manifest.package?.name !== actual.package.name ||
    manifest.package?.version !== actual.package.version ||
    manifest.lockfile?.sha256 !== actual.lockfile.sha256 ||
    manifest.lockfile?.bytes !== actual.lockfile.bytes
  ) {
    throw new Error("provenance source or package identity does not match");
  }

  if (
    manifest.runtime?.node !== actual.runtime.node ||
    manifest.runtime?.npm !== actual.runtime.npm
  ) {
    throw new Error("provenance runtime does not match");
  }

  if (
    manifest.artifact?.sha256 !== actual.artifact.sha256 ||
    manifest.artifact?.bytes !== actual.artifact.bytes ||
    manifest.artifact?.name !==
      packageArtifactName(actual.package.name, actual.package.version)
  ) {
    throw new Error("provenance artifact digest or identity does not match");
  }

  validateChecks(manifest.checks);
  if (manifest.checks.some((check) => check.status !== "passed")) {
    throw new Error("provenance checks did not all pass");
  }
}

async function buildManifest(output, artifactPath) {
  await requireCleanCheckout();
  const source = await sourceInputs();
  const runtime = await runtimeInputs();
  const checks = [];

  checks.push(await runNpmCheck("install", ["ci", "--ignore-scripts"]));
  checks.push(await runNpmCheck("typecheck", ["run", "typecheck"]));
  checks.push(await runNpmCheck("test", ["test"]));
  checks.push(await runNpmCheck("build", ["run", "build"]));

  let artifact;
  if (checks.every((check) => check.status === "passed")) {
    await mkdir(dirname(artifactPath), { recursive: true });
    const temporaryArtifact = resolve(
      dirname(artifactPath),
      `.${basename(artifactPath)}.npm-pack.tgz`,
    );
    const pack = await runNpmCheck("pack", [
      "pack",
      "--ignore-scripts",
      "--silent",
      "--pack-destination",
      dirname(temporaryArtifact),
    ]);
    checks.push(pack);

    if (pack.status === "passed") {
      const expectedName = packageArtifactName(
        source.package.name,
        source.package.version,
      );
      const packedPath = resolve(dirname(temporaryArtifact), expectedName);
      await copyFile(packedPath, artifactPath);
      artifact = {
        name: expectedName,
        ...(await hashFile(artifactPath)),
      };
    }
  } else {
    checks.push({
      name: "pack",
      status: "failed",
      error: "pack skipped because an earlier check failed",
    });
  }

  validateChecks(checks);
  const manifest = {
    schema: "gossip.release-provenance.v1",
    result: checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed",
    source,
    package: source.package,
    lockfile: source.lockfile,
    artifact: artifact ?? null,
    runtime,
    checks,
  };

  if (manifest.result === "passed") {
    await requireCleanCheckout();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  return manifest;
}

async function parseArguments(argumentsValue) {
  let output;
  let artifact;
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "--output") {
      output = argumentsValue[++index];
    } else if (argument === "--artifact") {
      artifact = argumentsValue[++index];
    } else {
      throw new Error(
        "Usage: node scripts/release-provenance.mjs --output ABSOLUTE_MANIFEST [--artifact ABSOLUTE_TGZ]",
      );
    }
  }

  if (typeof output !== "string" || output === "") {
    throw new Error(
      "Usage: node scripts/release-provenance.mjs --output ABSOLUTE_MANIFEST [--artifact ABSOLUTE_TGZ]",
    );
  }

  const manifestPath = ensureAbsoluteOutsideRepository(output, "output");
  const artifactPath = ensureAbsoluteOutsideRepository(
    artifact ?? `${output}.tgz`,
    "artifact",
  );
  await requireMissing(manifestPath, "output");
  await requireMissing(artifactPath, "artifact");
  return { manifestPath, artifactPath };
}

export async function main(argumentsValue = process.argv.slice(2)) {
  const { manifestPath, artifactPath } = await parseArguments(argumentsValue);
  const manifest = await buildManifest(manifestPath, artifactPath);
  if (manifest.result !== "passed") {
    const failedChecks = manifest.checks
      .filter((check) => check.status !== "passed")
      .map((check) => `${check.name}: ${check.error ?? "failed"}`)
      .join("; ");
    throw new Error(
      `release provenance checks failed; no manifest was written (${failedChecks})`,
    );
  }

  process.stdout.write(`${manifestPath}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "release provenance failed"}\n`,
    );
    process.exitCode = 1;
  });
}
