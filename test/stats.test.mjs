/**
 * Tests for the group scoreboard.
 *
 * Pure logic with an injectable clock, so every assertion is about the
 * counting rules themselves: what is charged to a candidate, what is not, and
 * how a recovery becomes visible.
 */
import assert from 'node:assert/strict'
import {
  GroupStats,
  MAX_TRACKED_GROUPS,
  RECENT_WINDOW,
  blamesCandidate,
} from '../lib/stats.js'

let failures = 0
const test = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   - ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL - ${label}`)
    console.log(`       ${error.message}`)
  }
}

const GROUP = 'fast-chat'
const M1 = 'codebuddy_gpt-5'
const M2 = 'codebuddy_claude'

/** The snapshot row for one candidate, or a readable failure. */
const rowOf = (stats, group, model) => {
  const row = stats.snapshot()[group]?.candidates[model]
  assert.ok(row !== undefined, `no row for ${group}/${model}`)
  return row
}

await test('a failure that is not the candidate\'s fault is never blamed', () => {
  // These answer identically on the next candidate, so charging them to
  // whichever one happened to be first would blame a healthy model.
  for (const code of [
    'ABORTED',
    'CONTEXT_WINDOW_EXCEEDED',
    'INVALID_REQUEST',
    'INVALID_PREPARED_CALL',
    'UNSUPPORTED_CONTENT',
    'UNSUPPORTED_OPTION',
    'UNSUPPORTED_REASONING_EFFORT',
  ]) {
    assert.equal(blamesCandidate(code), false, `${code} must not blame the candidate`)
  }
})

await test('a genuine upstream failure is blamed', () => {
  for (const code of ['RATE_LIMIT', 'QUOTA', 'QUOTA_EXCEEDED', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'AUTH']) {
    assert.equal(blamesCandidate(code), true, `${code} must blame the candidate`)
  }
  // The catalog is open, so an unknown code is treated as an upstream fault
  // rather than silently excused.
  assert.equal(blamesCandidate('SOMETHING_UNMAPPED'), true)
  assert.equal(blamesCandidate(undefined), true)
})

await test('attempts and answers accumulate per candidate', () => {
  const stats = new GroupStats()
  stats.attempt(GROUP, M1)
  stats.attempt(GROUP, M1)
  stats.answered(GROUP, M1, 1000)
  stats.attempt(GROUP, M2)
  stats.answered(GROUP, M2, 1001)

  assert.equal(rowOf(stats, GROUP, M1).attempts, 2)
  assert.equal(rowOf(stats, GROUP, M1).answered, 1)
  assert.equal(rowOf(stats, GROUP, M2).attempts, 1)
  assert.equal(rowOf(stats, GROUP, M2).answered, 1)
})

await test('a retry is a separate attempt, so it shows up as a worse ratio', () => {
  const stats = new GroupStats()
  // One candidate needs three asks; the other answers first try. Both end
  // with one answer, which is exactly why attempts must not be conflated.
  stats.attempt(GROUP, M1)
  stats.rateLimited(GROUP, M1)
  stats.attempt(GROUP, M1)
  stats.rateLimited(GROUP, M1)
  stats.attempt(GROUP, M1)
  stats.answered(GROUP, M1, 1000)

  const row = rowOf(stats, GROUP, M1)
  assert.equal(row.attempts, 3)
  assert.equal(row.retry429, 2)
  assert.equal(row.answered, 1)
  assert.equal(row.refused, 0)
  assert.equal(row.ratio, 1, 'it did answer, so its ratio is 1')
})

await test('a refusal is charged to the candidate and remembers its code', () => {
  const stats = new GroupStats()
  stats.attempt(GROUP, M1)
  stats.refused(GROUP, M1, 'RATE_LIMIT', 5000)

  const row = rowOf(stats, GROUP, M1)
  assert.equal(row.refused, 1)
  assert.equal(row.answered, 0)
  assert.equal(row.lastCode, 'RATE_LIMIT')
  assert.equal(row.lastAt, 5000)
  assert.equal(row.ratio, 0)
})

await test('an oversized request is recorded but does not enter the ratio', () => {
  const stats = new GroupStats()
  // A healthy candidate that happens to receive one oversized request must
  // not be dragged down by it.
  stats.attempt(GROUP, M1)
  stats.refused(GROUP, M1, 'CONTEXT_WINDOW_EXCEEDED', 6000)
  stats.attempt(GROUP, M1)
  stats.answered(GROUP, M1, 6001)

  const row = rowOf(stats, GROUP, M1)
  assert.equal(row.ignored, 1, 'the oversized request is recorded, not dropped')
  assert.equal(row.refused, 0)
  assert.equal(row.ratio, 1, 'the ignored attempt must not enter the ratio')
  assert.equal(row.recentRatio, 1)
  assert.equal(row.lastCode, undefined, 'an excused failure must not set lastCode')
})

await test('a cancelled call is excused rather than charged', () => {
  const stats = new GroupStats()
  stats.attempt(GROUP, M1)
  stats.refused(GROUP, M1, 'ABORTED')
  const row = rowOf(stats, GROUP, M1)
  assert.equal(row.ignored, 1)
  assert.equal(row.refused, 0)
  assert.equal(row.ratio, undefined, 'nothing counted yet')
})

await test('a candidate that cannot be resolved is excused, not blamed', () => {
  const stats = new GroupStats()
  stats.unresolved(GROUP, M1)
  const row = rowOf(stats, GROUP, M1)
  assert.equal(row.ignored, 1)
  assert.equal(row.refused, 0)
  assert.equal(row.attempts, 0)
})

await test('the ratio is undefined until something was actually counted', () => {
  const stats = new GroupStats()
  // An attempt that has not concluded yet leaves the ratio undefined rather
  // than reporting 0%, which would read as "this candidate always fails".
  stats.attempt(GROUP, M1)
  const row = rowOf(stats, GROUP, M1)
  assert.equal(row.attempts, 1)
  assert.equal(row.ratio, undefined)
  assert.equal(row.recentRatio, undefined)
})

await test('the recent window is bounded and keeps only the newest outcomes', () => {
  const stats = new GroupStats()
  // 25 refusals then 20 answers: far more than the window holds.
  for (let i = 0; i < 25; i += 1) {
    stats.attempt(GROUP, M1)
    stats.refused(GROUP, M1, 'SERVER')
  }
  for (let i = 0; i < 20; i += 1) {
    stats.attempt(GROUP, M1)
    stats.answered(GROUP, M1)
  }

  const row = rowOf(stats, GROUP, M1)
  assert.equal(row.refused, 25, 'lifetime counters are not windowed')
  assert.equal(row.answered, 20)
  assert.equal(row.recentRatio, 1, 'the window holds only the 20 answers')
})

await test('a recovered candidate becomes visible in the recent window', () => {
  const stats = new GroupStats()
  // Broken this morning, fine now. The lifetime ratio can never recover, which
  // is precisely why the recent window exists.
  for (let i = 0; i < 30; i += 1) {
    stats.attempt(GROUP, M1)
    stats.refused(GROUP, M1, 'SERVER')
  }
  for (let i = 0; i < RECENT_WINDOW; i += 1) {
    stats.attempt(GROUP, M1)
    stats.answered(GROUP, M1)
  }

  const row = rowOf(stats, GROUP, M1)
  assert.equal(row.ratio, 20 / 50, 'the lifetime ratio stays poor')
  assert.equal(row.recentRatio, 1, 'but the recent window shows the recovery')
})

await test('request and all-failed counters are per group', () => {
  const stats = new GroupStats()
  stats.request(GROUP)
  stats.request(GROUP)
  stats.allFailed(GROUP)
  stats.request('other')

  const snap = stats.snapshot()
  assert.equal(snap[GROUP].requests, 2)
  assert.equal(snap[GROUP].allFailed, 1)
  assert.equal(snap.other.requests, 1)
  assert.equal(snap.other.allFailed, 0)
})

await test('renaming a group carries its history over rather than resetting it', () => {
  const stats = new GroupStats()
  stats.attempt(GROUP, M1)
  stats.refused(GROUP, M1, 'SERVER')
  stats.rename(GROUP, 'renamed')

  const snap = stats.snapshot()
  assert.equal(snap[GROUP], undefined, 'the old name is gone')
  assert.equal(snap.renamed.candidates[M1].refused, 1, 'the history survived the rename')
})

await test('renaming a group to its own name changes nothing', () => {
  const stats = new GroupStats()
  stats.attempt(GROUP, M1)
  stats.rename(GROUP, GROUP)
  assert.equal(rowOf(stats, GROUP, M1).attempts, 1)
})

await test('renaming a group that has no history is a no-op', () => {
  const stats = new GroupStats()
  stats.rename('never-seen', 'also-never-seen')
  assert.deepEqual(stats.snapshot(), {})
})

await test('a changed candidate list drops only the members that are gone', () => {
  const stats = new GroupStats()
  for (const model of [M1, M2]) {
    stats.attempt(GROUP, model)
    stats.refused(GROUP, model, 'SERVER')
  }
  stats.reconcile(GROUP, [M1])

  const snap = stats.snapshot()
  assert.equal(snap[GROUP].candidates[M1].refused, 1, 'a kept member keeps its history')
  assert.equal(snap[GROUP].candidates[M2], undefined, 'a removed member is forgotten')
})

await test('removing a group forgets everything about it', () => {
  const stats = new GroupStats()
  stats.attempt(GROUP, M1)
  stats.forget(GROUP)
  assert.equal(stats.snapshot()[GROUP], undefined)
})

await test('the table refuses new groups once it is full, and never throws', () => {
  const stats = new GroupStats({ maxGroups: 2 })
  stats.attempt('g1', M1)
  stats.attempt('g2', M1)
  stats.attempt('g3', M1)

  const snap = stats.snapshot()
  assert.equal(Object.keys(snap).length, 2)
  assert.equal(snap.g3, undefined, 'the third group is ignored, not tracked')
  // The already-tracked groups keep working.
  stats.answered('g1', M1)
  assert.equal(stats.snapshot().g1.candidates[M1].answered, 1)
})

await test('the default table is bounded too', () => {
  assert.ok(MAX_TRACKED_GROUPS > 0)
  assert.equal(new GroupStats().maxGroups, MAX_TRACKED_GROUPS)
})

await test('a snapshot is JSON-safe, so it can ride the settings response', () => {
  const stats = new GroupStats()
  stats.request(GROUP)
  stats.attempt(GROUP, M1)
  stats.answered(GROUP, M1, 1)
  stats.attempt(GROUP, M2)
  stats.refused(GROUP, M2, 'RATE_LIMIT', 2)
  stats.unresolved(GROUP, 'ghost_model')

  const parsed = JSON.parse(JSON.stringify(stats.snapshot()))
  assert.equal(parsed[GROUP].requests, 1)
  assert.equal(parsed[GROUP].candidates[M1].ratio, 1)
  assert.equal(parsed[GROUP].candidates[M2].ratio, 0)
  assert.equal(parsed[GROUP].candidates.ghost_model.ignored, 1)
  // An absent timestamp must be absent, not null: the UI branches on it.
  assert.equal('lastOkAt' in parsed[GROUP].candidates[M2], false)
})

await test('counting is per group, so one group cannot pollute another', () => {
  const stats = new GroupStats()
  stats.attempt('a', M1)
  stats.answered('a', M1)
  stats.attempt('b', M1)
  stats.refused('b', M1, 'SERVER')

  const snap = stats.snapshot()
  assert.equal(snap.a.candidates[M1].answered, 1)
  assert.equal(snap.a.candidates[M1].refused, 0)
  assert.equal(snap.b.candidates[M1].refused, 1)
  assert.equal(snap.b.candidates[M1].answered, 0)
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall stats tests passed')
}
