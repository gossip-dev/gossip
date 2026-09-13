import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CredentialStore {
  read(id: string): Promise<string | null>;
  write(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function credentialId(directory: string): string {
  return createHash("sha256").update(resolve(directory)).digest("hex");
}

function validateId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new Error("Invalid credential identifier");
}

class WindowsDpapiCredentialStore implements CredentialStore {
  private readonly root: string;

  constructor(directory: string) {
    this.root = join(resolve(directory), ".credentials");
  }

  async read(id: string): Promise<string | null> {
    validateId(id);
    const path = join(this.root, `${id}.dpapi`);
    try {
      const encrypted = await readFile(path, "utf8");
      return runPowerShell(
        "$inputText = [Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputText), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)",
        encrypted,
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async write(id: string, secret: string): Promise<void> {
    validateId(id);
    await mkdir(this.root, { recursive: true });
    const encrypted = await runPowerShell(
      "$inputText = [Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes = [Text.Encoding]::UTF8.GetBytes($inputText); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))",
      secret,
    );
    const path = join(this.root, `${id}.dpapi`);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, encrypted, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  async remove(id: string): Promise<void> {
    validateId(id);
    await rm(join(this.root, `${id}.dpapi`), { force: true });
  }
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; " + script,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    let hadErrorOutput = false;
    let errorCategory = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      hadErrorOutput = true;
      if (/not recognized|could not be loaded/i.test(chunk))
        errorCategory = "command-unavailable";
      else if (/convertto-securestring|convertfrom-securestring/i.test(chunk))
        errorCategory = "securestring-command";
      else if (/access|protect|crypt/i.test(chunk))
        errorCategory = "protection-failure";
      else errorCategory = "command-error";
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows protected credential operation timed out"));
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(output.trimEnd());
      else
        reject(
          new Error(
            `Windows protected credential operation failed (${hadErrorOutput ? errorCategory : "process-exit"})`,
          ),
        );
    });
    child.stdin.end(input, "utf8");
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function createCredentialStore(directory: string): CredentialStore {
  if (process.platform === "win32")
    return new WindowsDpapiCredentialStore(directory);
  if (process.platform === "linux")
    return new LinuxSecretServiceCredentialStore();
  throw new Error(
    "Protected credential storage is unsupported on this platform",
  );
}

class LinuxSecretServiceCredentialStore implements CredentialStore {
  async read(id: string): Promise<string | null> {
    validateId(id);
    const result = await runSecretTool(
      ["lookup", "service", "gossip-agent-kit", "credential-id", id],
      undefined,
      true,
    );
    return result === "" ? null : result;
  }
  async write(id: string, secret: string): Promise<void> {
    validateId(id);
    await runSecretTool(
      [
        "store",
        "--label=Gossip Agent Kit",
        "service",
        "gossip-agent-kit",
        "credential-id",
        id,
      ],
      secret,
    );
  }
  async remove(id: string): Promise<void> {
    validateId(id);
    await runSecretTool(
      ["clear", "service", "gossip-agent-kit", "credential-id", id],
      undefined,
      true,
    );
  }
}

function runSecretTool(
  args: string[],
  input?: string,
  allowMissing = false,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("secret-tool", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.on("error", () =>
      reject(new Error("Linux Secret Service is unavailable")),
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Linux Secret Service operation timed out"));
    }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      // libsecret returns 1 without output when lookup/clear finds no matching item.
      const missing = code === 1 && output === "" && errorOutput === "";
      if (code === 0 || (allowMissing && missing))
        resolveOutput(output.trimEnd());
      else reject(new Error("Linux Secret Service operation failed"));
    });
    child.stdin.end(input, "utf8");
  });
}
