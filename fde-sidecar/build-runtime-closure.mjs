#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const labRoot = resolve(import.meta.dirname, '..')
const packageRoot = join(import.meta.dirname, 'runtime-package')
const carrierRoot = join(import.meta.dirname, 'runtime-carrier')
const closurePath = join(import.meta.dirname, 'runtime-closure.json')
const deployPackage = 'dsh-fde-sidecar-runtime'
const allowedRuntimeSuffixes = ['.js', '.cjs', '.mjs', '.json', '.node', '.wasm']

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: labRoot,
      env: { ...process.env, CI: 'true' },
      stdio: 'inherit',
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} failed with ${code === null ? `signal ${signal}` : `exit ${code}`}`))
    })
  })
}

async function findSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function materializeLinks() {
  const nodeModules = join(carrierRoot, 'node_modules')
  let link = await findSymlink(nodeModules)
  while (link !== undefined) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
    } else {
      const source = await realpath(link)
      const nestedNodeModules = join(source, 'node_modules')
      await unlink(link)
      await cp(source, link, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
      })
    }
    link = await findSymlink(nodeModules)
  }
}

async function restoreLegacyHoists() {
  const manifest = JSON.parse(await readFile(join(carrierRoot, 'package.json'), 'utf8'))
  const sourceNodeModules = join(packageRoot, 'node_modules')
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(carrierRoot, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) throw new Error(`missing deployed dependency ${dependency}`)
    const nestedNodeModules = join(source, 'node_modules')
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    })
  }
}

function keepRuntimeFile(path) {
  return allowedRuntimeSuffixes.some(suffix => path.endsWith(suffix))
}

async function pruneNonRuntimeFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await pruneNonRuntimeFiles(path)
      if ((await readdir(path)).length === 0) await rmdir(path)
    } else if (!entry.isFile() || !keepRuntimeFile(path)) {
      await rm(path, { force: true })
    }
  }
}

async function collectFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error(`runtime carrier contains symlink ${path}`)
    if (metadata.isDirectory()) await collectFiles(path, output)
    else if (metadata.isFile()) {
      const bytes = await readFile(path)
      output.push({
        path: relative(carrierRoot, path).split(sep).join('/'),
        mode: metadata.mode & 0o777,
        size: bytes.length,
        sha256: sha256(bytes),
      })
    } else throw new Error(`runtime carrier contains unsupported entry ${path}`)
  }
  return output
}

async function detachRegularFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await detachRegularFiles(path)
      continue
    }
    if (!entry.isFile()) throw new Error(`runtime carrier contains unsupported entry ${path}`)
    const metadata = await lstat(path)
    const detached = `${path}.fde-detached-${process.pid}`
    await writeFile(detached, await readFile(path), { flag: 'wx', mode: metadata.mode & 0o777 })
    await rename(detached, path)
  }
}

async function main() {
  await run(process.execPath, [
    join(labRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'scripts/verify-runtime-closure.ts', '--manifest', 'fde-sidecar/runtime-package/package.json',
  ])
  await rm(carrierRoot, { recursive: true, force: true })
  await run('pnpm', [
    '--filter', deployPackage, 'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted', '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true', '--config.allow-unused-patches=true', carrierRoot,
  ])
  await restoreLegacyHoists()
  await materializeLinks()
  await pruneNonRuntimeFiles(carrierRoot)
  await detachRegularFiles(carrierRoot)
  const files = (await collectFiles(carrierRoot)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const closure = {
    schemaVersion: 1,
    kind: 'effiengine.fde-harness-runtime-closure',
    entry: 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js',
    files,
  }
  const bytes = Buffer.from(`${canonicalJson(closure)}\n`)
  await writeFile(closurePath, bytes)
  process.stdout.write(`fde-sidecar runtime closure: ${files.length} files, sha256:${sha256(bytes)}\n`)
}

await main()
