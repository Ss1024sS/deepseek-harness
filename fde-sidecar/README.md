# FDE aggregate-only Harness sidecar P1 / P2-L1 admission

This is a macOS-only, fixed-commit, keyless replay experiment over the official DeepSeek Harness JSON-RPC runtime. It is not a cloud-model integration or an FDE deployment.

## Exact one-shot contract

FDE starts one process for one request:

```sh
node <lab>/fde-sidecar/sidecar.mjs --session-root <absent-private-leaf>
```

`<absent-private-leaf>` must be a fresh high-entropy path under an existing private parent. The sidecar exclusively creates the leaf as `0700`; an existing leaf fails closed. Stdin contains exactly one UTF-8 JSON line and then EOF. Stdout contains exactly one receipt or one stable-code error line and then exit. There is no daemon, reusable Session, project id, review id, browser token or approval token in this protocol.

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

Success is `effiengine.fde-harness-advice-receipt`. It is `ADVISORY_ONLY`, `KEYLESS_REPLAY`, `DENY_ALL_ENFORCED`, zero tools, zero cloud inference and zero FDE mutation. Runtime evidence separately binds the manifest, adapter template, expanded effective profile, canonical runtime closure, runtime entry and sidecar with `sha256:` fields. There is no `runtimeProfileDigest`: macOS applies the one expanded adapter profile to the complete child tree, and reporting a second profile would falsely imply a second enforcement boundary. Failure is only:

```json
{"schemaVersion":1,"kind":"effiengine.fde-harness-sidecar-error","error":{"code":"<closed-code>"}}
```

No stderr, path, token or payload is reflected in an error.

## Security boundary actually exercised

- The unsandboxed launcher verifies the canonical manifest and every pinned hash, creates a deny-default profile, and starts `/usr/bin/sandbox-exec`. It does not read, parse or validate stdin.
- The sandboxed adapter is the first process that reads payload bytes. macOS refuses a nested `sandbox_init`, so adapter and official runtime share one deny-default Seatbelt boundary. The runtime is a child in the same process group, not detached.
- The launcher gives the internal entry point a one-use, 256-bit nonce bound to a private-run proof file, the Session root, run root, manifest digest, adapter-template digest and expanded-profile digest. The internal entry point hashes `adapter.generated.sb`, consumes the proof, and verifies that a known host file is denied before it reads stdin. Any public invocation that inherits either internal environment variable fails closed.
- The adapter may fork and exec only the manifest-pinned Node binary. That grant is inherited by the runtime, so the runtime can re-exec only that same Node binary inside the same policy; it cannot exec `/bin/sh` or another binary. The tree may read only the sidecar assets and generated carrier plus its private run/Session roots, write only those private roots, and has no network permission.
- Runtime `cwd` is a read-only bootstrap directory without `.env`; `DSH_CORDIS_CONFIG` is explicit. This closes the generic runner's cwd `.env` override seam.
- The bounded client is local code, not upstream `HarnessClient`: 64 KiB frame, 128 frames, 512 KiB aggregate stdout, 32 KiB stderr, 16 KiB assistant text, 500 Unicode code points per summary, 300 per action, 5 s initialize, 15 s absolute turn deadline and 3 s cleanup.
- Unknown notification/event, duplicate response, tool event, ambiguous/multiple assistant output, bounds, timeout, failed shutdown, trailing partial output or persistence mismatch fails closed. Both the runtime client and outer launcher wait for process close and stdio EOF, not merely child exit.
- A receipt is returned only after official `shutdown`, process close with stdio EOF, and readback of the completed JSONL event sequence. Apart from the validated Session header, the durable sequence must be byte-equivalent to the bounded wire-event sequence with exact type closure, cardinality and order; durable-only tools, unknown events, or extra user/assistant/turn events fail closed.

Seatbelt is defense in depth against the contained process tree. It does not defend against another malicious process already running as the same macOS user or against compromise of the unsandboxed FDE launcher.

## Fixed fresh-clone closure

The experiment is based on upstream commit `47f943859bef60e4160492346772ded9b24f765a`. The repository pins `pnpm@11.7.0`; do not substitute `npx` or a global pnpm.

```sh
git fetch origin lab/fde-aggregate-sidecar-p1
git checkout --detach origin/lab/fde-aggregate-sidecar-p1
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

The dedicated tests run real v1 and v2 public CLI replays, verify canonical request admission, fixed manifest/Node, fresh random Sessions, exact JSONL persistence after shutdown, payload-first-read placement, one-use launch proof, external-marker injection rejection, absent-leaf ownership, and Seatbelt denial of host read/write/network/unpinned exec. V2 counterexamples reject original/masked text, token maps and values, free prompts, preview segments, offsets, source digests, unknown fields, reordered/missing privacy findings, invalid buckets, and non-zero hard-block buckets before Session creation. The tests also reject an effective profile changed after proof creation and a changed transitive carrier JS file before Session creation. Durable-only tool and assistant counterexamples, as well as trailing unknown, duplicate and partial JSON-RPC output, remain failures. These tests do not run through the repository default CI inventory.

Not verified or delivered: Linux/container confinement, cloud provider, credentials, DLP/token vault, model quality, multi-user authorization, FDE deployment, Tencent deployment, browser acceptance or production retention policy. The P1 carrier is a local experiment input, not a customer distribution artifact; third-party license review, artifact signing and distribution packaging remain separate release checks. Replacing replay with a cloud adapter requires a separate privacy gateway and release gate; this experiment makes no such claim.
