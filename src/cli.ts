#!/usr/bin/env node
import { project, readJournal } from './query.js'
import type { ReadDiagnostic } from './query.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (!args.length || args[0] === '--help') {
    console.log('Usage: dsh-log-enhance query <journal-directory> [--max-records <count>]')
    return
  }
  if (args[0] !== 'query' || !args[1] || ![2, 4].includes(args.length) || (args.length === 4 && args[2] !== '--max-records')) {
    throw new Error('Invalid arguments; use --help')
  }
  const maxRecords = args[3] === undefined ? 100_000 : Number(args[3])
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new Error('Invalid --max-records')
  const diagnostics: ReadDiagnostic[] = []
  let omittedDiagnostics = 0
  const report = await project(readJournal(args[1], diagnostic => {
    if (diagnostics.length < 100) diagnostics.push(diagnostic)
    else omittedDiagnostics++
  }), maxRecords)
  console.log(JSON.stringify({ ...report, readDiagnostics: diagnostics, omittedDiagnostics }, null, 2))
  if (diagnostics.length) process.exitCode = 2
}

main().catch(() => {
  console.error('Query failed. Check arguments, journal access, schema compatibility and record limits; use --help.')
  process.exitCode = 1
})
