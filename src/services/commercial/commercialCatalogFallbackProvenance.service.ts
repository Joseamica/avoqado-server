import { types as utilTypes } from 'node:util'
import { COMMERCIAL_JSON_TEXT_V2_MAX_BYTES, COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH } from '@/contracts/commercial/commercialContractV2.constants'
import { toValidIso } from './commercialArtifactCodecBoundary.service'
import { failCatalogFallbackProvenance } from './commercialCatalogFallbackBoundary.service'
import type { CommercialCatalogPersistedRow } from '@/types/commercialCodec'

const DATE_CONSTRUCTOR = Date
const DATE_TO_ISO_STRING = Date.prototype.toISOString
const REFLECT_APPLY = Reflect.apply
const ARRAY_CONSTRUCTOR = Array
const ARRAY_IS_ARRAY = Array.isArray
const ARRAY_PROTOTYPE = Array.prototype
const BUFFER_CONSTRUCTOR = Buffer
const BUFFER_BYTE_LENGTH = Buffer.byteLength
const JSON_CONSTRUCTOR = JSON
const JSON_STRINGIFY = JSON.stringify
const MAP_CONSTRUCTOR = Map
const MAP_GET = Map.prototype.get
const MAP_HAS = Map.prototype.has
const MAP_SET = Map.prototype.set
const NUMBER_CONSTRUCTOR = Number
const NUMBER_IS_FINITE = Number.isFinite
const NUMBER_IS_INTEGER = Number.isInteger
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const OBJECT_CONSTRUCTOR = Object
const OBJECT_DEFINE_PROPERTY = Object.defineProperty
const OBJECT_FREEZE = Object.freeze
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf
const OBJECT_IS = Object.is
const OBJECT_PROTOTYPE = Object.prototype
const REFLECT_CONSTRUCTOR = Reflect
const REFLECT_OWN_KEYS = Reflect.ownKeys
const REGEXP_EXEC = RegExp.prototype.exec
const SET_CONSTRUCTOR = Set
const SET_ADD = Set.prototype.add
const SET_HAS = Set.prototype.has
const WEAK_SET_CONSTRUCTOR = WeakSet
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const IS_PROXY = utilTypes.isProxy
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/
const DEDUPE_PATTERN = /^commercial:activation:([1-9][0-9]*):(.*)$/
const PAYLOAD_KEYS = REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [
  ['eventId', 'type', 'publicationId', 'previousPublicationId', 'schemaVersion', 'checksum', 'occurredAt'],
]) as readonly ['eventId', 'type', 'publicationId', 'previousPublicationId', 'schemaVersion', 'checksum', 'occurredAt']
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isExactIsoDate(value: string): boolean {
  try {
    const date = new DATE_CONSTRUCTOR(value)
    return REFLECT_APPLY(DATE_TO_ISO_STRING, date, []) === value
  } catch {
    return false
  }
}

function ownKeys(value: object): (string | symbol)[] {
  return REFLECT_APPLY(REFLECT_OWN_KEYS, REFLECT_CONSTRUCTOR, [value])
}

function ownDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  return REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_CONSTRUCTOR, [value, key])
}

function defineArrayIndex<T>(target: T[], index: number, value: T): void {
  REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, OBJECT_CONSTRUCTOR, [
    target,
    `${index}`,
    {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    },
  ])
}

function freezeArray<T>(target: T[]): readonly T[] {
  REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [target])
  return target
}

function isArray(value: unknown): value is unknown[] {
  return REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_CONSTRUCTOR, [value])
}

function isPlainEvidenceRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || REFLECT_APPLY(IS_PROXY, utilTypes, [value]) || isArray(value)) return false
  try {
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [value])
    return prototype === OBJECT_PROTOTYPE || prototype === null
  } catch {
    return false
  }
}

interface ProvenanceEvent {
  id: string
  revision: number
  publication: CommercialCatalogPersistedRow
  previousPublication: CommercialCatalogPersistedRow | null
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = ownDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return failCatalogFallbackProvenance()
    return descriptor.value
  } catch {
    return failCatalogFallbackProvenance()
  }
}

function rowEvidence(value: unknown): {
  row: CommercialCatalogPersistedRow
  id: string
  schemaVersion: number
  checksum: string
  publishedAt: string
} {
  if (!isPlainEvidenceRecord(value)) return failCatalogFallbackProvenance()
  const id = ownData(value, 'id')
  const schemaVersion = ownData(value, 'schemaVersion')
  const checksum = ownData(value, 'checksum')
  const publishedAt = toValidIso(ownData(value, 'publishedAt'))
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    !REFLECT_APPLY(NUMBER_IS_INTEGER, NUMBER_CONSTRUCTOR, [schemaVersion]) ||
    typeof checksum !== 'string' ||
    REFLECT_APPLY(REGEXP_EXEC, CHECKSUM_PATTERN, [checksum]) === null ||
    publishedAt === null
  ) {
    return failCatalogFallbackProvenance()
  }
  return { row: value as unknown as CommercialCatalogPersistedRow, id, schemaVersion: schemaVersion as number, checksum, publishedAt }
}

function sameEvidence(left: ReturnType<typeof rowEvidence>, right: ReturnType<typeof rowEvidence>): boolean {
  return (
    left.id === right.id &&
    left.schemaVersion === right.schemaVersion &&
    left.checksum === right.checksum &&
    left.publishedAt === right.publishedAt
  )
}

interface JsonEvidenceFrame {
  left: unknown
  right: unknown
  depth: number
}

function serializedScalarBytes(value: null | boolean | string | number): number | null {
  const serialized = REFLECT_APPLY(JSON_STRINGIFY, JSON_CONSTRUCTOR, [value])
  return typeof serialized === 'string' ? REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_CONSTRUCTOR, [serialized, 'utf8']) : null
}

function exactJsonEvidence(left: unknown, right: unknown, bounded: boolean): boolean {
  const leftSeen = new WEAK_SET_CONSTRUCTOR<object>()
  const rightSeen = new WEAK_SET_CONSTRUCTOR<object>()
  const stack: JsonEvidenceFrame[] = [{ left, right, depth: 0 }]
  let stackLength = 1
  let bytes = 0
  const addBytes = (amount: number): boolean => {
    if (!bounded) return true
    bytes += amount
    return bytes <= COMMERCIAL_JSON_TEXT_V2_MAX_BYTES
  }
  while (stackLength > 0) {
    stackLength -= 1
    const frame = stack[stackLength]
    if (bounded && frame.depth > COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH) return false
    const leftObject = typeof frame.left === 'object' && frame.left !== null
    const rightObject = typeof frame.right === 'object' && frame.right !== null
    if (!leftObject || !rightObject) {
      let scalar: null | boolean | string | number
      if (frame.left === null || typeof frame.left === 'boolean' || typeof frame.left === 'string') {
        if (frame.left !== frame.right) return false
        scalar = frame.left
      } else if (typeof frame.left === 'number' && typeof frame.right === 'number') {
        if (
          !REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_CONSTRUCTOR, [frame.left]) ||
          !REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_CONSTRUCTOR, [frame.right]) ||
          !REFLECT_APPLY(OBJECT_IS, OBJECT_CONSTRUCTOR, [frame.left, frame.right])
        ) {
          return false
        }
        scalar = frame.left
      } else return false
      const scalarBytes = serializedScalarBytes(scalar)
      if (scalarBytes === null || !addBytes(scalarBytes)) return false
      continue
    }
    const leftValue = frame.left as object
    const rightValue = frame.right as object
    if (
      REFLECT_APPLY(IS_PROXY, utilTypes, [leftValue]) ||
      REFLECT_APPLY(IS_PROXY, utilTypes, [rightValue]) ||
      REFLECT_APPLY(WEAK_SET_HAS, leftSeen, [leftValue]) ||
      REFLECT_APPLY(WEAK_SET_HAS, rightSeen, [rightValue])
    ) {
      return false
    }
    const leftArray = isArray(leftValue)
    const rightArray = isArray(rightValue)
    if (leftArray !== rightArray) return false
    if (leftArray) {
      if (
        REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [leftValue]) !== ARRAY_PROTOTYPE ||
        REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [rightValue]) !== ARRAY_PROTOTYPE
      ) {
        return false
      }
    } else if (!isPlainEvidenceRecord(leftValue) || !isPlainEvidenceRecord(rightValue)) return false
    REFLECT_APPLY(WEAK_SET_ADD, leftSeen, [leftValue])
    REFLECT_APPLY(WEAK_SET_ADD, rightSeen, [rightValue])
    const leftKeys = ownKeys(leftValue)
    const rightKeys = ownKeys(rightValue)
    if (leftKeys.length !== rightKeys.length) return false
    if (leftArray && rightArray) {
      if (leftValue.length !== rightValue.length || !addBytes(2 + (leftValue.length > 0 ? leftValue.length - 1 : 0))) return false
      for (let side = 0; side < 2; side += 1) {
        const keys = side === 0 ? leftKeys : rightKeys
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex]
          if (key === 'length') continue
          const index = typeof key === 'string' ? REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [key]) : 0 / 0
          if (
            !REFLECT_APPLY(NUMBER_IS_INTEGER, NUMBER_CONSTRUCTOR, [index]) ||
            index < 0 ||
            index >= leftValue.length ||
            `${index}` !== key
          ) {
            return false
          }
        }
      }
      for (let index = 0; index < leftValue.length; index += 1) {
        const key = `${index}`
        const leftDescriptor = ownDescriptor(leftValue, key)
        const rightDescriptor = ownDescriptor(rightValue, key)
        if (
          !leftDescriptor ||
          !rightDescriptor ||
          !leftDescriptor.enumerable ||
          !rightDescriptor.enumerable ||
          !('value' in leftDescriptor) ||
          !('value' in rightDescriptor)
        ) {
          return false
        }
        defineArrayIndex(stack, stackLength, { left: leftDescriptor.value, right: rightDescriptor.value, depth: frame.depth + 1 })
        stackLength += 1
      }
      continue
    }
    if (!addBytes(2 + (leftKeys.length > 0 ? leftKeys.length - 1 : 0))) return false
    for (let index = 0; index < rightKeys.length; index += 1) if (typeof rightKeys[index] !== 'string') return false
    for (let index = 0; index < leftKeys.length; index += 1) {
      const key = leftKeys[index]
      if (typeof key !== 'string') return false
      const leftDescriptor = ownDescriptor(leftValue, key)
      const rightDescriptor = ownDescriptor(rightValue, key)
      const keyBytes = serializedScalarBytes(key)
      if (
        !leftDescriptor ||
        !rightDescriptor ||
        !leftDescriptor.enumerable ||
        !rightDescriptor.enumerable ||
        !('value' in leftDescriptor) ||
        !('value' in rightDescriptor) ||
        keyBytes === null ||
        !addBytes(keyBytes + 1)
      ) {
        return false
      }
      defineArrayIndex(stack, stackLength, { left: leftDescriptor.value, right: rightDescriptor.value, depth: frame.depth + 1 })
      stackLength += 1
    }
  }
  return true
}

function sameJoinedPublication(left: ReturnType<typeof rowEvidence>, right: ReturnType<typeof rowEvidence>): boolean {
  if (!sameEvidence(left, right)) return false
  try {
    return exactJsonEvidence(
      ownData(left.row as unknown as object, 'snapshot'),
      ownData(right.row as unknown as object, 'snapshot'),
      left.schemaVersion !== 1,
    )
  } catch {
    return false
  }
}

function registerImmutablePublication(
  publicationsById: Map<string, ReturnType<typeof rowEvidence>>,
  evidence: ReturnType<typeof rowEvidence>,
): void {
  const prior = REFLECT_APPLY(MAP_GET, publicationsById, [evidence.id]) as ReturnType<typeof rowEvidence> | undefined
  if (prior) {
    if (!sameJoinedPublication(prior, evidence)) return failCatalogFallbackProvenance()
    return
  }
  REFLECT_APPLY(MAP_SET, publicationsById, [evidence.id, evidence])
}

function exactPayload(value: unknown): Record<string, unknown> {
  if (!isPlainEvidenceRecord(value)) return failCatalogFallbackProvenance()
  const keys = ownKeys(value)
  if (keys.length !== PAYLOAD_KEYS.length) return failCatalogFallbackProvenance()
  for (let index = 0; index < keys.length; index += 1) if (typeof keys[index] !== 'string') return failCatalogFallbackProvenance()
  for (let index = 0; index < PAYLOAD_KEYS.length; index += 1) ownData(value, PAYLOAD_KEYS[index])
  return value
}

function parseRevision(dedupeKey: string, publicationId: string): number {
  const match = REFLECT_APPLY(REGEXP_EXEC, DEDUPE_PATTERN, [dedupeKey])
  if (!match || match[2] !== publicationId) return failCatalogFallbackProvenance()
  const revision = REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [match[1]])
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [revision]) || revision <= 0) {
    return failCatalogFallbackProvenance()
  }
  return revision
}

function captureEvent(value: unknown): ProvenanceEvent {
  if (!isPlainEvidenceRecord(value)) return failCatalogFallbackProvenance()
  const id = ownData(value, 'id')
  const createdAt = toValidIso(ownData(value, 'createdAt'))
  const eventType = ownData(value, 'eventType')
  const publicationId = ownData(value, 'publicationId')
  const previousPublicationId = ownData(value, 'previousPublicationId')
  const payloadVersion = ownData(value, 'payloadVersion')
  const dedupeKey = ownData(value, 'dedupeKey')
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    createdAt === null ||
    (eventType !== 'PUBLICATION_ACTIVATED' && eventType !== 'PUBLICATION_ROLLED_BACK') ||
    typeof publicationId !== 'string' ||
    (previousPublicationId !== null && typeof previousPublicationId !== 'string') ||
    payloadVersion !== 1 ||
    typeof dedupeKey !== 'string'
  ) {
    return failCatalogFallbackProvenance()
  }
  const publication = rowEvidence(ownData(value, 'publication'))
  const previousValue = ownData(value, 'previousPublication')
  const previousPublication = previousValue === null ? null : rowEvidence(previousValue)
  if (publication.id !== publicationId || (previousPublication?.id ?? null) !== previousPublicationId) {
    return failCatalogFallbackProvenance()
  }
  const payload = exactPayload(ownData(value, 'payload'))
  const occurredAt = ownData(payload, 'occurredAt')
  if (
    ownData(payload, 'eventId') !== dedupeKey ||
    ownData(payload, 'type') !== eventType ||
    ownData(payload, 'publicationId') !== publicationId ||
    ownData(payload, 'previousPublicationId') !== previousPublicationId ||
    ownData(payload, 'schemaVersion') !== publication.schemaVersion ||
    ownData(payload, 'checksum') !== publication.checksum ||
    typeof occurredAt !== 'string' ||
    REFLECT_APPLY(REGEXP_EXEC, ISO_PATTERN, [occurredAt]) === null ||
    !isExactIsoDate(occurredAt)
  ) {
    return failCatalogFallbackProvenance()
  }
  return {
    id,
    revision: parseRevision(dedupeKey, publicationId),
    publication: publication.row,
    previousPublication: previousPublication?.row ?? null,
  }
}

function captureDenseEvents(value: unknown, expectedLength: number): readonly unknown[] {
  if (typeof value !== 'object' || value === null || REFLECT_APPLY(IS_PROXY, utilTypes, [value]) || !isArray(value)) {
    return failCatalogFallbackProvenance()
  }
  if (REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [value]) !== ARRAY_PROTOTYPE) {
    return failCatalogFallbackProvenance()
  }
  if (
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [expectedLength]) ||
    expectedLength <= 0 ||
    value.length !== expectedLength
  ) {
    return failCatalogFallbackProvenance()
  }
  const keys = ownKeys(value)
  if (keys.length !== value.length + 1) return failCatalogFallbackProvenance()
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex]
    if (key === 'length') continue
    const index = typeof key === 'string' ? REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [key]) : 0 / 0
    if (!REFLECT_APPLY(NUMBER_IS_INTEGER, NUMBER_CONSTRUCTOR, [index]) || index < 0 || index >= value.length || `${index}` !== key) {
      return failCatalogFallbackProvenance()
    }
  }
  const result: unknown[] = new ARRAY_CONSTRUCTOR(value.length)
  for (let index = 0; index < value.length; index += 1) defineArrayIndex(result, index, ownData(value, `${index}`))
  return result
}

// Internal synchronous proof helper: intentionally imported only by the resolver,
// the commercial authority boundary and focused tests, and never re-exported from
// the public fallback API.
export function proveCatalogActivationChain(input: {
  activePublication: CommercialCatalogPersistedRow
  pointerRevision: number
  activationEvents: unknown
}): readonly CommercialCatalogPersistedRow[] {
  const active = rowEvidence(input.activePublication)
  const publicationsById = new MAP_CONSTRUCTOR<string, ReturnType<typeof rowEvidence>>()
  registerImmutablePublication(publicationsById, active)
  const eventValues = captureDenseEvents(input.activationEvents, input.pointerRevision)
  const events: ProvenanceEvent[] = new ARRAY_CONSTRUCTOR(eventValues.length)
  for (let index = 0; index < eventValues.length; index += 1) defineArrayIndex(events, index, captureEvent(eventValues[index]))
  const byRevision = new MAP_CONSTRUCTOR<number, ProvenanceEvent>()
  const eventIds = new SET_CONSTRUCTOR<string>()
  for (let index = 0; index < events.length; index += 1) {
    const item = events[index]
    if (
      item.revision > input.pointerRevision ||
      REFLECT_APPLY(MAP_HAS, byRevision, [item.revision]) ||
      REFLECT_APPLY(SET_HAS, eventIds, [item.id])
    ) {
      return failCatalogFallbackProvenance()
    }
    REFLECT_APPLY(MAP_SET, byRevision, [item.revision, item])
    REFLECT_APPLY(SET_ADD, eventIds, [item.id])
  }
  const rows: CommercialCatalogPersistedRow[] = new ARRAY_CONSTRUCTOR(input.pointerRevision)
  for (let revision = 1; revision <= input.pointerRevision; revision += 1) {
    const current = REFLECT_APPLY(MAP_GET, byRevision, [revision]) as ProvenanceEvent | undefined
    if (!current) return failCatalogFallbackProvenance()
    const currentEvidence = rowEvidence(current.publication)
    registerImmutablePublication(publicationsById, currentEvidence)
    if (revision === 1) {
      if (current.previousPublication !== null) return failCatalogFallbackProvenance()
    } else {
      const prior = REFLECT_APPLY(MAP_GET, byRevision, [revision - 1]) as ProvenanceEvent | undefined
      if (!prior || current.previousPublication === null) return failCatalogFallbackProvenance()
      if (!sameJoinedPublication(rowEvidence(current.previousPublication), rowEvidence(prior.publication))) {
        return failCatalogFallbackProvenance()
      }
    }
    defineArrayIndex(rows, revision - 1, currentEvidence.row)
  }
  const head = REFLECT_APPLY(MAP_GET, byRevision, [input.pointerRevision]) as ProvenanceEvent | undefined
  if (!head || !sameJoinedPublication(rowEvidence(head.publication), active)) return failCatalogFallbackProvenance()
  return freezeArray(rows)
}
