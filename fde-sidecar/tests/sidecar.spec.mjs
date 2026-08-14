import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoundedJsonRpcClient,
  SidecarError,
  canonicalJson,
  parseAdvice,
  validateRequest,
  verifyDurableSession,
  verifyInternalLaunchProof,
  verifyRuntimeManifest,
} from '../sidecar.mjs'

const execFileAsync = promisify(execFile)
const sidecarRoot = dirname(fileURLToPath(new URL('../sidecar.mjs', import.meta.url)))
const roots = []

async function fixture() {
  return JSON.parse((await readFile(join(sidecarRoot, 'fixtures/aggregate-review.jsonl'), 'utf8')).trim())
}

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `fde-sidecar-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('hardened FDE one-shot Harness sidecar', () => {
  it('accepts only the exact wrapper and canonical P0 digest', async () => {
    const input = await fixture()
    const checked = validateRequest(input)
    expect(checked.outgoingDigest).toBe(input.outgoingDigest)
    expect(checked.payloadCanonical).toBe(canonicalJson(input.payload))

    expect(() => validateRequest({ ...input, projectRef: 'FORBIDDEN' })).toThrowError(SidecarError)
    expect(() => validateRequest({ ...input, outgoingDigest: `sha256:${'0'.repeat(64)}` }))
      .toThrowError(expect.objectContaining({ code: 'DIGEST_MISMATCH' }))
  })

  it('counts summary and action limits as Unicode code points', () => {
    const advice = (summary, text) => JSON.stringify({
      schemaVersion: 1,
      kind: 'effiengine.fde-harness-advice',
      verdict: 'MANUAL_REVIEW',
      summary,
      actions: [{ priority: 'P1', text }],
    })
    expect(parseAdvice(advice('界'.repeat(500), '🙂'.repeat(300)))).toMatchObject({ verdict: 'MANUAL_REVIEW' })
    expect(() => parseAdvice(advice('界'.repeat(501), '🙂'.repeat(300))))
      .toThrowError(expect.objectContaining({ code: 'INVALID_MODEL_OUTPUT' }))
    expect(() => parseAdvice(advice('界'.repeat(500), '🙂'.repeat(301))))
      .toThrowError(expect.objectContaining({ code: 'INVALID_MODEL_OUTPUT' }))
  })

  it('pins the canonical manifest, fixed Node, runtime and enforced adapter profile before spawn', async () => {
    const verified = await verifyRuntimeManifest()
    const raw = await readFile(join(sidecarRoot, 'runtime-manifest.json'))
    expect(raw.toString()).toBe(`${canonicalJson(verified.manifest)}\n`)
    expect(verified.manifest.upstreamCommit).toBe('47f943859bef60e4160492346772ded9b24f765a')
    expect(verified.manifest.node).toMatchObject({ version: 'v22.22.0', path: expect.any(String) })
    expect(verified.manifestDigest).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(await realpath(verified.nodePath)).toBe(await realpath(process.execPath))
    expect(await realpath(resolve(sidecarRoot, verified.manifest.node.path))).toBe(verified.nodePath)
    expect(verified.paths.runtimeArtifact).toBe(await realpath(join(
      verified.paths.runtimeClosureRoot, verified.runtimeClosure.entry,
    )))
    expect(verified.runtimeClosure.files.length).toBeGreaterThan(1)
  })

  it('runs a real keyless replay, shuts down, then proves durable payload-only events', async () => {
    const parent = await tempRoot('real')
    const sessionRoot = join(parent, 'session-leaf')
    const input = await fixture()
    const execution = await execa(process.execPath, [
      join(sidecarRoot, 'sidecar.mjs'), '--session-root', sessionRoot,
    ], { input: `${JSON.stringify(input)}\n`, timeout: 5_000 })
    expect(execution.stderr).toBe('')
    const receipt = JSON.parse(execution.stdout)

    expect(Object.keys(receipt).sort()).toEqual([
      'authority', 'evidence', 'kind', 'outcome', 'outgoingDigest', 'runtime', 'schemaVersion',
    ])
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: 'effiengine.fde-harness-advice-receipt',
      outgoingDigest: input.outgoingDigest,
      authority: 'ADVISORY_ONLY',
      runtime: {
        providerMode: 'KEYLESS_REPLAY', modelInferenceExecuted: false,
        cloudProviderConfigured: false, networkPolicy: 'DENY_ALL_ENFORCED',
        toolsExposed: 0, fdeMutationExecuted: false, sessionPersistenceExecuted: true,
      },
      outcome: { status: 'COMPLETED' },
      evidence: { inputDigest: input.outgoingDigest, toolCallCount: 0 },
    })
    expect(Object.keys(receipt.runtime).sort()).toEqual([
      'adapterTemplateDigest', 'cloudProviderConfigured', 'effectiveProfileDigest',
      'fdeMutationExecuted', 'manifestDigest', 'modelInferenceExecuted', 'networkPolicy',
      'providerMode', 'runtimeArtifactDigest', 'runtimeClosureDigest', 'sessionPersistenceExecuted',
      'sidecarDigest', 'toolsExposed', 'upstreamCommit',
    ])
    for (const key of [
      'manifestDigest', 'adapterTemplateDigest', 'effectiveProfileDigest',
      'runtimeArtifactDigest', 'runtimeClosureDigest', 'sidecarDigest',
    ]) {
      expect(receipt.runtime[key]).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
    const manifest = (await verifyRuntimeManifest()).manifest
    expect(receipt.runtime.adapterTemplateDigest).toBe(`sha256:${manifest.adapterProfile.sha256}`)
    expect(receipt.runtime.runtimeClosureDigest).toBe(`sha256:${manifest.runtimeClosure.sha256}`)
    const runDirectory = (await readdir(parent, { withFileTypes: true }))
      .find(entry => entry.isDirectory() && entry.name.startsWith('run-'))
    expect(runDirectory).toBeDefined()
    const effectiveProfile = await readFile(join(parent, runDirectory.name, 'adapter.generated.sb'))
    expect(receipt.runtime.effectiveProfileDigest)
      .toBe(`sha256:${createHash('sha256').update(effectiveProfile).digest('hex')}`)
    expect(receipt.runtime).not.toHaveProperty('adapterProfileDigest')
    expect(receipt.runtime).not.toHaveProperty('profileDigest')
    expect(receipt.runtime).not.toHaveProperty('runtimeProfileDigest')
    const files = (await readdir(sessionRoot, { recursive: true })).filter(path => path.endsWith('session.jsonl'))
    expect(files).toHaveLength(1)
    const log = await readFile(join(sessionRoot, files[0]), 'utf8')
    expect(log).toContain('effiengine.fde-harness-aggregate-facts')
    expect(log).not.toContain('effiengine.fde-harness-sidecar-request')
    expect(log).not.toContain(input.outgoingDigest)
    expect(log).not.toContain('"type":"tool/call"')
    expect(JSON.parse(log.trimEnd().split('\n').at(-1))).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })
  })

  it('creates a fresh random Session for identical canonical bytes', async () => {
    const input = await fixture()
    const first = await tempRoot('fresh-a')
    const second = await tempRoot('fresh-b')
    await execa(process.execPath, [join(sidecarRoot, 'sidecar.mjs'), '--session-root', join(first, 'session')], {
      input: `${JSON.stringify(input)}\n`, timeout: 5_000,
    })
    await execa(process.execPath, [join(sidecarRoot, 'sidecar.mjs'), '--session-root', join(second, 'session')], {
      input: `${JSON.stringify(input)}\n`, timeout: 5_000,
    })
    const readHeader = async root => {
      const files = (await readdir(join(root, 'session'), { recursive: true })).filter(path => path.endsWith('session.jsonl'))
      return JSON.parse((await readFile(join(root, 'session', files[0]), 'utf8')).split('\n')[0])
    }
    expect((await readHeader(first)).id).not.toBe((await readHeader(second)).id)
  })

  it('rejects an effective adapter profile changed after the launch proof was written', async () => {
    const runRoot = await tempRoot('profile-proof')
    const sessionRoot = join(runRoot, 'session')
    await mkdir(sessionRoot, { mode: 0o700 })
    const nonce = 'a'.repeat(64)
    const verified = await verifyRuntimeManifest()
    const original = '(version 1)\n'
    const effectiveProfileDigest = `sha256:${createHash('sha256').update(original).digest('hex')}`
    await writeFile(join(runRoot, 'adapter.generated.sb'), original, { mode: 0o600 })
    await writeFile(join(runRoot, 'launcher.proof'), `${canonicalJson({
      schemaVersion: 1,
      kind: 'effiengine.fde-harness-launch-proof',
      nonceDigest: `sha256:${createHash('sha256').update(nonce).digest('hex')}`,
      sessionRoot: await realpath(sessionRoot),
      runRoot: await realpath(runRoot),
      manifestDigest: `sha256:${verified.manifestDigest}`,
      adapterTemplateDigest: `sha256:${verified.manifest.adapterProfile.sha256}`,
      effectiveProfileDigest,
    })}\n`, { mode: 0o600 })
    await writeFile(join(runRoot, 'adapter.generated.sb'), '(version 1)\n(allow default)\n')
    await expect(verifyInternalLaunchProof({
      sessionRoot,
      runRoot,
      manifestPath: join(sidecarRoot, 'runtime-manifest.json'),
    }, nonce)).rejects.toMatchObject({ code: 'SANDBOX_FAILURE' })
  })

  it('fails the public CLI before Session creation when one transitive carrier JS file is changed', async () => {
    const copyRoot = await mkdtemp(join(fileURLToPath(new URL('../../', import.meta.url)), '.fde-lab-copy-'))
    roots.push(copyRoot)
    const sidecarCopy = join(copyRoot, 'fde-sidecar')
    await cp(sidecarRoot, sidecarCopy, { recursive: true })
    const manifestPath = join(sidecarCopy, 'runtime-manifest.json')
    const copiedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    copiedManifest.node.path = relative(sidecarCopy, process.execPath)
    await writeFile(manifestPath, `${canonicalJson(copiedManifest)}\n`)
    const transitive = join(sidecarCopy, 'runtime-carrier', 'node_modules', '@deepseek-ai', 'dsh-agent', 'lib', 'index.js')
    await writeFile(transitive, `${await readFile(transitive, 'utf8')}\n// tampered\n`)
    const parent = await tempRoot('closure-tamper')
    const sessionRoot = join(parent, 'session')
    const execution = await execa(process.execPath, [
      join(sidecarCopy, 'sidecar.mjs'), '--session-root', sessionRoot,
    ], { input: `${JSON.stringify(await fixture())}\n`, reject: false, timeout: 5_000 })
    expect(execution.exitCode).toBe(2)
    expect(JSON.parse(execution.stdout)).toEqual({
      schemaVersion: 1,
      kind: 'effiengine.fde-harness-sidecar-error',
      error: { code: 'MANIFEST_DRIFT' },
    })
    await expect(readdir(sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('proves the enforced adapter profile blocks host read, write, network and unpinned exec', async () => {
    const parent = await tempRoot('sandbox')
    const privateParent = await realpath(parent)
    const runRoot = join(parent, 'run')
    const sessionRoot = join(parent, 'session')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(runRoot, { mode: 0o700 }); await mkdir(sessionRoot, { mode: 0o700 })
    const verified = await verifyRuntimeManifest()
    let profile = await readFile(verified.paths.adapterProfile, 'utf8')
    const parameters = {
      NODE_PATH: verified.nodePath, SIDECAR_ROOT: sidecarRoot,
      PRIVATE_PARENT: privateParent, RUN_ROOT: await realpath(runRoot),
      SESSION_ROOT: await realpath(sessionRoot),
    }
    for (const [key, value] of Object.entries(parameters)) profile = profile.replaceAll(`@@${key}@@`, value)
    const profilePath = join(runRoot, 'probe.sb'); await writeFile(profilePath, profile, { mode: 0o600 })
    const canary = join(tmpdir(), `fde-denied-canary-${Date.now()}`); await writeFile(canary, 'secret', { mode: 0o600 })
    roots.push(canary)
    const script = `
      const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'); const r={};
      try{fs.readFileSync(process.argv[1]);r.read='allowed'}catch(e){r.read=e.code}
      try{fs.writeFileSync(process.argv[1],'x');r.write='allowed'}catch(e){r.write=e.code}
      const s=net.createServer(); s.once('error',e=>{r.network=e.code; finish()});
      s.listen(0,'127.0.0.1',()=>{r.network='allowed';s.close(finish)});
      function finish(){const x=cp.spawnSync('/bin/sh',['-c','true']);r.spawn=x.error?.code??'allowed';console.log(JSON.stringify(r))}
    `
    const { stdout } = await execFileAsync('/usr/bin/sandbox-exec', [
      '-f', profilePath, verified.nodePath, '-e', script, canary,
    ], { cwd: runRoot, timeout: 5_000 })
    expect(JSON.parse(stdout)).toEqual({ read: 'EPERM', write: 'EPERM', network: 'EPERM', spawn: 'EPERM' })
  })

  it('keeps the public CLI one-line/one-request and fails closed on a second line', async () => {
    const parent = await tempRoot('cli')
    const input = `${JSON.stringify(await fixture())}\n${JSON.stringify(await fixture())}\n`
    await expect(execa(process.execPath, [
      join(sidecarRoot, 'sidecar.mjs'), '--session-root', join(parent, 'session'),
    ], { input, timeout: 5_000 })).rejects.toMatchObject({ exitCode: 2 })
  })

  it('waits for stdio close and rejects unknown or partial trailing JSON-RPC output', async () => {
    const makeClient = async mode => {
      const root = await tempRoot(`rpc-${mode}`)
      const { mkdir, writeFile } = await import('node:fs/promises')
      const runtimeTmp = join(root, 'tmp')
      const bootstrapRoot = join(root, 'bootstrap')
      const sessionRoot = join(root, 'session')
      await mkdir(runtimeTmp); await mkdir(bootstrapRoot); await mkdir(sessionRoot)
      const runtimePath = join(root, 'runtime.mjs')
      await writeFile(runtimePath, `
        import readline from 'node:readline'
        const mode = process.argv[2]
        const lines = readline.createInterface({ input: process.stdin })
        lines.on('line', line => {
          const frame = JSON.parse(line)
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }) + '\\n')
          if (frame.method === 'initialize' && mode === 'unknown') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'unexpected', params: {} }) + '\\n')
          }
          if (frame.method === 'initialize' && mode === 'duplicate') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }) + '\\n')
          }
          if (frame.method === 'shutdown') {
            if (mode === 'partial') process.stdout.write('{"jsonrpc":')
            process.exit(0)
          }
        })
      `)
      return new BoundedJsonRpcClient({
        nodePath: process.execPath,
        runtimePath,
        configPath: mode,
        sessionRoot,
        runtimeTmp,
        bootstrapRoot,
        replayFile: runtimePath,
        replayOverride: runtimePath,
      })
    }

    const unknown = await makeClient('unknown')
    await unknown.request('initialize', {}, Date.now() + 1_000, 'INITIALIZE_TIMEOUT')
    await expect(unknown.close(Date.now() + 1_000)).rejects.toMatchObject({ code: 'UNKNOWN_NOTIFICATION' })

    const duplicate = await makeClient('duplicate')
    await duplicate.request('initialize', {}, Date.now() + 1_000, 'INITIALIZE_TIMEOUT')
    await expect(duplicate.close(Date.now() + 1_000)).rejects.toMatchObject({ code: 'PROTOCOL_VIOLATION' })

    const partial = await makeClient('partial')
    await partial.request('initialize', {}, Date.now() + 1_000, 'INITIALIZE_TIMEOUT')
    await expect(partial.close(Date.now() + 1_000)).rejects.toMatchObject({ code: 'PROTOCOL_VIOLATION' })
  })

  it('rejects durable-only tool and extra-assistant events', async () => {
    const root = await tempRoot('durable-counterexamples')
    const canonicalRoot = await realpath(root)
    const header = {
      type: 'session', version: 0, id: 'fde-test', createdAt: 1,
      cwd: canonicalRoot, delegationDepth: 0,
    }
    const expected = [{ type: 'turn/end', seq: 0, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }]
    const check = rows => verifyDurableSession(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`, {
      sessionId: 'fde-test', sessionRoot: canonicalRoot, expectedEvents: expected,
    })

    expect(() => check([header, ...expected, { type: 'tool/call', seq: 1, time: 3, data: {} }]))
      .toThrowError(expect.objectContaining({ code: 'TOOLS_EXPOSED' }))
    expect(() => check([header, ...expected, { type: 'assistant/message', seq: 1, time: 3, data: {} }]))
      .toThrowError(expect.objectContaining({ code: 'PERSISTENCE_NOT_PROVEN' }))
  })

  it('keeps first payload read and validation inside the sandboxed branch', async () => {
    const source = await readFile(join(sidecarRoot, 'sidecar.mjs'), 'utf8')
    const main = source.slice(source.indexOf('async function main()'))
    const launcher = source.slice(
      source.indexOf('async function launchSandboxedAdapter'),
      source.indexOf('async function readSingleInputLine'),
    )
    expect(main).toMatch(/verifyInternalLaunchProof[\s\S]*proveSandboxActive\(\)[\s\S]*readSingleInputLine\(\)[\s\S]*\.analyze\(request\)/)
    expect(launcher).not.toContain('readSingleInputLine')
    expect(launcher).not.toContain('validateRequest')
    expect(launcher).not.toContain('process.stdin')
  })

  it('rejects an externally injected internal marker before creating a Session', async () => {
    const parent = await tempRoot('marker-injection')
    const sessionRoot = join(parent, 'session')
    const execution = await execa(process.execPath, [
      join(sidecarRoot, 'sidecar.mjs'), '--session-root', sessionRoot,
    ], {
      input: `${JSON.stringify(await fixture())}\n`,
      env: { FDE_ADAPTER_SANDBOXED: '1' },
      reject: false,
      timeout: 5_000,
    })
    expect(execution.exitCode).toBe(2)
    expect(JSON.parse(execution.stdout)).toEqual({
      schemaVersion: 1,
      kind: 'effiengine.fde-harness-sidecar-error',
      error: { code: 'SANDBOX_FAILURE' },
    })
    await expect(readdir(sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('owns creation of an absent Session leaf and rejects a pre-existing leaf', async () => {
    const parent = await tempRoot('leaf-contract')
    const leaf = join(parent, 'session')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(leaf, { mode: 0o700 })
    await expect(execa(process.execPath, [
      join(sidecarRoot, 'sidecar.mjs'), '--session-root', leaf,
    ], { input: `${JSON.stringify(await fixture())}\n`, timeout: 5_000 }))
      .rejects.toMatchObject({ exitCode: 2 })
  })
})
