import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { isSupportedGossipSigningMessage } from "./local-file-signer.js";
import type { IdentitySigner } from "./transport.js";

export type ExistingKeyFile = {
  keyFile: string;
  format: "raw-hex" | "json-privateKey" | "json-private_key";
};

export function validateKeyFile(value: unknown): ExistingKeyFile {
  if (!value || typeof value !== "object")
    throw new Error("Invalid external wallet reference");
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.keyFile !== "string" ||
    !isAbsolute(entry.keyFile) ||
    !["raw-hex", "json-privateKey", "json-private_key"].includes(
      String(entry.format),
    )
  ) {
    throw new Error(
      "Existing wallet requires an absolute file path and an explicit supported format",
    );
  }
  return {
    keyFile: entry.keyFile,
    format: entry.format as ExistingKeyFile["format"],
  };
}

export function existingFileSigner(
  address: string,
  reference: ExistingKeyFile,
): IdentitySigner {
  const expectedAddress = getAddress(address);
  const source = validateKeyFile(reference);
  return {
    address: expectedAddress,
    async signMessage(message) {
      if (!isSupportedGossipSigningMessage(message)) {
        throw new Error(
          "External wallet received an unsupported Gossip signing message",
        );
      }
      const helper = fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./local-file-signer.ts"
            : "./local-file-signer.js",
          import.meta.url,
        ),
      );
      const signature = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            helper,
            "--key-file",
            source.keyFile,
            "--format",
            source.format,
            "--address",
            expectedAddress,
          ],
          { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
        );
        let output = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Existing wallet signer timed out"));
        }, 15_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.length > 4096) {
            child.kill();
            reject(new Error("Invalid existing wallet signer response"));
          }
        });
        child.stdin.on("error", () =>
          reject(new Error("Existing wallet signer input failed")),
        );
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Existing wallet signer could not start"));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          try {
            if (code !== 0) throw new Error();
            const response = JSON.parse(output) as { signature?: unknown };
            if (
              typeof response.signature !== "string" ||
              !/^0x[0-9a-fA-F]{130}$/.test(response.signature)
            )
              throw new Error();
            resolve(response.signature);
          } catch {
            reject(
              new Error(
                "Existing wallet signing failed; check file format, permissions and selected address",
              ),
            );
          }
        });
        child.stdin.end(JSON.stringify({ version: 1, message }));
      });
      if (getAddress(verifyMessage(message, signature)) !== expectedAddress)
        throw new Error("Existing wallet address mismatch");
      return signature;
    },
  };
}

export async function verifyExistingSigner(
  signer: IdentitySigner,
): Promise<void> {
  await signer.signMessage(
    `Gossip signer verification v1\n${signer.address}\n${randomUUID()}`,
  );
}
