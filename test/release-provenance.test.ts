import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateManifest } from "../scripts/release-provenance.mjs";

const actual = {
  repository: "https://github.com/gossip-dev/gossip.git",
  commit: "a".repeat(40),
  package: {
    name: "@gossip/agent-kit",
    version: "0.1.0-dev.1",
  },
  lockfile: {
    sha256: `sha256:${"b".repeat(64)}`,
    bytes: 123,
  },
  artifact: {
    name: "gossip-agent-kit-0.1.0-dev.1.tgz",
    sha256: `sha256:${"c".repeat(64)}`,
    bytes: 456,
  },
  runtime: {
    node: "v24.0.0",
    npm: "11.0.0",
  },
};

function manifest() {
  return {
    schema: "gossip.release-provenance.v1",
    result: "passed",
    source: {
      repository: actual.repository,
      commit: actual.commit,
    },
    package: actual.package,
    lockfile: actual.lockfile,
    artifact: actual.artifact,
    runtime: actual.runtime,
    checks: [
      { name: "install", status: "passed" },
      { name: "typecheck", status: "passed" },
      { name: "test", status: "passed" },
      { name: "build", status: "passed" },
      { name: "pack", status: "passed" },
    ],
  };
}

test("accepts a manifest whose source, lockfile, artifact, and runtime match", () => {
  assert.doesNotThrow(() => validateManifest(manifest(), actual));
});

test("rejects a changed lockfile or package artifact digest", () => {
  const lockfileMismatch = manifest();
  lockfileMismatch.lockfile = {
    ...lockfileMismatch.lockfile,
    sha256: `sha256:${"d".repeat(64)}`,
  };
  assert.throws(
    () => validateManifest(lockfileMismatch, actual),
    /source or package identity does not match/u,
  );

  const artifactMismatch = manifest();
  artifactMismatch.artifact = {
    ...artifactMismatch.artifact,
    bytes: 457,
  };
  assert.throws(
    () => validateManifest(artifactMismatch, actual),
    /artifact digest or identity does not match/u,
  );
});

test("rejects a manifest with a failed build or test check", () => {
  const failed = manifest();
  failed.checks = failed.checks.map((check) =>
    check.name === "build" ? { ...check, status: "failed" } : check,
  );
  assert.throws(
    () => validateManifest(failed, actual),
    /checks did not all pass/u,
  );
});

test("release workflow creates a repository-bound package attestation", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release-provenance.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /attestations: write/u);
  assert.match(workflow, /runs-on: windows-latest/u);
  assert.match(workflow, /\$env:RUNNER_TEMP\\gossip-agent-kit\.tgz/u);
  assert.match(workflow, /uses: actions\/attest@[0-9a-f]{40}/u);
  assert.match(
    workflow,
    /subject-path: \$\{\{ runner\.temp \}\}\/gossip-agent-kit\.tgz/u,
  );
  assert.doesNotMatch(
    workflow,
    /uses: actions\/(?:checkout|setup-node|upload-artifact|attest)@v\d/u,
  );
});
