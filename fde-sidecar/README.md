# FDE aggregate-only Harness sidecar P1 seam

This is a fixed-commit, keyless vertical slice over the official built JSON-RPC runtime. It is a lab prototype, not an FDE deployment.

## Input protocol

The CLI accepts newline-delimited JSON. Every line must contain exactly one `fde.aggregate-review.v1` document. Unknown keys fail before the runtime starts; free-form customer, person, material, order, price, raw-row, attachment, path, URL, or instruction fields have no place in the schema.

```json
{
  "schema": "fde.aggregate-review.v1",
  "reviewId": "REV-FICTION-0001",
  "projectRef": "PRJ-FICTION-ALPHA",
  "aggregate": {
    "assetRegistry": { "registered": 12, "ingested": 5, "installableSystems": 3 },
    "quality": { "passed": 8, "total": 9 },
    "workbench": { "screens": 4, "saveConnected": true },
    "blockers": [{ "code": "DEMO_METADATA_GAP", "count": 2 }]
  },
  "privacy": {
    "aggregateOnly": true,
    "rawRowsIncluded": false,
    "identifiersTokenized": true,
    "sensitiveFieldsRemoved": true
  }
}
```

The caller starts one process per FDE project and sends lines serially:

```sh
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 22.22.0
node fde-sidecar/sidecar.mjs \
  --project-ref PRJ-FICTION-ALPHA \
  --session-root /absolute/private/session-root \
  < fde-sidecar/fixtures/aggregate-review.jsonl
```

## Output protocol

Each accepted line returns `{ "ok": true, "receipt": FdeSidecarReceipt }`. A rejected line returns `{ "ok": false, "error": { "code", "message" } }`, then the CLI closes the runtime and exits non-zero.

The receipt keeps three meanings separate:

- `messageId` proves durable admission to the Harness inbox.
- `outcome.turn/reason` is accepted only when the observed interval contains exactly one matching receipt, one user message, one `turn/start`, one assistant message, one completed `turn/end`, zero tool events, then `idle`.
- `authority: advisory-only` means the suggestion has no FDE Draft/save/compiler/assemble authority.

The adapter rejects concurrent work on the same Session with `SESSION_BUSY`. It does not pretend that upstream JSON-RPC has a per-prompt causal result. A timeout or ambiguous interval closes the entire runtime because the upstream protocol has no prompt cancel.

## Isolation actually exercised

- Official built runtime: `packages/examples/jsonrpc-demo/lib/bin.js` at upstream commit `47f943859bef60e4160492346772ded9b24f765a`.
- Official stdio JSON-RPC methods: `initialize`, `session/prompt`, `shutdown`; notifications remain upstream `session.event` and `session.status`.
- One sidecar owns one `HarnessClient`, which owns one runtime child. An exclusive project-root lock rejects a second active sidecar.
- The project marker prevents reuse of one Session root by another project token or upstream commit.
- Cordis composition contains no filesystem, shell, subprocess, terminal, MCP, subagent, workflow, web, telemetry, live LLM adapter, or model-facing tool.
- macOS Seatbelt denies all runtime network operations and denies file writes outside the independent Session root. JSONL Session persistence is the only configured writer; the OS policy deliberately permits writes anywhere below that one private root.
- The child environment is replaced, not inherited; no API key or FDE workspace path enters the runtime.

`llm-replay` is test infrastructure. It proves the assembled loop, JSON-RPC framing, event correlation and containment without a network request; it does not prove a cloud model's quality.

## Exact verification

From a fresh clone of the fork, check out the experiment branch based on the fixed upstream commit. The build creates ignored `lib/` artifacts required by the sidecar; they are not part of this branch. Do not substitute `npx` for the repository-pinned package manager.

```sh
git fetch origin lab/fde-aggregate-sidecar-p1
git checkout --detach origin/lab/fde-aggregate-sidecar-p1
test "$(git merge-base 47f943859bef60e4160492346772ded9b24f765a HEAD)" = "47f943859bef60e4160492346772ded9b24f765a"
test -z "$(git diff --name-only 47f943859bef60e4160492346772ded9b24f765a HEAD -- . ':(exclude)fde-sidecar/**')"
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 22.22.0
test "$(node --version)" = "v22.22.0"
test "$(corepack pnpm --version)" = "11.7.0"
corepack pnpm install --frozen-lockfile
corepack pnpm run build:lib
corepack pnpm exec vitest run --config fde-sidecar/vitest.config.mjs
```

The test proves schema rejection, the real newline-JSON CLI boundary, two serial turns on one Session, concurrent-call refusal, one-active-process project locking, two-project separation, zero model-facing tools, no tool events, append-only Session output, and Seatbelt denial of network and out-of-root writes.

## Release boundary

- This is a macOS-only experiment because confinement calls `/usr/bin/sandbox-exec`; no Linux or container profile exists.
- The dedicated Vitest config is not included by the repository's default test inventory or CI.
- The only model path is keyless replay. No cloud model, provider credential, retention policy or output-quality acceptance is exercised.
- Nothing here is integrated into, deployed with or enabled in FDE.

## FDE P1 minimum seam

FDE owns `FdeAggregateSidecar`; the sidecar never owns an FDE repository, Draft or deployment credential.

1. FDE computes and validates the aggregate review document locally.
2. The privacy layer signs or records its own approval before calling this adapter; this prototype only validates the narrow document shape and privacy assertions.
3. The adapter starts one fixed-runtime process for that project, initializes the replay/cloud route, and submits one line only while the Session is idle.
4. The adapter returns a receipt containing input digest, `messageId`, turn reason, event digest, exact event types, runtime/profile fingerprint and a parsed suggestion.
5. FDE renders the suggestion in an untrusted “AI 建议” panel. A human may copy/accept it into a Draft through existing FDE actions.
6. Existing save, compiler, digest, assemble, repository quality, deployment and browser gates remain authoritative and unchanged.

Before replacing replay with a cloud adapter, P1 still needs an out-of-process Privacy Gateway, Token Vault, `llm/stream` outbound DLP guard, destination allowlist, encrypted Session persistence or encrypted volume, Linux/container confinement, cloud-retention policy, canary leak tests, and deployment/browser acceptance. None is implied by this keyless slice.
