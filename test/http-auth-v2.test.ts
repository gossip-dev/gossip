import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Wallet } from "ethers";
import {
  GOSSIP_V2_HEADERS,
  gossipV2AuthHeaders,
  gossipV2AuthMessage,
  verifyGossipV2HttpRequest,
} from "../src/http-auth-v2.js";
import { ProtocolError } from "../src/protocol-errors.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-http-auth.json", import.meta.url),
    "utf8",
  ),
) as {
  body: string;
  audience: string;
  endpoint: string;
  method: string;
  target: string;
  nonce: string;
  expires: string;
  digest: string;
  message: string;
  public_key: string;
  signature: string;
  address: string;
};

const now = 1_800_000_000;
const verifierConfiguration = {
  audience: fixture.audience,
  endpoint: fixture.endpoint,
} as const;

function headers(): Record<string, string> {
  return {
    ...gossipV2AuthHeaders({
      publicKey: fixture.public_key,
      signature: fixture.signature,
      nonce: fixture.nonce,
      expires: fixture.expires,
    }),
  };
}

function request(
  overrides: Partial<{
    body: string | Uint8Array;
    audience: string;
    endpoint: string;
    method: string;
    target: string;
    headers: Record<string, string>;
  }> = {},
) {
  return {
    body:
      typeof (overrides.body ?? fixture.body) === "string"
        ? new TextEncoder().encode(overrides.body ?? fixture.body)
        : (overrides.body ?? new Uint8Array()),
    audience: overrides.audience ?? fixture.audience,
    endpoint: overrides.endpoint ?? fixture.endpoint,
    method: overrides.method ?? fixture.method,
    target: overrides.target ?? fixture.target,
    headers: overrides.headers ?? headers(),
  };
}

function expectCode(action: () => unknown, code: ProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

test("matches the independently generated literal EIP-191 vector", () => {
  assert.equal(
    gossipV2AuthMessage({
      ...request(),
      nonce: fixture.nonce,
      expires: fixture.expires,
    }),
    fixture.message,
  );

  const verified = verifyGossipV2HttpRequest(
    request(),
    now,
    verifierConfiguration,
  );
  assert.equal(verified.address, fixture.address);
  assert.equal(verified.publicKey, fixture.public_key);
  assert.equal(verified.bodyDigest, fixture.digest);
  assert.equal(verified.message, fixture.message);
});

test("constructs the exact wire header names", () => {
  assert.deepEqual(
    Object.keys(headers()).sort(),
    Object.values(GOSSIP_V2_HEADERS).sort(),
  );
  assert.equal(headers()[GOSSIP_V2_HEADERS.profile], "gossip-eip191-v2");
});

test("binds the proof to the canonical body, URL, method, nonce, and expiry", () => {
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ body: '{"hello":"tampered","nonce":1}' }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );
  expectCode(
    () =>
      verifyGossipV2HttpRequest(request(), now, {
        audience: "https://other.test/",
        endpoint: fixture.endpoint,
      }),
    "unauthorized",
  );
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ target: "/other" }),
        now,
        verifierConfiguration,
      ),
    "invalid_request",
  );
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ endpoint: "https://engine.test/mcp/" }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({
          endpoint: "https://other.test/mcp",
          target: "//other.test/mcp",
        }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ method: "GET" }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );
});

test("fails closed for profile downgrade, legacy headers, malformed values, and duplicates", () => {
  const wrongProfile = headers();
  wrongProfile[GOSSIP_V2_HEADERS.profile] = "gossip-eip191-receipt-v1";
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: wrongProfile }),
        now,
        verifierConfiguration,
      ),
    "unsupported_auth_profile",
  );

  const legacy = { ...headers(), "X-Sherwood-Signature": fixture.signature };
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: legacy }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );

  const uppercaseNonce = headers();
  uppercaseNonce[GOSSIP_V2_HEADERS.nonce] =
    "00000000-0000-4A00-8000-000000000001";
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: uppercaseNonce }),
        now,
        verifierConfiguration,
      ),
    "invalid_request",
  );

  const invalidVersion = headers();
  invalidVersion[GOSSIP_V2_HEADERS.nonce] =
    "00000000-0000-9000-8000-000000000001";
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: invalidVersion }),
        now,
        verifierConfiguration,
      ),
    "invalid_request",
  );

  const invalidVariant = headers();
  invalidVariant[GOSSIP_V2_HEADERS.nonce] =
    "00000000-0000-4000-7000-000000000001";
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: invalidVariant }),
        now,
        verifierConfiguration,
      ),
    "invalid_request",
  );

  const duplicate = {
    ...headers(),
    "x-gossip-signature": fixture.signature,
  };
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: duplicate }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );

  const repeatedValue = {
    ...headers(),
    [GOSSIP_V2_HEADERS.signature]: [fixture.signature, fixture.signature],
  } as unknown as Record<string, string>;
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: repeatedValue }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );
});

test("hashes raw outer bytes, enforces request size, and checks expiration bounds", () => {
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ body: new Uint8Array(65_537) }),
        now,
        verifierConfiguration,
      ),
    "limit_exceeded",
  );

  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        { ...request(), body: fixture.body as unknown as Uint8Array },
        now,
        verifierConfiguration,
      ),
    "invalid_request",
  );

  const expired = headers();
  expired[GOSSIP_V2_HEADERS.expires] = String(now);
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: expired }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );

  const tooFar = headers();
  tooFar[GOSSIP_V2_HEADERS.expires] = String(now + 301);
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: tooFar }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );

  const leadingZero = headers();
  leadingZero[GOSSIP_V2_HEADERS.expires] = `0${fixture.expires}`;
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: leadingZero }),
        now,
        verifierConfiguration,
      ),
    "invalid_request",
  );
});

test("accepts empty and noncanonical outer JSON-RPC bodies while binding exact bytes", async () => {
  const wallet = new Wallet(`0x${"00".repeat(31)}03`);
  for (const body of ["", '{ "jsonrpc": "2.0", "method": "tools/call" }']) {
    const input = {
      ...request(),
      body,
      method: "GET",
      nonce: fixture.nonce,
      expires: fixture.expires,
    };
    const signature = await wallet.signMessage(gossipV2AuthMessage(input));
    const verified = verifyGossipV2HttpRequest(
      {
        ...input,
        body: new TextEncoder().encode(body),
        headers: gossipV2AuthHeaders({
          publicKey: wallet.signingKey.publicKey,
          signature,
          nonce: fixture.nonce,
          expires: fixture.expires,
        }),
      },
      now,
      verifierConfiguration,
    );
    assert.equal(verified.message, gossipV2AuthMessage(input));
  }
});

test("requires low-S EIP-191 signatures with recovery byte 27 or 28", () => {
  const highS = Buffer.from(fixture.signature.slice(2), "hex");
  const order =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt(`0x${highS.subarray(32, 64).toString("hex")}`);
  highS.set(Buffer.from((order - s).toString(16).padStart(64, "0"), "hex"), 32);
  const highSHeaders = headers();
  highSHeaders[GOSSIP_V2_HEADERS.signature] = `0x${highS.toString("hex")}`;
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: highSHeaders }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );

  const wrongV = Buffer.from(fixture.signature.slice(2), "hex");
  wrongV[64] = 26;
  const wrongVHeaders = headers();
  wrongVHeaders[GOSSIP_V2_HEADERS.signature] = `0x${wrongV.toString("hex")}`;
  expectCode(
    () =>
      verifyGossipV2HttpRequest(
        request({ headers: wrongVHeaders }),
        now,
        verifierConfiguration,
      ),
    "unauthorized",
  );
});

test("rejects a target component containing a line feed", () => {
  expectCode(
    () => gossipV2AuthMessage({ ...request(), target: "/mcp\nX" }),
    "invalid_request",
  );
});

test("does not put a second nonce into the logical body digest", async () => {
  const wallet = new Wallet(`0x${"00".repeat(31)}01`);
  const alternateNonce = "00000000-0000-4000-8000-000000000002";
  const input = {
    ...request(),
    nonce: alternateNonce,
    expires: fixture.expires,
  };
  const signature = await wallet.signMessage(gossipV2AuthMessage(input));
  const alternate = verifyGossipV2HttpRequest(
    {
      ...input,
      headers: gossipV2AuthHeaders({
        publicKey: wallet.signingKey.publicKey,
        signature,
        nonce: alternateNonce,
        expires: fixture.expires,
      }),
    },
    now,
    verifierConfiguration,
  );
  assert.equal(alternate.bodyDigest, fixture.digest);
  assert.notEqual(alternate.nonce, fixture.nonce);
});
