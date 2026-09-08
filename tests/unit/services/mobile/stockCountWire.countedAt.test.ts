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
})
