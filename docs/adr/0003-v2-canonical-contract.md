# Gossip v2 canonical contract candidate

Status: implementation candidate for WS1 of [epic #3](../epics/gossip-protocol-v2.md).
This records the first executable contract. It is not a server capability,
deployed protocol, final schema freeze, or authorization to spend credit.

## Decision

Use the exact revision `gossip/2-draft.1`, schema revision `2026-09-09`, and
the proposed authentication profile `gossip-eip191-v2`. Pin MCP `2025-11-25`
for conformance with the current kit dependency. This intentionally pins a
revision rather than tracking the newest MCP release. A later revision requires
explicit negotiation and new conformance evidence.

Keep the four v1 tools and the `Sherwood request v1` signature message and
`X-Sherwood-*` headers unchanged. No v2 request is sent through that profile.
Installing these modules does not register a tool or enable a signing profile.

## Canonical bytes

The candidate uses the JSON Canonicalization Scheme's string escaping and
UTF-16 property ordering, with a narrower numeric domain: JSON numbers must be
safe integers, with negative zero rejected. Large quantities, block heights,
chain identifiers, and credit amounts use decimal strings. Fractional domain
quantities will require an explicit decimal-string schema, never a float.

Preserve Unicode exactly, including composed versus decomposed characters.
Reject lone surrogates, unsupported JavaScript values, sparse arrays, accessor
properties, non-plain objects, and cycles. These are validation failures rather
than values that JSON serialization may silently omit or transform.

Limits apply before hashing: 65,536 UTF-8 bytes, depth 16 (root depth zero),
256 elements per array, 64 members per object, and 4,096 total value nodes.
Keys and string values each consume the same byte budget. Local encoders reject
inputs that would exceed it before assembling an unbounded output.

The decoder accepts only canonical UTF-8 JSON bytes. It checks the byte limit
before parsing, validates the value, then compares its canonical serialization
with the original bytes. This rejects duplicate members, whitespace, alternate
numeric spellings, BOMs, invalid UTF-8, and alternative string escapes. For MCP,
this rule applies to the protocol envelope's canonical representation; the
outer JSON-RPC framing is not required to be canonical. A future server adapter
must reject duplicate members in raw framing before an SDK discards them.

Digest input is UTF-8 of `gossip/2-draft.1`, one LF, an allowed domain, one LF,
then the canonical payload. Allowed domains are `request`, `evidence`, and
`receipt`. Output is `sha256:` plus 64 lowercase hexadecimal characters.
This primitive proves content integrity only; authentication, truth, ownership,
and server acceptance are separate checks.

## Consultation envelope

All fields are required and unknown fields are rejected:

| Field | Candidate rule |
| --- | --- |
| `protocol` | `gossip/2-draft.1` |
| `schema_revision` | `2026-09-09` |
| `auth_profile` | `gossip-eip191-v2` |
| `operation_id` | 1–64 ASCII letters, digits, underscore or hyphen |
| `actor` | `{chain_id, address}`; the authenticating Ethereum identity |
| `subject` | `{kind, chain_id, address}`; kind `token` or `wallet` |
| `capability` | `token_overview` or `wallet_overview`, matching subject kind |
| `endpoint`, `audience` | Exact canonical HTTPS URLs selected by the user |
| `quality` | `{tier, max_age_seconds, finality, allow_partial}` |
| `max_cost` | `{unit: "earned_credit", amount}` |
| `deadline` | Unix seconds, integer from 0 through 253402300799 |

Addresses are lowercase `0x` plus 40 hex digits in the protocol, with no silent
normalization. User-facing checksummed display remains separate. Chain IDs are
positive decimal uint256 strings; credit amounts are nonnegative decimal
uint256 strings. No plus sign or leading zero is permitted except `"0"`.

Quality tiers are `standard` and `enriched`. Standard must request zero maximum
cost. Finality is `latest`, `safe`, or `finalized`; maximum age is an integer
from 0 through 86,400 seconds. Partial permission is explicit. Freshness measures
the underlying source facts; a new retrieval timestamp cannot refresh old data.

URLs must equal their WHATWG serialized HTTPS form and contain no credentials,
fragment, literal whitespace, or controls. Exact paths and query strings remain
bound; redirects cannot change the signing destination. An absent root path is
not canonical: use `https://example.test/` instead of `https://example.test`.

The request digest binds every field, including actor, subject, endpoint,
audience, operation ID, quality, cost, and deadline. A fresh authentication nonce
on retry is outside the logical envelope; changing an envelope field changes
the digest. A semantic deadline check rejects `deadline <= now`. Schema
validation and hashing do not establish signer ownership or reserve credit.

## Discovery and negotiation

An untrusted capability report names protocol/schema/auth revisions, MCP
revision, server ID/revision, endpoint, audience, issue/expiry times, limits,
and per-feature readiness. Features are `atomic_consult`, `durable_operations`,
`signed_receipts`, `evidence`, `session_keys`, `public_submission`,
`private_submission`, `http`, and `tasks`. States are `installed`, `verified`,
`not_applicable`, and `blocked`.
Every non-verified entry has a reason and an actionable next step. A verified
entry names its conformance evidence revision. Duplicate features are invalid.

Negotiation compares the report to the caller's independently configured
endpoint, audience, and exact MCP/profile pins. It checks freshness (at most
one hour report lifetime), exact supported protocol/schema revisions, and
requires all four core features to report `verified`. Unknown or absent features
never imply support. Optional blocked features cannot block core selection.

The selected limits cannot exceed local ceilings. Negotiation is a pure
compatibility decision about a supplied report, not evidence that the report
is authentic or its claims are true. A future transport must authenticate the
server and bind this selection to a verified connection before using it.
It must still enforce permissions and verify signed acknowledgments/receipts.

The report fields are `protocols`, `schema_revisions`, `auth_profiles`,
`mcp_revision`, `server: {id, revision}`, `endpoint`, `audience`, `issued_at`,
`expires_at`, `limits`, and `features`. Revision arrays contain 1–16 unique
identifiers. Each identifier, including server and evidence revisions, is
1–128 ASCII characters matching `[a-zA-Z0-9][a-zA-Z0-9._/-]*`. Features contain
at most eight entries. Reasons and next actions contain 1–256 characters;
URLs contain at most 2,048. Only `verified` has `evidence_revision`, and it has
no blocker fields. Every other state has both blocker fields and no evidence
revision. All objects reject unknown fields.

Limits are positive integers named `max_request_bytes`, `max_depth`, and
`max_collection_items`, capped at 65,536, 16, and 256 respectively. Smaller
server limits are retained. Times use the same Unix-second range as deadlines.
Capability reports remain valid while `now < expires_at`, with up to one second
of issuance grace for the whole-second precision of a trusted HTTP `Date`
header. Reports more than one second ahead of `now` are rejected. Their declared
interval must still satisfy `0 < expires_at - issued_at <= 3600`.

Successful negotiation returns `protocol`, `schema_revision`, `auth_profile`,
`mcp_revision`, `endpoint`, `audience`, `server`, `expires_at`, and `limits`.
It returns no connection or authorization flag. Query construction must still
check the negotiated limits and the current connection before sending work.

## Errors and acceptance

Local boundary failures use stable codes and fixed, non-sensitive messages.
Never interpolate rejected claims, source URLs, identities, signatures, or
credentials into errors. Validation errors do not imply durable acceptance.
The candidate taxonomy also reserves operation, quality, authorization, and
reconciliation failures for later server work; a code alone never releases a
reservation or authorizes a new logical operation.

The accepted test seam is canonical vectors and public protocol boundaries,
as specified in epic #3. Tests cover ordering, Unicode, numeric restrictions,
invalid encodings, limits, domain separation, tampered request fields, deadline
boundaries, unsupported profiles, and capability downgrade. Literal golden
digests are checked independently in Python; expected values must not be
computed using the TypeScript implementation under test.

Sherwood must execute the same vectors before schema freeze. Real verifier,
database, concurrency, receipt, host, and release acceptance remain subsequent
gates; passing this module's tests does not satisfy them.

## Sources

- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785): canonical string escaping,
  UTF-16 sorting, Unicode preservation. This profile restricts its number set.
- [ERC-191](https://eips.ethereum.org/EIPS/eip-191): existing personal-sign
  primitive; the proposed v2 application message still requires server work.
- [MCP lifecycle, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle):
  explicit version and capability negotiation.
- [MCP tools, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools):
  structured content and output-schema integration for the later adapter.
