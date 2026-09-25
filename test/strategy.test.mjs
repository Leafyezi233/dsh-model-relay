/**
 * Tests for the group scheduling primitives.
 *
 * These are pure functions, which is the point of keeping them in their own
 * module: the ordering rules and the retry judgement are the parts most worth
 * pinning exactly, and they need no network, no DSH service, and no clock.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_STRATEGY,
  MAX_RETRY_429,
  RETRY_BUDGET_MS,
  RETRY_MAX_DELAY_MS,
  STRATEGIES,
  isRetryableRateLimit,
  normalizeRetry429,
  normalizeStrategy,
  orderLegs,
  retryDelayMs,
} from '../lib/strategy.js'

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

const LEGS = ['a_x', 'b_y', 'c_z', 'd_w']

/** A deterministic stand-in for Math.random. */
const sequence = (...values) => {
  let at = 0
  return () => values[at++ % values.length]
}

await test('an unknown strategy degrades to the default rather than throwing', () => {
  assert.equal(normalizeStrategy('nonsense'), DEFAULT_STRATEGY)
  assert.equal(normalizeStrategy(undefined), 'sequential')
  assert.equal(normalizeStrategy(42), 'sequential')
  for (const strategy of STRATEGIES) assert.equal(normalizeStrategy(strategy), strategy)
})

await test('a retry count is clamped to the accepted range', () => {
  assert.equal(normalizeRetry429(0), 0)
  assert.equal(normalizeRetry429(2), 2)
  assert.equal(normalizeRetry429(99), MAX_RETRY_429)
  assert.equal(normalizeRetry429(-1), 0)
  assert.equal(normalizeRetry429(1.5), 0)
  assert.equal(normalizeRetry429('2'), 0)
  assert.equal(normalizeRetry429(undefined), 0)
})

await test('sequential is the identity order and never moves the cursor', () => {
  const { legs, nextCursor } = orderLegs('sequential', LEGS, 2)
  assert.deepEqual(legs, LEGS)
  assert.equal(nextCursor, 0)
})

await test('round-robin rotates a full permutation and advances one step', () => {
  const first = orderLegs('round-robin', LEGS, 0)
  assert.deepEqual(first.legs, ['a_x', 'b_y', 'c_z', 'd_w'])
  assert.equal(first.nextCursor, 1)

  const second = orderLegs('round-robin', LEGS, first.nextCursor)
  assert.deepEqual(second.legs, ['b_y', 'c_z', 'd_w', 'a_x'])
  assert.equal(second.nextCursor, 2)

  // Walking the cursor all the way round returns to the start.
  let cursor = 0
  const seen = []
  for (let step = 0; step < LEGS.length; step += 1) {
    const result = orderLegs('round-robin', LEGS, cursor)
    seen.push(result.legs[0])
    cursor = result.nextCursor
  }
  assert.deepEqual(seen, LEGS, 'every candidate must lead exactly once per cycle')
})

await test('a rotation is a permutation, so no candidate is ever lost', () => {
  for (let cursor = 0; cursor < LEGS.length; cursor += 1) {
    const { legs } = orderLegs('round-robin', LEGS, cursor)
    assert.equal(legs.length, LEGS.length)
    assert.deepEqual([...legs].sort(), [...LEGS].sort())
  }
})

await test('an out-of-range cursor still produces a valid rotation', () => {
  for (const cursor of [-5, -1, 4, 9, 1e9]) {
    const { legs, nextCursor } = orderLegs('round-robin', LEGS, cursor)
    assert.deepEqual([...legs].sort(), [...LEGS].sort(), `cursor ${cursor}`)
    assert.ok(nextCursor >= 0 && nextCursor < LEGS.length, `cursor ${cursor} -> ${nextCursor}`)
  }
})

await test('random is a permutation, and the source is respected', () => {
  const { legs } = orderLegs('random', LEGS, 0, sequence(0.9, 0.1, 0.5, 0))
  assert.equal(legs.length, LEGS.length)
  assert.deepEqual([...legs].sort(), [...LEGS].sort())

  // A source that always returns the top of the range must not index past the
  // end; this is the boundary the clamp exists for.
  const clamped = orderLegs('random', LEGS, 0, () => 1)
  assert.deepEqual([...clamped.legs].sort(), [...LEGS].sort())
})

await test('an empty or single-candidate group is returned as-is', () => {
  for (const strategy of STRATEGIES) {
    assert.deepEqual(orderLegs(strategy, []).legs, [])
    assert.deepEqual(orderLegs(strategy, ['only_one']).legs, ['only_one'])
    assert.equal(orderLegs(strategy, []).nextCursor, 0)
  }
})

await test('only a rate limit is retryable, never an exhausted quota', () => {
  assert.equal(isRetryableRateLimit({ code: 'RATE_LIMIT' }), true)
  // These all map to HTTP 429 through statusForCode, which is exactly why the
  // judgement reads the code instead of the status.
  assert.equal(isRetryableRateLimit({ code: 'QUOTA' }), false)
  assert.equal(isRetryableRateLimit({ code: 'QUOTA_EXCEEDED' }), false)
  assert.equal(isRetryableRateLimit({ code: 'SERVER' }), false)
  assert.equal(isRetryableRateLimit({ code: 'AUTH' }), false)
  assert.equal(isRetryableRateLimit(undefined), false)
})

await test('the backoff grows and is capped', () => {
  assert.equal(retryDelayMs(1, 0), 250)
  assert.equal(retryDelayMs(2, 0), 500)
  assert.equal(retryDelayMs(3, 0), 1000)
  assert.equal(retryDelayMs(9, 0), RETRY_MAX_DELAY_MS, 'the backoff must not grow without bound')
})

await test("the provider's own retry hint wins over the local backoff", () => {
  assert.equal(retryDelayMs(1, 800), 800)
  // A hint beyond the budget is refused rather than slept through, so the
  // caller moves to the next candidate instead of waiting out a long quiet
  // period the provider asked for.
  assert.equal(retryDelayMs(1, RETRY_BUDGET_MS + 1), undefined)
  assert.equal(retryDelayMs(3, 5000), undefined)
})

await test('a candidate that already spent its budget gets no more retries', () => {
  assert.equal(retryDelayMs(1, 0, RETRY_BUDGET_MS - 250), 250)
  assert.equal(retryDelayMs(1, 0, RETRY_BUDGET_MS), undefined)
  assert.equal(retryDelayMs(2, 0, 1800), undefined, 'the next wait would exceed the budget')
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall scheduling tests passed')
}
