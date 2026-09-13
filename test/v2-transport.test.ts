import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  GOSSIP_V2_HEADERS,
  verifyGossipV2HttpRequest,
} from "../src/http-auth-v2.js";
import {
  createV2SignedFetch,
  MAX_ABSOLUTE_CLOCK_SKEW_SECONDS,
  MAX_SERVER_TIME_ROUND_TRIP_MS,
  SERVER_TIME_FRESHNESS_MS,
} from "../src/transport.js";

const wallet = new Wallet(`0x${"00".repeat(31)}01`);
const endpoint = "https://gossip.example/mcp";
const audience = "https://gossip.example/";
const serverNowSeconds = 2_000_000_000;

function response(
  status = 200,
  date = Math.floor(Date.now() / 1_000),
): Response {
  return new Response("{}", {
    status,
    headers: {
      "content-type": "application/json",
      Date: new Date(date * 1_000).toUTCString(),
    },
  });
}

test("v2 transport signs the exact MCP request with the frozen profile", async () => {
  let captured: Request | undefined;
  const signed = createV2SignedFetch(
    wallet,
    { endpoint, audience },
    async (input, init) => {
      captured = new Request(input, init);
      return response();
    },
  );
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';

  await signed(endpoint, { method: "POST", body });

  assert.ok(captured);
  const bodyBytes = new Uint8Array(await captured.clone().arrayBuffer());
  const verified = verifyGossipV2HttpRequest(
    {
      audience,
      endpoint,
      method: captured.method,
      target: "/mcp",
      body: bodyBytes,
      headers: Object.fromEntries(captured.headers.entries()),
    },
    Math.floor(Date.now() / 1000),
    { audience, endpoint },
  );
  assert.equal(verified.address, wallet.address.toLowerCase());
  assert.equal(
    captured.headers.get(GOSSIP_V2_HEADERS.profile),
    "gossip-eip191-v2",
  );
  assert.equal(captured.redirect, "error");
});

test("v2 transport corrects bounded clock skew and retries authentication with a fresh nonce", async () => {
  for (const skewDirection of [-1, 1]) {
    const localNowMs =
      (serverNowSeconds +
        skewDirection * (MAX_ABSOLUTE_CLOCK_SKEW_SECONDS - 1)) *
      1_000;
    const requests: Request[] = [];
    const signed = createV2SignedFetch(
      wallet,
      { endpoint, audience },
      async (input) => {
        const request = new Request(input);
        requests.push(request.clone());
        const body = new Uint8Array(await request.clone().arrayBuffer());
        try {
          verifyGossipV2HttpRequest(
            {
              audience,
              endpoint,
              method: request.method,
              target: "/mcp",
              body,
              headers: Object.fromEntries(request.headers.entries()),
            },
            serverNowSeconds,
            { audience, endpoint },
          );
          return response(200, serverNowSeconds);
        } catch {
          return response(401, serverNowSeconds);
        }
      },
      () => localNowMs,
    );

    assert.equal(
      (await signed(endpoint, { method: "POST", body: "{}" })).status,
      200,
    );
    assert.equal(requests.length, 2);
    assert.notEqual(
      requests[0]!.headers.get(GOSSIP_V2_HEADERS.nonce),
      requests[1]!.headers.get(GOSSIP_V2_HEADERS.nonce),
    );
    assert.equal(signed.serverNowSeconds(), serverNowSeconds);
  }
});

test("v2 transport rejects untrusted or excessive server clock evidence", async () => {
  const localNowMs = serverNowSeconds * 1_000;
  for (const untrustedResponse of [
    new Response("{}", { status: 401 }),
    new Response("{}", { status: 401, headers: { Date: "not-a-date" } }),
    response(401, serverNowSeconds + MAX_ABSOLUTE_CLOCK_SKEW_SECONDS + 1),
    response(401, serverNowSeconds - MAX_ABSOLUTE_CLOCK_SKEW_SECONDS - 1),
  ]) {
    const signed = createV2SignedFetch(
      wallet,
      { endpoint, audience },
      async () => untrustedResponse.clone(),
      () => localNowMs,
    );
    await assert.rejects(
      signed(endpoint, { method: "POST", body: "{}" }),
      /Date header|clock differs/i,
    );
  }

  const readings = [
    localNowMs,
    localNowMs,
    localNowMs + MAX_SERVER_TIME_ROUND_TRIP_MS + 1,
  ];
  const slow = createV2SignedFetch(
    wallet,
    { endpoint, audience },
    async () => response(401, serverNowSeconds),
    () => readings.shift() ?? readings.at(-1)!,
  );
  await assert.rejects(
    slow(endpoint, { method: "POST", body: "{}" }),
    /took too long/i,
  );
});

test("v2 transport refreshes stale server time without weakening signed request checks", async () => {
  let localNowMs = serverNowSeconds * 1_000;
  const acceptedNonces = new Set<string>();
  const signed = createV2SignedFetch(
    wallet,
    { endpoint, audience },
    async (input) => {
      const request = new Request(input);
      const body = new Uint8Array(await request.clone().arrayBuffer());
      const verified = verifyGossipV2HttpRequest(
        {
          audience,
          endpoint,
          method: request.method,
          target: "/mcp",
          body,
          headers: Object.fromEntries(request.headers.entries()),
        },
        Math.floor(localNowMs / 1_000),
        { audience, endpoint },
      );
      assert.equal(acceptedNonces.has(verified.nonce), false);
      acceptedNonces.add(verified.nonce);
      return response(200, Math.floor(localNowMs / 1_000));
    },
    () => localNowMs,
  );

  await signed(endpoint, { method: "POST", body: "{}" });
  localNowMs += SERVER_TIME_FRESHNESS_MS + 1;
  assert.throws(() => signed.serverNowSeconds(), /unavailable or stale/i);

  await signed(endpoint, { method: "POST", body: "{}" });
  assert.equal(signed.serverNowSeconds(), Math.floor(localNowMs / 1_000));
  assert.equal(acceptedNonces.size, 2);
});

test("v2 transport refuses destination drift and caller-supplied auth", async () => {
  let sent = false;
  const signed = createV2SignedFetch(
    wallet,
    { endpoint, audience },
    async () => {
      sent = true;
      return new Response("{}");
    },
  );

  await assert.rejects(
    signed("https://evil.example/mcp", { method: "POST", body: "{}" }),
    /destination/i,
  );
  await assert.rejects(
    signed(endpoint, {
      method: "POST",
      headers: { "X-Gossip-Signature": "caller-controlled" },
      body: "{}",
    }),
    /authentication header/i,
  );
  await assert.rejects(
    signed(endpoint, {
      method: "POST",
      headers: { "X-Sherwood-Signature": "legacy" },
      body: "{}",
    }),
    /authentication header/i,
  );
  await assert.rejects(
    signed(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer caller-controlled" },
      body: "{}",
    }),
    /authentication header/i,
  );
  assert.equal(sent, false);
});

test("v2 transport validates its endpoint and signer identity", async () => {
  assert.throws(
    () =>
      createV2SignedFetch(wallet, {
        endpoint: "http://localhost/mcp",
        audience,
      }),
    /HTTPS/i,
  );

  const wrongIdentity = {
    address: "0x0000000000000000000000000000000000000002",
    signMessage: (message: string | Uint8Array) => wallet.signMessage(message),
  };
  const signed = createV2SignedFetch(
    wrongIdentity,
    { endpoint, audience },
    async () => new Response("{}"),
  );
  await assert.rejects(
    signed(endpoint, { method: "POST", body: "{}" }),
    /different identity/i,
  );
});
