import { createHmac } from 'node:crypto'

import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  issueCommercialQuotePreviewTokenV2,
  verifyCommercialQuotePreviewTokenV2,
  type CommercialQuotePreviewTokenPayloadV2,
} from '@/services/commercial/commercialQuotePreviewToken.service'
import {
  issueCommercialQuotePreviewTokenV3,
  QUOTE_PREVIEW_TOKEN_V3_HMAC_SEPARATOR,
  verifyCommercialQuotePreviewTokenV3,
  type CommercialQuotePreviewTokenPayloadV3,
} from '@/services/commercial/quotes-v3/commercialQuotePreviewTokenV3.service'

const secrets = {
  publicationPreviewSigningSecret: 'p'.repeat(48),
  quotePreviewSigningSecret: 'q'.repeat(48),
}
const payload: CommercialQuotePreviewTokenPayloadV3 = {
  version: 3,
  previewQuoteId: 'preview-quote-v3-1',
  previewChecksum: 'a'.repeat(64),
  acquisitionContextId: 'acquisition-context-v3-1',
  offerVersionId: 'commercial-offer-v3-1',
  offerChecksum: 'b'.repeat(64),
  catalogPublicationId: 'commercial-catalog-v2-1',
  catalogChecksum: 'c'.repeat(64),
  selectionFingerprint: 'd'.repeat(64),
  issuedAt: '2026-08-31T12:00:00.000Z',
  expiresAt: '2026-08-31T12:15:00.000Z',
}

function signRawPayload(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  const signature = createHmac('sha256', secrets.quotePreviewSigningSecret)
    .update(QUOTE_PREVIEW_TOKEN_V3_HMAC_SEPARATOR)
    .update(bytes)
    .digest('base64url')
  return `v3.${bytes.toString('base64url')}.${signature}`
}

describe('Commercial Quote preview token v3', () => {
  it('uses the exact v3 domain and round-trips one frozen canonical payload', () => {
    expect(QUOTE_PREVIEW_TOKEN_V3_HMAC_SEPARATOR.toString('utf8')).toBe('avoqado.commercial.quote-preview-token@3\0')
    expect(QUOTE_PREVIEW_TOKEN_V3_HMAC_SEPARATOR.at(-1)).toBe(0)
    const token = issueCommercialQuotePreviewTokenV3(payload, secrets)
    const verified = verifyCommercialQuotePreviewTokenV3(token, secrets, new Date('2026-08-31T12:14:59.999Z'))
    expect(verified).toEqual(payload)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Buffer.from(token.split('.')[1], 'base64url')).toEqual(canonicalJsonBytesV2(payload))
  })

  it('rejects v2 → v3 and v3 → v2 decoding even with the same secret', () => {
    const v2Payload: CommercialQuotePreviewTokenPayloadV2 = {
      version: 2,
      previewQuoteId: payload.previewQuoteId,
      previewChecksum: payload.previewChecksum,
      acquisitionContextId: payload.acquisitionContextId,
      publicationId: payload.catalogPublicationId,
      campaignVersionId: payload.offerVersionId,
      selectionFingerprint: payload.selectionFingerprint,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    }
    const v2 = issueCommercialQuotePreviewTokenV2(v2Payload, secrets)
    const v3 = issueCommercialQuotePreviewTokenV3(payload, secrets)
    expect(() => verifyCommercialQuotePreviewTokenV3(v2, secrets, new Date(payload.issuedAt))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
    expect(() => verifyCommercialQuotePreviewTokenV2(v3, secrets, new Date(payload.issuedAt))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it.each([
    ['future issue', new Date('2026-08-31T11:59:59.999Z'), 'COMMERCIAL_PREVIEW_TOKEN_INVALID'],
    ['exact expiry', new Date('2026-08-31T12:15:00.000Z'), 'COMMERCIAL_PREVIEW_TOKEN_EXPIRED'],
  ])('rejects %s using the intrinsic caller clock', (_label, now, code) => {
    const token = issueCommercialQuotePreviewTokenV3(payload, secrets)
    expect(() => verifyCommercialQuotePreviewTokenV3(token, secrets, now)).toThrow(expect.objectContaining({ code }))
  })

  it.each([
    ['extra money', { ...payload, totalMinor: '2200' }],
    ['unknown key', { ...payload, future: true }],
    ['wrong TTL', { ...payload, expiresAt: '2026-08-31T12:14:59.999Z' }],
    ['bad checksum', { ...payload, offerChecksum: 'B'.repeat(64) }],
    ['oversized id', { ...payload, previewQuoteId: 'p'.repeat(129) }],
    ['noncanonical time', { ...payload, issuedAt: '2026-08-31T12:00:00.000+00:00' }],
  ])('rejects invalid issue payload: %s', (_label, value) => {
    expect(() => issueCommercialQuotePreviewTokenV3(value as CommercialQuotePreviewTokenPayloadV3, secrets)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it.each([
    ['duplicate key', `{"version":3,"version":3,"previewQuoteId":"${payload.previewQuoteId}"}`],
    ['extra key', JSON.stringify({ ...payload, browserPrice: '22.00' })],
    ['noncanonical key order', JSON.stringify(payload)],
  ])('rejects signed non-exact JSON: %s', (_label, text) => {
    expect(() => verifyCommercialQuotePreviewTokenV3(signRawPayload(text), secrets, new Date(payload.issuedAt))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it('rejects accessors and proxies before they can influence signed bytes', () => {
    const accessor = { ...payload } as Record<string, unknown>
    Object.defineProperty(accessor, 'previewQuoteId', { enumerable: true, get: () => payload.previewQuoteId })
    expect(() => issueCommercialQuotePreviewTokenV3(accessor as unknown as CommercialQuotePreviewTokenPayloadV3, secrets)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
    expect(() => issueCommercialQuotePreviewTokenV3(new Proxy({ ...payload }, {}) as CommercialQuotePreviewTokenPayloadV3, secrets)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it('rejects tampering, wrong HMAC domain and noncanonical base64url', () => {
    const token = issueCommercialQuotePreviewTokenV3(payload, secrets)
    expect(() => verifyCommercialQuotePreviewTokenV3(`${token.slice(0, -1)}A`, secrets, new Date(payload.issuedAt))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
    const bytes = canonicalJsonBytesV2(payload)
    const v2DomainSignature = createHmac('sha256', secrets.quotePreviewSigningSecret)
      .update(Buffer.from('avoqado.commercial.quote-preview-token@2\0'))
      .update(bytes)
      .digest('base64url')
    expect(() =>
      verifyCommercialQuotePreviewTokenV3(`v3.${bytes.toString('base64url')}.${v2DomainSignature}`, secrets, new Date(payload.issuedAt)),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }))
    expect(() => verifyCommercialQuotePreviewTokenV3(`${token}=`, secrets, new Date(payload.issuedAt))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it('contains no money, lines, quote body or secrets', () => {
    const token = issueCommercialQuotePreviewTokenV3(payload, secrets)
    const decoded = Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    expect(decoded).not.toMatch(/amount|lines|subtotal|total|tax|renewal|price|secret/iu)
    expect(token).not.toContain(secrets.quotePreviewSigningSecret)
    expect(token).not.toContain(secrets.publicationPreviewSigningSecret)
  })
})
