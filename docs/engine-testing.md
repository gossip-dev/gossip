# Engine interoperability test

`test/engine/test-engine.ps1` verifies the public Agent Kit signing seam against
the pinned Sherwood engine. It builds the TypeScript kit, uses its real
`createSignedFetch` implementation to generate an HTTPS `/mcp` request, and
passes the captured method, body, and wallet headers to a temporary xUnit test
in an ignored Sherwood checkout. The xUnit test uses the upstream
`SherwoodWebApplicationFactory`, Testcontainers PostgreSQL, and the real
`WalletRequestAuthentication` middleware. It asserts that the request reaches
MCP with HTTP 200 and creates the wallet subscriber in PostgreSQL. It then
uses the same real middleware to reject a tampered body, a replayed nonce, and
a request signed for a different audience with HTTP 401.

The harness does not copy engine source into this repository. Prepare the
ignored checkout at `output/engine-source` at the revision below, then run:

```powershell
git -C output/engine-source checkout 47695b9bbc86658b1c420810fcb304c5ea68fb79
pwsh ./test/engine/test-engine.ps1
```

Docker must be running because the upstream PostgreSQL fixture starts a
`postgres:17` Testcontainers instance. The captured request is exchanged as a
short-lived JSON fixture; no private key or engine source is committed.

Each run creates an ephemeral wallet in memory; no user key or key fixture is
stored in the repository.

The capture now exercises the existing-file signer subprocess with an ephemeral synthetic source wallet before passing its proof to the real engine. The source is removed after capture; the transport receives a signature rather than a private key.
