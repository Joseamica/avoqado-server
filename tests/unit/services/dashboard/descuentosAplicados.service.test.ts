// Reporte «Descuentos» (encargo f998c8): agrupado por motivo exacto en la base + lista paginada con tope del servidor.
import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { listarDescuentosAplicados, PAGINA_MAXIMA, SIN_MOTIVO } from '@/services/dashboard/descuentosAplicados.service'

const db = prismaMock as any

beforeEach(() => {
  jest.clearAllMocks()
  db.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  db.orderDiscount.aggregate = jest.fn().mockResolvedValue({ _count: { _all: 3 }, _sum: { amount: new Decimal('45.5') } })
  db.orderDiscount.groupBy = jest.fn().mockResolvedValue([
    { reason: 'Queja del cliente', _count: { _all: 2 }, _sum: { amount: new Decimal('30') } },
    { reason: null, _count: { _all: 1 }, _sum: { amount: new Decimal('15.5') } },
  ])
  db.orderDiscount.count = jest.fn().mockResolvedValue(3)
  db.orderDiscount.findMany = jest.fn().mockResolvedValue([
    {
      id: 'od-1',
      createdAt: new Date('2026-11-16T18:00:00Z'),
      orderId: 'o-1',
      name: 'Ajuste de precio',
      type: 'FIXED_AMOUNT',
      amount: new Decimal('20'),
      reason: 'Queja del cliente',
      reasonComment: 'tardó',
      order: { orderNumber: 'A-12', createdAt: new Date('2026-11-16T17:40:00Z'), clientCreatedAt: null },
      appliedBy: { staff: { firstName: 'Ana', lastName: 'López' } },
      authorizedBy: { staff: { firstName: 'Beto', lastName: null } },
    },
  ])
})

describe('listarDescuentosAplicados', () => {
  it('días del negocio: 15-nov en México = 06:00 UTC a 05:59:59.999 UTC del día siguiente', async () => {
    const r = await listarDescuentosAplicados('venue-1', { from: '2026-11-15', to: '2026-11-15' })
    expect(r.from.toISOString()).toBe('2026-11-15T06:00:00.000Z')
    expect(r.to.toISOString()).toBe('2026-11-16T05:59:59.999Z')
    const where = db.orderDiscount.aggregate.mock.calls[0][0].where
    expect(where.order.AND[0]).toMatchObject({ venueId: 'venue-1', status: { notIn: ['CANCELLED', 'DELETED'] } })
  })

  it('totales y agrupado por motivo salen de la base (exactos), en pesos, con «Sin motivo» como null', async () => {
    const r = await listarDescuentosAplicados('venue-1')
    expect(r.totales).toEqual({ count: 3, amount: 45.5 })
    expect(r.porMotivo).toEqual([
      { reason: 'Queja del cliente', count: 2, amount: 30 },
      { reason: null, count: 1, amount: 15.5 },
    ])
    expect(r.motivosRecortados).toBe(false)
  })

  it('la fila trae folio, motivo, comentario y los nombres de quien aplicó y aprobó', async () => {
    const r = await listarDescuentosAplicados('venue-1')
    expect(r.rows[0]).toEqual(
      expect.objectContaining({
        orderNumber: 'A-12',
        // D4: la fecha de la VENTA (la cuenta), la misma que filtra el periodo, no la del renglón del descuento.
        createdAt: new Date('2026-11-16T17:40:00Z'),
        amount: 20,
        reason: 'Queja del cliente',
        reasonComment: 'tardó',
        appliedBy: 'Ana López',
        authorizedBy: 'Beto',
      }),
    )
  })

  it(`tope del servidor: pageSize 5000 ⇒ ${PAGINA_MAXIMA}; orden estable createdAt e id; el total viaja`, async () => {
    const r = await listarDescuentosAplicados('venue-1', { pageSize: 5000, page: 2 })
    const args = db.orderDiscount.findMany.mock.calls[0][0]
    expect(args.take).toBe(PAGINA_MAXIMA)
    expect(args.skip).toBe(PAGINA_MAXIMA)
    expect(args.orderBy).toEqual([{ order: { createdAt: 'desc' } }, { createdAt: 'desc' }, { id: 'desc' }])
    expect(r.pagination).toEqual({ page: 2, pageSize: PAGINA_MAXIMA, total: 3, totalPages: 1 })
  })

  it('filtro por motivo exacto y por «Sin motivo»; el agrupado NO se filtra (siempre todo el periodo)', async () => {
    await listarDescuentosAplicados('venue-1', { reason: 'Queja del cliente' })
    expect(db.orderDiscount.findMany.mock.calls[0][0].where.reason).toBe('Queja del cliente')
    expect(db.orderDiscount.groupBy.mock.calls[0][0].where.reason).toBeUndefined()
    await listarDescuentosAplicados('venue-1', { reason: SIN_MOTIVO })
    expect(db.orderDiscount.findMany.mock.calls[1][0].where.reason).toBeNull()
    expect(db.orderDiscount.count.mock.calls[1][0].where.reason).toBeNull()
  })

  it('el agrupado tiene tope y avisa si se recortó', async () => {
    db.orderDiscount.groupBy.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({ reason: `m${i}`, _count: { _all: 1 }, _sum: { amount: new Decimal(1) } })),
    )
    const r = await listarDescuentosAplicados('venue-1')
    expect(r.porMotivo).toHaveLength(100)
    expect(r.motivosRecortados).toBe(true)
  })

  it('negocio que no existe: 404', async () => {
    db.venue.findUnique.mockResolvedValue(null)
    await expect(listarDescuentosAplicados('venue-x')).rejects.toThrow(/No encontramos/)
  })
})
