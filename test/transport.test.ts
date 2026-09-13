import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, verifyMessage, getBytes } from "ethers";
import { createSignedFetch } from "../src/transport.js";

const wallet = new Wallet("0x" + "01".padStart(64, "0"));
const endpoint = "https://gossip.example/mcp";
test("a signed MCP request binds the exact UTF-8 body, path and configured audience", async () => {
  let captured: Request | undefined;
  const fetcher = createSignedFetch(
    wallet,
    { endpoint, audience: "https://identity.example" },
    async (input, init) => {
      captured = new Request(input, init);
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    },
  );
  await fetcher(endpoint, { method: "POST", body: "" });
  assert.ok(captured);
  const headers = captured.headers;
  const message = [
    "Sherwood request v1",
    "https://identity.example",
    "POST",
    "/mcp",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    headers.get("X-Sherwood-Nonce"),
    headers.get("X-Sherwood-Expires"),
  ].join("\n");
  assert.equal(
    verifyMessage(message, headers.get("X-Sherwood-Signature")!),
    wallet.address,
  );
  assert.equal(
    headers.get("X-Sherwood-Public-Key"),
    wallet.signingKey.publicKey,
  );
  assert.equal(captured.redirect, "error");
});

test("the signer refuses other destinations, oversized bodies and unsafe endpoint configuration", async () => {
  let sent = false;
  const send: typeof fetch = async () => {
    sent = true;
    return new Response("{}");
  };
  const signed = createSignedFetch(
    wallet,
    { endpoint, audience: endpoint },
    send,
  );
  for (const url of [
    "https://evil.example/mcp",
    "https://gossip.example/admin",
    endpoint + "?other=1",
  ]) {
    await assert.rejects(
      signed(url, { method: "POST", body: "{}" }),
      /destination/i,
    );
  }
  await assert.rejects(
    signed(endpoint, { method: "POST", body: "x".repeat(65537) }),
    /64 KiB/,
  );
  assert.throws(
    () =>
      createSignedFetch(wallet, {
        endpoint: "http://localhost/mcp",
        audience: endpoint,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createSignedFetch(wallet, { endpoint, audience: endpoint + "\nspoof" }),
    /audience/,
  );
  assert.equal(sent, false);
});

import {
  BoundedMemoryNonceStore,
  createVerifierClient,
} from "@slicekit/erc8128";
test("ERC-8128 requests verify with the pinned independent verifier and cannot be replayed", async () => {
  const verifier = createVerifierClient({
    nonceStore: new BoundedMemoryNonceStore(),
    verifyMessage: async ({ address, message, signature }) =>
      verifyMessage(getBytes(message.raw), signature).toLowerCase() ===
      address.toLowerCase(),
  });
  let captured: Request | undefined;
  const signed = createSignedFetch(
    wallet,
    { endpoint, audience: endpoint, profile: "erc8128", chainId: 4663 },
    async (input, init) => {
      captured = new Request(input, init);
      return new Response("{}");
    },
  );
  await signed(endpoint, { method: "POST", body: '{"question":"évidence"}' });
  assert.ok(captured);
  const verification = await verifier.verifyRequest({
    request: captured.clone(),
  });
  assert.equal(verification.ok, true, JSON.stringify(verification));
  assert.equal(
    (await verifier.verifyRequest({ request: captured.clone() })).ok,
    false,
  );
});

test("an external signer can authenticate without exposing its key to the transport", async () => {
  let captured;
  const external = {
    address: wallet.address,
    signMessage: (message: string | Uint8Array) => wallet.signMessage(message),
  };
  const signed = createSignedFetch(
    external,
    { endpoint, audience: endpoint },
    async (input) => {
      captured = new Request(input);
      return new Response("{}");
    },
  );
  await signed(endpoint, { method: "POST", body: "{}" });
  assert.equal(
    captured!.headers.get("X-Sherwood-Public-Key"),
    wallet.signingKey.publicKey,
  );
});
