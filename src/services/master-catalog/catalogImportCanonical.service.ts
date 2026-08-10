import { createHash, type Hash } from 'node:crypto'
import AppError from '../../errors/AppError'
import { canonicalJsonV1 } from './catalogHash.service'

export const EVENT_LOOP_BUDGET_MS = 50
const CANONICAL_SLICE_MS = 4
const HASH_BUFFER_CHARACTERS = 64 * 1_024

export type CatalogImportCooperativeCheckpoint = () => Promise<void> | undefined

export function createCatalogImportCooperativeCheckpoint(sliceMilliseconds = 8): CatalogImportCooperativeCheckpoint {
  let sliceStartedAt = performance.now()
  return () => {
    if (performance.now() - sliceStartedAt < sliceMilliseconds) return undefined
    // WHY: Domain validation runs on the main thread after worker isolation;
    // the fast path allocates no Promise, preventing GC pauses while traversing
    // tens of thousands of otherwise cheap durable dependency leaves.
    return new Promise<void>(resolve => {
      setImmediate(() => {
        sliceStartedAt = performance.now()
        resolve()
      })
    })
  }
}

export async function hashCatalogImportUploadBuffer(buffer: Buffer): Promise<string> {
  // WHY: Even the bounded 10 MiB upload digest yields between chunks, so the
  // worker boundary is not followed by a single long main-thread crypto turn.
  const hash = createHash('sha256')
  for (let offset = 0; offset < buffer.length; offset += 256 * 1_024) {
    hash.update(buffer.subarray(offset, offset + 256 * 1_024))
    if (offset > 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return hash.digest('hex')
}

export interface CanonicalCatalogImportRowsResult {
  hash: string
}

export type CatalogImportCanonicalNamespace =
  | 'catalog-import-rows:v1'
  | 'catalog-import-audit-envelopes:v1'
  | 'catalog-import-dependencies:v1'

interface CanonicalState {
  hash: Hash
  signal?: AbortSignal
  sliceStartedAt: number
  visited: number
  buffer: string[]
  bufferedCharacters: number
  probeStack: unknown[]
}

type CanonicalWork =
  | { kind: 'TOKEN'; value: string }
  | { kind: 'VALUE'; value: unknown }
  | { kind: 'ARRAY'; value: readonly unknown[]; index: number }
  | { kind: 'ROWS'; index: number }

function invalidCanonicalJson(): never {
  throw new Error('CATALOG_CANONICAL_JSON_INVALID')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function flush(state: CanonicalState): void {
  if (!state.buffer.length) return
  state.hash.update(state.buffer.join(''))
  state.buffer = []
  state.bufferedCharacters = 0
}

function append(state: CanonicalState, value: string): void {
  state.buffer.push(value)
  state.bufferedCharacters += value.length
  if (state.bufferedCharacters >= HASH_BUFFER_CHARACTERS) flush(state)
}

function isSmallCanonicalValue(state: CanonicalState, root: unknown): boolean {
  const maximumNodes = 256
  const maximumCharacters = 16 * 1_024
  let nodes = 0
  let characters = 0
  const pending = state.probeStack
  pending.push(root)
  while (pending.length) {
    const value = pending.pop()
    nodes += 1
    if (nodes > maximumNodes) {
      pending.length = 0
      return false
    }
    if (typeof value === 'string') characters += value.length
    else if (Array.isArray(value)) {
      characters += value.length
      for (let index = 0; index < value.length; index += 1) pending.push(value[index])
    } else if (isPlainObject(value)) {
      const entries = Object.entries(value)
      for (const [key, nested] of entries) {
        characters += key.length
        pending.push(nested)
      }
    }
    if (characters > maximumCharacters) {
      pending.length = 0
      return false
    }
  }
  return true
}

function checkpoint(state: CanonicalState): Promise<void> | undefined {
  state.visited += 1
  if (state.signal?.aborted) {
    throw new AppError('La importación fue cancelada.', 400, true, 'CATALOG_IMPORT_CANCELLED')
  }
  if (state.visited % 128 !== 0 && performance.now() - state.sliceStartedAt < CANONICAL_SLICE_MS) return
  // WHY: Nested arrays may place the complete 64 MiB envelope in one staged
  // row, so traversal yields inside values instead of only between outer rows.
  flush(state)
  return new Promise<void>(resolve => {
    setImmediate(() => {
      state.sliceStartedAt = performance.now()
      resolve()
    })
  })
}

export async function canonicalizeAndHashCatalogImportRows(
  rows: readonly unknown[],
  options: {
    chunkSize?: number
    signal?: AbortSignal
    projectRow?: (row: unknown) => unknown
    namespace?: CatalogImportCanonicalNamespace
  } = {},
): Promise<CanonicalCatalogImportRowsResult> {
  // WHY: `chunkSize` remains accepted for the v1 API, while elapsed-time and
  // recursive checkpoints are the actual safety boundary for hostile nesting.
  if (options.chunkSize !== undefined && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1)) {
    throw new AppError('El tamaño de chunk no es válido.', 400, true, 'CATALOG_IMPORT_CHUNK_INVALID')
  }
  const state: CanonicalState = {
    hash: createHash('sha256'),
    signal: options.signal,
    sliceStartedAt: performance.now(),
    visited: 0,
    buffer: [],
    bufferedCharacters: 0,
    probeStack: [],
  }
  // WHY: Closed domain separation prevents a valid staged-row digest from
  // being replayed as audit or dependency evidence with identical JSON bytes.
  append(state, `${options.namespace ?? 'catalog-import-rows:v1'}\n[`)
  const work: CanonicalWork[] = [{ kind: 'ROWS', index: 0 }]
  while (work.length) {
    const pause = checkpoint(state)
    if (pause) await pause
    const current = work.pop() as CanonicalWork
    if (current.kind === 'TOKEN') {
      append(state, current.value)
      continue
    }
    if (current.kind === 'ROWS') {
      if (current.index >= rows.length) {
        append(state, ']')
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(rows, current.index)) invalidCanonicalJson()
      if (current.index > 0) append(state, ',')
      work.push({ kind: 'ROWS', index: current.index + 1 })
      const row = rows[current.index]
      const projected = options.projectRow ? options.projectRow(row) : row
      // WHY: Typical staged rows are independently bounded and complete in a
      // few microseconds. Reusing the proven synchronous serializer for those
      // rows avoids millions of frame/token allocations (and long GC pauses),
      // while oversized/nested rows remain on the cooperative walker below.
      if (isSmallCanonicalValue(state, projected)) append(state, canonicalJsonV1(projected))
      else work.push({ kind: 'VALUE', value: projected })
      continue
    }
    if (current.kind === 'ARRAY') {
      if (current.index >= current.value.length) {
        append(state, ']')
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(current.value, current.index)) invalidCanonicalJson()
      if (current.index > 0) append(state, ',')
      work.push({ kind: 'ARRAY', value: current.value, index: current.index + 1 })
      work.push({ kind: 'VALUE', value: current.value[current.index] })
      continue
    }

    const value = current.value
    if (value === null) {
      append(state, 'null')
    } else if (typeof value === 'boolean') {
      append(state, value ? 'true' : 'false')
    } else if (typeof value === 'string') {
      append(state, JSON.stringify(value.normalize('NFC')))
    } else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) invalidCanonicalJson()
      append(state, String(value))
    } else if (Array.isArray(value)) {
      append(state, '[')
      work.push({ kind: 'ARRAY', value, index: 0 })
    } else {
      if (!isPlainObject(value)) invalidCanonicalJson()
      const entries = Object.entries(value).map(([key, nested]) => [key.normalize('NFC'), nested] as const)
      if (new Set(entries.map(([key]) => key)).size !== entries.length) invalidCanonicalJson()
      entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      append(state, '{')
      work.push({ kind: 'TOKEN', value: '}' })
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, nested] = entries[index] as (typeof entries)[number]
        work.push({ kind: 'VALUE', value: nested })
        work.push({ kind: 'TOKEN', value: ':' })
        work.push({ kind: 'TOKEN', value: JSON.stringify(key) })
        if (index > 0) work.push({ kind: 'TOKEN', value: ',' })
      }
    }
  }
  flush(state)
  return { hash: state.hash.digest('hex') }
}
