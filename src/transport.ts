import { createSignerClient } from "@slicekit/erc8128";
import { createHash, randomUUID } from "node:crypto";
import { computeAddress, getAddress, hashMessage, SigningKey } from "ethers";
import { gossipV2AuthHeaders, gossipV2AuthMessage } from "./http-auth-v2.js";

export const MAX_ABSOLUTE_CLOCK_SKEW_SECONDS = 300;
export const MAX_SERVER_TIME_ROUND_TRIP_MS = 20_000;
export const SERVER_TIME_FRESHNESS_MS = 300_000;

const V2_REQUEST_LIFETIME_SECONDS = 240;
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

export class ServerClockError extends Error {}

export type V2SignedFetch = typeof fetch & {
  serverNowSeconds(): number;
};

class ServerClock {
  private offsetMs: number | undefined;
  private observedAtMs: number | undefined;

  constructor(private readonly localNowMs: () => number) {}

  signingNowSeconds(): number {
    return Math.floor((this.localNowMs() + (this.offsetMs ?? 0)) / 1_000);
  }

  serverNowSeconds(): number {
    const localNow = this.localNowMs();
    if (
      this.offsetMs === undefined ||
      this.observedAtMs === undefined ||
      localNow < this.observedAtMs ||
      localNow - this.observedAtMs > SERVER_TIME_FRESHNESS_MS
    ) {
      throw new ServerClockError(
        "Trusted server time is unavailable or stale. Retry the Gossip connection.",
      );
    }

    return Math.floor((localNow + this.offsetMs) / 1_000);
  }

  observe(dateHeader: string | null, startedAtMs: number): void {
    const receivedAtMs = this.localNowMs();
    const roundTripMs = receivedAtMs - startedAtMs;
    if (roundTripMs < 0 || roundTripMs > MAX_SERVER_TIME_ROUND_TRIP_MS) {
      throw new ServerClockError(
        "The HTTPS server-time response took too long to establish a trusted clock.",
      );
    }
    if (dateHeader === null || !HTTP_DATE.test(dateHeader)) {
      throw new ServerClockError(
        "The Gossip HTTPS response did not contain a valid Date header for trusted server time.",
      );
    }

    const serverSecondMs = Date.parse(dateHeader);
    if (
      !Number.isFinite(serverSecondMs) ||
      new Date(serverSecondMs).toUTCString() !== dateHeader
    ) {
      throw new ServerClockError(
        "The Gossip HTTPS response contained malformed server time.",
      );
    }

    const minimumOffsetMs = serverSecondMs - receivedAtMs;
    const maximumOffsetMs = serverSecondMs + 999 - startedAtMs;
    const maximumSkewMs = MAX_ABSOLUTE_CLOCK_SKEW_SECONDS * 1_000;
    if (minimumOffsetMs < -maximumSkewMs || maximumOffsetMs > maximumSkewMs) {
      throw new ServerClockError(
        `The local clock differs from the Gossip server by more than ${MAX_ABSOLUTE_CLOCK_SKEW_SECONDS} seconds.`,
      );
    }

    this.offsetMs = Math.round((minimumOffsetMs + maximumOffsetMs) / 2);
    this.observedAtMs = receivedAtMs;
  }
}

export interface IdentitySigner {
  readonly address: string;
  signMessage(message: string | Uint8Array): Promise<string>;
}

export interface Connection {
  endpoint: string;
  audience: string;
  profile?: "sherwood-eip191-personal-sign-v1" | "gossip-eip191-v2" | "erc8128";
  chainId?: number;
}

function canonicalHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a canonical HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== value ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`${label} must be a canonical HTTPS URL.`);
  }
  return url;
}

export function createV2SignedFetch(
  wallet: IdentitySigner,
  connection: Pick<Connection, "endpoint" | "audience">,
  send: typeof fetch = fetch,
  localNowMs: () => number = Date.now,
): V2SignedFetch {
  const endpoint = canonicalHttpsUrl(connection.endpoint, "Endpoint");
  const audience = canonicalHttpsUrl(connection.audience, "Audience");
  const clock = new ServerClock(localNowMs);

  const signedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const original = new Request(input, { ...init, redirect: "error" });
    if (original.url !== endpoint.href) {
      throw new Error(
        "Signing destination does not match the configured MCP endpoint.",
      );
    }
    if (
      [...original.headers.keys()].some((name) => {
        const normalized = name.toLowerCase();
        return (
          normalized === "authorization" ||
          normalized.startsWith("x-gossip-") ||
          normalized.startsWith("x-sherwood-")
        );
      })
    ) {
      throw new Error("Caller-supplied authentication headers are forbidden.");
    }

    const sendAttempt = async () => {
      const request = original.clone();
      const body = new Uint8Array(await request.clone().arrayBuffer());
      const nonce = randomUUID();
      const signingNow = clock.signingNowSeconds();
      const expires = String(signingNow + V2_REQUEST_LIFETIME_SECONDS);
      const target = endpoint.pathname + endpoint.search;
      const message = gossipV2AuthMessage({
        audience: audience.href,
        endpoint: endpoint.href,
        method: request.method,
        target,
        body,
        nonce,
        expires,
      });
      const proof = await checkedSignature(wallet, message);
      const headers = gossipV2AuthHeaders({
        publicKey: proof.publicKey,
        signature: proof.signature,
        nonce,
        expires,
      });
      for (const [name, value] of Object.entries(headers)) {
        request.headers.set(name, value);
      }

      const startedAtMs = localNowMs();
      const response = await send(request);
      if (
        response.redirected ||
        (response.url !== "" && response.url !== endpoint.href)
      ) {
        throw new ServerClockError(
          "Trusted server time must come from the exact configured HTTPS endpoint.",
        );
      }
      clock.observe(response.headers.get("date"), startedAtMs);

      return { response, signingNow };
    };

    const first = await sendAttempt();
    if (
      first.response.status === 401 &&
      clock.signingNowSeconds() !== first.signingNow
    ) {
      await first.response.body?.cancel();
      return (await sendAttempt()).response;
    }

    return first.response;
  };

  return Object.assign(signedFetch, {
    serverNowSeconds: () => clock.serverNowSeconds(),
  }) as V2SignedFetch;
}

export function createSignedFetch(
  wallet: IdentitySigner,
  connection: Connection,
  send: typeof fetch = fetch,
): typeof fetch {
  const endpoint = new URL(connection.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error(
      "The endpoint must be HTTPS without credentials or a fragment.",
    );
  }
  const audience = new URL(connection.audience);
  if (
    audience.protocol !== "https:" ||
    audience.username ||
    audience.password ||
    audience.hash ||
    /[\r\n]/.test(connection.audience)
  ) {
    throw new Error("Invalid HTTPS audience.");
  }
  if (connection.profile === "gossip-eip191-v2") {
    throw new Error("Unsupported signing profile.");
  }
  if (
    connection.profile === "erc8128" &&
    (!Number.isSafeInteger(connection.chainId) || connection.chainId! <= 0)
  ) {
    throw new Error("ERC-8128 requires an explicit positive chain ID.");
  }
  return async (input, init) => {
    const request = new Request(input, { ...init, redirect: "error" });
    if (request.url !== endpoint.href)
      throw new Error(
        "Signing destination does not match the configured MCP endpoint.",
      );
    const body = new Uint8Array(await request.clone().arrayBuffer());
    if (body.length > 64 * 1024) throw new Error("Request exceeds 64 KiB.");
    if (connection.profile === "erc8128") {
      const signer = createSignerClient({
        address: wallet.address as `0x${string}`,
        chainId: connection.chainId!,
        signMessage: async (message: Uint8Array) =>
          (await checkedSignature(wallet, message)).signature as `0x${string}`,
      });
      const signed = await signer.signRequest(request);
      return send(new Request(signed, { redirect: "error" }));
    }
    const nonce = randomUUID();
    const expires = String(Math.floor(Date.now() / 1000) + 240);
    const url = new URL(request.url);
    const message = [
      "Sherwood request v1",
      connection.audience,
      request.method.toUpperCase(),
      url.pathname + url.search,
      createHash("sha256").update(body).digest("hex"),
      nonce,
      expires,
    ].join("\n");
    const proof = await checkedSignature(wallet, message);
    request.headers.set("X-Sherwood-Public-Key", proof.publicKey);
    request.headers.set("X-Sherwood-Signature", proof.signature);
    request.headers.set("X-Sherwood-Nonce", nonce);
    request.headers.set("X-Sherwood-Expires", expires);
    return send(request);
  };
}

async function checkedSignature(
  wallet: IdentitySigner,
  message: string | Uint8Array,
) {
  const signature = await wallet.signMessage(message);
  const publicKey = SigningKey.recoverPublicKey(
    hashMessage(message),
    signature,
  );
  if (getAddress(computeAddress(publicKey)) !== getAddress(wallet.address)) {
    throw new Error("Signer returned a proof for a different identity.");
  }
  return { signature, publicKey };
}
