/**
 * Tests for the API-key store.
 *
 * Runs against a real temporary directory so permission handling and atomic
 * writes are exercised for real rather than mocked.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayKeyStore, generateApiKey, hashApiKey, maskApiKey } from '../lib/keys.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gw-keys-'))
  try {
    return await fn(join(dir, 'keys.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await test('generateApiKey mints prefixed, unique, high-entropy keys', () => {
  const a = generateApiKey()
  const b = generateApiKey()
  assert.match(a, /^sk-dshgw-[A-Za-z0-9_-]{32}$/)
  assert.notEqual(a, b)
})

await test('maskApiKey keeps a recognizable head and tail but not the middle', () => {
  const key = 'sk-dshgw-abcdefghijklmnopqrstuvwxyz012345'
  const masked = maskApiKey(key)
  assert.match(masked, /^sk-dshgw-abcd…/)
  assert.equal(masked.endsWith(key.slice(-4)), true)
  assert.equal(masked.includes(key.slice(14, -4)), false)
})

await test('create returns the plaintext once and persists only its hash', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    const created = await store.create('laptop')
    assert.match(created.key, /^sk-dshgw-/)
    assert.equal(created.record.label, 'laptop')
    assert.equal(created.record.masked, maskApiKey(created.key))

    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes(created.key), false, 'the plaintext key must never reach disk')
    assert.equal(raw.includes(hashApiKey(created.key)), true, 'the hash must be stored')
  })
})

await test('the store file is written owner-only', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    await store.create('perm')
    const info = await stat(file)
    assert.equal(info.mode & 0o077, 0, `expected 0600, got ${(info.mode & 0o777).toString(8)}`)
  })
})

await test('verify accepts a created key and rejects anything else', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    const created = await store.create('a')
    assert.equal(await store.verify(created.key), true)
    assert.equal(await store.verify(`${created.key}x`), false)
    assert.equal(await store.verify('sk-dshgw-not-a-real-key'), false)
    assert.equal(await store.verify(''), false)
    assert.equal(await store.verify(undefined), false)
  })
})

await test('keys survive a reload from disk', async () => {
  await withStore(async (file) => {
    const first = new GatewayKeyStore({ file })
    const created = await first.create('persisted')
    const second = new GatewayKeyStore({ file })
    assert.equal(await second.verify(created.key), true)
    const listed = await second.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].label, 'persisted')
  })
})

await test('list never exposes a hash and is newest-first', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    await store.create('first')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.create('second')
    const listed = await store.list()
    assert.deepEqual(listed.map((entry) => entry.label), ['second', 'first'])
    for (const entry of listed) {
      assert.equal('hash' in entry, false)
      assert.equal('key' in entry, false)
    }
  })
})

await test('revoke removes exactly the targeted key', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    const a = await store.create('a')
    const b = await store.create('b')
    assert.equal(await store.revoke(a.record.id), true)
    assert.equal(await store.revoke(a.record.id), false, 'revoking twice reports no removal')
    assert.equal(await store.verify(a.key), false)
    assert.equal(await store.verify(b.key), true)
    assert.equal(await store.count(), 1)
  })
})

await test('a fresh store is open, and creating a key locks it', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    assert.equal(await store.isLocked(), false, 'a store that never held a key is open')
    await store.create('first')
    assert.equal(await store.isLocked(), true)
  })
})

await test('revoking the last key keeps the gateway locked', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    const created = await store.create('only')
    await store.revoke(created.record.id)
    assert.equal(await store.count(), 0)
    // The critical property: deleting a key must never widen access.
    assert.equal(await store.isLocked(), true, 'the endpoint must stay locked after the last key is removed')
    assert.equal(await store.verify(created.key), false)

    // The lock survives a reload, too.
    const reloaded = new GatewayKeyStore({ file })
    assert.equal(await reloaded.isLocked(), true)
  })
})

await test('setLocked opens and closes the gateway explicitly', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    await store.create('k')
    await store.revoke((await store.list())[0].id)
    assert.equal(await store.isLocked(), true)
    await store.setLocked(false)
    assert.equal(await store.isLocked(), false, 'an explicit unlock reopens the endpoint')
    await store.setLocked(true)
    assert.equal(await store.isLocked(), true)
    const reloaded = new GatewayKeyStore({ file })
    assert.equal(await reloaded.isLocked(), true)
  })
})

await test('concurrent creates do not lose keys', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    // Writes are serialized: an unserialized read-modify-write would drop some.
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => store.create(`k${i}`)))
    assert.equal(await store.count(), 12)
    for (const entry of created) assert.equal(await store.verify(entry.key), true)
  })
})

await test('a corrupt store degrades to empty instead of throwing', async () => {
  await withStore(async (file) => {
    await writeFile(file, '{ not json', { mode: 0o600 })
    const store = new GatewayKeyStore({ file })
    assert.equal(await store.count(), 0)
    assert.equal(await store.verify('sk-dshgw-whatever'), false)
  })
})

await test('a world-readable store is treated as absent until rewritten', async () => {
  await withStore(async (file) => {
    const seeded = new GatewayKeyStore({ file })
    const created = await seeded.create('insecure')
    // Loosen the mode, then confirm a fresh store refuses to trust it.
    await (await import('node:fs/promises')).chmod(file, 0o644)
    const store = new GatewayKeyStore({ file })
    assert.equal(await store.count(), 0, 'keys from a world-readable file must not be trusted')
    assert.equal(await store.verify(created.key), false)
  })
})

await test('a missing store reads as empty and creating still works', async () => {
  await withStore(async (file) => {
    const store = new GatewayKeyStore({ file })
    assert.equal(await store.count(), 0)
    const created = await store.create()
    assert.equal(await store.verify(created.key), true)
    assert.equal(created.record.label, '未命名')
  })
})

await test('a renamed plugin reads the pre-rename store instead of silently unlocking', async () => {
  // Renaming the plugin changes the default store filename. If the new path
  // were simply treated as absent, `locked` would read false and an endpoint
  // that was key-protected would reopen without anyone deciding that.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mr-legacy-'))
  try {
    const legacy = join(dir, 'openai-gateway-keys.json')
    const current = join(dir, 'model-relay-keys.json')
    const key = generateApiKey()
    await writeFile(legacy, `${JSON.stringify({
      version: 1,
      keys: [{ id: 'legacy-1', hash: hashApiKey(key), masked: maskApiKey(key), label: 'before', createdAt: Date.now() }],
      locked: true,
    }, null, 2)}\n`, { mode: 0o600 })

    const store = new GatewayKeyStore({ file: current, legacyFile: legacy })
    assert.equal(await store.isLocked(), true, 'the pre-rename lock still applies')
    assert.equal(await store.verify(key), true, 'the pre-rename key still authenticates')

    // A write moves the state to the current path.
    await store.create('after')
    const moved = JSON.parse(await readFile(current, 'utf8'))
    assert.equal(moved.locked, true)
    assert.equal(moved.keys.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('an explicit store path never falls back to the shared legacy file', async () => {
  // An isolated store must stay isolated; otherwise tests and profiles that
  // move the store deliberately would inherit unrelated keys.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mr-isolated-'))
  try {
    const store = new GatewayKeyStore({ file: join(dir, 'custom.json') })
    assert.equal(store.legacyFile, undefined)
    assert.equal(await store.isLocked(), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log(failures === 0 ? '\nAll key store tests passed.' : `\n${failures} test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
