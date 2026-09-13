# Attach an existing wallet file

The attach-file path deliberately reuses an existing wallet held by the user’s
host. It creates a link to the source through the local signing helper;
it does not copy the secret into the Gossip profile, send it to an engine, or
store it in Secret Service. This is deliberate reuse, not a new plaintext-key
fallback.

Use an empty absolute Gossip state directory and pass the source file only to a
trusted local subprocess:

```text
node dist/cli.js wallet attach-file \
  --file /absolute/path/to/wallet-file \
  --format json-privateKey \
  --address 0xChecksummedExpectedAddress \
  --directory /absolute/path/to/empty-gossip-state
```

The exact source format must be selected explicitly. The supported labels are
`raw-hex`, `json-privateKey`, and `json-private_key`. The tool validates the
selected file and expected EIP-55 checksum locally through the host key helper;
it must never print, log, echo, or place the secret in command output, chat,
URLs, shell history, configuration, or an engine request. Do not paste the file
contents into the agent.

The source file remains at its original path and is never deleted or rewritten.
Rerunning the command with the same source and address preserves the link. A
different address or occupied destination must stop before mutation. If the
source format or host helper is unavailable, report the missing capability and
stop; do not create another identity or fall back to plaintext storage.

This path does not move funds, change registry ownership, or establish engine
access. After attaching, configure the actual HTTPS endpoint and audience with
`gossip setup`, then run `gossip connect`. The current supported authentication
profiles are legacy Sherwood EIP-191 and `gossip-eip191-v2`; a missing endpoint leaves the identity in a
connection-pending state.

`gossip wallet delete --confirm-address ...` removes only the Gossip-side link.
It must not delete or rewrite the source key file. Backups and recovery remain
the responsibility of the source wallet’s owner tools; Gossip does not invent a
backup format for an attached source.

On Linux the source must already have owner-only permissions (0600 or stricter).
The helper refuses symlinks and does not change permissions. This does not add
encryption to a pre-existing plaintext wallet; custody and host access controls
remain the owner's responsibility. The helper runs locally and reads the selected
file in its own process. Only its signature is returned to the transport.

Validation for this path: 57 tests passed and 2 platform-specific tests were skipped on Windows. A separate Linux container without a keyring passed all 7 existing-file/CLI/helper checks, including permissions rejection. The real pinned engine accepted a proof produced by the helper and rejected tampering, replay and wrong audience. Rho's actual source wallet was not accessed during development.
