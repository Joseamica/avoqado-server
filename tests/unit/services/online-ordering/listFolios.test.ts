/**
 * Tienda híbrida T12: «Por pagar» y «Por entregar» (la lista de la caja). Forma de las consultas, paginación, `counts` exactos, el
 * orden de las sincronizaciones previas (R43) y el filtro de R16/R41/R42. El camino con dinero real va en la integración.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'

jest.mock('@/services/online-ordering/cancelledOrderSync', () => ({
  __esModule: true,
  ...jest.requireActual('@/services/online-ordering/cancelledOrderSync'),
  cerrarCanceladasReleyendo: jest.fn(async () => []),
}))
jest.mock('@/services/online-ordering/settings.service', () => ({ __esModule: true, getSettings: jest.fn() }))
jest.mock('@/services/online-ordering/notifications.service', () => ({
  __esModule: true,
  notifyOrderEvent: jest.fn(async () => undefined),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ __esModule: true, socketManager: { broadcastToVenue: jest.fn() } }))

import { cerrarCanceladasReleyendo } from '@/services/online-ordering/cancelledOrderSync'
import { getSettings } from '@/services/online-ordering/settings.service'
import { listFolios } from '@/services/online-ordering/folios.service'
import { INBOX_PAGE_SIZE } from '@/services/online-ordering/constants'

const NOW = new Date('2026-11-06T18:30:00.000Z')
const PAGADO_A = new Date('2026-11-06T17:45:00.000Z')
const row = (n: number, o: { paymentStatus?: string; remaining?: string; status?: string } = {}) => ({
  id: `oo${String(n).padStart(3, '0')}`,
  status: o.status ?? 'PENDING_ACCEPTANCE',
  paymentMode: 'PAY_AT_PICKUP',
  rejectReason: null,
  requiresAcceptance: false,
  channel: 'QR',
  acceptDeadlineAt: NOW,
  estimatedReadyAt: null,
  printClaimedAt: null,
  printedAt: null,
  createdAt: new Date(NOW.getTime() + n * 1000),
  charge: null,
  order: {
    id: `ord${n}`,
    orderNumber: `F-${n}`,
    total: new Prisma.Decimal('186.00'),
    remainingBalance: new Prisma.Decimal(o.remaining ?? '186.00'),
    paymentStatus: o.paymentStatus ?? 'PENDING',
    customerName: 'María',
    customerPhone: null,
    specialRequests: null,
    items: [],
    payments: o.paymentStatus === 'PAID' ? [{ createdAt: PAGADO_A }] : [],
  },
})

/** Las listas leen con `INBOX_SELECT` (trae `charge`); las sincronizaciones, no. */
const esLista = (a: any) => a.select?.charge !== undefined
let POR_PAGAR: any[] = []
let POR_ENTREGAR: any[] = []
let CONTEOS = { toPay: 0, toDeliver: 0 }

beforeEach(() => {
  POR_PAGAR = []
  POR_ENTREGAR = []
  CONTEOS = { toPay: 0, toDeliver: 0 }
  ;(getSettings as jest.Mock).mockResolvedValue({ enabled: true, requiresAcceptance: false })
  ;(cerrarCanceladasReleyendo as jest.Mock).mockResolvedValue([])
  prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => {
    if (!esLista(a)) return []
    return a.where.status === 'ACCEPTED' ? POR_ENTREGAR : POR_PAGAR
  }) as any)
  prismaMock.onlineOrder.count.mockImplementation((async (a: any) =>
    a.where.status === 'ACCEPTED' ? CONTEOS.toDeliver : CONTEOS.toPay) as any)
})

const listas = () => (prismaMock.onlineOrder.findMany.mock.calls as any[][]).map(c => c[0]).filter(esLista)

describe('listFolios', () => {
  it('sin section trae la primera página de las dos, del más viejo al más nuevo, con remaining y counts exactos', async () => {
    POR_PAGAR = [row(1), row(2, { paymentStatus: 'PARTIAL', remaining: '66.00' })]
    POR_ENTREGAR = [row(3, { status: 'ACCEPTED', paymentStatus: 'PAID', remaining: '0.00' })]
    CONTEOS = { toPay: 2, toDeliver: 1 }
    const r = await listFolios({ venueId: 'v1', now: NOW })
    expect(r).toMatchObject({
      serverTime: NOW.toISOString(),
      enabled: true,
      requiresAcceptance: false,
      showTile: true,
      pollSeconds: 30,
      counts: { toPay: 2, toDeliver: 1 },
      nextCursors: { toPay: null, toDeliver: null },
    })
    expect(r.toPay.map(o => [o.orderNumber, o.remaining])).toEqual([
      ['F-1', 186],
      ['F-2', 66],
    ])
    expect(r.toDeliver.map(o => o.orderNumber)).toEqual(['F-3'])
    for (const q of listas()) {
      expect(q.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
      expect(q.take).toBe(INBOX_PAGE_SIZE + 1)
    }
  })

  it('T18b: cada folio trae paidAt (hora del cobro que lo saldó, null si no está pagado) en la MISMA lectura, sin consultas por folio', async () => {
    POR_PAGAR = [row(1)]
    POR_ENTREGAR = [row(3, { status: 'ACCEPTED', paymentStatus: 'PAID', remaining: '0.00' })]
    const r = await listFolios({ venueId: 'v1', now: NOW })
    expect(r.toPay[0].paidAt).toBeNull()
    expect(r.toDeliver[0].paidAt).toBe(PAGADO_A.toISOString())
    const lista = listas()[0]
    expect(lista.select.order.select.payments).toMatchObject({ where: { status: 'COMPLETED' }, orderBy: { createdAt: 'desc' }, take: 1 })
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
  })

  it('un folio con abono (PARTIAL) sale en toPay con su remaining y cuenta en counts.toPay; uno cuya cuenta se canceló no sale', async () => {
    await listFolios({ venueId: 'v1', now: NOW })
    const pagar = listas().find(q => q.where.status === 'PENDING_ACCEPTANCE')
    expect(pagar.where).toEqual({
      venueId: 'v1',
      status: 'PENDING_ACCEPTANCE',
      requiresAcceptance: false,
      order: { status: { notIn: ['CANCELLED', 'DELETED'] }, paymentStatus: { notIn: ['PAID', 'REFUNDED'] } },
    })
    // PARTIAL no está excluido (R41) y el número cuenta con el MISMO filtro que la lista (R42)
    const cuenta = (prismaMock.onlineOrder.count.mock.calls as any[][]).map(c => c[0]).find(q => q.where.status === 'PENDING_ACCEPTANCE')
    expect(cuenta.where).toEqual(pagar.where)
  })

  it('con 101 por entregar, la primera página trae 100, counts.toDeliver = 101 y un nextCursors.toDeliver que lleva al 101 sin tocar toPay', async () => {
    POR_ENTREGAR = Array.from({ length: 101 }, (_, i) => row(i + 1, { status: 'ACCEPTED', paymentStatus: 'PAID' }))
    CONTEOS = { toPay: 0, toDeliver: 101 }
    const p1 = await listFolios({ venueId: 'v1', now: NOW })
    expect(p1.toDeliver).toHaveLength(100)
    expect(p1.counts.toDeliver).toBe(101)
    expect(p1.nextCursors.toDeliver).toBe(`${POR_ENTREGAR[99].createdAt.toISOString()}_oo100`)
    expect(p1.nextCursors.toPay).toBeNull()

    prismaMock.onlineOrder.findMany.mockClear()
    POR_ENTREGAR = [row(101, { status: 'ACCEPTED', paymentStatus: 'PAID' })]
    const p2 = await listFolios({ venueId: 'v1', section: 'toDeliver', cursor: p1.nextCursors.toDeliver!, now: NOW })
    expect(p2.toDeliver.map(o => o.orderNumber)).toEqual(['F-101'])
    expect(p2.toPay).toEqual([])
    expect(p2.nextCursors).toEqual({ toPay: null, toDeliver: null })
    expect(p2.counts.toDeliver).toBe(101)
    const q = listas()
    expect(q).toHaveLength(1) // toPay no se lee
    const d = new Date(POR_ENTREGAR[0].createdAt.getTime() - 1000)
    expect(q[0].where.OR).toEqual([{ createdAt: { gt: d } }, { createdAt: d, id: { gt: 'oo100' } }])
  })

  it('un cursor mal formado da 400', async () => {
    await expect(listFolios({ venueId: 'v1', section: 'toPay', cursor: 'basura', now: NOW })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('m4: un cursor sin section da 400 en el servicio, no se ignora', async () => {
    await expect(listFolios({ venueId: 'v1', cursor: `${NOW.toISOString()}_oo001`, now: NOW })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('con la tienda apagada y sin folios vivos: showTile false y pollSeconds 600', async () => {
    ;(getSettings as jest.Mock).mockResolvedValue({ enabled: false, requiresAcceptance: false })
    const r = await listFolios({ venueId: 'v1', now: NOW })
    expect(r).toMatchObject({ showTile: false, pollSeconds: 600 })
  })

  it('cambiar a «Mi equipo» con folios vivos: showTile sigue true mientras haya', async () => {
    ;(getSettings as jest.Mock).mockResolvedValue({ enabled: true, requiresAcceptance: true })
    CONTEOS = { toPay: 1, toDeliver: 0 }
    expect(await listFolios({ venueId: 'v1', now: NOW })).toMatchObject({ showTile: true, pollSeconds: 30, requiresAcceptance: true })
    CONTEOS = { toPay: 0, toDeliver: 0 }
    expect(await listFolios({ venueId: 'v1', now: NOW })).toMatchObject({ showTile: false, pollSeconds: 600 })
  })

  it('R43: antes de leer corre cerrarCanceladasReleyendo y las sincronizaciones de pagados; si una falla, avisa y sigue', async () => {
    ;(cerrarCanceladasReleyendo as jest.Mock).mockRejectedValue(new Error('boom'))
    const warn = jest.spyOn(logger, 'warn').mockImplementation((() => logger) as any)
    POR_PAGAR = [row(1)]
    CONTEOS = { toPay: 1, toDeliver: 0 }
    const r = await listFolios({ venueId: 'v1', now: NOW })
    expect(r.toPay).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('antes de la lista de folios'), expect.objectContaining({ venueId: 'v1' }))
    const calls = (prismaMock.onlineOrder.findMany.mock.calls as any[][]).map(c => c[0])
    const primeraLista = calls.findIndex(esLista)
    const sincPagados = calls.findIndex(a => !esLista(a) && a.where.status === 'PENDING_ACCEPTANCE')
    const sincCerrados = calls.findIndex(a => !esLista(a) && a.where.status?.in)
    expect(sincPagados).toBeGreaterThanOrEqual(0)
    expect(sincPagados).toBeLessThan(sincCerrados)
    expect(sincCerrados).toBeLessThan(primeraLista)
    warn.mockRestore()
  })

  it('R52: sin `now` (las rutas), lo que las sincronizaciones escriben bajo el candado lleva la hora de la escritura, no la de la petición', async () => {
    const PETICION = new Date('2026-11-06T09:59:50.000Z') // 03:59:50 en México
    const BAJO_CANDADO = new Date('2026-11-06T10:00:05.000Z') // 04:00:05: ya es el día nuevo del negocio
    jest.useFakeTimers({ now: PETICION, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] })
    try {
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
      ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) => {
        jest.setSystemTime(BAJO_CANDADO) // la espera del candado de la orden cruzó las 04:00
        return [{ id: orderId }]
      })
      prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
      const listasYConteos = prismaMock.onlineOrder.findMany.getMockImplementation()!
      prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) =>
        !esLista(a) && a.where.status?.in
          ? [{ id: 'oo-A', orderId: 'ord-A', venueId: 'v1', status: 'EXPIRED', order: { orderNumber: 'F-A' } }] // un folio cerrado ya saldado
          : listasYConteos(a)) as any)

      const r = await listFolios({ venueId: 'v1' })

      expect((prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).data).toEqual({ status: 'ACCEPTED', acceptedAt: BAJO_CANDADO })
      expect(r.serverTime).toBe(BAJO_CANDADO.toISOString()) // la respuesta lleva la hora de después de sincronizar
      // R2 (simulada aquí) recibe el reloj, no la hora de la petición.
      const relojR2 = (cerrarCanceladasReleyendo as jest.Mock).mock.calls[0][1]
      expect(typeof relojR2).toBe('function')
      expect(relojR2()).toEqual(BAJO_CANDADO)
    } finally {
      jest.useRealTimers()
    }
  })
})
