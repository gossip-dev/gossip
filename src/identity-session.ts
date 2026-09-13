import {
  computeAddress,
  hashMessage,
  recoverAddress,
  SigningKey,
} from "ethers";
import {
  canonicalDigest,
  canonicalJson,
  parseCanonicalJson,
  PROTOCOL_REVISION,
} from "./canonical.js";
import {
  verifyGossipV2HttpRequest,
  type GossipV2HttpRequest,
  type GossipV2HttpVerifierConfiguration,
  type VerifiedGossipV2HttpRequest,
} from "./http-auth-v2.js";
import { ProtocolError } from "./protocol-errors.js";
import { consultationSchema, operationIdV2Schema } from "./protocol-v2.js";
import { parsePublicSubmission } from "./public-submission-v1.js";

export const IDENTITY_SESSION_SCHEMA = "gossip.identity-session.v1" as const;
export const IDENTITY_SESSION_REVOCATION_SCHEMA =
  "gossip.identity-session-revocation.v1" as const;
export const IDENTITY_SESSION_REQUEST_SCHEMA =
  "gossip.identity-session-request.v1" as const;
export const IDENTITY_SESSION_AUTH_PROFILE =
  "gossip-eip191-identity-session-v1" as const;
export const MAX_IDENTITY_SESSION_SECONDS = 86_400;

export const IDENTITY_SESSION_TOOLS = [
  "gossip_capabilities",
  "gossip_consult_v2",
  "gossip_submit_v2",
  "gossip_operation",
  "gossip_receipt_v2",
  "gossip_feedback",
] as const;

export const IDENTITY_SESSION_SUBMISSION_KINDS = [
  "chain_observation",
  "source_observation",
  "research_heuristic",
  "correction",
  "feedback",
  "public_submission",
] as const;

export type IdentitySessionTool = (typeof IDENTITY_SESSION_TOOLS)[number];
export type IdentitySessionSubmissionKind =
  (typeof IDENTITY_SESSION_SUBMISSION_KINDS)[number];

export type IdentitySessionGrant = {
  schema: typeof IDENTITY_SESSION_SCHEMA;
  protocol: typeof PROTOCOL_REVISION;
  root: { chain_id: string; address: string };
  session: { key_id: string; public_key: string; address: string };
  endpoint: string;
  audience: string;
  tools: IdentitySessionTool[];
  submission_kinds: IdentitySessionSubmissionKind[];
  max_cost: { unit: "earned_credit"; amount: string };
  issued_at: number;
  expires_at: number;
  previous: { key_id: string; grant_digest: string } | null;
};

export type SignedIdentitySessionGrant = {
  grant: IdentitySessionGrant;
  grant_digest: string;
  root_public_key: string;
  signature: string;
};

export type IdentitySessionRevocation = {
  schema: typeof IDENTITY_SESSION_REVOCATION_SCHEMA;
  protocol: typeof PROTOCOL_REVISION;
  root: { chain_id: string; address: string };
  key_id: string;
  grant_digest: string;
  revoked_at: number;
};

export type SignedIdentitySessionRevocation = {
  revocation: IdentitySessionRevocation;
  revocation_digest: string;
  root_public_key: string;
  signature: string;
};

export type VerifiedIdentitySessionChain = {
  grants: SignedIdentitySessionGrant[];
  active: SignedIdentitySessionGrant;
};

export type IdentitySessionRequest = {
  schema: typeof IDENTITY_SESSION_REQUEST_SCHEMA;
  protocol: typeof PROTOCOL_REVISION;
  root: { chain_id: string; address: string };
  key_id: string;
  tool: IdentitySessionTool;
  submission_kind: IdentitySessionSubmissionKind | null;
  cost: { unit: "earned_credit"; amount: string };
  payload: unknown;
};

export type IdentitySessionAuthorization = {
  grants: unknown[];
  revocations: unknown[];
  now: number;
  request: GossipV2HttpRequest;
  verifier: GossipV2HttpVerifierConfiguration;
};

export type IdentitySessionMcpAuthorization = IdentitySessionAuthorization & {
  actualTool: IdentitySessionTool;
};

export type AuthorizedIdentitySessionRequest = {
  grant: SignedIdentitySessionGrant;
  request: IdentitySessionRequest;
};

export type VerifiedIdentitySessionTransport = VerifiedGossipV2HttpRequest;

type IdentitySessionSemanticAuthorization = {
  grants: unknown[];
  revocations: unknown[];
  now: number;
  request: IdentitySessionRequest;
  authenticated: VerifiedGossipV2HttpRequest;
  endpoint: string;
  audience: string;
};

type IdentitySessionToolMappingInput = Pick<
  IdentitySessionRequest,
  "root" | "tool" | "cost" | "payload"
> & {
  endpoint?: string;
  audience?: string;
  submission_kind?: IdentitySessionSubmissionKind | null;
};

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PUBLIC_KEY = /^0x04[0-9a-f]{128}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

function invalid(): never {
  throw new ProtocolError("invalid_request");
}

function unauthorized(): never {
  throw new ProtocolError("unauthorized");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid();
  }

  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const result = object(value);
  const actualKeys = Object.keys(result);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key))
  ) {
    invalid();
  }

  return result;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid();
  }

  return value;
}

function unixTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid();
  }

  return value;
}

function canonicalHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    invalid();
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      parsed.href !== value
    ) {
      invalid();
    }
  } catch {
    invalid();
  }

  return value;
}

function uint256(value: unknown): string {
  const result = text(value, DECIMAL);
  if (result.length > 78 || BigInt(result) >= 1n << 256n) {
    invalid();
  }

  return result;
}

function sortedEnumValues<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value) || value.length > allowed.length) {
    invalid();
  }

  const result = value.map((entry) => {
    if (typeof entry !== "string" || !allowed.includes(entry as T)) {
      invalid();
    }
    return entry as T;
  });
  const sorted = [...result].sort();
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => entry !== sorted[index])
  ) {
    invalid();
  }

  return result;
}

function identity(value: unknown): { chain_id: string; address: string } {
  const result = exactObject(value, ["chain_id", "address"]);
  const chainId = uint256(result.chain_id);
  if (chainId === "0") {
    invalid();
  }

  return {
    chain_id: chainId,
    address: text(result.address, ADDRESS),
  };
}

function session(value: unknown): IdentitySessionGrant["session"] {
  const result = exactObject(value, ["key_id", "public_key", "address"]);
  const publicKey = text(result.public_key, PUBLIC_KEY);
  const address = text(result.address, ADDRESS);
  try {
    if (computeAddress(publicKey).toLowerCase() !== address) {
      invalid();
    }
  } catch {
    invalid();
  }

  return {
    key_id: text(result.key_id, IDENTIFIER),
    public_key: publicKey,
    address,
  };
}

function previous(value: unknown): IdentitySessionGrant["previous"] {
  if (value === null) {
    return null;
  }

  const result = exactObject(value, ["key_id", "grant_digest"]);
  return {
    key_id: text(result.key_id, IDENTIFIER),
    grant_digest: text(result.grant_digest, DIGEST),
  };
}

export function parseIdentitySessionGrant(
  input: unknown,
): IdentitySessionGrant {
  canonicalJson(input);
  const value = exactObject(input, [
    "schema",
    "protocol",
    "root",
    "session",
    "endpoint",
    "audience",
    "tools",
    "submission_kinds",
    "max_cost",
    "issued_at",
    "expires_at",
    "previous",
  ]);
  if (
    value.schema !== IDENTITY_SESSION_SCHEMA ||
    value.protocol !== PROTOCOL_REVISION
  ) {
    invalid();
  }

  const tools = sortedEnumValues(value.tools, IDENTITY_SESSION_TOOLS);
  if (tools.length === 0) {
    invalid();
  }
  const submissionKinds = sortedEnumValues(
    value.submission_kinds,
    IDENTITY_SESSION_SUBMISSION_KINDS,
  );
  const submissionToolPresent =
    tools.includes("gossip_submit_v2") || tools.includes("gossip_feedback");
  if (submissionToolPresent !== submissionKinds.length > 0) {
    invalid();
  }

  const maxCost = exactObject(value.max_cost, ["unit", "amount"]);
  if (maxCost.unit !== "earned_credit") {
    invalid();
  }

  const issuedAt = unixTime(value.issued_at);
  const expiresAt = unixTime(value.expires_at);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_IDENTITY_SESSION_SECONDS
  ) {
    invalid();
  }

  return {
    schema: IDENTITY_SESSION_SCHEMA,
    protocol: PROTOCOL_REVISION,
    root: identity(value.root),
    session: session(value.session),
    endpoint: canonicalHttpsUrl(value.endpoint),
    audience: canonicalHttpsUrl(value.audience),
    tools,
    submission_kinds: submissionKinds,
    max_cost: {
      unit: "earned_credit",
      amount: uint256(maxCost.amount),
    },
    issued_at: issuedAt,
    expires_at: expiresAt,
    previous: previous(value.previous),
  };
}

export function identitySessionGrantDigest(input: unknown): string {
  return canonicalDigest("identity", parseIdentitySessionGrant(input));
}

export function identitySessionGrantMessage(grantDigest: string): string {
  const digest = text(grantDigest, DIGEST);
  return [
    "Gossip identity session v1",
    PROTOCOL_REVISION,
    IDENTITY_SESSION_AUTH_PROFILE,
    digest,
  ].join("\n");
}

export function verifyIdentitySignature(
  publicKey: string,
  signature: string,
  message: string,
  expectedAddress: string,
): void {
  if (!PUBLIC_KEY.test(publicKey) || !SIGNATURE.test(signature)) {
    unauthorized();
  }
  const signatureBytes = Buffer.from(signature.slice(2), "hex");
  const recovery = signatureBytes[64];
  const r = BigInt(`0x${signatureBytes.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${signatureBytes.subarray(32, 64).toString("hex")}`);
  if (
    (recovery !== 27 && recovery !== 28) ||
    r <= 0n ||
    r >= SECP256K1_ORDER ||
    s <= 0n ||
    s > SECP256K1_HALF_ORDER
  ) {
    unauthorized();
  }

  try {
    const digest = hashMessage(message);
    if (
      computeAddress(publicKey).toLowerCase() !== expectedAddress ||
      recoverAddress(digest, signature).toLowerCase() !== expectedAddress ||
      SigningKey.recoverPublicKey(digest, signature).toLowerCase() !== publicKey
    ) {
      unauthorized();
    }
  } catch {
    unauthorized();
  }
}

export function verifyIdentitySessionGrant(
  input: unknown,
): SignedIdentitySessionGrant {
  const value = exactObject(input, [
    "grant",
    "grant_digest",
    "root_public_key",
    "signature",
  ]);
  const grant = parseIdentitySessionGrant(value.grant);
  const grantDigest = text(value.grant_digest, DIGEST);
  if (grantDigest !== identitySessionGrantDigest(grant)) {
    throw new ProtocolError("digest_mismatch");
  }

  const rootPublicKey = text(value.root_public_key, PUBLIC_KEY);
  const signature = text(value.signature, SIGNATURE);
  verifyIdentitySignature(
    rootPublicKey,
    signature,
    identitySessionGrantMessage(grantDigest),
    grant.root.address,
  );

  return {
    grant,
    grant_digest: grantDigest,
    root_public_key: rootPublicKey,
    signature,
  };
}

export function parseIdentitySessionRevocation(
  input: unknown,
): IdentitySessionRevocation {
  canonicalJson(input);
  const value = exactObject(input, [
    "schema",
    "protocol",
    "root",
    "key_id",
    "grant_digest",
    "revoked_at",
  ]);
  if (
    value.schema !== IDENTITY_SESSION_REVOCATION_SCHEMA ||
    value.protocol !== PROTOCOL_REVISION
  ) {
    invalid();
  }

  return {
    schema: IDENTITY_SESSION_REVOCATION_SCHEMA,
    protocol: PROTOCOL_REVISION,
    root: identity(value.root),
    key_id: text(value.key_id, IDENTIFIER),
    grant_digest: text(value.grant_digest, DIGEST),
    revoked_at: unixTime(value.revoked_at),
  };
}

export function identitySessionRevocationDigest(input: unknown): string {
  return canonicalDigest("identity", parseIdentitySessionRevocation(input));
}

export function identitySessionRevocationMessage(
  revocationDigest: string,
): string {
  const digest = text(revocationDigest, DIGEST);
  return [
    "Gossip identity session revocation v1",
    PROTOCOL_REVISION,
    IDENTITY_SESSION_AUTH_PROFILE,
    digest,
  ].join("\n");
}

export function verifyIdentitySessionRevocation(
  input: unknown,
): SignedIdentitySessionRevocation {
  const value = exactObject(input, [
    "revocation",
    "revocation_digest",
    "root_public_key",
    "signature",
  ]);
  const revocation = parseIdentitySessionRevocation(value.revocation);
  const revocationDigest = text(value.revocation_digest, DIGEST);
  if (revocationDigest !== identitySessionRevocationDigest(revocation)) {
    throw new ProtocolError("digest_mismatch");
  }

  const rootPublicKey = text(value.root_public_key, PUBLIC_KEY);
  const signature = text(value.signature, SIGNATURE);
  verifyIdentitySignature(
    rootPublicKey,
    signature,
    identitySessionRevocationMessage(revocationDigest),
    revocation.root.address,
  );

  return {
    revocation,
    revocation_digest: revocationDigest,
    root_public_key: rootPublicKey,
    signature,
  };
}

export function verifyIdentitySessionChain(
  input: unknown,
): VerifiedIdentitySessionChain {
  if (!Array.isArray(input) || input.length === 0 || input.length > 16) {
    invalid();
  }

  const grants = input.map(verifyIdentitySessionGrant);
  const keyIds = new Set<string>();
  for (let index = 0; index < grants.length; index++) {
    const current = grants[index]!;
    const prior = grants[index - 1];
    if (keyIds.has(current.grant.session.key_id)) {
      invalid();
    }
    keyIds.add(current.grant.session.key_id);

    if (index === 0) {
      if (current.grant.previous !== null) {
        invalid();
      }
      continue;
    }

    if (
      current.grant.root.chain_id !== prior!.grant.root.chain_id ||
      current.grant.root.address !== prior!.grant.root.address ||
      current.grant.issued_at < prior!.grant.issued_at ||
      current.grant.previous?.key_id !== prior!.grant.session.key_id ||
      current.grant.previous.grant_digest !== prior!.grant_digest
    ) {
      invalid();
    }
  }

  return { grants, active: grants.at(-1)! };
}

export function parseIdentitySessionRequest(
  input: string | Uint8Array,
): IdentitySessionRequest {
  const parsed = parseCanonicalJson(input);
  const value = exactObject(parsed, [
    "schema",
    "protocol",
    "root",
    "key_id",
    "tool",
    "submission_kind",
    "cost",
    "payload",
  ]);
  if (
    value.schema !== IDENTITY_SESSION_REQUEST_SCHEMA ||
    value.protocol !== PROTOCOL_REVISION ||
    !IDENTITY_SESSION_TOOLS.includes(value.tool as IdentitySessionTool) ||
    (value.submission_kind !== null &&
      !IDENTITY_SESSION_SUBMISSION_KINDS.includes(
        value.submission_kind as IdentitySessionSubmissionKind,
      ))
  ) {
    invalid();
  }

  const cost = exactObject(value.cost, ["unit", "amount"]);
  if (cost.unit !== "earned_credit") {
    invalid();
  }

  const requiresSubmissionKind =
    value.tool === "gossip_submit_v2" || value.tool === "gossip_feedback";
  if (requiresSubmissionKind !== (value.submission_kind !== null)) {
    invalid();
  }

  return {
    schema: IDENTITY_SESSION_REQUEST_SCHEMA,
    protocol: PROTOCOL_REVISION,
    root: identity(value.root),
    key_id: text(value.key_id, IDENTIFIER),
    tool: value.tool as IdentitySessionTool,
    submission_kind:
      value.submission_kind as IdentitySessionSubmissionKind | null,
    cost: { unit: "earned_credit", amount: uint256(cost.amount) },
    payload: value.payload,
  };
}

export function verifyIdentitySessionTransport(
  request: GossipV2HttpRequest,
  now: number,
  verifier: GossipV2HttpVerifierConfiguration,
): VerifiedIdentitySessionTransport {
  return verifyGossipV2HttpRequest(request, now, verifier);
}

export function parseIdentitySessionMcpArguments(
  input: unknown,
  actualTool: IdentitySessionTool,
): {
  session_request: IdentitySessionRequest;
} {
  const value = exactObject(input, ["session_request"]);
  const sessionRequest = parseIdentitySessionRequest(
    new TextEncoder().encode(canonicalJson(value.session_request)),
  );
  if (sessionRequest.tool !== actualTool) {
    invalid();
  }
  return {
    session_request: sessionRequest,
  };
}

function parseIdentitySessionMcpBody(
  input: string | Uint8Array,
  actualTool: IdentitySessionTool,
): IdentitySessionRequest {
  const value = exactObject(parseIdentitySessionMcpJson(input), [
    "jsonrpc",
    "id",
    "method",
    "params",
  ]);
  if (value.jsonrpc !== "2.0" || value.method !== "tools/call") {
    invalid();
  }

  const params = parseIdentitySessionMcpParams(value.params);
  if (params.name !== actualTool) {
    invalid();
  }

  return parseIdentitySessionMcpArguments(params.arguments, actualTool)
    .session_request;
}

function parseIdentitySessionMcpParams(
  input: unknown,
): Record<string, unknown> {
  const params = object(input);
  const keys = Object.keys(params);
  if (
    !keys.includes("name") ||
    !keys.includes("arguments") ||
    keys.some((key) => !["name", "arguments", "_meta"].includes(key))
  ) {
    invalid();
  }
  if (Object.prototype.hasOwnProperty.call(params, "_meta")) {
    object(params._meta);
  }
  return params;
}

function parseIdentitySessionMcpJson(input: string | Uint8Array): unknown {
  let text: string;
  try {
    text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            input,
          );
    rejectDuplicateJsonKeys(text);
    return JSON.parse(text) as unknown;
  } catch {
    invalid();
  }
}

function rejectDuplicateJsonKeys(text: string): void {
  let index = 0;

  function skipWhitespace(): void {
    while (index < text.length) {
      const character = text[index];
      if (character === undefined || !/\s/u.test(character)) {
        return;
      }
      index += 1;
    }
  }

  function parseString(): string {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === undefined) {
        invalid();
      }
      index += 1;
      if (character === "\\") {
        if (index >= text.length) {
          invalid();
        }
        index += 1;
      } else if (character === '"') {
        try {
          const value = JSON.parse(text.slice(start, index)) as unknown;
          if (typeof value !== "string") {
            invalid();
          }
          return value;
        } catch {
          invalid();
        }
      } else if (character < " ") {
        invalid();
      }
    }
    invalid();
  }

  function parseValue(): void {
    skipWhitespace();
    const character = text[index];
    if (character === undefined) {
      invalid();
    }
    if (character === '"') {
      parseString();
    } else if (character === "{") {
      parseObject();
    } else if (character === "[") {
      parseArray();
    } else {
      const start = index;
      while (index < text.length) {
        const character = text[index];
        if (character === undefined || /[\s,\]}]/u.test(character)) {
          break;
        }
        index += 1;
      }
      if (start === index) {
        invalid();
      }
    }
  }

  function parseObject(): void {
    const keys = new Set<string>();
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }

    while (true) {
      skipWhitespace();
      if (text[index] !== '"') {
        invalid();
      }
      const key = parseString();
      if (keys.has(key)) {
        invalid();
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") {
        invalid();
      }
      index += 1;
      parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") {
        invalid();
      }
      index += 1;
    }
  }

  function parseArray(): void {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }

    while (true) {
      parseValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") {
        invalid();
      }
      index += 1;
    }
  }

  parseValue();
  skipWhitespace();
  if (index !== text.length) {
    invalid();
  }
}

export function mapIdentitySessionToolPayload(
  input: IdentitySessionToolMappingInput,
): unknown {
  switch (input.tool) {
    case "gossip_capabilities":
      requireZeroCost(input.cost.amount);
      return exactObject(input.payload, []);
    case "gossip_consult_v2": {
      const parsed = consultationSchema.safeParse(input.payload);
      if (!parsed.success || !sameRoot(parsed.data.actor, input.root)) {
        invalid();
      }
      if (
        (input.endpoint !== undefined &&
          parsed.data.endpoint !== input.endpoint) ||
        (input.audience !== undefined &&
          parsed.data.audience !== input.audience)
      ) {
        unauthorized();
      }
      if (
        parsed.data.max_cost.unit !== input.cost.unit ||
        parsed.data.max_cost.amount !== input.cost.amount
      ) {
        unauthorized();
      }
      return parsed.data;
    }
    case "gossip_operation":
    case "gossip_receipt_v2": {
      requireZeroCost(input.cost.amount);
      const payload = exactObject(input.payload, ["operation_id"]);
      if (!operationIdV2Schema.safeParse(payload.operation_id).success) {
        invalid();
      }
      return { operation_id: payload.operation_id };
    }
    case "gossip_submit_v2": {
      if (input.submission_kind !== "public_submission") {
        throw new ProtocolError("unsupported_capability");
      }
      requireZeroCost(input.cost.amount);
      const submission = parsePublicSubmission(input.payload);
      if (!sameRoot(submission.actor, input.root)) {
        invalid();
      }
      if (
        input.endpoint === undefined ||
        input.audience === undefined ||
        submission.endpoint !== input.endpoint ||
        submission.audience !== input.audience
      ) {
        unauthorized();
      }
      return submission;
    }
    case "gossip_feedback":
      throw new ProtocolError("unsupported_capability");
  }
}

function sameRoot(
  actor: { chain_id: string; address: string },
  root: { chain_id: string; address: string },
): boolean {
  return actor.chain_id === root.chain_id && actor.address === root.address;
}

function requireZeroCost(amount: string): void {
  if (amount !== "0") {
    unauthorized();
  }
}

function authorizeExtractedIdentitySessionCore(
  value: IdentitySessionSemanticAuthorization,
): AuthorizedIdentitySessionRequest {
  if (
    !Array.isArray(value.grants) ||
    !Array.isArray(value.revocations) ||
    value.revocations.length > 16
  ) {
    invalid();
  }

  const now = unixTime(value.now);
  const signedRequest = value.request;
  const authenticatedRequest = value.authenticated;
  const verifiedChain = verifyIdentitySessionChain(value.grants);
  const active = verifiedChain.active;
  const grant = active.grant;
  if (
    now < grant.issued_at ||
    now >= grant.expires_at ||
    value.endpoint !== grant.endpoint ||
    value.audience !== grant.audience ||
    signedRequest.root.chain_id !== grant.root.chain_id ||
    signedRequest.root.address !== grant.root.address ||
    signedRequest.key_id !== grant.session.key_id ||
    authenticatedRequest.publicKey !== grant.session.public_key ||
    authenticatedRequest.address !== grant.session.address ||
    !grant.tools.includes(signedRequest.tool) ||
    BigInt(signedRequest.cost.amount) > BigInt(grant.max_cost.amount)
  ) {
    unauthorized();
  }

  if (
    signedRequest.submission_kind !== null &&
    !grant.submission_kinds.includes(signedRequest.submission_kind)
  ) {
    unauthorized();
  }

  if (
    signedRequest.tool === "gossip_submit_v2" &&
    signedRequest.submission_kind !== "public_submission"
  ) {
    throw new ProtocolError("unsupported_capability");
  }

  mapIdentitySessionToolPayload({
    ...signedRequest,
    endpoint: value.endpoint,
    audience: value.audience,
  });

  const isRevoked = value.revocations.some((candidate) => {
    const revocation = verifyIdentitySessionRevocation(candidate).revocation;
    return (
      revocation.root.chain_id === grant.root.chain_id &&
      revocation.root.address === grant.root.address &&
      revocation.key_id === grant.session.key_id &&
      revocation.grant_digest === active.grant_digest &&
      revocation.revoked_at <= now
    );
  });
  if (isRevoked) {
    unauthorized();
  }

  return { grant: active, request: signedRequest };
}

export function authorizeIdentitySession(
  input: unknown,
): AuthorizedIdentitySessionRequest {
  const value = exactObject(input, [
    "grants",
    "revocations",
    "now",
    "request",
    "verifier",
  ]);
  if (
    !Array.isArray(value.grants) ||
    !Array.isArray(value.revocations) ||
    value.revocations.length > 16
  ) {
    invalid();
  }

  const now = unixTime(value.now);
  const request = object(value.request) as GossipV2HttpRequest;
  const verifier = object(
    value.verifier,
  ) as unknown as GossipV2HttpVerifierConfiguration;
  const authenticated = verifyIdentitySessionTransport(request, now, verifier);
  const signedRequest = parseIdentitySessionRequest(request.body);
  return authorizeExtractedIdentitySessionCore({
    grants: value.grants,
    revocations: value.revocations,
    now,
    request: signedRequest,
    authenticated,
    endpoint: request.endpoint,
    audience: request.audience,
  });
}

export function authorizeIdentitySessionMcp(
  input: unknown,
): AuthorizedIdentitySessionRequest {
  const value = exactObject(input, [
    "grants",
    "revocations",
    "now",
    "request",
    "verifier",
    "actualTool",
  ]);
  if (
    !IDENTITY_SESSION_TOOLS.includes(value.actualTool as IdentitySessionTool)
  ) {
    invalid();
  }

  const now = unixTime(value.now);
  const request = object(value.request) as GossipV2HttpRequest;
  const verifier = object(
    value.verifier,
  ) as unknown as GossipV2HttpVerifierConfiguration;
  const authenticated = verifyIdentitySessionTransport(request, now, verifier);
  const signedRequest = parseIdentitySessionMcpBody(
    request.body,
    value.actualTool as IdentitySessionTool,
  );

  return authorizeExtractedIdentitySessionCore({
    grants: value.grants as unknown[],
    revocations: value.revocations as unknown[],
    now,
    request: signedRequest,
    authenticated,
    endpoint: request.endpoint,
    audience: request.audience,
  });
}
