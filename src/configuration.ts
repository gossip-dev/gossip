import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { policySchema } from "./schemas.js";

export interface Configuration {
  schemaVersion: 1;
  endpoint: string;
  audience: string;
  profile: "sherwood-eip191-personal-sign-v1" | "gossip-eip191-v2" | "erc8128";
  chainId: 4663;
  enabled: boolean;
  policy: { dailyCreditBudget: number; submissionKinds: string[] };
}

const configurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    endpoint: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:"),
    audience: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:"),
    profile: z.enum([
      "sherwood-eip191-personal-sign-v1",
      "gossip-eip191-v2",
      "erc8128",
    ]),
    chainId: z.literal(4663),
    enabled: z.boolean(),
    policy: policySchema,
  })
  .strict();

const configPath = (directory: string) => join(directory, "config.yaml");

export async function loadConfiguration(
  directory: string,
): Promise<Configuration> {
  try {
    const value: unknown = parse(await readFile(configPath(directory), "utf8"));
    return configurationSchema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Gossip configuration is not initialized");
    if (error instanceof z.ZodError)
      throw new Error("Gossip configuration is invalid");
    throw new Error("Gossip configuration could not be read");
  }
}

export async function saveConfiguration(
  directory: string,
  config: Configuration,
): Promise<void> {
  const validated = configurationSchema.parse(config);
  await mkdir(dirname(configPath(directory)), { recursive: true, mode: 0o700 });
  const path = configPath(directory);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, stringify(validated), {
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
