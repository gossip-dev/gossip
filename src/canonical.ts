import { createHash } from "node:crypto";
import { ProtocolError } from "./protocol-errors.js";

export const PROTOCOL_REVISION = "gossip/2-draft.1";

export const CANONICAL_LIMITS = Object.freeze({
  maxBytes: 65_536,
  maxDepth: 16,
  maxArrayItems: 256,
  maxObjectMembers: 64,
  maxNodes: 4_096,
});

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;

  function accountBytes(count: number): void {
    bytes += count;
    if (bytes > CANONICAL_LIMITS.maxBytes) {
      throw new ProtocolError("limit_exceeded");
    }
  }

  function encodedString(text: string): string {
    validateString(text);
    if (Buffer.byteLength(text, "utf8") > CANONICAL_LIMITS.maxBytes) {
      throw new ProtocolError("limit_exceeded");
    }
    const encoded = JSON.stringify(text);
    accountBytes(Buffer.byteLength(encoded, "utf8"));
    return encoded;
  }

  function serialize(current: unknown, depth: number): string {
    nodes++;
    if (
      depth > CANONICAL_LIMITS.maxDepth ||
      nodes > CANONICAL_LIMITS.maxNodes
    ) {
      throw new ProtocolError("limit_exceeded");
    }

    if (current === null || typeof current === "boolean") {
      const encoded = JSON.stringify(current);
      accountBytes(encoded.length);
      return encoded;
    }

    if (typeof current === "string") {
      return encodedString(current);
    }

    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        throw new ProtocolError("invalid_canonical_json");
      }
      const encoded = String(current);
      accountBytes(encoded.length);
      return encoded;
    }

    if (typeof current !== "object" || ancestors.has(current)) {
      throw new ProtocolError("invalid_canonical_json");
    }

    ancestors.add(current);
    const isArray = Array.isArray(current);
    if (isArray && current.length > CANONICAL_LIMITS.maxArrayItems) {
      throw new ProtocolError("limit_exceeded");
    }
    const prototype = Object.getPrototypeOf(current);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw new ProtocolError("invalid_canonical_json");
    }

    const keys = Reflect.ownKeys(current);
    if (!isArray && keys.length > CANONICAL_LIMITS.maxObjectMembers) {
      throw new ProtocolError("limit_exceeded");
    }
    if (keys.some((key) => typeof key !== "string")) {
      throw new ProtocolError("invalid_canonical_json");
    }
    if (isArray && keys.length !== current.length + 1) {
      throw new ProtocolError("invalid_canonical_json");
    }

    const members: string[] = [];
    const orderedKeys = isArray
      ? Array.from({ length: current.length }, (_, index) => String(index))
      : (keys as string[]).sort();
    accountBytes(2 + Math.max(0, orderedKeys.length - 1));

    for (const key of orderedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new ProtocolError("invalid_canonical_json");
      }
      let prefix = "";
      if (!isArray) {
        prefix = `${encodedString(key)}:`;
        accountBytes(1);
      }
      members.push(prefix + serialize(descriptor.value, depth + 1));
    }

    ancestors.delete(current);
    return isArray ? `[${members.join(",")}]` : `{${members.join(",")}}`;
  }

  return serialize(value, 0);
}

export function parseCanonicalJson(input: string | Uint8Array): unknown {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    throw new ProtocolError("invalid_canonical_json");
  }
  const length =
    typeof input === "string"
      ? Buffer.byteLength(input, "utf8")
      : input.byteLength;
  if (length > CANONICAL_LIMITS.maxBytes) {
    throw new ProtocolError("limit_exceeded");
  }

  let text: string;
  let value: unknown;
  try {
    // Preserve the BOM so canonical comparison rejects it rather than stripping it.
    text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            input,
          );
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError("invalid_canonical_json");
  }

  if (canonicalJson(value) !== text) {
    throw new ProtocolError("invalid_canonical_json");
  }
  return value;
}

export function canonicalDigest(
  domain: "request" | "evidence" | "receipt" | "identity" | "conformance",
  value: unknown,
): string {
  if (
    !["request", "evidence", "receipt", "identity", "conformance"].includes(
      domain,
    )
  ) {
    throw new ProtocolError("invalid_request");
  }
  const bytes = `${PROTOCOL_REVISION}\n${domain}\n${canonicalJson(value)}`;
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function validateString(value: string): void {
  // Unicode mode matches lone surrogates while treating valid pairs as a code point.
  if (/[\uD800-\uDFFF]/u.test(value)) {
    throw new ProtocolError("invalid_canonical_json");
  }
}
