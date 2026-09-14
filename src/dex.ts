import { Interface, type Provider, getAddress } from "ethers";
import {
  isTransientRpcError,
  retryTransientRpc,
  type RpcRetryOptions,
} from "./rpc-retry.js";

export const ROBINHOOD_CHAIN_ID = 4663n;
export const SWAP_ROUTER02 = "0xCaf681a66D020601342297493863E78C959E5cb2";
export const QUOTER_V2 = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
export const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
export const ROBINHOOD_WETH9 = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const UNISWAP_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;
export type UniswapV3FeeTier = (typeof UNISWAP_V3_FEE_TIERS)[number];

const FACTORY_INTERFACE = new Interface([
  "function getPool(address,address,uint24) view returns (address)",
]);
const QUOTER_INTERFACE = new Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const ROUTER_INTERFACE = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
]);
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ExactInputQuoteRequest {
  provider: Provider;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint | string;
  fee: number;
  slippageBps: number;
  deadlineSecs: number;
  recipient?: string;
  nowSecs?: number;
  inputKind?: "erc20" | "native";
  retry?: RpcRetryOptions;
}

export interface ExactInputRouteRequest
  extends Omit<ExactInputQuoteRequest, "fee"> {
  feeTiers?: readonly number[];
}

export interface ExactInputQuote {
  chainId: bigint;
  router: string;
  quoter: string;
  factory: string;
  pool: string;
  tokenIn: string;
  tokenOut: string;
  inputKind: "erc20" | "native";
  fee: number;
  amountIn: bigint;
  quotedAmountOut: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  transaction: { to: string; data: string; value: bigint };
}

export class NoSwapRouteError extends Error {
  constructor() {
    super("No Uniswap V3 route found for the allowed fee tiers");
    this.name = "NoSwapRouteError";
  }
}

export class SwapRouteResolutionIncompleteError extends Error {
  constructor() {
    super("Unable to check every allowed Uniswap V3 fee tier; try again later");
    this.name = "SwapRouteResolutionIncompleteError";
  }
}

export async function quoteExactInputSingle(
  request: ExactInputQuoteRequest,
): Promise<ExactInputQuote> {
  return resolveExactInputQuote({ ...request, feeTiers: [request.fee] });
}

export async function resolveExactInputQuote(
  request: ExactInputRouteRequest,
): Promise<ExactInputQuote> {
  const feeTiers = requireFeeTiers(request.feeTiers ?? UNISWAP_V3_FEE_TIERS);
  const retry = request.retry ?? {};
  const network = await retryTransientRpc(
    () => request.provider.getNetwork(),
    retry,
  );
  if (network.chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `unsupported chain ${network.chainId}; expected ${ROBINHOOD_CHAIN_ID}`,
    );
  }

  await verifyDexDeployment(request.provider, retry);
  const tokenIn = requireAddress(request.tokenIn, "tokenIn");
  const tokenOut = requireAddress(request.tokenOut, "tokenOut");
  if (tokenIn === tokenOut) {
    throw new Error("tokenIn and tokenOut must differ");
  }
  requireUint(request.slippageBps, "slippageBps");
  if (request.slippageBps >= 10_000) {
    throw new Error("slippageBps must be less than 10000");
  }
  requireUint(request.deadlineSecs, "deadlineSecs");
  if (request.deadlineSecs < 1 || request.deadlineSecs > 300) {
    throw new Error("deadlineSecs must be between 1 and 300");
  }
  const amountIn =
    typeof request.amountIn === "string"
      ? BigInt(request.amountIn)
      : request.amountIn;
  if (amountIn <= 0n || amountIn >= 2n ** 256n) {
    throw new Error("amountIn must be positive");
  }
  const inputKind = request.inputKind ?? "erc20";
  if (inputKind === "native" && tokenIn !== getAddress(ROBINHOOD_WETH9)) {
    throw new Error("Native input must use the pinned Robinhood WETH9 route");
  }

  const [tokenInCode, tokenOutCode] = await Promise.all([
    retryTransientRpc(() => request.provider.getCode(tokenIn), retry),
    retryTransientRpc(() => request.provider.getCode(tokenOut), retry),
  ]);
  if (tokenInCode === "0x" || tokenOutCode === "0x") {
    throw new Error("tokenIn and tokenOut must be deployed ERC-20 contracts");
  }

  const routes: RouteCandidate[] = [];
  let incomplete = false;
  for (const fee of feeTiers) {
    try {
      const route = await probeFeeTier(
        request.provider,
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        retry,
      );
      if (route !== null) {
        routes.push(route);
      }
    } catch (error) {
      if (!isTransientRpcError(error)) {
        throw error;
      }
      incomplete = true;
    }
  }
  if (incomplete) {
    throw new SwapRouteResolutionIncompleteError();
  }
  if (routes.length === 0) {
    throw new NoSwapRouteError();
  }

  const bestRoute = routes.reduce((best, candidate) =>
    candidate.quotedAmountOut > best.quotedAmountOut ? candidate : best,
  );
  return buildQuote(request, tokenIn, tokenOut, amountIn, inputKind, bestRoute);
}

type RouteCandidate = {
  fee: UniswapV3FeeTier;
  pool: string;
  quotedAmountOut: bigint;
};

async function probeFeeTier(
  provider: Provider,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: UniswapV3FeeTier,
  retry: RpcRetryOptions | undefined,
): Promise<RouteCandidate | null> {
  const factoryCall = FACTORY_INTERFACE.encodeFunctionData("getPool", [
    tokenIn,
    tokenOut,
    fee,
  ]);
  const factoryResult = await retryTransientRpc(
    () => provider.call({ to: V3_FACTORY, data: factoryCall }),
    retry,
  );
  const pool = getAddress(
    FACTORY_INTERFACE.decodeFunctionResult("getPool", factoryResult)[0],
  );
  if (pool === ZERO_ADDRESS) {
    return null;
  }
  const poolCode = await retryTransientRpc(() => provider.getCode(pool), retry);
  if (poolCode === "0x") {
    return null;
  }

  const quoteCall = QUOTER_INTERFACE.encodeFunctionData(
    "quoteExactInputSingle",
    [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 }],
  );
  let quoteResult: string;
  try {
    quoteResult = await retryTransientRpc(
      () => provider.call({ to: QUOTER_V2, data: quoteCall }),
      retry,
    );
  } catch (error) {
    if (isDeterministicCallMiss(error)) {
      return null;
    }
    throw error;
  }
  const result = QUOTER_INTERFACE.decodeFunctionResult(
    "quoteExactInputSingle",
    quoteResult,
  );
  const quotedAmountOut = BigInt(result[0]);

  return quotedAmountOut > 0n ? { fee, pool, quotedAmountOut } : null;
}

function isDeterministicCallMiss(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "CALL_EXCEPTION" ||
    (typeof candidate.message === "string" &&
      candidate.message.toLowerCase().includes("execution reverted"))
  );
}

function buildQuote(
  request: ExactInputRouteRequest,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  inputKind: "erc20" | "native",
  route: RouteCandidate,
): ExactInputQuote {
  const amountOutMinimum =
    (route.quotedAmountOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
  const recipient = request.recipient
    ? requireAddress(request.recipient, "recipient")
    : MSG_SENDER;
  if (recipient === ZERO_ADDRESS) {
    throw new Error("recipient must not be zero");
  }
  if (amountOutMinimum <= 0n) {
    throw new Error("Quote minimum output must be positive");
  }
  const deadline =
    BigInt(request.nowSecs ?? Math.floor(Date.now() / 1000)) +
    BigInt(request.deadlineSecs);

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    router: getAddress(SWAP_ROUTER02),
    quoter: getAddress(QUOTER_V2),
    factory: getAddress(V3_FACTORY),
    pool: route.pool,
    tokenIn,
    tokenOut,
    inputKind,
    fee: route.fee,
    amountIn,
    quotedAmountOut: route.quotedAmountOut,
    amountOutMinimum,
    deadline,
    transaction: buildSwapTransaction({
      tokenIn,
      tokenOut,
      fee: route.fee,
      recipient,
      amountIn,
      amountOutMinimum,
      deadline,
      inputKind,
    }),
  };
}

function requireAddress(value: string, name: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name} must be a valid EVM address`);
  }
}

function requireUint(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function requireFeeTiers(feeTiers: readonly number[]): UniswapV3FeeTier[] {
  if (feeTiers.length === 0) {
    throw new Error("At least one allowed fee tier is required");
  }
  if (new Set(feeTiers).size !== feeTiers.length) {
    throw new Error("Allowed fee tiers must be unique");
  }
  for (const fee of feeTiers) {
    requireUint(fee, "fee");
    if (!UNISWAP_V3_FEE_TIERS.includes(fee as UniswapV3FeeTier)) {
      throw new Error("fee must be a standard Uniswap V3 fee tier");
    }
  }

  return [...feeTiers] as UniswapV3FeeTier[];
}

export function buildSwapTransaction(input: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  inputKind?: "erc20" | "native";
}): { to: string; data: string; value: bigint } {
  const swapData = ROUTER_INTERFACE.encodeFunctionData("exactInputSingle", [
    { ...input, sqrtPriceLimitX96: 0 },
  ]);
  return {
    to: getAddress(SWAP_ROUTER02),
    data: ROUTER_INTERFACE.encodeFunctionData("multicall", [
      input.deadline,
      [swapData],
    ]),
    value: input.inputKind === "native" ? input.amountIn : 0n,
  };
}

export async function verifyDexDeployment(
  provider: Provider,
  retry?: RpcRetryOptions,
): Promise<void> {
  const code = await Promise.all(
    [SWAP_ROUTER02, QUOTER_V2, V3_FACTORY].map((address) =>
      retry === undefined
        ? provider.getCode(address)
        : retryTransientRpc(() => provider.getCode(address), retry),
    ),
  );
  if (code.some((value) => value === "0x")) {
    throw new Error("Verified Uniswap deployment is absent on this RPC");
  }
}
