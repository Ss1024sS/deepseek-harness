# Agent Note: FDE aggregate-only replay sidecar

Status: implemented

English | [中文](2026-08-14-fde-aggregate-only-replay-sidecar.zh.md)

## Problem

FDE needs a keyless experiment that proves the official DeepSeek Harness runtime can consume an aggregate-only fact document without receiving source rows, files, tools, network access, cloud credentials, or FDE mutation authority. A useful result must bind the exact local runtime, correlate one request with one durable event sequence, and fail closed when JSON-RPC output is ambiguous; a mock that bypasses the official runtime does not prove those properties.

## Decision

`fde-sidecar/` ships a macOS-only, one-shot replay experiment pinned to upstream commit `47f943859bef60e4160492346772ded9b24f765a`. Stdin accepts one exact schema-v1 request wrapper containing only `outgoingDigest` and the closed `effiengine.fde-harness-aggregate-facts` payload. The payload may be the exact existing `fde.aggregate-facts.v1` profile or the exact P2-L1 `fde.aggregate-facts.v2` profile. The digest covers recursively key-sorted canonical payload bytes, and only those payload bytes enter the Harness prompt.

V2 preserves the aggregate `plan`, `counts`, `acceptance`, `findings`, and `evidence` facts and adds only `contentPrivacy`: fixed scalar enums followed by nine fixed, ordered `{code,countBucket}` pairs. Counts use the closed coarse buckets `ZERO`, `ONE`, `TWO_TO_FIVE`, and `SIX_PLUS`, never exact counts; `PRIVATE_KEY_MATERIAL` and `CREDENTIAL_ASSIGNMENT` must be `ZERO` because the FDE local gate blocks them before outbound creation. V2 semantics fixes the two evidence classes and states that raw text, redacted text, and token maps are absent. Exact-key validation at every layer leaves no schema position for source or masked text, preview segments, offsets, token values or maps, source or review digests, or a free-form prompt. The sidecar is an admission gate, not a sanitizer: it refuses an unsafe shape instead of transforming it.

Every public invocation creates a fresh private run root and one official stdio JSON-RPC runtime. A start invocation creates a fresh persisted Session; a P2-L2b resume invocation explicitly restores that Session before its next prompt under the [visible Session continuation decision](2026-08-14-fde-visible-session-continuation.md). The local bounded client limits input, frames, aggregate output, stderr, assistant text, initialization, turn time, and cleanup; summary and action text are capped at 500 and 300 Unicode code points respectively. It rejects unknown notifications or events, tool activity, duplicate responses, multiple assistant results, trailing partial frames, and any result that cannot be associated with the single Session and message.

The launcher verifies the canonical runtime manifest and a symlink-free generated carrier before it starts `/usr/bin/sandbox-exec`; it never reads stdin. The carrier is produced through the repository's hoisted `pnpm deploy` route from a minimal closed deploy manifest. Its canonical closure lists every regular file by relative path, POSIX mode, size, and SHA-256; startup rejects missing, extra, linked, wrong-type, wrong-mode, or changed entries. The sandboxed adapter is the first process that reads or validates payload bytes.

One deny-default Seatbelt profile covers the adapter and official runtime child because macOS refuses a nested sandbox application. The manifest pins the adapter template; the launcher expands it with the fixed sidecar, carrier, Node, run, and Session paths. A one-use 256-bit nonce binds the private proof file to those roots, the manifest, the adapter template, and the expanded effective profile. The internal entry point re-hashes that generated profile, consumes the proof, and confirms a known host read is denied before reading stdin. The profile denies network and host reads and writes outside the sidecar assets, carrier, and private roots. It permits exec only of the pinned Node binary, so the runtime inherits the ability to re-exec that binary inside the same policy but cannot exec an unpinned binary. All children remain in the caller-owned process group.

Completion requires official `shutdown`, process close with stdio EOF, an empty trailing frame buffer, and readback of one completed JSONL Session log. A start requires the durable event sequence to match the bounded wire sequence in type closure, cardinality, order, and canonical bytes. A resume also requires the approved prefix to remain identical, one official resume seed marker at the old count, and the new durable suffix to match the bounded wire sequence. A durable-only tool, raw reasoning, unknown event, or extra user, assistant, or turn event fails closed. The receipt is advisory-only keyless replay evidence: it reports no cloud inference, no configured cloud provider, zero tools, zero FDE mutation, and distinct `sha256:` digests for the manifest, adapter template, expanded effective profile, runtime closure, runtime entry, and sidecar.

## Verification

The dedicated sidecar suite exercises both v1 and v2 through the public CLI with the official replay runtime, validates canonical request admission, identical-input Session separation, and payload-only persistence, proves host read/write/network and unpinned-exec denial, and rejects an externally injected internal marker. Its two-turn scenario exits the first runtime, resumes the Session in a second process, and resolves a value present only in the prior visible aggregate payload; the same scenario verifies the unchanged prefix, contiguous sequence and turns, resume marker, zero tools, `providerContinuationDigest: null`, and absence of raw reasoning. Stale cursor, cwd, sequence, turn, raw-reasoning, and thinking/signature counterexamples fail closed. V2 counterexamples reject original or masked text, token maps and values, free prompts, preview segments, offsets, source digests, unknown fields, reordered or missing privacy findings, invalid buckets, and non-zero hard-block buckets before Session creation. Additional counterexamples change the generated profile after proof creation and one transitive carrier JS file, with the latter failing the public CLI before Session creation. A fresh carrier rebuild must reproduce the canonical closure. Durable-only tool and assistant events, an unknown trailing notification, a duplicate response, or a partial final frame remain failures even after a valid response. This suite is an experiment-specific check and is not part of the repository default CI inventory.

## Alternatives considered

**Use the upstream `HarnessClient`.** Rejected because its open-ended stream handling does not provide this experiment's absolute deadline, frame, byte, stderr, assistant-text, and ambiguity bounds.

**Reuse a daemon or infer restoration inside `session/prompt`.** Rejected because overlapping requests and implicit create-or-resume behavior do not provide an exact ownership interval. P2-L2b permits only explicit, sequential Session restoration in a fresh process with a caller-supplied durable cursor.

**Apply nested adapter and runtime Seatbelt profiles.** Rejected because macOS denies the nested sandbox application in this process tree. One actually enforced profile is more accurate than publishing a digest for a second profile that never runs.

**Trust an internal environment marker.** Rejected because a public caller can pre-populate inherited environment. The internal path requires a launcher-created one-use proof and a real denial check in addition to the marker.

**Make v2 fields optional or extensible.** Rejected because absence would be ambiguous and an expanding object would create a future text-smuggling seam.

**Represent privacy findings as a map.** Rejected because fixed array order is part of the cross-repository canonical-byte contract and makes missing or duplicate findings explicit failures.

**Send exact finding counts.** Rejected because the model needs only coarse exposure buckets, while exact counts add avoidable disclosure.

**Carry redacted text or reversible tokens.** Rejected because masked text still contains customer content, and token restoration belongs exclusively to a local privacy gateway.

**Send detailed business data to a cloud model in this experiment.** Rejected because keyless aggregate replay is intended to verify composition and containment, not DLP, re-identification resistance, cloud-model quality, or production privacy policy.

## Consequences

The experiment reaches the official plugin-composed runtime and durable Session path while keeping the receipt's authority narrow and its enforcement claims honest. It costs one process tree per turn; a visible aggregate Session may span explicit sequential turns, but no runtime process is reused. It supports only the tested macOS Seatbelt boundary and allows the contained runtime to re-exec only the pinned Node binary under the same restrictions. The generated carrier is a local experiment input, not a customer distribution artifact; third-party license review, artifact signing, and distribution packaging remain separate release checks.

Supporting v2 does not widen runtime authority or capability, but the fixed order, enums, and canonical bytes create a coordinated FDE-to-Harness versioning obligation. Coarse buckets reduce disclosure at the cost of diagnostic detail. The sidecar still performs no DLP: unsafe content must be blocked by the local privacy gateway and rejected again by exact admission.

This decision does not deliver provider-specific opaque continuation, raw provider reasoning retention, cloud inference, a privacy gateway, token restoration, multi-user authorization, Linux or container confinement, FDE integration or deployment, browser acceptance, Tencent deployment, production retention policy, or model-quality evidence. Any of those capabilities requires its own implementation and release evidence.
