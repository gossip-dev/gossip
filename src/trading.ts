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
import { getAddress, Interface } from "ethers";
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
import {
  activateAutonomyProposal,
  authorizeAutonomousRequest,
  chooseConfirmEach,
  proposeAutonomy,
  readActiveAutonomyPolicy,
  readAutonomyStatus,
  revokeAutonomy,
} from "./trade-autonomy.js";
import {
  cancelStrategy,
  createDca,
  createWatcher,
  getStrategy,
  listStrategies,
  pauseStrategy,
  resumeStrategy,
} from "./trade-strategies.js";

export async function tradingCommand(
  directory: string,
  args: string[],
): Promise<void> {
  if (args[0] === "order") {
    await orderCommand(directory, args.slice(1));
    return;
  }
  if (args[0] === "autonomy") {
    await autonomyCommand(directory, args.slice(1));
    return;
  }
  if (args[0] === "buy") {
    await autonomousBuyCommand(directory, args.slice(1));
    return;
  }
  if (args[0] === "watcher" || args[0] === "dca") {
    await strategyCommand(directory, args[0], args.slice(1));
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

async function strategyCommand(
  directory: string,
  kind: "watcher" | "dca",
  args: string[],
): Promise<void> {
  const action = args[0];
  const account = await configuredIdentity(directory);
  if (action === "create") {
    validateOrderArguments(
      args,
      new Set([
        "--id",
        "--token-in",
        "--token-out",
        "--fee",
        "--slippage-bps",
        "--comparison",
        "--amount-out",
        "--amount-in",
        "--anchor-at",
        "--interval-seconds",
        "--max-runs",
        "--directory",
      ]),
    );
    const tradeMode = await readAutonomyStatus(directory);
    if (tradeMode.mode === "choice-required") {
      throw new Error("Autonomy mode choice is required before strategies");
    }
    const authorization =
      tradeMode.mode === "bounded-auto"
        ? {
            kind: "standing-envelope" as const,
            policyId: tradeMode.policy.id,
            policyRevision: tradeMode.policy.revision,
          }
        : { kind: "confirm-each" as const };
    const common = {
      kind,
      id: required(args, "--id"),
      account,
      tokenIn: required(args, "--token-in"),
      tokenOut: required(args, "--token-out"),
      fee: numberOption(args, "--fee", 3000) as 100 | 500 | 3000 | 10000,
      slippageBps: numberOption(args, "--slippage-bps"),
      authorization,
    };
    if (tradeMode.mode === "bounded-auto") {
      const policy = tradeMode.policy;
      const actionKind = kind === "dca" ? "dca" : "watcher";
      if (
        !policy.actionKinds.includes(actionKind) ||
        policy.inputToken !== getAddress(common.tokenIn) ||
        !policy.outputTokens.includes(getAddress(common.tokenOut)) ||
        !policy.feeTiers.includes(common.fee) ||
        common.slippageBps > policy.maxSlippageBps
      ) {
        throw new Error("Strategy does not fit the active autonomy policy");
      }
    }
    const strategy =
      kind === "watcher"
        ? await createWatcher(directory, {
            ...common,
            kind,
            threshold: {
              comparison: required(args, "--comparison") as
                | "at-or-above"
                | "at-or-below",
              amountOut: required(args, "--amount-out"),
            },
            pollIntervalSeconds: numberOption(args, "--interval-seconds"),
            maxRuns:
              optional(args, "--max-runs") === undefined
                ? null
                : numberOption(args, "--max-runs"),
          })
        : await createDca(directory, {
            ...common,
            kind,
            amountIn: required(args, "--amount-in"),
            anchorAt: numberOption(args, "--anchor-at"),
            intervalSeconds: numberOption(args, "--interval-seconds"),
            maxRuns: numberOption(args, "--max-runs"),
          });
    output({ strategy, executionAuthorized: false });
    return;
  }
  if (action === "list") {
    validateOrderArguments(args, new Set(["--status", "--directory"]));
    const strategies = await listStrategies(
      directory,
      account,
      optional(args, "--status") as
        | "active"
        | "paused"
        | "cancelled"
        | "blocked"
        | "completed"
        | undefined,
    );
    output({
      strategies: strategies.filter((strategy) => strategy.kind === kind),
      executionAuthorized: false,
    });
    return;
  }
  if (action === "status") {
    validateOrderArguments(args, new Set(["--id", "--directory"]));
    const strategy = await getStrategy(
      directory,
      account,
      required(args, "--id"),
    );
    if (strategy.kind !== kind) {
      throw new Error(`Strategy is a ${strategy.kind}, not a ${kind}`);
    }
    output({
      strategy,
      executionAuthorized: false,
    });
    return;
  }
  if (action === "pause" || action === "resume" || action === "cancel") {
    validateOrderArguments(args, new Set(["--id", "--directory"]));
    const id = required(args, "--id");
    const current = await getStrategy(directory, account, id);
    if (current.kind !== kind) {
      throw new Error(`Strategy is a ${current.kind}, not a ${kind}`);
    }
    const strategy =
      action === "pause"
        ? await pauseStrategy(directory, account, id)
        : action === "resume"
          ? await resumeStrategy(directory, account, id)
          : await cancelStrategy(directory, account, id);
    output({ strategy, executionAuthorized: false });
    return;
  }
  throw new Error(
    `trade ${kind} requires create, list, status, pause, resume, or cancel`,
  );
}

async function autonomousBuyCommand(
  directory: string,
  args: string[],
): Promise<void> {
  validateOrderArguments(
    ["buy", ...args],
    new Set([
      "--id",
      "--token-out",
      "--spend-wei",
      "--spend-bps",
      "--fee",
      "--slippage-bps",
      "--deadline-seconds",
      "--directory",
    ]),
  );
  const id = required(args, "--id");
  try {
    const existing = await readPermission(directory);
    if (
      existing.id === id &&
      existing.authorizationSource?.kind === "standing-envelope" &&
      existing.authorizationSource.requestId === id
    ) {
      const source = existing.authorizationSource;
      const suppliedSpendType = optional(args, "--spend-wei")
        ? "fixed"
        : "balance-bps";
      const suppliedSpendValue =
        optional(args, "--spend-wei") ?? optional(args, "--spend-bps");
      if (
        source.requestIntent.tokenOut !==
          getAddress(required(args, "--token-out")) ||
        source.requestIntent.spendType !== suppliedSpendType ||
        source.requestIntent.spendValue !== suppliedSpendValue
      ) {
        throw new Error("Autonomous operation ID already has another request");
      }
      output(await executeTrade(directory, id));
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const policy = await readActiveAutonomyPolicy(directory);
  const account = await configuredIdentity(directory);
  if (account !== policy.account) {
    throw new Error("Autonomy account does not match configured wallet");
  }
  const spendWei = optional(args, "--spend-wei");
  const spendBps = optional(args, "--spend-bps");
  if (Boolean(spendWei) === Boolean(spendBps)) {
    throw new Error("Autonomy buy requires exactly one spend amount");
  }
  const provider = await createNetworkProvider(directory);
  try {
    const token = new Interface([
      "function balanceOf(address) view returns(uint256)",
    ]);
    const balance = token.decodeFunctionResult(
      "balanceOf",
      await provider.call({
        to: policy.inputToken,
        data: token.encodeFunctionData("balanceOf", [account]),
      }),
    )[0] as bigint;
    const basisPoints = spendBps === undefined ? null : Number(spendBps);
    if (
      basisPoints !== null &&
      (!Number.isInteger(basisPoints) ||
        basisPoints < 1 ||
        basisPoints > 10_000)
    ) {
      throw new Error("Autonomy spend bps must be between 1 and 10000");
    }
    const amountIn =
      spendWei === undefined
        ? (balance * BigInt(basisPoints!)) / 10_000n
        : BigInt(spendWei);
    const fee = numberOption(args, "--fee", policy.feeTiers[0]!) as
      | 100
      | 500
      | 3000
      | 10000;
    const slippageBps = numberOption(
      args,
      "--slippage-bps",
      policy.maxSlippageBps,
    );
    const deadlineSeconds = numberOption(
      args,
      "--deadline-seconds",
      policy.maxDeadlineSeconds,
    );
    const quote = await quoteExactInputSingle({
      provider,
      recipient: account,
      tokenIn: policy.inputToken,
      tokenOut: required(args, "--token-out"),
      amountIn,
      fee,
      slippageBps,
      deadlineSecs: deadlineSeconds,
    });
    const serializedQuote = JSON.parse(
      JSON.stringify(
        { ...quote, account, executionAuthorized: false },
        (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
      ),
    );
    const reservation = await authorizeAutonomousRequest(directory, {
      id,
      policyId: policy.id,
      actionKind: "quick-buy",
      account,
      tokenIn: policy.inputToken,
      tokenOut: required(args, "--token-out"),
      amountIn: amountIn.toString(),
      inputBalance: balance.toString(),
      fee,
      slippageBps,
      deadlineSeconds,
      gasLimit: policy.gasLimit,
      maxFeePerGas: policy.maxFeePerGas,
      maxPriorityFeePerGas: policy.maxPriorityFeePerGas,
    });
    const permission = permissionSchema.parse({
      schemaVersion: 1,
      id,
      enabled: true,
      quote: serializedQuote,
      gasLimit: policy.gasLimit,
      maxFeePerGas: policy.maxFeePerGas,
      maxPriorityFeePerGas: policy.maxPriorityFeePerGas,
      minNativeReserveWei: policy.minNativeReserveWei,
      authorizationSource: {
        kind: "standing-envelope",
        envelopeId: policy.id,
        envelopeRevision: policy.revision,
        requestId: id,
        reservationFingerprint: reservation.fingerprint,
        requestIntent: {
          tokenOut: required(args, "--token-out"),
          spendType: spendWei === undefined ? "balance-bps" : "fixed",
          spendValue: spendWei ?? spendBps!,
        },
      },
    });
    validatePermission(permission);
    await withTradeLock(directory, async () => {
      try {
        const current = await readPermission(directory);
        if (
          current.id !== id &&
          !(await permissionCanBeReplaced(directory, current.id))
        ) {
          throw new Error(
            "Existing trade permission must be reconciled before replacement",
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeTradeFile(directory, "trade-permission.json", permission);
    });
    output(await executeTrade(directory, id));
  } finally {
    provider.destroy();
  }
}

async function autonomyCommand(
  directory: string,
  args: string[],
): Promise<void> {
  const action = args[0];
  if (action === "status") {
    validateOrderArguments(args, new Set(["--directory"]));
    output(await readAutonomyStatus(directory));
    return;
  }
  if (action === "choose") {
    validateOrderArguments(args, new Set(["--mode", "--directory"]));
    if (required(args, "--mode") !== "confirm-each") {
      throw new Error(
        "Use autonomy propose and activate for bounded-auto mode",
      );
    }
    await chooseConfirmEach(directory);
    output(await readAutonomyStatus(directory));
    return;
  }
  if (action === "propose") {
    const allowed = new Set([
      "--id",
      "--token-in",
      "--token-out",
      "--allow",
      "--max-input-per-trade",
      "--max-input-per-utc-day",
      "--max-input-total",
      "--max-trades-per-utc-day",
      "--max-executions",
      "--max-input-balance-bps",
      "--max-slippage-bps",
      "--gas-limit",
      "--max-fee-wei",
      "--max-priority-fee-wei",
      "--max-gas-cost-per-trade",
      "--max-gas-cost-per-utc-day",
      "--max-deadline-seconds",
      "--min-native-reserve-wei",
      "--fee",
      "--valid-until",
      "--directory",
    ]);
    validateRepeatedArguments(
      args,
      allowed,
      new Set(["--token-out", "--allow", "--fee"]),
    );
    const policy = await proposeAutonomy(directory, {
      id: required(args, "--id"),
      account: await configuredIdentity(directory),
      inputToken: required(args, "--token-in"),
      outputTokens: allOptions(args, "--token-out"),
      actionKinds: allOptions(args, "--allow") as (
        | "quick-buy"
        | "dca"
        | "watcher"
      )[],
      maxInputPerTrade: required(args, "--max-input-per-trade"),
      maxInputPerUtcDay: required(args, "--max-input-per-utc-day"),
      maxInputTotal: required(args, "--max-input-total"),
      maxTradesPerUtcDay: numberOption(args, "--max-trades-per-utc-day"),
      maxExecutions: numberOption(args, "--max-executions"),
      maxInputBalanceBps: numberOption(args, "--max-input-balance-bps"),
      maxSlippageBps: numberOption(args, "--max-slippage-bps"),
      gasLimit: required(args, "--gas-limit"),
      maxFeePerGas: required(args, "--max-fee-wei"),
      maxPriorityFeePerGas: required(args, "--max-priority-fee-wei"),
      maxGasCostPerTrade: required(args, "--max-gas-cost-per-trade"),
      maxGasCostPerUtcDay: required(args, "--max-gas-cost-per-utc-day"),
      maxDeadlineSeconds: numberOption(args, "--max-deadline-seconds"),
      minNativeReserveWei: required(args, "--min-native-reserve-wei"),
      feeTiers: allOptions(args, "--fee").map(Number) as (
        | 100
        | 500
        | 3000
        | 10000
      )[],
      validUntil: numberOption(args, "--valid-until"),
    });
    output({
      proposedPolicy: policy,
      executionAuthorized: false,
      nextStep:
        "Review every bound locally, then run trade autonomy activate --id ID in an interactive terminal.",
    });
    return;
  }
  if (action === "activate") {
    validateOrderArguments(args, new Set(["--id", "--directory"]));
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Autonomy activation requires an interactive terminal");
    }
    const status = await readAutonomyStatus(directory);
    output({
      proposedPolicy:
        "policy" in status ? status.policy : (status.proposedPolicy ?? null),
    });
    if (
      (await readSecret(
        "Type CONFIRM to activate bounded autonomous trading: ",
      )) !== "CONFIRM"
    ) {
      throw new Error("Autonomy activation cancelled");
    }
    const policy = await activateAutonomyProposal(
      directory,
      required(args, "--id"),
      await configuredIdentity(directory),
    );
    output({ policy, executionAuthorized: true });
    return;
  }
  if (action === "revoke") {
    validateOrderArguments(args, new Set(["--directory"]));
    output({
      policy: await revokeAutonomy(directory),
      executionAuthorized: false,
      existingTransactionsAndAllowances: "unchanged",
    });
    return;
  }
  throw new Error(
    "trade autonomy requires status, choose, propose, activate, or revoke",
  );
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

function validateRepeatedArguments(
  args: string[],
  allowedOptions: ReadonlySet<string>,
  repeatableOptions: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name?.startsWith("--") ||
      !allowedOptions.has(name) ||
      (seen.has(name) && !repeatableOptions.has(name)) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error("Invalid trade autonomy arguments");
    }
    seen.add(name);
  }
}

function allOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      values.push(value);
    }
  }
  return values;
}

function required(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
