/**
 * Tests for the model-group store.
 *
 * Runs against a real temporary directory so atomic writes and the serialized
 * write queue are exercised for real rather than mocked.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayGroupStore, isValidGroupName } from '../lib/groups.js'

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

/** Run one case against a fresh temp directory that is always cleaned up. */
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gw-groups-'))
  try {
    return await fn(join(dir, 'groups.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await test('isValidGroupName accepts plain names and rejects underscores', () => {
  assert.equal(isValidGroupName('fast-chat'), true)
  assert.equal(isValidGroupName('g1'), true)
  assert.equal(isValidGroupName('a.b-c'), true)
  // An underscore would collide with the `<provider>_<model>` spelling.
  assert.equal(isValidGroupName('codebuddy_flash'), false)
  assert.equal(isValidGroupName('-leading'), false)
  assert.equal(isValidGroupName(''), false)
  assert.equal(isValidGroupName('a'.repeat(65)), false)
})

await test('a fresh store is empty and an absent file is not an error', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    assert.deepEqual(await store.all(), [])
    assert.equal(await store.get('nope'), undefined)
  })
})

await test('create persists a group and round-trips through a second store', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    const created = await store.create('fast-chat', ['codebuddy_deepseek-v4.1-flash', 'deepseek_deepseek-chat'])
    assert.equal(created.ok, true)
    assert.equal(created.group.id, 'fast-chat')

    const reopened = new GatewayGroupStore({ file })
    const hit = await reopened.get('fast-chat')
    assert.equal(hit.name, 'fast-chat')
    assert.deepEqual(hit.models, ['codebuddy_deepseek-v4.1-flash', 'deepseek_deepseek-chat'])
    assert.equal(hit.enabled, true)
  })
})

await test('create rejects a duplicate name, a bad name, and an empty candidate list', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    assert.equal((await store.create('g', ['a_b'])).ok, true)

    const duplicate = await store.create('g', ['c_d'])
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.error, /已存在/)

    assert.equal((await store.create('bad_name', ['a_b'])).ok, false)
    assert.equal((await store.create('g2', [])).ok, false)
    assert.equal((await store.create('g3', ['  '])).ok, false)
  })
})

await test('concurrent creates do not drop each other', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => store.create(`g${index}`, ['a_b'])),
    )
    const all = await store.all()
    assert.equal(all.length, 12, 'every queued create must survive')
  })
})

await test('update replaces candidates, renames, and toggles enabled', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'])

    assert.equal((await store.update('g', { models: ['c_d', 'e_f'] })).ok, true)
    assert.deepEqual((await store.get('g')).models, ['c_d', 'e_f'])

    assert.equal((await store.update('g', { name: 'h' })).ok, true)
    assert.equal(await store.get('g'), undefined)
    assert.notEqual(await store.get('h'), undefined)

    assert.equal((await store.update('h', { enabled: false })).ok, true)
    assert.equal((await store.get('h')).enabled, false)
  })
})

await test('update refuses an empty candidate list and a colliding rename', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('a', ['m_n'])
    await store.create('b', ['m_n'])

    assert.equal((await store.update('a', { models: [] })).ok, false)
    assert.equal((await store.update('a', { name: 'b' })).ok, false)
    assert.equal((await store.update('missing', { models: ['x_y'] })).ok, false)
  })
})

await test('remove deletes exactly one group', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('a', ['m_n'])
    await store.create('b', ['m_n'])
    assert.equal(await store.remove('a'), true)
    assert.equal(await store.remove('a'), false)
    assert.deepEqual((await store.all()).map((group) => group.name), ['b'])
  })
})

await test('a corrupt file degrades to empty instead of throwing', async () => {
  await withStore(async (file) => {
    await writeFile(file, '{ not json', 'utf8')
    const store = new GatewayGroupStore({ file })
    assert.deepEqual(await store.all(), [])
  })
})

await test('unusable stored entries are dropped rather than repaired', async () => {
  await withStore(async (file) => {
    await writeFile(file, JSON.stringify({
      version: 1,
      groups: [
        { name: 'good', models: ['a_b'], enabled: true },
        { name: 'bad_name', models: ['a_b'] },      // underscore
        { name: 'empty', models: [] },               // no candidates
        { name: 'notobject' },
        'garbage',
      ],
    }), 'utf8')
    const store = new GatewayGroupStore({ file })
    assert.deepEqual((await store.all()).map((group) => group.name), ['good'])
  })
})

await test('the persisted file is valid JSON with a versioned shape', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'])
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(Array.isArray(parsed.groups), true)
    assert.equal(parsed.groups[0].name, 'g')
  })
})

await test('a returned group is a copy, so mutating it cannot corrupt the store', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'])
    const first = await store.get('g')
    first.models.push('injected')
    assert.deepEqual((await store.get('g')).models, ['a_b'])
  })
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall group-store tests passed')
}
