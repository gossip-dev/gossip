import {
  getAddress,
  Interface,
  isAddress,
  type Provider,
  type TypedDataDomain,
} from "ethers";

export const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ERC8004_REGISTRATION_TYPE =
  "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
const ERC8004_IDENTITY_INTERFACE = new Interface([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);
const ERC1271_INTERFACE = new Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const UINT256_MAX = (1n << 256n) - 1n;

function uint256(value: bigint, name: string): bigint {
  if (value < 0n || value > UINT256_MAX)
    throw new Error(`${name} must be a uint256`);
  return value;
}

export function formatChecksumAddress(address: string): string {
  if (!isAddress(address)) throw new Error("Invalid Ethereum address");
  return getAddress(address);
}

export function isChecksumAddress(address: string): boolean {
  return isAddress(address) && getAddress(address) === address;
}

export interface Erc8004Service {
  name: string;
  endpoint: string;
  version?: string;
  skills?: string[];
  domains?: string[];
}

export interface Erc8004RegistrationInput {
  name: string;
  description: string;
  image: string;
  services: Erc8004Service[];
  registrations: Array<{ agentRegistry: string; agentId: bigint }>;
  x402Support?: boolean;
  active?: boolean;
  supportedTrust?: string[];
}

export interface Erc8004Registration
  extends Omit<Erc8004RegistrationInput, "registrations"> {
  readonly type: typeof ERC8004_REGISTRATION_TYPE;
  registrations: Array<{ agentRegistry: string; agentId: string }>;
}

export function prepareErc8004Registration(
  input: Erc8004RegistrationInput,
): Erc8004Registration {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid ERC-8004 registration");
  if (!input.name.trim() || !input.description.trim() || !input.image.trim()) {
    throw new Error(
      "ERC-8004 registration requires name, description, and image",
    );
  }
  if (
    !Array.isArray(input.services) ||
    input.services.some(
      (service) => !service.name.trim() || !service.endpoint.trim(),
    )
  ) {
    throw new Error("ERC-8004 services require a name and endpoint");
  }
  if (!Array.isArray(input.registrations) || input.registrations.length === 0) {
    throw new Error("ERC-8004 registration requires an identity registration");
  }
  for (const registration of input.registrations) {
    if (
      !/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(registration.agentRegistry) ||
      registration.agentId < 0n
    ) {
      throw new Error("Invalid ERC-8004 agent registration");
    }
  }
  const registration: Erc8004Registration = {
    type: ERC8004_REGISTRATION_TYPE,
    name: input.name,
    description: input.description,
    image: input.image,
    services: input.services.map((service) => ({
      name: service.name,
      endpoint: service.endpoint,
      ...(service.version === undefined ? {} : { version: service.version }),
      ...(service.skills === undefined ? {} : { skills: [...service.skills] }),
      ...(service.domains === undefined
        ? {}
        : { domains: [...service.domains] }),
    })),
    registrations: input.registrations.map((item) => ({
      agentRegistry: item.agentRegistry,
      agentId: item.agentId.toString(),
    })),
  };
  if (input.x402Support !== undefined)
    registration.x402Support = input.x402Support;
  if (input.active !== undefined) registration.active = input.active;
  if (input.supportedTrust !== undefined)
    registration.supportedTrust = [...input.supportedTrust];
  return registration;
}

export interface Erc8004AgentWalletProof {
  domain: TypedDataDomain;
  types: {
    AgentWalletSet: Array<{ name: string; type: string }>;
  };
  primaryType: "AgentWalletSet";
  message: {
    agentId: bigint;
    newWallet: string;
    owner: string;
    deadline: bigint;
  };
}

export function buildErc8004AgentWalletTypedData(input: {
  chainId: bigint | number;
  registry: string;
  agentId: bigint;
  newWallet: string;
  owner: string;
  deadline: bigint;
}): Erc8004AgentWalletProof {
  const chainId = BigInt(input.chainId);
  if (chainId <= 0n) throw new Error("ERC-8004 chainId must be positive");
  uint256(chainId, "chainId");
  uint256(input.agentId, "agentId");
  uint256(input.deadline, "deadline");
  return {
    domain: {
      name: "ERC8004IdentityRegistry",
      version: "1",
      chainId,
      verifyingContract: formatChecksumAddress(input.registry),
    },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: {
      agentId: input.agentId,
      newWallet: formatChecksumAddress(input.newWallet),
      owner: formatChecksumAddress(input.owner),
      deadline: input.deadline,
    },
  };
}

export interface Erc8004AssociationResult {
  verified: boolean;
  owner?: string;
  agentWallet?: string;
  reason?: string;
}

export async function validateErc8004Association(input: {
  provider: Provider;
  registry: string;
  agentId: bigint;
  wallet: string;
  expectedOwner: string;
  expectedChainId: bigint | number;
  blockTag?: number | string;
}): Promise<Erc8004AssociationResult> {
  const expectedChainId = BigInt(input.expectedChainId);
  if (expectedChainId <= 0n)
    return { verified: false, reason: "Expected chain ID must be positive" };
  uint256(input.agentId, "agentId");
  const registry = formatChecksumAddress(input.registry);
  const wallet = formatChecksumAddress(input.wallet);
  try {
    const network = await input.provider.getNetwork();
    if (network.chainId !== expectedChainId)
      return { verified: false, reason: "Registry is on the wrong chain" };
    const blockTag = input.blockTag ?? (await input.provider.getBlockNumber());
    const code = await input.provider.getCode(registry, blockTag);
    if (code === "0x")
      return { verified: false, reason: "Registry has no contract code" };
    const rpcBlockTag =
      typeof blockTag === "number" ? `0x${blockTag.toString(16)}` : blockTag;
    const call = (data: string) =>
      (
        input.provider as Provider & {
          send(method: string, params: unknown[]): Promise<string>;
        }
      ).send("eth_call", [{ to: registry, data }, rpcBlockTag]);
    const ownerResult = await call(
      ERC8004_IDENTITY_INTERFACE.encodeFunctionData("ownerOf", [input.agentId]),
    );
    const walletResult = await call(
      ERC8004_IDENTITY_INTERFACE.encodeFunctionData("getAgentWallet", [
        input.agentId,
      ]),
    );
    const owner = getAddress(
      ERC8004_IDENTITY_INTERFACE.decodeFunctionResult(
        "ownerOf",
        ownerResult,
      )[0],
    );
    const agentWallet = getAddress(
      ERC8004_IDENTITY_INTERFACE.decodeFunctionResult(
        "getAgentWallet",
        walletResult,
      )[0],
    );
    const expectedOwner = formatChecksumAddress(input.expectedOwner);
    const verified = agentWallet === wallet && owner === expectedOwner;
    return verified
      ? { verified, owner, agentWallet }
      : {
          verified,
          owner,
          agentWallet,
          reason: "On-chain owner or agentWallet does not match",
        };
  } catch {
    return {
      verified: false,
      reason: "ERC-8004 identity registry read failed",
    };
  }
}

export async function verifyErc1271Signature(
  provider: Provider,
  wallet: string,
  digest: string,
  signature: string,
): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest))
    throw new Error("ERC-1271 digest must be bytes32");
  let result: string;
  try {
    result = await provider.call({
      to: formatChecksumAddress(wallet),
      data: ERC1271_INTERFACE.encodeFunctionData("isValidSignature", [
        digest,
        signature,
      ]),
    });
  } catch {
    return false;
  }
  try {
    const decoded = ERC1271_INTERFACE.decodeFunctionResult(
      "isValidSignature",
      result,
    )[0] as string;
    return decoded.toLowerCase() === ERC1271_MAGIC_VALUE;
  } catch {
    return false;
  }
}

export type CapabilityStatus =
  | "installed"
  | "verified"
  | "optional-not-enabled"
  | "blocked-legacy-engine"
  | "not-applicable";
export interface CapabilityReportEntry {
  standard: string;
  status: CapabilityStatus;
  detail: string;
}

export function createStandardsCapabilityReport(
  input: {
    erc8128Verified?: boolean;
    erc8004Enabled?: boolean;
    erc8004Verified?: boolean;
    erc1271Applicable?: boolean;
    erc1271Verified?: boolean;
    legacyEngine?: boolean;
  } = {},
): CapabilityReportEntry[] {
  return [
    {
      standard: "EIP-55",
      status: "verified",
      detail: "Address formatting and validation are available locally",
    },
    {
      standard: "ERC-8004",
      status: input.erc8004Verified
        ? "verified"
        : input.erc8004Enabled
          ? "installed"
          : "optional-not-enabled",
      detail: "Registration metadata and read-only association checks",
    },
    {
      standard: "EIP-191",
      status: "installed",
      detail:
        "Legacy personal-sign transport remains owned by the engine transport",
    },
    {
      standard: "EIP-712 ERC-8004 AgentWalletSet",
      status: "installed",
      detail:
        "Concrete typed proof preparation is available; signing verification is pending",
    },
    {
      standard: "ERC-1271",
      status:
        input.erc1271Applicable === false
          ? "not-applicable"
          : input.erc1271Verified
            ? "verified"
            : "installed",
      detail: "Read-only isValidSignature verification",
    },
    {
      standard: "ERC-8128",
      status: input.erc8128Verified
        ? "verified"
        : input.legacyEngine
          ? "blocked-legacy-engine"
          : "installed",
      detail: "Transport integration requires a compatible server profile",
    },
  ];
}
