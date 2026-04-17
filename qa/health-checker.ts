#!/usr/bin/env node
import { readFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import type { ServicesFile, ServiceConfig } from './src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const POLL_INTERVAL_MS = 5_000
const TIMEOUT_MS = 3 * 60 * 1_000

async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
    return res.ok
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const allFlag = args.includes('--all')
  const serviceIdx = args.indexOf('--service')
  const serviceFlag = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined

  if (!allFlag && !serviceFlag) {
    console.error('Usage: npx tsx qa/health-checker.ts --service <name> | --all')
    process.exit(1)
  }

  const qaDir = __dirname
  const servicesFile = yaml.load(
    readFileSync(join(qaDir, 'services.yaml'), 'utf-8')
  ) as ServicesFile
  const { base_url, services } = servicesFile

  let targets: Array<[string, ServiceConfig]>

  if (allFlag) {
    targets = Object.entries(services)
  } else {
    if (!services[serviceFlag!]) {
      console.error(`Unknown service: '${serviceFlag}'. Check qa/services.yaml.`)
      process.exit(1)
    }
    targets = [[serviceFlag!, services[serviceFlag!]]]
  }

  const deadline = Date.now() + TIMEOUT_MS
  const healthy = new Set<string>()

  console.log(`Waiting for ${targets.length} service(s) to become healthy (timeout: 3 min)...`)

  while (Date.now() < deadline) {
    for (const [name, config] of targets) {
      if (healthy.has(name)) continue
      const url = `${base_url}:${config.port}${config.health}`
      if (await isHealthy(url)) {
        healthy.add(name)
        console.log(`  ✓ ${name} healthy`)
      }
    }

    if (healthy.size === targets.length) {
      console.log('All targeted services are healthy.')
      process.exit(0)
    }

    const remaining = targets.filter(([n]) => !healthy.has(n)).map(([n]) => n)
    process.stdout.write(`  Still waiting: ${remaining.join(', ')}...\r`)
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }

  const stuck = targets.filter(([n]) => !healthy.has(n)).map(([n]) => n)
  console.error(`\nTimeout: services still unhealthy after 3 min: ${stuck.join(', ')}`)
  process.exit(1)
}

main().catch((err: unknown) => {
  console.error('health-checker crashed:', err)
  process.exit(1)
})
