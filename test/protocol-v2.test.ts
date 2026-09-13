import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_PROFILE,
  consultationDigest,
  MCP_REVISION,
  negotiateCapabilities,
  parseConsultation,
  PROTOCOL_REVISION,
  SCHEMA_REVISION,
} from "../src/protocol-v2.js";
import { ProtocolError } from "../src/protocol-errors.js";

const actorAddress = "0x1111111111111111111111111111111111111111";
const subjectAddress = "0x2222222222222222222222222222222222222222";
const endpoint = "https://gossip.example/mcp/";
const audience = "https://gossip.example/";

function consultation(overrides: Record<string, unknown> = {}) {
  return {
    protocol: PROTOCOL_REVISION,
    schema_revision: SCHEMA_REVISION,
    auth_profile: AUTH_PROFILE,
    operation_id: "consult_1",
    actor: { chain_id: "4663", address: actorAddress },
    subject: { kind: "token", chain_id: "4663", address: subjectAddress },
    capability: "token_overview",
    endpoint,
    audience,
    quality: {
      tier: "standard",
      max_age_seconds: 300,
      finality: "safe",
      allow_partial: false,
    },
    max_cost: { unit: "earned_credit", amount: "0" },
    deadline: 2_000,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: ProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

function feature(
  capability: string,
  status: "verified" | "installed" | "blocked" = "verified",
) {
  return status === "verified"
    ? { capability, status, evidence_revision: "engine-1" }
    : {
        capability,
        status,
        reason: "Unavailable in this deployment",
        next_action: "Enable the feature after conformance",
      };
}

function capabilities(overrides: Record<string, unknown> = {}) {
  return {
    protocols: [PROTOCOL_REVISION],
    schema_revisions: [SCHEMA_REVISION],
    auth_profiles: [AUTH_PROFILE],
    mcp_revision: MCP_REVISION,
    server: { id: "sherwood", revision: "engine-1" },
    endpoint,
    audience,
    issued_at: 1_000,
    expires_at: 2_000,
    limits: {
      max_request_bytes: 32_768,
      max_depth: 8,
      max_collection_items: 128,
    },
    features: [
      feature("atomic_consult"),
      feature("durable_operations"),
      feature("signed_receipts"),
      feature("evidence"),
      feature("session_keys", "blocked"),
    ],
    ...overrides,
  };
}

const expectedConnection = {
  endpoint,
  audience,
  mcp_revision: MCP_REVISION,
  auth_profile: AUTH_PROFILE,
};

test("parses a strict standard consultation and binds every field in its digest", () => {
  const input = consultation();
  const parsed = parseConsultation(input, 1_000);

  assert.deepEqual(parsed, input);
  assert.match(consultationDigest(input), /^sha256:[0-9a-f]{64}$/);
});

test("digest binds every mutable consultation field and does not use the clock", () => {
  const input = consultation();
  const enriched = consultation({
    quality: {
      tier: "enriched",
      max_age_seconds: 300,
      finality: "safe",
      allow_partial: false,
    },
    max_cost: { unit: "earned_credit", amount: "0" },
  });
  const enrichedCost = {
    ...enriched,
    max_cost: { unit: "earned_credit", amount: "1" },
  };
  const enrichedCostChanged = {
    ...enriched,
    max_cost: { unit: "earned_credit", amount: "2" },
  };
  const mutations = [
    consultation({ operation_id: "consult_2" }),
    consultation({ actor: { chain_id: "4664", address: actorAddress } }),
    consultation({ actor: { chain_id: "4663", address: subjectAddress } }),
    consultation({
      subject: { kind: "token", chain_id: "4664", address: subjectAddress },
    }),
    consultation({
      subject: { kind: "token", chain_id: "4663", address: actorAddress },
    }),
    consultation({ endpoint: "https://gossip.example/other/?q=1" }),
    consultation({ audience: "https://audience.example/" }),
    enriched,
    consultation({
      quality: { ...consultation().quality, max_age_seconds: 301 },
    }),
    consultation({
      quality: { ...consultation().quality, finality: "latest" },
    }),
    consultation({
      quality: { ...consultation().quality, allow_partial: true },
    }),
    consultation({ deadline: 2_001 }),
  ];

  for (const changed of mutations) {
    assert.notEqual(consultationDigest(input), consultationDigest(changed));
  }
  assert.notEqual(
    consultationDigest(enrichedCost),
    consultationDigest(enrichedCostChanged),
  );
  assert.equal(parseConsultation(input, 1_999).deadline, 2_000);
  for (const field of [
    "protocol",
    "schema_revision",
    "auth_profile",
  ] as const) {
    expectCode(
      () => consultationDigest(consultation({ [field]: "wrong" })),
      "invalid_request",
    );
  }
});

test("canonical validation runs before schema traversal and rejects non-canonical values", () => {
  const withExtra = consultation({ unexpected: true });
  expectCode(() => parseConsultation(withExtra, 1_000), "invalid_request");

  const accessor = consultation();
  Object.defineProperty(accessor, "operation_id", {
    enumerable: true,
    get: () => "consult_1",
  });
  expectCode(
    () => parseConsultation(accessor, 1_000),
    "invalid_canonical_json",
  );
});

test("rejects coercion, non-canonical URLs, invalid identifiers, and invalid numbers", () => {
  expectCode(
    () => parseConsultation(consultation({ deadline: "2000" }), 1_000),
    "invalid_request",
  );
  expectCode(
    () =>
      parseConsultation(
        consultation({ endpoint: "https://gossip.example" }),
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      parseConsultation(
        consultation({ audience: "https://gossip.example/#" }),
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      parseConsultation(
        consultation({ actor: { chain_id: "04663", address: actorAddress } }),
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      parseConsultation(
        consultation({
          quality: { ...consultation().quality, max_age_seconds: 1.5 },
        }),
        1_000,
      ),
    "invalid_canonical_json",
  );
});

test("enforces capability and standard cost semantics", () => {
  expectCode(
    () =>
      parseConsultation(
        consultation({
          subject: {
            kind: "wallet",
            chain_id: "4663",
            address: subjectAddress,
          },
        }),
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      parseConsultation(
        consultation({ max_cost: { unit: "earned_credit", amount: "1" } }),
        1_000,
      ),
    "invalid_request",
  );
});

test("rejects a deadline at or before now", () => {
  expectCode(
    () => parseConsultation(consultation(), 2_000),
    "expired_deadline",
  );
  expectCode(
    () => parseConsultation(consultation({ deadline: 999 }), 1_000),
    "expired_deadline",
  );
  for (const now of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    253_402_300_800,
  ]) {
    expectCode(() => parseConsultation(consultation(), now), "invalid_request");
  }
});

test("negotiates verified core capabilities and retains reported lower limits", () => {
  assert.deepEqual(
    negotiateCapabilities(capabilities(), expectedConnection, 1_000),
    {
      protocol: PROTOCOL_REVISION,
      schema_revision: SCHEMA_REVISION,
      auth_profile: AUTH_PROFILE,
      mcp_revision: MCP_REVISION,
      endpoint,
      audience,
      server: { id: "sherwood", revision: "engine-1" },
      expires_at: 2_000,
      limits: {
        max_request_bytes: 32_768,
        max_depth: 8,
        max_collection_items: 128,
      },
    },
  );
});

test("accepts installed public submission as a non-core advertised capability", () => {
  const report = capabilities({
    features: [
      ...capabilities().features,
      feature("public_submission", "installed"),
    ],
  });

  assert.doesNotThrow(() =>
    negotiateCapabilities(report, expectedConnection, 1_000),
  );
});

test("capability report validity tolerates HTTP Date precision at issue time", () => {
  assert.doesNotThrow(() =>
    negotiateCapabilities(capabilities(), expectedConnection, 1_000),
  );
  assert.doesNotThrow(() =>
    negotiateCapabilities(capabilities(), expectedConnection, 999),
  );
  assert.doesNotThrow(() =>
    negotiateCapabilities(capabilities(), expectedConnection, 1_999),
  );
  expectCode(
    () => negotiateCapabilities(capabilities(), expectedConnection, 2_000),
    "expired_capabilities",
  );
  expectCode(
    () => negotiateCapabilities(capabilities(), expectedConnection, 998),
    "expired_capabilities",
  );
});

test("rejects protocol, schema, auth, MCP, endpoint, audience, and core readiness mismatches", () => {
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({ protocols: ["gossip/1"] }),
        expectedConnection,
        1_000,
      ),
    "unsupported_version",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({ schema_revisions: ["2026-01-01"] }),
        expectedConnection,
        1_000,
      ),
    "unsupported_version",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({ auth_profiles: ["gossip-eip191-v1"] }),
        expectedConnection,
        1_000,
      ),
    "unsupported_auth_profile",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({ mcp_revision: "2025-06-18" }),
        expectedConnection,
        1_000,
      ),
    "unsupported_version",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({ endpoint: "https://other.example/mcp/" }),
        expectedConnection,
        1_000,
      ),
    "capability_mismatch",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({ audience: "https://other.example/" }),
        expectedConnection,
        1_000,
      ),
    "capability_mismatch",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities(),
        { ...expectedConnection, endpoint: "https://gossip.example" },
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () => negotiateCapabilities(capabilities(), expectedConnection, 2_000.5),
    "invalid_request",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities(),
        { ...expectedConnection, auth_profile: "gossip profile" },
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities(),
        { ...expectedConnection, mcp_revision: "2025-06-18" },
        1_000,
      ),
    "unsupported_version",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities(),
        { ...expectedConnection, auth_profile: "gossip-eip191-v1" },
        1_000,
      ),
    "unsupported_auth_profile",
  );
  const withoutCore = capabilities({
    features: [
      feature("durable_operations"),
      feature("signed_receipts"),
      feature("evidence"),
    ],
  });
  expectCode(
    () => negotiateCapabilities(withoutCore, expectedConnection, 1_000),
    "unsupported_capability",
  );
  const installedCore = capabilities({
    features: [
      feature("durable_operations"),
      feature("signed_receipts"),
      feature("evidence"),
      {
        capability: "atomic_consult",
        status: "installed",
        reason: "Pending verification",
        next_action: "Run vectors",
      },
    ],
  });
  expectCode(
    () => negotiateCapabilities(installedCore, expectedConnection, 1_000),
    "unsupported_capability",
  );
});

test("rejects duplicate revisions/features and invalid feature evidence rules", () => {
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({ protocols: [PROTOCOL_REVISION, PROTOCOL_REVISION] }),
        expectedConnection,
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({
          features: [
            feature("atomic_consult"),
            feature("atomic_consult"),
            feature("durable_operations"),
            feature("signed_receipts"),
            feature("evidence"),
          ],
        }),
        expectedConnection,
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({
          features: [
            { capability: "atomic_consult", status: "verified" },
            feature("durable_operations"),
            feature("signed_receipts"),
            feature("evidence"),
          ],
        }),
        expectedConnection,
        1_000,
      ),
    "invalid_request",
  );
});

test("capability schema bounds report lifetime, limits, and feature text", () => {
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({ expires_at: 5_001 }),
        expectedConnection,
        1_000,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({
          limits: {
            max_request_bytes: 65_537,
            max_depth: 8,
            max_collection_items: 128,
          },
        }),
        expectedConnection,
        1_000,
      ),
    "invalid_request",
  );
  const malformedFeature = {
    capability: "session_keys",
    status: "blocked",
    reason: "x",
    next_action: "y",
    evidence_revision: "engine-1",
  };
  expectCode(
    () =>
      negotiateCapabilities(
        capabilities({
          features: [
            feature("atomic_consult"),
            feature("durable_operations"),
            feature("signed_receipts"),
            feature("evidence"),
            malformedFeature,
          ],
        }),
        expectedConnection,
        1_000,
      ),
    "invalid_request",
  );
});
