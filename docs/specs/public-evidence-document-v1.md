# Public evidence document v1

`gossip.public-evidence-document.v1` is the portable response for retrieving one
public evidence payload by its exact content digest. This kit parses and
verifies the document without hosting a route. Sherwood separately exposes
root-authenticated HTTP and MCP lookup backed by durable public storage.

The top-level object is exact and contains only:

```json
{
  "protocol": "gossip/2-draft.1",
  "schema_revision": "2026-09-11",
  "schema": "gossip.public-evidence-document.v1",
  "digest": "sha256:…",
  "evidence": { "schema": "gossip.evidence.v1" },
  "links": []
}
```

`digest` must equal the `evidence` payload's `gossip/2-draft.1` evidence
digest. The embedded payload is parsed with the existing v2 evidence contract,
and this document further requires public access and public source locations.
No owner-private node, source, or reference is represented by this contract.

`links` contains at most 256 exact objects with these fields:

```json
{
  "child_digest": "sha256:…",
  "relationship": "derived_from",
  "parent_digest": "sha256:…",
  "correction_reason": null
}
```

The relationship is `derived_from`, `supersedes`, or `conflicts_with`. A
`correction_reason` is required and bounded for `supersedes`; it must be null
for the other relationships. Links are unique and sorted strictly by
`(child_digest, relationship, parent_digest)`. Every link must mention the
requested digest as either child or parent. Outgoing links for the requested
payload must match the corresponding evidence references; incoming links may
point to the requested public digest from another public document. The
outgoing links whose child is the requested digest must exactly cover every
reference in its `derived_from`, `supersedes`, and `conflicts_with` fields.

The TypeScript parser is `parsePublicEvidenceDocument` in
`src/public-evidence-document-v1.ts`. The literal vector is
`test/fixtures/v2-public-evidence-document.json`, and the independent Python
check runs with `npm run verify:public-evidence-document-v2`.

The `.12` Sherwood process gate requires the server to resolve external public
targets and their same-subject relationship before returning them and to keep
the HTTP and MCP response byte-identical for one digest. This does not activate
private submission, feedback, trading, or transaction execution.
