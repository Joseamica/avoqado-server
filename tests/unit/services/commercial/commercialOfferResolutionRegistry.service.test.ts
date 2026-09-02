import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import resolutionSchema from '@/contracts/commercial/commercial-offer-resolution-v2.schema.json'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferStacking.service'
import {
  COMMERCIAL_OFFER_RESOLUTION_REGISTRY,
  CommercialOfferResolutionVersionError,
  createCommercialOfferResolutionRegistry,
  resolveCommercialOfferV3Revision2,
  resolveCommercialOfferV3WithRegistry,
} from '@/services/commercial/offers/commercialOfferResolutionRegistry.service'
import type { CommercialOfferResolutionInputV3, CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

function input(): CommercialOfferResolutionInputV3 {
  return {
    offer: JSON.parse(JSON.stringify(offerFixture)) as CommercialOfferSnapshotV3,
    resolvedAt: '2026-08-15T12:00:00.000Z',
    saasMatches: [{ lineKey: 'PRODUCT:POS:POS_MONTHLY', ruleCodes: ['POS_FIXED_50'] }],
    hardwareSelections: [],
    rateBlockers: [],
  }
}

describe('Commercial Offer resolution registry', () => {
  describe('behavior', () => {
    it('registers revision 2 with the exact frozen resolver function and schema', () => {
      expect(resolveCommercialOfferV3Revision2).toBe(resolveCommercialOfferV3)
      expect(COMMERCIAL_OFFER_RESOLUTION_REGISTRY[2]).toEqual(
        expect.objectContaining({
          resolutionVersion: 2,
          resolve: resolveCommercialOfferV3,
          schema: resolutionSchema,
        }),
      )
      expect(resolveCommercialOfferV3WithRegistry({ resolutionVersion: 2, ...input() })).toEqual(resolveCommercialOfferV3(input()))
    })

    it('keeps historical revision 2 pinned after a fictitious later revision is registered', () => {
      const laterResolver = jest.fn(() => ({ ...resolveCommercialOfferV3(input()), resolutionVersion: 2 as const }))
      const registry = createCommercialOfferResolutionRegistry([
        COMMERCIAL_OFFER_RESOLUTION_REGISTRY[2],
        { resolutionVersion: 3, resolve: laterResolver, schema: { $id: 'fictitious-revision-3' } },
      ])

      expect(registry.resolve({ resolutionVersion: 2, ...input() })).toEqual(resolveCommercialOfferV3(input()))
      expect(laterResolver).not.toHaveBeenCalled()
      expect(registry.entries[2].resolve).toBe(resolveCommercialOfferV3Revision2)
      expect(registry.entries[3].resolve).toBe(laterResolver)
    })
  })

  describe('regression', () => {
    it.each([
      ['missing', input()],
      ['string', { resolutionVersion: '2', ...input() }],
      ['unknown', { resolutionVersion: 3, ...input() }],
      ['zero', { resolutionVersion: 0, ...input() }],
      ['fraction', { resolutionVersion: 2.5, ...input() }],
    ])('fails closed without a fallback for a %s resolution version', (_label, value) => {
      expect(() => resolveCommercialOfferV3WithRegistry(value as any)).toThrow(
        expect.objectContaining({
          code: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_UNSUPPORTED',
          retryable: false,
          poisonedRow: true,
          alertCode: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_POISONED_ROW',
          message: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_UNSUPPORTED',
        }) as CommercialOfferResolutionVersionError,
      )
    })

    it('requires resolutionVersion to be an own enumerable data property', () => {
      const inherited = Object.assign(Object.create({ resolutionVersion: 2 }), input())
      const accessor = { ...input() } as any
      Object.defineProperty(accessor, 'resolutionVersion', { enumerable: true, get: () => 2 })

      expect(() => resolveCommercialOfferV3WithRegistry(inherited)).toThrow(CommercialOfferResolutionVersionError)
      expect(() => resolveCommercialOfferV3WithRegistry(accessor)).toThrow(CommercialOfferResolutionVersionError)
    })

    it('routes Quote v3 and pair consumers through the registry without another resolver import', () => {
      const root = resolve(__dirname, '../../../..')
      const paths = [
        'src/services/commercial/quotes-v3/commercialQuoteV3Contract.service.ts',
        'src/services/commercial/quotes-v3/commercialQuoteV3Engine.service.ts',
        'src/services/commercial/offers/commercialCatalogOfferCompatibility.service.ts',
      ]
      for (const path of paths) {
        const source = readFileSync(resolve(root, path), 'utf8')
        expect(source).toContain('commercialOfferResolutionRegistry.service')
        expect(source).not.toContain('commercialOfferStacking.service')
        expect(source).toContain('resolveCommercialOfferV3WithRegistry')
      }
    })
  })
})
