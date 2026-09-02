import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import checkoutVector from '@/contracts/commercial/vectors/v2/checkout-request-fingerprint.json'
import selectionVector from '@/contracts/commercial/vectors/v2/selection-fingerprint.json'
import { canonicalJsonBytesV2, hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  CommercialCheckoutRequestFingerprintInputV2,
  CommercialSelectionFingerprintInputV2,
  fingerprintCommercialCheckoutRequestV2,
  fingerprintCommercialSelectionV2,
} from '@/services/commercial/commercialFingerprintV2.service'

const selectionInput: CommercialSelectionFingerprintInputV2 = {
  lines: selectionVector.preimage.lines.map(line => ({
    targetType: line.targetType as 'PRODUCT' | 'BUNDLE',
    targetCode: line.targetCode,
    priceCode: line.priceCode,
    quantity: line.quantity,
  })),
}

const checkoutInput: CommercialCheckoutRequestFingerprintInputV2 = {
  operationType: checkoutVector.preimage.operationType as 'CHECKOUT_SESSION',
  acceptanceId: checkoutVector.preimage.acceptanceId,
  quoteId: checkoutVector.preimage.quoteId,
  quoteChecksum: checkoutVector.preimage.quoteChecksum,
  organizationId: checkoutVector.preimage.organizationId,
  venueId: checkoutVector.preimage.venueId,
}

describe('commercialFingerprintV2', () => {
  describe('new selection fingerprint behavior', () => {
    it('matches the independently frozen selection preimage, bytes, and digest', () => {
      expect(canonicalJsonBytesV2(selectionVector.preimage).toString('hex')).toBe(selectionVector.canonicalUtf8Hex)
      expect(hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE_SELECTION, selectionVector.preimage)).toBe(selectionVector.digestSha256)
      expect(fingerprintCommercialSelectionV2(selectionInput)).toBe(selectionVector.digestSha256)
    })

    it('sorts selection lines by their derived ASCII lineKey', () => {
      const first: CommercialSelectionFingerprintInputV2 = {
        lines: [
          { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_YEARLY', quantity: 1 },
          { targetType: 'BUNDLE', targetCode: 'ALL_MODULES', priceCode: 'ALL_MODULES_MONTHLY', quantity: 1 },
        ],
      }
      const reversed: CommercialSelectionFingerprintInputV2 = { lines: [...first.lines].reverse() }

      expect(fingerprintCommercialSelectionV2(first)).toBe(fingerprintCommercialSelectionV2(reversed))
    })

    it('rejects duplicate derived lineKeys even when quantities differ', () => {
      expect(() =>
        fingerprintCommercialSelectionV2({
          lines: [
            { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 },
            { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 2 },
          ],
        }),
      ).toThrow('COMMERCIAL_SELECTION_FINGERPRINT_V2_INVALID')
    })

    it.each([
      { targetType: 'PLAN', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 },
      { targetType: 'PRODUCT', targetCode: 'pos', priceCode: 'POS_MONTHLY', quantity: 1 },
      { targetType: 'PRODUCT', targetCode: 'P', priceCode: 'POS_MONTHLY', quantity: 1 },
      { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'monthly', quantity: 1 },
      { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 0 },
      { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1.5 },
      { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1_001 },
    ])('rejects an invalid selection line %#', line => {
      expect(() => fingerprintCommercialSelectionV2({ lines: [line] } as unknown as CommercialSelectionFingerprintInputV2)).toThrow(
        'COMMERCIAL_SELECTION_FINGERPRINT_V2_INVALID',
      )
    })

    it('rebuilds an allowlisted preimage so caller metadata cannot enter the digest', () => {
      const withForbiddenMetadata = {
        ...selectionInput,
        subject: { venueId: 'other' },
        metadata: { amountMinor: 24_900n },
        campaignCode: 'FORBIDDEN',
      } as unknown as CommercialSelectionFingerprintInputV2

      expect(fingerprintCommercialSelectionV2(withForbiddenMetadata)).toBe(fingerprintCommercialSelectionV2(selectionInput))
    })

    it('rejects a lines accessor before reading it, including a stateful TOCTOU value', () => {
      let reads = 0
      const input = Object.defineProperty({}, 'lines', {
        enumerable: true,
        get: () => {
          reads += 1
          return reads === 1
            ? [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }]
            : [{ targetType: 'BUNDLE', targetCode: 'ALL_MODULES', priceCode: 'ALL_MODULES_MONTHLY', quantity: 1 }]
        },
      }) as CommercialSelectionFingerprintInputV2

      expect(() => fingerprintCommercialSelectionV2(input)).toThrow(/^COMMERCIAL_SELECTION_FINGERPRINT_V2_INVALID$/)
      expect(reads).toBe(0)
    })

    it('normalizes hostile selection Proxies and getters without leaking caller errors', () => {
      const rootProxy = new Proxy(selectionInput, {
        getPrototypeOf: () => {
          throw new Error('SELECTION_ROOT_PROXY_LEAK')
        },
      })
      const linesProxy = new Proxy([...selectionInput.lines], {
        get: () => {
          throw new Error('SELECTION_LINES_PROXY_LEAK')
        },
      })
      const lineProxy = new Proxy(selectionInput.lines[0], {
        getPrototypeOf: () => {
          throw new Error('SELECTION_LINE_PROXY_LEAK')
        },
      })
      const hostileLinesGetter = Object.defineProperty({}, 'lines', {
        enumerable: true,
        get: () => {
          throw new Error('SELECTION_LINES_GETTER_LEAK')
        },
      })

      for (const input of [rootProxy, { lines: linesProxy }, { lines: [lineProxy] }, hostileLinesGetter]) {
        expect(() => fingerprintCommercialSelectionV2(input as CommercialSelectionFingerprintInputV2)).toThrow(
          /^COMMERCIAL_SELECTION_FINGERPRINT_V2_INVALID$/,
        )
      }
    })

    it.each(['targetType', 'targetCode', 'priceCode', 'quantity'] as const)(
      'rejects an accessor selection line field %s before invoking it',
      field => {
        let reads = 0
        const line = { ...selectionInput.lines[0] } as Record<string, unknown>
        const value = line[field]
        Object.defineProperty(line, field, {
          enumerable: true,
          get: () => {
            reads += 1
            return value
          },
        })

        expect(() => fingerprintCommercialSelectionV2({ lines: [line] } as unknown as CommercialSelectionFingerprintInputV2)).toThrow(
          /^COMMERCIAL_SELECTION_FINGERPRINT_V2_INVALID$/,
        )
        expect(reads).toBe(0)
      },
    )

    it('requires enumerable data descriptors for the lines root and each array index', () => {
      const hiddenRoot = Object.defineProperty({}, 'lines', {
        enumerable: false,
        value: selectionInput.lines,
      })
      const hiddenIndex = [...selectionInput.lines]
      Object.defineProperty(hiddenIndex, '0', { enumerable: false, value: selectionInput.lines[0] })
      const accessorIndex = [...selectionInput.lines]
      Object.defineProperty(accessorIndex, '0', { enumerable: true, get: () => selectionInput.lines[0] })

      for (const input of [hiddenRoot, { lines: hiddenIndex }, { lines: accessorIndex }]) {
        expect(() => fingerprintCommercialSelectionV2(input as CommercialSelectionFingerprintInputV2)).toThrow(
          /^COMMERCIAL_SELECTION_FINGERPRINT_V2_INVALID$/,
        )
      }
    })
  })

  describe('new checkout request fingerprint behavior', () => {
    it('matches the independently frozen checkout preimage, bytes, and digest', () => {
      expect(canonicalJsonBytesV2(checkoutVector.preimage).toString('hex')).toBe(checkoutVector.canonicalUtf8Hex)
      expect(hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.STRIPE_CHECKOUT_REQUEST, checkoutVector.preimage)).toBe(checkoutVector.digestSha256)
      expect(fingerprintCommercialCheckoutRequestV2(checkoutInput)).toBe(checkoutVector.digestSha256)
    })

    it('rebuilds an allowlisted preimage so amounts and metadata cannot enter the digest', () => {
      const withForbiddenFields = {
        ...checkoutInput,
        totalMinor: 24_900n,
        metadata: { source: 'caller' },
      } as unknown as CommercialCheckoutRequestFingerprintInputV2

      expect(fingerprintCommercialCheckoutRequestV2(withForbiddenFields)).toBe(fingerprintCommercialCheckoutRequestV2(checkoutInput))
    })

    it('changes when quote integrity or tenant scope changes', () => {
      const baseline = fingerprintCommercialCheckoutRequestV2(checkoutInput)

      expect(fingerprintCommercialCheckoutRequestV2({ ...checkoutInput, quoteChecksum: 'f'.repeat(64) })).not.toBe(baseline)
      expect(fingerprintCommercialCheckoutRequestV2({ ...checkoutInput, organizationId: 'another_org' })).not.toBe(baseline)
      expect(fingerprintCommercialCheckoutRequestV2({ ...checkoutInput, venueId: 'another_venue' })).not.toBe(baseline)
    })

    it.each([
      { operationType: 'PAYMENT_INTENT' },
      { acceptanceId: '' },
      { quoteId: '' },
      { quoteChecksum: 'A'.repeat(64) },
      { quoteChecksum: '0'.repeat(63) },
      { organizationId: '' },
      { venueId: '' },
    ])('rejects malformed checkout authority fields %#', override => {
      expect(() =>
        fingerprintCommercialCheckoutRequestV2({
          ...checkoutInput,
          ...override,
        } as unknown as CommercialCheckoutRequestFingerprintInputV2),
      ).toThrow('COMMERCIAL_CHECKOUT_REQUEST_FINGERPRINT_V2_INVALID')
    })

    it.each([
      ['operationType', 'REFUND'],
      ['quoteChecksum', 'not-a-checksum'],
      ['organizationId', 'other-organization'],
      ['venueId', 'other-venue'],
    ] as const)('rejects a stateful %s accessor before TOCTOU hashing', (field, secondValue) => {
      let reads = 0
      const input = { ...checkoutInput } as Record<string, unknown>
      const firstValue = input[field]
      Object.defineProperty(input, field, {
        enumerable: true,
        get: () => {
          reads += 1
          return reads === 1 ? firstValue : secondValue
        },
      })

      expect(() => fingerprintCommercialCheckoutRequestV2(input as unknown as CommercialCheckoutRequestFingerprintInputV2)).toThrow(
        /^COMMERCIAL_CHECKOUT_REQUEST_FINGERPRINT_V2_INVALID$/,
      )
      expect(reads).toBe(0)
    })

    it('normalizes hostile checkout Proxy/getter errors across operation, checksum, and scope', () => {
      const rootProxy = new Proxy(checkoutInput, {
        getPrototypeOf: () => {
          throw new Error('CHECKOUT_ROOT_PROXY_LEAK')
        },
      })

      for (const field of ['operationType', 'quoteChecksum', 'organizationId', 'venueId'] as const) {
        const input = { ...checkoutInput } as Record<string, unknown>
        Object.defineProperty(input, field, {
          enumerable: true,
          get: () => {
            throw new Error(`CHECKOUT_${field}_GETTER_LEAK`)
          },
        })
        expect(() => fingerprintCommercialCheckoutRequestV2(input as unknown as CommercialCheckoutRequestFingerprintInputV2)).toThrow(
          /^COMMERCIAL_CHECKOUT_REQUEST_FINGERPRINT_V2_INVALID$/,
        )
      }
      expect(() => fingerprintCommercialCheckoutRequestV2(rootProxy)).toThrow(/^COMMERCIAL_CHECKOUT_REQUEST_FINGERPRINT_V2_INVALID$/)
    })

    it('requires every checkout authority field to be an own enumerable data property', () => {
      for (const field of ['operationType', 'acceptanceId', 'quoteId', 'quoteChecksum', 'organizationId', 'venueId'] as const) {
        const input = { ...checkoutInput }
        Object.defineProperty(input, field, {
          enumerable: false,
          value: input[field],
        })
        expect(() => fingerprintCommercialCheckoutRequestV2(input)).toThrow(/^COMMERCIAL_CHECKOUT_REQUEST_FINGERPRINT_V2_INVALID$/)
      }
    })
  })

  describe('regression guardrails', () => {
    it('returns lowercase SHA-256 hex for both fingerprint domains', () => {
      expect(fingerprintCommercialSelectionV2(selectionInput)).toMatch(/^[0-9a-f]{64}$/)
      expect(fingerprintCommercialCheckoutRequestV2(checkoutInput)).toMatch(/^[0-9a-f]{64}$/)
    })
  })
})
