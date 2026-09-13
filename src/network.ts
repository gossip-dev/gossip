import { mkdir, open, rm, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { Interface, formatUnits, getAddress, isAddress } from "ethers";

const DEFAULT_RPC = "https://robinhood-rpc.publicnode.com";
const CHAIN_ID = 4663;
const RPC_TIMEOUT_MS = 8_000;
const networkPath = (directory: string) => join(directory, "network.yaml");
const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export interface NetworkConfiguration {
  schemaVersion: 1;
  rpc: string;
  chainId: 4663;
}

function safeRpc(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RPC endpoint must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(
      "RPC endpoint must be HTTPS without credentials or fragments",
    );
  return value;
}

function publicRpc(value: string): string {
  const url = new URL(value);
  return url.host;
}

async function loadNetwork(
  directory: string,
  override?: string,
): Promise<NetworkConfiguration> {
  if (override)
    return { schemaVersion: 1, rpc: safeRpc(override), chainId: CHAIN_ID };
  try {
    const value = parse(
      await readFile(networkPath(directory), "utf8"),
    ) as Partial<NetworkConfiguration>;
    if (
      value.schemaVersion !== 1 ||
      value.chainId !== CHAIN_ID ||
      typeof value.rpc !== "string"
    )
      throw new Error("invalid");
    return { schemaVersion: 1, rpc: safeRpc(value.rpc), chainId: CHAIN_ID };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, rpc: DEFAULT_RPC, chainId: CHAIN_ID };
    if (error instanceof Error && error.message.includes("HTTPS")) throw error;
    throw new Error("Network configuration is invalid");
  }
}

async function saveNetwork(
  directory: string,
  config: NetworkConfiguration,
): Promise<void> {
  const path = networkPath(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, stringify(config), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) =>
      rm(temporary, { force: true }),
    );
    throw error;
  }
}

type RpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("RPC redirects are not allowed");
    if (!response.ok)
      throw new Error(`RPC request failed (${response.status})`);
    const payload: unknown = JSON.parse(
      Buffer.from(await readRpcBody(response)).toString("utf8"),
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as Record<string, unknown>).jsonrpc !== "2.0" ||
      (payload as Record<string, unknown>).id !== 1
    )
      throw new Error("RPC returned a malformed response");
    const envelope = payload as RpcResponse;
    if (envelope.error || !Object.hasOwn(envelope, "result"))
      throw new Error("RPC request failed");
    return envelope.result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("RPC request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function required(args: string[], name: string): string {
  const i = args.indexOf(name);
  const value = i < 0 ? undefined : args[i + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function address(args: string[], name = "--address"): string {
  const value = required(args, name);
  if (!isAddress(value)) throw new Error(`${name} must be an Ethereum address`);
  return getAddress(value);
}
function rpcOverride(args: string[]): string | undefined {
  const i = args.indexOf("--rpc");
  return i < 0 ? undefined : args[i + 1];
}
function output(value: unknown): void {
  console.log(JSON.stringify(value));
}

function hex(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error(`RPC returned an invalid ${label}`);
  return BigInt(value);
}

async function assertChain(config: NetworkConfiguration): Promise<void> {
  if (
    Number(hex(await rpc(config.rpc, "eth_chainId"), "chain ID")) !== CHAIN_ID
  )
    throw new Error(`RPC chain is not ${CHAIN_ID}`);
}

async function configureUnlocked(
  directory: string,
  explicitRpc?: string,
): Promise<{ configured: true; rpc: string; chainId: 4663 }> {
  let existing: NetworkConfiguration | undefined;
  try {
    await readFile(networkPath(directory));
    existing = await loadNetwork(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const requested =
    explicitRpc === undefined
      ? (existing?.rpc ?? DEFAULT_RPC)
      : safeRpc(explicitRpc);
  if (existing && explicitRpc !== undefined && requested !== existing.rpc)
    throw new Error(
      "Existing RPC configuration conflicts; refusing to overwrite it",
    );
  const config = {
    schemaVersion: 1 as const,
    rpc: requested,
    chainId: CHAIN_ID as 4663,
  };
  await checkNetwork(directory, requested);
  await saveNetwork(directory, config);
  return {
    configured: true as const,
    rpc: publicRpc(config.rpc),
    chainId: config.chainId,
  };
}

export async function checkNetwork(
  directory: string,
  explicitRpc?: string,
): Promise<{
  chainId: 4663;
  blockNumber: number;
  blockAgeSeconds: number;
  rpc: string;
}> {
  const config = await loadNetwork(directory, explicitRpc);
  await assertChain(config);
  const blockNumber = Number(
    hex(await rpc(config.rpc, "eth_blockNumber"), "block number"),
  );
  const block = await rpc(config.rpc, "eth_getBlockByNumber", [
    `0x${blockNumber.toString(16)}`,
    false,
  ]);
  if (!block || typeof block !== "object")
    throw new Error("RPC returned an invalid latest block");
  const timestamp = hex(
    (block as Record<string, unknown>).timestamp,
    "block timestamp",
  );
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (age < 0 || age > 300) throw new Error("RPC latest block is stale");
  return {
    chainId: CHAIN_ID as 4663,
    blockNumber,
    blockAgeSeconds: age,
    rpc: publicRpc(config.rpc),
  };
}

export async function networkCommand(
  directory: string,
  args: string[],
): Promise<void> {
  const allowed = new Set([
    "--directory",
    "--rpc",
    "--address",
    "--token",
    "--owner",
    "--spender",
    "--tx",
  ]);
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!;
    if (
      !allowed.has(name) ||
      seen.has(name) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith("--")
    )
      throw new Error("Invalid network arguments");
    seen.add(name);
  }
  const action = args[0];
  if (action === "configure") {
    output(await configureNetwork(directory, rpcOverride(args)));
    return;
  }
  if (action === "check") {
    output(await checkNetwork(directory, rpcOverride(args)));
    return;
  }
  const config = await loadNetwork(directory, rpcOverride(args));
  if (action === "status") {
    output({ ...config, rpc: publicRpc(config.rpc) });
    return;
  }
  await assertChain(config);
  if (action === "balance") {
    const who = address(args);
    const value = hex(
      await rpc(config.rpc, "eth_getBalance", [who, "latest"]),
      "balance",
    );
    output({
      address: who,
      balanceWei: value.toString(),
      balance: formatUnits(value, 18),
    });
    return;
  }
  if (action === "token" || action === "allowance") {
    const token = address(args, "--token");
    const data =
      action === "token"
        ? erc20.encodeFunctionData("balanceOf", [address(args)])
        : erc20.encodeFunctionData("allowance", [
            address(args, "--owner"),
            address(args, "--spender"),
          ]);
    const result = await rpc(config.rpc, "eth_call", [
      { to: token, data },
      "latest",
    ]);
    if (typeof result !== "string")
      throw new Error("RPC returned an invalid contract result");
    const raw = erc20.decodeFunctionResult(
      action === "token" ? "balanceOf" : "allowance",
      result,
    )[0] as bigint;
    if (action === "token") {
      const decimalsResult = await rpc(config.rpc, "eth_call", [
        { to: token, data: erc20.encodeFunctionData("decimals", []) },
        "latest",
      ]);
      if (typeof decimalsResult !== "string")
        throw new Error("Invalid token decimals");
      const decimals = Number(
        erc20.decodeFunctionResult("decimals", decimalsResult)[0],
      );
      output({
        token,
        value: raw.toString(),
        decimals,
        balance: formatUnits(raw, decimals),
      });
    } else output({ token, value: raw.toString() });
    return;
  }
  if (action === "receipt") {
    const tx = required(args, "--tx");
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx))
      throw new Error("--tx must be a transaction hash");
    output({
      transactionHash: tx,
      receipt: await rpc(config.rpc, "eth_getTransactionReceipt", [tx]),
    });
    return;
  }
  if (action === "fees") {
    const [gasPrice, priority] = await Promise.all([
      rpc(config.rpc, "eth_gasPrice"),
      rpc(config.rpc, "eth_maxPriorityFeePerGas"),
    ]);
    output({
      gasPriceWei: hex(gasPrice, "gas price").toString(),
      maxPriorityFeePerGasWei: hex(priority, "priority fee").toString(),
    });
    return;
  }
  throw new Error(
    "network requires configure, status, check, balance, token, allowance, receipt, or fees",
  );
}

export async function createNetworkProvider(directory: string) {
  const { FetchRequest, JsonRpcProvider } = await import("ethers");
  const config = await loadNetwork(directory);
  await checkNetwork(directory);
  const request = new FetchRequest(config.rpc);
  request.timeout = RPC_TIMEOUT_MS;
  request.setThrottleParams({ maxAttempts: 1 });
  request.getUrlFunc = async (input) => {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body ? Buffer.from(input.body) : null,
      redirect: "error",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const bytes = await readRpcBody(response);
    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: new Uint8Array(bytes),
    };
  };
  return new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
}

async function readRpcBody(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error("Empty RPC response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 2 * 1024 * 1024)
        throw new Error("RPC response exceeds limit");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function configureNetwork(
  directory: string,
  explicitRpc?: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "network.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    return await configureUnlocked(directory, explicitRpc);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
