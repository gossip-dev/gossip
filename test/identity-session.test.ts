import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Wallet } from "ethers";
import {
  gossipV2AuthHeaders,
  gossipV2AuthMessage,
  type GossipV2HttpRequest,
} from "../src/http-auth-v2.js";
import { canonicalJson } from "../src/canonical.js";
import { parsePublicSubmission } from "../src/public-submission-v1.js";
import {
  authorizeIdentitySession,
  authorizeIdentitySessionMcp,
  mapIdentitySessionToolPayload,
  parseIdentitySessionMcpArguments,
  parseIdentitySessionRequest,
  identitySessionGrantDigest,
  identitySessionGrantMessage,
  identitySessionRevocationDigest,
  identitySessionRevocationMessage,
  verifyIdentitySessionTransport,
  verifyIdentitySessionChain,
  verifyIdentitySessionGrant,
  verifyIdentitySessionRevocation,
} from "../src/identity-session.js";
import { ProtocolError } from "../src/protocol-errors.js";

const root = new Wallet(`0x${"00".repeat(31)}01`);
const sessionOne = new Wallet(`0x${"00".repeat(31)}02`);
const sessionTwo = new Wallet(`0x${"00".repeat(31)}03`);
const secp256k1Order =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-identity-session.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

function grant(
  session: Wallet,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "gossip.identity-session.v1",
    protocol: "gossip/2-draft.1",
    root: {
      chain_id: "4663",
      address: root.address.toLowerCase(),
    },
    session: {
      key_id: session === sessionOne ? "session-1" : "session-2",
      public_key: session.signingKey.publicKey,
      address: session.address.toLowerCase(),
    },
    endpoint: "https://engine.test/mcp",
    audience: "https://engine.test/",
    tools: [
      "gossip_capabilities",
      "gossip_consult_v2",
      "gossip_operation",
      "gossip_receipt_v2",
    ],
    submission_kinds: [],
    max_cost: { unit: "earned_credit", amount: "0" },
    issued_at: 1_800_000_000,
    expires_at: 1_800_003_600,
    previous: null,
    ...overrides,
  };
}

async function signedGrant(
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const digest = identitySessionGrantDigest(value);
  return {
    grant: value,
    grant_digest: digest,
    root_public_key: root.signingKey.publicKey,
    signature: await root.signMessage(identitySessionGrantMessage(digest)),
  };
}

async function signedRevocation(
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const digest = identitySessionRevocationDigest(value);
  return {
    revocation: value,
    revocation_digest: digest,
    root_public_key: root.signingKey.publicKey,
    signature: await root.signMessage(identitySessionRevocationMessage(digest)),
  };
}

async function authenticatedRequest(
  signer: Wallet,
  context: Record<string, unknown> = requestContext(),
  expires = "1800000400",
): Promise<GossipV2HttpRequest> {
  const body = new TextEncoder().encode(canonicalJson(context));
  const request = {
    audience: "https://engine.test/",
    endpoint: "https://engine.test/mcp",
    method: "POST",
    target: "/mcp",
    body,
    nonce: "00000000-0000-4000-8000-000000000001",
    expires,
  };
  const signature = await signer.signMessage(gossipV2AuthMessage(request));
  return {
    ...request,
    headers: gossipV2AuthHeaders({
      publicKey: signer.signingKey.publicKey,
      signature,
      nonce: request.nonce,
      expires: request.expires,
    }),
  };
}

async function authenticatedMcpRequest(
  signer: Wallet,
  sessionRequest: Record<string, unknown>,
  actualTool = String(sessionRequest.tool),
): Promise<GossipV2HttpRequest> {
  const request = await authenticatedRequest(signer);
  const body = new TextEncoder().encode(
    canonicalJson({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: actualTool,
        arguments: { session_request: sessionRequest },
      },
    }),
  );
  const signature = await signer.signMessage(
    gossipV2AuthMessage({ ...request, body }),
  );
  return {
    ...request,
    body,
    headers: gossipV2AuthHeaders({
      publicKey: signer.signingKey.publicKey,
      signature,
      nonce: request.nonce,
      expires: request.expires,
    }),
  };
}

function requestContext(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "gossip.identity-session-request.v1",
    protocol: "gossip/2-draft.1",
    root: { chain_id: "4663", address: root.address.toLowerCase() },
    key_id: "session-1",
    tool: "gossip_consult_v2",
    submission_kind: null,
    cost: { unit: "earned_credit", amount: "0" },
    payload: { operation_id: "synthetic-operation" },
    ...overrides,
  };
}

function consultationPayload(
  operationId = "consultation-1",
): Record<string, unknown> {
  return {
    protocol: "gossip/2-draft.1",
    schema_revision: "2026-09-09",
    auth_profile: "gossip-eip191-v2",
    operation_id: operationId,
    actor: {
      chain_id: "4663",
      address: root.address.toLowerCase(),
    },
    subject: {
      kind: "wallet",
      chain_id: "4663",
      address: root.address.toLowerCase(),
    },
    capability: "wallet_overview",
    endpoint: "https://engine.test/mcp",
    audience: "https://engine.test/",
    quality: {
      tier: "standard",
      max_age_seconds: 0,
      finality: "latest",
      allow_partial: false,
    },
    max_cost: { unit: "earned_credit", amount: "0" },
    deadline: 1_800_000_400,
  };
}

function publicSubmissionPayload(
  actorAddress = root.address.toLowerCase(),
  operationId = "public-submission-1",
  endpoint = "https://gossip.example/mcp/",
  audience = "https://gossip.example/",
): Record<string, unknown> {
  const value = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/v2-public-submission.json", import.meta.url),
      "utf8",
    ),
  ) as { canonical: string };
  const payload = JSON.parse(value.canonical) as Record<string, any>;
  payload.operation_id = operationId;
  payload.actor.address = actorAddress;
  payload.endpoint = endpoint;
  payload.audience = audience;
  return payload;
}

function expectCode(action: () => unknown, code: ProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

test("verifies a root-signed, information-only session grant", async () => {
  const value = grant(sessionOne);
  const signed = await signedGrant(value);
  const verified = verifyIdentitySessionGrant(signed);

  assert.equal(verified.grant_digest, identitySessionGrantDigest(value));
  assert.equal(verified.grant.root.address, root.address.toLowerCase());
  assert.equal(
    verified.grant.session.address,
    sessionOne.address.toLowerCase(),
  );
});

test("verifies literal grant, rotation, and revocation vectors", () => {
  const first = verifyIdentitySessionGrant(fixture.first_grant);
  const rotated = verifyIdentitySessionGrant(fixture.rotated_grant);
  const revocation = verifyIdentitySessionRevocation(fixture.revocation);

  assert.equal(
    identitySessionGrantMessage(first.grant_digest),
    fixture.first_message,
  );
  assert.equal(
    identitySessionGrantMessage(rotated.grant_digest),
    fixture.rotated_message,
  );
  assert.equal(
    identitySessionRevocationMessage(revocation.revocation_digest),
    fixture.revocation_message,
  );
  assert.equal(
    verifyIdentitySessionChain([fixture.first_grant, fixture.rotated_grant])
      .active.grant.session.key_id,
    "session-2",
  );

  const requestVector = fixture.session_request;
  const authorized = authorizeIdentitySession({
    grants: [fixture.first_grant],
    revocations: [],
    now: 1_800_000_200,
    request: {
      audience: String(requestVector.audience),
      endpoint: String(requestVector.endpoint),
      method: String(requestVector.method),
      target: String(requestVector.target),
      body: new TextEncoder().encode(String(requestVector.body)),
      nonce: String(requestVector.nonce),
      expires: String(requestVector.expires),
      headers: gossipV2AuthHeaders({
        publicKey: String(requestVector.public_key),
        signature: String(requestVector.signature),
        nonce: String(requestVector.nonce),
        expires: String(requestVector.expires),
      }),
    },
    verifier: {
      endpoint: String(requestVector.endpoint),
      audience: String(requestVector.audience),
    },
  });
  assert.equal(authorized.request.tool, "gossip_consult_v2");
});

test("verifies the literal public_submission grant and request vector", () => {
  const vector = fixture.public_submission_session as any;
  const signedGrant = verifyIdentitySessionGrant(vector.grant);
  const request = parseIdentitySessionRequest(vector.body);
  const authenticatedRequest: GossipV2HttpRequest = {
    audience: vector.audience,
    endpoint: vector.endpoint,
    method: vector.method,
    target: vector.target,
    body: new TextEncoder().encode(vector.body),
    nonce: vector.nonce,
    expires: vector.expires,
    headers: vector.headers,
  };

  assert.equal(signedGrant.grant.submission_kinds[0], "public_submission");
  assert.equal(request.tool, "gossip_submit_v2");
  assert.equal(request.submission_kind, "public_submission");
  assert.equal(request.cost.amount, "0");
  assert.doesNotThrow(() =>
    mapIdentitySessionToolPayload({
      root: request.root,
      tool: request.tool,
      submission_kind: request.submission_kind,
      payload: request.payload,
      cost: request.cost,
      endpoint: vector.endpoint,
      audience: vector.audience,
    }),
  );
  assert.doesNotThrow(() =>
    authorizeIdentitySession({
      grants: [vector.grant],
      revocations: [],
      now: 1_800_000_200,
      request: authenticatedRequest,
      verifier: {
        endpoint: vector.endpoint,
        audience: vector.audience,
      },
    }),
  );
  assert.doesNotThrow(() =>
    verifyIdentitySessionTransport(authenticatedRequest, 1_800_000_200, {
      endpoint: vector.endpoint,
      audience: vector.audience,
    }),
  );
});

test("rejects the incomplete consultation payload", async () => {
  const request = await authenticatedRequest(sessionOne);

  expectCode(
    () =>
      authorizeIdentitySession({
        grants: [fixture.first_grant],
        revocations: [],
        now: 1_800_000_200,
        request,
        verifier: {
          endpoint: "https://engine.test/mcp",
          audience: "https://engine.test/",
        },
      }),
    "invalid_request",
  );
});

test("extracts the session envelope from signed raw transport bytes", async () => {
  const request = await authenticatedRequest(sessionOne);
  const authenticated = verifyIdentitySessionTransport(request, 1_800_000_200, {
    endpoint: "https://engine.test/mcp",
    audience: "https://engine.test/",
  });

  assert.equal(authenticated.publicKey, sessionOne.signingKey.publicKey);
  assert.equal(
    parseIdentitySessionRequest(request.body).tool,
    "gossip_consult_v2",
  );

  const tampered = {
    ...request,
    body: new TextEncoder().encode(
      canonicalJson(requestContext({ payload: { operation_id: "changed" } })),
    ),
  };
  expectCode(
    () =>
      verifyIdentitySessionTransport(tampered, 1_800_000_200, {
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      }),
    "unauthorized",
  );

  const mcpRequest = await authenticatedMcpRequest(
    sessionOne,
    requestContext(),
    "gossip_consult_v2",
  );
  const mcpAuthenticated = verifyIdentitySessionTransport(
    mcpRequest,
    1_800_000_200,
    {
      endpoint: "https://engine.test/mcp",
      audience: "https://engine.test/",
    },
  );
  const mcpEnvelope = parseIdentitySessionMcpArguments(
    JSON.parse(new TextDecoder().decode(mcpRequest.body)).params.arguments,
    "gossip_consult_v2",
  );
  assert.equal(mcpAuthenticated.publicKey, sessionOne.signingKey.publicKey);
  assert.equal(mcpEnvelope.session_request.tool, "gossip_consult_v2");
});

test("binds MCP authorization to the authenticated raw body", async () => {
  const signed = await signedGrant(grant(sessionOne));
  const first = {
    schema: "gossip.identity-session-request.v1" as const,
    protocol: "gossip/2-draft.1" as const,
    root: { chain_id: "4663", address: root.address.toLowerCase() },
    key_id: "session-1",
    tool: "gossip_consult_v2" as const,
    submission_kind: null,
    cost: { unit: "earned_credit" as const, amount: "0" },
    payload: consultationPayload("mcp-first"),
  };
  const second = {
    ...first,
    payload: consultationPayload("mcp-second"),
  };
  const firstRequest = await authenticatedMcpRequest(sessionOne, first);
  const secondRequest = await authenticatedMcpRequest(sessionOne, second);
  const noncanonicalBody = new TextEncoder().encode(
    `{ "params": { "arguments": { "session_request": ${canonicalJson(first)} }, "name": "gossip_consult_v2", "_meta": { "progressToken": "progress-1" } }, "id": 1, "method": "tools/call", "jsonrpc": "2.0" }`,
  );
  const noncanonicalBase = await authenticatedRequest(sessionOne);
  const noncanonicalSignature = await sessionOne.signMessage(
    gossipV2AuthMessage({ ...noncanonicalBase, body: noncanonicalBody }),
  );
  const noncanonicalRequest = {
    ...noncanonicalBase,
    body: noncanonicalBody,
    headers: gossipV2AuthHeaders({
      publicKey: sessionOne.signingKey.publicKey,
      signature: noncanonicalSignature,
      nonce: noncanonicalBase.nonce,
      expires: noncanonicalBase.expires,
    }),
  };

  assert.doesNotThrow(() =>
    authorizeIdentitySessionMcp({
      grants: [signed],
      revocations: [],
      now: 1_800_000_200,
      request: firstRequest,
      verifier: {
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      },
      actualTool: "gossip_consult_v2",
    }),
  );
  const taskBody = new TextEncoder().encode(
    canonicalJson({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "gossip_consult_v2",
        arguments: { session_request: first },
        task: { id: "task-1" },
      },
    }),
  );
  const taskBase = await authenticatedRequest(sessionOne);
  const taskSignature = await sessionOne.signMessage(
    gossipV2AuthMessage({ ...taskBase, body: taskBody }),
  );
  expectCode(
    () =>
      authorizeIdentitySessionMcp({
        grants: [signed],
        revocations: [],
        now: 1_800_000_200,
        request: {
          ...taskBase,
          body: taskBody,
          headers: gossipV2AuthHeaders({
            publicKey: sessionOne.signingKey.publicKey,
            signature: taskSignature,
            nonce: taskBase.nonce,
            expires: taskBase.expires,
          }),
        },
        verifier: {
          endpoint: "https://engine.test/mcp",
          audience: "https://engine.test/",
        },
        actualTool: "gossip_consult_v2",
      }),
    "invalid_request",
  );
  assert.doesNotThrow(() =>
    authorizeIdentitySessionMcp({
      grants: [signed],
      revocations: [],
      now: 1_800_000_200,
      request: noncanonicalRequest,
      verifier: {
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      },
      actualTool: "gossip_consult_v2",
    }),
  );
  assert.doesNotThrow(() =>
    authorizeIdentitySessionMcp({
      grants: [signed],
      revocations: [],
      now: 1_800_000_200,
      request: secondRequest,
      verifier: {
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      },
      actualTool: "gossip_consult_v2",
    }),
  );

  const duplicateBodies = [
    `{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "gossip_consult_v2", "name": "gossip_consult_v2", "arguments": { "session_request": ${canonicalJson(first)} } } }`,
    `{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "gossip_consult_v2", "arguments": { "session_request": ${canonicalJson(first)} }, "arguments": { "session_request": ${canonicalJson(first)} } } }`,
    `{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "gossip_consult_v2", "arguments": { "session_request": ${canonicalJson(first)}, "session_request": ${canonicalJson(first)} } } }`,
  ];
  for (const bodyText of duplicateBodies) {
    const body = new TextEncoder().encode(bodyText);
    const base = await authenticatedRequest(sessionOne);
    const signature = await sessionOne.signMessage(
      gossipV2AuthMessage({ ...base, body }),
    );
    expectCode(
      () =>
        authorizeIdentitySessionMcp({
          grants: [signed],
          revocations: [],
          now: 1_800_000_200,
          request: {
            ...base,
            body,
            headers: gossipV2AuthHeaders({
              publicKey: sessionOne.signingKey.publicKey,
              signature,
              nonce: base.nonce,
              expires: base.expires,
            }),
          },
          verifier: {
            endpoint: "https://engine.test/mcp",
            audience: "https://engine.test/",
          },
          actualTool: "gossip_consult_v2",
        }),
      "invalid_request",
    );
  }

  expectCode(
    () =>
      authorizeIdentitySessionMcp({
        grants: [signed],
        revocations: [],
        now: 1_800_000_200,
        request: { ...firstRequest, body: secondRequest.body },
        verifier: {
          endpoint: "https://engine.test/mcp",
          audience: "https://engine.test/",
        },
        actualTool: "gossip_consult_v2",
      }),
    "unauthorized",
  );
});

test("maps each implementable session tool to its exact payload and cost", async () => {
  const consultation = consultationPayload();

  assert.deepEqual(
    mapIdentitySessionToolPayload({
      root: { chain_id: "4663", address: root.address.toLowerCase() },
      tool: "gossip_capabilities",
      payload: {},
      cost: { unit: "earned_credit", amount: "0" },
    }),
    {},
  );
  assert.deepEqual(
    mapIdentitySessionToolPayload({
      root: { chain_id: "4663", address: root.address.toLowerCase() },
      tool: "gossip_consult_v2",
      payload: consultation,
      cost: consultation.max_cost,
      endpoint: "https://engine.test/mcp",
      audience: "https://engine.test/",
    }),
    consultation,
  );
  assert.deepEqual(
    mapIdentitySessionToolPayload({
      root: { chain_id: "4663", address: root.address.toLowerCase() },
      tool: "gossip_operation",
      payload: { operation_id: "operation-1" },
      cost: { unit: "earned_credit", amount: "0" },
    }),
    { operation_id: "operation-1" },
  );

  const publicSubmission = publicSubmissionPayload();
  assert.deepEqual(
    mapIdentitySessionToolPayload({
      root: { chain_id: "4663", address: root.address.toLowerCase() },
      tool: "gossip_submit_v2",
      submission_kind: "public_submission",
      payload: publicSubmission,
      cost: { unit: "earned_credit", amount: "0" },
      endpoint: "https://gossip.example/mcp/",
      audience: "https://gossip.example/",
    }),
    parsePublicSubmission(publicSubmission),
  );
  assert.deepEqual(
    mapIdentitySessionToolPayload({
      root: { chain_id: "4663", address: root.address.toLowerCase() },
      tool: "gossip_receipt_v2",
      payload: { operation_id: "operation-1" },
      cost: { unit: "earned_credit", amount: "0" },
    }),
    { operation_id: "operation-1" },
  );

  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_consult_v2",
        payload: consultation,
        cost: { unit: "earned_credit", amount: "1" },
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_operation",
        payload: consultation,
        cost: { unit: "earned_credit", amount: "0" },
      }),
    "invalid_request",
  );

  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_consult_v2",
        payload: {
          ...consultation,
          actor: {
            ...consultation.actor,
            address: sessionOne.address.toLowerCase(),
          },
        },
        cost: consultation.max_cost,
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      }),
    "invalid_request",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_consult_v2",
        payload: { ...consultation, endpoint: "https://other.test/mcp" },
        cost: consultation.max_cost,
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: sessionOne.address.toLowerCase() },
        tool: "gossip_submit_v2",
        submission_kind: "public_submission",
        payload: publicSubmission,
        cost: { unit: "earned_credit", amount: "0" },
        endpoint: "https://gossip.example/mcp/",
        audience: "https://gossip.example/",
      }),
    "invalid_request",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_submit_v2",
        submission_kind: "public_submission",
        payload: publicSubmission,
        cost: { unit: "earned_credit", amount: "1" },
        endpoint: "https://gossip.example/mcp/",
        audience: "https://gossip.example/",
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_submit_v2",
        submission_kind: "public_submission",
        payload: publicSubmission,
        cost: { unit: "earned_credit", amount: "0" },
        endpoint: "https://gossip.example/mcp/",
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_submit_v2",
        submission_kind: "public_submission",
        payload: publicSubmission,
        cost: { unit: "earned_credit", amount: "0" },
        endpoint: "https://gossip.example/mcp/",
        audience: "https://other.example/",
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_submit_v2",
        submission_kind: "public_submission",
        payload: publicSubmission,
        cost: { unit: "earned_credit", amount: "0" },
        endpoint: "https://other.example/mcp/",
        audience: "https://gossip.example/",
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_submit_v2",
        submission_kind: "public_submission",
        payload: publicSubmission,
        cost: { unit: "earned_credit", amount: "0" },
        audience: "https://gossip.example/",
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_submit_v2",
        submission_kind: "chain_observation",
        payload: publicSubmission,
        cost: { unit: "earned_credit", amount: "0" },
        endpoint: "https://gossip.example/mcp/",
        audience: "https://gossip.example/",
      }),
    "unsupported_capability",
  );
  expectCode(
    () =>
      mapIdentitySessionToolPayload({
        root: { chain_id: "4663", address: root.address.toLowerCase() },
        tool: "gossip_feedback",
        submission_kind: "public_submission",
        payload: {},
        cost: { unit: "earned_credit", amount: "0" },
      }),
    "unsupported_capability",
  );

  const signed = await signedGrant(grant(sessionOne));
  const extracted = {
    schema: "gossip.identity-session-request.v1" as const,
    protocol: "gossip/2-draft.1" as const,
    root: { chain_id: "4663", address: root.address.toLowerCase() },
    key_id: "session-1",
    tool: "gossip_consult_v2" as const,
    submission_kind: null,
    cost: consultation.max_cost,
    payload: consultation,
  };
  const mcpRequest = await authenticatedMcpRequest(sessionOne, extracted);
  assert.doesNotThrow(() =>
    authorizeIdentitySessionMcp({
      grants: [signed],
      revocations: [],
      now: 1_800_000_200,
      request: mcpRequest,
      verifier: {
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      },
      actualTool: "gossip_consult_v2",
    }),
  );
});

test("authorizes a public_submission grant and exact public payload", async () => {
  const value = grant(sessionOne, {
    tools: ["gossip_submit_v2"],
    submission_kinds: ["public_submission"],
  });
  const signed = await signedGrant(value);
  const payload = publicSubmissionPayload(
    root.address.toLowerCase(),
    "public-submission-1",
    "https://engine.test/mcp",
    "https://engine.test/",
  );
  const request = await authenticatedRequest(
    sessionOne,
    requestContext({
      tool: "gossip_submit_v2",
      submission_kind: "public_submission",
      payload,
    }),
  );

  const authorized = authorizeIdentitySession({
    grants: [signed],
    revocations: [],
    now: 1_800_000_200,
    request,
    verifier: {
      endpoint: "https://engine.test/mcp",
      audience: "https://engine.test/",
    },
  });

  assert.equal(authorized.request.submission_kind, "public_submission");
  assert.deepEqual(authorized.request.payload, payload);
});

test("requires an exclusive session_request MCP argument", () => {
  const request = requestContext();
  assert.deepEqual(
    parseIdentitySessionMcpArguments(
      { session_request: request },
      "gossip_consult_v2",
    ),
    {
      session_request: request,
    },
  );
  expectCode(
    () =>
      parseIdentitySessionMcpArguments(
        { session_request: request },
        "gossip_operation",
      ),
    "invalid_request",
  );

  expectCode(
    () =>
      parseIdentitySessionMcpArguments(
        {
          request,
          session_request: request,
        },
        "gossip_consult_v2",
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      parseIdentitySessionMcpArguments(
        {
          session_request: request,
          extra: true,
        },
        "gossip_consult_v2",
      ),
    "invalid_request",
  );
});

test("rejects scope and signature tampering", async () => {
  const signed = await signedGrant(grant(sessionOne));
  const changedScope = structuredClone(signed);
  const changedGrant = changedScope.grant as Record<string, unknown>;
  changedGrant.max_cost = { unit: "earned_credit", amount: "1" };

  expectCode(() => verifyIdentitySessionGrant(changedScope), "digest_mismatch");

  const changedSignature = structuredClone(signed);
  changedSignature.signature = `0x${"00".repeat(65)}`;
  expectCode(
    () => verifyIdentitySessionGrant(changedSignature),
    "unauthorized",
  );

  const highS = structuredClone(signed);
  const signatureBytes = Buffer.from(String(highS.signature).slice(2), "hex");
  const originalS = BigInt(
    `0x${signatureBytes.subarray(32, 64).toString("hex")}`,
  );
  signatureBytes.set(
    Buffer.from(
      (secp256k1Order - originalS).toString(16).padStart(64, "0"),
      "hex",
    ),
    32,
  );
  highS.signature = `0x${signatureBytes.toString("hex")}`;
  expectCode(() => verifyIdentitySessionGrant(highS), "unauthorized");

  expectCode(
    () =>
      identitySessionGrantDigest(
        grant(sessionOne, { tools: ["gossip_trade"] }),
      ),
    "invalid_request",
  );
});

test("rejects the wrong root, destination, key, and time", async () => {
  const chain = verifyIdentitySessionChain([
    await signedGrant(grant(sessionOne)),
  ]);
  const request = await authenticatedRequest(sessionOne);
  const valid = {
    grants: chain.grants,
    revocations: [],
    now: 1_800_000_200,
    request,
    verifier: {
      endpoint: "https://engine.test/mcp",
      audience: "https://engine.test/",
    },
  };
  const invalid = [
    { ...valid, now: 1_799_999_999 },
    { ...valid, now: 1_800_003_600 },
    {
      ...valid,
      request: await authenticatedRequest(
        sessionOne,
        requestContext({
          root: { chain_id: "1", address: root.address.toLowerCase() },
        }),
      ),
    },
    {
      ...valid,
      request: await authenticatedRequest(
        sessionOne,
        requestContext({ key_id: "unknown-session" }),
      ),
    },
    {
      ...valid,
      request: await authenticatedRequest(sessionTwo),
    },
    {
      ...valid,
      request: { ...request, endpoint: "https://other.test/mcp" },
    },
    {
      ...valid,
      request: { ...request, audience: "https://other.test/" },
    },
    {
      ...valid,
      request: {
        ...request,
        body: new TextEncoder().encode(
          canonicalJson(requestContext({ tool: "gossip_operation" })),
        ),
      },
    },
  ];

  for (const input of invalid) {
    expectCode(() => authorizeIdentitySession(input), "unauthorized");
  }

  expectCode(() => authorizeIdentitySession({}), "invalid_request");
});

test("rotation replaces scope instead of inheriting it", async () => {
  const first = await signedGrant(
    grant(sessionOne, {
      tools: ["gossip_consult_v2", "gossip_operation"],
    }),
  );
  const firstDigest = first.grant_digest as string;
  const second = await signedGrant(
    grant(sessionTwo, {
      tools: ["gossip_operation"],
      issued_at: 1_800_000_100,
      expires_at: 1_800_003_700,
      previous: { key_id: "session-1", grant_digest: firstDigest },
    }),
  );
  const chain = verifyIdentitySessionChain([first, second]);
  const requestTwoConsult = await authenticatedRequest(
    sessionTwo,
    requestContext({ key_id: "session-2" }),
  );
  const requestTwoOperation = await authenticatedRequest(
    sessionTwo,
    requestContext({ key_id: "session-2", tool: "gossip_operation" }),
  );

  const brokenSuccessor = await signedGrant(
    grant(sessionTwo, {
      tools: ["gossip_operation"],
      issued_at: 1_800_000_100,
      expires_at: 1_800_003_700,
      previous: {
        key_id: "session-1",
        grant_digest: `sha256:${"0".repeat(64)}`,
      },
    }),
  );
  expectCode(
    () => verifyIdentitySessionChain([first, brokenSuccessor]),
    "invalid_request",
  );

  assert.equal(chain.active.grant.session.key_id, "session-2");
  expectCode(
    () =>
      authorizeIdentitySession({
        grants: chain.grants,
        revocations: [],
        now: 1_800_000_200,
        request: requestTwoConsult,
        verifier: {
          endpoint: "https://engine.test/mcp",
          audience: "https://engine.test/",
        },
      }),
    "unauthorized",
  );

  assert.doesNotThrow(() =>
    authorizeIdentitySession({
      grants: chain.grants,
      revocations: [],
      now: 1_800_000_200,
      request: requestTwoOperation,
      verifier: {
        endpoint: "https://engine.test/mcp",
        audience: "https://engine.test/",
      },
    }),
  );

  const requestOne = await authenticatedRequest(
    sessionOne,
    requestContext({ tool: "gossip_operation" }),
  );
  expectCode(
    () =>
      authorizeIdentitySession({
        grants: chain.grants,
        revocations: [],
        now: 1_800_000_200,
        request: requestOne,
        verifier: {
          endpoint: "https://engine.test/mcp",
          audience: "https://engine.test/",
        },
      }),
    "unauthorized",
  );
});

test("revocation is terminal for new authorization", async () => {
  const first = await signedGrant(grant(sessionOne));
  const revocationValue = {
    schema: "gossip.identity-session-revocation.v1",
    protocol: "gossip/2-draft.1",
    root: {
      chain_id: "4663",
      address: root.address.toLowerCase(),
    },
    key_id: "session-1",
    grant_digest: first.grant_digest,
    revoked_at: 1_800_000_100,
  };
  const revocation = await signedRevocation(revocationValue);

  assert.equal(
    verifyIdentitySessionRevocation(revocation).revocation.key_id,
    "session-1",
  );

  const chain = verifyIdentitySessionChain([first]);
  const request = await authenticatedRequest(
    sessionOne,
    requestContext({
      payload: consultationPayload("revocation-consultation"),
    }),
  );
  expectCode(
    () =>
      authorizeIdentitySession({
        grants: chain.grants,
        revocations: [revocation],
        now: 1_800_000_200,
        request,
        verifier: {
          endpoint: "https://engine.test/mcp",
          audience: "https://engine.test/",
        },
      }),
    "unauthorized",
  );

  expectCode(
    () =>
      authorizeIdentitySession({
        grants: chain.grants,
        revocations: Array.from({ length: 17 }, () => revocation),
        now: 1_800_000_200,
        request,
        verifier: {
          endpoint: "https://engine.test/mcp",
          audience: "https://engine.test/",
        },
      }),
    "invalid_request",
  );
});

test("submission kinds and earned-credit ceilings are enforced", async () => {
  const value = grant(sessionOne, {
    tools: ["gossip_submit_v2"],
    submission_kinds: ["chain_observation"],
    max_cost: { unit: "earned_credit", amount: "2" },
  });
  const chain = verifyIdentitySessionChain([await signedGrant(value)]);
  const submissionRequest = (
    submissionKind: string,
    amount: string,
  ): Promise<GossipV2HttpRequest> =>
    authenticatedRequest(
      sessionOne,
      requestContext({
        tool: "gossip_submit_v2",
        submission_kind: submissionKind,
        cost: { unit: "earned_credit", amount },
      }),
    );
  const authenticatedRequests = {
    valid: await submissionRequest("chain_observation", "2"),
    wrongKind: await submissionRequest("research_heuristic", "2"),
    excessiveCost: await submissionRequest("chain_observation", "3"),
  };
  const common = {
    grants: chain.grants,
    revocations: [],
    now: 1_800_000_200,
    verifier: {
      endpoint: "https://engine.test/mcp",
      audience: "https://engine.test/",
    },
  };

  expectCode(
    () =>
      authorizeIdentitySession({
        ...common,
        request: authenticatedRequests.valid,
      }),
    "unsupported_capability",
  );
  expectCode(
    () =>
      authorizeIdentitySession({
        ...common,
        request: authenticatedRequests.wrongKind,
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      authorizeIdentitySession({
        ...common,
        request: authenticatedRequests.excessiveCost,
      }),
    "unauthorized",
  );
});
