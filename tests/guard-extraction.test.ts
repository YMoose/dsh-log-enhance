import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findRepositoryRoot, loadCoupling } from './seam/engine.js'
import type { ProbeSpec } from './seam/engine.js'
import { standardSpecs } from './seam/standard-specs.js'
import { IMPLICIT_SEAMS } from './contracts/implicit-seams.js'

/**
 * Guard extraction regression tests (2026-11-13): the probe prelude for each
 * upstream surface must come from WHERE THE PLUGIN ACTUALLY READS IT, not
 * from a hand-written dictionary. Three verified drift bugs motivated this:
 *
 * 1. `sourceEventSeqs` is read only inside `case 'tool/result'`
 *    (src/observer.ts:105) but the dictionary probed it under
 *    `user/message` — upstream could drop the tool/result field and the
 *    probe would stay green while the plugin breaks.
 * 2. `data.turn` is read at :100 (`tool/call`) and :107 (`step/start`);
 *    the dictionary probed it under `turn/start`, an event the plugin
 *    never even listens to.
 * 3. `data.step` misses its `tool/call` access at :100.
 *
 * These assertions import only `standardSpecs` — the public registration
 * API — so they kept working unchanged when the dictionary was replaced by
 * `probeSpecsFromCoupling` (the mechanical generator inside the engine).
 */

const ROOT = findRepositoryRoot('dsh-log-enhance')
const SPECS = standardSpecs(loadCoupling(ROOT), IMPLICIT_SEAMS)

/**
 * The old hand-written library returned one spec per path; the mechanical
 * generator returns one per access site. Accept both shapes so the same
 * assertion documents the drift (red) and the fix (green).
 */
function accessSpecs(key: string): readonly ProbeSpec[] {
  const specs: unknown = SPECS.fieldSpecs[key]
  return Array.isArray(specs) ? (specs as readonly ProbeSpec[]) : specs === undefined ? [] : [specs as ProbeSpec]
}

const preludeOf = (spec: ProbeSpec): string => (spec.prelude ?? []).join('\n')

test('sourceEventSeqs is probed under tool/result (the case that actually reads it)', () => {
  const specs = accessSpecs('@deepseek-ai/dsh-session::sourceEventSeqs')
  assert.ok(specs.length > 0, 'sourceEventSeqs must have a probe spec')
  assert.ok(
    specs.some(spec => preludeOf(spec).includes('tool/result')),
    `at least one probe must narrow to tool/result; got:\n${specs.map(preludeOf).join('\n')}`,
  )
  assert.ok(
    !specs.some(spec => preludeOf(spec).includes('user/message')),
    `no probe may narrow to user/message — the plugin never reads sourceEventSeqs there; got:\n${specs.map(preludeOf).join('\n')}`,
  )
})

test('data.turn has one probe per access site: tool/call and step/start, never turn/start', () => {
  const specs = accessSpecs('@deepseek-ai/dsh-session::data.turn')
  assert.equal(specs.length, 2, `data.turn is read at two sites; expected 2 probe specs, got ${specs.length}`)
  assert.ok(
    specs.some(spec => preludeOf(spec).includes('tool/call')),
    `a tool/call-guarded access (src/observer.ts:100) must exist; got:\n${specs.map(preludeOf).join('\n')}`,
  )
  assert.ok(
    specs.some(spec => preludeOf(spec).includes('step/start')),
    `a step/start-guarded access (src/observer.ts:107) must exist; got:\n${specs.map(preludeOf).join('\n')}`,
  )
  assert.ok(
    !JSON.stringify(specs).includes('turn/start'),
    `the plugin never reads data.turn under turn/start; specs: ${JSON.stringify(specs)}`,
  )
})

test('data.step includes the tool/call-guarded access at src/observer.ts:100', () => {
  const specs = accessSpecs('@deepseek-ai/dsh-session::data.step')
  assert.ok(
    specs.some(spec => preludeOf(spec).includes('tool/call')),
    `the tool/call access must be probed; got:\n${specs.map(preludeOf).join('\n')}`,
  )
  assert.ok(
    specs.some(spec => preludeOf(spec).includes('step/start')),
    `the step/start access must stay probed; got:\n${specs.map(preludeOf).join('\n')}`,
  )
})
