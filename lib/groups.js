/**
 * Persistent model-group store for the OpenAI gateway.
 *
 * A group is a named, ordered list of models the gateway already exposes. A
 * caller that names the group gets the first candidate that answers; the rest
 * are fallbacks. This is the whole feature: routing *within* a group is the
 * ordered list, nothing more. There are deliberately no conditions, weights, or
 * nested groups — a group is a list, and a list is a group.
 *
 * Model entries are stored in the gateway's own exposed spelling
 * (`<provider>_<model>`, see `exposedModelId` in `index.js`), not in some new
 * format. That is what lets the router resolve a group's candidates with the
 * exact same code path it uses for a directly-named model.
 *
 * Storage lives beside the key store but in its own file. The key store's
 * owner-only permission rule exists because that file is a credential store;
 * group definitions carry no such secret and folding them in would blur that
 * rule for no benefit.
 *
 * @module dsh-model-relay/groups
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/**
 * Characters a group name may use.
 *
 * The underscore is deliberately excluded. Every exposed model id is
 * `<provider>_<model>`, so a name without an underscore can never collide with
 * a model id — the two namespaces stay disjoint without any precedence rule.
 * A leading character must be alphanumeric so a name is never mistakable for a
 * flag or a path fragment.
 */
const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/

/** Longest accepted group name, so a listing stays readable. */
const MAX_NAME_LENGTH = 64

/** Most candidates one group may hold. */
const MAX_MODELS = 32

/** Default group store location inside the DSH home directory. */
export function defaultGroupsFile() {
  return dshHomePath('model-relay-groups.json')
}

/** Whether a string is usable as a group name. */
export function isValidGroupName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_NAME_LENGTH
    && GROUP_NAME_PATTERN.test(name)
}

/** An empty document, used when the file is absent or unusable. */
function emptyDocument() {
  return { version: 1, groups: [] }
}

/** Whether a value is a plain object, so a parsed entry can be inspected. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one stored entry, or return undefined when it cannot be salvaged.
 *
 * A group whose name or candidate list is unusable is dropped rather than
 * repaired: inventing a name or an empty candidate list would produce a group
 * that can never serve a request, which is worse than its absence.
 */
function normalizeStoredGroup(raw) {
  if (!isRecord(raw)) return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!isValidGroupName(name)) return undefined
  const models = Array.isArray(raw.models)
    ? raw.models.filter((model) => typeof model === 'string' && model.trim() !== '').map((model) => model.trim())
    : []
  if (models.length === 0) return undefined
  return {
    id: name,
    name,
    models: models.slice(0, MAX_MODELS),
    enabled: raw.enabled !== false,
  }
}

/**
 * File-backed group store with serialized writes.
 *
 * Mirrors the key store's write discipline for the same reason: two settings
 * page clicks must not interleave read-modify-write cycles and drop a group,
 * and a crash mid-write must leave the previous definition intact rather than
 * a truncated document.
 */
export class GatewayGroupStore {
  /**
   * @param options - store location and diagnostic sink.
   */
  constructor({ file, logger } = {}) {
    this.file = file ?? defaultGroupsFile()
    this.logger = logger
    /** Cached document; undefined until the first read. */
    this.document = undefined
    /** Serialized write chain tail. */
    this.tail = Promise.resolve()
  }

  /** Run one read-modify-write cycle after every queued one. */
  enqueue(task) {
    const run = this.tail.then(task, task)
    // Keep the chain alive after a failure so one bad write cannot poison the rest.
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Read the store, returning an empty document when absent or unreadable.
   *
   * Unlike the key store this file is not permission-gated: it holds routing
   * preferences, and treating a group definition as hostile because another
   * local user can read it would disable the feature for no gain.
   */
  async load() {
    if (this.document !== undefined) return this.document
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.(`dsh-model-relay: could not read the group store at ${this.file}`)
        this.logger?.warn?.(error)
      }
      this.document = emptyDocument()
      return this.document
    }
    try {
      const parsed = JSON.parse(raw)
      const groups = Array.isArray(parsed?.groups)
        ? parsed.groups.map(normalizeStoredGroup).filter((group) => group !== undefined)
        : []
      this.document = { version: 1, groups }
    } catch (error) {
      this.logger?.warn?.(`dsh-model-relay: ${this.file} is not valid JSON; treating it as empty`)
      this.logger?.warn?.(error)
      this.document = emptyDocument()
    }
    return this.document
  }

  /** Durably write the store. */
  async persist(document) {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }

  /** Every group, in insertion order. */
  async all() {
    const document = await this.load()
    return document.groups.map((group) => ({ ...group, models: [...group.models] }))
  }

  /** Look one group up by name (a group's id is always its name). */
  async get(name) {
    if (typeof name !== 'string' || name === '') return undefined
    const document = await this.load()
    const hit = document.groups.find((group) => group.name === name)
    return hit === undefined ? undefined : { ...hit, models: [...hit.models] }
  }

  /**
   * Create a group.
   *
   * Validation failures are reported rather than thrown so the settings page
   * can surface the reason; a caller that ignores the result still cannot store
   * an unusable group.
   * @param name - the group name, also its id.
   * @param models - ordered candidate list in exposed model spelling.
   * @returns `{ ok: true, group }` or `{ ok: false, error }`.
   */
  async create(name, models) {
    const clean = typeof name === 'string' ? name.trim() : ''
    if (!isValidGroupName(clean)) {
      return { ok: false, error: '分组名只能含字母、数字、- 和 .，且不能含下划线（下划线是模型名的分隔符）' }
    }
    const candidates = Array.isArray(models)
      ? models.filter((model) => typeof model === 'string' && model.trim() !== '').map((model) => model.trim())
      : []
    if (candidates.length === 0) return { ok: false, error: '至少需要一个候选模型' }
    if (candidates.length > MAX_MODELS) return { ok: false, error: `候选模型最多 ${MAX_MODELS} 个` }
    let failure
    await this.enqueue(async () => {
      const document = await this.load()
      if (document.groups.some((group) => group.name === clean)) {
        failure = `分组 ${clean} 已存在`
        return
      }
      const group = { id: clean, name: clean, models: candidates, enabled: true }
      const next = { version: 1, groups: [...document.groups, group] }
      await this.persist(next)
      this.document = next
    })
    if (failure !== undefined) return { ok: false, error: failure }
    return { ok: true, group: { id: clean, name: clean, models: candidates, enabled: true } }
  }

  /**
   * Update a group's candidate list, and optionally rename it.
   * @param id - the group's current name.
   * @param next - `{ models?, name?, enabled? }`.
   */
  async update(id, next = {}) {
    const candidates = Array.isArray(next.models)
      ? next.models.filter((model) => typeof model === 'string' && model.trim() !== '').map((model) => model.trim())
      : undefined
    if (candidates !== undefined && candidates.length === 0) return { ok: false, error: '至少需要一个候选模型' }
    if (candidates !== undefined && candidates.length > MAX_MODELS) return { ok: false, error: `候选模型最多 ${MAX_MODELS} 个` }
    const rename = typeof next.name === 'string' ? next.name.trim() : undefined
    if (rename !== undefined && rename !== id && !isValidGroupName(rename)) {
      return { ok: false, error: '分组名只能含字母、数字、- 和 .，且不能含下划线（下划线是模型名的分隔符）' }
    }
    let failure
    await this.enqueue(async () => {
      const document = await this.load()
      const index = document.groups.findIndex((group) => group.name === id)
      if (index === -1) {
        failure = '分组不存在'
        return
      }
      if (rename !== undefined && document.groups.some((group, at) => at !== index && group.name === rename)) {
        failure = `分组 ${rename} 已存在`
        return
      }
      const current = document.groups[index]
      const updated = {
        id: rename ?? current.id,
        name: rename ?? current.name,
        models: candidates ?? current.models,
        enabled: typeof next.enabled === 'boolean' ? next.enabled : current.enabled,
      }
      const groups = [...document.groups]
      groups[index] = updated
      const nextDocument = { version: 1, groups }
      await this.persist(nextDocument)
      this.document = nextDocument
    })
    if (failure !== undefined) return { ok: false, error: failure }
    return { ok: true }
  }

  /** Remove a group by name. */
  async remove(id) {
    let removed = false
    await this.enqueue(async () => {
      const document = await this.load()
      const groups = document.groups.filter((group) => group.name !== id)
      if (groups.length === document.groups.length) return
      const next = { version: 1, groups }
      await this.persist(next)
      this.document = next
      removed = true
    })
    return removed
  }
}
