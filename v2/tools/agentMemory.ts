import { execFile, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

interface RssSample {
  combined_peak_mb: number
  parent_at_peak_mb: number
  child_at_peak_mb: number
  samples_with_child: number
  samples: number
  max_sample_gap_ms: number
  mean_sample_interval_ms: number
}

const exec = promisify(execFile)
const root = fileURLToPath(new URL(path.extname(fileURLToPath(import.meta.url)) === '.ts' ? '..' : '../../..', import.meta.url))

export async function measureScan(home: string, data: string, source = false) {
  if (process.platform !== 'darwin') throw new Error('1 ms RSS sampling requires the macOS procstat tool')
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
  await exec(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json')])
  const sampler = path.join(root, 'build', 'procstat')
  mkdirSync(path.dirname(sampler), { recursive: true })
  await exec('swiftc', ['-O', path.join(root, 'tools', 'procstat.swift'), '-o', sampler])
  const scan = path.join(root, source ? 'tools/agentScan.ts' : 'build/js/tools/agentScan.js')
  const bin: string = source ? process.execPath : createRequire(import.meta.url)('electron')
  const env = source ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const { stdout: version } = await exec(bin, ['-p', 'JSON.stringify({electron:process.versions.electron ?? null,node:process.versions.node})'], { env })
  const gate = 'data:text/javascript,await new Promise(r=>process.stdin.once("data",r));process.stdin.destroy();process.execArgv.splice(0,2)'
  const child = spawn(bin, ['--import', gate, scan, '--home', home, '--data-dir', data, '--again'], { stdio: ['pipe', 'pipe', 'pipe'], env })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', (s: string) => (out += s))
  child.stdin.on('error', (error) => { err += error.message })
  child.stderr.setEncoding('utf8').on('data', (s: string) => (err += s))
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`scan exited ${code}: ${err}`)))
  })
  const samplerProcess = spawn(sampler, ['--root', String(child.pid), '--interval-s', '0.001', '--summary'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let samples = ''
  let samplingError = ''
  let started = false
  samplerProcess.stdout.setEncoding('utf8').on('data', (s: string) => {
    samples += s
    if (!started && samples.includes('{"ready":true}')) {
      started = true
      child.stdin.end('start\n')
    }
  })
  samplerProcess.stderr.setEncoding('utf8').on('data', (s: string) => (samplingError += s))
  const sampled = new Promise<RssSample>((resolve, reject) => {
    samplerProcess.once('error', reject)
    samplerProcess.once('close', (code) => {
      if (code !== 0) return reject(new Error(`RSS sampler exited ${code}: ${samplingError}`))
      try { resolve(JSON.parse(samples.trim().split('\n').pop()!)) }
      catch (err) { reject(err) }
    })
  })
  try {
    const [sample] = await Promise.all([sampled, exited])
    return { runtime: JSON.parse(version), entrypoint: scan, executable: bin, sample_interval_ms: 1, ...sample, passes: out.trim().split('\n').map((line) => JSON.parse(line)) }
  } catch (err) {
    child.kill()
    samplerProcess.kill()
    await exited.catch(() => {})
    throw err
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await measureScan(process.argv[2]!, process.argv[3]!, process.argv.includes('--source')), null, 2))
