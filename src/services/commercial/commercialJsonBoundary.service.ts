import { types as utilTypes } from 'node:util'
import type { Prisma } from '@prisma/client'

const INVALID_COMMERCIAL_JSON = 'COMMERCIAL_JSON_VALUE_INVALID'

function invalidCommercialJson(): never {
  throw new Error(INVALID_COMMERCIAL_JSON)
}

function materializeCommercialJson(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalidCommercialJson()
  if (typeof value !== 'object' || utilTypes.isProxy(value)) return invalidCommercialJson()

  if (ancestors.has(value)) return invalidCommercialJson()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return invalidCommercialJson()
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== value.length + 1 || ownKeys.at(-1) !== 'length') return invalidCommercialJson()

      const result: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index)
        if (ownKeys[index] !== key) return invalidCommercialJson()
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidCommercialJson()
        result.push(materializeCommercialJson(descriptor.value, ancestors))
      }
      return result
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return invalidCommercialJson()

    const result = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return invalidCommercialJson()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidCommercialJson()
      result[key] = materializeCommercialJson(descriptor.value, ancestors)
    }
    return result
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_COMMERCIAL_JSON) throw error
    return invalidCommercialJson()
  } finally {
    ancestors.delete(value)
  }
}

export function assertCommercialJsonValue(value: unknown): Prisma.InputJsonValue {
  return materializeCommercialJson(value, new WeakSet()) as Prisma.InputJsonValue
}
