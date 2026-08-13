import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { FdeAggregateSidecar, SidecarError, validateAggregateReview } from '../sidecar.mjs'

const execFileAsync = promisify(execFile)
const roots = []
const sidecars = []

function validInput(reviewId = 'REV-FICTION-0001', projectRef = 'PRJ-FICTION-ALPHA') {
  return {
    schema: 'fde.aggregate-review.v1',
    reviewId,
    projectRef,
    aggregate: {
      assetRegistry: { registered: 12, ingested: 5, installableSystems: 3 },
      quality: { passed: 8, total: 9 },
      workbench: { screens: 4, saveConnected: true },
      blockers: [{ code: 'DEMO_METADATA_GAP', count: 2 }],
    },
    privacy: {
      aggregateOnly: true,
      rawRowsIncluded: false,
      identifiersTokenized: true,
      sensitiveFieldsRemoved: true,
    },
  }
}

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `fde-sidecar-${label}-`))
  roots.push(root)
  return root
}

async function makeSidecar(projectRef, root) {
  const sidecar = new FdeAggregateSidecar({ projectRef, sessionRoot: root })
  sidecars.push(sidecar)
  return sidecar
}

afterEach(async () => {
  await Promise.allSettled(sidecars.splice(0).map(sidecar => sidecar.close()))
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('FDE aggregate-only Harness sidecar', () => {
  it('rejects raw or extra business fields before spawning a runtime', () => {
    const input = { ...validInput(), customerName: 'RAW_CUSTOMER_CANARY' }
    expect(() => validateAggregateReview(input, 'PRJ-FICTION-ALPHA')).toThrowError(SidecarError)
    input.privacy = { ...input.privacy, rawRowsIncluded: true }
    delete input.customerName
    expect(() => validateAggregateReview(input, 'PRJ-FICTION-ALPHA')).toThrow(/rawRowsIncluded must be false/)
  })

  it('runs two strictly sequential, tool-free turns on one isolated session', async () => {
    const root = await tempRoot('serial')
    const sidecar = await makeSidecar('PRJ-FICTION-ALPHA', root)
    const first = await sidecar.analyze(validInput())
    const second = await sidecar.analyze(validInput('REV-FICTION-0002'))

    expect(first.sessionId).toBe(second.sessionId)
    expect(first.messageId).not.toBe(second.messageId)
    expect(first.outcome.turn).toBe(1)
    expect(second.outcome.turn).toBe(2)
    expect(first.authority).toBe('advisory-only')
    expect(first.evidence.toolCallCount).toBe(0)
    expect(second.evidence.toolCallCount).toBe(0)
    expect([...first.evidence.eventTypes, ...second.evidence.eventTypes]).not.toContain('tool/call')
    expect(first.runtime.networkPolicy).toBe('deny-all')
    expect(first.runtime.writePolicy).toBe('session-root-only')

    await sidecar.close()
    const sessionFiles = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
    expect(sessionFiles).toHaveLength(1)
    const session = await readFile(join(root, sessionFiles[0]), 'utf8')
    expect(session).toContain('fde.aggregate-review.v1')
    expect(session).not.toContain('RAW_CUSTOMER_CANARY')
    expect(session).not.toContain('"type":"tool/call"')
    const headers = session.trimEnd().split('\n').map(line => JSON.parse(line))
      .filter(row => row.type === 'request/header')
    expect(headers.length).toBeGreaterThan(0)
    expect(headers.every(row => row.data.header.tools === undefined || row.data.header.tools.length === 0)).toBe(true)
  })

  it('fails closed on same-session concurrency instead of inventing prompt correlation', async () => {
    const root = await tempRoot('busy')
    const sidecar = await makeSidecar('PRJ-FICTION-ALPHA', root)
    const active = sidecar.analyze(validInput())
    await expect(sidecar.analyze(validInput('REV-FICTION-0002')))
      .rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await expect(active).resolves.toMatchObject({ outcome: { turn: 1, reason: 'completed' } })
  })

  it('enforces one active sidecar per project root and separates two projects', async () => {
    const rootA = await tempRoot('project-a')
    const rootB = await tempRoot('project-b')
    const a = await makeSidecar('PRJ-PROJECT-A', rootA)
    const duplicate = await makeSidecar('PRJ-PROJECT-A', rootA)
    await a.start()
    await expect(duplicate.start()).rejects.toMatchObject({ code: 'PROJECT_ALREADY_ACTIVE' })

    const b = await makeSidecar('PRJ-PROJECT-B', rootB)
    const [receiptA, receiptB] = await Promise.all([
      a.analyze(validInput('REV-PROJECT-A-01', 'PRJ-PROJECT-A')),
      b.analyze(validInput('REV-PROJECT-B-01', 'PRJ-PROJECT-B')),
    ])
    expect(receiptA.sidecarInstanceId).not.toBe(receiptB.sidecarInstanceId)
    expect(receiptA.sessionId).not.toBe(receiptB.sessionId)
    expect(receiptA.projectRef).toBe('PRJ-PROJECT-A')
    expect(receiptB.projectRef).toBe('PRJ-PROJECT-B')
  })

  it('proves the runtime Seatbelt profile denies network and writes outside the session root', async () => {
    const root = await realpath(await tempRoot('seatbelt'))
    const outside = join(tmpdir(), `fde-sidecar-denied-${Date.now()}`)
    const script = `
      const fs = require('node:fs'); const net = require('node:net');
      const result = {};
      try { fs.writeFileSync(process.argv[1] + '/allowed', 'ok'); result.inside = 'allowed' } catch (e) { result.inside = e.code }
      try { fs.writeFileSync(process.argv[2], 'no'); result.outside = 'allowed' } catch (e) { result.outside = e.code }
      const server = net.createServer();
      server.once('error', e => { result.network = e.code; console.log(JSON.stringify(result)) });
      server.listen(0, '127.0.0.1', () => { result.network = 'allowed'; server.close(() => console.log(JSON.stringify(result))) });
    `
    const profile = join(process.cwd(), 'fde-sidecar', 'runtime.sb')
    const { stdout } = await execFileAsync('/usr/bin/sandbox-exec', [
      '-D', `SESSION_ROOT=${root}`, '-f', profile,
      process.execPath, '-e', script, root, outside,
    ], { timeout: 5_000 })
    const result = JSON.parse(stdout.trim())
    expect(result.inside).toBe('allowed')
    expect(result.outside).not.toBe('allowed')
    expect(result.network).not.toBe('allowed')
  })

  it('exposes the exact newline JSON CLI boundary and returns an advisory receipt', async () => {
    const root = await tempRoot('cli')
    const bin = fileURLToPath(new URL('../sidecar.mjs', import.meta.url))
    const fixture = fileURLToPath(new URL('../fixtures/aggregate-review.jsonl', import.meta.url))
    const result = await execa(process.execPath, [
      bin, '--project-ref', 'PRJ-FICTION-ALPHA', '--session-root', root,
    ], {
      input: await readFile(fixture, 'utf8'),
      timeout: 15_000,
    })
    expect(result.stderr).toBe('')
    const line = JSON.parse(result.stdout)
    expect(line).toMatchObject({
      ok: true,
      receipt: {
        schema: 'fde.sidecar-receipt.v1',
        authority: 'advisory-only',
        reviewId: 'REV-FICTION-0001',
        outcome: { reason: 'completed' },
        evidence: { toolCallCount: 0 },
      },
    })
    expect(line.receipt.runtime.runtimeArtifactDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(line.receipt.runtime.adapterDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(line.receipt).not.toHaveProperty('input')
  })
})
