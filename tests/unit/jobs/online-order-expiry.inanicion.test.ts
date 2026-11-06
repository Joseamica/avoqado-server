// tests/unit/jobs/online-order-expiry.inanicion.test.ts
/**
 * R50 (parada de la metodología): inanición de los barridos acotados del vencimiento. Codex r2 y r3 la reprodujeron con el trabajo
 * REAL, su vencimiento REAL y consultas simuladas; aquí igual. La base simulada contesta lo que cada lectura PIDE (si su SQL excluye
 * el cobro de terminal sin desenlace, no lo devuelve; si trae cursor, sigue después de él) y la guarda de cancelar
 * (`findLiveTerminalCharge`) rechaza el vencimiento de una cuenta con un cobro de terminal sin desenlace, como la real.
 *
 * Por cada barrido: «tantas filas bloqueadas como el tope de una pasada + 1 que sí procede ⇒ la que procede vence en la MISMA
 * pasada», la bloqueada nunca se vence, y una fila que el candado rechaza por una carrera no se relee en la misma pasada (cursor).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'

jest.mock('@/services/online-ordering/notifications.service', () => ({
  __esModule: true,
  notifyOrderEvent: jest.fn(async () => undefined),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/shared/orderCancelGuard', () => ({
  __esModule: true,
  findLiveTerminalCharge: jest.fn(),
  devolverCanjesDeVentaAnuladaEnTx: jest.fn(async () => undefined),
}))

import { findLiveTerminalCharge } from '@/services/shared/orderCancelGuard'
import { OnlineOrderAcceptanceExpiryJob } from '@/jobs/online-order-acceptance-expiry.job'

const NOW = new Date('2026-11-06T18:30:10.000Z')
const VIEJO = new Date('2026-11-06T10:00:00.000Z')
const POSTERIOR = new Date('2026-11-06T18:00:00.000Z')
const D = (v: number) => new Prisma.Decimal(v)

interface Fila {
  id: string
  orderId: string
  venueId: string
  acceptDeadlineAt: Date
  requiresAcceptance: boolean
  paymentStatus: 'PENDING' | 'PARTIAL'
  /** Σ (importe + propina) de los Payment COMPLETED; los reembolsos restan. */
  neto: number
  /** Un cobro de terminal sin desenlace acreditado sobre su cuenta (sin caducidad: Codex r3). */
  cobroIncierto?: true
  /** El SQL lo deja pasar, pero bajo el candado ya cambió (otro lo aceptó): una carrera pasajera. */
  carrera?: true
}

let db: Fila[] = []
const vencidos = () =>
  prismaMock.onlineOrder.updateMany.mock.calls.map(([a]: any[]) => db.find(f => f.id === a.where.id)?.orderId).filter(Boolean)

const despuesDe = (f: Fila, at: Date, id: string) =>
  f.acceptDeadlineAt.getTime() > at.getTime() || (f.acceptDeadlineAt.getTime() === at.getTime() && f.id > id)
const enOrden = (filas: Fila[]) =>
  [...filas].sort((a, b) => a.acceptDeadlineAt.getTime() - b.acceptDeadlineAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const comoCandidato = ({ id, orderId, venueId, acceptDeadlineAt }: Fila) => ({ id, orderId, venueId, acceptDeadlineAt })

beforeEach(() => {
  db = []
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (strings: any, ...values: any[]) => {
    const q = Prisma.sql(strings, ...values)
    // El candado de la orden (`lockExistingOrderForPayment`): devuelve la orden pedida.
    if (!q.sql.includes('"OnlineOrder" oo')) return [{ id: values[0] }]
    // Una lectura de candidatos a vencer: contesta lo que su SQL pide.
    let filas = db.filter(f => f.acceptDeadlineAt.getTime() <= NOW.getTime())
    if (q.sql.includes(`o."paymentStatus" = 'PENDING'`)) filas = filas.filter(f => f.paymentStatus === 'PENDING')
    else if (q.sql.includes(`o."paymentStatus" = 'PARTIAL'`))
      filas = filas.filter(f => !f.requiresAcceptance && f.paymentStatus === 'PARTIAL' && f.neto <= 0)
    else throw new Error(`consulta inesperada: ${q.sql}`)
    if (q.sql.includes('"TerminalPaymentRequest"')) filas = filas.filter(f => !f.cobroIncierto)
    if (q.sql.includes('oo.id) >')) {
      const [at, id] = q.values.slice(-3, -1) as [Date, string]
      filas = filas.filter(f => despuesDe(f, at, id))
    }
    return enOrden(filas)
      .slice(0, q.values[q.values.length - 1] as number)
      .map(comoCandidato)
  })
  // La forma de antes del barrido principal (Prisma): no puede excluir el cobro de terminal (no hay relación desde la cuenta).
  prismaMock.onlineOrder.findMany.mockImplementation(async ({ where, take }: any) => {
    if (where.status !== 'PENDING_ACCEPTANCE' || where.order?.paymentStatus !== 'PENDING') return []
    let filas = db.filter(f => f.acceptDeadlineAt.getTime() <= NOW.getTime() && f.paymentStatus === 'PENDING')
    if (where.OR) filas = filas.filter(f => despuesDe(f, where.OR[1].acceptDeadlineAt, where.OR[1].id.gt))
    return enOrden(filas).slice(0, take).map(comoCandidato)
  })
  // Bajo el candado: la relectura del pedido y de su cuenta.
  prismaMock.onlineOrder.findFirst.mockImplementation(async ({ where }: any) => {
    const f = db.find(x => x.orderId === where.orderId || x.id === where.id)
    if (!f) return null
    return {
      id: f.id,
      status: f.carrera ? 'ACCEPTED' : 'PENDING_ACCEPTANCE',
      paymentMode: 'PAY_AT_PICKUP',
      requiresAcceptance: f.requiresAcceptance,
      acceptDeadlineAt: f.acceptDeadlineAt,
      order: { orderNumber: `F-${f.id}`, status: 'PENDING', paymentStatus: f.paymentStatus, paidAmount: D(f.neto) },
    }
  })
  prismaMock.payment.groupBy.mockImplementation(async ({ where }: any) =>
    where.orderId.in.map((orderId: string) => ({
      orderId,
      _sum: { amount: D(db.find(f => f.orderId === orderId)?.neto ?? 0), tipAmount: D(0) },
    })),
  )
  ;(findLiveTerminalCharge as jest.Mock).mockImplementation(async (_tx: unknown, i: { orderId: string }) =>
    db.find(f => f.orderId === i.orderId)?.cobroIncierto ? { requestId: `req-${i.orderId}` } : null,
  )
  prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
})

/** El trabajo con su vencimiento y sus lecturas REALES; las sincronizaciones de antes del vencimiento no aportan aquí. */
const pasada = () =>
  new OnlineOrderAcceptanceExpiryJob({
    cron: { start: jest.fn(), stop: jest.fn() } as never,
    now: () => NOW,
    syncCancelled: jest.fn().mockResolvedValue(0),
    syncPaidPickups: jest.fn().mockResolvedValue(0),
    syncPaidFolios: jest.fn().mockResolvedValue(0),
    syncPaidClosedFolios: jest.fn().mockResolvedValue(0),
    cerrarFoliosDelDia: jest.fn().mockResolvedValue(0),
  }).checkNow()

const sinDinero = (i: number, extra: Partial<Fila> = {}): Fila => ({
  id: `oo-p${String(i).padStart(4, '0')}`,
  orderId: `pendiente${i}`,
  venueId: `v-${i % 7}`,
  acceptDeadlineAt: VIEJO,
  requiresAcceptance: false,
  paymentStatus: 'PENDING',
  neto: 0,
  ...extra,
})
const abonoDevuelto = (i: number, extra: Partial<Fila> = {}): Fila => ({
  id: `oo-d${String(i).padStart(4, '0')}`,
  orderId: `devuelto${i}`,
  venueId: `v-${i % 7}`,
  acceptDeadlineAt: VIEJO,
  requiresAcceptance: false,
  paymentStatus: 'PARTIAL',
  neto: 0,
  ...extra,
})

describe('R50 · el vencimiento principal (cuenta abierta sin dinero)', () => {
  it('1,000 vencidos con un cobro de terminal sin desenlace (el tope de una pasada: 10 × 100) + 1 sin cobro ⇒ el 1,001 vence en la MISMA pasada y los bloqueados nunca', async () => {
    db = [
      ...Array.from({ length: 1000 }, (_, i) => sinDinero(i, { cobroIncierto: true })),
      sinDinero(9999, { acceptDeadlineAt: POSTERIOR }),
    ]

    const r = await pasada()

    expect(vencidos()).toEqual(['pendiente9999'])
    expect(r).toMatchObject({ expired: 1, errors: 0 })
  })

  it('cursor DENTRO de la pasada: 100 que el candado ve ya cambiados (carrera) no se releen; el de detrás vence en la misma pasada y queda el aviso con el conteo', async () => {
    const warn = jest.spyOn(logger, 'warn')
    db = [...Array.from({ length: 100 }, (_, i) => sinDinero(i, { carrera: true })), sinDinero(9999, { acceptDeadlineAt: POSTERIOR })]

    const r = await pasada()

    expect(vencidos()).toEqual(['pendiente9999'])
    expect(r).toMatchObject({ scanned: 101, expired: 1, noop: 100, errors: 0 })
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pasada: 'findDue', leidos: 101, sinVencer: 100 }))
  })

  it('R49 (Codex r2) sigue: 1,000 folios con abono VIVO vencidos no tapan a un pedido posterior sin dinero; ningún abono vivo se intenta vencer', async () => {
    db = [
      ...Array.from({ length: 1000 }, (_, i) => abonoDevuelto(i, { neto: 50 })),
      sinDinero(9999, { acceptDeadlineAt: POSTERIOR, requiresAcceptance: true }),
    ]

    await pasada()

    expect(vencidos()).toEqual(['pendiente9999'])
    expect(findLiveTerminalCharge).toHaveBeenCalledTimes(1)
  })
})

describe('R50 · la pasada aparte de los folios con abono devuelto (neto 0)', () => {
  it('Codex r3: 1,000 con un cobro de terminal sin desenlace + 1 sin cobro ⇒ el 1,001 vence en la MISMA pasada y los bloqueados nunca', async () => {
    db = [
      ...Array.from({ length: 1000 }, (_, i) => abonoDevuelto(i, { cobroIncierto: true })),
      abonoDevuelto(9999, { acceptDeadlineAt: POSTERIOR }),
    ]

    const r = await pasada()

    expect(vencidos()).toEqual(['devuelto9999'])
    expect(r).toMatchObject({ expired: 1, errors: 0 })
  })

  it('cursor DENTRO de la pasada: 100 que el candado ve ya cambiados no se releen; el de detrás vence en la misma pasada y queda el aviso con el conteo', async () => {
    const warn = jest.spyOn(logger, 'warn')
    db = [
      ...Array.from({ length: 100 }, (_, i) => abonoDevuelto(i, { carrera: true })),
      abonoDevuelto(9999, { acceptDeadlineAt: POSTERIOR }),
    ]

    const r = await pasada()

    expect(vencidos()).toEqual(['devuelto9999'])
    expect(r).toMatchObject({ scanned: 101, expired: 1, noop: 100, errors: 0 })
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pasada: 'abonosDevueltos', leidos: 101, sinVencer: 100 }),
    )
  })
})
