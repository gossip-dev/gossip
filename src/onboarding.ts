import { installSkills } from "./skill-install.js";
import { access } from "node:fs/promises";
import { configureNetwork, checkNetwork } from "./network.js";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { installHost } from "./host-install.js";
import { prepareConnection } from "./setup-connection.js";
import { saveConfiguration } from "./configuration.js";
import { validateKeyFile, verifyExistingSigner } from "./external-signer.js";
import { WalletVault } from "./wallet.js";
import { createCredentialStore } from "./credential-store.js";
import { loadConfiguration } from "./configuration.js";
import { hostConfiguration, type SupportedHost } from "./hosts.js";
import { installInstructions } from "./instruction-install.js";
import { chooseConfirmEach, readAutonomyStatus } from "./trade-autonomy.js";

const standardNames = [
  "EIP-55",
  "EIP-191",
  "EIP-712",
  "ERC-1271",
  "ERC-8004",
  "ERC-8128",
] as const;

const standardNextSteps: Record<(typeof standardNames)[number], string> = {
  "EIP-55": "Select a wallet to validate its checksummed address.",
  "EIP-191": "Select a wallet to verify a fresh local signing proof.",
  "EIP-712":
    "Verify the concrete AgentWalletSet proof with a supported signer and registry.",
  "ERC-1271":
    "An EOA is not a contract wallet; existing contract accounts need a compatible signer and engine verifier.",
  "ERC-8004":
    "Select a verified registry and agent ID to check ownership and wallet association.",
  "ERC-8128":
    "A compatible engine and signer are required before activating ERC-8128.",
};

export async function onboardingCommand(
  directory: string,
  args: string[],
): Promise<void> {
  const allowed = new Set([
    "--host",
    "--directory",
    "--wallet",
    "--file",
    "--format",
    "--address",
    "--endpoint",
    "--audience",
    "--profile",
    "--config",
    "--network",
    "--rpc",
    "--skills-directory",
    "--trade-mode",
    "--instructions-file",
  ]);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    if (!allowed.has(name) || seen.has(name))
      throw new Error("Unsupported or duplicate setup option");
    required(args, name);
    seen.add(name);
  }
  const hostIndex = args.indexOf("--host");
  const host = args[hostIndex + 1];
  if (hostIndex < 0 || !["grok-bot", "hermes", "openclaw"].includes(host ?? ""))
    throw new Error("--host must be grok-bot, hermes or openclaw");
  const endpoint = option(args, "--endpoint");
  const audience = option(args, "--audience");
  if (Boolean(endpoint) !== Boolean(audience))
    throw new Error("Both endpoint and audience are required");
  for (const value of [endpoint, audience]) {
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Invalid endpoint or audience");
  }
  const configPath = option(args, "--config");
  if (configPath && !isAbsolute(configPath))
    throw new Error("--config must be absolute");
  const instructionsPath = option(args, "--instructions-file");
  if (instructionsPath && !isAbsolute(instructionsPath)) {
    throw new Error("--instructions-file must be absolute");
  }
  const requestedTradeMode = option(args, "--trade-mode");
  if (
    requestedTradeMode &&
    requestedTradeMode !== "confirm-each" &&
    requestedTradeMode !== "buy-and-fire"
  ) {
    throw new Error("--trade-mode must be confirm-each or buy-and-fire");
  }
  const hostArgs = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js"),
    "serve",
    "--directory",
    directory,
  ];
  let hostConfigured = false;
  const networkMode = option(args, "--network");
  if (networkMode && !["configure", "check"].includes(networkMode))
    throw new Error("Unsupported network mode");
  let network: Record<string, unknown> = {
    status: "unchecked",
    nextStep:
      "Run setup-gossip with --network configure after selecting the wallet.",
  };
  const vault = new WalletVault(directory, createCredentialStore(directory));
  const walletMode = option(args, "--wallet");
  if (walletMode && !["create", "reuse", "attach-file"].includes(walletMode))
    throw new Error("Unsupported wallet mode");
  if (walletMode && Number(process.versions.node.split(".")[0]) < 24)
    throw new Error(
      "Node.js 24 or newer is required. Install Node.js 24, then rerun this command.",
    );
  if (walletMode === "create") {
    if (await exists(resolve(directory, "config.yaml"))) await vault.identity();
    await vault.create();
  }
  if (walletMode === "attach-file") {
    await vault.attachFile(
      required(args, "--address"),
      validateKeyFile({
        keyFile: required(args, "--file"),
        format: required(args, "--format"),
      }),
    );
  }
  let wallet: { status: string; address?: string; nextStep?: string };
  try {
    const identity = await vault.identity();
    await verifyExistingSigner(await vault.signer());
    wallet = { status: "verified", address: identity.address };
  } catch {
    wallet = {
      status: "pending",
      nextStep:
        "Select an existing wallet or explicitly request protected creation; inspect an existing profile before replacing anything.",
    };
  }
  if (endpoint && audience && wallet.status === "verified")
    await prepareConnection(directory, args);
  let configured = false;
  let connected = false;
  try {
    await loadConfiguration(directory);
    configured = true;
  } catch {
    /* Report pending without replacing state. */
  }
  if (endpoint && configured && wallet.status === "verified") {
    try {
      const { checkConnection } = await import("./bridge.js");
      await checkConnection(directory);
      await saveConfiguration(directory, {
        ...(await loadConfiguration(directory)),
        enabled: true,
      });
      connected = true;
    } catch {
      /* An unavailable engine must not discard a verified local wallet. */
    }
  }
  if (configPath && host !== "grok-bot") {
    await installHost(
      host as SupportedHost,
      configPath,
      process.execPath,
      hostArgs,
    );
    hostConfigured = true;
  }
  if (networkMode) {
    try {
      const result =
        networkMode === "configure"
          ? await configureNetwork(directory, option(args, "--rpc"))
          : await checkNetwork(directory, option(args, "--rpc"));
      network = { status: "verified", ...result };
    } catch {
      network = {
        status: "pending",
        nextStep:
          "Check the selected HTTPS RPC, chain 4663, fresh blocks and connectivity; existing configuration was preserved.",
      };
    }
  }
  const skillsDirectory = option(args, "--skills-directory");
  const skills = skillsDirectory
    ? await installSkills(skillsDirectory)
    : {
        installed: false,
        nextStep:
          "Select the documented host skill directory with --skills-directory.",
      };
  const instructions = instructionsPath
    ? await installInstructions(instructionsPath)
    : {
        changed: false,
        pending: true,
        nextStep:
          "Provide the active AGENTS.md or equivalent as --instructions-file to install the trading-mode prompt additively.",
      };
  if (requestedTradeMode === "confirm-each") {
    await chooseConfirmEach(directory);
  }
  const tradeMode = await readAutonomyStatus(directory);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      skills,
      instructions,
      runtime: {
        version: process.versions.node,
        ready: Number(process.versions.node.split(".")[0]) >= 24,
        nextStep:
          Number(process.versions.node.split(".")[0]) >= 24
            ? null
            : "Run the pinned prerequisite bootstrap to install Node 24.",
      },
      wallet,
      host: {
        name: host,
        configured: hostConfigured,
        nextStep:
          host === "grok-bot"
            ? "After gossip connect succeeds, pass the emitted arguments to AddMcpServer, call RestartMcpServers, then verify GetMcpServerStatus and GetDynamicTools in the next message."
            : "Verify the installed tools in the actual host; a configuration fragment alone is not a loaded connection.",
        ...hostConfiguration(host as SupportedHost, process.execPath, hostArgs),
      },
      gossip: {
        status: connected ? "connected" : "pending",
        configured,
        connected,
        nextStep: configured
          ? "Run gossip connect to verify signed agent_access."
          : "Provide the actual HTTPS endpoint and audience to gossip setup.",
      },
      network,
      standards: standardNames.map((standard) => {
        const local =
          wallet.status === "verified" &&
          ["EIP-55", "EIP-191"].includes(standard);
        return {
          standard,
          status: local
            ? "verified-local"
            : standard === "ERC-8128"
              ? "blocked"
              : "unverified",
          evidence: local
            ? "Selected address validated and a fresh local EIP-191 proof recovered to that address."
            : "Library/fixture availability alone does not establish this wallet profile.",
          nextStep: local ? null : standardNextSteps[standard],
        };
      }),
      trading: {
        executionAuthorized: tradeMode.executionAuthorized,
        status: tradeMode.mode,
        mode: tradeMode.mode,
        adapter: "uniswap-v3-exact-input",
        identityWallet: wallet.address ?? null,
        tradingWallet: null,
        nextStep:
          requestedTradeMode === "buy-and-fire"
            ? "Create and review a fully bounded proposal with trade autonomy propose, then activate it locally. Setup never grants standing trade authority."
            : tradeMode.mode === "choice-required"
              ? "Ask the owner to choose confirm-each or bounded buy-and-fire before the first trading request."
              : tradeMode.mode === "confirm-each"
                ? "Quote the exact trade, then obtain the existing interactive one-trade confirmation before execution."
                : "Execute only exact requests that remain inside the active local policy.",
      },
    }),
  );
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
