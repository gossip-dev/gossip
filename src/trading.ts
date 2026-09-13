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

export async function tradingCommand(
  directory: string,
  args: string[],
): Promise<void> {
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

function required(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
