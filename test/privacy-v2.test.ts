import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Wallet } from "ethers";
import {
  PRIVATE_DATA_CLASSES,
  PRIVATE_OWNER_ACTIONS,
  SYNTHETIC_PRIVATE_EVIDENCE_POLICY,
  appendPrivateEvidenceCorrection,
  authorizePrivacyOperation,
  bindPrivacyOperation,
  buildOwnerAccessAudit,
  buildOwnerPrivacyExport,
  buildPrivateEvidenceCorrectionResult,
  buildPrivateEvidenceDeletionResult,
  parsePrivacyAuditEvent,
  parsePrivacyCorrectionResult,
  parsePrivacyDeletionResult,
  parsePrivacyPolicy,
  parsePrivacyTelemetryEvent,
  planPrivateEvidenceDeletion,
  privacyOperationDigest,
  publicationConsentDigest,
  publicationConsentMessage,
  requirePublicationConsent,
  verifyPublicationConsent,
} from "../src/privacy-v2.js";
import { ProtocolError } from "../src/protocol-errors.js";
import { canonicalJson } from "../src/canonical.js";

const owner = {
  chain_id: "4663",
  address: "0x1111111111111111111111111111111111111111",
};
const stranger = {
  chain_id: "4663",
  address: "0x2222222222222222222222222222222222222222",
};
const rootPrincipal = { kind: "root" as const, owner };
const strangerPrincipal = { kind: "root" as const, owner: stranger };
const evidenceDigest = `sha256:${"a".repeat(64)}`;
const correctionDigest = `sha256:${"b".repeat(64)}`;
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-privacy.json", import.meta.url),
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

function privacyOperation(
  action:
    | { kind: "export"; scope: "all" }
    | { kind: "delete"; evidence_digest: string }
    | {
        kind: "correct";
        evidence_digest: string;
        correction_digest: string;
      }
    | { kind: "access_audit"; since: number; until: number },
) {
  return {
    schema: "gossip.privacy-operation.v1",
    protocol: "gossip/2-draft.1",
    policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
    operation_id: "privacy_operation_1",
    owner,
    requested_at: 1_800_000_000,
    action,
  };
}

function lifecycleRecord() {
  return {
    schema: "gossip.private-evidence-lifecycle.v1" as const,
    owner,
    evidence_digest: evidenceDigest,
    policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
    stored_at: 1_799_999_000,
    retention_expires_at: 1_802_591_000,
    hold: null,
    correction_digests: [] as string[],
  };
}

test("freezes every private data class and owner operation behind a blocked synthetic policy", () => {
  const policy = parsePrivacyPolicy(SYNTHETIC_PRIVATE_EVIDENCE_POLICY);

  assert.equal(policy.activation, "blocked_pending_approval");
  assert.deepEqual(
    policy.data_classes.map((entry) => entry.name).sort(),
    [...PRIVATE_DATA_CLASSES].sort(),
  );
  assert.deepEqual(
    policy.owner_operations.map((entry) => entry.action).sort(),
    [...PRIVATE_OWNER_ACTIONS].sort(),
  );
  assert.ok(policy.data_classes.every((entry) => entry.retention_seconds > 0));
  assert.ok(
    policy.data_classes.every((entry) => entry.retention_clock.length > 0),
  );
  assert.ok(
    policy.owner_operations.every((entry) => entry.outcomes.length >= 2),
  );
  assert.equal(
    Object.isFrozen(SYNTHETIC_PRIVATE_EVIDENCE_POLICY.data_classes),
    true,
  );
  assert.equal(
    Object.isFrozen(SYNTHETIC_PRIVATE_EVIDENCE_POLICY.data_classes[0]),
    true,
  );
});

test("matches the independent policy and signed-consent literals", () => {
  assert.deepEqual(
    parsePrivacyPolicy(fixture.policy),
    parsePrivacyPolicy(SYNTHETIC_PRIVATE_EVIDENCE_POLICY),
  );
  const signedConsent = verifyPublicationConsent(fixture.signed_consent);

  assert.equal(
    publicationConsentDigest(signedConsent.consent),
    signedConsent.consent_digest,
  );
  assert.equal(
    publicationConsentMessage(signedConsent.consent_digest),
    fixture.consent_message,
  );
});

test("freezes canonical owner-operation vectors for engine parity", () => {
  for (const vector of fixture.operation_vectors) {
    const operation = JSON.parse(vector.canonical);

    assert.equal(canonicalJson(operation), vector.canonical);
    assert.equal(privacyOperationDigest(operation), vector.digest);
  }
});

test("rejects incomplete policy vectors and unapproved activation", () => {
  expectCode(
    () =>
      parsePrivacyPolicy({
        ...SYNTHETIC_PRIVATE_EVIDENCE_POLICY,
        data_classes: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.data_classes.slice(1),
      }),
    "invalid_privacy_contract",
  );
  expectCode(
    () =>
      parsePrivacyPolicy({
        ...SYNTHETIC_PRIVATE_EVIDENCE_POLICY,
        activation: "verified",
      }),
    "invalid_privacy_contract",
  );
});

test("requires fresh root-signed consent for public commitments and identity links", async () => {
  const wallet = new Wallet(`0x${"1".padStart(64, "0")}`);
  const consentOwner = {
    chain_id: "4663",
    address: wallet.address.toLowerCase(),
  };
  const consent = {
    schema: "gossip.publication-consent.v1",
    protocol: "gossip/2-draft.1",
    policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
    owner: consentOwner,
    evidence_digest: evidenceDigest,
    disclosures: ["public_commitment", "linkable_identity"],
    issued_at: 1_800_000_000,
    expires_at: 1_800_000_300,
  };
  const consentDigest = publicationConsentDigest(consent);
  const signedConsent = {
    consent,
    consent_digest: consentDigest,
    root_public_key: wallet.signingKey.publicKey,
    signature: await wallet.signMessage(
      publicationConsentMessage(consentDigest),
    ),
  };

  assert.doesNotThrow(() =>
    requirePublicationConsent(
      { kind: "root", owner: consentOwner },
      signedConsent,
      {
        evidence_digest: evidenceDigest,
        disclosure: "public_commitment",
        policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
        now: 1_800_000_100,
      },
    ),
  );
  expectCode(
    () =>
      requirePublicationConsent(
        { kind: "root", owner: consentOwner },
        {
          ...signedConsent,
          consent: { ...consent, disclosures: ["linkable_identity"] },
        },
        {
          evidence_digest: evidenceDigest,
          disclosure: "public_commitment",
          policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
          now: 1_800_000_100,
        },
      ),
    "privacy_consent_required",
  );
  expectCode(
    () =>
      requirePublicationConsent(
        { kind: "root", owner: consentOwner },
        signedConsent,
        {
          evidence_digest: evidenceDigest,
          disclosure: "public_commitment",
          policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
          now: 1_800_000_300,
        },
      ),
    "privacy_consent_required",
  );
  expectCode(
    () =>
      requirePublicationConsent(
        { kind: "session", owner: consentOwner, key_id: "session-1" },
        signedConsent,
        {
          evidence_digest: evidenceDigest,
          disclosure: "public_commitment",
          policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
          now: 1_800_000_100,
        },
      ),
    "privacy_consent_required",
  );
});

test("uses one non-enumerating response for every cross-owner operation", () => {
  const actions = [
    { kind: "export", scope: "all" } as const,
    { kind: "delete", evidence_digest: evidenceDigest } as const,
    {
      kind: "correct",
      evidence_digest: evidenceDigest,
      correction_digest: correctionDigest,
    } as const,
    { kind: "access_audit", since: 1, until: 2 } as const,
  ];

  for (const action of actions) {
    expectCode(
      () =>
        authorizePrivacyOperation(
          strangerPrincipal,
          privacyOperation(action),
          SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
        ),
      "privacy_unavailable",
    );
  }

  expectCode(
    () =>
      authorizePrivacyOperation(
        rootPrincipal,
        {
          ...privacyOperation({ kind: "export", scope: "all" }),
          policy_revision: "superseded-policy",
        },
        SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
      ),
    "privacy_unavailable",
  );
  expectCode(
    () =>
      authorizePrivacyOperation(
        { kind: "session", owner, key_id: "session-1" },
        privacyOperation({ kind: "export", scope: "all" }),
        SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
      ),
    "privacy_unavailable",
  );
});

test("binds privacy idempotency keys to canonical request content", () => {
  const deletion = privacyOperation({
    kind: "delete",
    evidence_digest: evidenceDigest,
  });
  const correction = privacyOperation({
    kind: "correct",
    evidence_digest: evidenceDigest,
    correction_digest: correctionDigest,
  });

  assert.notEqual(
    privacyOperationDigest(deletion),
    privacyOperationDigest(correction),
  );
  assert.equal(
    privacyOperationDigest(deletion),
    privacyOperationDigest({ ...deletion }),
  );

  const binding = bindPrivacyOperation(null, deletion);
  assert.deepEqual(bindPrivacyOperation(binding, { ...deletion }), binding);
  expectCode(
    () => bindPrivacyOperation(binding, correction),
    "operation_conflict",
  );
});

test("plans idempotent deletion while preserving only a minimal tombstone", () => {
  const operation = privacyOperation({
    kind: "delete",
    evidence_digest: evidenceDigest,
  });
  const first = planPrivateEvidenceDeletion(
    rootPrincipal,
    operation,
    lifecycleRecord(),
    1_800_000_010,
  );

  assert.equal(first.outcome, "deleted");
  assert.deepEqual(Object.keys(first.tombstone).sort(), [
    "deleted_at",
    "deletion_operation_id",
    "evidence_digest",
    "owner",
    "policy_revision",
    "reason",
    "schema",
  ]);
  assert.deepEqual(Object.keys(first).sort(), ["outcome", "tombstone"]);

  const retry = planPrivateEvidenceDeletion(
    rootPrincipal,
    operation,
    first.tombstone,
    1_800_000_020,
  );
  assert.equal(retry.outcome, "already_deleted");
  assert.deepEqual(retry.tombstone, first.tombstone);

  const held = planPrivateEvidenceDeletion(
    rootPrincipal,
    operation,
    {
      ...lifecycleRecord(),
      hold: { kind: "legal", placed_at: 1_800_000_001 },
    },
    1_800_000_010,
  );
  assert.equal(held.outcome, "held");
  assert.deepEqual(held.record, {
    ...lifecycleRecord(),
    hold: { kind: "legal", placed_at: 1_800_000_001 },
  });

  expectCode(
    () =>
      planPrivateEvidenceDeletion(
        rootPrincipal,
        operation,
        null,
        1_800_000_010,
      ),
    "privacy_unavailable",
  );

  expectCode(
    () =>
      planPrivateEvidenceDeletion(
        rootPrincipal,
        operation,
        { ...lifecycleRecord(), retention_expires_at: 253_402_300_799 },
        1_800_000_010,
      ),
    "privacy_unavailable",
  );

  expectCode(
    () =>
      planPrivateEvidenceDeletion(
        rootPrincipal,
        operation,
        { ...first.tombstone, policy_revision: "wrong-policy" },
        1_800_000_020,
      ),
    "privacy_unavailable",
  );
});

test("appends corrections without rewriting prior lineage", () => {
  const operation = privacyOperation({
    kind: "correct",
    evidence_digest: evidenceDigest,
    correction_digest: correctionDigest,
  });
  const original = lifecycleRecord();
  const corrected = appendPrivateEvidenceCorrection(
    rootPrincipal,
    operation,
    original,
  );

  assert.deepEqual(original.correction_digests, []);
  assert.deepEqual(corrected.correction_digests, [correctionDigest]);
  assert.equal(corrected.evidence_digest, evidenceDigest);
  assert.deepEqual(
    appendPrivateEvidenceCorrection(rootPrincipal, operation, corrected),
    corrected,
  );
});

test("builds strict deletion wire results without exposing held lifecycle data", () => {
  const operation = privacyOperation({
    kind: "delete",
    evidence_digest: evidenceDigest,
  });
  const deleted = buildPrivateEvidenceDeletionResult(
    rootPrincipal,
    operation,
    lifecycleRecord(),
    1_800_000_010,
  );

  assert.equal(deleted.outcome, "deleted");
  assert.deepEqual(Object.keys(deleted).sort(), [
    "operation_id",
    "outcome",
    "owner",
    "policy_revision",
    "protocol",
    "schema",
    "tombstone",
  ]);
  assert.deepEqual(parsePrivacyDeletionResult(deleted), deleted);

  const retry = buildPrivateEvidenceDeletionResult(
    rootPrincipal,
    operation,
    deleted.tombstone,
    1_800_000_020,
  );
  assert.equal(retry.outcome, "already_deleted");
  assert.deepEqual(retry.tombstone, deleted.tombstone);

  const held = buildPrivateEvidenceDeletionResult(
    rootPrincipal,
    operation,
    {
      ...lifecycleRecord(),
      hold: { kind: "legal", placed_at: 1_800_000_001 },
    },
    1_800_000_010,
  );
  assert.deepEqual(held, {
    schema: "gossip.privacy-deletion-result.v1",
    protocol: "gossip/2-draft.1",
    policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
    owner,
    operation_id: operation.operation_id,
    outcome: "held",
  });
  assert.deepEqual(parsePrivacyDeletionResult(held), held);
  expectCode(
    () => parsePrivacyDeletionResult({ ...held, record: lifecycleRecord() }),
    "invalid_privacy_contract",
  );
  expectCode(
    () => parsePrivacyDeletionResult({ ...held, tombstone: deleted.tombstone }),
    "invalid_privacy_contract",
  );
  expectCode(
    () =>
      parsePrivacyDeletionResult({
        ...deleted,
        tombstone: { ...deleted.tombstone, deletion_operation_id: "other" },
      }),
    "invalid_privacy_contract",
  );
  expectCode(
    () =>
      parsePrivacyDeletionResult({
        ...deleted,
        policy_revision: "future-policy",
      }),
    "invalid_privacy_contract",
  );
});

test("builds correction wire results with explicit idempotent outcomes", () => {
  const operation = privacyOperation({
    kind: "correct",
    evidence_digest: evidenceDigest,
    correction_digest: correctionDigest,
  });
  const first = buildPrivateEvidenceCorrectionResult(
    rootPrincipal,
    operation,
    lifecycleRecord(),
  );
  assert.deepEqual(first, {
    schema: "gossip.privacy-correction-result.v1",
    protocol: "gossip/2-draft.1",
    policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
    owner,
    operation_id: operation.operation_id,
    outcome: "corrected",
    correction_digests: [correctionDigest],
  });
  assert.deepEqual(parsePrivacyCorrectionResult(first), first);

  const retry = buildPrivateEvidenceCorrectionResult(
    rootPrincipal,
    operation,
    firstCorrectionRecord(first),
  );
  assert.equal(retry.outcome, "already_corrected");
  assert.deepEqual(retry.correction_digests, [correctionDigest]);
  expectCode(
    () =>
      parsePrivacyCorrectionResult({
        ...first,
        correction_digests: [],
      }),
    "invalid_privacy_contract",
  );
  expectCode(
    () =>
      parsePrivacyCorrectionResult({
        ...first,
        correction_digests: [correctionDigest, correctionDigest],
      }),
    "invalid_privacy_contract",
  );
  expectCode(
    () =>
      parsePrivacyCorrectionResult({
        ...first,
        policy_revision: "future-policy",
      }),
    "invalid_privacy_contract",
  );
});

function firstCorrectionRecord(
  result: ReturnType<typeof buildPrivateEvidenceCorrectionResult>,
) {
  return {
    ...lifecycleRecord(),
    correction_digests: result.correction_digests,
  };
}

test("matches canonical deletion and correction result vectors", () => {
  for (const vector of fixture.result_vectors) {
    const result = JSON.parse(vector.canonical);
    const parsed =
      vector.kind === "deletion"
        ? parsePrivacyDeletionResult(result)
        : parsePrivacyCorrectionResult(result);

    assert.deepEqual(parsed, result);
    assert.equal(canonicalJson(parsed), vector.canonical);
  }
});

test("builds deterministic owner exports and rejects server-only material", () => {
  const operation = privacyOperation({ kind: "export", scope: "all" });
  const records = [
    {
      owner,
      data_class: "private_payload" as const,
      record_id: "z",
      created_at: 2,
      owner_data: { claim: "second" },
    },
    {
      owner,
      data_class: "access_audit" as const,
      record_id: "a",
      created_at: 1,
      owner_data: { action: "read" },
    },
  ];
  const exported = buildOwnerPrivacyExport(
    rootPrincipal,
    operation,
    1_800_000_100,
    records,
  );

  assert.deepEqual(
    exported.records.map((record) => record.record_id),
    ["a", "z"],
  );
  assert.equal(exported.records[1]?.owner_data.claim, "second");
  assert.ok(exported.records.every((record) => !("owner" in record)));

  expectCode(
    () =>
      buildOwnerPrivacyExport(
        rootPrincipal,
        operation,
        1_800_000_100,
        undefined,
      ),
    "privacy_unavailable",
  );

  for (const key of [
    "server_secret",
    "private_key",
    "api_key",
    "encryptionKey",
    "access-token",
    "serverEncryptionKey",
    "privateKeyMaterial",
    "databasePassword",
    "serverSigningSecret",
    "token",
    "authToken",
    "serviceToken",
    "opaqueToken",
  ]) {
    expectCode(
      () =>
        buildOwnerPrivacyExport(rootPrincipal, operation, 1_800_000_100, [
          {
            ...records[0],
            owner_data: { [key]: "must-not-export" },
          },
        ]),
      "invalid_privacy_contract",
    );
  }
  expectCode(
    () =>
      buildOwnerPrivacyExport(rootPrincipal, operation, 1_800_000_100, [
        {
          owner,
          data_class: "aggregate_metric",
          record_id: "aggregate-window",
          created_at: 1,
          owner_data: { count: 2 },
        },
      ]),
    "invalid_privacy_contract",
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expectCode(
    () =>
      buildOwnerPrivacyExport(rootPrincipal, operation, 1_800_000_100, [
        {
          owner,
          data_class: "private_payload",
          record_id: "cyclic",
          created_at: 1,
          owner_data: cyclic,
        },
      ]),
    "invalid_privacy_contract",
  );

  expectCode(
    () =>
      buildOwnerPrivacyExport(rootPrincipal, operation, 1_800_000_100, [
        { ...records[0], owner: stranger },
      ]),
    "privacy_unavailable",
  );

  const sparseRecords = new Array(1);
  expectCode(
    () =>
      buildOwnerPrivacyExport(
        rootPrincipal,
        operation,
        1_800_000_100,
        sparseRecords,
      ),
    "invalid_privacy_contract",
  );
});

test("accepts only bounded telemetry fields and rejects canaries on error paths", () => {
  const event = {
    schema: "gossip.privacy-telemetry.v1",
    event: "privacy_operation_completed",
    correlation: {
      id: "018f47a2-4a20-7cc8-9de1-0123456789ab",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_300,
    },
    occurred_at: 1_800_000_100,
    status: "ok",
    measurements: { duration_ms: 12, item_count: 2 },
  };

  assert.deepEqual(parsePrivacyTelemetryEvent(event, 1_800_000_100), event);
  expectCode(
    () =>
      parsePrivacyTelemetryEvent(
        { ...event, source_url: "https://private.example/account/1" },
        1_800_000_100,
      ),
    "unsafe_telemetry",
  );
  expectCode(
    () =>
      parsePrivacyTelemetryEvent(
        {
          ...event,
          measurements: { ...event.measurements, private_claim: 1 },
        },
        1_800_000_100,
      ),
    "unsafe_telemetry",
  );
});

test("keeps access audit events bounded and free of owner identifiers", () => {
  const audit = {
    schema: "gossip.privacy-audit.v1",
    audit_id: "018f47a2-4a20-7cc8-9de1-0123456789ab",
    occurred_at: 1_800_000_100,
    action: "access_audit",
    record_class: "access_audit",
    outcome: "allowed",
    item_count: 2,
    correlation_id: "018f47a2-4a20-7cc8-9de1-0123456789ac",
    policy_revision: SYNTHETIC_PRIVATE_EVIDENCE_POLICY.revision,
  };

  assert.deepEqual(parsePrivacyAuditEvent(audit), audit);
  expectCode(
    () => parsePrivacyAuditEvent({ ...audit, owner }),
    "invalid_privacy_contract",
  );

  const operation = privacyOperation({
    kind: "access_audit",
    since: 1_800_000_000,
    until: 1_800_000_200,
  });
  const selected = buildOwnerAccessAudit(rootPrincipal, operation, [
    { owner, event: { ...audit, occurred_at: 1_800_000_150 } },
    { owner: stranger, event: { ...audit, occurred_at: 1_800_000_050 } },
    {
      owner,
      event: {
        ...audit,
        audit_id: "018f47a2-4a20-7cc8-9de1-0123456789aa",
        occurred_at: 1_800_000_100,
      },
    },
    { owner, event: { ...audit, occurred_at: 1_800_000_300 } },
  ]);

  assert.deepEqual(
    selected.records.map((record) => record.occurred_at),
    [1_800_000_100, 1_800_000_150],
  );
  assert.ok(selected.records.every((record) => !("owner" in record)));
  expectCode(
    () => buildOwnerAccessAudit(rootPrincipal, operation, undefined),
    "privacy_unavailable",
  );
});
