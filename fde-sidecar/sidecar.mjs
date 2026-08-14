#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fstat as fstatCallback } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const UPSTREAM_COMMIT = '47f943859bef60e4160492346772ded9b24f765a'
const REQUEST_KIND = 'effiengine.fde-harness-sidecar-request'
const PAYLOAD_KIND = 'effiengine.fde-harness-aggregate-facts'
const RECEIPT_KIND = 'effiengine.fde-harness-advice-receipt'
const ADVICE_KIND = 'effiengine.fde-harness-advice'
const ERROR_KIND = 'effiengine.fde-harness-sidecar-error'
const SERVER_NAME = 'deepseek-harness-sdk-runtime'
const SERVER_VERSION = '0.0.2'
const MAX_INPUT_LINE_BYTES = 64 * 1024
const MAX_FRAME_BYTES = 64 * 1024
const MAX_FRAMES = 128
const MAX_TOTAL_FRAME_BYTES = 512 * 1024
const MAX_STDERR_BYTES = 32 * 1024
const MAX_ASSISTANT_BYTES = 16 * 1024
const INITIALIZE_TIMEOUT_MS = 5_000
const TURN_TIMEOUT_MS = 15_000
const CLEANUP_TIMEOUT_MS = 3_000
const MAX_SUMMARY_CODE_POINTS = 500
const MAX_ACTION_TEXT_CODE_POINTS = 300
const MAX_ACTIONS = 8
const MAX_RUNTIME_CLOSURE_FILES = 2_048
const MAX_RUNTIME_CLOSURE_BYTES = 32 * 1024 * 1024
const EMPTY_EVENT_DIGEST = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const SESSION_LOCK_FD = 3
const fstatAsync = promisify(fstatCallback)

const labRoot = fileURLToPath(new URL('../', import.meta.url))
const sidecarRoot = join(labRoot, 'fde-sidecar')
const defaults = {
  manifest: join(sidecarRoot, 'runtime-manifest.json'),
  config: join(sidecarRoot, 'cordis.yml'),
  adapterProfile: join(sidecarRoot, 'adapter.sb'),
  replayFile: join(sidecarRoot, 'replay', 'session.jsonl'),
  replayOverride: join(sidecarRoot, 'replay', 'replay.override.json'),
  runtime: join(sidecarRoot, 'runtime-carrier', 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'packaged-bin.js'),
}

const STATUS_VALUES = new Set([
  'BLOCKED', 'NOT_APPLICABLE', 'NOT_MEASURED', 'NOT_PROBED', 'PASS',
  'absent', 'candidate', 'customer', 'default', 'design', 'local_only',
  'missing', 'not_selected', 'pilot', 'snapshot_only', 'stable',
  'unavailable', 'unverified',
])
const FINDING_CODES = new Set([
  'CANDIDATE_ACTION_NOT_INSTALLABLE', 'CONFIG_ABOVE_MAXIMUM',
  'CONFIG_BELOW_MINIMUM', 'CONFIG_INVALID_TYPE', 'CONFIG_MISSING',
  'CONFIG_NOT_IN_ENUM', 'CONFIG_UNRESOLVED', 'CONTRACT_CONFLICT',
  'CONTRACT_DEPENDENCY_MISSING', 'CONTRACT_SYSTEM_NOT_SELECTED',
  'EXTERNAL_URL_SOURCE_CONFLICT', 'EXTERNAL_URL_SOURCE_MISSING',
  'INACTIVE_CONTRACT_CONFIG', 'OPTIONAL_CONTRACT_UNAVAILABLE',
  'PLATFORM_REQUIRED', 'PORT_BINDING_MISSING', 'PORT_CAPABILITY_MISSING',
  'PORT_NOT_AVAILABLE_IN_SNAPSHOT', 'PROVIDER_EVIDENCE_MISMATCH',
  'SYSTEM_DEPENDENCY_MISSING', 'SYSTEM_NOT_FOUND',
])
const COUNT_KEYS = [
  'requestedSystems', 'resolvedSystems', 'selectedContracts', 'dependencyEdges',
  'contractDependencyEdges', 'requestedExternal', 'contracts', 'configurationSlots',
  'capabilityGaps', 'routes', 'artifacts', 'blockers', 'warnings',
]
const EVIDENCE_KEYS = [
  'portsByStatus', 'actionsByStatus', 'contractsByMaturity',
  'configurationSlotsByStatus', 'configurationSlotsBySource', 'gapsByStatus',
  'syncRuntimeHealthByStatus', 'syncFreshnessByStatus',
]
const CONTENT_PRIVACY_FINDING_CODES = [
  'PRIVATE_KEY_MATERIAL',
  'CREDENTIAL_ASSIGNMENT',
  'PRC_ID_NUMBER',
  'BANK_CARD_NUMBER',
  'EMAIL_ADDRESS',
  'PRC_MOBILE_NUMBER',
  'URL',
  'IP_ADDRESS',
  'UNCLASSIFIED_TEXT',
]
const CONTENT_PRIVACY_COUNT_BUCKETS = new Set([
  'ZERO', 'ONE', 'TWO_TO_FIVE', 'SIX_PLUS',
])
const CONTENT_PRIVACY_HARD_BLOCK_CODES = new Set([
  'PRIVATE_KEY_MATERIAL', 'CREDENTIAL_ASSIGNMENT',
])
const ALLOWED_EVENT_TYPES = new Set([
  'agent/inbox/spliced', 'turn/start', 'step/start', 'user/message',
  'session/title', 'request/header', 'request/context', 'assistant/chunk',
  'assistant/message', 'step/end', 'turn/end',
])
const ALLOWED_DURABLE_EVENT_TYPES = new Set([...ALLOWED_EVENT_TYPES, 'session/end-seed'])
const SAFE_ASSISTANT_CHUNK_TYPES = new Set([
  'block-start', 'text-delta', 'block-end', 'usage', 'finish',
])
const ERROR_CODES = new Set([
  'INVALID_REQUEST', 'DIGEST_MISMATCH', 'INPUT_TOO_LARGE', 'MULTIPLE_REQUESTS',
  'MANIFEST_INVALID', 'MANIFEST_DRIFT', 'PLATFORM_UNSUPPORTED', 'SANDBOX_FAILURE',
  'RUNTIME_START_FAILED', 'INITIALIZE_TIMEOUT', 'TURN_TIMEOUT', 'FRAME_TOO_LARGE',
  'FRAME_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED', 'STDERR_LIMIT_EXCEEDED',
  'PROTOCOL_VIOLATION', 'UNKNOWN_NOTIFICATION', 'UNKNOWN_EVENT', 'TOOLS_EXPOSED',
  'AMBIGUOUS_RESULT', 'INVALID_MODEL_OUTPUT', 'PERSISTENCE_NOT_PROVEN',
  'CONTINUATION_STALE', 'SESSION_BUSY', 'RAW_REASONING_EXPOSED', 'CLEANUP_FAILED', 'SIDECAR_FAILURE',
])

export class SidecarError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SidecarError'
    this.code = ERROR_CODES.has(code) ? code : 'SIDECAR_FAILURE'
  }
}

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SidecarError('INVALID_REQUEST')
  return value
}

function exactKeys(value, expected, code = 'INVALID_REQUEST') {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SidecarError(code)
  }
}

function nonnegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new SidecarError('INVALID_REQUEST')
}

function boolean(value) {
  if (typeof value !== 'boolean') throw new SidecarError('INVALID_REQUEST')
}

function validateStatusCounts(value) {
  if (!Array.isArray(value) || value.length > STATUS_VALUES.size) throw new SidecarError('INVALID_REQUEST')
  const seen = new Set()
  for (const itemValue of value) {
    const item = record(itemValue)
    exactKeys(item, ['status', 'count'])
    if (!STATUS_VALUES.has(item.status) || seen.has(item.status)) throw new SidecarError('INVALID_REQUEST')
    nonnegativeInteger(item.count)
    seen.add(item.status)
  }
}

function validateFindingCounts(value) {
  if (!Array.isArray(value) || value.length > FINDING_CODES.size) throw new SidecarError('INVALID_REQUEST')
  const seen = new Set()
  for (const itemValue of value) {
    const item = record(itemValue)
    exactKeys(item, ['code', 'count'])
    if (!FINDING_CODES.has(item.code) || seen.has(item.code)) throw new SidecarError('INVALID_REQUEST')
    nonnegativeInteger(item.count)
    seen.add(item.code)
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new SidecarError('INVALID_REQUEST')
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validateContentPrivacy(value) {
  const contentPrivacy = record(value)
  exactKeys(contentPrivacy, [
    'sourceKind', 'policy', 'decision', 'residualText', 'findings',
  ])
  if (contentPrivacy.sourceKind !== 'PASTED_PLAIN_TEXT'
    || contentPrivacy.policy !== 'fde.local-content.v1'
    || contentPrivacy.decision !== 'AGGREGATE_ONLY'
    || contentPrivacy.residualText !== 'EXCLUDED_UNCLASSIFIED'
    || !Array.isArray(contentPrivacy.findings)
    || contentPrivacy.findings.length !== CONTENT_PRIVACY_FINDING_CODES.length) {
    throw new SidecarError('INVALID_REQUEST')
  }
  for (let index = 0; index < CONTENT_PRIVACY_FINDING_CODES.length; index += 1) {
    const finding = record(contentPrivacy.findings[index])
    exactKeys(finding, ['code', 'countBucket'])
    const expectedCode = CONTENT_PRIVACY_FINDING_CODES[index]
    if (finding.code !== expectedCode
      || !CONTENT_PRIVACY_COUNT_BUCKETS.has(finding.countBucket)
      || CONTENT_PRIVACY_HARD_BLOCK_CODES.has(expectedCode) && finding.countBucket !== 'ZERO') {
      throw new SidecarError('INVALID_REQUEST')
    }
  }
}

function validatePayload(value) {
  const payload = record(value)
  exactKeys(payload, ['schemaVersion', 'kind', 'profile', 'semantics', 'facts'])
  if (payload.kind !== PAYLOAD_KIND || ![1, 2].includes(payload.schemaVersion)) {
    throw new SidecarError('INVALID_REQUEST')
  }
  const semantics = record(payload.semantics)
  if (payload.schemaVersion === 1) {
    if (payload.profile !== 'fde.aggregate-facts.v1') throw new SidecarError('INVALID_REQUEST')
    exactKeys(semantics, [
      'authority', 'evidenceClass', 'assemblyExecuted', 'deploymentExecuted',
      'runtimeProbeExecuted', 'businessAcceptanceProven',
    ])
    if (semantics.authority !== 'ADVISORY_ONLY'
      || semantics.evidenceClass !== 'STATIC_COMPILER_PROJECTION'
      || semantics.assemblyExecuted !== false
      || semantics.deploymentExecuted !== false
      || semantics.runtimeProbeExecuted !== false
      || semantics.businessAcceptanceProven !== false) throw new SidecarError('INVALID_REQUEST')
  } else {
    if (payload.profile !== 'fde.aggregate-facts.v2') throw new SidecarError('INVALID_REQUEST')
    exactKeys(semantics, [
      'authority', 'evidenceClasses', 'rawTextIncluded', 'redactedTextIncluded',
      'tokenMapIncluded', 'assemblyExecuted', 'deploymentExecuted',
      'runtimeProbeExecuted', 'businessAcceptanceProven',
    ])
    if (semantics.authority !== 'ADVISORY_ONLY'
      || !Array.isArray(semantics.evidenceClasses)
      || semantics.evidenceClasses.length !== 2
      || semantics.evidenceClasses[0] !== 'STATIC_COMPILER_PROJECTION'
      || semantics.evidenceClasses[1] !== 'DETERMINISTIC_LOCAL_CLASSIFICATION'
      || semantics.rawTextIncluded !== false
      || semantics.redactedTextIncluded !== false
      || semantics.tokenMapIncluded !== false
      || semantics.assemblyExecuted !== false
      || semantics.deploymentExecuted !== false
      || semantics.runtimeProbeExecuted !== false
      || semantics.businessAcceptanceProven !== false) throw new SidecarError('INVALID_REQUEST')
  }

  const facts = record(payload.facts)
  exactKeys(facts, payload.schemaVersion === 1
    ? ['plan', 'counts', 'acceptance', 'findings', 'evidence']
    : ['plan', 'counts', 'acceptance', 'findings', 'evidence', 'contentPrivacy'])
  const plan = record(facts.plan)
  exactKeys(plan, ['status', 'canAssemble', 'lockWouldWrite'])
  if (!['READY', 'BLOCKED'].includes(plan.status)) throw new SidecarError('INVALID_REQUEST')
  boolean(plan.canAssemble)
  boolean(plan.lockWouldWrite)

  const counts = record(facts.counts)
  exactKeys(counts, COUNT_KEYS)
  for (const key of COUNT_KEYS) nonnegativeInteger(counts[key])

  const acceptance = record(facts.acceptance)
  exactKeys(acceptance, ['declared', 'structurallyValidated', 'executable', 'executed', 'status'])
  for (const key of ['declared', 'structurallyValidated', 'executable', 'executed']) nonnegativeInteger(acceptance[key])
  if (!['NOT_RUN', 'SPEC_ONLY'].includes(acceptance.status)) throw new SidecarError('INVALID_REQUEST')

  const findings = record(facts.findings)
  exactKeys(findings, ['blockersByCode', 'warningsByCode'])
  validateFindingCounts(findings.blockersByCode)
  validateFindingCounts(findings.warningsByCode)

  const evidence = record(facts.evidence)
  exactKeys(evidence, EVIDENCE_KEYS)
  for (const key of EVIDENCE_KEYS) validateStatusCounts(evidence[key])
  if (payload.schemaVersion === 2) validateContentPrivacy(facts.contentPrivacy)
  return payload
}

export function validateRequest(value) {
  const wrapper = record(value)
  exactKeys(wrapper, ['schemaVersion', 'kind', 'outgoingDigest', 'payload'])
  if (wrapper.schemaVersion !== 1 || wrapper.kind !== REQUEST_KIND
    || typeof wrapper.outgoingDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(wrapper.outgoingDigest)) throw new SidecarError('INVALID_REQUEST')
  const payload = validatePayload(wrapper.payload)
  const payloadCanonical = canonicalJson(payload)
  if (sha256(payloadCanonical) !== wrapper.outgoingDigest) throw new SidecarError('DIGEST_MISMATCH')
  return { outgoingDigest: wrapper.outgoingDigest, payloadCanonical, payloadSchemaVersion: payload.schemaVersion }
}

function safeText(value, maxCharacters) {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maxCharacters
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/u.test(value)) {
    throw new SidecarError('INVALID_MODEL_OUTPUT')
  }
  return value
}

export function parseAdvice(text) {
  if (Buffer.byteLength(text) > MAX_ASSISTANT_BYTES) throw new SidecarError('OUTPUT_LIMIT_EXCEEDED')
  let value
  try { value = JSON.parse(text) } catch { throw new SidecarError('INVALID_MODEL_OUTPUT') }
  const advice = record(value)
  exactKeys(advice, ['schemaVersion', 'kind', 'verdict', 'summary', 'actions'], 'INVALID_MODEL_OUTPUT')
  if (advice.schemaVersion !== 1 || advice.kind !== ADVICE_KIND
    || !['READY_WITH_CONDITIONS', 'MANUAL_REVIEW', 'BLOCKED'].includes(advice.verdict)) {
    throw new SidecarError('INVALID_MODEL_OUTPUT')
  }
  safeText(advice.summary, MAX_SUMMARY_CODE_POINTS)
  if (!Array.isArray(advice.actions) || advice.actions.length > MAX_ACTIONS) throw new SidecarError('INVALID_MODEL_OUTPUT')
  for (const actionValue of advice.actions) {
    const action = record(actionValue)
    exactKeys(action, ['priority', 'text'], 'INVALID_MODEL_OUTPUT')
    if (!['P0', 'P1', 'P2', 'P3'].includes(action.priority)) throw new SidecarError('INVALID_MODEL_OUTPUT')
    safeText(action.text, MAX_ACTION_TEXT_CODE_POINTS)
  }
  return advice
}

async function canonicalPathInside(path, root) {
  const canonical = await realpath(path)
  const canonicalRoot = await realpath(root)
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}/`)) throw new SidecarError('MANIFEST_INVALID')
  return canonical
}

async function digestFile(path) {
  return sha256Hex(await readFile(path))
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('\0')) return false
  const segments = value.split('/')
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

async function verifyRuntimeClosure(manifest, rootPath) {
  const raw = await readFile(manifest.path)
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new SidecarError('MANIFEST_INVALID') }
  const closure = record(parsed)
  exactKeys(closure, ['schemaVersion', 'kind', 'entry', 'files'], 'MANIFEST_INVALID')
  if (closure.schemaVersion !== 1 || closure.kind !== 'effiengine.fde-harness-runtime-closure'
    || !safeRelativePath(closure.entry) || !Array.isArray(closure.files)
    || closure.files.length === 0 || closure.files.length > MAX_RUNTIME_CLOSURE_FILES) {
    throw new SidecarError('MANIFEST_INVALID')
  }
  if (Buffer.compare(raw, Buffer.from(`${canonicalJson(closure)}\n`)) !== 0) throw new SidecarError('MANIFEST_INVALID')
  if (sha256Hex(raw) !== manifest.sha256) throw new SidecarError('MANIFEST_DRIFT')

  const expected = new Map()
  let previous
  let expectedBytes = 0
  for (const fileValue of closure.files) {
    const file = record(fileValue)
    exactKeys(file, ['path', 'mode', 'size', 'sha256'], 'MANIFEST_INVALID')
    if (!safeRelativePath(file.path) || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777
      || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)
      || previous !== undefined && previous >= file.path) throw new SidecarError('MANIFEST_INVALID')
    expectedBytes += file.size
    if (expectedBytes > MAX_RUNTIME_CLOSURE_BYTES) throw new SidecarError('MANIFEST_INVALID')
    expected.set(file.path, file)
    previous = file.path
  }
  if (!expected.has(closure.entry)) throw new SidecarError('MANIFEST_INVALID')

  const seen = new Set()
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new SidecarError('MANIFEST_DRIFT')
      if (metadata.isDirectory()) {
        await visit(path, relativePath)
        continue
      }
      if (!metadata.isFile()) throw new SidecarError('MANIFEST_DRIFT')
      const file = expected.get(relativePath)
      if (file === undefined || metadata.size !== file.size || (metadata.mode & 0o777) !== file.mode) {
        throw new SidecarError('MANIFEST_DRIFT')
      }
      if (await digestFile(path) !== file.sha256) throw new SidecarError('MANIFEST_DRIFT')
      seen.add(relativePath)
    }
  }
  const rootMetadata = await lstat(rootPath)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new SidecarError('MANIFEST_DRIFT')
  await visit(rootPath)
  if (seen.size !== expected.size) throw new SidecarError('MANIFEST_DRIFT')
  return closure
}

function validateManifestShape(value) {
  const manifest = record(value)
  exactKeys(manifest, [
    'schemaVersion', 'kind', 'upstreamCommit', 'node', 'sidecar', 'config',
    'adapterProfile', 'replaySession', 'replayOverride', 'runtimeArtifact', 'runtimeClosure',
  ], 'MANIFEST_INVALID')
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'effiengine.fde-harness-runtime-manifest'
    || manifest.upstreamCommit !== UPSTREAM_COMMIT) throw new SidecarError('MANIFEST_INVALID')
  const node = record(manifest.node)
  exactKeys(node, ['path', 'version', 'sha256'], 'MANIFEST_INVALID')
  if (typeof node.path !== 'string' || node.path === '' || node.path.startsWith('/') || node.path.includes('\0')
    || node.version !== 'v22.22.0' || !/^[0-9a-f]{64}$/.test(node.sha256)) {
    throw new SidecarError('MANIFEST_INVALID')
  }
  for (const key of ['sidecar', 'config', 'adapterProfile', 'replaySession', 'replayOverride', 'runtimeArtifact']) {
    const item = record(manifest[key])
    exactKeys(item, ['path', 'sha256'], 'MANIFEST_INVALID')
    if (typeof item.path !== 'string' || item.path === '' || item.path.startsWith('/') || item.path.includes('\0')
      || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new SidecarError('MANIFEST_INVALID')
  }
  const runtimeClosure = record(manifest.runtimeClosure)
  exactKeys(runtimeClosure, ['path', 'root', 'sha256'], 'MANIFEST_INVALID')
  if (!safeRelativePath(runtimeClosure.path) || !safeRelativePath(runtimeClosure.root)
    || !/^[0-9a-f]{64}$/.test(runtimeClosure.sha256)) throw new SidecarError('MANIFEST_INVALID')
  return manifest
}

export async function verifyRuntimeManifest(options = {}) {
  const manifestPath = resolve(options.manifestPath ?? defaults.manifest)
  const raw = await readFile(manifestPath)
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new SidecarError('MANIFEST_INVALID') }
  const manifest = validateManifestShape(parsed)
  if (Buffer.compare(raw, Buffer.from(`${canonicalJson(manifest)}\n`)) !== 0) throw new SidecarError('MANIFEST_INVALID')
  const manifestDir = dirname(manifestPath)
  const paths = {}
  for (const key of ['sidecar', 'config', 'adapterProfile', 'replaySession', 'replayOverride', 'runtimeArtifact']) {
    const path = await canonicalPathInside(resolve(manifestDir, manifest[key].path), labRoot)
    if (await digestFile(path) !== manifest[key].sha256) throw new SidecarError('MANIFEST_DRIFT')
    paths[key] = path
  }
  paths.runtimeClosure = await canonicalPathInside(resolve(manifestDir, manifest.runtimeClosure.path), labRoot)
  paths.runtimeClosureRoot = await canonicalPathInside(resolve(manifestDir, manifest.runtimeClosure.root), labRoot)
  const runtimeClosure = await verifyRuntimeClosure({
    path: paths.runtimeClosure,
    sha256: manifest.runtimeClosure.sha256,
  }, paths.runtimeClosureRoot)
  if (paths.runtimeArtifact !== await realpath(join(paths.runtimeClosureRoot, runtimeClosure.entry))) {
    throw new SidecarError('MANIFEST_INVALID')
  }
  const nodePath = await realpath(resolve(manifestDir, manifest.node.path))
  if (await realpath(process.execPath) !== nodePath || process.version !== manifest.node.version
    || await digestFile(nodePath) !== manifest.node.sha256) {
    throw new SidecarError('MANIFEST_DRIFT')
  }
  return {
    manifest,
    manifestDigest: sha256Hex(raw),
    paths,
    nodePath,
    runtimeClosure,
  }
}

function replaceProfileParameters(template, parameters) {
  let result = template
  for (const [name, value] of Object.entries(parameters)) {
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    result = result.replaceAll(`@@${name}@@`, escaped)
  }
  if (/@@[A-Z_]+@@/.test(result)) throw new SidecarError('SANDBOX_FAILURE')
  return result
}

async function writePrivateFile(path, content) {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(content) } finally { await handle.close() }
}

function deadlinePromise(deadline, code) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.reject(new SidecarError(code))
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new SidecarError(code)), remaining)
    timer.unref?.()
  })
}

export class BoundedJsonRpcClient {
  constructor({ nodePath, runtimePath, configPath, sessionRoot, runtimeTmp, bootstrapRoot, replayFile, replayOverride }) {
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.waiters = []
    this.frameCount = 0
    this.totalFrameBytes = 0
    this.stderrBytes = 0
    this.stdoutBuffer = Buffer.alloc(0)
    const env = {
      PATH: '/usr/bin:/bin',
      TMPDIR: runtimeTmp,
      DSH_CORDIS_CONFIG: configPath,
      FDE_SIDECAR_SESSION_ROOT: sessionRoot,
      FDE_SIDECAR_REPLAY_FILE: replayFile,
      FDE_SIDECAR_REPLAY_OVERRIDE: replayOverride,
      NARB_DISABLE_NATIVE_CACHE: '1',
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    }
    this.child = spawn(nodePath, [runtimePath, configPath], {
      cwd: bootstrapRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The public launcher puts this adapter and its child runtime under one
      // deny-default Seatbelt profile. Keep the complete child tree in the
      // caller-owned process group.
      detached: false,
    })
    this.child.stdin.on('error', () => {})
    this.child.stdout.on('data', chunk => this.onStdout(chunk))
    this.child.stderr.on('data', chunk => {
      this.stderrBytes += chunk.length
      if (this.stderrBytes > MAX_STDERR_BYTES) this.fail(new SidecarError('STDERR_LIMIT_EXCEEDED'))
    })
    this.closeTask = new Promise(resolveClose => this.child.once('close', (code, signal) => {
      if (!this.closing) this.fail(new SidecarError('PROTOCOL_VIOLATION'))
      resolveClose({ code, signal })
    }))
    this.child.once('error', () => this.fail(new SidecarError('RUNTIME_START_FAILED')))
  }

  onStdout(chunk) {
    if (this.failed) return
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    if (this.stdoutBuffer.length > MAX_FRAME_BYTES && !this.stdoutBuffer.includes(0x0a)) {
      this.fail(new SidecarError('FRAME_TOO_LARGE'))
      return
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) return
      const line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.length === 0 || line.length > MAX_FRAME_BYTES) {
        this.fail(new SidecarError(line.length > MAX_FRAME_BYTES ? 'FRAME_TOO_LARGE' : 'PROTOCOL_VIOLATION'))
        return
      }
      this.frameCount += 1
      this.totalFrameBytes += line.length + 1
      if (this.frameCount > MAX_FRAMES) return this.fail(new SidecarError('FRAME_LIMIT_EXCEEDED'))
      if (this.totalFrameBytes > MAX_TOTAL_FRAME_BYTES) return this.fail(new SidecarError('OUTPUT_LIMIT_EXCEEDED'))
      let frame
      try { frame = JSON.parse(line.toString('utf8')) } catch { return this.fail(new SidecarError('PROTOCOL_VIOLATION')) }
      try { this.dispatch(frame) } catch (error) { this.fail(error) }
    }
  }

  dispatch(value) {
    const frame = record(value)
    if (frame.jsonrpc !== '2.0') throw new SidecarError('PROTOCOL_VIOLATION')
    if ((typeof frame.id === 'string' || typeof frame.id === 'number') && frame.method === undefined) {
      exactKeys(frame, ['jsonrpc', 'id', 'result'], 'PROTOCOL_VIOLATION')
      const key = String(frame.id)
      const pending = this.pending.get(key)
      if (pending === undefined) throw new SidecarError('PROTOCOL_VIOLATION')
      this.pending.delete(key)
      if ('error' in frame || !('result' in frame)) throw new SidecarError('PROTOCOL_VIOLATION')
      pending.resolve(frame.result)
      return
    }
    exactKeys(frame, ['jsonrpc', 'method', 'params'], 'PROTOCOL_VIOLATION')
    if (!['session.event', 'session.status'].includes(frame.method)) throw new SidecarError('UNKNOWN_NOTIFICATION')
    const params = record(frame.params)
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve({ method: frame.method, params })
    else this.notifications.push({ method: frame.method, params })
  }

  request(method, params, deadline, timeoutCode) {
    if (this.failed) return Promise.reject(this.failed)
    const id = this.nextId++
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    const response = new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(String(id), { resolve: resolveResponse, reject: rejectResponse })
      this.child.stdin.write(frame, error => {
        if (error) {
          this.pending.delete(String(id))
          rejectResponse(new SidecarError('PROTOCOL_VIOLATION'))
        }
      })
    })
    return Promise.race([response, deadlinePromise(deadline, timeoutCode)])
  }

  nextNotification(deadline) {
    const queued = this.notifications.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.failed) return Promise.reject(this.failed)
    const notification = new Promise((resolveNotification, rejectNotification) => {
      this.waiters.push({ resolve: resolveNotification, reject: rejectNotification })
    })
    return Promise.race([notification, deadlinePromise(deadline, 'TURN_TIMEOUT')])
  }

  fail(error) {
    if (this.failed) return
    this.failed = error instanceof SidecarError ? error : new SidecarError('SIDECAR_FAILURE')
    for (const pending of this.pending.values()) pending.reject(this.failed)
    this.pending.clear()
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failed)
    this.kill()
  }

  kill() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.stdin.destroy()
    this.child.kill('SIGKILL')
  }

  async close(deadline) {
    this.closing = true
    if (!this.failed && this.child.exitCode === null && this.child.signalCode === null) {
      try {
        await this.request('shutdown', {}, Math.min(deadline, Date.now() + 1_000), 'CLEANUP_FAILED')
      } catch {
        this.kill()
      }
    }
    this.child.stdin.end()
    let result
    try {
      result = await Promise.race([this.closeTask, deadlinePromise(deadline, 'CLEANUP_FAILED')])
    } catch (error) {
      this.fail(error)
      throw this.failed
    }
    if (this.stdoutBuffer.length !== 0 || this.pending.size !== 0
      || this.waiters.length !== 0 || this.notifications.length !== 0) {
      this.fail(new SidecarError('PROTOCOL_VIOLATION'))
    }
    if (result.code !== 0 || this.failed) {
      if (this.failed) throw this.failed
      throw new SidecarError('CLEANUP_FAILED')
    }
  }
}

const RAW_REASONING_KEYS = new Set([
  'reasoning', 'reasoning_content', 'thinking', 'signature', 'encrypted_content',
])
const RAW_REASONING_TYPES = new Set([
  'reasoning', 'reasoning-delta', 'thinking', 'redacted_thinking',
])

function rejectRawReasoningValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectRawReasoningValue(item)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (RAW_REASONING_KEYS.has(key)
      || key === 'type' && RAW_REASONING_TYPES.has(item)
      || key === 'blockType' && RAW_REASONING_TYPES.has(item)) {
      throw new SidecarError('RAW_REASONING_EXPOSED')
    }
    rejectRawReasoningValue(item)
  }
}

function validateEventSafety(event) {
  if (event.type === 'tool/call' || event.type === 'tool/result') throw new SidecarError('TOOLS_EXPOSED')
  rejectRawReasoningValue(event.data)
  if (event.type !== 'assistant/chunk') return
  const data = record(event.data)
  const chunk = record(data.chunk)
  if (chunk.type === 'tool-call-delta') throw new SidecarError('TOOLS_EXPOSED')
  if (!SAFE_ASSISTANT_CHUNK_TYPES.has(chunk.type)) throw new SidecarError('PROTOCOL_VIOLATION')
  if (chunk.type === 'block-start' && chunk.blockType !== 'text') {
    throw new SidecarError('PROTOCOL_VIOLATION')
  }
  if (chunk.type === 'block-end' && chunk.block?.type !== 'text') {
    throw new SidecarError('PROTOCOL_VIOLATION')
  }
}

function eventFrom(notification, sessionId) {
  if (notification.method !== 'session.event') return undefined
  const params = record(notification.params)
  if (params.sessionId !== sessionId) throw new SidecarError('PROTOCOL_VIOLATION')
  exactKeys(params, ['sessionId', 'event'], 'PROTOCOL_VIOLATION')
  const event = record(params.event)
  if (typeof event.type !== 'string') throw new SidecarError('PROTOCOL_VIOLATION')
  if (!ALLOWED_EVENT_TYPES.has(event.type)) throw new SidecarError('UNKNOWN_EVENT')
  validateEventSafety(event)
  return event
}

function matchingReceipt(event, messageId) {
  return event?.type === 'agent/inbox/spliced'
    && Array.isArray(event.data?.inserted)
    && event.data.inserted.some(message => message?.id === messageId)
}

function verifyEvents(events, messageId, payloadCanonical, { expectedTurn, expectedFirstSeq }) {
  const matchingReceipts = events.filter(event => matchingReceipt(event, messageId))
  const userMessages = events.filter(event => event.type === 'user/message')
  const assistants = events.filter(event => event.type === 'assistant/message')
  const turnStarts = events.filter(event => event.type === 'turn/start')
  const turnEnds = events.filter(event => event.type === 'turn/end')
  const toolEvents = events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
  const headers = events.filter(event => event.type === 'request/header')
  if (matchingReceipts.length !== 1 || userMessages.length !== 1 || assistants.length !== 1
    || turnStarts.length !== 1 || turnEnds.length !== 1 || toolEvents.length !== 0) {
    throw new SidecarError(toolEvents.length > 0 ? 'TOOLS_EXPOSED' : 'AMBIGUOUS_RESULT')
  }
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.seq !== expectedFirstSeq + index) throw new SidecarError('CONTINUATION_STALE')
  }
  if (turnStarts[0].data?.turn !== expectedTurn
    || turnEnds[0].data?.turn !== expectedTurn
    || turnEnds[0].data?.reason?.kind !== 'completed') {
    throw new SidecarError('AMBIGUOUS_RESULT')
  }
  for (const header of headers) {
    const tools = header.data?.header?.tools
    if (tools !== undefined && (!Array.isArray(tools) || tools.length !== 0)) throw new SidecarError('TOOLS_EXPOSED')
  }
  const userContent = userMessages[0].data?.content
  if (!Array.isArray(userContent) || userContent.length !== 1
    || userContent[0]?.type !== 'text' || userContent[0]?.text !== payloadCanonical) throw new SidecarError('AMBIGUOUS_RESULT')
  const content = assistants[0].data?.message?.content
  if (!Array.isArray(content) || !content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
    throw new SidecarError('AMBIGUOUS_RESULT')
  }
  return parseAdvice(content.map(block => block.text).join(''))
}

async function findSessionLog(sessionRoot) {
  const { readdir } = await import('node:fs/promises')
  const found = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'session.jsonl') found.push(path)
    }
  }
  await visit(sessionRoot)
  if (found.length !== 1) throw new SidecarError('PERSISTENCE_NOT_PROVEN')
  return found[0]
}

export function inspectDurableSession(logText, { sessionRoot }) {
  let rows
  try { rows = logText.trimEnd().split('\n').map(line => JSON.parse(line)) } catch {
    throw new SidecarError('CONTINUATION_STALE')
  }
  if (rows.length < 2) throw new SidecarError('CONTINUATION_STALE')
  const header = record(rows[0])
  exactKeys(header, ['type', 'version', 'id', 'createdAt', 'cwd', 'delegationDepth'], 'CONTINUATION_STALE')
  if (header.type !== 'session' || header.version !== 0
    || typeof header.id !== 'string' || header.id === ''
    || header.cwd !== sessionRoot || header.delegationDepth !== 0
    || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
    throw new SidecarError('CONTINUATION_STALE')
  }
  const persisted = rows.slice(1)
  let openTurn
  let completedTurn = 0
  for (let index = 0; index < persisted.length; index += 1) {
    const event = record(persisted[index])
    validateEventSafety(event)
    if (!ALLOWED_DURABLE_EVENT_TYPES.has(event.type)) throw new SidecarError('UNKNOWN_EVENT')
    if (event.seq !== index) throw new SidecarError('CONTINUATION_STALE')
    if (event.type === 'session/end-seed') {
      const data = record(event.data)
      exactKeys(data, [], 'CONTINUATION_STALE')
      if (openTurn !== undefined) throw new SidecarError('CONTINUATION_STALE')
    } else if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (openTurn !== undefined || turn !== completedTurn + 1) throw new SidecarError('CONTINUATION_STALE')
      openTurn = turn
    } else if (event.type === 'turn/end') {
      const turn = event.data?.turn
      if (openTurn !== turn || event.data?.reason?.kind !== 'completed') {
        throw new SidecarError('CONTINUATION_STALE')
      }
      completedTurn = turn
      openTurn = undefined
    }
  }
  if (openTurn !== undefined || completedTurn === 0
    || persisted.at(-1)?.type !== 'turn/end') throw new SidecarError('CONTINUATION_STALE')
  return {
    header,
    sessionIdentityDigest: sha256(canonicalJson(header)),
    persisted,
    eventCount: persisted.length,
    lastEventSeq: persisted.length - 1,
    completedTurn,
    eventDigest: sha256(persisted.map(event => canonicalJson(event)).join('\n')),
  }
}

export function verifyDurableSession(logText, { sessionId, sessionRoot, expectedEvents }) {
  let inspected
  try { inspected = inspectDurableSession(logText, { sessionRoot }) } catch (error) {
    if (error instanceof SidecarError
      && ['TOOLS_EXPOSED', 'RAW_REASONING_EXPOSED', 'UNKNOWN_EVENT'].includes(error.code)) throw error
    throw new SidecarError('PERSISTENCE_NOT_PROVEN')
  }
  if (inspected.header.id !== sessionId) throw new SidecarError('PERSISTENCE_NOT_PROVEN')
  const persisted = inspected.persisted
  if (persisted.length !== expectedEvents.length) throw new SidecarError('PERSISTENCE_NOT_PROVEN')
  for (let index = 0; index < persisted.length; index += 1) {
    if (canonicalJson(persisted[index]) !== canonicalJson(expectedEvents[index])) {
      throw new SidecarError('PERSISTENCE_NOT_PROVEN')
    }
  }
  return persisted
}

async function ensurePrivateDirectory(path, create) {
  if (create) await mkdir(path, { recursive: false, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new SidecarError('SANDBOX_FAILURE')
  return realpath(path)
}

async function proveSandboxActive() {
  try {
    await readFile('/private/etc/hosts')
  } catch (error) {
    if (error?.code === 'EPERM') return
    throw new SidecarError('SANDBOX_FAILURE')
  }
  throw new SidecarError('SANDBOX_FAILURE')
}

export class FdeHarnessSidecar {
  constructor(options) {
    this.sessionRoot = resolve(options.sessionRoot)
    this.runRoot = resolve(options.runRoot ?? join(this.sessionRoot, '..', `run-${randomUUID()}`))
    this.manifestPath = resolve(options.manifestPath ?? defaults.manifest)
    this.clientFactory = options.clientFactory
    this.precreatedRoots = options.precreatedRoots ?? false
    this.effectiveProfileDigest = options.effectiveProfileDigest
    this.sessionMode = options.sessionMode ?? 'start'
    this.expectedEventCount = options.expectedEventCount ?? 0
    this.expectedEventDigest = options.expectedEventDigest ?? EMPTY_EVENT_DIGEST
    this.expectedSessionIdentityDigest = options.expectedSessionIdentityDigest ?? null
  }

  async analyze(rawRequest) {
    if (process.platform !== 'darwin') throw new SidecarError('PLATFORM_UNSUPPORTED')
    await proveSandboxActive()
    const { outgoingDigest, payloadCanonical, payloadSchemaVersion } = validateRequest(rawRequest)
    if (this.sessionMode === 'resume' && payloadSchemaVersion !== 2) {
      throw new SidecarError('INVALID_REQUEST')
    }
    const verified = await verifyRuntimeManifest({ manifestPath: this.manifestPath })
    if (!/^sha256:[0-9a-f]{64}$/.test(this.effectiveProfileDigest ?? '')) {
      throw new SidecarError('SANDBOX_FAILURE')
    }
    await ensurePrivateDirectory(this.runRoot, !this.precreatedRoots)
    await ensurePrivateDirectory(this.sessionRoot, !this.precreatedRoots)
    const canonicalSessionRoot = await realpath(this.sessionRoot)
    let sessionId = `fde-${randomUUID()}`
    let prior = {
      persisted: [], eventCount: 0, lastEventSeq: -1, completedTurn: 0,
      eventDigest: EMPTY_EVENT_DIGEST,
    }
    if (this.sessionMode === 'resume') {
      let logText
      try { logText = await readFile(await findSessionLog(this.sessionRoot), 'utf8') } catch {
        throw new SidecarError('CONTINUATION_STALE')
      }
      prior = inspectDurableSession(logText, { sessionRoot: canonicalSessionRoot })
      if (prior.eventCount !== this.expectedEventCount
        || prior.eventDigest !== this.expectedEventDigest
        || prior.sessionIdentityDigest !== this.expectedSessionIdentityDigest) {
        throw new SidecarError('CONTINUATION_STALE')
      }
      sessionId = prior.header.id
    }
    const runtimeTmp = join(this.runRoot, 'runtime-tmp')
    await mkdir(runtimeTmp, { mode: 0o700 })
    const bootstrapRoot = join(this.runRoot, 'bootstrap')
    await mkdir(bootstrapRoot, { mode: 0o500 })
    await chmod(bootstrapRoot, 0o500)

    const createClient = this.clientFactory ?? (options => new BoundedJsonRpcClient(options))
    const client = createClient({
      nodePath: verified.nodePath,
      runtimePath: verified.paths.runtimeArtifact,
      configPath: verified.paths.config,
      sessionRoot: canonicalSessionRoot,
      runtimeTmp: await realpath(runtimeTmp),
      bootstrapRoot: await realpath(bootstrapRoot),
      replayFile: verified.paths.replaySession,
      replayOverride: verified.paths.replayOverride,
    })
    let events = []
    let result
    let failure
    try {
      const initialize = await client.request('initialize', {
        cwd: await realpath(this.sessionRoot),
        provider: 'fde-replay',
        model: 'aggregate-review-v1',
        maxTokens: 1024,
      }, Date.now() + INITIALIZE_TIMEOUT_MS, 'INITIALIZE_TIMEOUT')
      if (initialize?.serverInfo?.name !== SERVER_NAME || initialize?.serverInfo?.version !== SERVER_VERSION) {
        throw new SidecarError('PROTOCOL_VIOLATION')
      }
      const turnDeadline = Date.now() + TURN_TIMEOUT_MS
      let expectedFirstSeq = 0
      if (this.sessionMode === 'resume') {
        const resumed = await client.request('session/resume', { sessionId }, turnDeadline, 'TURN_TIMEOUT')
        const value = record(resumed)
        exactKeys(value, ['sessionId', 'durablePrefixCount', 'nextSeq'], 'PROTOCOL_VIOLATION')
        if (value.sessionId !== sessionId
          || value.durablePrefixCount !== prior.eventCount
          || value.nextSeq !== prior.eventCount + 1) throw new SidecarError('CONTINUATION_STALE')
        expectedFirstSeq = value.nextSeq
      }
      const prompt = await client.request('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text: payloadCanonical }],
      }, turnDeadline, 'TURN_TIMEOUT')
      if (typeof prompt?.messageId !== 'string' || prompt.messageId === '') throw new SidecarError('PROTOCOL_VIOLATION')
      let idle = false
      while (!idle) {
        const notification = await client.nextNotification(turnDeadline)
        if (notification.method === 'session.status') {
          exactKeys(notification.params, ['sessionId', 'status'], 'PROTOCOL_VIOLATION')
          if (notification.params.sessionId !== sessionId || !['running', 'idle'].includes(notification.params.status)) {
            throw new SidecarError('PROTOCOL_VIOLATION')
          }
          if (notification.params.status === 'idle') idle = true
          continue
        }
        const event = eventFrom(notification, sessionId)
        if (event !== undefined) events.push(event)
      }
      const suggestion = verifyEvents(events, prompt.messageId, payloadCanonical, {
        expectedTurn: prior.completedTurn + 1,
        expectedFirstSeq,
      })
      result = { suggestion }
    } catch (error) {
      failure = error instanceof SidecarError ? error : new SidecarError('SIDECAR_FAILURE')
      client.fail?.(failure)
    }

    try {
      await client.close(Date.now() + CLEANUP_TIMEOUT_MS)
    } catch (error) {
      failure ??= error instanceof SidecarError ? error : new SidecarError('CLEANUP_FAILED')
    }
    if (failure) throw failure

    const sessionLog = await findSessionLog(this.sessionRoot)
    const logBytes = await readFile(sessionLog)
    const logText = logBytes.toString('utf8')
    if (logText.includes(REQUEST_KIND) || logText.includes(outgoingDigest)) {
      throw new SidecarError('PERSISTENCE_NOT_PROVEN')
    }
    let finalInspection
    if (this.sessionMode === 'start') {
      const persisted = verifyDurableSession(logText, {
        sessionId, sessionRoot: canonicalSessionRoot, expectedEvents: events,
      })
      finalInspection = inspectDurableSession(logText, { sessionRoot: canonicalSessionRoot })
      if (persisted.length !== finalInspection.eventCount) throw new SidecarError('PERSISTENCE_NOT_PROVEN')
    } else {
      finalInspection = inspectDurableSession(logText, { sessionRoot: canonicalSessionRoot })
      if (finalInspection.header.id !== sessionId
        || finalInspection.eventCount !== prior.eventCount + 1 + events.length) {
        throw new SidecarError('PERSISTENCE_NOT_PROVEN')
      }
      for (let index = 0; index < prior.persisted.length; index += 1) {
        if (canonicalJson(finalInspection.persisted[index]) !== canonicalJson(prior.persisted[index])) {
          throw new SidecarError('PERSISTENCE_NOT_PROVEN')
        }
      }
      const marker = finalInspection.persisted[prior.eventCount]
      if (marker?.type !== 'session/end-seed' || marker.seq !== prior.eventCount
        || canonicalJson(marker.data) !== '{}') throw new SidecarError('PERSISTENCE_NOT_PROVEN')
      for (let index = 0; index < events.length; index += 1) {
        if (canonicalJson(finalInspection.persisted[prior.eventCount + 1 + index]) !== canonicalJson(events[index])) {
          throw new SidecarError('PERSISTENCE_NOT_PROVEN')
        }
      }
    }
    if (finalInspection.completedTurn !== prior.completedTurn + 1) {
      throw new SidecarError('PERSISTENCE_NOT_PROVEN')
    }
    const manifest = verified.manifest
    return {
      schemaVersion: 1,
      kind: RECEIPT_KIND,
      outgoingDigest,
      runtime: {
        upstreamCommit: UPSTREAM_COMMIT,
        manifestDigest: `sha256:${verified.manifestDigest}`,
        adapterTemplateDigest: `sha256:${manifest.adapterProfile.sha256}`,
        effectiveProfileDigest: this.effectiveProfileDigest,
        runtimeClosureDigest: `sha256:${manifest.runtimeClosure.sha256}`,
        runtimeArtifactDigest: `sha256:${manifest.runtimeArtifact.sha256}`,
        sidecarDigest: `sha256:${manifest.sidecar.sha256}`,
        providerMode: 'KEYLESS_REPLAY',
        modelInferenceExecuted: false,
        cloudProviderConfigured: false,
        networkPolicy: 'DENY_ALL_ENFORCED',
        toolsExposed: 0,
        fdeMutationExecuted: false,
        sessionPersistenceExecuted: true,
      },
      outcome: { status: 'COMPLETED', suggestion: result.suggestion },
      evidence: {
        inputDigest: outgoingDigest,
        resumeMode: this.sessionMode === 'start' ? 'STARTED' : 'RESUMED',
        priorEventDigest: prior.eventDigest,
        priorEventCount: prior.eventCount,
        eventDigest: finalInspection.eventDigest,
        eventCount: finalInspection.eventCount,
        lastEventSeq: finalInspection.lastEventSeq,
        completedTurn: finalInspection.completedTurn,
        sessionIdentityDigest: finalInspection.sessionIdentityDigest,
        providerContinuationDigest: null,
        rawReasoningPersisted: false,
        toolCallCount: 0,
      },
      authority: 'ADVISORY_ONLY',
    }
  }
}

export function sessionLockPathFor(sessionRoot) {
  return `${resolve(sessionRoot)}.fde-session.lock`
}

function safeSessionLockMetadata(metadata) {
  return metadata.isFile()
    && metadata.nlink === 1n
    && (metadata.mode & 0o177n) === 0n
    && (process.getuid?.() === undefined || metadata.uid === BigInt(process.getuid()))
}

async function acquireSessionLock(sessionRoot) {
  const path = sessionLockPathFor(sessionRoot)
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new SidecarError('SESSION_BUSY')
    throw new SidecarError('SANDBOX_FAILURE')
  }
  try {
    const metadata = await handle.stat({ bigint: true })
    if (!safeSessionLockMetadata(metadata)) throw new SidecarError('SANDBOX_FAILURE')
    return {
      handle,
      path: await realpath(path),
      device: String(metadata.dev),
      inode: String(metadata.ino),
    }
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(path).catch(() => {})
    if (error instanceof SidecarError) throw error
    throw new SidecarError('SANDBOX_FAILURE')
  }
}

async function releaseSessionLock(lock) {
  let failure
  try {
    const metadata = await lstat(lock.path, { bigint: true })
    if (!safeSessionLockMetadata(metadata)
      || String(metadata.dev) !== lock.device
      || String(metadata.ino) !== lock.inode) throw new SidecarError('CLEANUP_FAILED')
    await unlink(lock.path)
  } catch (error) {
    failure = error instanceof SidecarError ? error : new SidecarError('CLEANUP_FAILED')
  }
  try { await lock.handle.close() } catch { failure ??= new SidecarError('CLEANUP_FAILED') }
  if (failure !== undefined) throw failure
}

function parseCliArgs(argv) {
  if (argv.length === 2 && argv[0] === '--start-session-root' && typeof argv[1] === 'string') {
    const sessionRoot = resolve(argv[1])
    return {
      sessionMode: 'start', sessionRoot, runRoot: join(dirname(sessionRoot), `run-${randomUUID()}`),
      expectedEventCount: 0, expectedEventDigest: EMPTY_EVENT_DIGEST,
      expectedSessionIdentityDigest: null,
    }
  }
  if (argv.length === 8 && argv[0] === '--resume-session-root'
    && argv[2] === '--expected-event-count' && argv[4] === '--expected-event-digest'
    && argv[6] === '--expected-session-identity-digest') {
    const expectedEventCount = Number(argv[3])
    if (!Number.isSafeInteger(expectedEventCount) || expectedEventCount <= 0
      || String(expectedEventCount) !== argv[3]
      || !/^sha256:[0-9a-f]{64}$/.test(argv[5])
      || !/^sha256:[0-9a-f]{64}$/.test(argv[7])) throw new SidecarError('INVALID_REQUEST')
    const sessionRoot = resolve(argv[1])
    return {
      sessionMode: 'resume', sessionRoot, runRoot: join(dirname(sessionRoot), `run-${randomUUID()}`),
      expectedEventCount, expectedEventDigest: argv[5], expectedSessionIdentityDigest: argv[7],
    }
  }
  throw new SidecarError('INVALID_REQUEST')
}

function parseInternalCliArgs(argv) {
  if (argv.length !== 16 || argv[0] !== '--internal-session-mode'
    || !['start', 'resume'].includes(argv[1])
    || argv[2] !== '--internal-session-root' || argv[4] !== '--internal-run-root'
    || argv[6] !== '--manifest' || argv[8] !== '--expected-event-count'
    || argv[10] !== '--expected-event-digest'
    || argv[12] !== '--expected-session-identity-digest'
    || argv[14] !== '--session-lock-fd') throw new SidecarError('INVALID_REQUEST')
  const expectedEventCount = Number(argv[9])
  const expectedSessionIdentityDigest = argv[13] === 'null' ? null : argv[13]
  const sessionLockFd = Number(argv[15])
  if (!Number.isSafeInteger(expectedEventCount) || expectedEventCount < 0
    || String(expectedEventCount) !== argv[9]
    || !/^sha256:[0-9a-f]{64}$/.test(argv[11])
    || expectedSessionIdentityDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(expectedSessionIdentityDigest)
    || sessionLockFd !== SESSION_LOCK_FD || String(sessionLockFd) !== argv[15]
    || argv[1] === 'start' && (expectedEventCount !== 0
      || argv[11] !== EMPTY_EVENT_DIGEST || expectedSessionIdentityDigest !== null)
    || argv[1] === 'resume' && (expectedEventCount <= 0 || expectedSessionIdentityDigest === null)) {
    throw new SidecarError('INVALID_REQUEST')
  }
  return {
    sessionMode: argv[1], sessionRoot: resolve(argv[3]), runRoot: resolve(argv[5]),
    manifestPath: resolve(argv[7]), expectedEventCount, expectedEventDigest: argv[11],
    expectedSessionIdentityDigest, sessionLockFd,
  }
}

export async function verifyInternalLaunchProof(args, nonce) {
  if (!/^[0-9a-f]{64}$/.test(nonce ?? '')) throw new SidecarError('SANDBOX_FAILURE')
  const verified = await verifyRuntimeManifest({ manifestPath: args.manifestPath })
  if (await realpath(args.manifestPath) !== await realpath(defaults.manifest)) {
    throw new SidecarError('SANDBOX_FAILURE')
  }
  const proofPath = join(args.runRoot, 'launcher.proof')
  let proof
  try { proof = JSON.parse(await readFile(proofPath, 'utf8')) } catch { throw new SidecarError('SANDBOX_FAILURE') }
  const value = record(proof)
  exactKeys(value, [
    'schemaVersion', 'kind', 'nonceDigest', 'sessionRoot', 'runRoot', 'manifestDigest',
    'adapterTemplateDigest', 'effectiveProfileDigest', 'sessionMode',
    'expectedEventCount', 'expectedEventDigest', 'expectedSessionIdentityDigest',
    'sessionLockPath', 'sessionLockFd', 'sessionLockDevice', 'sessionLockInode',
  ], 'SANDBOX_FAILURE')
  const effectiveProfileDigest = sha256(await readFile(join(args.runRoot, 'adapter.generated.sb')))
  let lockMetadata
  try { lockMetadata = await fstatAsync(args.sessionLockFd, { bigint: true }) } catch {
    throw new SidecarError('SANDBOX_FAILURE')
  }
  const expectedLockPath = await realpath(sessionLockPathFor(args.sessionRoot))
  const lockPathMetadata = await lstat(expectedLockPath, { bigint: true })
  if (value.schemaVersion !== 1 || value.kind !== 'effiengine.fde-harness-launch-proof'
    || value.nonceDigest !== sha256(nonce)
    || value.sessionRoot !== await realpath(args.sessionRoot)
    || value.runRoot !== await realpath(args.runRoot)
    || value.sessionMode !== args.sessionMode
    || value.expectedEventCount !== args.expectedEventCount
    || value.expectedEventDigest !== args.expectedEventDigest
    || value.expectedSessionIdentityDigest !== args.expectedSessionIdentityDigest
    || value.sessionLockPath !== expectedLockPath
    || value.sessionLockFd !== args.sessionLockFd
    || !/^[0-9]+$/.test(value.sessionLockDevice)
    || !/^[0-9]+$/.test(value.sessionLockInode)
    || !safeSessionLockMetadata(lockMetadata)
    || !safeSessionLockMetadata(lockPathMetadata)
    || String(lockMetadata.dev) !== value.sessionLockDevice
    || String(lockMetadata.ino) !== value.sessionLockInode
    || String(lockPathMetadata.dev) !== value.sessionLockDevice
    || String(lockPathMetadata.ino) !== value.sessionLockInode
    || value.manifestDigest !== `sha256:${verified.manifestDigest}`
    || value.adapterTemplateDigest !== `sha256:${verified.manifest.adapterProfile.sha256}`
    || value.effectiveProfileDigest !== effectiveProfileDigest) {
    throw new SidecarError('SANDBOX_FAILURE')
  }
  try { await unlink(proofPath) } catch { throw new SidecarError('SANDBOX_FAILURE') }
  return effectiveProfileDigest
}

async function launchSandboxedAdapterLocked({
  sessionMode, sessionRoot, runRoot, expectedEventCount, expectedEventDigest,
  expectedSessionIdentityDigest,
}, sessionLock) {
  const verified = await verifyRuntimeManifest()
  await ensurePrivateDirectory(runRoot, true)
  await ensurePrivateDirectory(sessionRoot, sessionMode === 'start')
  const profileTemplate = await readFile(verified.paths.adapterProfile, 'utf8')
  const profile = replaceProfileParameters(profileTemplate, {
    NODE_PATH: verified.nodePath,
    SIDECAR_ROOT: await realpath(sidecarRoot),
    PRIVATE_PARENT: await realpath(dirname(runRoot)),
    RUN_ROOT: await realpath(runRoot),
    SESSION_ROOT: await realpath(sessionRoot),
    SESSION_LOCK_PATH: sessionLock.path,
  })
  const profilePath = join(runRoot, 'adapter.generated.sb')
  await writePrivateFile(profilePath, profile)
  const effectiveProfileDigest = sha256(profile)
  const nonce = randomBytes(32).toString('hex')
  const proof = {
    schemaVersion: 1,
    kind: 'effiengine.fde-harness-launch-proof',
    nonceDigest: sha256(nonce),
    sessionRoot: await realpath(sessionRoot),
    runRoot: await realpath(runRoot),
    manifestDigest: `sha256:${verified.manifestDigest}`,
    adapterTemplateDigest: `sha256:${verified.manifest.adapterProfile.sha256}`,
    effectiveProfileDigest,
    sessionMode,
    expectedEventCount,
    expectedEventDigest,
    expectedSessionIdentityDigest,
    sessionLockPath: sessionLock.path,
    sessionLockFd: SESSION_LOCK_FD,
    sessionLockDevice: sessionLock.device,
    sessionLockInode: sessionLock.inode,
  }
  await writePrivateFile(join(runRoot, 'launcher.proof'), `${canonicalJson(proof)}\n`)
  const env = {
    PATH: '/usr/bin:/bin',
    TMPDIR: runRoot,
    FDE_ADAPTER_SANDBOXED: '1',
    FDE_ADAPTER_LAUNCH_NONCE: nonce,
    NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
  }
  const child = spawn('/usr/bin/sandbox-exec', [
    '-f', profilePath,
    verified.nodePath, verified.paths.sidecar,
    '--internal-session-mode', sessionMode,
    '--internal-session-root', await realpath(sessionRoot),
    '--internal-run-root', await realpath(runRoot),
    '--manifest', await realpath(defaults.manifest),
    '--expected-event-count', String(expectedEventCount),
    '--expected-event-digest', expectedEventDigest,
    '--expected-session-identity-digest', expectedSessionIdentityDigest ?? 'null',
    '--session-lock-fd', String(SESSION_LOCK_FD),
  ], { cwd: runRoot, env, stdio: ['inherit', 'pipe', 'ignore', sessionLock.handle.fd] })
  const chunks = []
  let total = 0
  let overflow = false
  child.stdout.on('data', chunk => {
    total += chunk.length
    if (total > MAX_FRAME_BYTES + 1) {
      overflow = true
      child.kill('SIGKILL')
      return
    }
    chunks.push(chunk)
  })
  const result = await new Promise(resolveClose => {
    child.once('error', () => resolveClose({ code: null, signal: null }))
    child.once('close', (code, signal) => resolveClose({ code, signal }))
  })
  const output = Buffer.concat(chunks)
  if (overflow || result.signal !== null || ![0, 2].includes(result.code)
    || output.length === 0 || output.indexOf(0x0a) !== output.length - 1
    || output.subarray(0, output.length - 1).includes(0x0a)) throw new SidecarError('SANDBOX_FAILURE')
  return { output, exitCode: result.code }
}

async function launchSandboxedAdapter(args) {
  if (process.platform !== 'darwin') throw new SidecarError('PLATFORM_UNSUPPORTED')
  await ensurePrivateDirectory(dirname(args.sessionRoot), false)
  const sessionLock = await acquireSessionLock(args.sessionRoot)
  let execution
  try {
    execution = await launchSandboxedAdapterLocked(args, sessionLock)
  } finally {
    await releaseSessionLock(sessionLock)
  }
  process.stdout.write(execution.output)
  process.exitCode = execution.exitCode
}

async function readSingleInputLine() {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    total += chunk.length
    if (total > MAX_INPUT_LINE_BYTES + 1) throw new SidecarError('INPUT_TOO_LARGE')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  const newline = bytes.indexOf(0x0a)
  if (newline < 0 || newline !== bytes.length - 1 || bytes.subarray(0, newline).includes(0x0a)) {
    throw new SidecarError(newline >= 0 ? 'MULTIPLE_REQUESTS' : 'INVALID_REQUEST')
  }
  const line = bytes.subarray(0, newline)
  if (line.length === 0 || line.length > MAX_INPUT_LINE_BYTES || line.includes(0x0d)) throw new SidecarError('INVALID_REQUEST')
  try { return JSON.parse(line.toString('utf8')) } catch { throw new SidecarError('INVALID_REQUEST') }
}

export function errorReceipt(error) {
  const code = error instanceof SidecarError && ERROR_CODES.has(error.code) ? error.code : 'SIDECAR_FAILURE'
  return { schemaVersion: 1, kind: ERROR_KIND, error: { code } }
}

async function main() {
  try {
    const internalArgs = process.argv[2] === '--internal-session-mode'
    if (internalArgs) {
      if (process.env.FDE_ADAPTER_SANDBOXED !== '1') throw new SidecarError('SANDBOX_FAILURE')
      const args = parseInternalCliArgs(process.argv.slice(2))
      const effectiveProfileDigest = await verifyInternalLaunchProof(args, process.env.FDE_ADAPTER_LAUNCH_NONCE)
      await proveSandboxActive()
      const request = await readSingleInputLine()
      const receipt = await new FdeHarnessSidecar({
        ...args, precreatedRoots: true, effectiveProfileDigest,
      }).analyze(request)
      process.stdout.write(`${canonicalJson(receipt)}\n`)
    } else {
      if (process.env.FDE_ADAPTER_SANDBOXED !== undefined
        || process.env.FDE_ADAPTER_LAUNCH_NONCE !== undefined) throw new SidecarError('SANDBOX_FAILURE')
      await launchSandboxedAdapter(parseCliArgs(process.argv.slice(2)))
    }
  } catch (error) {
    process.stdout.write(`${canonicalJson(errorReceipt(error))}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
