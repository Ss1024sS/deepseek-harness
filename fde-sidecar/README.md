# FDE aggregate-only Harness sidecar P1 / P2-L1 admission / P2-L2b visible continuation

English | [中文](README.zh.md)

This is a macOS-only, fixed-commit, keyless replay experiment over the official DeepSeek Harness JSON-RPC runtime. It is not a cloud-model integration or an FDE deployment.

## Exact one-process-per-turn contract

FDE starts one fresh process for each turn. A first turn creates the Session:

```sh
node <lab>/fde-sidecar/sidecar.mjs --start-session-root <absent-private-leaf>
```

`<absent-private-leaf>` must be a fresh high-entropy path under an existing private parent. The sidecar exclusively creates the leaf as `0700`; an existing leaf fails closed. A later P2-L2b turn resumes that exact Session with the preceding receipt's canonical durable cursor:

```sh
node <lab>/fde-sidecar/sidecar.mjs \
  --resume-session-root <existing-private-root> \
  --expected-event-count <positive-integer> \
  --expected-event-digest sha256:<64hex> \
  --expected-session-identity-digest sha256:<64hex>
```

Resume accepts only the closed P2-L1 v2 payload. Before starting the official runtime, the sandboxed adapter checks the Session header identity digest, cwd, contiguous event sequence, completed turn sequence, event type closure, zero tools, absence of raw reasoning, and exact expected prefix count and digest. The public launcher obtains one cross-process exclusive lock before any Session creation, read, or runtime work and holds it until the sandbox child and stdio have closed; a concurrent or stale lock returns `SESSION_BUSY` before any durable write. Each invocation still reads exactly one UTF-8 JSON line and EOF, writes exactly one receipt or stable-code error line, and exits. There is no daemon, implicit resume inside `session/prompt`, project id, review id, browser token or approval token in this protocol.

The wrapper remains schema v1 and has exact keys:

```json
{"schemaVersion":1,"kind":"effiengine.fde-harness-sidecar-request","outgoingDigest":"sha256:<64hex>","payload":{"schemaVersion":1,"kind":"effiengine.fde-harness-aggregate-facts","profile":"fde.aggregate-facts.v1","semantics":{},"facts":{}}}
```

The payload may be the existing exact `fde.aggregate-facts.v1`, or P2-L1 exact `fde.aggregate-facts.v2`. V2 preserves every v1 aggregate fact and adds only the following model-visible classification summary under `facts.contentPrivacy`:

```json
{
  "sourceKind": "PASTED_PLAIN_TEXT",
  "policy": "fde.local-content.v1",
  "decision": "AGGREGATE_ONLY",
  "residualText": "EXCLUDED_UNCLASSIFIED",
  "findings": [
    {"code": "PRIVATE_KEY_MATERIAL", "countBucket": "ZERO"},
    {"code": "CREDENTIAL_ASSIGNMENT", "countBucket": "ZERO"},
    {"code": "PRC_ID_NUMBER", "countBucket": "ZERO"},
    {"code": "BANK_CARD_NUMBER", "countBucket": "ZERO"},
    {"code": "EMAIL_ADDRESS", "countBucket": "ZERO"},
    {"code": "PRC_MOBILE_NUMBER", "countBucket": "ZERO"},
    {"code": "URL", "countBucket": "ZERO"},
    {"code": "IP_ADDRESS", "countBucket": "ZERO"},
    {"code": "UNCLASSIFIED_TEXT", "countBucket": "ZERO"}
  ]
}
```

The nine finding codes and their order are fixed. `countBucket` is exactly one of `ZERO`, `ONE`, `TWO_TO_FIVE`, or `SIX_PLUS`; the private-key and credential-assignment buckets must be `ZERO` because the local gateway blocks them before outbound creation. V2 semantics additionally fixes the ordered evidence classes to `STATIC_COMPILER_PROJECTION` and `DETERMINISTIC_LOCAL_CLASSIFICATION`, and fixes `rawTextIncluded`, `redactedTextIncluded`, and `tokenMapIncluded` to `false`.

There is no schema position for original text, redacted/masked text, preview segments, offsets, token values or maps, source/review digests, or a free-form prompt. This sidecar validates that closed aggregate contract; it does not perform DLP or make an unsafe payload safe.

`outgoingDigest` must equal SHA-256 of recursively key-sorted, compact UTF-8 canonical payload bytes. The Harness prompt receives only those canonical payload bytes. Thus the v2 closed `contentPrivacy` buckets enter the Session, while the wrapper, digest, project, review, stage and approval metadata never do.

Success is `effiengine.fde-harness-advice-receipt`. It is `ADVISORY_ONLY`, `KEYLESS_REPLAY`, `DENY_ALL_ENFORCED`, zero tools, zero cloud inference and zero FDE mutation. Runtime evidence separately binds the manifest, adapter template, expanded effective profile, canonical runtime closure, runtime entry and sidecar with `sha256:` fields. Continuation evidence distinguishes `STARTED` from `RESUMED`, binds the stable canonical Session-header identity digest, prior and completed canonical event count/digest, last sequence and completed turn, and fixes `providerContinuationDigest` to `null` and `rawReasoningPersisted` to `false`; the start cursor uses the real SHA-256 of empty bytes, not a zero sentinel. There is no `runtimeProfileDigest`: macOS applies the one expanded adapter profile to the complete child tree, and reporting a second profile would falsely imply a second enforcement boundary. Failure is only:

```json
{"schemaVersion":1,"kind":"effiengine.fde-harness-sidecar-error","error":{"code":"<closed-code>"}}
```

No stderr, path, token or payload is reflected in an error.

## Security boundary actually exercised

- The unsandboxed launcher first creates an owner-only sibling lock with exclusive creation, verifies its regular-file identity, and keeps the file descriptor open across the sandbox child's complete lifecycle. Only then does it verify the canonical manifest and every pinned hash, create a deny-default profile, and start `/usr/bin/sandbox-exec`; it never reads, parses or validates stdin. Normal release verifies the lock path still names the same device/inode before unlinking it. A crash may leave a stale lock, which intentionally fails closed as `SESSION_BUSY` and is never reclaimed automatically.
- The sandboxed adapter is the first process that reads payload bytes. macOS refuses a nested `sandbox_init`, so adapter and official runtime share one deny-default Seatbelt boundary. The runtime is a child in the same process group, not detached.
- The launcher gives the internal entry point a one-use, 256-bit nonce bound to a private-run proof file, the Session root, run root, expected continuation cursor, manifest digest, adapter-template digest, expanded-profile digest, lock path, inherited FD number, and lock device/inode. The sandboxed entry point independently compares path and inherited-FD metadata, hashes `adapter.generated.sb`, consumes the proof, and verifies that a known host file is denied before it reads stdin. Any public invocation that inherits either internal environment variable fails closed.
- The adapter may fork and exec only the manifest-pinned Node binary. That grant is inherited by the runtime, so the runtime can re-exec only that same Node binary inside the same policy; it cannot exec `/bin/sh` or another binary. The tree may read only the sidecar assets and generated carrier plus its private run/Session roots, write only those private roots, and has no network permission.
- Runtime `cwd` is a read-only bootstrap directory without `.env`; `DSH_CORDIS_CONFIG` is explicit. This closes the generic runner's cwd `.env` override seam.
- The bounded client is local code, not upstream `HarnessClient`: 64 KiB frame, 128 frames, 512 KiB aggregate stdout, 32 KiB stderr, 16 KiB assistant text, 500 Unicode code points per summary, 300 per action, 5 s initialize, 15 s absolute turn deadline and 3 s cleanup.
- Unknown notification/event, duplicate response, tool event, ambiguous/multiple assistant output, bounds, timeout, failed shutdown, trailing partial output or persistence mismatch fails closed. Both the runtime client and outer launcher wait for process close and stdio EOF, not merely child exit.
- A receipt is returned only after official `shutdown`, process close with stdio EOF, and readback of the completed JSONL event sequence. A start requires the durable sequence to equal the bounded wire-event sequence in canonical bytes. A resume additionally requires the canonical Session header identity and previously approved prefix to remain identical, exactly one official `session/end-seed` marker at the old count, and the new suffix to equal the bounded wire-event sequence. Durable-only tools, unknown events, raw reasoning, or extra user/assistant/turn events fail closed.

Seatbelt is defense in depth against the contained process tree. It does not defend against another malicious process already running as the same macOS user or against compromise of the unsandboxed FDE launcher.

## Fixed fresh-clone closure

The experiment is based on upstream commit `47f943859bef60e4160492346772ded9b24f765a`. The repository pins `pnpm@11.7.0`; do not substitute `npx` or a global pnpm.

```sh
git fetch origin lab/fde-context-capsule-p2l2b
git checkout --detach origin/lab/fde-context-capsule-p2l2b
test "$(git merge-base 47f943859bef60e4160492346772ded9b24f765a HEAD)" = 47f943859bef60e4160492346772ded9b24f765a
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 22.22.0
test "$(node --version)" = v22.22.0
test "$(corepack pnpm --version)" = 11.7.0
corepack pnpm install --frozen-lockfile
corepack pnpm run build:lib
node fde-sidecar/build-runtime-closure.mjs
node_modules/.bin/vitest run --config fde-sidecar/vitest.config.mjs
```

The build uses the repository's official `pnpm deploy --legacy --prod --node-linker=hoisted` carrier route, narrowed to the 60 workspace packages reachable from this fixed composition. It materializes links, removes non-runtime assets, detaches workspace hardlinks, and emits `runtime-closure.json`. The canonical closure lists every regular file by relative path, POSIX mode, size and SHA-256. Startup rejects a symlink, unsupported file type, mode or content drift, missing file, and any extra file before sandbox or runtime creation.

`runtime-manifest.json` is canonical JSON and has no self-hash. `node.path` and all artifact paths resolve relative to the manifest's parent directory. The caller must separately pin the entire manifest SHA-256; calculating and approving it in the same startup is not an approval boundary. `runtime-carrier/` is a generated ignored directory, while its canonical closure is versioned so a fresh build must reproduce the approved bytes.

## Verified / not verified

The dedicated tests run real v1 and v2 public CLI replays, verify canonical request admission, fixed manifest/Node, fresh random Sessions, exact JSONL persistence after shutdown, payload-first-read placement, one-use launch proof, external-marker injection rejection, absent-leaf ownership, and Seatbelt denial of host read/write/network/unpinned exec. A real P2-L2b test completes turn one, blocks a second-process resume while it holds the inherited lock FD, proves a concurrent loser returns `SESSION_BUSY` with byte-identical durable log, then completes turns two and three across fresh processes from reconstructed visible history. It proves the old prefix is unchanged, event sequence and turns remain contiguous, the stable Session identity remains equal, and no provider continuation exists. Stale count/digest/identity, swapped header id or creation time, renamed-root identity, cwd, sequence, turn, raw-reasoning, thinking/signature, tool, and unknown-event counterexamples fail closed. The SDK tests also reject prompt/resume before initialization, duplicate initialization, and resume after prompt-created ownership. V2 counterexamples reject original/masked text, token maps and values, free prompts, preview segments, offsets, source digests, unknown fields, reordered/missing privacy findings, invalid buckets, and non-zero hard-block buckets before Session creation. The tests also reject inherited lock identity drift, an effective profile changed after proof creation, and a changed transitive carrier JS file before Session creation. Durable-only tool and assistant counterexamples, as well as trailing unknown, duplicate and partial JSON-RPC output, remain failures. These tests do not run through the repository default CI inventory.

Not verified or delivered: provider-specific opaque continuation, raw provider reasoning retention, model switching, compaction, retention/deletion automation, Linux/container confinement, cloud provider, credentials, DLP/token vault, model quality, multi-user authorization, FDE deployment, Tencent deployment, browser acceptance or production retention policy. The P1 carrier is a local experiment input, not a customer distribution artifact; third-party license review, artifact signing and distribution packaging remain separate release checks. Replacing replay with a cloud adapter requires a separate privacy gateway and release gate; this experiment makes no such claim.
