import { WalletVault } from "./wallet.js";
import { createCredentialStore } from "./credential-store.js";
import {
  loadConfiguration,
  saveConfiguration,
  type Configuration,
} from "./configuration.js";
const profiles = [
  "sherwood-eip191-personal-sign-v1",
  "gossip-eip191-v2",
  "erc8128",
] as const;
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
export async function prepareConnection(
  directory: string,
  args: string[],
): Promise<void> {
  const endpoint = option(args, "--endpoint");
  const audience = option(args, "--audience");
  const requestedProfile =
    option(args, "--profile") ?? "sherwood-eip191-personal-sign-v1";
  if (!endpoint || !audience || !isProfile(requestedProfile)) {
    throw new Error(
      "setup requires --endpoint, --audience, and a supported --profile",
    );
  }
  let config: Configuration | null = null;
  try {
    config = await loadConfiguration(directory);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Gossip configuration is not initialized"
    )
      throw error;
  }
  if (!isSafeHttpsUrl(endpoint) || !isSafeHttpsUrl(audience)) {
    throw new Error("setup requires valid HTTPS endpoint and audience URLs");
  }
  if (
    config &&
    (config.endpoint !== endpoint ||
      config.audience !== audience ||
      config.profile !== requestedProfile)
  )
    throw new Error(
      "Existing Gossip configuration conflicts; refusing to overwrite it",
    );
  await new WalletVault(directory, createCredentialStore(directory)).create();
  const selected = await new WalletVault(
    directory,
    createCredentialStore(directory),
  ).identity();
  if (
    selected.signer === "existing-key-file" &&
    requestedProfile !== "sherwood-eip191-personal-sign-v1" &&
    requestedProfile !== "gossip-eip191-v2"
  ) {
    throw new Error(
      "Existing-file wallet supports only EIP-191 signing profiles",
    );
  }
  await saveConfiguration(
    directory,
    config ?? {
      schemaVersion: 1,
      endpoint,
      audience,
      profile: requestedProfile,
      chainId: 4663,
      enabled: false,
      policy: { dailyCreditBudget: 0, submissionKinds: [] },
    },
  );
}
function isProfile(value: string): value is Configuration["profile"] {
  return profiles.includes(value as (typeof profiles)[number]);
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
