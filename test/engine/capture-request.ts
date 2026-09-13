import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { createSignedFetch } from "../../src/transport.ts";
import { existingFileSigner } from "../../src/external-signer.ts";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: capture-request.ts <output.json>");

const endpoint = "https://localhost/mcp";
const audience = "https://localhost";
const wallet = Wallet.createRandom();
const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "gossip-engine-interop", version: "0.1.0" },
  },
});

const capture = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const request = new Request(input, init);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        endpoint,
        audience,
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.text(),
        headers,
        walletAddress: wallet.address,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return new Response("{}", { status: 200 });
};

const temporary = await mkdtemp(join(tmpdir(), "gossip-interop-signer-"));
const keyFile = join(temporary, "synthetic-key");
try {
  await writeFile(keyFile, wallet.privateKey, { mode: 0o600 });
  const signer = existingFileSigner(wallet.address, {
    keyFile,
    format: "raw-hex",
  });
  const signedFetch = createSignedFetch(
    signer,
    { endpoint, audience },
    capture,
  );
  await signedFetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body,
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
