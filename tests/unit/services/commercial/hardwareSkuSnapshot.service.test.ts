import { TPV_CATALOG, type TpvCatalogEntry } from '@/config/tpvCatalog'
import { createHardwareSkuSnapshotV3 } from '@/services/commercial/offers/hardwareSkuSnapshot.service'

function cloneCatalog(): Record<string, TpvCatalogEntry> {
  return JSON.parse(JSON.stringify(TPV_CATALOG)) as Record<string, TpvCatalogEntry>
}

describe('Commercial Offer v3 hardware SKU snapshot', () => {
  it.each([
    ['PAX_A910S', 'PAX', 'A910S', 'PAX A910S', '400000'],
    ['NEXGO_N62', 'NEXGO', 'N62', 'NexGo N62', '180000'],
    ['NEXGO_N86', 'NEXGO', 'N86', 'NexGo N86', '300000'],
  ])('freezes %s from authoritative catalog fields', (catalogKey, brand, model, name, listUnitAmountMinor) => {
    const snapshot = createHardwareSkuSnapshotV3(catalogKey)

    expect(snapshot).toEqual({
      catalogKey,
      catalogContentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      brand,
      model,
      name,
      listUnitAmountMinor,
      currency: 'MXN',
      taxRateBasisPoints: 1600,
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot).not.toHaveProperty('description')
    expect(snapshot).not.toHaveProperty('image')
    expect(snapshot).not.toHaveProperty('specs')
  })

  it('is deterministic and immune to later source mutation', () => {
    const catalog = cloneCatalog()
    const snapshot = createHardwareSkuSnapshotV3('PAX_A910S', catalog)
    const same = createHardwareSkuSnapshotV3('PAX_A910S', cloneCatalog())

    catalog.PAX_A910S.brand = 'CHANGED'
    catalog.PAX_A910S.unitPriceCents = 1

    expect(snapshot.brand).toBe('PAX')
    expect(snapshot.listUnitAmountMinor).toBe('400000')
    expect(snapshot.catalogContentHash).toBe(same.catalogContentHash)
  })

  it('changes the source hash when any frozen authority field changes', () => {
    const catalog = cloneCatalog()
    const original = createHardwareSkuSnapshotV3('NEXGO_N62', catalog)

    catalog.NEXGO_N62.name = 'NexGo N62 revision 2'
    const changed = createHardwareSkuSnapshotV3('NEXGO_N62', catalog)

    expect(changed.catalogContentHash).not.toBe(original.catalogContentHash)
  })

  it('rejects unknown, zero, negative, fractional and unsafe prices', () => {
    expect(() => createHardwareSkuSnapshotV3('UNKNOWN')).toThrow('COMMERCIAL_HARDWARE_SKU_UNKNOWN')

    for (const price of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1_000_000_000_000]) {
      const catalog = cloneCatalog()
      catalog.PAX_A910S.unitPriceCents = price
      expect(() => createHardwareSkuSnapshotV3('PAX_A910S', catalog)).toThrow('COMMERCIAL_HARDWARE_SKU_PRICE_INVALID')
    }
  })

  it('rejects malformed source identity instead of normalizing it silently', () => {
    const catalog = cloneCatalog()
    catalog.PAX_A910S.brand = ''
    expect(() => createHardwareSkuSnapshotV3('PAX_A910S', catalog)).toThrow('COMMERCIAL_HARDWARE_SKU_SOURCE_INVALID')
  })
})
