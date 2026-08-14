# Agent Note: FDE visible Session continuation

Status: implemented

English | [中文](2026-08-14-fde-visible-session-continuation.zh.md)

## Problem

The [aggregate-only replay sidecar](2026-08-14-fde-aggregate-only-replay-sidecar.md) proves one contained advisory turn, but an FDE job needs a later process to continue from approved model-visible history without trusting an ambient Session directory, retaining raw reasoning, or smuggling provider-specific continuation into the provider-neutral record. Reusing a daemon would weaken one-process ownership and teardown; silently choosing create or resume inside `session/prompt` would make a stale caller indistinguishable from a valid continuation.

## Decision

P2-L2b keeps one fresh runtime process per turn and permits only explicit, serialized continuation of a P2-L1 v2 visible capsule. The public sidecar CLI separates `--start-session-root` from `--resume-session-root`; resume requires the preceding receipt's positive event count, `sha256:` canonical event digest, and canonical Session-header identity digest. Before any Session creation, read, or runtime work, the launcher exclusively creates an owner-only sibling lock, binds its inherited FD and device/inode identity into the launch proof, and holds it through child close and stdio EOF. A concurrent or stale lock fails as `SESSION_BUSY` before durable mutation; stale locks are never reclaimed automatically. The wrapper and v2 aggregate payload remain unchanged, and v1 remains start-only.

The SDK JSON-RPC server accepts exactly one successful `initialize`; prompt or resume before it and any duplicate initialization fail, so a live route cannot be silently replaced. It exposes `session/resume` as a distinct operation after initialization and before the Session's first prompt in that process. It calls the official `ctx.agents.resume`, rejects an already-open or prompt-created Session and an exact cwd mismatch, and returns the persisted prefix count plus the next live sequence number. The sidecar validates the stored header identity, cwd, contiguous sequence, completed turn sequence, closed event types, zero tools, and absence of raw reasoning before invoking the runtime. It then requires the server cursor to place exactly one official `session/end-seed` event between the approved prefix and the next wire event.

The completed receipt records `STARTED` or `RESUMED`, the stable Session identity digest, prior and final canonical event count/digest, last sequence, completed turn, zero tool calls, `providerContinuationDigest: null`, and `rawReasoningPersisted: false`. The empty prior prefix uses the real SHA-256 of empty bytes instead of a zero sentinel. A resume succeeds only when the canonical header identity and old event prefix remain identical, the one seed marker occupies the old count, the new durable suffix equals the bounded wire sequence, and exactly one further turn completes. Any stale cursor or swapped id, creation time, root/cwd, sequence, turn, tool, raw-reasoning, thinking, signature, unknown event, or extra assistant/user event fails closed.

Provider-neutral visible history and provider-specific opaque continuation are physically separate: this keyless composition mounts only the JSONL Session containing canonical aggregate payloads and validated advice. It mounts no provider continuation store, accepts no continuation token, and retains no raw reasoning. A future cloud provider requires a separate opaque store and receipt contract; it cannot place opaque bytes or raw reasoning in this Session.

## Verification

The public CLI test starts v2 turn one, then launches a resume process but withholds stdin after its lock appears. A concurrent process returns `SESSION_BUSY` while the JSONL bytes remain identical. The lock holder then completes turn two, and a third fresh process completes turn three, with the replay response able to resolve its required value only from prior visible history. The test compares the complete old prefix, contiguous sequence numbers, both seed markers, all three turns and canonical user payloads, stable Session identity, and final resumability. Separate counterexamples reject stale count/digest/identity, swapped header id and creation time, a renamed root with substituted id/cwd, lock-FD identity drift, sequence, turn, reasoning-delta, thinking/signature, and request-header reasoning before runtime.

## Alternatives considered

**Keep every turn in one daemon.** Rejected because process ownership, output bounds, teardown, and request-to-log association would depend on shared mutable runtime state.

**Let `session/prompt` create or resume implicitly.** Rejected because a stale or mistyped Session id could select history without an explicit caller decision or approved prefix cursor.

**Persist provider continuation in the visible Session.** Rejected because provider tokens and raw reasoning are not provider-neutral model-visible context and may carry undisclosed customer or model-private data.

**Prove continuation with a static replay answer.** Rejected because the same output can succeed without restoring any history. The dynamic replay match makes prior visible context necessary.

## Consequences

FDE can prove three provider-neutral visible turns across process restarts while preserving one Seatbelt process tree per turn, zero network, zero tools, keyless replay, and advisory-only authority. The caller must retain and pass the complete receipt cursor, while the launcher enforces single-writer execution for one Session rather than trusting caller serialization. Canonical visible history grows until a separately specified compaction policy exists.

This decision does not implement provider-specific opaque continuation, cloud inference, model switching, compaction, retention or deletion automation, multi-user authorization, or FDE deployment. `providerContinuationDigest: null` is an asserted absence in this composition, not a placeholder for silently adding provider state later.
