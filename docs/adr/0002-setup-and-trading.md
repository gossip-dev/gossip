# Setup-gossip and explicit local trading permissions

Issue #2 extends the identity-only boundary with optional, bounded local execution. The setup skill installs and configures capabilities but grants no transaction authority. It preserves the six standards accepted in #1 and reports unverified engine/account capabilities explicitly.

A quote names the selected trading account. A separate local interactive confirmation authorizes that exact swap and gas bounds, including an exact-amount ERC-20 approval when needed. The executor reconstructs and checks calldata, verifies chain and selected account, simulates, checks fees and balances, then signs locally. Existing-file keys are read inside trusted local code without copying them into Gossip storage or exposing them to the model. This shared-host boundary does not sandbox equally privileged processes.

Persist signed transactions before broadcasting and serialize processes sharing the state directory. A retry reuses the same bytes and nonce; uncertain results do not free a trade for duplication. Recheck permission at signing time. Revocation is local and does not cancel existing transactions or allowances. One explicit trade at a time is supported; standing policies and fee replacement remain pending.

Use the official Robinhood Chain Uniswap V3 deployment inventory for SwapRouter02, QuoterV2 and the factory. Local synthetic-contract tests prove the process flow; they do not prove full Uniswap/mainnet execution compatibility. Real hosts and all inherited verifier capabilities remain release gates.
