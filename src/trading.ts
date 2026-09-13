import { readFile } from "node:fs/promises";
import { readSecret } from "./secret-prompt.js";
import {
  executeTrade,
  permissionCanBeReplaced,
  readPermission,
  permissionSchema,
  validatePermission,
  withTradeLock,
  writeTradeFile,
} from "./trade-execution.js";
import { getAddress } from "ethers";
import { createNetworkProvider } from "./network.js";
import { quoteExactInputSingle } from "./dex.js";
import { WalletVault } from "./wallet.js";
import { createCredentialStore } from "./credential-store.js";
import {
  cancelOrder,
  createOrder,
  isOrderReachable,
  listOrders,
  setOrderReadiness,
  summarizeOrders,
  type OrderFilter,
} from "./order-book.js";

export async function tradingCommand(
  directory: string,
  args: string[],
): Promise<void> {
  if (args[0] === "order") {
    await orderCommand(directory, args.slice(1));
    return;
  }
  if (args[0] === "status") {
    let authorized = false;
    try {
      const policy = await readPermission(directory);
      validatePermission(policy);
      authorized =
        policy.enabled &&
        BigInt(policy.quote.deadline) > BigInt(Math.floor(Date.now() / 1000));
    } catch {
      /* Missing or invalid permission never authorizes execution. */
    }
    console.log(
      JSON.stringify({
        executionAuthorized: authorized,
        status: authorized ? "permission-configured" : "disabled",
        verified: false,
      }),
    );
    return;
  }
  if (args[0] === "authorize") {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error("Trade authorization requires an interactive terminal");
    const json = await readFile(required(args, "--quote"), "utf8");
    if (json.length > 16_384) throw new Error("Quote exceeds limit");
    const permission = permissionSchema.parse({
      schemaVersion: 1,
      enabled: true,
      id: required(args, "--id"),
      quote: JSON.parse(json),
      gasLimit: required(args, "--gas-limit"),
      maxFeePerGas: required(args, "--max-fee-wei"),
    });
    validatePermission(permission);
    const seconds =
      BigInt(permission.quote.deadline) - BigInt(Math.floor(Date.now() / 1000));
    if (seconds <= 0n || seconds > 300n)
      throw new Error("Quote expired or deadline exceeds five minutes");
    console.log(
      JSON.stringify({
        proposedPermission: permission,
        maximumGasCostWei: (
          2n *
          BigInt(permission.gasLimit) *
          BigInt(permission.maxFeePerGas)
        ).toString(),
        approval:
          "Exact input amount to SwapRouter02 if allowance is zero; output goes to the selected account.",
      }),
    );
    if (
      (await readSecret("Type CONFIRM to authorize this single trade: ")) !==
      "CONFIRM"
    )
      throw new Error("Trade authorization cancelled");
    await withTradeLock(directory, async () => {
      try {
        const existing = await readPermission(directory);
        if (
          existing.id !== permission.id &&
          !(await permissionCanBeReplaced(directory, existing.id))
        )
          throw new Error(
            "Existing trade permission must be reconciled before replacement",
          );
        if (
          existing.id === permission.id &&
          JSON.stringify({ ...existing, enabled: true }) !==
            JSON.stringify(permission)
        )
          throw new Error("Trade operation conflicts");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeTradeFile(directory, "trade-permission.json", permission);
    });
    console.log(JSON.stringify({ authorized: true, id: permission.id }));
    return;
  }
  if (args[0] === "revoke") {
    await withTradeLock(directory, async () => {
      const permission = await readPermission(directory);
      await writeTradeFile(directory, "trade-permission.json", {
        ...permission,
        enabled: false,
      });
    });
    console.log(
      JSON.stringify({
        executionAuthorized: false,
        existingTransactionsAndAllowances: "unchanged",
      }),
    );
    return;
  }
  if (args[0] === "execute") {
    console.log(
      JSON.stringify(await executeTrade(directory, required(args, "--id"))),
    );
    return;
  }
  if (args[0] === "quote") {
    const account = getAddress(required(args, "--address"));
    const provider = await createNetworkProvider(directory);
    try {
      const quote = await quoteExactInputSingle({
        provider,
        recipient: account,
        tokenIn: required(args, "--token-in"),
        tokenOut: required(args, "--token-out"),
        amountIn: required(args, "--amount-in"),
        fee: Number(required(args, "--fee")),
        slippageBps: Number(required(args, "--slippage-bps")),
        deadlineSecs: Number(required(args, "--deadline-seconds")),
      });
      console.log(
        JSON.stringify(
          { ...quote, account, executionAuthorized: false },
          (_, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
      );
    } finally {
      provider.destroy();
    }
    return;
  }
  throw new Error("Trading action is not supported");
}

async function orderCommand(directory: string, args: string[]): Promise<void> {
  const action = args[0];
  if (action === "create") {
    validateOrderArguments(
      args,
      new Set([
        "--id",
        "--side",
        "--type",
        "--token-in",
        "--token-out",
        "--amount-in",
        "--limit-price",
        "--fee",
        "--slippage-bps",
        "--deadline-seconds",
        "--directory",
      ]),
    );
    const identity = await configuredIdentity(directory);
    const order = await createOrder(directory, {
      id: required(args, "--id"),
      side: required(args, "--side") as "buy" | "sell",
      type: required(args, "--type") as "market" | "limit",
      tokenIn: required(args, "--token-in"),
      tokenOut: required(args, "--token-out"),
      amountIn: required(args, "--amount-in"),
      limitPrice: optional(args, "--limit-price"),
      fee: numberOption(args, "--fee", 3000) as 100 | 500 | 3000 | 10000,
      slippageBps: numberOption(args, "--slippage-bps"),
      deadlineSeconds: numberOption(args, "--deadline-seconds"),
      account: identity,
    });
    output({ order, executionAuthorized: false });
    return;
  }
  if (action === "list") {
    validateOrderArguments(
      args,
      new Set(["--side", "--type", "--status", "--directory"]),
    );
    const filter: OrderFilter = {};
    const side = optional(args, "--side");
    const type = optional(args, "--type");
    const status = optional(args, "--status");
    if (side !== undefined) {
      filter.side = side as NonNullable<OrderFilter["side"]>;
    }
    if (type !== undefined) {
      filter.type = type as NonNullable<OrderFilter["type"]>;
    }
    if (status !== undefined) {
      filter.status = status as NonNullable<OrderFilter["status"]>;
    }
    const orders = await listOrders(directory, filter);
    output({ orders, executionAuthorized: false });
    return;
  }
  if (action === "status") {
    validateOrderArguments(args, new Set(["--directory"]));
    output({
      ...(await summarizeOrders(directory)),
      executionAuthorized: false,
    });
    return;
  }
  if (action === "cancel") {
    validateOrderArguments(args, new Set(["--id", "--directory"]));
    output({
      order: await cancelOrder(directory, required(args, "--id")),
      executionAuthorized: false,
    });
    return;
  }
  if (action === "check") {
    validateOrderArguments(args, new Set(["--id", "--directory"]));
    await checkOrder(directory, required(args, "--id"));
    return;
  }
  throw new Error(
    "trade order requires create, list, cancel, status, or check",
  );
}

async function checkOrder(directory: string, id: string): Promise<void> {
  const order = (await listOrders(directory)).find(
    (candidate) => candidate.id === id,
  );
  if (!order) throw new Error(`Order ${id} does not exist`);
  if (order.status !== "open" && order.status !== "ready") {
    throw new Error(`Order ${id} cannot be checked from ${order.status}`);
  }
  if ((await configuredIdentity(directory)) !== order.account) {
    throw new Error("Order account does not match the configured wallet");
  }

  const provider = await createNetworkProvider(directory);
  try {
    const quote = await quoteExactInputSingle({
      provider,
      recipient: order.account,
      tokenIn: order.tokenIn,
      tokenOut: order.tokenOut,
      amountIn: order.amountIn,
      fee: order.fee,
      slippageBps: order.slippageBps,
      deadlineSecs: order.deadlineSeconds,
    });
    const preparedQuote = JSON.parse(
      JSON.stringify(
        { ...quote, account: order.account, executionAuthorized: false },
        (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
      ),
    ) as Record<string, unknown>;
    const reachable = isOrderReachable(
      order,
      String(preparedQuote.amountOutMinimum),
    );

    output({
      order: await setOrderReadiness(directory, id, reachable),
      reachable,
      preparedQuote: reachable ? preparedQuote : null,
      executionAuthorized: false,
    });
  } finally {
    provider.destroy();
  }
}

async function configuredIdentity(directory: string): Promise<string> {
  return (
    await new WalletVault(
      directory,
      createCredentialStore(directory),
    ).identity()
  ).address;
}

function output(value: unknown): void {
  console.log(JSON.stringify(value));
}

function optional(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value?.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function numberOption(
  args: string[],
  name: string,
  defaultValue?: number,
): number {
  const value = optional(args, name);
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (value === undefined) throw new Error(`${name} is required`);

  return Number(value);
}

function validateOrderArguments(
  args: string[],
  allowedOptions: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name?.startsWith("--") ||
      !allowedOptions.has(name) ||
      seen.has(name) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error("Invalid trade order arguments");
    }
    seen.add(name);
  }
}

function required(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
