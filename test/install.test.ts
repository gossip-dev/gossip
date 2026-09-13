import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repository = process.cwd();
const installer = join(repository, "scripts", "install.mjs");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmArguments =
  process.platform === "win32"
    ? [
        join(
          dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      ]
    : [];

async function makeArtifact(root: string) {
  const source = join(root, "fixture");
  await (await import("node:fs/promises")).mkdir(source);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "@gossip/agent-kit",
      version: "1.0.0",
      main: "dist/cli.js",
      scripts: { install: 'node -e "process.exit(77)"' },
      files: ["dist"],
    }),
  );
  await (await import("node:fs/promises")).mkdir(join(source, "dist"));
  await writeFile(join(source, "dist", "cli.js"), 'console.log("fixture");\n');
  const { stdout } = await execFileAsync(
    npmCommand,
    [...npmArguments, "pack", "--ignore-scripts", "--pack-destination", root],
    { cwd: source },
  );
  const filename = stdout.trim().split(/\r?\n/).at(-1)!;
  const artifact = join(root, filename);
  const digest = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  return { artifact, digest };
}

test("installs a verified local package without running package scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gossip-install-"));
  try {
    const { artifact, digest } = await makeArtifact(root);
    const destination = join(root, "installed");
    await execFileAsync(process.execPath, [
      installer,
      "--artifact",
      artifact,
      "--sha256",
      digest,
      "--destination",
      destination,
    ]);
    await execFileAsync(process.execPath, [
      installer,
      "--artifact",
      artifact,
      "--sha256",
      digest,
      "--destination",
      destination,
    ]);
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith(".gossip-install-")),
      false,
    );
    assert.equal(
      JSON.parse(
        await readFile(join(destination, ".gossip-install.json"), "utf8"),
      ).artifactSha256,
      digest,
    );
    assert.equal(
      await readFile(
        join(
          destination,
          "node_modules",
          "@gossip",
          "agent-kit",
          "dist",
          "cli.js",
        ),
        "utf8",
      ),
      'console.log("fixture");\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a bad digest before creating the destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "gossip-install-"));
  try {
    const { artifact } = await makeArtifact(root);
    const destination = join(root, "installed");
    await assert.rejects(
      execFileAsync(process.execPath, [
        installer,
        "--artifact",
        artifact,
        "--sha256",
        "0".repeat(64),
        "--destination",
        destination,
      ]),
      /SHA-256/,
    );
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an occupied destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "gossip-install-"));
  try {
    const { artifact, digest } = await makeArtifact(root);
    const destination = join(root, "occupied");
    await (await import("node:fs/promises")).mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "keep");
    await assert.rejects(
      execFileAsync(process.execPath, [
        installer,
        "--artifact",
        artifact,
        "--sha256",
        digest,
        "--destination",
        destination,
      ]),
      /occupied/,
    );
    assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
