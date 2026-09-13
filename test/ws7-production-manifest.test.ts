import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  validateManifest,
  type Ws7ProductionManifest,
} from "../scripts/verify-ws7-production-manifest.mjs";

const run = promisify(execFile);
const template = JSON.parse(
  await readFile(
    new URL(
      "../docs/acceptance/ws7-production-manifest.template.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Ws7ProductionManifest;

function passedManifest(): Ws7ProductionManifest {
  const manifest = structuredClone(template);
  manifest.result = "passed";
  manifest.generated_at = "2026-09-12T12:00:00Z";
  manifest.release = {
    gossip_commit: "a".repeat(40),
    sherwood_commit: "b".repeat(40),
    package: "@gossip/agent-kit@0.1.0-dev.1",
    artifact_sha256: `sha256:${"c".repeat(64)}`,
    lockfile_sha256: `sha256:${"d".repeat(64)}`,
    provenance_run: "https://example.invalid/actions/runs/123",
    release_tag: "v0.1.0-dev.1",
  };
  manifest.deployment = {
    provider: "railway",
    environment: "production",
    service: "engine",
    deployment_id: "deployment-123",
    image_digest: `sha256:${"e".repeat(64)}`,
    endpoint: "https://engine-production-c4d8.up.railway.app/mcp",
    audience: "https://engine-production-c4d8.up.railway.app/",
  };
  manifest.receipt_trust = {
    key_id: "production-key-1",
    public_key:
      "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
    ethereum_address: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    valid_from: "2026-09-01T00:00:00Z",
    valid_until: "2027-09-01T00:00:00Z",
    manifest_digest: `sha256:${"f".repeat(64)}`,
  };
  manifest.production_checks = Object.fromEntries(
    Object.keys(manifest.production_checks).map((name, index) => [
      name,
      {
        passed: true,
        evidence_sha256: `sha256:${((index % 9) + 1).toString().repeat(64)}`,
      },
    ]),
  ) as Ws7ProductionManifest["production_checks"];
  manifest.hosts = Object.fromEntries(
    Object.entries(manifest.hosts).map(([name, host]) => [
      name,
      {
        ...host,
        version: "1.0.0",
        operating_system: "linux",
        protected_storage: "secret-service",
        evidence_sha256: `sha256:${"9".repeat(64)}`,
        verified: true,
      },
    ]),
  ) as Ws7ProductionManifest["hosts"];
  manifest.measurement_windows = [
    measurementWindow("run-a", "2026-09-12T10:00:00Z"),
    measurementWindow("run-b", "2026-09-12T11:00:00Z"),
  ];
  manifest.slos = Object.fromEntries(
    Object.keys(manifest.slos).map((name) => [
      name,
      {
        objective: "p95 <= 1s",
        observations: 100,
        passed: true,
        windows: [sloWindow("run-a", "1s"), sloWindow("run-b", "900ms")],
      },
    ]),
  ) as Ws7ProductionManifest["slos"];
  manifest.private_submission = {
    enabled: false,
    policy_approved: true,
    policy_digest: `sha256:${"a".repeat(64)}`,
  };
  manifest.verification = {
    production_verified: true,
    host_acceptance_verified: true,
    independent_verifier: "release-auditor",
    verified_at: "2026-09-12T13:00:00Z",
  };
  manifest.blockers = [];
  return manifest;
}

function measurementWindow(id: string, startedAt: string) {
  const endedAt = new Date(
    Date.parse(startedAt) + 30 * 60 * 1_000,
  ).toISOString();
  return {
    id,
    started_at: startedAt,
    ended_at: endedAt,
    client_region: "ca-central",
    gossip_commit: "a".repeat(40),
    sherwood_commit: "b".repeat(40),
    artifact_sha256: `sha256:${"c".repeat(64)}`,
    deployment_id: "deployment-123",
    trust_manifest_digest: `sha256:${"f".repeat(64)}`,
    protocol: "gossip/2-draft.1",
    schema_revision: "2026-09-09",
    authentication: "gossip-eip191-v2",
    mcp_revision: "2025-11-25",
    excluded_deterministic_refusals: 0,
  };
}

function sloWindow(windowId: string, result: string) {
  return {
    window_id: windowId,
    observations: 50,
    result,
    evidence_sha256: `sha256:${(windowId === "run-a" ? "1" : "2").repeat(64)}`,
  };
}

test("accepts a complete passed manifest with private submission disabled by approved policy", () => {
  assert.doesNotThrow(() => validateManifest(passedManifest()));
});

test("accepts a blocked manifest with nullable evidence and an actionable blocker", () => {
  assert.doesNotThrow(() => validateManifest(template));
});

test("rejects passed manifests when any release, deployment, or trust identity is absent", () => {
  for (const section of ["release", "deployment", "receipt_trust"] as const) {
    const invalid = passedManifest();
    const field = Object.keys(
      invalid[section],
    )[0] as keyof (typeof invalid)[typeof section];
    invalid[section][field] = null as never;
    assert.throws(() => validateManifest(invalid), /complete|non-empty/u);
  }
});

test("rejects passed manifests with an unverified production check, host, SLO, or gate", () => {
  const productionCheck = passedManifest();
  productionCheck.production_checks.signed_capabilities.passed = false;
  assert.throws(() => validateManifest(productionCheck), /production checks/u);

  const missingProductionEvidence = passedManifest();
  missingProductionEvidence.production_checks.signed_capabilities.evidence_sha256 =
    null;
  assert.throws(
    () => validateManifest(missingProductionEvidence),
    /production check evidence/u,
  );

  const host = passedManifest();
  host.hosts.hermes.verified = false;
  assert.throws(() => validateManifest(host), /hosts/u);

  const missingHostEvidence = passedManifest();
  missingHostEvidence.hosts.hermes.evidence_sha256 = null;
  assert.throws(() => validateManifest(missingHostEvidence), /host evidence/u);

  const slo = passedManifest();
  slo.slos.consultation_latency = {
    objective: "p95 <= 5s",
    observations: 0,
    passed: true,
    windows: [],
  };
  assert.throws(() => validateManifest(slo), /SLO/u);

  const undersampled = passedManifest();
  undersampled.slos.consultation_latency = {
    objective: "p95 <= 5s",
    observations: 99,
    passed: true,
    windows: [
      { ...sloWindow("run-a", "1s"), observations: 49 },
      sloWindow("run-b", "1s"),
    ],
  };
  assert.throws(() => validateManifest(undersampled), /100 measurements/u);

  const policy = passedManifest();
  policy.private_submission.policy_approved = false;
  assert.throws(() => validateManifest(policy), /private submission/u);

  const verification = passedManifest();
  verification.verification.host_acceptance_verified = false;
  assert.throws(() => validateManifest(verification), /verification/u);

  const enabledPrivateSubmission = passedManifest();
  enabledPrivateSubmission.private_submission.enabled = true;
  assert.throws(
    () => validateManifest(enabledPrivateSubmission),
    /private submission/u,
  );
});

test("requires blocked manifests to keep both verification flags false and retain a blocker", () => {
  const verified = structuredClone(template);
  verified.verification.production_verified = true;
  assert.throws(() => validateManifest(verified), /blocked.*verification/u);

  const noBlocker = structuredClone(template);
  noBlocker.blockers = [];
  assert.throws(() => validateManifest(noBlocker), /blocker/u);

  const enabled = structuredClone(template);
  enabled.private_submission.enabled = true;
  assert.throws(() => validateManifest(enabled), /disabled/u);
});

test("rejects unknown or missing keys and inconsistent contract values", () => {
  const unknown = passedManifest() as Record<string, unknown>;
  unknown.extra = true;
  assert.throws(() => validateManifest(unknown), /unknown/u);

  const missing = passedManifest();
  delete (missing.slos.capability_discovery_latency as Record<string, unknown>)
    .passed;
  assert.throws(() => validateManifest(missing), /SLO|unknown or missing/u);

  const inconsistent = passedManifest();
  inconsistent.contract.authentication = "gossip-eip191-v1";
  assert.throws(() => validateManifest(inconsistent), /contract/u);

  const missingGeneratedAt = passedManifest();
  missingGeneratedAt.generated_at = null;
  assert.throws(
    () => validateManifest(missingGeneratedAt),
    /non-empty|timestamp/u,
  );

  const endpoint = passedManifest();
  endpoint.deployment.audience =
    "http://engine-production-c4d8.up.railway.app/";
  assert.throws(() => validateManifest(endpoint), /canonical HTTPS origin/u);

  const trust = passedManifest();
  trust.receipt_trust.ethereum_address = `0x${"3".repeat(40)}`;
  assert.throws(() => validateManifest(trust), /do not match/u);

  const unpinnedWindow = passedManifest();
  unpinnedWindow.measurement_windows[0].deployment_id = "other-deployment";
  assert.throws(() => validateManifest(unpinnedWindow), /pinned/u);

  const overlappingWindows = passedManifest();
  overlappingWindows.measurement_windows[1].started_at = "2026-09-12T10:15:00Z";
  overlappingWindows.measurement_windows[1].ended_at = "2026-09-12T10:45:00Z";
  assert.throws(() => validateManifest(overlappingWindows), /overlap/u);

  const outsideTrust = passedManifest();
  outsideTrust.receipt_trust.valid_from = "2026-09-12T10:15:00Z";
  assert.throws(() => validateManifest(outsideTrust), /trust validity/u);

  const verifiedBeforeGeneration = passedManifest();
  verifiedBeforeGeneration.verification.verified_at = "2026-09-12T11:59:59Z";
  assert.throws(
    () => validateManifest(verifiedBeforeGeneration),
    /chronology/u,
  );
});

test("CLI exits successfully for a valid manifest and fails closed for an invalid one", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "gossip-ws7-manifest-"));
  try {
    const manifestPath = join(temporary, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(passedManifest()));
    const script = join(
      process.cwd(),
      "scripts",
      "verify-ws7-production-manifest.mjs",
    );
    const valid = await run(process.execPath, [
      script,
      "--manifest",
      manifestPath,
    ]);
    assert.match(valid.stdout, /verified/u);

    const invalid = passedManifest();
    invalid.blockers = ["unexpected blocker"];
    await writeFile(manifestPath, JSON.stringify(invalid));
    await assert.rejects(() =>
      run(process.execPath, [script, "--manifest", manifestPath]),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
