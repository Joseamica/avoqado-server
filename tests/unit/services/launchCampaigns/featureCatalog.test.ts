import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { listFeatureCatalog, featureCatalogQuery } from '@/services/launchCampaigns/featureCatalog.service'
import { FREE_TIER_CODES, PREMIUM_ONLY_CODES } from '@/services/access/basePlan.service'

describe('Catálogo completo para planes y funciones', () => {
  it('representa las 41 capacidades, sin inventar precios ni revivir funciones retiradas', () => {
    expect(FEATURE_CATALOG).toHaveLength(41)
    expect(new Set(FEATURE_CATALOG.map(f => f.id)).size).toBe(41)
    expect(FEATURE_CATALOG.filter(f => f.featureCode)).toHaveLength(35)
    expect(FEATURE_CATALOG.some(f => f.featureCode === 'ADVANCED_ANALYTICS')).toBe(false)
    expect(FEATURE_CATALOG.every(f => !('price' in f) && !('monthlyPrice' in f))).toBe(true)
  })

  it('conserva todas las inclusiones Premium y Gratis existentes', () => {
    expect(
      FEATURE_CATALOG.filter(f => f.minimumTier === 'PREMIUM')
        .map(f => f.featureCode)
        .sort(),
    ).toEqual([...PREMIUM_ONLY_CODES].sort())
    expect(FEATURE_CATALOG.filter(f => f.minimumTier === 'FREE' && f.featureCode).map(f => f.featureCode)).toEqual([...FREE_TIER_CODES])
    for (const code of ['AREA_TICKETS', 'VARIABLE_WEIGHT_BARCODE', 'CUSTOMER_CAMPAIGNS']) {
      expect(FEATURE_CATALOG.find(f => f.featureCode === code)?.minimumTier).toBe('PRO')
    }
    expect(FEATURE_CATALOG.find(f => f.featureCode === 'MASTER_CATALOG')?.minimumTier).toBeNull()
  })

  it('permite recorrer el total en páginas estables sin duplicar ni ocultar registros', () => {
    const first = listFeatureCatalog({ pageSize: 12 })
    expect(first.total).toBe(41)
    expect(first.totalPages).toBe(4)
    const ids = [1, 2, 3, 4].flatMap(page => listFeatureCatalog({ page, pageSize: 12 }).items.map(f => f.id))
    expect(new Set(ids).size).toBe(41)
    expect(listFeatureCatalog({ page: 5, pageSize: 12 }).items).toEqual([])
    expect(listFeatureCatalog({}).catalogVersion).toBe(first.catalogVersion)
  })

  it('filtra antes de paginar y busca por nombre, descripción y código sin distinguir acentos', () => {
    const page = listFeatureCatalog({ q: 'facturacion', pageSize: 1 })
    expect(page.items.map(f => f.featureCode)).toEqual(['CFDI'])
    expect(page.total).toBe(1)
    expect(listFeatureCatalog({ q: 'AREA_TICKETS' }).items[0].featureCode).toBe('AREA_TICKETS')
    expect(listFeatureCatalog({ category: 'customers', pageSize: 1 }).total).toBe(5)
    expect(listFeatureCatalog({ q: '<script>' }).total).toBe(0)
  })

  it.each([{ pageSize: 101 }, { pageSize: 0 }, { page: -1 }, { page: 1.5 }, { category: 'unknown' }, { q: 'x'.repeat(121) }])(
    'rechaza consultas fuera del contrato: %j',
    query => {
      expect(() => listFeatureCatalog(query)).toThrow()
    },
  )

  it('acepta parámetros HTTP y limita el catálogo también fuera del controller', () => {
    expect(featureCatalogQuery.parse({ page: '2', pageSize: '12' })).toMatchObject({ page: 2, pageSize: 12 })
    expect(listFeatureCatalog({}).items).toHaveLength(25)
    expect(listFeatureCatalog({ pageSize: 100 }).items).toHaveLength(41)
  })
})
