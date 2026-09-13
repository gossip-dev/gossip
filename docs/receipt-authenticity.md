# Receipt authenticity contract

`src/receipt-auth.ts` is the portable verifier for signed
`gossip.receipt.v2` envelopes. It requires the caller to provide an
operator-pinned trust manifest. The verifier does not fetch, discover, or
learn keys from receipts.

The supported profile is `gossip-eip191-receipt-v1`. The signed message is
exactly:

```text
Gossip receipt v1
gossip/2-draft.1
<receipt_digest>
```

The signature is unpadded base64url encoding of 65 bytes in `r || s || v`
order. The recovery byte is 27 or 28. `s` must be low-S. The manifest pins the
server ID, profile, key ID, uncompressed public key, lowercase Ethereum
address, issue-time validity interval, and key status. The public key must
derive the pinned address.

```ts
const verified = verifySignedReceipt(envelope, trustManifest);
const chain = verifyReceiptTransitionChainAuthenticity(envelopes, trustManifest);
const bound = verifyConsultationReceiptAuthenticity(
  envelope,
  trustManifest,
  consultation,
);
```

Both functions run structural receipt parsing first. The chain verifier also
requires one signer key for the acknowledgment and every later state receipt.
Rotation starts a new operation chain. A retired key remains usable for
receipts issued inside its retained validity interval; a revoked key is never
accepted. Since this offline contract has no operation registry or signed
rotation event, it cannot distinguish a newly created acknowledgment signed by
a retired key before that interval ends from an old acknowledgment. Server
policy must enforce that stronger new-operations-only rule.

Use the consultation-bound functions at an agent boundary. They verify the
request digest, operation ID, actor, endpoint, audience, quality, maximum cost,
and acceptance deadline in addition to origin authenticity. The shorter
functions verify signature provenance only.

The package intentionally exposes protocol modules as generated `dist/*.js`
subpaths until the draft API is frozen. Run `npm run test:receipt-auth` for the
focused authenticity suite.

`parseSignedReceipt` remains structural by design and accepts the prior
nonempty canonical base64url signature field. Callers that need authenticity
must supply the manifest and use this module. The test vector in
`test/fixtures/v2-receipt-auth.json` uses a deterministic synthetic key and a
reserved `.test` endpoint; it is not a production trust anchor.
