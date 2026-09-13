#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computeAddress } from "ethers";

const SCHEMA = "gossip.ws7-production-acceptance.v1";
const CONTRACT = {
  protocol: "gossip/2-draft.1",
  schema_revision: "2026-09-09",
  authentication: "gossip-eip191-v2",
  mcp_revision: "2025-11-25",
};
const PRODUCTION_CHECKS = [
  "signed_capabilities",
  "standard_zero_cost_consultation",
  "evidence_reproduction",
  "receipt_chain",
  "exact_retry",
  "changed_content_conflict",
  "owner_isolation",
  "restart_upgrade_rollback",
  "session_rotation_revocation",
  "telemetry_scan",
];
const HOSTS = ["grok_bot", "hermes", "openclaw"];
const SLOS = [
  "capability_discovery_latency",
  "durable_acknowledgment_latency",
  "consultation_latency",
  "pending_operation_age",
  "reconciliation_window",
  "authentication_replay_rejection",
  "exact_operation_retry",
  "changed_content_conflict",
  "source_divergence_safety",
  "reorg_quarantine",
  "correction_publication",
];

/** @typedef {Record<string, unknown>} UnknownRecord */

/**
 * @typedef {Object} Ws7ProductionManifest
 * @property {string} schema
 * @property {"passed"|"blocked"} result
 * @property {string|null} generated_at
 * @property {UnknownRecord} release
 * @property {UnknownRecord} deployment
 * @property {UnknownRecord} contract
 * @property {UnknownRecord} receipt_trust
 * @property {Record<string, UnknownRecord>} production_checks
 * @property {Record<string, UnknownRecord>} hosts
 * @property {UnknownRecord[]} measurement_windows
 * @property {Record<string, UnknownRecord|null>} slos
 * @property {UnknownRecord} private_submission
 * @property {UnknownRecord} verification
 * @property {string[]} blockers
 */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`invalid WS7 production manifest: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }

  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !expected.includes(key))
  ) {
    fail(`${label} has unknown or missing keys`);
  }
}

function text(value, label, { nullable = false } = {}) {
  if (value === null && nullable) {
    return;
  }

  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} must be a non-empty text value`);
  }
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be boolean`);
  }
}

function digest(value, label, { nullable = false } = {}) {
  if (value === null && nullable) {
    return;
  }

  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function timestamp(value, label, { nullable = false } = {}) {
  if (value === null && nullable) {
    return;
  }

  text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }

  if (!Number.isFinite(Date.parse(value))) {
    fail(`${label} must be a valid timestamp`);
  }
}

function validateRoot(manifest) {
  exactKeys(
    manifest,
    [
      "schema",
      "result",
      "generated_at",
      "release",
      "deployment",
      "contract",
      "receipt_trust",
      "production_checks",
      "hosts",
      "measurement_windows",
      "slos",
      "private_submission",
      "verification",
      "blockers",
    ],
    "manifest",
  );

  if (manifest.schema !== SCHEMA) {
    fail("unsupported schema");
  }
  if (manifest.result !== "passed" && manifest.result !== "blocked") {
    fail("result must be passed or blocked");
  }
  timestamp(manifest.generated_at, "generated_at", {
    nullable: manifest.result === "blocked",
  });
}

function validateRelease(release, passed) {
  exactKeys(
    release,
    [
      "gossip_commit",
      "sherwood_commit",
      "package",
      "artifact_sha256",
      "lockfile_sha256",
      "provenance_run",
      "release_tag",
    ],
    "release",
  );
  const nullable = !passed;

  for (const field of ["gossip_commit", "sherwood_commit"]) {
    if (release[field] !== null && !/^[0-9a-f]{40}$/u.test(release[field])) {
      fail(`release.${field} must be a full lowercase commit`);
    }
    if (passed && release[field] === null) {
      fail("release identity is not complete");
    }
  }
  text(release.package, "release.package", { nullable });
  digest(release.artifact_sha256, "release.artifact_sha256", { nullable });
  digest(release.lockfile_sha256, "release.lockfile_sha256", { nullable });
  text(release.provenance_run, "release.provenance_run", { nullable });
  text(release.release_tag, "release.release_tag", { nullable });

  if (
    passed &&
    [
      release.package,
      release.artifact_sha256,
      release.lockfile_sha256,
      release.provenance_run,
      release.release_tag,
    ].some((value) => value === null)
  ) {
    fail("release identity is not complete");
  }
}

function validateDeployment(deployment, passed) {
  exactKeys(
    deployment,
    [
      "provider",
      "environment",
      "service",
      "deployment_id",
      "image_digest",
      "endpoint",
      "audience",
    ],
    "deployment",
  );
  const nullable = !passed;
  for (const field of [
    "provider",
    "environment",
    "service",
    "deployment_id",
    "endpoint",
    "audience",
  ]) {
    text(deployment[field], `deployment.${field}`, { nullable });
  }
  digest(deployment.image_digest, "deployment.image_digest", { nullable });

  if (
    passed &&
    ["provider", "environment", "service"].some(
      (field) =>
        deployment[field] === null ||
        deployment[field] !==
          { provider: "railway", environment: "production", service: "engine" }[
            field
          ],
    )
  ) {
    fail("deployment identity is inconsistent");
  }
  if (deployment.endpoint !== null && deployment.audience !== null) {
    let endpoint;
    let audience;
    try {
      endpoint = new URL(deployment.endpoint);
      audience = new URL(deployment.audience);
    } catch {
      fail("deployment endpoint and audience must be valid URLs");
    }
    if (
      endpoint.protocol !== "https:" ||
      audience.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      audience.username !== "" ||
      audience.password !== "" ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      audience.search !== "" ||
      audience.hash !== "" ||
      endpoint.pathname !== "/mcp" ||
      audience.pathname !== "/" ||
      endpoint.origin !== audience.origin
    ) {
      fail(
        "deployment endpoint and audience are not the same canonical HTTPS origin",
      );
    }
  }
}

function validateContract(contract) {
  exactKeys(contract, Object.keys(CONTRACT), "contract");
  for (const [field, expected] of Object.entries(CONTRACT)) {
    if (contract[field] !== expected) {
      fail("contract is inconsistent");
    }
  }
}

function validateTrust(receiptTrust, passed) {
  exactKeys(
    receiptTrust,
    [
      "key_id",
      "public_key",
      "ethereum_address",
      "valid_from",
      "valid_until",
      "manifest_digest",
    ],
    "receipt_trust",
  );
  const nullable = !passed;
  text(receiptTrust.key_id, "receipt_trust.key_id", { nullable });
  text(receiptTrust.public_key, "receipt_trust.public_key", { nullable });
  text(receiptTrust.ethereum_address, "receipt_trust.ethereum_address", {
    nullable,
  });
  timestamp(receiptTrust.valid_from, "receipt_trust.valid_from", { nullable });
  timestamp(receiptTrust.valid_until, "receipt_trust.valid_until", {
    nullable,
  });
  digest(receiptTrust.manifest_digest, "receipt_trust.manifest_digest", {
    nullable,
  });

  if (receiptTrust.public_key !== null) {
    if (!/^0x04[0-9a-fA-F]{128}$/u.test(receiptTrust.public_key)) {
      fail("receipt_trust.public_key is not an uncompressed public key");
    }
    if (receiptTrust.ethereum_address !== null) {
      let derivedAddress;
      try {
        derivedAddress = computeAddress(receiptTrust.public_key);
      } catch {
        fail("receipt_trust.public_key is not a valid secp256k1 key");
      }
      if (
        derivedAddress.toLowerCase() !==
        receiptTrust.ethereum_address.toLowerCase()
      ) {
        fail("receipt trust public key and Ethereum address do not match");
      }
    }
  }
  if (
    receiptTrust.ethereum_address !== null &&
    !/^0x[0-9a-fA-F]{40}$/u.test(receiptTrust.ethereum_address)
  ) {
    fail("receipt_trust.ethereum_address is not an Ethereum address");
  }
  if (
    receiptTrust.valid_from !== null &&
    receiptTrust.valid_until !== null &&
    Date.parse(receiptTrust.valid_until) <= Date.parse(receiptTrust.valid_from)
  ) {
    fail("receipt trust validity interval is inconsistent");
  }
  if (passed) {
    if (
      [
        receiptTrust.key_id,
        receiptTrust.public_key,
        receiptTrust.ethereum_address,
        receiptTrust.valid_from,
        receiptTrust.valid_until,
        receiptTrust.manifest_digest,
      ].some((value) => value === null)
    ) {
      fail("receipt trust identity is not complete");
    }
  }
}

function validateProductionChecks(checks, passed) {
  exactKeys(checks, PRODUCTION_CHECKS, "production_checks");
  for (const name of PRODUCTION_CHECKS) {
    const check = checks[name];
    exactKeys(
      check,
      ["passed", "evidence_sha256"],
      `production_checks.${name}`,
    );
    boolean(check.passed, `production_checks.${name}.passed`);
    if (check.passed && check.evidence_sha256 === null) {
      fail("passed production check evidence is missing");
    }
    digest(check.evidence_sha256, `production_checks.${name}.evidence_sha256`, {
      nullable: true,
    });
    if (passed && check.passed !== true) {
      fail("production checks did not all pass");
    }
  }
}

function validateHosts(hosts, passed) {
  exactKeys(hosts, HOSTS, "hosts");
  for (const name of HOSTS) {
    const host = hosts[name];
    exactKeys(
      host,
      [
        "version",
        "operating_system",
        "protected_storage",
        "evidence_sha256",
        "verified",
      ],
      `hosts.${name}`,
    );
    text(host.version, `hosts.${name}.version`, { nullable: !passed });
    text(host.operating_system, `hosts.${name}.operating_system`, {
      nullable: !passed,
    });
    text(host.protected_storage, `hosts.${name}.protected_storage`, {
      nullable: !passed,
    });
    boolean(host.verified, `hosts.${name}.verified`);
    if (host.verified && host.evidence_sha256 === null) {
      fail("verified host evidence is missing");
    }
    digest(host.evidence_sha256, `hosts.${name}.evidence_sha256`, {
      nullable: true,
    });
    if (passed && host.verified !== true) {
      fail("hosts are not all verified");
    }
  }
}

function validateMeasurementWindows(manifest, passed) {
  const windows = manifest.measurement_windows;
  if (!Array.isArray(windows) || windows.length > 2) {
    fail("measurement_windows must contain at most two windows");
  }
  if (passed && windows.length !== 2) {
    fail("passed manifests require two measurement windows");
  }

  const identifiers = new Set();
  for (const [index, window] of windows.entries()) {
    const label = `measurement_windows.${index}`;
    exactKeys(
      window,
      [
        "id",
        "started_at",
        "ended_at",
        "client_region",
        "gossip_commit",
        "sherwood_commit",
        "artifact_sha256",
        "deployment_id",
        "trust_manifest_digest",
        "protocol",
        "schema_revision",
        "authentication",
        "mcp_revision",
        "excluded_deterministic_refusals",
      ],
      label,
    );
    text(window.id, `${label}.id`);
    timestamp(window.started_at, `${label}.started_at`);
    timestamp(window.ended_at, `${label}.ended_at`);
    text(window.client_region, `${label}.client_region`);
    digest(window.artifact_sha256, `${label}.artifact_sha256`);
    digest(window.trust_manifest_digest, `${label}.trust_manifest_digest`);

    if (identifiers.has(window.id)) {
      fail("measurement window IDs must be unique");
    }
    identifiers.add(window.id);

    const duration =
      Date.parse(window.ended_at) - Date.parse(window.started_at);
    if (duration !== 30 * 60 * 1_000) {
      fail("every measurement window must be exactly 30 minutes");
    }
    if (
      window.gossip_commit !== manifest.release.gossip_commit ||
      window.sherwood_commit !== manifest.release.sherwood_commit ||
      window.artifact_sha256 !== manifest.release.artifact_sha256 ||
      window.deployment_id !== manifest.deployment.deployment_id ||
      window.trust_manifest_digest !== manifest.receipt_trust.manifest_digest ||
      window.protocol !== manifest.contract.protocol ||
      window.schema_revision !== manifest.contract.schema_revision ||
      window.authentication !== manifest.contract.authentication ||
      window.mcp_revision !== manifest.contract.mcp_revision
    ) {
      fail("measurement window is not pinned to the accepted release");
    }
    if (
      !Number.isInteger(window.excluded_deterministic_refusals) ||
      window.excluded_deterministic_refusals < 0
    ) {
      fail("excluded deterministic refusals must be a non-negative integer");
    }
  }

  if (windows.length === 2) {
    const ordered = [...windows].sort(
      (left, right) =>
        Date.parse(left.started_at) - Date.parse(right.started_at),
    );
    if (Date.parse(ordered[0].ended_at) > Date.parse(ordered[1].started_at)) {
      fail("measurement windows must not overlap");
    }
  }

  return identifiers;
}

function validateSlos(slos, passed, measurementWindowIds) {
  exactKeys(slos, SLOS, "slos");
  for (const name of SLOS) {
    const slo = slos[name];
    if (slo === null) {
      if (passed) {
        fail("SLO results are incomplete");
      }
      continue;
    }
    exactKeys(
      slo,
      ["objective", "observations", "passed", "windows"],
      `slos.${name}`,
    );
    text(slo.objective, `slos.${name}.objective`);
    if (
      typeof slo.observations !== "number" ||
      !Number.isInteger(slo.observations) ||
      slo.observations < 100
    ) {
      fail("SLO observations must include at least 100 measurements");
    }
    boolean(slo.passed, `slos.${name}.passed`);
    if (passed && slo.passed !== true) {
      fail("SLO results did not all pass");
    }

    if (!Array.isArray(slo.windows)) {
      fail("SLO windows must be an array");
    }
    if (passed && slo.windows.length !== 2) {
      fail("passed SLO results require two window results");
    }

    const seenWindowIds = new Set();
    let observedTotal = 0;
    for (const [index, window] of slo.windows.entries()) {
      const label = `slos.${name}.windows.${index}`;
      exactKeys(
        window,
        ["window_id", "observations", "result", "evidence_sha256"],
        label,
      );
      text(window.window_id, `${label}.window_id`);
      text(window.result, `${label}.result`);
      digest(window.evidence_sha256, `${label}.evidence_sha256`);
      if (!Number.isInteger(window.observations) || window.observations < 50) {
        fail("each SLO window must include at least 50 measurements");
      }
      if (
        !measurementWindowIds.has(window.window_id) ||
        seenWindowIds.has(window.window_id)
      ) {
        fail("SLO window references must be unique accepted windows");
      }
      seenWindowIds.add(window.window_id);
      observedTotal += window.observations;
    }
    if (observedTotal !== slo.observations) {
      fail("SLO observation total does not match its windows");
    }
  }
}

function validatePrivateSubmission(privateSubmission, passed) {
  exactKeys(
    privateSubmission,
    ["enabled", "policy_approved", "policy_digest"],
    "private_submission",
  );
  boolean(privateSubmission.enabled, "private_submission.enabled");
  boolean(
    privateSubmission.policy_approved,
    "private_submission.policy_approved",
  );
  digest(privateSubmission.policy_digest, "private_submission.policy_digest", {
    nullable: true,
  });
  if (privateSubmission.enabled) {
    fail("private submission must remain disabled");
  }
  if (
    passed &&
    (!privateSubmission.policy_approved ||
      privateSubmission.policy_digest === null)
  ) {
    fail("private submission policy is not approved");
  }
}

function validateVerification(verification, result) {
  exactKeys(
    verification,
    [
      "production_verified",
      "host_acceptance_verified",
      "independent_verifier",
      "verified_at",
    ],
    "verification",
  );
  boolean(verification.production_verified, "verification.production_verified");
  boolean(
    verification.host_acceptance_verified,
    "verification.host_acceptance_verified",
  );
  text(verification.independent_verifier, "verification.independent_verifier", {
    nullable: true,
  });
  timestamp(verification.verified_at, "verification.verified_at", {
    nullable: true,
  });

  if (result === "passed") {
    if (
      verification.production_verified !== true ||
      verification.host_acceptance_verified !== true ||
      verification.independent_verifier === null ||
      verification.verified_at === null
    ) {
      fail("verification is incomplete");
    }
  } else if (
    verification.production_verified !== false ||
    verification.host_acceptance_verified !== false
  ) {
    fail("blocked manifests must keep verification flags false");
  }
}

function validateBlockers(blockers, result) {
  if (
    !Array.isArray(blockers) ||
    blockers.some(
      (blocker) => typeof blocker !== "string" || blocker.trim().length === 0,
    )
  ) {
    fail("blockers must be an array of non-empty text values");
  }
  if (result === "passed" && blockers.length !== 0) {
    fail("passed manifests cannot contain blockers");
  }
  if (result === "blocked" && blockers.length === 0) {
    fail("blocked manifests require at least one blocker");
  }
}

function validateChronology(manifest) {
  if (manifest.result !== "passed") {
    return;
  }

  const trustStart = Date.parse(manifest.receipt_trust.valid_from);
  const trustEnd = Date.parse(manifest.receipt_trust.valid_until);
  const latestMeasurementEnd = Math.max(
    ...manifest.measurement_windows.map((window) => {
      const startedAt = Date.parse(window.started_at);
      const endedAt = Date.parse(window.ended_at);
      if (startedAt < trustStart || endedAt > trustEnd) {
        fail("measurement windows must remain inside receipt trust validity");
      }
      return endedAt;
    }),
  );

  const generatedAt = Date.parse(manifest.generated_at);
  const verifiedAt = Date.parse(manifest.verification.verified_at);
  if (generatedAt < latestMeasurementEnd || verifiedAt < generatedAt) {
    fail("manifest generation and verification chronology is inconsistent");
  }
}

/**
 * Validate the WS7 production acceptance manifest.
 *
 * @param {unknown} manifest
 * @returns {asserts manifest is Ws7ProductionManifest}
 */
export function validateManifest(manifest) {
  validateRoot(manifest);
  const passed = manifest.result === "passed";
  validateRelease(manifest.release, passed);
  validateDeployment(manifest.deployment, passed);
  validateContract(manifest.contract);
  validateTrust(manifest.receipt_trust, passed);
  validateProductionChecks(manifest.production_checks, passed);
  validateHosts(manifest.hosts, passed);
  const measurementWindowIds = validateMeasurementWindows(manifest, passed);
  validateSlos(manifest.slos, passed, measurementWindowIds);
  validatePrivateSubmission(manifest.private_submission, passed);
  validateVerification(manifest.verification, manifest.result);
  validateBlockers(manifest.blockers, manifest.result);
  validateChronology(manifest);
}

export const validateWs7ProductionManifest = validateManifest;

function parseArguments(argumentsValue) {
  if (
    argumentsValue.length !== 2 ||
    argumentsValue[0] !== "--manifest" ||
    !isAbsolute(argumentsValue[1])
  ) {
    throw new Error(
      "Usage: node scripts/verify-ws7-production-manifest.mjs --manifest ABSOLUTE_MANIFEST",
    );
  }
  return resolve(argumentsValue[1]);
}

export async function main(argumentsValue = process.argv.slice(2)) {
  const manifestPath = parseArguments(argumentsValue);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  process.stdout.write("WS7 production manifest verified\n");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "WS7 production manifest verification failed"}\n`,
    );
    process.exitCode = 1;
  });
}
