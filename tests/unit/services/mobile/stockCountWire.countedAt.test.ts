import { prismaMock } from '../../../__helpers__/setup'
import { getStockCounts, mapCountItem } from '@/services/mobile/inventory.mobile.service'

/**
 * El servidor guardaba `countedAt` y NUNCA lo mandaba. Android e iOS tienen el
 * campo desde el 2026-08-03 («el server ya lo distinguía y la app lo
 * ignoraba») — pero el server no lo mandaba, así que `yaSeConto` siempre era
 * false: retomar un conteo se paraba en la línea 1 y el detalle pintaba
 * «Contado 0» en todo. Contrato aditivo: se AÑADE, nada cambia de forma.
 */
const item = (o: Record<string, unknown>) => ({
  id: 'i1',
  productId: 'p1',
  rawMaterialId: null,
  expected: '20.000',
  counted: '0.000',
  countedAt: null,
  appliedAt: null,
  product: { id: 'p1', name: 'Gorra Beige', sku: '10025', gtin: null, imageUrl: null },
  rawMaterial: null,
  ...o,
})

describe('mapCountItem — countedAt viaja al cliente', () => {
  it('una línea sin contar lleva countedAt: null y conserva counted/difference numéricos', () => {
    const wire = mapCountItem(item({}) as never)
    expect(wire.countedAt).toBeNull()
    expect(wire.counted).toBe(0)
    expect(wire.difference).toBe(-20)
  })

  it('una línea contada lleva countedAt en ISO', () => {
    const wire = mapCountItem(item({ counted: '18.000', countedAt: new Date('2026-09-07T22:51:00.000Z') }) as never)
    expect(wire.countedAt).toBe('2026-09-07T22:51:00.000Z')
    expect(wire.difference).toBe(-2)
  })
})

describe('mapCountItem — la línea que el conteo NO aplicó por Shopify (L5)', () => {
  it('una línea retenida lleva shopifyHeld con la hora en ISO UTC y el motivo', () => {
    const wire = mapCountItem(
      item({
        counted: '18.000',
        countedAt: new Date(),
        shopifyHeldAt: new Date('2026-10-08T15:00:00.000Z'),
        shopifyHeldReason: 'ENVIO_EN_CAMINO',
      }) as never,
    )
    expect(wire.shopifyHeld).toEqual({ at: '2026-10-08T15:00:00.000Z', motivo: 'ENVIO_EN_CAMINO' })
    expect(
      mapCountItem(item({ shopifyHeldAt: new Date('2026-10-08T15:00:00.000Z'), shopifyHeldReason: 'DUDA_POR_REVISAR' }) as never)
        .shopifyHeld,
    ).toEqual({ at: '2026-10-08T15:00:00.000Z', motivo: 'DUDA_POR_REVISAR' })
  })

  it('una línea aplicada (o sin conexión) lleva shopifyHeld: null', () => {
    expect(mapCountItem(item({ shopifyHeldAt: null, shopifyHeldReason: null }) as never).shopifyHeld).toBeNull()
    // Una fila sin las columnas (fixture viejo) tampoco inventa una retención.
    expect(mapCountItem(item({}) as never).shopifyHeld).toBeNull()
  })

  it('🔴 regresión: los campos de siempre no cambian por la retención', () => {
    const base = mapCountItem(item({ counted: '18.000', countedAt: new Date('2026-09-07T22:51:00.000Z') }) as never)
    const retenida = mapCountItem(
      item({
        counted: '18.000',
        countedAt: new Date('2026-09-07T22:51:00.000Z'),
        shopifyHeldAt: new Date('2026-10-08T15:00:00.000Z'),
        shopifyHeldReason: 'ENVIO_EN_CAMINO',
      }) as never,
    )
    expect(retenida).toEqual({ ...base, shopifyHeld: { at: '2026-10-08T15:00:00.000Z', motivo: 'ENVIO_EN_CAMINO' } })
  })
})

describe('getStockCounts — summary y cancelados', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.stockCount.findMany.mockResolvedValue([
      {
        id: 'c1',
        revision: 7,
        type: 'FULL',
        status: 'APPLYING',
        note: null,
        createdAt: new Date('2026-09-07T22:51:23.142Z'),
        createdByUser: { id: 's1', firstName: 'Fatima', lastName: 'Flores' },
        items: [
          item({}),
          item({
            id: 'i2',
            productId: null,
            rawMaterialId: 'rm1',
            product: null,
            rawMaterial: { id: 'rm1', name: 'Hielo', sku: null, gtin: null, unit: 'GRAM' },
            expected: '92420.000',
            counted: '92000.000',
            countedAt: new Date(),
          }),
        ],
      },
    ] as never)
  })

  it('cada conteo trae summary calculado SOLO sobre líneas contadas', async () => {
    const [c] = await getStockCounts('v1')
    expect(c.summary).toEqual({
      itemCount: 2,
      countedCount: 1,
      matchedCount: 0,
      mismatchedCount: 1,
      differenceByUnit: [{ unit: 'GRAM', difference: -420 }],
    })
  })

  it('APPLYING se sigue mapeando a IN_PROGRESS para las apps', async () => {
    const [c] = await getStockCounts('v1')
    expect(c.status).toBe('IN_PROGRESS')
  })

  it('expone la revisión del agregado en cada conteo', async () => {
    const [c] = await getStockCounts('v1')
    expect(c.revision).toBe(7)
  })

  it('🔴 la consulta EXCLUYE los cancelados: un status desconocido tira el decoder de las apps', async () => {
    await getStockCounts('v1')
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', status: { not: 'CANCELLED' } } }),
    )
  })

  // ── Regresión: nada de lo viejo cambia de forma ───────────────────────────
  it('conserva id, type, note, createdAt ISO, createdBy, itemCount e items', async () => {
    const [c] = await getStockCounts('v1')
    expect(c).toMatchObject({
      id: 'c1',
      type: 'FULL',
      note: null,
      createdAt: '2026-09-07T22:51:23.142Z',
      createdBy: 'Fatima Flores',
      itemCount: 2,
    })
    expect(c.items).toHaveLength(2)
    expect(c.items[1]).toMatchObject({ itemType: 'RAW_MATERIAL', unit: 'GRAM', productId: 'rm1' })
  })

  it('🔴 el GET móvil conserva la forma vieja de cada línea y sólo AÑADE shopifyHeld', async () => {
    const [c] = await getStockCounts('v1')
    expect(Object.keys(c.items[0]).sort()).toEqual(
      [
        'id',
        'productId',
        'rawMaterialId',
        'itemType',
        'productName',
        'sku',
        'gtin',
        'imageUrl',
        'unit',
        'expected',
        'counted',
        'difference',
        'countedAt',
        'shopifyHeld',
      ].sort(),
    )
    expect(c.items[0]).toMatchObject({
      id: 'i1',
      productId: 'p1',
      itemType: 'PRODUCT',
      productName: 'Gorra Beige',
      expected: 20,
      counted: 0,
    })
    expect(c.items[0].shopifyHeld).toBeNull()
  })
})
