import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/online-ordering/notifications.service', () => ({
  __esModule: true,
  notifyOrderEvent: jest.fn(async () => undefined),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn() },
}))

import { socketManager } from '@/communication/sockets/managers/socketManager'
import { notifyOrderEvent } from '@/services/online-ordering/notifications.service'
import { getInboxOrder, listInbox } from '@/services/online-ordering/inbox.service'

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
    items: [
      {
        productName: 'Flautas',
        productId: 'prod-flautas',
        product: { categoryId: 'cat-antojitos' },
        quantity: 2,
        notes: null,
        modifiers: [{ name: 'Salsa verde', quantity: 1 }],
      },
    ],
  },
  ...o,
})

/** Las dos sincronizaciones al leer (R2 y «pagado al recoger») filtran por su cuenta (`where.order`); las listas, no. */
const esSincronizacion = (a: any) => a.where.order !== undefined
let CANCELADAS: any[] = []
let PAGADAS: any[] = []
const sync = (id: string, o: Record<string, unknown> = {}) => ({
  id: `oo-${id}`,
  orderId: `ord-${id}`,
  venueId: 'v1',
  status: 'READY',
  order: { orderNumber: `W${id}`, status: 'CANCELLED' },
  ...o,
})

beforeEach(() => {
  CANCELADAS = []
  PAGADAS = []
  prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
  prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => {
    if (esSincronizacion(a)) return a.where.paymentMode ? PAGADAS : CANCELADAS
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
  it('todas las consultas llevan tope (+1, H10, en las listas; 100 en las sincronizaciones) y el venue', async () => {
    await listInbox({ venueId: 'v1', now: NOW })
    for (const call of prismaMock.onlineOrder.findMany.mock.calls) {
      const a = call[0] as any
      expect(a.where.venueId).toBe('v1')
      expect(esSincronizacion(a) ? [100] : [101, 51]).toContain(a.take)
    }
  })

  it('arma conteos exactos (también los cerrados del periodo, H10), ordena lo pendiente primero y marca needsPrint sólo lo aceptado sin imprimir', async () => {
    const r = await listInbox({ venueId: 'v1', now: NOW })
    // 1b: los activos también por etapa (aceptados 1 + listos 3 = 4), del mismo `groupBy` exacto.
    expect(r.counts).toEqual({ pending: 2, active: 4, done: 7, accepted: 1, ready: 3 })
    const cerrados = (prismaMock.onlineOrder.count.mock.calls[0][0] as any).where
    expect(cerrados).toMatchObject({ venueId: 'v1', createdAt: { gte: new Date(NOW.getTime() - 24 * 3_600_000) } })
    expect(r.orders.map(o => o.orderNumber)).toEqual(['WA', 'WB', 'WC'])
    const byNumber = Object.fromEntries(r.orders.map(o => [o.orderNumber, o]))
    expect(byNumber.WA.needsPrint).toBe(false)
    expect(byNumber.WB.needsPrint).toBe(true)
    expect(byNumber.WA).toMatchObject({ total: 186, remaining: 186, customerPhone: '+525543453965' })
    expect(byNumber.WA.items[0]).toMatchObject({ name: 'Flautas', quantity: 2, modifiers: [{ name: 'Salsa verde', quantity: 1 }] })
  })

  it('inbox items carry productId and categoryId', async () => {
    const r = await listInbox({ venueId: 'v1', now: NOW })
    const wa = r.orders.find(o => o.orderNumber === 'WA')!
    expect(wa.items[0]).toMatchObject({ productId: 'prod-flautas', categoryId: 'cat-antojitos' })
    const lista = prismaMock.onlineOrder.findMany.mock.calls.map(c => c[0] as any).find(a => a.select?.order?.select?.items)
    const sel = lista.select.order.select.items.select
    expect(sel).toMatchObject({ productId: true, product: { select: { categoryId: true } } })
  })

  it('inbox items: un renglón sin producto (borrado o libre) da productId y categoryId null', async () => {
    const z: any = row('Z', 'ACCEPTED')
    z.order.items = [{ productName: 'Libre', productId: null, product: null, quantity: 1, notes: null, modifiers: [] }]
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => (esSincronizacion(a) ? [] : [z])) as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.orders[0].items[0]).toMatchObject({ productId: null, categoryId: null })
  })

  it('1b: una etapa sin pedidos cuenta 0 (no desaparece del objeto)', async () => {
    prismaMock.onlineOrder.groupBy.mockResolvedValueOnce([{ status: 'READY', _count: { _all: 5 } }] as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.counts).toEqual({ pending: 0, active: 5, done: 7, accepted: 0, ready: 5 })
  })

  it('`orderId` es el id de la CUENTA (Order.id): la llave de las acciones y del reclamo de impresión; `onlineOrderId` es otro', async () => {
    const r = await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })
    expect(r.orders[0]).toMatchObject({ orderId: 'ord-A', onlineOrderId: 'oo-A' })
  })

  it('el filtro `pending` sólo consulta lo pendiente', async () => {
    await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })
    const listas = prismaMock.onlineOrder.findMany.mock.calls.filter((c: any[]) => !esSincronizacion(c[0]))
    expect(listas).toHaveLength(1)
  })

  it('antes de leer cierra los pedidos de cuentas canceladas por otra vía en este negocio (R2)', async () => {
    CANCELADAS = [sync('X')]
    await listInbox({ venueId: 'v1', now: NOW })
    const lectura = prismaMock.onlineOrder.findMany.mock.calls[0][0] as any
    expect(lectura.where).toMatchObject({ venueId: 'v1', order: { status: { in: ['CANCELLED', 'DELETED'] } } })
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.where).toEqual({ id: 'oo-X', status: { in: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'READY'] } })
    expect(cas.data).toMatchObject({ status: 'CANCELLED_BY_STAFF' })
  })

  it('I-1: el pedido que la bandeja cerró por R2 se avisa UNA vez (comensal, bandeja y bitácora); la siguiente lectura ya no avisa', async () => {
    CANCELADAS = [sync('X')]
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 1 })
    await listInbox({ venueId: 'v1', now: NOW })
    expect(notifyOrderEvent).toHaveBeenCalledTimes(1)
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord-X', 'CANCELLED')
    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'v1',
      'order_updated',
      expect.objectContaining({ orderId: 'ord-X', onlineStatus: 'CANCELLED_BY_STAFF', status: 'CANCELLED' }),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CANCELLED_BY_STAFF', entityId: 'oo-X' }))

    // Ya cerrado: la siguiente bandeja lo vuelve a leer en el `findMany` simulado, pero su CAS da 0 y no avisa.
    await listInbox({ venueId: 'v1', now: NOW })
    expect(notifyOrderEvent).toHaveBeenCalledTimes(1)
  })

  it('opción 1 (founder, 17-oct): en la MISMA pasada y DESPUÉS de R2, entrega solo lo pagado al recoger de este negocio y lo anuncia', async () => {
    PAGADAS = [sync('P', { order: { orderNumber: 'WP' } })]
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 1 })
    await listInbox({ venueId: 'v1', now: NOW })

    // En orden: primero R2, luego pagado al recoger, y sólo después las listas.
    const lecturas = prismaMock.onlineOrder.findMany.mock.calls.map((c: any[]) => c[0])
    expect(esSincronizacion(lecturas[0]) && lecturas[0].where.paymentMode === undefined).toBe(true)
    expect(lecturas[1].where).toMatchObject({ venueId: 'v1', paymentMode: 'PAY_AT_PICKUP' })
    expect(lecturas.slice(2).some(esSincronizacion)).toBe(false)
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenCalledWith({
      // A3: el CAS repite el filtro de la cuenta (pagada, viva y sin reembolsos).
      where: {
        id: 'oo-P',
        status: 'READY',
        order: { paymentStatus: 'PAID', status: { notIn: ['CANCELLED', 'DELETED'] }, payments: { none: { type: 'REFUND' } } },
      },
      data: { status: 'COMPLETED', completedAt: NOW },
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ONLINE_ORDER_COLLECTED',
        entityId: 'oo-P',
        staffId: null,
        data: { orderNumber: 'WP', automatic: true },
      }),
    )
    expect(notifyOrderEvent).not.toHaveBeenCalled() // el comensal ya está en el mostrador
  })

  it('I-2: lo activo sale lo MÁS NUEVO primero, así un tope nunca esconde lo recién aceptado o listo', async () => {
    await listInbox({ venueId: 'v1', filter: 'active', now: NOW })
    const activos = prismaMock.onlineOrder.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => !esSincronizacion(a))
    expect(activos.where.status).toEqual({ in: ['ACCEPTED', 'READY'] })
    expect(activos.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('si una sincronización falla, la bandeja igual se lista', async () => {
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => {
      if (esSincronizacion(a)) throw new Error('db')
      return []
    }) as any)
    await expect(listInbox({ venueId: 'v1', now: NOW })).resolves.toMatchObject({ orders: [] })
    expect(logger.warn).toHaveBeenCalledTimes(2)
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

  it('A8: los activos se paginan por llave estable: nextCursor si hay más, y con cursor siguen DESPUÉS del último (createdAt desc, id desc)', async () => {
    const at = new Date('2026-10-14T17:00:00.000Z')
    const activos = Array.from({ length: 101 }, (_, i) => row(`B${String(i).padStart(3, '0')}`, 'ACCEPTED', { createdAt: at }))
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => (esSincronizacion(a) ? [] : activos)) as any)

    const r = await listInbox({ venueId: 'v1', filter: 'active', now: NOW })
    expect(r.orders).toHaveLength(100)
    expect(r.truncated).toBe(true)
    expect(r.nextCursor).toBe(`${at.toISOString()}_oo-B099`)

    prismaMock.onlineOrder.findMany.mockClear()
    await listInbox({ venueId: 'v1', filter: 'active', activeCursor: r.nextCursor!, now: NOW })
    const lista = prismaMock.onlineOrder.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => !esSincronizacion(a))
    expect(lista.where).toEqual({
      venueId: 'v1',
      status: { in: ['ACCEPTED', 'READY'] },
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 'oo-B099' } }],
    })
    expect(lista.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(lista.take).toBe(101)
  })

  it('A8: sin cursor la bandeja responde igual que antes, con nextCursor null si no recorta', async () => {
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.nextCursor).toBeNull()
    const activos = prismaMock.onlineOrder.findMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => !esSincronizacion(a) && a.where.status.in.includes('ACCEPTED'))
    expect(activos.where).toEqual({ venueId: 'v1', status: { in: ['ACCEPTED', 'READY'] } })
  })

  it('A8: un pedido se busca DIRECTO por { venueId, orderId } (no dentro de una página), con la forma de la bandeja', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValueOnce(row('Z', 'READY') as any)
    const o = await getInboxOrder({ venueId: 'v1', orderId: 'ord-Z', now: NOW })
    expect((prismaMock.onlineOrder.findFirst.mock.calls[0][0] as any).where).toEqual({ venueId: 'v1', orderId: 'ord-Z' })
    expect(o).toMatchObject({ orderId: 'ord-Z', onlineOrderId: 'oo-Z', status: 'READY', orderNumber: 'WZ', total: 186 })
    prismaMock.onlineOrder.findFirst.mockResolvedValueOnce(null)
    await expect(getInboxOrder({ venueId: 'v1', orderId: 'de-otro-negocio', now: NOW })).resolves.toBeNull()
    expect(prismaMock.onlineOrder.findMany).not.toHaveBeenCalled() // ni bandeja ni sincronizaciones
  })
})
