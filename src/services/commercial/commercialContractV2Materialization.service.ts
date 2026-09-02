import { readFileSync } from 'node:fs'
import { types as utilTypes } from 'node:util'
import { parseJsonTextV2Strict } from './commercialCanonicalJsonV2.service'
import { COMMERCIAL_JSON_TEXT_V2_MAX_BYTES, COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH } from '@/contracts/commercial/commercialContractV2.constants'

function invalidMaterializedGraph(): never {
  throw new Error('COMMERCIAL_CONTRACT_V2_NON_MATERIALIZED')
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const JSON_STRINGIFY = JSON.stringify

function serializeMaterializedJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string' || typeof value === 'number') {
    const serialized = JSON_STRINGIFY(value)
    if (serialized === undefined) return invalidMaterializedGraph()
    return serialized
  }
  if (typeof value !== 'object') return invalidMaterializedGraph()

  if (Array.isArray(value)) {
    const values: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidMaterializedGraph()
      values.push(serializeMaterializedJson(descriptor.value))
    }
    return `[${values.join(',')}]`
  }

  const entries: string[] = []
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return invalidMaterializedGraph()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidMaterializedGraph()
    entries.push(`${JSON_STRINGIFY(key)}:${serializeMaterializedJson(descriptor.value)}`)
  }
  return `{${entries.join(',')}}`
}

class MaterializedJsonBudget {
  private bytes = 0

  addText(value: string): void {
    this.bytes += Buffer.byteLength(value, 'utf8')
    if (this.bytes > COMMERCIAL_JSON_TEXT_V2_MAX_BYTES) invalidMaterializedGraph()
  }

  addAscii(bytes: number): void {
    this.bytes += bytes
    if (this.bytes > COMMERCIAL_JSON_TEXT_V2_MAX_BYTES) invalidMaterializedGraph()
  }

  addJsonString(value: string): void {
    this.addAscii(2)
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
        this.addAscii(2)
      } else if (code <= 0x1f) {
        this.addAscii(6)
      } else if (code <= 0x7f) {
        this.addAscii(1)
      } else if (code <= 0x7ff) {
        this.addAscii(2)
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const following = value.charCodeAt(index + 1)
        if (following < 0xdc00 || following > 0xdfff) invalidMaterializedGraph()
        this.addAscii(4)
        index += 1
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        invalidMaterializedGraph()
      } else {
        this.addAscii(3)
      }
    }
  }
}

function copyMaterializedJson(value: unknown, seen: WeakSet<object>, depth: number, budget: MaterializedJsonBudget): unknown {
  if (depth > COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH) return invalidMaterializedGraph()
  if (value === null) {
    budget.addAscii(4)
    return value
  }
  if (typeof value === 'boolean') {
    budget.addAscii(value ? 4 : 5)
    return value
  }
  if (typeof value === 'string') {
    budget.addJsonString(value)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidMaterializedGraph()
    const serialized = JSON_STRINGIFY(value)
    if (serialized === undefined) return invalidMaterializedGraph()
    budget.addText(serialized)
    return value
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) return invalidMaterializedGraph()
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return invalidMaterializedGraph()
  } else if (!isPlainObject(value)) return invalidMaterializedGraph()
  if (seen.has(value)) return invalidMaterializedGraph()

  seen.add(value)
  {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some(key => typeof key === 'symbol') || ownKeys.includes('toJSON')) return invalidMaterializedGraph()
    if (Array.isArray(value)) {
      budget.addAscii(2 + Math.max(0, value.length - 1))
      const copy: unknown[] = []
      for (const key of ownKeys) {
        if (key === 'length') continue
        const index = Number(key)
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          return invalidMaterializedGraph()
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidMaterializedGraph()
        copy.push(copyMaterializedJson(descriptor.value, seen, depth + 1, budget))
      }
      return copy
    }

    budget.addAscii(2 + Math.max(0, ownKeys.length - 1))
    const copy = Object.create(null) as Record<string, unknown>
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidMaterializedGraph()
      budget.addJsonString(key)
      budget.addAscii(1)
      Object.defineProperty(copy, key, {
        value: copyMaterializedJson(descriptor.value, seen, depth + 1, budget),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return copy
  }
}

function deepFreezeJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreezeJson(nested)
  return Object.freeze(value)
}

export function parseCommercialContractControlledJsonV2<T = unknown>(text: string): T {
  return deepFreezeJson(parseJsonTextV2Strict(text) as T)
}

export function loadCommercialContractControlledJsonV2<T = unknown>(path: string): T {
  return parseCommercialContractControlledJsonV2<T>(readFileSync(path, 'utf8'))
}

export function materializeCommercialContractV2Json<T>(value: unknown): T {
  const materialized = copyMaterializedJson(value, new WeakSet(), 0, new MaterializedJsonBudget())
  try {
    return deepFreezeJson(parseJsonTextV2Strict(serializeMaterializedJson(materialized)) as T)
  } catch {
    return invalidMaterializedGraph()
  }
}
