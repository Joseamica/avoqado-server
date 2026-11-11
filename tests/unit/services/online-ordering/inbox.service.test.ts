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
// Tienda híbrida T9: sus filtros, su candado y su CAS se prueban en `folios.service.test.ts`; aquí sólo cuándo corren.
jest.mock('@/services/online-ordering/folios.service', () => ({
  __esModule: true,
  syncPaidFolios: jest.fn(async () => 0),
  syncPaidClosedFolios: jest.fn(async () => 0),
}))

import { socketManager } from '@/communication/sockets/managers/socketManager'
import { notifyOrderEvent } from '@/services/online-ordering/notifications.service'
import { syncPaidClosedFolios, syncPaidFolios } from '@/services/online-ordering/folios.service'
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
        unitPrice: new Prisma.Decimal('80.00'),
        total: new Prisma.Decimal('186.00'),
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
  // R12: la bandeja cierra cada cancelada en su transacción, bajo el candado de la orden (devuelve la orden que se pidió).
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) => [{ id: orderId }])
  prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
  prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => {
    if (esSincronizacion(a)) return a.where.paymentMode ? PAGADAS : CANCELADAS
    const st = a.where.status.in as string[]
    if (st.includes('PENDING_ACCEPTANCE')) return [row('A', 'PENDING_ACCEPTANCE')]
    if (st.includes('ACCEPTED')) return [row('B', 'ACCEPTED')]
    return [row('C', 'COMPLETED')]
  }) as any)
  prismaMock.onlineOrder.groupBy.mockResolvedValue([
    { status: 'PENDING_ACCEPTANCE', requiresAcceptance: true, _count: { _all: 2 } },
    { status: 'ACCEPTED', requiresAcceptance: true, _count: { _all: 1 } },
    { status: 'READY', requiresAcceptance: true, _count: { _all: 3 } },
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
    expect(r.counts).toEqual({ pending: 2, active: 4, done: 7, accepted: 1, ready: 3, acceptedTeam: 1 })
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
    const lista = prismaMock.onlineOrder.findMany.mock.calls
      .map((c: unknown[]) => c[0] as any)
      .find((a: any) => a.select?.order?.select?.items)
    const sel = lista.select.order.select.items.select
    expect(sel).toMatchObject({ productId: true, product: { select: { categoryId: true } } })
  })

  it('T18c: cada renglón trae unitPrice (base) y total (con extras) en pesos, leídos en el mismo select', async () => {
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => (esSincronizacion(a) ? [] : [row('P', 'ACCEPTED')])) as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.orders[0].items[0]).toMatchObject({ unitPrice: 80, total: 186 })
    const lista = (prismaMock.onlineOrder.findMany.mock.calls as any[][]).map(c => c[0]).find(q => !esSincronizacion(q))
    expect(lista.select.order.select.items.select).toMatchObject({ unitPrice: true, total: true })
    expect(lista.select.order.select.items.take).toBeGreaterThan(0)
  })

  it('inbox items: un renglón sin producto (borrado o libre) da productId y categoryId null', async () => {
    const z: any = row('Z', 'ACCEPTED')
    z.order.items = [
      {
        productName: 'Libre',
        productId: null,
        product: null,
        quantity: 1,
        notes: null,
        unitPrice: new Prisma.Decimal('5'),
        total: new Prisma.Decimal('5'),
        modifiers: [],
      },
    ]
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => (esSincronizacion(a) ? [] : [z])) as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.orders[0].items[0]).toMatchObject({ productId: null, categoryId: null })
  })

  it('1b: una etapa sin pedidos cuenta 0 (no desaparece del objeto)', async () => {
    prismaMock.onlineOrder.groupBy.mockResolvedValueOnce([{ status: 'READY', requiresAcceptance: true, _count: { _all: 5 } }] as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.counts).toEqual({ pending: 0, active: 5, done: 7, accepted: 0, ready: 5, acceptedTeam: 0 })
  })

  it('tienda híbrida: un folio por pagar no sale en pending ni en counts.pending', async () => {
    prismaMock.onlineOrder.groupBy.mockResolvedValueOnce([
      { status: 'PENDING_ACCEPTANCE', requiresAcceptance: true, _count: { _all: 2 } },
      { status: 'PENDING_ACCEPTANCE', requiresAcceptance: false, _count: { _all: 9 } },
    ] as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.counts.pending).toBe(2)
    const gb = (prismaMock.onlineOrder.groupBy.mock.calls.at(-1)![0] as any).by
    expect(gb).toEqual(['status', 'requiresAcceptance'])
    const lista = prismaMock.onlineOrder.findMany.mock.calls
      .map((c: unknown[]) => c[0] as any)
      .find((a: any) => !esSincronizacion(a) && (a.where.status.in as string[]).includes('PENDING_ACCEPTANCE'))
    expect(lista.where).toMatchObject({ venueId: 'v1', requiresAcceptance: true })
  })

  it('tienda híbrida: counts.acceptedTeam no cuenta folios y counts.accepted sí', async () => {
    prismaMock.onlineOrder.groupBy.mockResolvedValueOnce([
      { status: 'ACCEPTED', requiresAcceptance: true, _count: { _all: 1 } },
      { status: 'ACCEPTED', requiresAcceptance: false, _count: { _all: 4 } },
    ] as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.counts).toMatchObject({ accepted: 5, acceptedTeam: 1 })
  })

  it('tienda híbrida: active y counts.active siguen trayendo folios pagados (apps viejas)', async () => {
    prismaMock.onlineOrder.groupBy.mockResolvedValueOnce([
      { status: 'ACCEPTED', requiresAcceptance: false, _count: { _all: 2 } },
      { status: 'READY', requiresAcceptance: false, _count: { _all: 3 } },
    ] as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.counts.active).toBe(5)
    const lista = prismaMock.onlineOrder.findMany.mock.calls
      .map((c: unknown[]) => c[0] as any)
      .find((a: any) => !esSincronizacion(a) && (a.where.status.in as string[]).includes('ACCEPTED'))
    expect(lista.where.requiresAcceptance).toBeUndefined()
  })

  it('tienda híbrida: InboxOrder trae requiresAcceptance y channel (campos nuevos)', async () => {
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) =>
      esSincronizacion(a) ? [] : [row('F', 'PENDING_ACCEPTANCE', { requiresAcceptance: false, channel: 'QR' })]) as any)
    const r = await listInbox({ venueId: 'v1', now: NOW })
    expect(r.orders[0]).toMatchObject({ requiresAcceptance: false, channel: 'QR' })
    const lista = prismaMock.onlineOrder.findMany.mock.calls
      .map((c: unknown[]) => c[0] as any)
      .find((a: any) => a.select?.order?.select?.items)
    expect(lista.select).toMatchObject({ requiresAcceptance: true, channel: true })
  })

  it('tienda híbrida: getInboxOrder sí devuelve un folio por pagar, con requiresAcceptance false', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValueOnce(
      row('F', 'PENDING_ACCEPTANCE', { requiresAcceptance: false, channel: null }) as any,
    )
    const o = await getInboxOrder({ venueId: 'v1', orderId: 'ord-F', now: NOW })
    expect(o).toMatchObject({ status: 'PENDING_ACCEPTANCE', requiresAcceptance: false, channel: null })
    expect((prismaMock.onlineOrder.findFirst.mock.calls[0][0] as any).where).toEqual({ venueId: 'v1', orderId: 'ord-F' })
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
    // R12: el CAS vuelve a exigir la cuenta cancelada, ya bajo el candado (el dinero tardío pudo reabrirla).
    expect(cas.where).toEqual({
      id: 'oo-X',
      status: { in: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'READY'] },
      order: { status: { in: ['CANCELLED', 'DELETED'] } },
    })
    expect(cas.data).toMatchObject({ status: 'CANCELLED_BY_STAFF' })
    expect(prismaMock.$transaction).toHaveBeenCalled()
  })

  it('tienda híbrida (decisión 18): después de R2 y de lo pagado al recoger, pasa los folios pagados a «Por entregar» y revive los cerrados ya saldados, antes de las listas', async () => {
    await listInbox({ venueId: 'v1', now: NOW })
    // R52: reciben el reloj (con `now` fijo, el de la prueba), no una hora.
    expect(syncPaidFolios).toHaveBeenCalledWith({ venueId: 'v1' }, expect.any(Function))
    expect(syncPaidClosedFolios).toHaveBeenCalledWith({ venueId: 'v1' }, expect.any(Function))
    expect((syncPaidFolios as jest.Mock).mock.calls[0][1]()).toEqual(NOW)
    const lecturas = prismaMock.onlineOrder.findMany.mock
    const pagadoAlRecoger = lecturas.calls.findIndex((c: any[]) => c[0].where.paymentMode)
    const primeraLista = lecturas.calls.findIndex((c: any[]) => !esSincronizacion(c[0]))
    expect(lecturas.invocationCallOrder[pagadoAlRecoger]).toBeLessThan((syncPaidFolios as jest.Mock).mock.invocationCallOrder[0])
    expect((syncPaidFolios as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (syncPaidClosedFolios as jest.Mock).mock.invocationCallOrder[0],
    )
    expect((syncPaidClosedFolios as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(lecturas.invocationCallOrder[primeraLista])
  })

  it('R52: sin `now` (la ruta), R2 escribe `cancelledAt` con la hora de DESPUÉS del candado y las sincronizaciones de folios reciben el reloj', async () => {
    const PETICION = new Date('2026-11-06T09:59:50.000Z')
    const BAJO_CANDADO = new Date('2026-11-06T10:00:05.000Z')
    const LUEGO = new Date('2026-11-06T10:00:09.000Z')
    jest.useFakeTimers({ now: PETICION, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] })
    try {
      ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) => {
        jest.setSystemTime(BAJO_CANDADO)
        return [{ id: orderId }]
      })
      CANCELADAS = [sync('X')]
      prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 1 })

      await listInbox({ venueId: 'v1' })

      expect((prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).data).toMatchObject({ cancelledAt: BAJO_CANDADO })
      for (const sincronizacion of [syncPaidFolios, syncPaidClosedFolios]) {
        const reloj = (sincronizacion as jest.Mock).mock.calls[0][1]
        jest.setSystemTime(LUEGO)
        expect(reloj()).toEqual(LUEGO) // un reloj que se lee al escribir, no una hora fija
      }
    } finally {
      jest.useRealTimers()
    }
  })

  it('si una sincronización de folios falla, la bandeja igual se lista y lo registra', async () => {
    ;(syncPaidFolios as jest.Mock).mockRejectedValueOnce(new Error('db'))
    ;(syncPaidClosedFolios as jest.Mock).mockRejectedValueOnce(new Error('db'))
    await expect(listInbox({ venueId: 'v1', now: NOW })).resolves.toMatchObject({ counts: expect.any(Object) })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Por entregar'), expect.objectContaining({ venueId: 'v1' }))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('saldados'), expect.objectContaining({ venueId: 'v1' }))
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
        // Tienda híbrida (decisión 18): nunca un folio.
        requiresAcceptance: true,
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

const cargo = (status: string, o: Record<string, unknown> = {}) => ({
  status,
  amount: new Prisma.Decimal('186.00'),
  capturedAmount: null,
  authorizedAt: new Date('2026-10-14T18:20:00.000Z'),
  capturedAt: null,
  ...o,
})

describe('fase 2: cardStatus en la bandeja', () => {
  const unaSola = (o: any) =>
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => (esSincronizacion(a) ? [] : [o])) as any)

  it('un cargo AUTHORIZED sale cardStatus AUTHORIZED y uno CAPTURING sale CONFIRMING', async () => {
    unaSola(row('A', 'PENDING_ACCEPTANCE', { paymentMode: 'CARD_ONLINE', charge: cargo('AUTHORIZED') }))
    expect((await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })).orders[0]).toMatchObject({
      paymentMode: 'CARD_ONLINE',
      cardStatus: 'AUTHORIZED',
    })
    unaSola(row('A', 'PENDING_ACCEPTANCE', { paymentMode: 'CARD_ONLINE', charge: cargo('CAPTURING') }))
    expect((await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })).orders[0].cardStatus).toBe('CONFIRMING')
  })

  it.each(['PENDING_AUTH', 'CAPTURED', 'CAPTURE_FAILED', 'RELEASING', 'RELEASED', 'ABANDONED'])(
    'un cargo %s sale cardStatus null',
    async status => {
      unaSola(row('A', 'ACCEPTED', { paymentMode: 'CARD_ONLINE', charge: cargo(status) }))
      expect((await listInbox({ venueId: 'v1', filter: 'active', now: NOW })).orders[0].cardStatus).toBeNull()
    },
  )

  it('el cargo viaja en el MISMO select de la bandeja (relación 1:1 acotada, sin consulta extra por renglón)', async () => {
    await listInbox({ venueId: 'v1', now: NOW })
    const lista = prismaMock.onlineOrder.findMany.mock.calls.map((c: unknown[]) => c[0] as any).find((a: any) => !esSincronizacion(a))
    expect(lista.select.charge).toEqual({
      select: { status: true, amount: true, capturedAmount: true, authorizedAt: true, capturedAt: true },
    })
  })

  it('un pedido al recoger no cambia: conserva TODAS sus llaves y sólo suma cardStatus y card: null', async () => {
    const LLAVES_ANTES = [
      'orderId',
      'onlineOrderId',
      'orderNumber',
      'status',
      'paymentMode',
      'customerName',
      'customerPhone',
      'note',
      'createdAt',
      'acceptDeadlineAt',
      'estimatedReadyAt',
      'total',
      'remaining',
      'paymentStatus',
      'needsPrint',
      'items',
    ]
    unaSola(row('A', 'PENDING_ACCEPTANCE')) // sin `charge`: paga al recoger
    const o = (await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })).orders[0]
    for (const k of LLAVES_ANTES) expect(o).toHaveProperty(k)
    expect(Object.keys(o).sort()).toEqual(
      // S14: `cliente`, `beneficios` y `beneficiosTotal` son aditivos (opcionales para las apps viejas).
      [
        ...LLAVES_ANTES,
        'cardStatus',
        'card',
        'rejectReason',
        'requiresAcceptance',
        'channel',
        'paidAt',
        'cliente',
        'beneficios',
        'beneficiosTotal',
      ].sort(),
    )
    expect(o.cardStatus).toBeNull()
    expect(o.rejectReason).toBeNull()
    expect(o.card).toBeNull()
    expect(o.paymentMode).toBe('PAY_AT_PICKUP')
  })

  it('apps (2-nov): la bandeja dice POR QUÉ se rechazó (PAYMENT_FAILED = «No se pudo cobrar la tarjeta»), en el mismo select', async () => {
    unaSola(row('A', 'REJECTED', { paymentMode: 'CARD_ONLINE', rejectReason: 'PAYMENT_FAILED', charge: cargo('CAPTURE_FAILED') }))
    expect((await listInbox({ venueId: 'v1', filter: 'done', now: NOW })).orders[0].rejectReason).toBe('PAYMENT_FAILED')
    const lista = prismaMock.onlineOrder.findMany.mock.calls.map((c: unknown[]) => c[0] as any).find((a: any) => !esSincronizacion(a))
    expect(lista.select.rejectReason).toBe(true)
  })

  it('getInboxOrder también lleva cardStatus', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(
      row('A', 'ACCEPTED', { paymentMode: 'CARD_ONLINE', charge: cargo('AUTHORIZED') }) as any,
    )
    expect((await getInboxOrder({ venueId: 'v1', orderId: 'ord-A', now: NOW }))?.cardStatus).toBe('AUTHORIZED')
  })

  it('MCP: el cobro sale en PESOS (number), no en centavos, con sus fechas ISO; lo no cobrado aún va null', async () => {
    unaSola(row('A', 'PENDING_ACCEPTANCE', { paymentMode: 'CARD_ONLINE', charge: cargo('AUTHORIZED') }))
    expect((await listInbox({ venueId: 'v1', filter: 'pending', now: NOW })).orders[0].card).toEqual({
      status: 'AUTHORIZED',
      amount: 186,
      capturedAmount: null,
      authorizedAt: '2026-10-14T18:20:00.000Z',
      capturedAt: null,
    })
  })

  it('un cargo ya cobrado sale con capturedAmount y capturedAt (lo cobrado puede ser menor que lo apartado)', async () => {
    unaSola(
      row('A', 'ACCEPTED', {
        paymentMode: 'CARD_ONLINE',
        charge: cargo('CAPTURED', { capturedAmount: new Prisma.Decimal('150.50'), capturedAt: new Date('2026-10-14T18:25:00.000Z') }),
      }),
    )
    const o = (await listInbox({ venueId: 'v1', filter: 'active', now: NOW })).orders[0]
    expect(o.cardStatus).toBeNull()
    expect(o.card).toMatchObject({ status: 'CAPTURED', amount: 186, capturedAmount: 150.5, capturedAt: '2026-10-14T18:25:00.000Z' })
  })

  it('getInboxOrder (el detalle) también lleva card', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(
      row('A', 'ACCEPTED', { paymentMode: 'CARD_ONLINE', charge: cargo('AUTHORIZED') }) as any,
    )
    expect((await getInboxOrder({ venueId: 'v1', orderId: 'ord-A', now: NOW }))?.card).toMatchObject({ status: 'AUTHORIZED', amount: 186 })
  })
})

describe('S14: la Bandeja dice de qué clienta es cada folio y qué beneficios trae (P2-3, R1, R2)', () => {
  // La ficha trae contacto A PROPÓSITO: aunque una lectura lo trajera, la respuesta nunca lo deja salir.
  const ANA = { id: 'cus-ana', firstName: 'Ana', lastName: 'López', phone: '+525511112222', email: 'ana@correo.test' }
  const fila = (name: string, amount: string) => ({ name, amount: new Prisma.Decimal(amount), isComp: false, compReason: null })
  const conCuenta = (id: string, status: string, cuenta: Record<string, unknown>) => {
    const r = row(id, status)
    return { ...r, order: { ...r.order, ...cuenta } }
  }
  const soloLista = (o: any) =>
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => (esSincronizacion(a) ? [] : [o])) as any)

  it('un folio con premio trae cliente y beneficios en la Bandeja (y en el detalle por id)', async () => {
    const folio = conCuenta('B', 'ACCEPTED', { customer: ANA, orderDiscounts: [fila('Premio', '45.00')], _count: { orderDiscounts: 1 } })
    soloLista(folio)
    const r = await listInbox({ venueId: 'v1', filter: 'active', now: NOW })
    expect(r.orders[0]).toMatchObject({ beneficios: [{ nombre: 'Premio', monto: 45 }], beneficiosTotal: 1 })
    // R2: nombre de pila e inicial del apellido; de la ficha, sólo eso y su id.
    expect(r.orders[0].cliente).toEqual({ id: 'cus-ana', nombre: 'Ana L.' })
    expect(r.orders[0].beneficios).toEqual([{ nombre: 'Premio', monto: 45 }])
    expect(JSON.stringify(r)).not.toMatch(/5511112222|ana@correo\.test|López/)
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio as any)
    await expect(getInboxOrder({ venueId: 'v1', orderId: 'ord-B', now: NOW })).resolves.toMatchObject({
      cliente: { id: 'cus-ana', nombre: 'Ana L.' },
      beneficios: [{ nombre: 'Premio', monto: 45 }],
    })
  })

  it('Codex r1 #1: la clienta ligada desde la TPV (primario, sin `customerId`) es la dueña; con las dos, gana el primario como en la lealtad', async () => {
    const BETO = { id: 'cus-beto', firstName: 'Beto', lastName: 'Ruiz', phone: '+525533334444', email: 'beto@correo.test' }
    soloLista(
      conCuenta('B', 'ACCEPTED', {
        customer: null,
        orderCustomers: [{ customer: ANA }],
        orderDiscounts: [],
        _count: { orderDiscounts: 0 },
      }),
    )
    expect((await listInbox({ venueId: 'v1', filter: 'active', now: NOW })).orders[0].cliente).toEqual({ id: 'cus-ana', nombre: 'Ana L.' })
    soloLista(
      conCuenta('B', 'ACCEPTED', {
        customer: BETO,
        orderCustomers: [{ customer: ANA }],
        orderDiscounts: [],
        _count: { orderDiscounts: 0 },
      }),
    )
    const r = await listInbox({ venueId: 'v1', filter: 'active', now: NOW })
    expect(r.orders[0].cliente).toEqual({ id: 'cus-ana', nombre: 'Ana L.' })
    expect(JSON.stringify(r)).not.toMatch(/5533334444|beto@correo\.test|5511112222|ana@correo\.test/)
    // Sin primario, la heredada (la de la sesión).
    soloLista(conCuenta('B', 'ACCEPTED', { customer: BETO, orderCustomers: [], orderDiscounts: [], _count: { orderDiscounts: 0 } }))
    expect((await listInbox({ venueId: 'v1', filter: 'active', now: NOW })).orders[0].cliente).toEqual({
      id: 'cus-beto',
      nombre: 'Beto R.',
    })
  })

  it('sin cliente ⇒ cliente null (y sin beneficios, la lista vacía con su total 0)', async () => {
    soloLista(conCuenta('A', 'ACCEPTED', { customer: null, orderDiscounts: [], _count: { orderDiscounts: 0 } }))
    const o = (await listInbox({ venueId: 'v1', filter: 'active', now: NOW })).orders[0]
    expect(o.cliente).toBeNull()
    expect(o).toMatchObject({ beneficios: [], beneficiosTotal: 0 })
  })

  it('R2: sin apellido sale sólo el nombre de pila; el nombre compuesto se respeta; sin nombre, «Sin nombre»', async () => {
    const nombres: Array<[Record<string, unknown>, string]> = [
      [{ id: 'c1', firstName: 'Ana', lastName: null }, 'Ana'],
      [{ id: 'c2', firstName: ' Ana Sofía ', lastName: ' ñúñez Paz' }, 'Ana Sofía Ñ.'],
      [{ id: 'c3', firstName: null, lastName: 'López' }, 'Sin nombre'],
      [{ id: 'c4', firstName: '  ', lastName: null }, 'Sin nombre'],
    ]
    for (const [customer, nombre] of nombres) {
      soloLista(conCuenta('A', 'ACCEPTED', { customer, orderDiscounts: [], _count: { orderDiscounts: 0 } }))
      expect((await listInbox({ venueId: 'v1', filter: 'active', now: NOW })).orders[0].cliente).toEqual({ id: customer.id, nombre })
    }
  })

  it('R1: con más de 10 beneficios publica 10 (en el orden en que se aplicaron) y dice cuántos son: nunca recorta en silencio', async () => {
    const diez = Array.from({ length: 10 }, (_, i) => fila(`Descuento ${i + 1}`, '1.00'))
    soloLista(conCuenta('A', 'ACCEPTED', { customer: ANA, orderDiscounts: diez, _count: { orderDiscounts: 13 } }))
    const o = (await listInbox({ venueId: 'v1', filter: 'active', now: NOW })).orders[0]
    expect(o.beneficios).toHaveLength(10)
    expect(o.beneficiosTotal).toBe(13)
  })

  it('R1/R2 en la consulta: tope de 10 con orden estable y su conteo en la MISMA lectura (sin N+1); de la ficha sólo id y nombre', async () => {
    await listInbox({ venueId: 'v1', now: NOW })
    const listas = (prismaMock.onlineOrder.findMany.mock.calls as any[][]).map(c => c[0]).filter(a => !esSincronizacion(a))
    expect(listas).toHaveLength(3)
    for (const a of listas) {
      const cuenta = a.select.order.select
      expect(cuenta.customer).toEqual({ select: { id: true, firstName: true, lastName: true } })
      // Codex r1 #1: el primario de las ligas (lo que escribe la TPV), en la misma lectura y con la misma ficha mínima.
      expect(cuenta.orderCustomers).toEqual({
        where: { isPrimary: true },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { customer: { select: { id: true, firstName: true, lastName: true } } },
      })
      expect(cuenta.orderDiscounts).toMatchObject({ take: 10, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      expect(cuenta.orderDiscounts.select).toMatchObject({ name: true, amount: true })
      expect(cuenta._count).toEqual({ select: { orderDiscounts: true } })
    }
    expect(prismaMock.orderDiscount.findMany).not.toHaveBeenCalled()
    expect(prismaMock.customer.findMany).not.toHaveBeenCalled()
  })
})
