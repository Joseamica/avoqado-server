import { timingSafeEqual } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { materializeCommercialContractV2Json } from './commercialContractV2Materialization.service'
import { artifactCode, failCommercialArtifactCodec } from './commercialArtifactCodecErrors.service'
import type { CommercialPersistedArtifactKind } from '@/types/commercialCodec'

const DATE_GET_TIME = Date.prototype.getTime
const DATE_TO_ISO_STRING = Date.prototype.toISOString
const IS_DATE = utilTypes.isDate
const IS_PROXY = utilTypes.isProxy
const NUMBER_CONSTRUCTOR = Number
const NUMBER_IS_FINITE = Number.isFinite
const REFLECT_APPLY = Reflect.apply
const UTIL_TYPES_RECEIVER = utilTypes

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value) || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

export function readOwnData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  return descriptor.value
}

function readSchemaDiscriminant(value: object, key: string, kind: CommercialPersistedArtifactKind): number {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  if (!descriptor) failCommercialArtifactCodec(artifactCode(kind, 'SCHEMA_UNSUPPORTED'))
  if (!descriptor.enumerable || !('value' in descriptor)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  if (!Number.isInteger(descriptor.value)) failCommercialArtifactCodec(artifactCode(kind, 'SCHEMA_UNSUPPORTED'))
  return descriptor.value as number
}

export function captureEnvelopeDiscriminants(value: unknown): {
  envelope: Record<string, unknown>
  kind: CommercialPersistedArtifactKind
  rowSchemaVersion: number
} {
  if (!isPlainRecord(value)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  let kindValue: unknown
  try {
    kindValue = readOwnData(value, 'kind')
  } catch (error) {
    if (error instanceof Error && error.name === 'CommercialArtifactCodecError') throw error
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  if (kindValue !== 'CATALOG' && kindValue !== 'CAMPAIGN' && kindValue !== 'QUOTE') {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_KIND_UNSUPPORTED')
  }
  return { envelope: value, kind: kindValue, rowSchemaVersion: readSchemaDiscriminant(value, 'rowSchemaVersion', kindValue) }
}

export function captureEmitDiscriminants(value: unknown): {
  envelope: Record<string, unknown>
  kind: CommercialPersistedArtifactKind
  schemaVersion: number
} {
  if (!isPlainRecord(value)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  let kindValue: unknown
  try {
    kindValue = readOwnData(value, 'kind')
  } catch {
    return failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  if (kindValue !== 'CATALOG' && kindValue !== 'CAMPAIGN' && kindValue !== 'QUOTE') {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_KIND_UNSUPPORTED')
  }
  return { envelope: value, kind: kindValue, schemaVersion: readSchemaDiscriminant(value, 'schemaVersion', kindValue) }
}

export function assertCommercialArtifactEnvelopeData(value: Record<string, unknown>): void {
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'CommercialArtifactCodecError') throw error
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
}

function copyV1(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid')
    return value
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) throw new Error('invalid')
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('invalid')
  } else if (!isPlainRecord(value)) throw new Error('invalid')
  if (seen.has(value)) throw new Error('invalid')
  seen.add(value)
  {
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key === 'symbol') || keys.includes('toJSON')) throw new Error('invalid')
    if (Array.isArray(value)) {
      const result: unknown[] = []
      for (const key of keys) {
        if (key === 'length') continue
        const index = Number(key)
        if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= value.length) throw new Error('invalid')
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('invalid')
        result.push(copyV1(descriptor.value, seen))
      }
      return result
    }
    const result = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('invalid')
      Object.defineProperty(result, key, {
        value: copyV1(descriptor.value, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return result
  }
}

export function deepFreezeCommercialArtifact<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) deepFreezeCommercialArtifact(descriptor.value)
  }
  return Object.freeze(value)
}

export function materializeArtifactSnapshot<T>(kind: CommercialPersistedArtifactKind, schemaVersion: 1 | 2, value: unknown): T {
  try {
    const materialized = schemaVersion === 1 ? copyV1(value, new WeakSet()) : materializeCommercialContractV2Json(value)
    return deepFreezeCommercialArtifact(materialized) as T
  } catch {
    return failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  }
}

export function verifyArtifactChecksum(
  kind: CommercialPersistedArtifactKind,
  provided: unknown,
  expected: string,
): asserts provided is string {
  if (typeof provided !== 'string' || !/^[0-9a-f]{64}$/.test(provided)) {
    failCommercialArtifactCodec(artifactCode(kind, 'CHECKSUM_INVALID'))
  }
  const actualBytes = Buffer.from(provided, 'hex')
  const expectedBytes = Buffer.from(expected, 'hex')
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    failCommercialArtifactCodec(artifactCode(kind, 'CHECKSUM_INVALID'))
  }
}

export function toValidIso(value: unknown): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    REFLECT_APPLY(IS_PROXY, UTIL_TYPES_RECEIVER, [value]) ||
    !REFLECT_APPLY(IS_DATE, UTIL_TYPES_RECEIVER, [value])
  ) {
    return null
  }
  try {
    const time = REFLECT_APPLY(DATE_GET_TIME, value, [])
    return REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_CONSTRUCTOR, [time]) ? REFLECT_APPLY(DATE_TO_ISO_STRING, value, []) : null
  } catch {
    return null
  }
}

export function isVerifiedObjectCandidate(value: unknown): value is object {
  return isPlainRecord(value)
}
