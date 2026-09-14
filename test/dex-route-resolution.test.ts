import test from "node:test";
import assert from "node:assert/strict";
import { Interface, type Provider, getAddress } from "ethers";
import {
  NoSwapRouteError,
  QUOTER_V2,
  SWAP_ROUTER02,
  SwapRouteResolutionIncompleteError,
  V3_FACTORY,
  resolveExactInputQuote,
  verifyDexDeployment,
} from "../src/dex.js";

const tokenIn = "0x1000000000000000000000000000000000000001";
const tokenOut = "0x2000000000000000000000000000000000000002";
const recipient = "0x3000000000000000000000000000000000000003";
const factory = new Interface([
  "function getPool(address,address,uint24) view returns (address)",
]);
const quoter = new Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

type Route = {
  pool?: string;
  amountOut?: bigint;
  factoryError?: unknown;
  quoteError?: unknown;
};

function testProvider(
  routes: Readonly<Record<number, Route>>,
  probedFees: number[],
): Provider {
  const pools = new Map<string, number>();
  for (const [fee, route] of Object.entries(routes)) {
    if (route.pool !== undefined) {
      pools.set(getAddress(route.pool), Number(fee));
    }
  }

  return {
    getNetwork: async () => ({ chainId: 4663n }),
    getCode: async (address: string) =>
      pools.has(getAddress(address)) ||
      [tokenIn, tokenOut].map(getAddress).includes(getAddress(address)) ||
      [V3_FACTORY, QUOTER_V2].map(getAddress).includes(getAddress(address))
        ? "0x01"
        : "0x01",
    call: async (transaction: { to?: string; data?: string }) => {
      if (getAddress(transaction.to!) === getAddress(V3_FACTORY)) {
        const [, , fee] = factory.decodeFunctionData(
          "getPool",
          transaction.data!,
        );
        const numericFee = Number(fee);
        probedFees.push(numericFee);
        if (routes[numericFee]?.factoryError !== undefined) {
          throw routes[numericFee].factoryError;
        }
        return factory.encodeFunctionResult("getPool", [
          routes[numericFee]?.pool ??
            "0x0000000000000000000000000000000000000000",
        ]);
      }

      const [{ fee }] = quoter.decodeFunctionData(
        "quoteExactInputSingle",
        transaction.data!,
      );
      const route = routes[Number(fee)]!;
      if (route.quoteError !== undefined) {
        throw route.quoteError;
      }
      return quoter.encodeFunctionResult("quoteExactInputSingle", [
        route.amountOut,
        0,
        0,
        0,
      ]);
    },
  } as unknown as Provider;
}

function request(provider: Provider, feeTiers: readonly number[]) {
  return {
    provider,
    tokenIn,
    tokenOut,
    recipient,
    amountIn: 1_000n,
    feeTiers,
    slippageBps: 100,
    deadlineSecs: 60,
    nowSecs: 1_900_000_000,
  };
}

test("checks only allowed tiers and selects maximum output with a stable tie-break", async () => {
  const probedFees: number[] = [];
  const provider = testProvider(
    {
      500: {
        pool: "0x5000000000000000000000000000000000000005",
        amountOut: 2_000n,
      },
      3000: {
        pool: "0x3000000000000000000000000000000000000003",
        amountOut: 2_000n,
      },
    },
    probedFees,
  );

  const quote = await resolveExactInputQuote(request(provider, [500, 3000]));

  assert.deepEqual(probedFees, [500, 3000]);
  assert.equal(quote.fee, 500);
  assert.equal(quote.quotedAmountOut, 2_000n);
});

test("reports no route only after every deterministic tier miss", async () => {
  const probedFees: number[] = [];
  const provider = testProvider(
    {
      500: {
        pool: "0x5000000000000000000000000000000000000005",
        quoteError: Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
        }),
      },
    },
    probedFees,
  );

  await assert.rejects(
    resolveExactInputQuote(request(provider, [100, 500, 3000, 10000])),
    NoSwapRouteError,
  );
  assert.deepEqual(probedFees, [100, 500, 3000, 10000]);
});

test("retries a rate-limited tier using bounded Retry-After delay", async () => {
  const probedFees: number[] = [];
  let quoteAttempts = 0;
  const rateLimit = Object.assign(new Error("rate limited"), {
    status: 429,
    retryAfter: "0.02",
  });
  const provider = testProvider(
    {
      500: {
        pool: "0x5000000000000000000000000000000000000005",
        get amountOut() {
          quoteAttempts += 1;
          if (quoteAttempts === 1) {
            throw rateLimit;
          }
          return 2_000n;
        },
      },
    },
    probedFees,
  );
  const delays: number[] = [];

  const quote = await resolveExactInputQuote({
    ...request(provider, [500]),
    retry: {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 50,
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
  });

  assert.equal(quote.fee, 500);
  assert.equal(quoteAttempts, 2);
  assert.deepEqual(delays, [20]);
});

test("an exhausted transient tier is incomplete even when another tier succeeds", async () => {
  const probedFees: number[] = [];
  const provider = testProvider(
    {
      100: {
        pool: "0x1000000000000000000000000000000000000100",
        quoteError: Object.assign(new Error("too many requests"), {
          status: 429,
        }),
      },
      500: {
        pool: "0x5000000000000000000000000000000000000005",
        amountOut: 2_000n,
      },
    },
    probedFees,
  );

  await assert.rejects(
    resolveExactInputQuote({
      ...request(provider, [100, 500]),
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    }),
    SwapRouteResolutionIncompleteError,
  );
  assert.deepEqual(probedFees, [100, 500]);
});

test("rejects fee lists that could probe outside the supported policy", async () => {
  const provider = testProvider({}, []);

  await assert.rejects(
    resolveExactInputQuote(request(provider, [500, 500])),
    /unique/,
  );
  await assert.rejects(
    resolveExactInputQuote(request(provider, [250])),
    /standard Uniswap V3 fee tier/,
  );
});

test("surfaces malformed provider results instead of reporting no route", async () => {
  const provider = testProvider(
    {
      500: {
        pool: "0x5000000000000000000000000000000000000005",
        quoteError: new Error("malformed provider response"),
      },
    },
    [],
  );

  await assert.rejects(
    resolveExactInputQuote(request(provider, [500])),
    /malformed provider response/,
  );
});

test("surfaces factory call reverts instead of treating them as missing pools", async () => {
  const factoryError = Object.assign(new Error("execution reverted"), {
    code: "CALL_EXCEPTION",
  });
  const provider = testProvider({ 500: { factoryError } }, []);

  await assert.rejects(
    resolveExactInputQuote(request(provider, [500])),
    factoryError,
  );
});

test("deployment reads retry only when the caller opts into read recovery", async () => {
  let routerAttempts = 0;
  const rateLimit = Object.assign(new Error("rate limited"), { status: 429 });
  const provider = {
    getCode: async (address: string) => {
      if (getAddress(address) === getAddress(SWAP_ROUTER02)) {
        routerAttempts += 1;
        if (routerAttempts === 1 || routerAttempts === 2) {
          throw rateLimit;
        }
      }
      return "0x01";
    },
  } as unknown as Provider;

  await assert.rejects(verifyDexDeployment(provider), /rate limited/);
  assert.equal(routerAttempts, 1);

  await verifyDexDeployment(provider, {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });
  assert.equal(routerAttempts, 3);
});
