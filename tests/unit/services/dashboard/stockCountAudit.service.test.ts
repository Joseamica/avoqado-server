import { prismaMock } from '../../../__helpers__/setup'
import { listStockCountsForAudit, getStockCountForAudit, STOCK_COUNT_PAGE_MAX } from '@/services/dashboard/stockCountAudit.service'

/**
 * La lista del dashboard cargaba TODOS los conteos del venue con TODAS sus
 * líneas para calcular un `totalDifference` que además mezclaba unidades y
 * sumaba líneas sin contar. Ahora: paginación en la base, tope 100 impuesto
 * por el servidor, y el resumen (la regla única) sólo para la página.
 */
const cabecera = (o: Record<string, unknown>) => ({
  id: 'c1',
  type: 'FULL',
  status: 'IN_PROGRESS',
  note: null,
  createdAt: new Date('2026-09-07T22:51:23.142Z'),
  completedAt: null,
  cancelledAt: null,
  createdByUser: { firstName: 'Fatima', lastName: 'Flores' },
  ...o,
})

describe('listStockCountsForAudit — acotada', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.stockCount.findMany.mockResolvedValue([cabecera({})] as never)
    prismaMock.stockCount.count.mockResolvedValue(1)
    prismaMock.stockCountItem.findMany.mockResolvedValue([
      { stockCountId: 'c1', expected: '20.000', counted: '0.000', countedAt: null, rawMaterial: null },
      { stockCountId: 'c1', expected: '500.000', counted: '350.000', countedAt: new Date(), rawMaterial: { unit: 'GRAM' } },
    ] as never)
  })

  it('pagina en la base con orden estable y el tope lo pone el servidor', async () => {
    await listStockCountsForAudit('v1', { page: 3, pageSize: 500 })
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'v1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 2 * STOCK_COUNT_PAGE_MAX,
        take: STOCK_COUNT_PAGE_MAX,
      }),
    )
  })

  it('un page/pageSize ilegible NO llega a la base como NaN', async () => {
    // Lo que produce el controlador con `?page=abc` / `?page[a]=1`: parseInt → NaN.
    // `Math.max(1, NaN)` sigue siendo NaN, y un `skip: NaN` sale como un 500 de Prisma:
    // la única función cuyo trabajo es acotar la consulta la dejaba sin acotar.
    await listStockCountsForAudit('v1', { page: NaN, pageSize: NaN })
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }))
  })

  it('un page/pageSize ilegible tampoco sale en la respuesta como NaN', async () => {
    const r = await listStockCountsForAudit('v1', { page: NaN, pageSize: NaN })
    expect(r.pagination).toEqual({ page: 1, pageSize: 50, total: 1, totalPages: 1 })
  })

  it('una página negativa cae al principio, nunca a un skip negativo', async () => {
    await listStockCountsForAudit('v1', { page: -5 })
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0 }))
  })

  it('una página enorme NO produce un skip fuera del Int de 32 bits de Postgres', async () => {
    // `999999999` es finito, así que el clamp del NaN lo deja pasar tal cual y
    // `skip` sale ≈ 5e10: Prisma lo rechaza y el cliente recibe un 500 desde la URL.
    await listStockCountsForAudit('v1', { page: 999_999_999, pageSize: 100 })
    const { skip } = prismaMock.stockCount.findMany.mock.calls[0][0] as unknown as { skip: number }
    expect(Number.isFinite(skip)).toBe(true)
    expect(skip).toBeLessThanOrEqual(2_147_483_647)
    expect(skip).toBeGreaterThanOrEqual(0)
  })

  it('pageSize 0 se recorta al piso de 1, nunca a un take de 0', async () => {
    await listStockCountsForAudit('v1', { pageSize: 0 })
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
  })

  it('IN_PROGRESS del cliente incluye APPLYING en la base', async () => {
    await listStockCountsForAudit('v1', { status: 'IN_PROGRESS' })
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', status: { in: ['IN_PROGRESS', 'APPLYING'] } } }),
    )
  })

  it('sin pageSize, el tamaño de página lo pone el servidor (50)', async () => {
    await listStockCountsForAudit('v1', {})
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }))
  })

  it('el filtro de tipo llega a la base', async () => {
    await listStockCountsForAudit('v1', { type: 'FULL' })
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'v1', type: 'FULL' } }))
  })

  it('el rango de fechas va a createdAt, con gte/lte en su lugar (no invertidos)', async () => {
    const desde = new Date('2026-09-01T00:00:00.000Z')
    const hasta = new Date('2026-09-30T23:59:59.999Z')
    await listStockCountsForAudit('v1', { startDate: desde, endDate: hasta })
    expect(prismaMock.stockCount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', createdAt: { gte: desde, lte: hasta } } }),
    )
  })

  it('el resumen se calcula sólo con las líneas de los conteos de la página', async () => {
    const { rows } = await listStockCountsForAudit('v1', {})
    expect(prismaMock.stockCountItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stockCountId: { in: ['c1'] } },
        select: { stockCountId: true, expected: true, counted: true, countedAt: true, rawMaterial: { select: { unit: true } } },
      }),
    )
    expect(rows[0].summary).toEqual({
      itemCount: 2,
      countedCount: 1,
      matchedCount: 0,
      mismatchedCount: 1,
      differenceByUnit: [{ unit: 'GRAM', difference: -150 }],
    })
  })

  it('totalDifference (deprecado) ya NO suma líneas sin contar', async () => {
    const { rows } = await listStockCountsForAudit('v1', {})
    // Antes: (0-20) + (350-500) = -170. Ahora sólo la línea contada: -150.
    expect(rows[0].totalDifference).toBe(-150)
  })

  it('devuelve metadatos de paginación y el estado para clientes', async () => {
    prismaMock.stockCount.count.mockResolvedValue(250)
    const r = await listStockCountsForAudit('v1', { page: 1, pageSize: 50 })
    expect(r.pagination).toEqual({ page: 1, pageSize: 50, total: 250, totalPages: 5 })
    expect(r.rows[0]).toMatchObject({ id: 'c1', status: 'IN_PROGRESS', createdBy: 'Fatima Flores', itemCount: 2, cancelledAt: null })
  })

  it('un conteo cancelado sí aparece, con su fecha', async () => {
    prismaMock.stockCount.findMany.mockResolvedValue([
      cabecera({ status: 'CANCELLED', cancelledAt: new Date('2026-09-08T01:00:00.000Z') }),
    ] as never)
    const { rows } = await listStockCountsForAudit('v1', {})
    expect(rows[0]).toMatchObject({ status: 'CANCELLED', cancelledAt: '2026-09-08T01:00:00.000Z' })
  })
})

describe('getStockCountForAudit', () => {
  it('busca por id Y venue (nunca por id pelón) y trae items con countedAt', async () => {
    prismaMock.stockCount.findFirst.mockResolvedValue(
      cabecera({
        items: [
          {
            id: 'i1',
            productId: 'p1',
            rawMaterialId: null,
            expected: '20.000',
            counted: '0.000',
            countedAt: null,
            appliedAt: null,
            product: { id: 'p1', name: 'Gorra', sku: '10025', gtin: null, imageUrl: null },
            rawMaterial: null,
          },
        ],
      }) as never,
    )
    const d = await getStockCountForAudit('v1', 'c1')
    expect(prismaMock.stockCount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', venueId: 'v1' } }))
    expect(d?.items[0]).toMatchObject({ id: 'i1', countedAt: null, expected: 20, counted: 0 })
    expect(d?.summary.countedCount).toBe(0)
  })

  it('null cuando no existe en este negocio', async () => {
    prismaMock.stockCount.findFirst.mockResolvedValue(null)
    await expect(getStockCountForAudit('v1', 'ajeno')).resolves.toBeNull()
  })
})
