import { createHmac, timingSafeEqual } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import AppError from '@/errors/AppError'
import { assertCommercialQuotePreviewSecrets, type CommercialQuotePreviewSecretsInput } from '@/config/commercialQuotePreviewSecrets'
import { canonicalJsonBytesV2, parseJsonTextV2Strict } from './commercialCanonicalJsonV2.service'

const INTERNAL_QUOTE_PREVIEW_TOKEN_HMAC_SEPARATOR = Buffer.from('avoqado.commercial.quote-preview-token@2\0', 'utf8')
export const QUOTE_PREVIEW_TOKEN_HMAC_SEPARATOR = Buffer.from(INTERNAL_QUOTE_PREVIEW_TOKEN_HMAC_SEPARATOR)

const TOKEN_PREFIX = 'v2'
const TOKEN_MAX_LENGTH = 4096
export const COMMERCIAL_QUOTE_PREVIEW_TTL_MS = 15 * 60 * 1000
const BASE64URL = /^[A-Za-z0-9_-]+$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const PAYLOAD_KEYS = [
  'version',
  'previewQuoteId',
  'previewChecksum',
  'acquisitionContextId',
  'publicationId',
  'campaignVersionId',
  'selectionFingerprint',
  'issuedAt',
  'expiresAt',
] as const

export interface CommercialQuotePreviewTokenPayloadV2 {
  version: 2
  previewQuoteId: string
  previewChecksum: string
  acquisitionContextId: string
  publicationId: string
  campaignVersionId: string | null
  selectionFingerprint: string
  issuedAt: string
  expiresAt: string
}

function invalidToken(): never {
  throw new AppError('El comprobante de vista previa es inválido.', 401, true, 'COMMERCIAL_PREVIEW_TOKEN_INVALID')
}

function expiredToken(): never {
  throw new AppError('El comprobante de vista previa venció.', 410, true, 'COMMERCIAL_PREVIEW_TOKEN_EXPIRED')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidToken()
  return descriptor.value
}

function opaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
}

function canonicalTimestamp(value: unknown): { text: string; time: number } {
  if (typeof value !== 'string') return invalidToken()
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return invalidToken()
  return { text: value, time }
}

function normalizePayload(value: unknown): CommercialQuotePreviewTokenPayloadV2 {
  if (!isPlainRecord(value)) return invalidToken()
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some(key => typeof key !== 'string' || !PAYLOAD_KEYS.includes(key as (typeof PAYLOAD_KEYS)[number]))
  ) {
    return invalidToken()
  }

  const version = ownDataValue(value, 'version')
  const previewQuoteId = ownDataValue(value, 'previewQuoteId')
  const previewChecksum = ownDataValue(value, 'previewChecksum')
  const acquisitionContextId = ownDataValue(value, 'acquisitionContextId')
  const publicationId = ownDataValue(value, 'publicationId')
  const campaignVersionId = ownDataValue(value, 'campaignVersionId')
  const selectionFingerprint = ownDataValue(value, 'selectionFingerprint')
  const issuedAt = canonicalTimestamp(ownDataValue(value, 'issuedAt'))
  const expiresAt = canonicalTimestamp(ownDataValue(value, 'expiresAt'))

  if (
    version !== 2 ||
    !opaqueId(previewQuoteId) ||
    typeof previewChecksum !== 'string' ||
    !SHA256_HEX.test(previewChecksum) ||
    !opaqueId(acquisitionContextId) ||
    !opaqueId(publicationId) ||
    (campaignVersionId !== null && !opaqueId(campaignVersionId)) ||
    typeof selectionFingerprint !== 'string' ||
    !SHA256_HEX.test(selectionFingerprint) ||
    expiresAt.time - issuedAt.time !== COMMERCIAL_QUOTE_PREVIEW_TTL_MS
  ) {
    return invalidToken()
  }

  return Object.freeze({
    version: 2,
    previewQuoteId,
    previewChecksum,
    acquisitionContextId,
    publicationId,
    campaignVersionId,
    selectionFingerprint,
    issuedAt: issuedAt.text,
    expiresAt: expiresAt.text,
  })
}

function hmac(payloadBytes: Buffer, secret: string): Buffer {
  return createHmac('sha256', secret).update(INTERNAL_QUOTE_PREVIEW_TOKEN_HMAC_SEPARATOR).update(payloadBytes).digest()
}

function decodeCanonicalBase64Url(segment: string): Buffer {
  if (!BASE64URL.test(segment)) return invalidToken()
  const decoded = Buffer.from(segment, 'base64url')
  if (decoded.toString('base64url') !== segment) return invalidToken()
  return decoded
}

function withStableTokenError<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'COMMERCIAL_PREVIEW_TOKEN_INVALID' || error.code === 'COMMERCIAL_PREVIEW_TOKEN_EXPIRED')
    ) {
      throw error
    }
    return invalidToken()
  }
}

export function issueCommercialQuotePreviewTokenV2(
  payload: CommercialQuotePreviewTokenPayloadV2,
  secrets: CommercialQuotePreviewSecretsInput,
): string {
  assertCommercialQuotePreviewSecrets(secrets)
  return withStableTokenError(() => {
    const normalized = normalizePayload(payload)
    const payloadBytes = canonicalJsonBytesV2(normalized)
    const signature = hmac(payloadBytes, secrets.quotePreviewSigningSecret as string).toString('base64url')
    const token = `${TOKEN_PREFIX}.${payloadBytes.toString('base64url')}.${signature}`
    if (token.length > TOKEN_MAX_LENGTH) return invalidToken()
    return token
  })
}

export function verifyCommercialQuotePreviewTokenV2(
  token: string,
  secrets: CommercialQuotePreviewSecretsInput,
  now: Date,
): CommercialQuotePreviewTokenPayloadV2 {
  assertCommercialQuotePreviewSecrets(secrets)
  return withStableTokenError(() => {
    let nowTime: number
    try {
      nowTime = Date.prototype.getTime.call(now)
    } catch {
      nowTime = Number.NaN
    }
    if (!Number.isFinite(nowTime) || typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX_LENGTH) {
      return invalidToken()
    }

    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || parts[2].length !== 43) return invalidToken()
    const payloadBytes = decodeCanonicalBase64Url(parts[1])
    const signature = decodeCanonicalBase64Url(parts[2])
    if (signature.length !== 32) return invalidToken()

    const expected = hmac(payloadBytes, secrets.quotePreviewSigningSecret as string)
    if (!timingSafeEqual(signature, expected)) return invalidToken()

    const payloadText = payloadBytes.toString('utf8')
    if (!Buffer.from(payloadText, 'utf8').equals(payloadBytes)) return invalidToken()
    const normalized = normalizePayload(parseJsonTextV2Strict(payloadText))
    if (!canonicalJsonBytesV2(normalized).equals(payloadBytes)) return invalidToken()

    const issuedAt = Date.parse(normalized.issuedAt)
    const expiresAt = Date.parse(normalized.expiresAt)
    if (issuedAt > nowTime) return invalidToken()
    if (expiresAt <= nowTime) return expiredToken()
    return normalized
  })
}
