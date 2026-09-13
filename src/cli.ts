#!/usr/bin/env node
import { prepareConnection } from "./setup-connection.js";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAddress } from "ethers";
import { WalletVault } from "./wallet.js";
import { validateKeyFile } from "./external-signer.js";
import { createCredentialStore } from "./credential-store.js";
import {
  loadConfiguration,
  saveConfiguration,
  type Configuration,
} from "./configuration.js";
import { readSecret } from "./secret-prompt.js";
import { hostConfiguration, type SupportedHost } from "./hosts.js";
import { installHost, uninstallHost } from "./host-install.js";
import {
  installInstructions,
  uninstallInstructions,
} from "./instruction-install.js";
import { createStandardsCapabilityReport } from "./standards.js";

const defaultDirectory = resolve(homedir(), ".gossip");

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help")
    return printHelp();
  const command = argv[0];
  try {
    const directory = parseDirectory(argv);
    if (command === "setup-gossip") {
      const { onboardingCommand } = await import("./onboarding.js");
      return await onboardingCommand(directory, argv.slice(1));
    }
    if (command === "instructions")
      return await instructionsCommand(argv.slice(1));
    if (command === "status") return await status(directory);
    if (command === "doctor") return await doctor(directory);
    if (Number(process.versions.node.split(".")[0]) < 24) {
      throw new Error(
        "Node.js 24 or newer is required. Install Node.js 24, then rerun this command.",
      );
    }
    if (command === "trade") {
      const { tradingCommand } = await import("./trading.js");
      return await tradingCommand(directory, argv.slice(1));
    }
    if (command === "network") {
      const { networkCommand } = await import("./network.js");
      return await networkCommand(directory, argv.slice(1));
    }
    if (command === "setup") return await setup(directory, argv.slice(1));
    if (command === "connect") return await connect(directory);
    if (command === "serve") return await serveCommand(directory);
    if (command === "disconnect") return await disconnect(directory);
    if (command === "wallet")
      return await walletCommand(directory, argv.slice(1));
    if (command === "policy")
      return await policyCommand(directory, argv.slice(1));
    if (command === "host-config") return hostConfig(argv.slice(1), directory);
    if (command === "host-install")
      return await hostInstallCommand(argv.slice(1), directory);
    if (command === "host-uninstall")
      return await hostUninstallCommand(argv.slice(1), directory);
    if (command === "standards") return await standardsCommand(directory);
    throw new Error("Unknown Gossip command. Use --help for usage.");
  } catch (error) {
    throw new Error(safeError(error));
  }
}

function parseDirectory(argv: string[]): string {
  const index = argv.indexOf("--directory");
  if (index < 0) return defaultDirectory;
  const value = argv[index + 1];
  if (!value || !isAbsolute(value))
    throw new Error("--directory must be an absolute path");
  return resolve(value);
}

async function status(directory: string): Promise<void> {
  let config: Configuration | null = null;
  try {
    config = await loadConfiguration(directory);
  } catch {
    /* status reports pending state */
  }
  let identity: Awaited<ReturnType<WalletVault["identity"]>> | null = null;
  try {
    identity = await new WalletVault(
      directory,
      createCredentialStore(directory),
    ).identity();
  } catch {
    /* never expose provider errors */
  }
  console.log(
    JSON.stringify({
      kitAvailable: true,
      runtimeVersion: process.versions.node,
      runtimeSupported: Number(process.versions.node.split(".")[0]) >= 24,
      connected: false,
      connectionChecked: false,
      enabled: Boolean(config?.enabled),
      configured: Boolean(config),
      identity: identity?.address ?? null,
      configuredStorageAdapter:
        identity?.signer === "existing-key-file"
          ? "existing-key-file"
          : process.platform === "win32"
            ? "windows-dpapi"
            : process.platform === "linux"
              ? "linux-secret-service"
              : "unsupported",
      storageVerified: false,
      limitations: [
        "protected credential storage availability is not verified by status",
        ...(process.platform === "darwin"
          ? ["protected credential storage is unsupported on macOS"]
          : []),
      ],
    }),
  );
}

async function doctor(directory: string): Promise<void> {
  await status(directory);
  console.log(
    JSON.stringify({
      nextStep:
        Number(process.versions.node.split(".")[0]) < 24
          ? "Run the documented Linux bootstrap script or install Node.js 24, then rerun doctor."
          : "Run `gossip setup --endpoint <url> --audience <audience>` if configuration is pending.",
    }),
  );
}

async function setup(directory: string, args: string[]): Promise<void> {
  await prepareConnection(directory, args);
  const identity = await new WalletVault(
    directory,
    createCredentialStore(directory),
  ).identity();
  console.log(
    JSON.stringify({
      installed: true,
      connected: false,
      address: identity.address,
    }),
  );
}

async function connect(directory: string): Promise<void> {
  const { checkConnection } = await import("./bridge.js");
  const config = await loadConfiguration(directory);
  const result = await checkConnection(directory);
  await saveConfiguration(directory, { ...config, enabled: true });
  console.log(JSON.stringify({ connected: true, access: result }));
}

async function serveCommand(directory: string): Promise<void> {
  const { serve } = await import("./bridge.js");
  const config = await loadConfiguration(directory);
  if (!config.enabled)
    throw new Error("Gossip is disconnected; run connect first");
  await serve(directory);
}

async function disconnect(directory: string): Promise<void> {
  const config = await loadConfiguration(directory);
  await saveConfiguration(directory, { ...config, enabled: false });
  console.log(JSON.stringify({ disconnected: true }));
}

async function walletCommand(directory: string, args: string[]): Promise<void> {
  const vault = new WalletVault(directory, createCredentialStore(directory));
  const action = args[0];
  if (action === "attach-file") {
    const reference = validateKeyFile({
      keyFile: requiredAbsoluteOption(args, "--file"),
      format: requiredOption(args, "--format"),
    });
    const identity = await vault.attachFile(
      requiredOption(args, "--address"),
      reference,
    );
    console.log(
      JSON.stringify({
        ...identity,
        signer: "existing-key-file",
        connected: false,
      }),
    );
    return;
  }
  if (action === "create") {
    const identity = await vault.create();
    console.log(JSON.stringify({ ...identity, connected: false }));
    return;
  }
  if (action === "import") {
    const file = requiredOption(args, "--file");
    const address = requiredOption(args, "--address");
    const password = await readSecret("Keystore password: ");
    console.log(
      JSON.stringify(
        await vault.importKeystore(
          await readFile(file, "utf8"),
          password,
          getAddress(address),
        ),
      ),
    );
    return;
  }
  if (action === "backup") {
    const file = requiredOption(args, "--file");
    const password = await readSecret("Backup password: ");
    const confirmation = await readSecret("Confirm backup password: ");
    if (!password || password !== confirmation)
      throw new Error("Backup password confirmation failed");
    await writeFile(file, await vault.backup(password), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify({ backedUp: true }));
    return;
  }
  if (action === "delete") {
    const address = requiredOption(args, "--confirm-address");
    const identity = await vault.identity();
    if (getAddress(address) !== identity.address) {
      throw new Error(
        "Confirmation address does not match the configured identity",
      );
    }
    let config: Configuration | null = null;
    try {
      config = await loadConfiguration(directory);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Gossip configuration is not initialized"
      ) {
        throw error;
      }
    }
    if (config?.enabled) {
      await saveConfiguration(directory, { ...config, enabled: false });
    }
    await vault.remove();
    console.log(JSON.stringify({ deleted: true }));
    return;
  }
  throw new Error(
    "wallet requires create, attach-file, import, backup, or delete",
  );
}

async function policyCommand(directory: string, args: string[]): Promise<void> {
  const config = await loadConfiguration(directory);
  const budget = Number(requiredOption(args, "--daily-credit-budget"));
  const kind = option(args, "--allow-kind");
  const allowedKinds = [
    "token_discovery",
    "pool_discovery",
    "external_event",
    "trading_experience",
  ];
  if (
    !Number.isInteger(budget) ||
    budget < 0 ||
    budget > 1000 ||
    (kind !== undefined && !allowedKinds.includes(kind))
  )
    throw new Error(
      "policy requires a valid budget and supported --allow-kind",
    );
  const submissionKinds = kind ? [kind] : [];
  console.log(
    JSON.stringify({
      proposedPolicy: { dailyCreditBudget: budget, submissionKinds },
    }),
  );
  const confirmation = await readSecret("Type CONFIRM to apply this policy: ");
  if (confirmation !== "CONFIRM") throw new Error("Policy change cancelled");
  await saveConfiguration(directory, {
    ...config,
    policy: { dailyCreditBudget: budget, submissionKinds },
  });
  console.log(
    JSON.stringify({ policy: { dailyCreditBudget: budget, submissionKinds } }),
  );
}

function hostConfig(args: string[], directory: string): void {
  const host = parseHost(requiredOption(args, "--host"));
  const fragment = hostConfiguration(host, ...hostCommand(directory));
  console.log(JSON.stringify(fragment));
}

async function hostInstallCommand(
  args: string[],
  directory: string,
): Promise<void> {
  const host = parseHost(requiredOption(args, "--host"));
  const configPath = requiredAbsoluteOption(args, "--config");
  const result = await installHost(host, configPath, ...hostCommand(directory));
  console.log(JSON.stringify({ host, config: configPath, ...result }));
}

async function hostUninstallCommand(
  args: string[],
  directory: string,
): Promise<void> {
  const host = parseHost(requiredOption(args, "--host"));
  const configPath = requiredAbsoluteOption(args, "--config");
  const result = await uninstallHost(
    host,
    configPath,
    ...hostCommand(directory),
  );
  console.log(JSON.stringify({ host, config: configPath, ...result }));
}

async function instructionsCommand(args: string[]): Promise<void> {
  const action = args[0];
  if (action !== "install" && action !== "uninstall") {
    throw new Error("instructions requires install or uninstall");
  }
  if (args.length !== 3 || args[1] !== "--file") {
    throw new Error("instructions requires --file ABSOLUTE");
  }

  const filePath = requiredAbsoluteOption(args, "--file");
  const result =
    action === "install"
      ? await installInstructions(filePath)
      : await uninstallInstructions(filePath);
  console.log(JSON.stringify(result));
}

async function standardsCommand(directory: string): Promise<void> {
  const config = await loadConfiguration(directory);
  const report = createStandardsCapabilityReport({
    erc1271Applicable: false,
    legacyEngine: config.profile === "sherwood-eip191-personal-sign-v1",
  });
  console.log(
    JSON.stringify({
      installed: true,
      verified: false,
      profile: config.profile,
      capabilities: report,
    }),
  );
}

function hostCommand(directory: string): [string, string[]] {
  return [
    process.execPath,
    [
      resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js"),
      "serve",
      "--directory",
      directory,
    ],
  ];
}

function parseHost(value: string): SupportedHost {
  if (value === "hermes" || value === "openclaw" || value === "grok-bot")
    return value;
  throw new Error("--host must be hermes, openclaw, or grok-bot");
}

function requiredAbsoluteOption(args: string[], name: string): string {
  const value = requiredOption(args, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function printHelp(): void {
  console.log(
    "gossip status|doctor|setup-gossip|instructions|network|trade|setup|connect|serve|disconnect|wallet|policy|host-config|host-install|host-uninstall|standards [--directory ABSOLUTE]",
  );
}

function safeError(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.startsWith("Node.js 24 or newer is required.")
  )
    return error.message;
  if (!(error instanceof Error)) {
    return "Gossip command failed. Run `gossip doctor` and retry.";
  }
  if (
    error.message ===
    "Engine connection is pending because required Gossip v2 capabilities are not verified."
  ) {
    return error.message;
  }
  if (error.message === "Trade authorization requires an interactive terminal")
    return error.message;
  if (
    error.message.startsWith("Order ") ||
    error.message.startsWith("Invalid order") ||
    error.message.startsWith("Invalid trade order arguments") ||
    error.message.startsWith("trade order requires") ||
    error.message.startsWith("Invalid trade autonomy arguments") ||
    error.message.startsWith("trade autonomy requires") ||
    error.message.startsWith("Autonomy") ||
    error.message.startsWith("trade automation requires") ||
    error.message.startsWith("Automation") ||
    error.message.startsWith("Another trading worker") ||
    error.message.startsWith("Strategy") ||
    error.message.startsWith("Watcher") ||
    error.message.startsWith("Native") ||
    error.message.startsWith("ERC-20") ||
    error.message.startsWith("Input kind") ||
    error.message.startsWith("Confirmed trade permission") ||
    error.message.startsWith("Stored permission")
  )
    return error.message;
  if (
    error.message.startsWith("Instruction ") ||
    error.message.startsWith("Existing Gossip instruction") ||
    error.message.startsWith("Gossip instruction") ||
    error.message.startsWith("Refusing to modify a symlinked instruction") ||
    error.message.startsWith("Another Gossip instruction") ||
    error.message.startsWith("instructions requires")
  )
    return error.message;
  if (/configuration/i.test(error.message)) {
    return "Configuration error. Run `gossip doctor` and review the local configuration.";
  }
  if (/password|terminal/i.test(error.message))
    return "Secure password input failed. Retry locally without sharing secrets.";
  if (/wallet|identity|keystore/i.test(error.message))
    return "Wallet operation failed. Check protected storage and run `gossip doctor`.";
  if (/host|config path|--config|--host/i.test(error.message))
    return "Host configuration failed. Check the absolute `--config` path and run the host's read-only status command.";
  if (/directory/i.test(error.message))
    return "Directory argument is invalid. Use `--directory ABSOLUTE`.";
  if (/endpoint|audience|URL|profile/i.test(error.message))
    return "Setup arguments are invalid. Use HTTPS URLs without credentials or fragments and a supported profile.";
  return "Gossip command failed. Run `gossip doctor` and retry.";
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Gossip command failed",
    );
    process.exitCode = 1;
  });
