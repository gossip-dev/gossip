import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical.js";
import {
  CONFORMANCE_CAPABILITIES,
  CONFORMANCE_SCENARIOS,
  conformanceStatementDigest,
  createConformanceEnvelope,
  parseConformanceEnvelope,
  scanConformanceText,
} from "../src/conformance-v2.js";
import { ProtocolError } from "../src/protocol-errors.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-conformance.json", import.meta.url),
    "utf8",
  ),
) as Record<string, any>;

function expectCode(action: () => unknown, code: ProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

function copyReferencedFixtures(
  statement: Record<string, any>,
  temporary: string,
): void {
  for (const fixtureReference of statement.fixtures) {
    const filename = fixtureReference.path.split("/").at(-1);
    assert.ok(filename);
    const fixtureBytes = fs.readFileSync(
      new URL(`./fixtures/${filename}`, import.meta.url),
    );
    const copiedFixture = path.join(
      temporary,
      ...fixtureReference.path.split("/"),
    );
    fs.mkdirSync(path.dirname(copiedFixture), { recursive: true });
    fs.writeFileSync(copiedFixture, fixtureBytes);
    fixtureReference.sha256 = `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`;
    fixtureReference.bytes = fixtureBytes.byteLength;
  }
}

test("verifies the literal blocked acceptance envelope and its content address", () => {
  const envelope = parseConformanceEnvelope(fixture);

  assert.equal(envelope.statement.decision, "blocked");
  assert.equal(
    conformanceStatementDigest(envelope.statement),
    envelope.content_address.digest,
  );
  assert.deepEqual(
    envelope.statement.scenarios.map((scenario) => scenario.id).sort(),
    [...CONFORMANCE_SCENARIOS].sort(),
  );
  assert.deepEqual(
    envelope.statement.capabilities.map((capability) => capability.name).sort(),
    [...CONFORMANCE_CAPABILITIES].sort(),
  );
});

test("creates a content-addressed envelope from a validated statement", () => {
  assert.deepEqual(createConformanceEnvelope(fixture.statement), fixture);
  assert.notEqual(
    canonicalDigest("conformance", fixture.statement),
    canonicalDigest("identity", fixture.statement),
  );
});

test("rejects tampering, incomplete catalogs, and duplicate entries", () => {
  expectCode(
    () =>
      parseConformanceEnvelope({
        ...fixture,
        statement: {
          ...fixture.statement,
          generated_at: fixture.statement.generated_at + 1,
        },
      }),
    "invalid_conformance_manifest",
  );
  expectCode(
    () =>
      parseConformanceEnvelope({
        ...fixture,
        statement: {
          ...fixture.statement,
          scenarios: fixture.statement.scenarios.slice(1),
        },
      }),
    "invalid_conformance_manifest",
  );
  expectCode(
    () =>
      parseConformanceEnvelope({
        ...fixture,
        statement: {
          ...fixture.statement,
          capabilities: [
            ...fixture.statement.capabilities,
            fixture.statement.capabilities[0],
          ],
        },
      }),
    "invalid_conformance_manifest",
  );
  expectCode(() => {
    const duplicatedFixture = structuredClone(fixture);
    duplicatedFixture.statement.fixtures.push({
      ...duplicatedFixture.statement.fixtures[0],
      name: "duplicate-fixture",
    });
    duplicatedFixture.content_address.digest = canonicalDigest(
      "conformance",
      duplicatedFixture.statement,
    );
    return parseConformanceEnvelope(duplicatedFixture);
  }, "invalid_conformance_manifest");
});

test("does not convert installed code into verified capability support", () => {
  const promoted = structuredClone(fixture);
  promoted.statement.decision = "verified";
  promoted.statement.capabilities = promoted.statement.capabilities.map(
    (capability: Record<string, unknown>) => {
      const {
        reason: _reason,
        next_action: _nextAction,
        ...identity
      } = capability;
      return {
        ...identity,
        state: "verified",
        evidence_revision: "local-install-only",
        evidence_scenarios: ["artifact_install"],
      };
    },
  );
  promoted.content_address.digest = canonicalDigest(
    "conformance",
    promoted.statement,
  );

  expectCode(
    () => parseConformanceEnvelope(promoted),
    "invalid_conformance_manifest",
  );
});

test("requires verified capabilities to cite verified scenarios", () => {
  const promoted = structuredClone(fixture);
  const capability = promoted.statement.capabilities[0];
  delete capability.reason;
  delete capability.next_action;
  capability.state = "verified";
  capability.evidence_revision = "engine-conformance-1";
  capability.evidence_scenarios = ["operation_exactly_once"];
  promoted.content_address.digest = canonicalDigest(
    "conformance",
    promoted.statement,
  );

  expectCode(
    () => parseConformanceEnvelope(promoted),
    "invalid_conformance_manifest",
  );
});

test("requires Sherwood process evidence for every process-proved scenario", () => {
  const invalid = structuredClone(fixture);
  const scenario = invalid.statement.scenarios.find(
    (candidate: Record<string, unknown>) =>
      candidate.id === "operation_exactly_once",
  );
  assert.ok(scenario);
  delete scenario.reason;
  delete scenario.next_action;
  scenario.status = "verified";
  scenario.assertions = 1;
  scenario.evidence = [fixture.statement.scenarios[0].evidence[0]];
  invalid.content_address.digest = canonicalDigest(
    "conformance",
    invalid.statement,
  );

  expectCode(
    () => parseConformanceEnvelope(invalid),
    "invalid_conformance_manifest",
  );
});

test("rejects prohibited values from captured diagnostics before publication", () => {
  assert.doesNotThrow(() =>
    scanConformanceText("status=blocked duration_ms=12", ["canary-private"]),
  );
  for (const captured of [
    "Authorization: Bearer opaque",
    "private_key=0x1234",
    "signature=0xabcd",
    "source_url=https://private.test/account/1",
    "prompt=buy this token",
    '{"authorization":"Bearer opaque"}',
    '{"private_key":"0x1234"}',
    '{"signature":"0xabcd"}',
    '{"auth_token":"opaque"}',
    "token_value=opaque",
    "tokenValue=opaque",
    "accessTokenId=opaque",
    "privateKeyMaterial=opaque",
    "serverSigningSecret=opaque",
    "authorizationHeader=opaque",
    "sourceUrlPath=https://private.test/account/1",
    '{"token.value":"opaque"}',
    '{"private.key.material":"opaque"}',
    `${"x".repeat(80)}TokenValue=opaque`,
    '"token=opaque"',
    '["private.key.material=opaque"]',
    "canary-private",
  ]) {
    expectCode(
      () => scanConformanceText(captured, ["canary-private"]),
      "unsafe_conformance_artifact",
    );
  }
});

test("TypeScript and Python reject ambiguous fixture paths", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "gossip-path-vector-"),
  );

  try {
    for (const fixturePath of ["a//b", "a/./b", "C:fixture.json"]) {
      const invalid = structuredClone(fixture);
      invalid.statement.fixtures[0].path = fixturePath;
      invalid.content_address.digest = canonicalDigest(
        "conformance",
        invalid.statement,
      );

      expectCode(
        () => parseConformanceEnvelope(invalid),
        "invalid_conformance_manifest",
      );

      const manifestPath = path.join(temporary, "acceptance-manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(invalid));
      const python = spawnSync(
        "python",
        [
          "scripts/verify-v2-conformance-manifest.py",
          "--manifest",
          manifestPath,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(python.status, 0, fixturePath);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("TypeScript and Python enforce the same manifest bounds", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "gossip-schema-vector-"),
  );

  try {
    const validBase = structuredClone(fixture);
    copyReferencedFixtures(validBase.statement, temporary);
    for (const scenario of validBase.statement.scenarios) {
      if (scenario.status !== "verified") {
        continue;
      }
      const evidenceBytes = Buffer.from(`evidence:${scenario.id}\n`, "utf8");
      const evidencePath = path.join(
        temporary,
        ...scenario.evidence[0].path.split("/"),
      );
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, evidenceBytes);
      scenario.evidence[0].sha256 = `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}`;
      scenario.evidence[0].bytes = evidenceBytes.byteLength;
    }
    validBase.content_address.digest = canonicalDigest(
      "conformance",
      validBase.statement,
    );
    const validManifestPath = path.join(temporary, "valid-manifest.json");
    fs.writeFileSync(validManifestPath, JSON.stringify(validBase));
    const validPython = spawnSync(
      "python",
      [
        "scripts/verify-v2-conformance-manifest.py",
        "--manifest",
        validManifestPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(validPython.status, 0, validPython.stderr);

    const replay = structuredClone(validBase);
    replay.statement.generated_at += 1;
    replay.content_address.digest = canonicalDigest(
      "conformance",
      replay.statement,
    );
    const replayManifestPath = path.join(temporary, "replay-manifest.json");
    fs.writeFileSync(replayManifestPath, JSON.stringify(replay));
    const replayAttestationPath = path.join(
      temporary,
      "replay-attestation.json",
    );

    const replayPython = spawnSync(
      "python",
      [
        "scripts/verify-v2-conformance-manifest.py",
        "--manifest",
        validManifestPath,
        "--replay-manifest",
        replayManifestPath,
        "--write-replay-attestation",
        replayAttestationPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(replayPython.status, 0, replayPython.stderr);
    const replayAttestation = JSON.parse(
      fs.readFileSync(replayAttestationPath, "utf8"),
    );
    assert.deepEqual(replayAttestation, {
      schema: "gossip.replay-attestation-envelope.v1",
      attestation: {
        schema: "gossip.replay-attestation.v1",
        protocol: "gossip/2-draft.1",
        suite_revision: validBase.statement.suite_revision,
        primary_manifest: validBase.content_address.digest,
        replay_manifest: replay.content_address.digest,
        projection_digest: replayAttestation.attestation.projection_digest,
        result: "matched",
      },
      content_address: {
        algorithm: "sha256",
        digest: replayAttestation.content_address.digest,
      },
    });
    assert.match(
      replayAttestation.attestation.projection_digest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(
      replayAttestation.content_address.digest,
      canonicalDigest("conformance", replayAttestation.attestation),
    );

    const overwriteAttestation = spawnSync(
      "python",
      [
        "scripts/verify-v2-conformance-manifest.py",
        "--manifest",
        validManifestPath,
        "--replay-manifest",
        replayManifestPath,
        "--write-replay-attestation",
        replayAttestationPath,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(overwriteAttestation.status, 0);

    const differentRuntime = structuredClone(replay);
    differentRuntime.statement.runtime.node = "25.0.0";
    differentRuntime.content_address.digest = canonicalDigest(
      "conformance",
      differentRuntime.statement,
    );
    const differentRuntimePath = path.join(
      temporary,
      "different-runtime-manifest.json",
    );
    fs.writeFileSync(differentRuntimePath, JSON.stringify(differentRuntime));

    const differentRuntimePython = spawnSync(
      "python",
      [
        "scripts/verify-v2-conformance-manifest.py",
        "--manifest",
        validManifestPath,
        "--replay-manifest",
        differentRuntimePath,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(differentRuntimePython.status, 0);

    const divergentReplay = structuredClone(replay);
    const divergentScenario = divergentReplay.statement.scenarios.find(
      (scenario: Record<string, unknown>) => scenario.id === "artifact_install",
    );
    assert.ok(divergentScenario);
    divergentScenario.status = "blocked";
    divergentScenario.reason = "replay diverged";
    divergentScenario.next_action = "inspect replay";
    delete divergentScenario.assertions;
    delete divergentScenario.evidence;
    divergentReplay.content_address.digest = canonicalDigest(
      "conformance",
      divergentReplay.statement,
    );
    const divergentReplayPath = path.join(
      temporary,
      "divergent-replay-manifest.json",
    );
    fs.writeFileSync(divergentReplayPath, JSON.stringify(divergentReplay));

    const divergentPython = spawnSync(
      "python",
      [
        "scripts/verify-v2-conformance-manifest.py",
        "--manifest",
        validManifestPath,
        "--replay-manifest",
        divergentReplayPath,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(divergentPython.status, 0);

    const invalidManifests = [
      (() => {
        const invalid = structuredClone(validBase);
        invalid.statement.fixtures = [];
        return invalid;
      })(),
      (() => {
        const invalid = structuredClone(validBase);
        invalid.statement.runtime.os = 123;
        return invalid;
      })(),
      (() => {
        const invalid = structuredClone(validBase);
        const blocked = invalid.statement.scenarios.find(
          (scenario: Record<string, unknown>) => scenario.status === "blocked",
        );
        assert.ok(blocked);
        blocked.reason = "x".repeat(257);
        return invalid;
      })(),
    ];

    for (const [index, invalid] of invalidManifests.entries()) {
      invalid.content_address.digest = canonicalDigest(
        "conformance",
        invalid.statement,
      );
      expectCode(
        () => parseConformanceEnvelope(invalid),
        "invalid_conformance_manifest",
      );

      const manifestPath = path.join(temporary, `manifest-${index}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(invalid));
      const python = spawnSync(
        "python",
        [
          "scripts/verify-v2-conformance-manifest.py",
          "--manifest",
          manifestPath,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(python.status, 0, `malformed manifest ${index}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("TypeScript and Python enforce Sherwood assembly and process evidence prerequisites", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "gossip-sherwood-schema-vector-"),
  );

  try {
    const processEvidence = path.join(temporary, "evidence", "process.json");
    fs.mkdirSync(path.dirname(processEvidence), { recursive: true });
    fs.writeFileSync(processEvidence, "process evidence\n");

    const valid = structuredClone(fixture);
    copyReferencedFixtures(valid.statement, temporary);
    for (const scenario of valid.statement.scenarios) {
      if (scenario.status !== "verified") {
        continue;
      }
      const evidenceBytes = Buffer.from(`evidence:${scenario.id}\n`);
      const evidencePath = path.join(
        temporary,
        ...scenario.evidence[0].path.split("/"),
      );
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, evidenceBytes);
      scenario.evidence[0].sha256 = `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}`;
      scenario.evidence[0].bytes = evidenceBytes.byteLength;
    }
    valid.statement.artifacts.sherwood.commit = "6f5739c5".repeat(5);
    valid.statement.artifacts.sherwood.assembly = {
      sha256: `sha256:${"1".repeat(64)}`,
      bytes: 123,
    };
    valid.statement.runtime.dotnet = "10.0.11";
    valid.statement.runtime.docker = "28.3.3";
    valid.statement.runtime.postgresql = "17.6";
    valid.statement.revisions.engine = "synthetic-v1";
    valid.statement.revisions.database_migrations =
      "git-tree-" + "2".repeat(40);
    for (const scenarioId of [
      "mcp_http_parity",
      "privacy_canary_scan",
      "session_scope_escape",
      "public_submission_transport",
      "zero_cost_reconciliation",
      "persistence_fault_recovery",
      "owner_isolation",
    ]) {
      const scenario = valid.statement.scenarios.find(
        (candidate: Record<string, unknown>) => candidate.id === scenarioId,
      );
      assert.ok(scenario);
      delete scenario.reason;
      delete scenario.next_action;
      scenario.status = "verified";
      scenario.assertions = 10;
      scenario.evidence = [
        {
          path: "evidence/process.json",
          sha256: `sha256:${createHash("sha256").update("process evidence\n").digest("hex")}`,
          bytes: 17,
        },
      ];
    }
    const publicSubmission = valid.statement.capabilities.find(
      (candidate: Record<string, unknown>) =>
        candidate.name === "public_submission",
    );
    assert.ok(publicSubmission);
    publicSubmission.state = "installed";
    publicSubmission.reason =
      "The packaged public-submission process gate passed without production deployment acceptance.";
    publicSubmission.next_action =
      "Pass the pinned production endpoint and host acceptance.";
    valid.content_address.digest = canonicalDigest(
      "conformance",
      valid.statement,
    );
    assert.doesNotThrow(() => parseConformanceEnvelope(valid));

    const validPath = path.join(temporary, "valid-manifest.json");
    fs.writeFileSync(validPath, JSON.stringify(valid));
    const validPython = spawnSync(
      "python",
      ["scripts/verify-v2-conformance-manifest.py", "--manifest", validPath],
      { encoding: "utf8" },
    );
    assert.equal(validPython.status, 0, validPython.stderr);

    const invalidManifests = [
      (() => {
        const invalid = structuredClone(fixture);
        invalid.statement.artifacts.sherwood.assembly = {
          sha256: `sha256:${"1".repeat(64)}`,
          bytes: 123,
        };
        return invalid;
      })(),
      (() => {
        const invalid = structuredClone(fixture);
        invalid.statement.artifacts.sherwood.commit = "6f5739c5".repeat(5);
        return invalid;
      })(),
      (() => {
        const invalid = structuredClone(fixture);
        invalid.statement.artifacts.sherwood.image_digest = `sha256:${"1".repeat(64)}`;
        return invalid;
      })(),
      (() => {
        const invalid = structuredClone(valid);
        invalid.statement.runtime.dotnet = null;
        return invalid;
      })(),
      (() => {
        const invalid = structuredClone(valid);
        invalid.statement.decision = "verified";
        invalid.statement.artifacts.sherwood.image_digest = null;
        return invalid;
      })(),
      (() => {
        const invalid = structuredClone(fixture);
        const scenario = invalid.statement.scenarios.find(
          (candidate: Record<string, unknown>) =>
            candidate.id === "authentication_fail_closed",
        );
        assert.ok(scenario);
        delete scenario.reason;
        delete scenario.next_action;
        scenario.status = "verified";
        scenario.assertions = 1;
        scenario.evidence = [fixture.statement.scenarios[0].evidence[0]];
        return invalid;
      })(),
      ...[
        "public_submission_transport",
        "zero_cost_reconciliation",
        "persistence_fault_recovery",
        "evidence_finality_reorg",
        "correction_supersession",
        "owner_isolation",
      ].map((scenarioId) => {
        const invalid = structuredClone(fixture);
        const scenario = invalid.statement.scenarios.find(
          (candidate: Record<string, unknown>) => candidate.id === scenarioId,
        );
        assert.ok(scenario);
        delete scenario.reason;
        delete scenario.next_action;
        scenario.status = "verified";
        scenario.assertions = 1;
        scenario.evidence = [fixture.statement.scenarios[0].evidence[0]];
        return invalid;
      }),
    ];

    for (const [index, invalid] of invalidManifests.entries()) {
      invalid.content_address.digest = canonicalDigest(
        "conformance",
        invalid.statement,
      );
      expectCode(
        () => parseConformanceEnvelope(invalid),
        "invalid_conformance_manifest",
      );

      const manifestPath = path.join(temporary, `invalid-${index}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(invalid));
      const python = spawnSync(
        "python",
        [
          "scripts/verify-v2-conformance-manifest.py",
          "--manifest",
          manifestPath,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(python.status, 0, `invalid Sherwood shape ${index}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
