import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Wallet, getAddress } from "ethers";
import type { CredentialStore } from "./credential-store.js";
import { credentialId } from "./credential-store.js";
import {
  existingFileSigner,
  validateKeyFile,
  verifyExistingSigner,
  type ExistingKeyFile,
} from "./external-signer.js";
import type { IdentitySigner } from "./transport.js";

type Profile = { address: string; external?: ExistingKeyFile };

export class WalletVault {
  private readonly directory: string;
  private readonly profilePath: string;
  private readonly lockPath: string;
  private readonly id: string;

  constructor(
    directory: string,
    private readonly store: CredentialStore,
  ) {
    this.directory = resolve(directory);
    this.profilePath = join(this.directory, "wallet.json");
    this.lockPath = join(this.directory, "wallet.lock");
    this.id = credentialId(this.directory);
  }

  async create(): Promise<{ address: string }> {
    return this.withLock(async () => {
      const profile = await this.readProfile();
      if (profile?.external) {
        await verifyExistingSigner(
          existingFileSigner(profile.address, profile.external),
        );
        return { address: profile.address };
      }
      const secret = await this.store.read(this.id);
      if (profile) {
        if (!secret)
          throw new Error(
            "Wallet profile exists but its protected key is missing",
          );
        const wallet = new Wallet(secret);
        if (getAddress(wallet.address) !== profile.address)
          throw new Error("Wallet profile does not match its protected key");
        return profile;
      }
      if (secret) {
        const wallet = new Wallet(secret);
        const recovered = { address: getAddress(wallet.address) };
        await this.writeProfile(recovered);
        return recovered;
      }
      const wallet = Wallet.createRandom();
      await this.store.write(this.id, wallet.privateKey);
      try {
        const profile = { address: getAddress(wallet.address) };
        await this.writeProfile(profile);
        return profile;
      } catch (error) {
        await this.store.remove(this.id);
        throw error;
      }
    });
  }

  async identity(): Promise<{ address: string; signer?: "existing-key-file" }> {
    const profile = await this.readProfile();
    if (!profile) throw new Error("Gossip identity wallet is not configured");
    if (profile.external)
      return { address: profile.address, signer: "existing-key-file" };
    const secret = await this.store.read(this.id);
    if (!secret)
      throw new Error("Wallet profile exists but its protected key is missing");
    if (getAddress(new Wallet(secret).address) !== profile.address)
      throw new Error("Wallet profile does not match its protected key");
    return profile;
  }

  async signer(): Promise<IdentitySigner> {
    const profile = await this.readProfile();
    if (!profile) throw new Error("Gossip identity wallet is not configured");
    if (profile.external)
      return existingFileSigner(profile.address, profile.external);
    const secret = await this.store.read(this.id);
    if (!secret)
      throw new Error("Wallet profile exists but its protected key is missing");
    const wallet = new Wallet(secret);
    if (getAddress(wallet.address) !== profile.address)
      throw new Error("Wallet profile does not match its protected key");
    return wallet;
  }

  async importKeystore(
    json: string,
    password: string,
    expectedAddress: string,
  ): Promise<{ address: string }> {
    const address = getAddress(expectedAddress);
    const imported = await Wallet.fromEncryptedJson(json, password);
    if (getAddress(imported.address) !== address)
      throw new Error(
        "Imported keystore address does not match expected address",
      );
    return this.withLock(async () => {
      const existing = await this.readProfile();
      if (existing) {
        if (existing.external)
          throw new Error(
            "An external wallet is attached; importing over it is not supported",
          );
        if (existing.address !== address)
          throw new Error("A different wallet identity already exists");
        const current = await this.store.read(this.id);
        if (!current || getAddress(new Wallet(current).address) !== address)
          throw new Error("Wallet identity conflict");
        return existing;
      }
      if (await this.store.read(this.id))
        throw new Error("Protected wallet key exists without a profile");
      await this.store.write(this.id, imported.privateKey);
      try {
        const profile = { address };
        await this.writeProfile(profile);
        return profile;
      } catch (error) {
        await this.store.remove(this.id);
        throw error;
      }
    });
  }

  async transactionSigner(): Promise<Wallet> {
    const profile = await this.readProfile();
    if (!profile) throw new Error("Gossip identity wallet is not configured");
    if (profile.external) {
      const { loadLocalWallet } = await import("./local-file-signer.js");
      return loadLocalWallet({ ...profile.external, address: profile.address });
    }
    const signer = await this.signer();
    if (!(signer instanceof Wallet))
      throw new Error("Transaction signing is unsupported for this wallet");
    return signer;
  }

  async backup(password: string): Promise<string> {
    const signer = await this.signer();
    if (!(signer instanceof Wallet))
      throw new Error(
        "Back up the existing wallet using its owner tools; Gossip does not export its key",
      );
    return signer.encrypt(password);
  }

  async attachFile(
    address: string,
    reference: ExistingKeyFile,
  ): Promise<{ address: string }> {
    const profile: Profile = {
      address: getAddress(address),
      external: validateKeyFile(reference),
    };
    return this.withLock(async () => {
      const previous = await this.readProfile();
      if (previous && JSON.stringify(previous) !== JSON.stringify(profile))
        throw new Error("A different wallet identity or signer already exists");
      if (
        !previous &&
        (await readdir(this.directory)).some((name) => name !== "wallet.lock")
      )
        throw new Error(
          "Use an empty dedicated directory to attach an existing wallet",
        );
      await verifyExistingSigner(
        existingFileSigner(profile.address, profile.external!),
      );
      if (!previous) await this.writeProfile(profile);
      return { address: profile.address };
    });
  }

  async remove(): Promise<void> {
    await this.withLock(async () => {
      const profile = await this.readProfile();
      if (!profile?.external) await this.store.remove(this.id);
      await rm(this.profilePath, { force: true });
    });
  }

  private async readProfile(): Promise<Profile | null> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.profilePath, "utf8"),
      );
      if (!isProfile(parsed)) throw new Error("Wallet profile is invalid");
      return {
        address: getAddress(parsed.address),
        ...("external" in parsed
          ? { external: validateKeyFile(parsed.external) }
          : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async writeProfile(profile: Profile): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.profilePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(profile)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.profilePath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "Another wallet operation is in progress or a stale wallet.lock remains; confirm no wallet process is active before removing it",
        );
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await rm(this.lockPath, { force: true });
    }
  }
}

function isProfile(value: unknown): value is Profile {
  return (
    typeof value === "object" &&
    value !== null &&
    "address" in value &&
    typeof value.address === "string"
  );
}
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
