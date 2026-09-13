import { Interface, type Provider, getAddress } from "ethers";

export const ROBINHOOD_CHAIN_ID = 4663n;
export const SWAP_ROUTER02 = "0xCaf681a66D020601342297493863E78C959E5cb2";
export const QUOTER_V2 = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
export const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";

const FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const ROUTER_INTERFACE = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
]);
const FACTORY_INTERFACE = new Interface(FACTORY_ABI);
const QUOTER_INTERFACE = new Interface(QUOTER_ABI);
const MSG_SENDER = "0x0000000000000000000000000000000000000001";

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
}

export interface ExactInputQuote {
  chainId: bigint;
  router: string;
  quoter: string;
  factory: string;
  pool: string;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
  quotedAmountOut: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  transaction: { to: string; data: string; value: bigint };
}

function requireAddress(value: string, name: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name} must be a valid EVM address`);
  }
}

function requireUint(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
}

export async function quoteExactInputSingle(
  request: ExactInputQuoteRequest,
): Promise<ExactInputQuote> {
  const network = await request.provider.getNetwork();
  if (network.chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `unsupported chain ${network.chainId}; expected ${ROBINHOOD_CHAIN_ID}`,
    );
  }
  await verifyDexDeployment(request.provider);
  const tokenIn = requireAddress(request.tokenIn, "tokenIn");
  const tokenOut = requireAddress(request.tokenOut, "tokenOut");
  if (tokenIn === tokenOut) throw new Error("tokenIn and tokenOut must differ");
  requireUint(request.fee, "fee");
  if (![100, 500, 3000, 10000].includes(request.fee))
    throw new Error("fee must be a standard Uniswap V3 fee tier");
  requireUint(request.slippageBps, "slippageBps");
  if (request.slippageBps >= 10_000)
    throw new Error("slippageBps must be less than 10000");
  requireUint(request.deadlineSecs, "deadlineSecs");
  if (request.deadlineSecs < 1 || request.deadlineSecs > 300)
    throw new Error("deadlineSecs must be between 1 and 300");
  const amountIn =
    typeof request.amountIn === "string"
      ? BigInt(request.amountIn)
      : request.amountIn;
  if (amountIn <= 0n || amountIn >= 2n ** 256n)
    throw new Error("amountIn must be positive");

  const [tokenInCode, tokenOutCode] = await Promise.all([
    request.provider.getCode(tokenIn),
    request.provider.getCode(tokenOut),
  ]);
  if (tokenInCode === "0x" || tokenOutCode === "0x")
    throw new Error("tokenIn and tokenOut must be deployed ERC-20 contracts");

  const factoryCall = FACTORY_INTERFACE.encodeFunctionData("getPool", [
    tokenIn,
    tokenOut,
    request.fee,
  ]);
  const factoryResult = await request.provider.call({
    to: V3_FACTORY,
    data: factoryCall,
  });
  const pool = getAddress(
    FACTORY_INTERFACE.decodeFunctionResult("getPool", factoryResult)[0],
  );
  if (pool === "0x0000000000000000000000000000000000000000")
    throw new Error("no Uniswap V3 pool for token pair and fee");
  if ((await request.provider.getCode(pool)) === "0x")
    throw new Error("Uniswap V3 pool is not deployed");

  const quoteCall = QUOTER_INTERFACE.encodeFunctionData(
    "quoteExactInputSingle",
    [
      {
        tokenIn,
        tokenOut,
        amountIn,
        fee: request.fee,
        sqrtPriceLimitX96: 0,
      },
    ],
  );
  const result = QUOTER_INTERFACE.decodeFunctionResult(
    "quoteExactInputSingle",
    await request.provider.call({ to: QUOTER_V2, data: quoteCall }),
  );
  const quotedAmountOut = BigInt(result[0]);
  const amountOutMinimum =
    (quotedAmountOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
  // SwapRouter02 resolves this sentinel to the transaction sender inside exactInputSingle.
  const recipient = request.recipient
    ? requireAddress(request.recipient, "recipient")
    : MSG_SENDER;
  if (recipient === "0x0000000000000000000000000000000000000000")
    throw new Error("recipient must not be zero");
  if (quotedAmountOut <= 0n || amountOutMinimum <= 0n)
    throw new Error("Quote minimum output must be positive");
  const now = BigInt(request.nowSecs ?? Math.floor(Date.now() / 1000));
  const deadline = now + BigInt(request.deadlineSecs);
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    router: getAddress(SWAP_ROUTER02),
    quoter: getAddress(QUOTER_V2),
    factory: getAddress(V3_FACTORY),
    pool,
    tokenIn,
    tokenOut,
    fee: request.fee,
    amountIn,
    quotedAmountOut,
    amountOutMinimum,
    deadline,
    transaction: buildSwapTransaction({
      tokenIn,
      tokenOut,
      fee: request.fee,
      recipient,
      amountIn,
      amountOutMinimum,
      deadline,
    }),
  };
}

export function buildSwapTransaction(input: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
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
    value: 0n,
  };
}

export async function verifyDexDeployment(provider: Provider): Promise<void> {
  const code = await Promise.all(
    [SWAP_ROUTER02, QUOTER_V2, V3_FACTORY].map((address) =>
      provider.getCode(address),
    ),
  );
  if (code.some((value) => value === "0x"))
    throw new Error("Verified Uniswap deployment is absent on this RPC");
}
