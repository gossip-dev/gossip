# Ethereum standards capabilities

`src/standards.ts` contains the read and preparation helpers used by the Gossip Agent Kit. They do not send transactions, register agents, publish metadata, or expose a generic signing operation.

## Public API

- `formatChecksumAddress` and `isChecksumAddress` implement EIP-55 display and validation using ethers' Keccak implementation. Wire protocol values remain separate from display formatting.
- `prepareErc8004Registration` validates and prepares the ERC-8004 registration-v1 document. It requires the normative `type`, `name`, `description`, `image`, `services`, and at least one `{ agentRegistry, agentId }` association. Returned agent IDs are decimal strings so the result is JSON serializable. It does not fetch or publish the document.
- `buildErc8004AgentWalletTypedData` returns only the concrete ERC-8004 `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)` proof. Its domain is `ERC8004IdentityRegistry`, version `1`, with the supplied registry as `verifyingContract`.
- `validateErc8004Association` uses an injected ethers `Provider`, expected chain ID, registry bytecode check, and read-only calls to `ownerOf` and `getAgentWallet` at one block tag. It requires the expected NFT owner and reports whether the supplied wallet matches the chain.
- `verifyErc1271Signature` performs one injected-provider `eth_call` to `isValidSignature(bytes32,bytes)`, decodes exactly `bytes4`, and accepts only the ERC-1271 magic value `0x1626ba7e`; malformed or failed RPC replies return `false`.
- `createStandardsCapabilityReport` keeps installation, runtime verification, optional/not-enabled, not-applicable, and legacy-engine-blocked states distinct.

## ERC-8128 boundary

ERC-8128 is a signed HTTP request profile built on RFC 9421 and Ethereum signatures. The primary project documentation currently presents `@slicekit/erc8128` and its `createSignerClient`/`createVerifierClient` APIs. The latest package version checked during this implementation is `0.4.1`; the root transport owner should pin `@slicekit/erc8128@0.4.1` only after verifying the target engine profile and lockfile integrity. This module intentionally does not implement or silently substitute ERC-8128 transport, because merely installing a client cannot make the legacy Sherwood verifier accept that profile.

ERC-8004 remains a Draft ERC. The typed proof and registry calls follow the current official ERC-8004 specification and should be re-verified when the supported draft revision or registry deployment changes.

## Identity-session boundary

Portable Gossip identity-session grants use the EIP-191 personal-sign profile
defined in [ADR 0007](adr/0007-v2-identity-session-authorization.md). This is an
offchain information-authority contract: it scopes Gossip tools, evidence
submission kinds, destination, time, and earned-credit cost. It cannot express
payment, trading, arbitrary signing, or transaction execution.

ERC-1271 remains the read-only contract-wallet verification standard. It is not
interchangeable with the EOA session profile because its result can depend on
chain state. ERC-7710 remains a draft smart-account execution-delegation
standard and is intentionally not used for Gossip sessions. Supporting either
as an active identity profile requires a separate version-pinned contract and
real conformance evidence.

## Capability interpretation

`installed` means client code exists; it does not mean a wallet, registry association, or runtime server path has been verified. `verified` means the relevant deterministic or read-only interoperability check passed. `optional-not-enabled` means the feature has not been selected. `blocked-legacy-engine` means the client cannot claim ERC-8128 compatibility against the current legacy server contract. An EOA may report ERC-1271 as `not-applicable`; that is not a failure.

The registry ABI and schema are pinned for this implementation to the official contracts repository revision [`b9e466c250744a7e06b13dff9d3c2844ed64f825`](https://github.com/erc-8004/erc-8004-contracts/blob/b9e466c250744a7e06b13dff9d3c2844ed64f825/ERC8004SPEC.md). The standards page remains the normative ERC source.

References: [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), [EIP-55](https://eips.ethereum.org/EIPS/eip-55), [EIP-191](https://eips.ethereum.org/EIPS/eip-191), [EIP-712](https://eips.ethereum.org/EIPS/eip-712), [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271), [ERC-7710](https://eips.ethereum.org/EIPS/eip-7710), and the [ERC-8128 project](https://erc8128.org/).

The contract integration test compiles `test/contracts/Mock1271.sol` with the pinned `solc` dev dependency and starts the pinned native Anvil binary on loopback with a random port. It uses only the documented Hardhat test mnemonic (`test test test test test test test test test test test junk`) and tears the process down after each test; it never contacts a public chain.
