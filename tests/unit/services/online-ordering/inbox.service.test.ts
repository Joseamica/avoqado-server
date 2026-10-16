import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { listInbox } from '@/services/online-ordering/inbox.service'

const NOW = new Date('2026-10-14T18:30:00.000Z')
const row = (id: string, status: string, o: Record<string, unknown> = {}) => ({
  id: `oo-${id}`,
  status,
  paymentMode: 'PAY_AT_PICKUP',
  acceptDeadlineAt: new Date(NOW.getTime() + 300_000),
  estimatedReadyAt: null,
  printClaimedAt: null,
  printedAt: null,
  createdAt: NOW,
  order: {
    id: `ord-${id}`,
    orderNumber: `W${id}`,
    total: new Prisma.Decimal('186.00'),
    remainingBalance: new Prisma.Decimal('186.00'),
    paymentStatus: 'PENDING',
    customerName: 'María G.',
    customerPhone: '+525543453965',
    specialRequests: null,
    items: [{ productName: 'Flautas', quantity: 2, notes: null, modifiers: [{ name: 'Salsa verde', quantity: 1 }] }],
  },
  ...o,
})

beforeEach(() => {
  prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
  prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => {
    const st = a.where.status.in as string[]
    if (st.includes('PENDING_ACCEPTANCE')) return [row('A', 'PENDING_ACCEPTANCE')]
    if (st.includes('ACCEPTED')) return [row('B', 'ACCEPTED')]
    return [row('C', 'COMPLETED')]
  }) as any)
  prismaMock.onlineOrder.groupBy.mockResolvedValue([
    { status: 'PENDING_ACCEPTANCE', _count: { _all: 2 } },
    { status: 'ACCEPTED', _count: { _all: 1 } },
    { status: 'READY', _count: { _all: 3 } },
  ] as any)
  prismaMock.onlineOrder.count.mockResolvedValue(7)
})

describe('listInbox', () => {
  it('todas las consultas llevan tope (+1, H10) y el venue', async () => {
    await listInbox({ venueId: 'v1', now: NOW })
    for (const call of prismaMock.onlineOrder.findMany.mock.calls) {
      const a = call[0] as any
      expect(a.where.venueId).toBe('v1')
      expect([101, 51]).toContain(a.take)
    }
  })

  it('arma conteos exactos (también los cerrados del periodo, H10), ordena lo pendiente primero y marca needsPrint sólo lo aceptado sin imprimir', async () => {
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.counts).toEqual({ pending: 2, active: 4, done: 7 })
    const cerrados = (prismaMock.onlineOrder.count.mock.calls[0][0] as any).where
    expect(cerrados).toMatchObject({ venueId: 'v1', createdAt: { gte: new Date(NOW.getTime() - 24 * 3_600_000) } })
    expect(r.orders.map(o => o.orderNumber)).toEqual(['WA', 'WB', 'WC'])
    const byNumber = Object.fromEntries(r.orders.map(o => [o.orderNumber, o]))
    expect(byNumber.WA.needsPrint).toBe(false)
    expect(byNumber.WB.needsPrint).toBe(true)
    expect(byNumber.WA).toMatchObject({ total: 186, remaining: 186, customerPhone: '+525543453965' })
    expect(byNumber.WA.items[0]).toMatchObject({ name: 'Flautas', quantity: 2, modifiers: [{ name: 'Salsa verde', quantity: 1 }] })
  })

  it('`orderId` es el id de la CUENTA (Order.id): la llave de las acciones y del reclamo de impresión; `onlineOrderId` es otro', async () => {
    const r = await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })
    expect(r.orders[0]).toMatchObject({ orderId: 'ord-A', onlineOrderId: 'oo-A' })
  })

  it('el filtro `pending` sólo consulta lo pendiente', async () => {
    await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })
    expect(prismaMock.onlineOrder.findMany).toHaveBeenCalledTimes(1)
  })

  it('antes de leer cierra los pedidos de cuentas canceladas por otra vía en este negocio (R2)', async () => {
    await listInbox({ venueId: 'v1', now: NOW })
    const sync = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(sync.where).toMatchObject({ venueId: 'v1', order: { status: { in: ['CANCELLED', 'DELETED'] } } })
    expect(sync.data).toMatchObject({ status: 'CANCELLED_BY_STAFF' })
  })

  it('si un tope recorta la bandeja lo dice (`truncated`, medido con tope + 1) y lo registra (R17, sin paginación en v1)', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue(Array.from({ length: 101 }, (_, i) => row(`P${i}`, 'PENDING_ACCEPTANCE')) as any)
    const r = await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })
    expect(r.truncated).toBe(true)
    expect(r.orders).toHaveLength(100)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('recort'), expect.objectContaining({ venueId: 'v1' }))
  })

  it('H10: exactamente el tope NO es recorte', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, i) => row(`P${i}`, 'PENDING_ACCEPTANCE')) as any)
    const r = await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })
    expect(r.truncated).toBe(false)
    expect(r.orders).toHaveLength(100)
  })
})
