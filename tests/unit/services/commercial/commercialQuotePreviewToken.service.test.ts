import { createHmac } from 'node:crypto'
import {
  issueCommercialQuotePreviewTokenV2,
  QUOTE_PREVIEW_TOKEN_HMAC_SEPARATOR,
  verifyCommercialQuotePreviewTokenV2,
  type CommercialQuotePreviewTokenPayloadV2,
} from '@/services/commercial/commercialQuotePreviewToken.service'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'

const secrets = {
  publicationPreviewSigningSecret: 'p'.repeat(48),
  quotePreviewSigningSecret: 'q'.repeat(48),
}

const payload: CommercialQuotePreviewTokenPayloadV2 = {
  version: 2,
  previewQuoteId: 'preview-quote-1',
  previewChecksum: 'a'.repeat(64),
  acquisitionContextId: 'acq-context-1',
  publicationId: 'publication-v2-1',
  campaignVersionId: 'campaign-version-1',
  selectionFingerprint: 'b'.repeat(64),
  issuedAt: '2026-08-28T12:00:00.000Z',
  expiresAt: '2026-08-28T12:15:00.000Z',
}

const controlledToken =
  'v2.eyJhY3F1aXNpdGlvbkNvbnRleHRJZCI6ImFjcS1jb250ZXh0LTEiLCJjYW1wYWlnblZlcnNpb25JZCI6ImNhbXBhaWduLXZlcnNpb24tMSIsImV4cGlyZXNBdCI6IjIwMjYtMDgtMjhUMTI6MTU6MDAuMDAwWiIsImlzc3VlZEF0IjoiMjAyNi0wOC0yOFQxMjowMDowMC4wMDBaIiwicHJldmlld0NoZWNrc3VtIjoiYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSIsInByZXZpZXdRdW90ZUlkIjoicHJldmlldy1xdW90ZS0xIiwicHVibGljYXRpb25JZCI6InB1YmxpY2F0aW9uLXYyLTEiLCJzZWxlY3Rpb25GaW5nZXJwcmludCI6ImJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIiLCJ2ZXJzaW9uIjoyfQ.NcrXbJRqonvgBsXw-eK_8Hg4UKRU9w33586vTN8Iz_U'

function signRawPayload(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  const signature = createHmac('sha256', secrets.quotePreviewSigningSecret)
    .update(QUOTE_PREVIEW_TOKEN_HMAC_SEPARATOR)
    .update(bytes)
    .digest('base64url')
  return `v2.${bytes.toString('base64url')}.${signature}`
}

function tokenError(operation: () => unknown): { code?: string; message: string } {
  try {
    operation()
    throw new Error('expected token operation to fail')
  } catch (error) {
    return error as { code?: string; message: string }
  }
}

describe('commercial quote preview token v2', () => {
  it('uses the exact local domain separator including the final NUL', () => {
    expect(QUOTE_PREVIEW_TOKEN_HMAC_SEPARATOR.toString('utf8')).toBe('avoqado.commercial.quote-preview-token@2\0')
    expect(QUOTE_PREVIEW_TOKEN_HMAC_SEPARATOR.at(-1)).toBe(0)
  })

  it('matches the independently controlled canonical token vector', () => {
    expect(issueCommercialQuotePreviewTokenV2(payload, secrets)).toBe(controlledToken)
  })

  it('verifies and freezes the exact payload before expiry', () => {
    const verified = verifyCommercialQuotePreviewTokenV2(controlledToken, secrets, new Date('2026-08-28T12:14:59.999Z'))

    expect(verified).toEqual(payload)
    expect(Object.isFrozen(verified)).toBe(true)
  })

  it('supports an organic acquisition without inventing a campaign version', () => {
    const organic = { ...payload, campaignVersionId: null }
    const token = issueCommercialQuotePreviewTokenV2(organic, secrets)

    expect(verifyCommercialQuotePreviewTokenV2(token, secrets, new Date('2026-08-28T12:01:00.000Z'))).toEqual(organic)
  })

  it.each([
    ['wrong prefix', controlledToken.replace(/^v2\./, 'v1.')],
    ['missing segment', controlledToken.slice(0, controlledToken.lastIndexOf('.'))],
    ['padding', `${controlledToken}=`],
    ['invalid alphabet', controlledToken.replace('eyJ', 'ey+')],
    ['oversized before decoding', `v2.${'A'.repeat(4096)}.A`],
    ['wrong signature', `${controlledToken.slice(0, -1)}A`],
  ])('rejects malformed framing without leaking it: %s', (_label, token) => {
    const error = tokenError(() => verifyCommercialQuotePreviewTokenV2(token, secrets, new Date('2026-08-28T12:01:00.000Z')))

    expect(error).toMatchObject({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' })
    expect(error.message).not.toContain(token)
    expect(error.message).not.toContain(secrets.quotePreviewSigningSecret)
  })

  it.each(['V', 'W', 'X'])('rejects a noncanonical signature last character that decodes to the same bytes: %s', lastCharacter => {
    const noncanonical = `${controlledToken.slice(0, -1)}${lastCharacter}`
    const canonicalBytes = Buffer.from(controlledToken.split('.')[2], 'base64url')

    expect(Buffer.from(noncanonical.split('.')[2], 'base64url')).toEqual(canonicalBytes)
    expect(() => verifyCommercialQuotePreviewTokenV2(noncanonical, secrets, new Date('2026-08-28T12:01:00.000Z'))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it.each([
    [
      'duplicate key',
      `{"version":2,"version":2,"previewQuoteId":"preview-quote-1","previewChecksum":"${'a'.repeat(64)}","acquisitionContextId":"acq-context-1","publicationId":"publication-v2-1","campaignVersionId":"campaign-version-1","selectionFingerprint":"${'b'.repeat(64)}","issuedAt":"2026-08-28T12:00:00.000Z","expiresAt":"2026-08-28T12:15:00.000Z"}`,
    ],
    ['extra key', JSON.stringify({ ...payload, browserPrice: '22.00' })],
    ['noncanonical key order', JSON.stringify(payload)],
  ])('rejects signed but noncanonical or non-exact JSON: %s', (_label, text) => {
    const token = signRawPayload(text)

    expect(() => verifyCommercialQuotePreviewTokenV2(token, secrets, new Date('2026-08-28T12:01:00.000Z'))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it.each([
    ['noncanonical issuedAt', { ...payload, issuedAt: '2026-08-28T12:00:00.000+00:00' }],
    ['noncanonical expiresAt', { ...payload, expiresAt: '2026-08-28T12:15:00.000+00:00' }],
    ['wrong TTL', { ...payload, expiresAt: '2026-08-28T12:14:59.999Z' }],
    ['extra payload key', { ...payload, total: '58.00' }],
    ['invalid checksum', { ...payload, previewChecksum: 'A'.repeat(64) }],
    ['oversized id', { ...payload, publicationId: 'p'.repeat(129) }],
  ])('rejects an invalid payload before issuing: %s', (_label, input) => {
    expect(() => issueCommercialQuotePreviewTokenV2(input as CommercialQuotePreviewTokenPayloadV2, secrets)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it('rejects a token issued in the future using the caller clock exactly once', () => {
    class AdversarialDate extends Date {
      override getTime(): number {
        throw new Error('override must not run')
      }
    }
    const now = new AdversarialDate('2026-08-28T11:59:59.999Z')

    expect(() => verifyCommercialQuotePreviewTokenV2(controlledToken, secrets, now)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_INVALID' }),
    )
  })

  it('expires at the exact signed boundary', () => {
    expect(() => verifyCommercialQuotePreviewTokenV2(controlledToken, secrets, new Date('2026-08-28T12:15:00.000Z'))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_EXPIRED' }),
    )
  })

  it.each([
    ['missing', { ...secrets, quotePreviewSigningSecret: undefined }],
    ['short', { ...secrets, quotePreviewSigningSecret: 'é'.repeat(15) }],
    ['reused', { ...secrets, quotePreviewSigningSecret: secrets.publicationPreviewSigningSecret }],
  ])('revalidates secret separation during issue and verify: %s', (_label, invalidSecrets) => {
    expect(() => issueCommercialQuotePreviewTokenV2(payload, invalidSecrets as never)).toThrow(
      /^COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET_INVALID$/,
    )
    expect(() =>
      verifyCommercialQuotePreviewTokenV2(controlledToken, invalidSecrets as never, new Date('2026-08-28T12:01:00.000Z')),
    ).toThrow(/^COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET_INVALID$/)
  })

  it('does not put lines, totals, quote JSON or either secret in the payload', () => {
    const decodedPayload = Buffer.from(controlledToken.split('.')[1], 'base64url')

    expect(decodedPayload).toEqual(canonicalJsonBytesV2(payload))
    expect(decodedPayload.toString('utf8')).not.toMatch(/lines|total|tax|renewal|grant|bearer|secret/i)
    expect(controlledToken).not.toContain(secrets.quotePreviewSigningSecret)
    expect(controlledToken).not.toContain(secrets.publicationPreviewSigningSecret)
  })
})
