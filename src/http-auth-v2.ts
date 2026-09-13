import { createHash } from "node:crypto";
import {
  computeAddress,
  hashMessage,
  recoverAddress,
  SigningKey,
} from "ethers";
import { PROTOCOL_REVISION } from "./canonical.js";
import { canonicalHttpsUrlSchema } from "./protocol-v2.js";
import { ProtocolError } from "./protocol-errors.js";

export const GOSSIP_V2_AUTH_PROFILE = "gossip-eip191-v2" as const;
export const GOSSIP_V2_AUTH_MESSAGE = "Gossip request v2" as const;
export const GOSSIP_V2_MAX_REQUEST_BYTES = 65_536;
export const GOSSIP_V2_MAX_EXPIRY_SECONDS = 300;

export const GOSSIP_V2_HEADERS = Object.freeze({
  profile: "X-Gossip-Auth-Profile",
  publicKey: "X-Gossip-Public-Key",
  signature: "X-Gossip-Signature",
  nonce: "X-Gossip-Nonce",
  expires: "X-Gossip-Expires",
});

const PUBLIC_KEY = /^0x04[0-9a-f]{128}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const METHOD = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;
const TARGET = /^\/[^\u0000-\u001f\u007f-\u009f#\r\n]*$/u;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

export type GossipV2HttpHeaderValue = string | readonly string[];
export type GossipV2HttpHeaders =
  | Headers
  | Readonly<Record<string, GossipV2HttpHeaderValue>>;

export type GossipV2AuthMessageInput = {
  audience: string;
  endpoint: string;
  method: string;
  target: string;
  body: string | Uint8Array;
  nonce: string;
  expires: string;
};

export type GossipV2HttpVerifierConfiguration = Readonly<{
  audience: string;
  endpoint: string;
}>;

export type GossipV2AuthHeaders = Readonly<
  Record<(typeof GOSSIP_V2_HEADERS)[keyof typeof GOSSIP_V2_HEADERS], string>
>;

type NormalizedGossipV2AuthHeaders = {
  profile: typeof GOSSIP_V2_AUTH_PROFILE;
  publicKey: string;
  signature: string;
  nonce: string;
  expires: string;
};

export type GossipV2HttpRequest = Omit<GossipV2AuthMessageInput, "body"> & {
  body: Uint8Array;
  headers: GossipV2HttpHeaders;
};

export type VerifiedGossipV2HttpRequest = {
  address: string;
  publicKey: string;
  profile: typeof GOSSIP_V2_AUTH_PROFILE;
  nonce: string;
  expires: number;
  bodyDigest: string;
  message: string;
};

function fail(
  code:
    | "invalid_request"
    | "limit_exceeded"
    | "unauthorized"
    | "unsupported_auth_profile",
): never {
  throw new ProtocolError(code);
}

function bytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (!(value instanceof Uint8Array)) {
    fail("invalid_request");
  }
  return new Uint8Array(value);
}

function noLineFeed(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\r\n]/u.test(value)
  ) {
    fail("invalid_request");
  }
  return value;
}

function canonicalUrl(value: string): string {
  noLineFeed(value);
  if (!canonicalHttpsUrlSchema.safeParse(value).success) {
    fail("invalid_request");
  }
  return value;
}

function boundedBodyBytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === "string") {
    const body = new TextEncoder().encode(value);
    if (body.byteLength > GOSSIP_V2_MAX_REQUEST_BYTES) {
      fail("limit_exceeded");
    }
    return body;
  }
  if (!(value instanceof Uint8Array)) {
    fail("invalid_request");
  }
  if (value.byteLength > GOSSIP_V2_MAX_REQUEST_BYTES) {
    fail("limit_exceeded");
  }
  return new Uint8Array(value);
}

function requestBodyBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    fail("invalid_request");
  }
  return boundedBodyBytes(value);
}

function bodyDigest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(boundedBodyBytes(value)).digest("hex")}`;
}

function canonicalTarget(
  audience: string,
  endpoint: string,
  target: string,
): string {
  const base = canonicalUrl(audience);
  const expectedEndpoint = canonicalUrl(endpoint);
  if (
    typeof target !== "string" ||
    !TARGET.test(target) ||
    target.startsWith("//") ||
    target.includes("\\")
  ) {
    fail("invalid_request");
  }

  let resolved: URL;
  try {
    resolved = new URL(target, base);
  } catch {
    fail("invalid_request");
  }

  if (
    resolved.origin !== new URL(base).origin ||
    resolved.href !== expectedEndpoint ||
    `${resolved.pathname}${resolved.search}` !== target ||
    resolved.hash !== ""
  ) {
    fail("invalid_request");
  }

  return target;
}

function canonicalMethod(value: string): string {
  noLineFeed(value);
  if (!METHOD.test(value)) {
    fail("invalid_request");
  }
  return value;
}

function canonicalNonce(value: string): string {
  if (
    typeof value !== "string" ||
    !UUID.test(value) ||
    value !== value.toLowerCase()
  ) {
    fail("invalid_request");
  }
  return value;
}

function canonicalExpires(value: string, now?: number): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    fail("invalid_request");
  }
  const expires = Number(value);
  if (!Number.isSafeInteger(expires) || expires < 0) {
    fail("invalid_request");
  }
  if (
    now !== undefined &&
    (!Number.isSafeInteger(now) ||
      now < 0 ||
      now >= expires ||
      expires > now + GOSSIP_V2_MAX_EXPIRY_SECONDS)
  ) {
    fail("unauthorized");
  }
  return value;
}

function headerEntries(input: GossipV2HttpHeaders): Map<string, string> {
  if (
    !(input instanceof Headers) &&
    (typeof input !== "object" || input === null || Array.isArray(input))
  ) {
    fail("unauthorized");
  }
  const entries =
    input instanceof Headers
      ? [...input.entries()]
      : Object.entries(input).map(([name, value]) => [name, value] as const);
  const result = new Map<string, string>();
  for (const [name, rawValue] of entries) {
    const normalized = name.toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(normalized) || result.has(normalized)) {
      fail("unauthorized");
    }
    if (
      Array.isArray(rawValue) ||
      typeof rawValue !== "string" ||
      rawValue.length === 0 ||
      /[\r\n]/u.test(rawValue)
    ) {
      fail("unauthorized");
    }
    result.set(normalized, rawValue);
  }
  return result;
}

function requiredHeaders(
  input: GossipV2HttpHeaders,
): NormalizedGossipV2AuthHeaders {
  const headers = headerEntries(input);
  const legacy = [
    "x-sherwood-public-key",
    "x-sherwood-signature",
    "x-sherwood-nonce",
    "x-sherwood-expires",
  ];
  if (legacy.some((name) => headers.has(name))) {
    fail("unauthorized");
  }

  const read = (name: string): string => {
    const value = headers.get(name.toLowerCase());
    if (value === undefined) {
      fail("unauthorized");
    }
    return value;
  };
  const profile = read(GOSSIP_V2_HEADERS.profile);
  if (profile !== GOSSIP_V2_AUTH_PROFILE) {
    fail("unsupported_auth_profile");
  }

  return {
    profile,
    publicKey: read(GOSSIP_V2_HEADERS.publicKey),
    signature: read(GOSSIP_V2_HEADERS.signature),
    nonce: read(GOSSIP_V2_HEADERS.nonce),
    expires: read(GOSSIP_V2_HEADERS.expires),
  };
}

function validateSignature(publicKey: string, signature: string): void {
  if (!PUBLIC_KEY.test(publicKey) || !SIGNATURE.test(signature)) {
    fail("unauthorized");
  }
  const bytesValue = Buffer.from(signature.slice(2), "hex");
  const recovery = bytesValue[64];
  if (recovery !== 27 && recovery !== 28) {
    fail("unauthorized");
  }
  const r = BigInt(`0x${bytesValue.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${bytesValue.subarray(32, 64).toString("hex")}`);
  if (r <= 0n || r >= SECP256K1_ORDER || s <= 0n || s > SECP256K1_HALF_ORDER) {
    fail("unauthorized");
  }
}

export function gossipV2AuthMessage(input: GossipV2AuthMessageInput): string {
  const audience = canonicalUrl(input.audience);
  const endpoint = canonicalUrl(input.endpoint);
  const method = canonicalMethod(input.method);
  const target = canonicalTarget(audience, endpoint, input.target);
  const digest = bodyDigest(input.body);
  const nonce = canonicalNonce(input.nonce);
  const expires = canonicalExpires(input.expires);
  return [
    GOSSIP_V2_AUTH_MESSAGE,
    PROTOCOL_REVISION,
    GOSSIP_V2_AUTH_PROFILE,
    audience,
    endpoint,
    method,
    target,
    digest,
    nonce,
    expires,
  ].join("\n");
}

export function gossipV2AuthHeaders(input: {
  publicKey: string;
  signature: string;
  nonce: string;
  expires: string;
}): GossipV2AuthHeaders {
  validateSignature(input.publicKey, input.signature);
  const nonce = canonicalNonce(input.nonce);
  const expires = canonicalExpires(input.expires);

  return {
    [GOSSIP_V2_HEADERS.profile]: GOSSIP_V2_AUTH_PROFILE,
    [GOSSIP_V2_HEADERS.publicKey]: input.publicKey,
    [GOSSIP_V2_HEADERS.signature]: input.signature,
    [GOSSIP_V2_HEADERS.nonce]: nonce,
    [GOSSIP_V2_HEADERS.expires]: expires,
  };
}

export function verifyGossipV2HttpRequest(
  input: GossipV2HttpRequest,
  now: number,
  configuration: GossipV2HttpVerifierConfiguration,
): VerifiedGossipV2HttpRequest {
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    Array.isArray(configuration)
  ) {
    fail("unauthorized");
  }
  const expectedAudience = canonicalUrl(configuration.audience);
  const expectedEndpoint = canonicalUrl(configuration.endpoint);
  if (
    input.audience !== expectedAudience ||
    input.endpoint !== expectedEndpoint
  ) {
    fail("unauthorized");
  }

  const body = requestBodyBytes(input.body);
  const headers = requiredHeaders(input.headers);
  const nonce = canonicalNonce(headers.nonce);
  const expiresText = canonicalExpires(headers.expires, now);
  const message = gossipV2AuthMessage({
    audience: input.audience,
    endpoint: input.endpoint,
    method: input.method,
    target: input.target,
    body,
    nonce,
    expires: expiresText,
  });
  validateSignature(headers.publicKey, headers.signature);

  const digest = hashMessage(message);
  const signature = headers.signature;
  let recoveredAddress: string;
  let recoveredPublicKey: string;
  let derivedAddress: string;
  try {
    recoveredAddress = recoverAddress(digest, signature);
    recoveredPublicKey = SigningKey.recoverPublicKey(digest, signature);
    derivedAddress = computeAddress(headers.publicKey);
  } catch {
    fail("unauthorized");
  }

  if (
    derivedAddress.toLowerCase() !== recoveredAddress.toLowerCase() ||
    recoveredPublicKey.toLowerCase() !== headers.publicKey.toLowerCase()
  ) {
    fail("unauthorized");
  }

  return {
    address: recoveredAddress.toLowerCase(),
    publicKey: headers.publicKey,
    profile: GOSSIP_V2_AUTH_PROFILE,
    nonce,
    expires: Number(expiresText),
    bodyDigest: bodyDigest(body),
    message,
  };
}
