/**
 * Verifies that the DSH provider registration is wired correctly.
 *
 * The gateway registers itself as a provider so a model group is selectable
 * inside DSH. That registration touches three separate APIs, and getting any
 * one of them wrong fails silently — the card simply does not appear. This test
 * supplies a fake `llm` that records what was registered, so the wiring is
 * checked without a running harness.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

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

const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-reg-'))
let seq = 0
const files = () => ({ keysFile: join(dir, `k${seq}.json`), groupsFile: join(dir, `g${seq++}.json`) })

/** A fake context whose llm service records registration calls. */
function makeCtx({ withLlm = true, withSettings = true, efforts, window } = {}) {
  const registered = { providers: [], adapters: [], sections: [], disposed: 0 }
  const infos = []
  const warnings = []
  const capabilityReads = []
  const ctx = {
    logger: { info: (m) => infos.push(m), warn: (m) => warnings.push(m) },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') ctx.__disposers.push(dispose)
      return () => {}
    },
    __disposers: [],
    get: (key) => (key === 'settings' && withSettings ? { installSection: () => {} } : undefined),
    inject: (services, callback) => {
      callback({
        get: (key) => {
          if (key === 'settings' && withSettings) {
            return {
              installSection: (_c, ns, _schema, _value, _hooks) => {
                registered.sections.push(ns)
              },
            }
          }
          if (key === 'connection') {
            return { fetch: { register: async () => () => {} } }
          }
          return undefined
        },
      })
      return Promise.resolve()
    },
    webServer: { port: 3080, host: '127.0.0.1', register: () => () => {} },
  }
  if (withLlm) {
    ctx.llm = {
      listProviders: () => [{ id: 'codebuddy', name: 'CodeBuddy' }],
      listModels: async (provider) => [{ provider, id: 'glm-5.2', name: 'GLM' }],
      stream: () => (async function* generate() { yield { type: 'text-delta', index: 0, text: 'x' } })(),
      /**
       * Per-member capability, so the group's intersection is observable here.
       * `efforts` maps a model id to that member's declared list; an id absent
       * from the map stands for a member that declares no reasoning at all.
       * `window` overrides a member's capacity, including to undefined.
       */
      resolveModelInfo: async (provider, model) => {
        capabilityReads.push(`${provider}_${model}`)
        const contextWindow = window !== undefined && model in window ? window[model] : 128000
        return {
          provider,
          id: model,
          ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
          ...(efforts?.[model] === undefined ? {} : { reasoning: { efforts: efforts[model] } }),
        }
      },
      registerConfigurableProviders: (entries) => {
        registered.providers.push(...entries)
        return () => { registered.disposed += 1 }
      },
      registerAdapter: (providers, adapter) => {
        registered.adapters.push({ providers, adapter })
        return () => { registered.disposed += 1 }
      },
    }
  }
  return { ctx, registered, infos, warnings, capabilityReads }
}

/** Write a groups file naming the given members, and return the mount config. */
function groupsWith(members) {
  const config = files()
  writeFileSync(config.groupsFile, JSON.stringify({
    version: 1,
    groups: [{ id: 'g', name: 'g', models: members, enabled: true }],
  }))
  return config
}

await test('the gateway registers itself as a DSH provider', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, files())
  assert.equal(registered.providers.length, 1)
  const entry = registered.providers[0]
  assert.equal(entry.provider, 'dsh-model-relay')
  assert.equal(entry.displayName, 'dsh-model-relay')
  assert.equal(entry.settingsNs, 'llm-dsh-model-relay')
  assert.deepEqual(entry.settingsPath, [])
})

await test('the adapter is bound to that exact route and preserves the id', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, files())
  assert.equal(registered.adapters.length, 1)
  const { providers, adapter } = registered.adapters[0]
  assert.deepEqual(providers, ['dsh-model-relay'])
  // The runtime compares these; a mismatch throws INVALID_ADAPTER at load.
  assert.deepEqual(adapter.providerInfo('dsh-model-relay'), { id: 'dsh-model-relay', name: 'dsh-model-relay' })
})

await test('a settings section is installed under the provider namespace', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, files())
  // Without this the Models page silently omits the card: it renders a row
  // only when the namespace resolves in the settings mirror.
  assert.deepEqual(registered.sections, ['llm-dsh-model-relay'])
})

await test('both registrations are released together on dispose', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, files())
  for (const dispose of ctx.__disposers) dispose()
  assert.equal(registered.disposed, 2, 'provider and adapter registrations both released')
})

await test('a composition without llm still serves /v1', async () => {
  const { ctx, infos, warnings } = makeCtx({ withLlm: false })
  apply(ctx, files())
  assert.equal(infos.some((line) => line.includes('llm service not available')), true)
  assert.equal(warnings.length, 0, 'this is expected, not a warning')
})

await test('a missing settings service does not break registration', async () => {
  const { ctx, registered, warnings } = makeCtx({ withSettings: false })
  apply(ctx, files())
  assert.equal(registered.adapters.length, 1, 'the provider still registers')
  assert.equal(warnings.some((line) => typeof line === 'string' && line.includes('settings service absent')), true)
})

await test('a registration failure is contained and reported', async () => {
  const { ctx, infos } = makeCtx()
  ctx.llm.registerAdapter = () => { throw new Error('DUPLICATE_ADAPTER') }
  apply(ctx, files())
  assert.equal(infos.length > 0, true)
  // The gateway must keep working over /v1 even when the provider is refused.
  assert.equal(ctx.llm.listProviders().length, 1)
})

/**
 * The group's advertised efforts are computed by the gateway and handed to the
 * adapter, so these cases drive the real `groupCapabilities` walk through the
 * registered adapter rather than testing the adapter in isolation.
 */
const FOUR = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

await test('a group advertises the intersection of its members, never the union', async () => {
  const { ctx, registered } = makeCtx({
    efforts: {
      'glm-5.2': FOUR,
      'chat': [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  // `off` and `max` are offered by only one member: advertising them would let
  // a caller pick a level the other member rejects mid-request.
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['low', 'high'])
  assert.equal('defaultEffort' in resolved.reasoning, false)
})

await test('a member with no reasoning collapses the group to no choice at all', async () => {
  const { ctx, registered } = makeCtx({
    efforts: { 'glm-5.2': FOUR },
    // `chat` is absent from the map, so it declares no reasoning block — which
    // is a different statement from "supports none of these levels".
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  assert.equal('reasoning' in resolved, false)
  // Losing the effort choice must NOT cost the group its capacity: the two
  // facts are independent, and dropping capacity would silently switch
  // auto-compaction off for a long session over an unrelated field.
  assert.deepEqual(resolved.context, { contextWindow: 128000 })
})

await test('an unreadable member capacity does not erase a known effort set', async () => {
  const { ctx, registered } = makeCtx({
    efforts: { 'glm-5.2': FOUR, 'chat': FOUR },
    window: { 'chat': undefined },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  // The minimum over a partial walk is not the group's capacity, so it must be
  // omitted — but the reasoning answer is unaffected and still valid.
  assert.equal('context' in resolved, false)
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['off', 'low', 'high', 'max'])
})

await test('a group whose members all agree keeps the shared levels', async () => {
  const { ctx, registered } = makeCtx({ efforts: { 'glm-5.2': FOUR, 'chat': FOUR } })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['off', 'low', 'high', 'max'])
  assert.equal('defaultEffort' in resolved.reasoning, false)
})

await test('capacity and efforts come from the same single member walk', async () => {
  const { ctx, registered, capabilityReads } = makeCtx({
    efforts: { 'glm-5.2': FOUR, 'chat': FOUR },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  assert.deepEqual(resolved.context, { contextWindow: 128000 })
  // One read per member, not one per fact: the two answers are gathered
  // together, and the result is cached for the next catalog build.
  assert.equal(capabilityReads.length, 2, `expected one read per member, got ${capabilityReads.join(', ')}`)
})

await test('a group naming an unreachable member advertises nothing rather than guessing', async () => {
  const { ctx, registered } = makeCtx({ efforts: { 'glm-5.2': FOUR } })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'nosuch_glm-5.2']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  assert.equal('reasoning' in resolved, false)
  assert.equal('context' in resolved, false)
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall registration tests passed')
}
