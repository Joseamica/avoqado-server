/**
 * 🔴 D23 (`hz:e5ee98bc:D23`): la venta del cajón que escribe el SERVIDOR viaja con la llave del cobro que la originó.
 *
 * El servidor anota la venta en efectivo con `localId = srv-cash-sale:<paymentId>` (`shared/cashDrawerPosting.ts`); la copia que el
 * POS escribe al cobrar es `idDeLaVentaEnEfectivo(K)`, donde K es la llave con la que el aparato mandó ese cobro y que el servidor
 * guarda en `Payment.idempotencyKey`. Sin la llave en la respuesta, el POS adivinaba qué venta del servidor era su copia, por orden y
 * luego por importe: una copia escrita tarde contaba dos veces (F1) y la venta de OTRO aparato del mismo importe se llevaba la copia
 * de un cobro que seguía en la cola (F2). Con `paymentIdempotencyKey` el POS la reconoce por identidad.
 *
 * Campo nuevo y OPCIONAL: `null` cuando el pago no tiene llave, en todo lo que no es una venta del servidor, y si la lectura de pagos
 * falla (la caja contesta igual; el POS cae al emparejamiento de siempre). Ningún campo existente cambia.
 */

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/shared/turnoDeCaja', () => ({
  abrirTurnoDeCaja: jest.fn().mockResolvedValue({ cashDrawerSessionId: 'session-1', shiftId: null, cajaCreada: true, shiftCreado: false }),
  cerrarTurnoDeCaja: jest.fn().mockResolvedValue({ shiftCerradoId: null }),
  turnoAbiertoDelNegocio: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/shared/parejaDeCierre', () => ({ asegurarLaLiga: jest.fn().mockResolvedValue(false) }))

import { closeSession, getCurrentSession, getHistory, openSession } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

const row = (over: Partial<Record<string, any>> & { id: string; type: string; amount: number }) => ({
  sessionId: 'session-1',
  note: null,
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: null,
  localId: null,
  createdAt: new Date('2026-11-12T10:00:00.000Z'),
  ...over,
})

const sesion = (over: Partial<Record<string, any>> = {}) => ({
  id: 'session-1',
  venueId: VENUE,
  deviceName: 'D3',
  status: 'OPEN',
  shiftId: null,
  openedByStaffId: 'staff-1',
  openedByName: 'Cajero',
  openedAt: new Date('2026-11-12T08:00:00.000Z'),
  startingAmount: 1000,
  closedByStaffId: null,
  closedByName: null,
  closedAt: null,
  actualAmount: null,
  overShort: null,
  closingNote: null,
  events: [
    row({ id: 'srv-ev-open', type: 'OPEN', amount: 1000 }),
    // La que cobró ESTE aparato (llave K-d3) y la de otro aparato del mismo importe (llave K-n86).
    row({ id: 'srv-ev-d3', type: 'CASH_SALE', amount: 300, localId: 'srv-cash-sale:pay-d3' }),
    row({ id: 'srv-ev-n86', type: 'CASH_SALE', amount: 300, localId: 'srv-cash-sale:pay-n86' }),
    // Un cobro del dashboard sin llave.
    row({ id: 'srv-ev-dash', type: 'CASH_SALE', amount: 50, localId: 'srv-cash-sale:pay-dash' }),
    // Codex r2: un pago que ya no está en esta sucursal (el job de «SIM de Evento» de PlayTelecom mueve la orden y sus pagos).
    row({ id: 'srv-ev-movido', type: 'CASH_SALE', amount: 0, localId: 'srv-cash-sale:pay-movido' }),
    // Movimiento del cliente: su localId es la llave del aparato, no un pago.
    row({ id: 'srv-ev-payin', type: 'PAY_IN', amount: 100, localId: 'local-ev-payin' }),
    ...(over.events ?? []),
  ],
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'events')),
})

const PAGOS = [
  { id: 'pay-d3', idempotencyKey: 'K-d3' },
  { id: 'pay-n86', idempotencyKey: 'K-n86' },
  { id: 'pay-dash', idempotencyKey: null },
]

const porId = (events: any[]) => Object.fromEntries(events.map(e => [e.id, e]))

function sembrarPagos(findMany: jest.Mock = jest.fn().mockResolvedValue(PAGOS)) {
  ;(prismaMock as any).payment = { ...(prismaMock as any).payment, findMany }
  return findMany
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
})

describe('D23 · la venta del servidor trae la llave del cobro', () => {
  it('🔴 /current: cada venta que escribió el servidor sale con la llave de SU pago', async () => {
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(sesion()) }
    sembrarPagos()

    const s = await getCurrentSession(VENUE, true)
    const ev = porId(s!.events as any[])

    expect(ev['srv-ev-d3'].paymentIdempotencyKey).toBe('K-d3')
    expect(ev['srv-ev-n86'].paymentIdempotencyKey).toBe('K-n86')
  })

  it('el pago leído sin llave sale con null; lo que no es una venta leída sale SIN el campo («no lo sé»)', async () => {
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(sesion()) }
    sembrarPagos()

    const ev = porId((await getCurrentSession(VENUE, true))!.events as any[])

    expect(ev['srv-ev-dash']).toHaveProperty('paymentIdempotencyKey', null)
    // 🔴 Codex r2: el pago movido a otra sucursal NO se encontró. Un null le diría al POS «no es de ninguna copia tuya» y su copia
    // contaría dos veces; sin el campo, el POS adivina como antes.
    for (const id of ['srv-ev-movido', 'srv-ev-open', 'srv-ev-payin']) expect(ev[id]).not.toHaveProperty('paymentIdempotencyKey')
    // Ningún campo de antes cambia.
    expect(ev['srv-ev-d3']).toMatchObject({ id: 'srv-ev-d3', type: 'CASH_SALE', amount: 300, localId: 'srv-cash-sale:pay-d3' })
  })

  it('una sola lectura de pagos, acotada a la sucursal y con tope', async () => {
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(sesion()) }
    const findMany = sembrarPagos()

    await getCurrentSession(VENUE, true)

    expect(findMany).toHaveBeenCalledTimes(1)
    const args = findMany.mock.calls[0][0]
    expect(args.where.venueId).toBe(VENUE)
    expect([...args.where.id.in].sort()).toEqual(['pay-d3', 'pay-dash', 'pay-movido', 'pay-n86'])
    expect(args.take).toBe(4)
  })

  it('sin ventas del servidor no se lee ningún pago', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      findFirst: jest.fn().mockResolvedValue({ ...sesion(), events: [row({ id: 'srv-ev-open', type: 'OPEN', amount: 1000 })] }),
    }
    const findMany = sembrarPagos()

    await getCurrentSession(VENUE, true)

    expect(findMany).not.toHaveBeenCalled()
  })

  it('🔴 si la lectura de pagos falla, la caja contesta igual y SIN el campo («no lo sé»), nunca con un null inventado', async () => {
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(sesion()) }
    sembrarPagos(jest.fn().mockRejectedValue(new Error('se cayó la base')))

    const s = await getCurrentSession(VENUE, true)

    // `null` le diría al POS «esta venta no es de ninguna copia tuya»; sin el campo, el POS adivina como antes.
    for (const ev of s!.events as any[]) expect(ev).not.toHaveProperty('paymentIdempotencyKey')
    expect(s!.expectedAmount).toBe(1750)
  })

  it('/open también la trae', async () => {
    ;(prismaMock as any).cashDrawerSession = { findUnique: jest.fn().mockResolvedValue(sesion()) }
    sembrarPagos()

    const s = await openSession({ venueId: VENUE, staffId: 'staff-1', staffName: 'Cajero', startingAmount: 1000 }, true)

    expect(porId(s.events as any[])['srv-ev-d3'].paymentIdempotencyKey).toBe('K-d3')
  })

  it('/close también la trae', async () => {
    const cerrada = sesion({ status: 'CLOSED', actualAmount: 1750, overShort: 0, closedAt: new Date('2026-11-12T20:00:00.000Z') })
    ;(prismaMock as any).cashDrawerSession = {
      findFirst: jest.fn().mockResolvedValue(sesion()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(cerrada),
    }
    ;(prismaMock as any).cashDrawerEvent = {
      findMany: jest.fn().mockResolvedValue(sesion().events),
      create: jest.fn().mockResolvedValue({}),
    }
    sembrarPagos()

    const s = await closeSession({ venueId: VENUE, staffId: 'staff-1', staffName: 'Cajero', actualAmount: 1750 })

    expect(porId(s.events as any[])['srv-ev-n86'].paymentIdempotencyKey).toBe('K-n86')
  })

  it('el historial la trae con UNA lectura para toda la página', async () => {
    const otra = sesion({
      id: 'session-0',
      status: 'CLOSED',
      events: [],
    })
    otra.events = [row({ id: 'srv-ev-ayer', type: 'CASH_SALE', amount: 80, sessionId: 'session-0', localId: 'srv-cash-sale:pay-ayer' })]
    ;(prismaMock as any).cashDrawerSession = {
      findMany: jest.fn().mockResolvedValue([sesion({ status: 'CLOSED' }), otra]),
      count: jest.fn().mockResolvedValue(2),
    }
    const findMany = sembrarPagos(jest.fn().mockResolvedValue([...PAGOS, { id: 'pay-ayer', idempotencyKey: 'K-ayer' }]))

    const h = await getHistory(VENUE, 1, 20)

    expect(findMany).toHaveBeenCalledTimes(1)
    const [hoy, ayer] = h.sessions
    expect(porId(hoy.events as any[])['srv-ev-d3'].paymentIdempotencyKey).toBe('K-d3')
    expect(porId(ayer.events as any[])['srv-ev-ayer'].paymentIdempotencyKey).toBe('K-ayer')
  })
})
