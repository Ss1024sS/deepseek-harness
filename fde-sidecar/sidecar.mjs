#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { HarnessClient } from '../packages/sdk/client/lib/index.js'

const UPSTREAM_COMMIT = '47f943859bef60e4160492346772ded9b24f765a'
const SERVER_NAME = 'deepseek-harness-sdk-runtime'
const SERVER_VERSION = '0.0.1'
const INPUT_SCHEMA = 'fde.aggregate-review.v1'
const OUTPUT_SCHEMA = 'fde.agent-suggestion.v1'
const RECEIPT_SCHEMA = 'fde.sidecar-receipt.v1'
const MAX_INPUT_BYTES = 8192
const DEFAULT_TURN_TIMEOUT_MS = 15_000

const labRoot = fileURLToPath(new URL('../', import.meta.url))
const defaultConfig = join(labRoot, 'fde-sidecar', 'cordis.yml')
const defaultRuntime = join(labRoot, 'packages', 'examples', 'jsonrpc-demo', 'lib', 'bin.js')
const defaultProfile = join(labRoot, 'fde-sidecar', 'runtime.sb')
const defaultReplayFile = join(labRoot, 'fde-sidecar', 'replay', 'session.jsonl')
const defaultReplayOverride = join(labRoot, 'fde-sidecar', 'replay', 'replay.override.json')

export class SidecarError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SidecarError'
    this.code = code
  }
}

function record(value, at) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SidecarError('INVALID_INPUT', `${at} must be an object`)
  }
  return value
}

function exactKeys(value, expected, at) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SidecarError('INVALID_INPUT', `${at} keys must be exactly: ${wanted.join(', ')}`)
  }
}

function boundedToken(value, pattern, at) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new SidecarError('INVALID_INPUT', `${at} is not an allowed token`)
  }
  return value
}

function nonnegativeInteger(value, at) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SidecarError('INVALID_INPUT', `${at} must be a non-negative safe integer`)
  }
  return value
}

function requiredBoolean(value, expected, at) {
  if (value !== expected) {
    throw new SidecarError('PRIVACY_POLICY_REJECTED', `${at} must be ${String(expected)}`)
  }
  return value
}

export function validateAggregateReview(value, expectedProjectRef) {
  const input = record(value, 'input')
  exactKeys(input, ['schema', 'reviewId', 'projectRef', 'aggregate', 'privacy'], 'input')
  if (input.schema !== INPUT_SCHEMA) throw new SidecarError('INVALID_INPUT', `schema must be ${INPUT_SCHEMA}`)
  const reviewId = boundedToken(input.reviewId, /^REV-[A-Z0-9-]{1,48}$/, 'reviewId')
  const projectRef = boundedToken(input.projectRef, /^PRJ-[A-Z0-9-]{1,48}$/, 'projectRef')
  if (projectRef !== expectedProjectRef) {
    throw new SidecarError('PROJECT_MISMATCH', `input projectRef ${projectRef} does not match this sidecar`)
  }

  const aggregate = record(input.aggregate, 'aggregate')
  exactKeys(aggregate, ['assetRegistry', 'quality', 'workbench', 'blockers'], 'aggregate')
  const assetRegistry = record(aggregate.assetRegistry, 'aggregate.assetRegistry')
  exactKeys(assetRegistry, ['registered', 'ingested', 'installableSystems'], 'aggregate.assetRegistry')
  nonnegativeInteger(assetRegistry.registered, 'aggregate.assetRegistry.registered')
  nonnegativeInteger(assetRegistry.ingested, 'aggregate.assetRegistry.ingested')
  nonnegativeInteger(assetRegistry.installableSystems, 'aggregate.assetRegistry.installableSystems')
  if (assetRegistry.ingested > assetRegistry.registered) {
    throw new SidecarError('INVALID_INPUT', 'ingested cannot exceed registered')
  }

  const quality = record(aggregate.quality, 'aggregate.quality')
  exactKeys(quality, ['passed', 'total'], 'aggregate.quality')
  nonnegativeInteger(quality.passed, 'aggregate.quality.passed')
  nonnegativeInteger(quality.total, 'aggregate.quality.total')
  if (quality.passed > quality.total) throw new SidecarError('INVALID_INPUT', 'quality passed cannot exceed total')

  const workbench = record(aggregate.workbench, 'aggregate.workbench')
  exactKeys(workbench, ['screens', 'saveConnected'], 'aggregate.workbench')
  nonnegativeInteger(workbench.screens, 'aggregate.workbench.screens')
  if (typeof workbench.saveConnected !== 'boolean') {
    throw new SidecarError('INVALID_INPUT', 'aggregate.workbench.saveConnected must be boolean')
  }

  if (!Array.isArray(aggregate.blockers) || aggregate.blockers.length > 20) {
    throw new SidecarError('INVALID_INPUT', 'aggregate.blockers must be an array of at most 20 items')
  }
  for (const [index, rawBlocker] of aggregate.blockers.entries()) {
    const blocker = record(rawBlocker, `aggregate.blockers[${index}]`)
    exactKeys(blocker, ['code', 'count'], `aggregate.blockers[${index}]`)
    boundedToken(blocker.code, /^[A-Z][A-Z0-9_]{1,47}$/, `aggregate.blockers[${index}].code`)
    nonnegativeInteger(blocker.count, `aggregate.blockers[${index}].count`)
  }

  const privacy = record(input.privacy, 'privacy')
  exactKeys(privacy, ['aggregateOnly', 'rawRowsIncluded', 'identifiersTokenized', 'sensitiveFieldsRemoved'], 'privacy')
  requiredBoolean(privacy.aggregateOnly, true, 'privacy.aggregateOnly')
  requiredBoolean(privacy.rawRowsIncluded, false, 'privacy.rawRowsIncluded')
  requiredBoolean(privacy.identifiersTokenized, true, 'privacy.identifiersTokenized')
  requiredBoolean(privacy.sensitiveFieldsRemoved, true, 'privacy.sensitiveFieldsRemoved')

  const canonical = JSON.stringify(input)
  if (Buffer.byteLength(canonical) > MAX_INPUT_BYTES) {
    throw new SidecarError('INVALID_INPUT', `input exceeds ${MAX_INPUT_BYTES} bytes`)
  }
  return { input, canonical, reviewId, projectRef }
}

function parseSuggestion(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new SidecarError('INVALID_MODEL_OUTPUT', 'model output is not JSON', error)
  }
  const suggestion = record(value, 'suggestion')
  exactKeys(suggestion, ['schema', 'verdict', 'summary', 'actions'], 'suggestion')
  if (suggestion.schema !== OUTPUT_SCHEMA) {
    throw new SidecarError('INVALID_MODEL_OUTPUT', `suggestion schema must be ${OUTPUT_SCHEMA}`)
  }
  if (!['ready-with-conditions', 'manual-review', 'blocked'].includes(suggestion.verdict)) {
    throw new SidecarError('INVALID_MODEL_OUTPUT', 'suggestion verdict is not allowed')
  }
  if (typeof suggestion.summary !== 'string' || suggestion.summary.length === 0 || suggestion.summary.length > 500) {
    throw new SidecarError('INVALID_MODEL_OUTPUT', 'suggestion summary must contain 1-500 characters')
  }
  if (!Array.isArray(suggestion.actions) || suggestion.actions.length > 8) {
    throw new SidecarError('INVALID_MODEL_OUTPUT', 'suggestion actions must be an array of at most 8 items')
  }
  for (const [index, rawAction] of suggestion.actions.entries()) {
    const action = record(rawAction, `suggestion.actions[${index}]`)
    exactKeys(action, ['code', 'priority', 'text'], `suggestion.actions[${index}]`)
    boundedToken(action.code, /^[A-Z][A-Z0-9_]{1,47}$/, `suggestion.actions[${index}].code`)
    if (!['P0', 'P1', 'P2', 'P3'].includes(action.priority)) {
      throw new SidecarError('INVALID_MODEL_OUTPUT', `suggestion.actions[${index}].priority is not allowed`)
    }
    if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 300) {
      throw new SidecarError('INVALID_MODEL_OUTPUT', `suggestion.actions[${index}].text must contain 1-300 characters`)
    }
  }
  return suggestion
}

function eventEnvelope(notification) {
  if (notification.method !== 'session.event') return undefined
  const event = notification.params.event
  return event !== null && typeof event === 'object' && typeof event.type === 'string' ? event : undefined
}

function isReceipt(event, messageId) {
  if (event?.type !== 'agent/inbox/spliced') return false
  const inserted = event.data?.inserted
  return Array.isArray(inserted) && inserted.some(message => message?.id === messageId)
}

function textOfAssistant(event) {
  if (event?.type !== 'assistant/message') return undefined
  const content = event.data?.message?.content
  if (!Array.isArray(content) || !content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
    throw new SidecarError('AMBIGUOUS_RESULT', 'assistant response contains a non-text block')
  }
  return content.map(block => block.text).join('')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function timeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SidecarError('TURN_TIMEOUT', `${label} exceeded ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function verifyStrictInterval(events, messageId) {
  if (!isReceipt(events[0], messageId)) {
    throw new SidecarError('AMBIGUOUS_RESULT', 'interval does not start at the matching durable inbox receipt')
  }
  const matchingReceipts = events.filter(event => isReceipt(event, messageId))
  const otherInsertions = events.filter(event => event.type === 'agent/inbox/spliced'
    && Array.isArray(event.data?.inserted)
    && event.data.inserted.some(message => message?.id !== messageId))
  const turnStarts = events.filter(event => event.type === 'turn/start')
  const turnEnds = events.filter(event => event.type === 'turn/end')
  const userMessages = events.filter(event => event.type === 'user/message' && event.data?.id === messageId)
  const assistants = events.filter(event => event.type === 'assistant/message')
  const toolEvents = events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
  const requestHeaders = events.filter(event => event.type === 'request/header')

  if (matchingReceipts.length !== 1 || otherInsertions.length !== 0
    || turnStarts.length !== 1 || turnEnds.length !== 1 || userMessages.length !== 1
    || assistants.length !== 1 || toolEvents.length !== 0) {
    throw new SidecarError('AMBIGUOUS_RESULT', 'event interval is not one isolated, tool-free turn')
  }
  const turn = turnStarts[0].data?.turn
  if (turnEnds[0].data?.turn !== turn || turnEnds[0].data?.reason?.kind !== 'completed') {
    throw new SidecarError('TURN_REJECTED', 'turn did not end with completed')
  }
  for (const header of requestHeaders) {
    const tools = header.data?.header?.tools
    if (tools !== undefined && (!Array.isArray(tools) || tools.length !== 0)) {
      throw new SidecarError('TOOLS_EXPOSED', 'request header exposed model-facing tools')
    }
  }
  const finalText = textOfAssistant(assistants[0])
  if (finalText === undefined) throw new SidecarError('AMBIGUOUS_RESULT', 'no assistant result')
  return { turn, finalText }
}

async function bindProjectRoot(root, projectRef, sidecarInstanceId) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const absolute = await realpath(root)
  const markerPath = join(absolute, '.fde-project.json')
  const marker = JSON.stringify({ schema: 'fde.sidecar-project.v1', projectRef, upstreamCommit: UPSTREAM_COMMIT }) + '\n'
  try {
    const handle = await open(markerPath, 'wx', 0o600)
    try { await handle.writeFile(marker) } finally { await handle.close() }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let existing
    try { existing = JSON.parse(await readFile(markerPath, 'utf8')) } catch (cause) {
      throw new SidecarError('PROJECT_ROOT_INVALID', 'project root marker is unreadable', cause)
    }
    if (existing?.projectRef !== projectRef || existing?.upstreamCommit !== UPSTREAM_COMMIT) {
      throw new SidecarError('PROJECT_ROOT_MISMATCH', 'session root belongs to another project or runtime commit')
    }
  }
  const lockPath = join(absolute, '.fde-sidecar.lock')
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
    await lock.writeFile(`${sidecarInstanceId}\n`)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new SidecarError('PROJECT_ALREADY_ACTIVE', 'project already has an active sidecar')
    throw error
  }
  return { root: absolute, lockPath, lock }
}

export class FdeAggregateSidecar {
  constructor(options) {
    this.projectRef = boundedToken(options.projectRef, /^PRJ-[A-Z0-9-]{1,48}$/, 'projectRef')
    this.sessionRoot = resolve(options.sessionRoot)
    this.configPath = resolve(options.configPath ?? defaultConfig)
    this.runtimePath = resolve(options.runtimePath ?? defaultRuntime)
    this.profilePath = resolve(options.profilePath ?? defaultProfile)
    this.replayFile = resolve(options.replayFile ?? defaultReplayFile)
    this.replayOverride = resolve(options.replayOverride ?? defaultReplayOverride)
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.sidecarInstanceId = `sidecar-${randomUUID()}`
    this.sessionId = `fde-${this.projectRef.toLowerCase()}`
    this.busy = false
    this.closed = false
    this.startTask = undefined
    this.client = undefined
    this.rootBinding = undefined
    this.profileDigest = undefined
  }

  async start() {
    if (this.closed) throw new SidecarError('SIDECAR_CLOSED', 'sidecar is closed')
    this.startTask ??= this.startOnce()
    return this.startTask
  }

  async startOnce() {
    const canonicalLabRoot = await realpath(labRoot)
    const canonicalConfig = await realpath(this.configPath)
    const canonicalRuntime = await realpath(this.runtimePath)
    const canonicalProfile = await realpath(this.profilePath)
    const canonicalReplayFile = await realpath(this.replayFile)
    const canonicalReplayOverride = await realpath(this.replayOverride)
    for (const [label, path] of [
      ['config', canonicalConfig], ['runtime', canonicalRuntime], ['profile', canonicalProfile],
      ['replay fixture', canonicalReplayFile], ['replay override', canonicalReplayOverride],
    ]) {
      if (!path.startsWith(`${canonicalLabRoot}/`)) {
        throw new SidecarError('RUNTIME_PATH_REJECTED', `${label} must remain inside the fixed lab checkout`)
      }
    }
    this.configPath = canonicalConfig
    this.runtimePath = canonicalRuntime
    this.profilePath = canonicalProfile
    this.replayFile = canonicalReplayFile
    this.replayOverride = canonicalReplayOverride
    this.rootBinding = await bindProjectRoot(this.sessionRoot, this.projectRef, this.sidecarInstanceId)
    try {
      const [runtimeArtifact, adapterSource, ...profileMaterial] = await Promise.all([
        readFile(this.runtimePath), readFile(fileURLToPath(import.meta.url)),
        readFile(this.configPath), readFile(this.profilePath), readFile(this.replayFile), readFile(this.replayOverride),
      ])
      this.profileDigest = sha256(Buffer.concat(profileMaterial))
      this.runtimeArtifactDigest = sha256(runtimeArtifact)
      this.adapterDigest = sha256(adapterSource)
      const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        FDE_SIDECAR_SESSION_ROOT: this.rootBinding.root,
        FDE_SIDECAR_REPLAY_FILE: this.replayFile,
        FDE_SIDECAR_REPLAY_OVERRIDE: this.replayOverride,
        NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      }
      this.client = new HarnessClient({
        command: '/usr/bin/sandbox-exec',
        args: [
          '-D', `SESSION_ROOT=${this.rootBinding.root}`,
          '-f', this.profilePath,
          process.execPath, this.runtimePath, this.configPath,
        ],
        cwd: this.rootBinding.root,
        env,
        requestTimeoutMs: this.turnTimeoutMs,
        shutdownTimeoutMs: 1_000,
        disposeEofGraceMs: 3_000,
        disposeGraceMs: 2_000,
      })
      this.client.start()
      const identity = await this.client.initialize({
        cwd: this.rootBinding.root,
        provider: 'fde-replay',
        model: 'aggregate-review-v1',
        maxTokens: 1024,
      })
      if (identity.serverInfo.name !== SERVER_NAME || identity.serverInfo.version !== SERVER_VERSION) {
        throw new SidecarError('RUNTIME_IDENTITY_MISMATCH', `unexpected runtime identity: ${JSON.stringify(identity)}`)
      }
      return identity
    } catch (error) {
      await this.close().catch(() => {})
      throw error
    }
  }

  async analyze(rawInput) {
    const { input, canonical, reviewId, projectRef } = validateAggregateReview(rawInput, this.projectRef)
    if (this.closed) throw new SidecarError('SIDECAR_CLOSED', 'sidecar is closed')
    if (this.busy) throw new SidecarError('SESSION_BUSY', 'same-session concurrent work is rejected; retry after idle')
    this.busy = true
    try {
      await this.start()
      const client = this.client
      if (client === undefined) throw new SidecarError('SIDECAR_NOT_STARTED', 'runtime client is unavailable')
      const subscription = client.subscribe(notification => notification.params?.sessionId === this.sessionId)
      try {
        const messageId = await client.prompt(this.sessionId, [{ type: 'text', text: canonical }])
        const events = []
        let receiptSeen = false
        let idleSeen = false
        while (!idleSeen) {
          const notification = await timeout(subscription.next(), this.turnTimeoutMs, 'turn notification interval')
          const event = eventEnvelope(notification)
          if (!receiptSeen) {
            if (event === undefined || !isReceipt(event, messageId)) continue
            receiptSeen = true
          }
          if (event !== undefined) events.push(event)
          if (notification.method === 'session.status' && notification.params.status === 'idle') idleSeen = true
        }
        if (!receiptSeen) throw new SidecarError('MISSING_RECEIPT', 'prompt has no matching durable inbox receipt')
        const interval = verifyStrictInterval(events, messageId)
        const suggestion = parseSuggestion(interval.finalText)
        return {
          schema: RECEIPT_SCHEMA,
          reviewId,
          projectRef,
          sidecarInstanceId: this.sidecarInstanceId,
          sessionId: this.sessionId,
          messageId,
          runtime: {
            upstreamCommit: UPSTREAM_COMMIT,
            serverName: SERVER_NAME,
            serverVersion: SERVER_VERSION,
            profileDigest: this.profileDigest,
            runtimeArtifactDigest: this.runtimeArtifactDigest,
            adapterDigest: this.adapterDigest,
            processModel: 'one-project-one-runtime-process',
            networkPolicy: 'deny-all',
            writePolicy: 'session-root-only',
          },
          outcome: { turn: interval.turn, reason: 'completed', suggestion },
          evidence: {
            inputDigest: sha256(canonical),
            eventDigest: sha256(events.map(event => JSON.stringify(event)).join('\n')),
            eventTypes: events.map(event => event.type),
            toolCallCount: 0,
          },
          authority: 'advisory-only',
        }
      } catch (error) {
        if (error instanceof SidecarError && ['TURN_TIMEOUT', 'AMBIGUOUS_RESULT'].includes(error.code)) {
          await this.close().catch(() => {})
        }
        throw error
      } finally {
        subscription.close()
      }
    } finally {
      this.busy = false
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    const failures = []
    try { await this.client?.close() } catch (error) { failures.push(error) }
    if (this.rootBinding !== undefined) {
      try { await this.rootBinding.lock.close() } catch (error) { failures.push(error) }
      try { await unlink(this.rootBinding.lockPath) } catch (error) {
        if (error?.code !== 'ENOENT') failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'sidecar close failed')
  }
}

function cliArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1])
  const projectRef = args.get('--project-ref')
  const sessionRoot = args.get('--session-root')
  if (projectRef === undefined || sessionRoot === undefined) {
    throw new SidecarError('CLI_USAGE', 'usage: sidecar.mjs --project-ref PRJ-TOKEN --session-root /absolute/private/root')
  }
  return { projectRef, sessionRoot }
}

async function main() {
  const sidecar = new FdeAggregateSidecar(cliArgs(process.argv.slice(2)))
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      try {
        const receipt = await sidecar.analyze(JSON.parse(line))
        process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`)
      } catch (error) {
        const code = error instanceof SidecarError ? error.code : 'SIDECAR_FAILURE'
        process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: String(error?.message ?? error) } })}\n`)
        process.exitCode = 2
        break
      }
    }
  } finally {
    await sidecar.close()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
