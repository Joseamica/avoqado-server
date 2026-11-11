// tests/unit/services/online-ordering/folios.service.test.ts
/**
 * Tienda híbrida T9 (decisión 18): lo pagado pasa a «Por entregar» (`ACCEPTED`) en un solo lugar, `prepararFolioPagadoEnTx`, bajo el
 * candado de la orden; `syncPaidFolios` lo corre por cada folio pagado y `syncPaidClosedFolios` revive a «Por entregar» el folio
 * cerrado cuya cuenta otro cobro terminó de saldar. Aquí sólo la forma (filtros, candado, CAS y avisos); cada camino de dinero se
 * prueba contra Postgres en `tests/integration/online-ordering/folios.integration.test.ts` (R14).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  __esModule: true,
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ __esModule: true, debeMarcarCocina: jest.fn() }))
jest.mock('@/services/shared/orderCancelGuard', () => ({
  __esModule: true,
  findLiveTerminalCharge: jest.fn(async () => null),
  devolverCanjesDeVentaAnuladaEnTx: jest.fn(),
}))
jest.mock('@/services/online-ordering/notifications.service', () => ({
  __esModule: true,
  notifyOrderEvent: jest.fn(async () => undefined),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn(async () => ({ id: 'post1' })),
  applySalePosting: jest.fn(async () => undefined),
}))
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLedger'),
  activarSobresDeCuentaPagadaEnTx: jest.fn(async () => ({ activated: [] })),
}))
jest.mock('@/services/online-ordering/settings.service', () => ({ __esModule: true, getSettings: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn() },
}))

import { socketManager } from '@/communication/sockets/managers/socketManager'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { debeMarcarCocina } from '@/services/kds/kitchenDisplayStations'
import { notifyOrderEvent } from '@/services/online-ordering/notifications.service'
import { getSettings } from '@/services/online-ordering/settings.service'
import { createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'
import {
  cerrarFolioEnCeroEnTx,
  cerrarFoliosDelDiaTerminado,
  leerFoliosConAbonoDevuelto,
  leerPedidosVencidos,
  prepararFolioPagado,
  prepararFolioPagadoEnTx,
  syncPaidClosedFolios,
  syncPaidFolios,
} from '@/services/online-ordering/folios.service'

const D = (v: string) => new Prisma.Decimal(v)
const NOW = new Date('2026-11-06T18:30:00.000Z')
const SIETE_DIAS_ANTES = new Date(NOW.getTime() - 7 * 24 * 3_600_000)
/** R18: sólo una cuenta SALDADA (`FOLIO_PAID_STATUSES`) y viva. R5: sin excluir reembolsos (un reembolso real deja la cuenta PAID). */
const CUENTA_SALDADA = { paymentStatus: { in: ['PAID', 'REFUNDED'] }, status: { notIn: ['CANCELLED', 'DELETED'] } }
const CERRADOS = ['EXPIRED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_STAFF', 'REJECTED']

const folio = (o: { requiresAcceptance?: boolean; status?: string; order?: Record<string, unknown> } = {}) => ({
  id: 'oo1',
  requiresAcceptance: o.requiresAcceptance ?? false,
  status: o.status ?? 'PENDING_ACCEPTANCE',
  paymentMode: 'PAY_AT_PICKUP',
  acceptDeadlineAt: new Date(NOW.getTime() - 60_000), // ya pasó su hora: el dinero gana igual
  order: { orderNumber: 'F-012', status: 'PENDING', paymentStatus: 'PAID', paidAmount: D('120'), ...(o.order ?? {}) },
})
const enTx = (o: { marcarCocina?: boolean } = {}) =>
  prepararFolioPagadoEnTx(prismaMock as any, {
    venueId: 'v1',
    orderId: 'ord1',
    marcarCocina: o.marcarCocina ?? true,
    minutes: 15,
    now: NOW,
  })

beforeEach(() => {
  ;(getSettings as jest.Mock).mockResolvedValue({ defaultPrepMinutes: 15 })
  ;(debeMarcarCocina as jest.Mock).mockResolvedValue(true)
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  // lockExistingOrderForPayment: devuelve la orden que se pidió (su primer valor interpolado).
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) => [{ id: orderId }])
  prismaMock.onlineOrder.findFirst.mockReset()
  prismaMock.onlineOrder.findFirst.mockResolvedValue(folio() as any)
  prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.onlineOrderCharge.findUnique.mockReset()
  prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(null)
})

describe('prepararFolioPagadoEnTx (un solo lugar de pagado → «Por entregar»)', () => {
  it('un pedido de «Mi equipo» no es folio: NOT_FOLIO, sin candado ni escrituras', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ requiresAcceptance: true }) as any)
    await expect(enTx()).resolves.toEqual({ r: 'NOT_FOLIO' })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('«Liquidar saldo» (cuenta PAID que sigue PENDING): CAS a ACCEPTED con su hora y la cuenta a CONFIRMED con la marca de cocina en la MISMA escritura', async () => {
    const r = await enTx()
    expect(r).toMatchObject({ r: 'OK', orderWritten: true, orderStatus: 'CONFIRMED' })
    expect(prismaMock.$queryRaw).toHaveBeenCalled() // el candado de la orden, antes del CAS
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'oo1', status: { in: ['PENDING_ACCEPTANCE'] } },
      data: { status: 'ACCEPTED', acceptedAt: NOW, estimatedReadyAt: new Date(NOW.getTime() + 15 * 60_000) },
    })
    expect(prismaMock.order.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord1', venueId: 'v1', status: { in: ['PENDING'] } },
      data: { status: 'CONFIRMED', kitchenPendingAt: NOW },
    })
  })

  it('cobro de la TPV (la cuenta ya COMPLETED): no la reabre; la marca de cocina va aparte y sólo mientras no esté cancelada', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ order: { status: 'COMPLETED' } }) as any)
    prismaMock.order.updateMany.mockResolvedValueOnce({ count: 0 }) // PENDING → CONFIRMED no aplica a una COMPLETED
    const r = await enTx()
    expect(r).toMatchObject({ r: 'OK', orderWritten: false, orderStatus: null })
    expect(prismaMock.order.updateMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ord1', venueId: 'v1', status: { notIn: ['CANCELLED', 'DELETED'] } },
      data: { kitchenPendingAt: NOW },
    })
  })

  it('sin pantalla de cocina no hay marca aparte', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ order: { status: 'COMPLETED' } }) as any)
    prismaMock.order.updateMany.mockResolvedValueOnce({ count: 0 })
    await enTx({ marcarCocina: false })
    expect(prismaMock.order.updateMany).toHaveBeenCalledTimes(1)
    expect((prismaMock.order.updateMany.mock.calls[0][0] as any).data).toEqual({ status: 'CONFIRMED' })
  })

  it('un folio sin pagar no pasa: PAYMENT_REQUIRED y nada se escribe', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ order: { paymentStatus: 'PENDING', paidAmount: D('0') } }) as any)
    await expect(enTx()).resolves.toEqual({ r: 'PAYMENT_REQUIRED' })
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('pagado y luego reembolsado completo (REFUNDED, sólo defensa) también pasa a «Por entregar»', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ order: { paymentStatus: 'REFUNDED' } }) as any)
    await expect(enTx()).resolves.toMatchObject({ r: 'OK' })
  })

  it('el aparato que acepta y la sincronización compiten: el que pierde el CAS recibe STALE sin escribir la cuenta', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 0 })
    prismaMock.onlineOrder.findFirst.mockResolvedValueOnce(folio() as any).mockResolvedValueOnce(folio() as any)
    prismaMock.onlineOrder.findFirst.mockResolvedValueOnce({ status: 'ACCEPTED', acceptDeadlineAt: NOW } as any)
    await expect(enTx()).resolves.toMatchObject({ r: 'STALE', status: 'ACCEPTED' })
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })
})

describe('prepararFolioPagado (la transacción y los avisos de después)', () => {
  it('OK: avisa a la bandeja, al comensal y a la bitácora, y arma la comanda aunque la cuenta no se haya escrito', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ order: { status: 'COMPLETED' } }) as any)
    prismaMock.order.updateMany.mockResolvedValueOnce({ count: 0 })
    const r = await prepararFolioPagado({ venueId: 'v1', orderId: 'ord1', staffId: 'staff1', now: NOW })
    expect(r).toEqual({ outcome: 'OK', status: 'ACCEPTED', estimatedReadyAt: new Date(NOW.getTime() + 15 * 60_000).toISOString() })
    expect(armarComandasTrasCommit).toHaveBeenCalledTimes(1)
    expect(armarComandasTrasCommit).toHaveBeenCalledWith('v1', 'ord1', 'ROUND')
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord1', 'ACCEPTED')
    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'v1',
      'order_updated',
      expect.objectContaining({ onlineStatus: 'ACCEPTED' }),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_ACCEPTED', entityId: 'oo1', staffId: 'staff1' }))
  })

  it('sin pantalla de cocina no arma comanda', async () => {
    ;(debeMarcarCocina as jest.Mock).mockResolvedValue(false)
    await prepararFolioPagado({ venueId: 'v1', orderId: 'ord1', staffId: null, now: NOW })
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
  })

  it('STALE no avisa nada', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ status: 'ACCEPTED' }) as any)
    await expect(prepararFolioPagado({ venueId: 'v1', orderId: 'ord1', staffId: null, now: NOW })).resolves.toEqual({
      outcome: 'STALE',
      status: 'ACCEPTED',
    })
    expect(notifyOrderEvent).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
  })
})

describe('syncPaidFolios', () => {
  it('lee con tope sólo folios por pagar cuya cuenta ya está saldada y viva (sin excluir reembolsos, R5), y prepara cada uno en SU transacción', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([
      { orderId: 'ord1', venueId: 'v1' },
      { orderId: 'ord2', venueId: 'v1' },
    ] as any)

    await expect(syncPaidFolios({ venueId: 'v1' }, () => NOW)).resolves.toBe(2)

    expect(prismaMock.onlineOrder.findMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', requiresAcceptance: false, status: 'PENDING_ACCEPTANCE', order: CUENTA_SALDADA },
      select: { orderId: true, venueId: true },
      orderBy: { id: 'asc' },
      take: 100,
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(logAction).toHaveBeenCalledTimes(2)
    // El job lo corre para todos los negocios.
    await syncPaidFolios({}, () => NOW)
    expect((prismaMock.onlineOrder.findMany.mock.calls[1][0] as any).where).not.toHaveProperty('venueId')
  })

  it('la lectura pasa por `readCandidates` (el job la reintenta); una fila que truena se registra y la pasada sigue', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([
      { orderId: 'ord1', venueId: 'v1' },
      { orderId: 'ord2', venueId: 'v1' },
    ] as any)
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(new Error('se cayó la conexión'))
    const read = jest.fn((leer: () => Promise<unknown>) => leer())

    await expect(syncPaidFolios({}, () => NOW, read as any)).resolves.toBe(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('folio'), expect.objectContaining({ orderId: 'ord1' }))
  })

  it('una fila que perdió contra el aparato (STALE) no cuenta', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([{ orderId: 'ord1', venueId: 'v1' }] as any)
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ status: 'ACCEPTED' }) as any)
    await expect(syncPaidFolios({ venueId: 'v1' }, () => NOW)).resolves.toBe(0)
  })
})

describe('syncPaidClosedFolios (dinero tardío que otro cobro terminó de saldar)', () => {
  const cerrado = (id: string, status = 'EXPIRED') => ({
    id: `oo-${id}`,
    orderId: `ord-${id}`,
    venueId: 'v1',
    status,
    order: { orderNumber: `F-${id}` },
  })
  // S9: el paso compartido (`revivirFolioSaldadoEnTx`) relee el folio bajo el candado de la orden; aquí devuelve lo que la lectura vio.
  beforeEach(() => {
    prismaMock.onlineOrder.findFirst.mockImplementation((async ({ where }: any) => {
      const filas = (await (prismaMock.onlineOrder.findMany.getMockImplementation()?.({ where: {} } as any) ?? [])) as any[]
      const f = filas.find(x => x.orderId === where.orderId)
      return f ? { id: f.id, status: f.status } : null
    }) as any)
    prismaMock.order.findFirst.mockReset()
    prismaMock.activityLog.count.mockReset()
  })

  it('R4: lee sólo folios cerrados en los últimos 7 días con la cuenta saldada y viva, con tope y orden estable', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([])
    await syncPaidClosedFolios({ venueId: 'v1' }, () => NOW)
    expect(prismaMock.onlineOrder.findMany).toHaveBeenCalledWith({
      where: {
        venueId: 'v1',
        requiresAcceptance: false,
        status: { in: CERRADOS },
        updatedAt: { gte: SIETE_DIAS_ANTES },
        order: CUENTA_SALDADA,
      },
      select: { id: true, orderId: true, venueId: true, status: true, order: { select: { orderNumber: true } } },
      orderBy: { id: 'asc' },
      take: 100,
    })
  })

  it('cada fila en su transacción, bajo el candado de la orden, con un CAS que repite el estado leído y la cuenta saldada; sin marca de cocina', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A'), cerrado('B', 'REJECTED')] as any)

    await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(2)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.onlineOrder.updateMany.mock.invocationCallOrder[0])
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'oo-A', status: 'EXPIRED', requiresAcceptance: false, order: CUENTA_SALDADA },
      data: { status: 'ACCEPTED', acceptedAt: NOW },
    })
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'oo-B', status: 'REJECTED', requiresAcceptance: false, order: CUENTA_SALDADA },
      data: { status: 'ACCEPTED', acceptedAt: NOW },
    })
    // Decisión 19: la comanda, si sale, es del cobro que saldó; esta pasada no toca la cuenta.
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'v1',
      'order_updated',
      expect.objectContaining({ orderId: 'ord-A', onlineStatus: 'ACCEPTED' }),
    )
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord-A', 'ACCEPTED')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ONLINE_ORDER_ACCEPTED',
        entityId: 'oo-A',
        staffId: null,
        data: expect.objectContaining({ from: 'EXPIRED' }),
      }),
    )
  })

  it('si el CAS pierde (otro lo movió) o la orden ya no es del negocio, no cuenta ni avisa', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A'), cerrado('B')] as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 0 })
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([{ id: 'ord-A' }]).mockResolvedValueOnce([])

    await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(0)
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenCalledTimes(1)
    expect(notifyOrderEvent).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('S9 v5 (U8): la revivida NO avisa (el aviso es de la nota del cobro): ni cuenta, ni bitácora del cobro, ni avisos', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A')] as any)
    await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(1)
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.count).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(prismaMock.notification.createMany).not.toHaveBeenCalled()
  })

  it('R13 (U8): lee por páginas con cursor por id; 100 filas venenosas delante no tapan a la 101, y queda el conteo de las no revividas', async () => {
    const venenosas = Array.from({ length: 100 }, (_, i) => cerrado(`P${String(i).padStart(3, '0')}`))
    const buena = cerrado('Z')
    prismaMock.onlineOrder.findMany.mockImplementation((async ({ where }: any) =>
      where.id?.gt ? [buena].filter(r => r.id > where.id.gt) : venenosas) as any)
    // El candado de la orden falla para las venenosas (su Order es de otro negocio): no revive y la pasada sigue.
    ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) =>
      orderId === buena.orderId ? [{ id: orderId }] : [],
    )
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ id: buena.id, status: 'EXPIRED' } as any)

    await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(1)

    const lecturas = prismaMock.onlineOrder.findMany.mock.calls.map((c: any[]) => c[0].where)
    expect(lecturas).toHaveLength(2)
    expect(lecturas[0].id).toBeUndefined()
    expect(lecturas[1].id).toEqual({ gt: 'oo-P099' })
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord-Z', 'ACCEPTED')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no revivieron'),
      expect.objectContaining({ leidos: 101, sinRevivir: 100 }),
    )
  })

  it('R13: a lo más 10 páginas por pasada', async () => {
    let n = 0
    prismaMock.onlineOrder.findMany.mockImplementation((async () =>
      Array.from({ length: 100 }, () => cerrado(`X${String(n++).padStart(5, '0')}`))) as any)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    await syncPaidClosedFolios({}, () => NOW)
    expect(prismaMock.onlineOrder.findMany).toHaveBeenCalledTimes(10)
  })

  it('una fila que truena se registra y la pasada sigue', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A'), cerrado('B')] as any)
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(new Error('candado'))
    await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('folio'), expect.objectContaining({ onlineOrderId: 'oo-A' }))
  })

  describe('regla C (founder, 10-nov): el folio cobrado en la caja ANTES de cerrarse llega a la cocina al revivir', () => {
    const T = new Date(NOW.getTime() - 10 * 60_000) // venció hace 10 min
    const MARCA = { where: { id: 'ord-A', venueId: 'v1' }, data: { kitchenPendingAt: NOW } }
    // Un solo cobro llegó después del cierre: el que saldó y trae la hora.
    beforeEach(() => prismaMock.payment.count.mockResolvedValue(1))
    const releido = (horaDelCobro: Date | null, cierre: Record<string, Date | string | null> = { expiredAt: T }) => ({
      id: 'oo-A',
      status: 'EXPIRED',
      createdAt: new Date(T.getTime() - 30 * 60_000), // se pidió 30 min antes de vencer
      expiredAt: null,
      cancelledAt: null,
      cancelledBy: null,
      rejectedAt: null,
      ...cierre,
      order: { loyaltySaleAt: horaDelCobro },
    })

    it('cobrado a los 25 de 30 (sube después de vencer): la MISMA transacción marca la cocina tras el CAS y el armado ROUND va después del commit', async () => {
      prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A')] as any)
      prismaMock.onlineOrder.findFirst.mockResolvedValue(releido(new Date(T.getTime() - 5 * 60_000)) as any)
      let enLaTransaccion = false
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
        enLaTransaccion = true
        try {
          return await fn(prismaMock)
        } finally {
          enLaTransaccion = false
        }
      })
      const dentro: boolean[] = []
      ;(prismaMock.order.updateMany as jest.Mock).mockImplementationOnce(async () => {
        dentro.push(enLaTransaccion)
        return { count: 1 }
      })
      ;(armarComandasTrasCommit as jest.Mock).mockImplementationOnce(async () => {
        dentro.push(enLaTransaccion)
      })

      await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(1)

      expect(debeMarcarCocina).toHaveBeenCalledWith('v1', { orderId: 'ord-A' })
      expect(prismaMock.order.updateMany).toHaveBeenCalledWith(MARCA)
      expect(prismaMock.onlineOrder.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        prismaMock.order.updateMany.mock.invocationCallOrder[0],
      )
      expect(armarComandasTrasCommit).toHaveBeenCalledWith('v1', 'ord-A', 'ROUND')
      expect(dentro).toEqual([true, false]) // la marca dentro de la transacción; el armado, ya fuera
      // Los cobros con dinero que llegaron desde el cierre, bajo el mismo candado (los reembolsos son filas negativas).
      expect(prismaMock.payment.count).toHaveBeenCalledWith({
        where: {
          venueId: 'v1',
          orderId: 'ord-A',
          status: 'COMPLETED',
          amount: { gt: 0 },
          OR: [{ createdAt: { gte: T } }, { updatedAt: { gte: T } }],
        },
      })
    })

    it('Codex r1 #2: DOS cobros llegaron después del cierre (otra caja pudo cobrar su parte después y subirla antes) ⇒ como hoy', async () => {
      prismaMock.payment.count.mockResolvedValue(2)
      prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A')] as any)
      prismaMock.onlineOrder.findFirst.mockResolvedValue(releido(new Date(T.getTime() - 5 * 60_000)) as any)
      await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(1)
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(armarComandasTrasCommit).not.toHaveBeenCalled()
    })

    it.each([
      ['la clienta lo canceló', 'CANCELLED_BY_CUSTOMER', 'CUSTOMER'],
      ['el personal lo canceló', 'CANCELLED_BY_STAFF', 'cstaff00000000000000000001'],
    ])('%s: T es su `cancelledAt` (fecha exacta del CAS)', async (_c, status, cancelledBy) => {
      prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A', status)] as any)
      prismaMock.onlineOrder.findFirst.mockResolvedValue(
        releido(new Date(T.getTime() - 60_000), { status, cancelledAt: T, cancelledBy }) as any,
      )
      await syncPaidClosedFolios({}, () => NOW)
      expect(prismaMock.order.updateMany).toHaveBeenCalledWith(MARCA)
      expect(armarComandasTrasCommit).toHaveBeenCalledWith('v1', 'ord-A', 'ROUND')
    })

    it.each([
      ['«cancelado por otra vía» (la sincronización o la conciliación reescriben la hora)', { cancelledBy: 'ORDER_CANCELLED_ELSEWHERE' }],
      ['el sello sin quién (la conciliación lo pone al llegar el dinero)', { cancelledBy: null }],
    ])('cobrado antes de un `cancelledAt` que NO es exacto: %s ⇒ como hoy', async (_c, quien) => {
      prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A', 'CANCELLED_BY_STAFF')] as any)
      prismaMock.onlineOrder.findFirst.mockResolvedValue(
        releido(new Date(T.getTime() - 60_000), { status: 'CANCELLED_BY_STAFF', cancelledAt: T, ...quien }) as any,
      )
      await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(1)
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(armarComandasTrasCommit).not.toHaveBeenCalled()
    })

    it('T es la MENOR de sus fechas exactas: cobrado después de rechazarse ⇒ como hoy', async () => {
      prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A', 'REJECTED')] as any)
      prismaMock.onlineOrder.findFirst.mockResolvedValue(
        releido(new Date(T.getTime() - 60_000), {
          status: 'REJECTED',
          rejectedAt: new Date(T.getTime() - 2 * 60_000),
          cancelledAt: T,
          cancelledBy: 'CUSTOMER',
        }) as any,
      )
      await syncPaidClosedFolios({}, () => NOW)
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    })

    it.each([
      ['cobrado DESPUÉS de cerrarse (a los 45)', new Date(T.getTime() + 15 * 60_000)],
      ['cobrado justo en T (no es anterior)', T],
      ['sin hora del cobro (TPV, panel, cripto, o el aparato no la mandó)', null],
      ['hora anterior a que existiera el folio (reloj del aparato sin hora)', new Date(T.getTime() - 60 * 60_000)],
    ])('%s ⇒ como hoy: revive sin marca ni armado', async (_c, hora) => {
      prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A')] as any)
      prismaMock.onlineOrder.findFirst.mockResolvedValue(releido(hora as Date | null) as any)
      await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(1)
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(armarComandasTrasCommit).not.toHaveBeenCalled()
    })

    it('sin pantalla de cocina (`debeMarcarCocina` dice que no) ⇒ revive sin marca ni armado', async () => {
      ;(debeMarcarCocina as jest.Mock).mockResolvedValue(false)
      prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A')] as any)
      prismaMock.onlineOrder.findFirst.mockResolvedValue(releido(new Date(T.getTime() - 5 * 60_000)) as any)
      await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(1)
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(armarComandasTrasCommit).not.toHaveBeenCalled()
    })

    it('si el CAS pierde (otro ya lo revivió) ⇒ ni marca ni armado: la comanda es de quien ganó', async () => {
      prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A')] as any)
      prismaMock.onlineOrder.findFirst.mockResolvedValue(releido(new Date(T.getTime() - 5 * 60_000)) as any)
      prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 0 })
      await expect(syncPaidClosedFolios({}, () => NOW)).resolves.toBe(0)
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(armarComandasTrasCommit).not.toHaveBeenCalled()
    })
  })
})

/** Una cancelación no termina «Entregado» (si `syncCancelled` falló en la pasada). */
const CUENTA_VIVA = { status: { notIn: ['CANCELLED', 'DELETED'] } }

describe('cerrarFoliosDelDiaTerminado (decisión 18: «Entregado» al terminar el día del negocio)', () => {
  const ACEPTADO = new Date('2026-11-05T12:00:00.000Z')
  const fila = (k: string, status = 'ACCEPTED') => ({
    id: `oo-${k}`,
    orderId: `ord-${k}`,
    venueId: 'v1',
    status,
    orderNumber: `F-${k}`,
    acceptedAt: ACEPTADO,
  })
  /** El texto SQL de la lectura: junta las partes fijas y los fragmentos `Prisma.raw` del template. */
  const sqlLeido = () => {
    const [strings, ...valores] = (prismaMock.$queryRaw as jest.Mock).mock.calls[0]
    const aplanar = (x: any): string =>
      Array.isArray(x) ? x.join(' ') : x && typeof x === 'object' && 'strings' in x ? x.strings.join(' ') : ''
    return [aplanar(strings), ...valores.map(aplanar)].join(' ')
  }

  it('lee con tope sólo folios (requiresAcceptance = false) ACCEPTED o READY cuyo día del negocio de `acceptedAt` ya terminó, con el corte de las 04:00', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([])
    await expect(cerrarFoliosDelDiaTerminado({ venueId: 'v1' }, () => NOW)).resolves.toBe(0)
    const sql = sqlLeido()
    expect(sql).toContain('"requiresAcceptance" = false')
    expect(sql).toMatch(/IN \('ACCEPTED', 'READY'\)/)
    expect(sql).toContain('oo."acceptedAt"')
    expect(sql).toContain("INTERVAL '4 hours'")
    expect(sql).toContain("ELSE 'America/Mexico_City'") // zona desconocida ⇒ la de respaldo
    expect(sql).toContain('LIMIT')
    expect(sql).toMatch(/o\.status NOT IN \('CANCELLED', 'DELETED'\)/)
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })

  it('cada fila: un CAS sobre el estado leído y requiresAcceptance:false que sólo escribe estado y completedAt; avisa y audita después', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([fila('A'), fila('B', 'READY')])
    await expect(cerrarFoliosDelDiaTerminado({}, () => NOW)).resolves.toBe(2)
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'oo-A', status: 'ACCEPTED', requiresAcceptance: false, acceptedAt: ACEPTADO, order: CUENTA_VIVA },
      data: { status: 'COMPLETED', completedAt: NOW },
    })
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'oo-B', status: 'READY', requiresAcceptance: false, acceptedAt: ACEPTADO, order: CUENTA_VIVA },
      data: { status: 'COMPLETED', completedAt: NOW },
    })
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled() // no toca la cuenta ni el dinero
    expect(socketManager.broadcastToVenue).toHaveBeenCalledTimes(2)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ONLINE_ORDER_COLLECTED',
        entityId: 'oo-A',
        staffId: null,
        data: { orderNumber: 'F-A', automatic: 'END_OF_DAY' },
      }),
    )
  })

  it('si el CAS pierde (una persona lo entregó antes) no cuenta ni avisa; una fila que truena se registra y la pasada sigue', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([fila('A'), fila('B'), fila('C')])
    prismaMock.onlineOrder.updateMany.mockRejectedValueOnce(new Error('conexión')).mockResolvedValueOnce({ count: 0 })
    await expect(cerrarFoliosDelDiaTerminado({}, () => NOW)).resolves.toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('folio'), expect.objectContaining({ onlineOrderId: 'oo-A' }))
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'oo-C' }))
  })

  it('la lectura pasa por `readCandidates` (el job la reintenta)', async () => {
    const readCandidates = jest.fn(async () => [])
    await expect(cerrarFoliosDelDiaTerminado({}, () => NOW, readCandidates as any)).resolves.toBe(0)
    expect(readCandidates).toHaveBeenCalledTimes(1)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('las lecturas de vencer (R49 y R50: lo durable se excluye en el SQL; llave estable dentro de la pasada)', () => {
  /** La consulta entera, como la arma Prisma: texto con `?` y sus valores ya aplanados. */
  const sqlLeido = () => {
    const [strings, ...valores] = (prismaMock.$queryRaw as jest.Mock).mock.calls[0]
    return Prisma.sql(strings, ...valores)
  }
  const CURSOR = { at: new Date('2026-11-06T18:00:00.000Z'), id: 'oo-099' }

  it('R49: folios con abono devuelto: folio PENDING_ACCEPTANCE vencido, cuenta abierta PARTIAL y Σ (importe + propina) de los COMPLETED ≤ 0, en UNA consulta acotada y en orden estable', async () => {
    const fila = { id: 'oo1', orderId: 'ord1', venueId: 'v1', acceptDeadlineAt: NOW }
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([fila])
    await expect(leerFoliosConAbonoDevuelto(NOW, null)).resolves.toEqual([fila])
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1) // sin N+1: el neto y el cobro de terminal van dentro de la misma consulta
    const { sql, values } = sqlLeido()
    expect(sql).toContain('oo."requiresAcceptance" = false')
    expect(sql).toContain("oo.status = 'PENDING_ACCEPTANCE'")
    expect(sql).toContain('oo."acceptDeadlineAt" <=')
    expect(sql).toContain("AT TIME ZONE 'UTC'") // la fecha va por `utcTs`
    expect(sql).toContain('o."paymentStatus" = \'PARTIAL\'')
    expect(sql).toContain('o.status::text IN')
    expect(sql).toMatch(/SUM\(p\.amount \+ p\."tipAmount"\)/)
    expect(sql).toContain("p.status = 'COMPLETED'")
    expect(sql).toMatch(/<= 0/)
    expect(sql).toMatch(/ORDER BY oo\."acceptDeadlineAt" ASC, oo\.id ASC/)
    expect(sql).not.toContain('oo.id) >') // sin cursor, desde el principio
    expect(values[values.length - 1]).toBe(100) // LIMIT
    expect(values).toEqual(expect.arrayContaining(['PENDING', 'CONFIRMED', 'PREPARING', 'READY', NOW]))
  })

  it('R49: el barrido principal sólo lee cuentas sin un peso (PENDING): un abono, vivo o devuelto, nunca gasta sus páginas', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([])
    await leerPedidosVencidos(NOW, null)
    const { sql, values } = sqlLeido()
    expect(sql).toContain("oo.status = 'PENDING_ACCEPTANCE'")
    expect(sql).toContain('oo."acceptDeadlineAt" <=')
    expect(sql).toContain('o."paymentStatus" = \'PENDING\'')
    expect(sql).not.toContain('PARTIAL')
    expect(sql).not.toContain('"requiresAcceptance"') // también «Mi equipo»
    expect(sql).toContain('o.status::text IN')
    expect(sql).toMatch(/ORDER BY oo\."acceptDeadlineAt" ASC, oo\.id ASC/)
    expect(values[values.length - 1]).toBe(100)
  })

  it.each([
    ['leerPedidosVencidos', () => leerPedidosVencidos(NOW, CURSOR)],
    ['leerFoliosConAbonoDevuelto', () => leerFoliosConAbonoDevuelto(NOW, CURSOR)],
  ])(
    'R50 · %s excluye EN SU SQL la cuenta con un cobro de terminal sin desenlace (la guarda de vencer, misma tabla, mismo negocio y misma orden) y sigue DESPUÉS de su cursor',
    async (_nombre, leer) => {
      ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([])
      await leer()
      const { sql, values } = sqlLeido()
      expect(sql).toMatch(
        /NOT EXISTS \(\s*SELECT 1 FROM "TerminalPaymentRequest" r\s+WHERE r\."venueId" = oo\."venueId" AND r\."orderId" = oo\."orderId"/,
      )
      // El predicado de la guarda (`UNRESOLVED_FINANCIAL_OUTCOME`) en SQL: en vuelo/UNKNOWN/TIMED_OUT, COMPLETED sin Payment, FAILED sin
      // código acreditado, CANCELLED sin aceptación. Su equivalencia fila por fila se prueba contra Postgres.
      expect(values).toEqual(expect.arrayContaining(['PENDING', 'SENT', 'CANCEL_REQUESTED', 'UNKNOWN', 'TIMED_OUT']))
      expect(sql).toContain('(oo."acceptDeadlineAt", oo.id) > (')
      expect(values.slice(-3)).toEqual([CURSOR.at, CURSOR.id, 100])
    },
  )
})

/**
 * R52 (parada «reloj viejo», Codex f1 r4): toda hora que se ESCRIBE bajo el candado o en un CAS, y la que decide días, se lee en ese
 * momento con el reloj que se inyecta (en producción `() => new Date()`); la hora de la pasada sólo elige candidatos. Aquí el reloj
 * avanza cuando el candado se suelta: lo escrito debe ser la hora de DESPUÉS.
 */
describe('R52 · la hora se lee al escribir o decidir, no al empezar la pasada', () => {
  // 03:59:50 y 04:00:05 en México (UTC-6): la pasada empezó el día anterior y el folio se escribe el día nuevo.
  const PASADA = new Date('2026-11-06T09:59:50.000Z')
  const BAJO_CANDADO = new Date('2026-11-06T10:00:05.000Z')
  /** El reloj marca PASADA hasta que se toma el candado de la orden; desde ahí, BAJO_CANDADO. */
  let ahora: Date
  const reloj = () => ahora
  beforeEach(() => {
    ahora = PASADA
    ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) => {
      ahora = BAJO_CANDADO // la espera del candado cruzó las 04:00
      return [{ id: orderId }]
    })
  })

  it('syncPaidClosedFolios escribe `acceptedAt` con el reloj leído DESPUÉS del candado (no la hora de la pasada) y avisa con esa hora', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([
      { id: 'oo-A', orderId: 'ord-A', venueId: 'v1', status: 'EXPIRED', order: { orderNumber: 'F-A' } },
    ] as any)
    await expect(syncPaidClosedFolios({}, reloj)).resolves.toBe(1)
    // La ventana de 7 días se cuenta con el reloj de la lectura.
    expect((prismaMock.onlineOrder.findMany.mock.calls[0][0] as any).where.updatedAt).toEqual({
      gte: new Date(PASADA.getTime() - 7 * 24 * 3_600_000),
    })
    expect((prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).data).toEqual({ status: 'ACCEPTED', acceptedAt: BAJO_CANDADO })
    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'v1',
      'order_updated',
      expect.objectContaining({ orderId: 'ord-A', timestamp: BAJO_CANDADO.toISOString() }),
    )
  })

  it('syncPaidFolios: «Por entregar» con `acceptedAt`, hora estimada y marca de cocina del reloj leído bajo el candado', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([{ orderId: 'ord1', venueId: 'v1' }] as any)
    await expect(syncPaidFolios({}, reloj)).resolves.toBe(1)
    expect((prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).data).toEqual({
      status: 'ACCEPTED',
      acceptedAt: BAJO_CANDADO,
      estimatedReadyAt: new Date(BAJO_CANDADO.getTime() + 15 * 60_000),
    })
    expect((prismaMock.order.updateMany.mock.calls[0][0] as any).data).toEqual({ status: 'CONFIRMED', kitchenPendingAt: BAJO_CANDADO })
  })

  it('cerrarFoliosDelDiaTerminado decide el día con el reloj de la lectura, nunca cierra un folio aceptado DESPUÉS de esa hora, y escribe `completedAt` al escribir', async () => {
    const DECIDE = new Date('2026-11-07T10:00:01.000Z') // 04:00:01 del día siguiente
    const ESCRIBE = new Date('2026-11-07T10:00:02.000Z')
    const horas = [DECIDE, ESCRIBE]
    const relojDelCierre = jest.fn(() => horas.shift() ?? ESCRIBE)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { id: 'oo-A', orderId: 'ord-A', venueId: 'v1', status: 'ACCEPTED', orderNumber: 'F-A', acceptedAt: BAJO_CANDADO },
    ])
    await expect(cerrarFoliosDelDiaTerminado({}, relojDelCierre)).resolves.toBe(1)
    const [strings, ...valores] = (prismaMock.$queryRaw as jest.Mock).mock.calls[0]
    // El texto en su orden: cada parte fija seguida de su fragmento `Prisma.raw` (los valores enlazados no cuentan aquí).
    const fragmento = (x: any): string => (x && typeof x === 'object' && 'strings' in x ? x.strings.join(' ') : '')
    const sql = (strings as string[]).reduce((acc, parte, i) => acc + parte + (i < valores.length ? fragmento(valores[i]) : ''), '')
    // La guarda: lo aceptado después de decidir no se toca (con `utcTs`, contra la hora de la lectura)…
    expect(sql).toMatch(/oo\."acceptedAt" <= \(\s*AT TIME ZONE 'UTC'\)/)
    const guarda = valores.find(
      (v: any) => v && typeof v === 'object' && 'strings' in v && v.strings.join('').includes("AT TIME ZONE 'UTC'"),
    )
    expect(guarda.values).toEqual([DECIDE])
    // …y el día se compara contra ese mismo instante.
    expect(sql).toContain("TIMESTAMP '2026-11-07 10:00:01.000'")
    expect((prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).data).toEqual({ status: 'COMPLETED', completedAt: ESCRIBE })
  })
})

describe('S11 · cerrarFolioEnCeroEnTx: un folio que un beneficio deja en $0 se cierra pagado sin cobro (P2-4, E5)', () => {
  const ITEMS = [{ id: 'oi1', productId: 'p1', quantity: 1, modifiers: [] }]
  const cerrar = () =>
    cerrarFolioEnCeroEnTx(prismaMock as any, { venueId: 'v1', orderId: 'ord1', marcarCocina: true, minutes: 15, reloj: () => NOW })

  beforeEach(() => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.order.findFirst.mockResolvedValue({ customerId: 'cust1', items: ITEMS } as any)
    prismaMock.orderDiscount.findFirst.mockResolvedValue(null)
    prismaMock.activityLog.create.mockResolvedValue({} as any)
    prismaMock.couponRedemption.create.mockResolvedValue({} as any)
    prismaMock.couponCode.update.mockResolvedValue({} as any)
    prismaMock.discount.update.mockResolvedValue({} as any)
  })

  it('«Nadie»: PAID y COMPLETED sin Payment, horas al escribir, comanda marcada, vale de inventario y «Por entregar»; nunca loyaltyEligibleAt', async () => {
    const r = await cerrar()
    expect(prismaMock.order.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'ord1', venueId: 'v1', total: 0, paymentStatus: 'PENDING', status: { notIn: ['CANCELLED', 'DELETED'] } },
      data: { paymentStatus: 'PAID', status: 'COMPLETED', completedAt: NOW, kitchenPendingAt: NOW, remainingBalance: 0 },
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(createSalePostingInTx).toHaveBeenCalledWith(prismaMock, { venueId: 'v1', orderId: 'ord1', items: ITEMS, staffId: null })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ venueId: 'v1', action: 'ONLINE_ORDER_CLOSED_AT_ZERO', entity: 'Order', entityId: 'ord1' }),
    })
    // El paso de etapa 1 a «Por entregar» (CAS PENDING_ACCEPTANCE → ACCEPTED), sin volver a marcar la cocina.
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['PENDING_ACCEPTANCE'] } }),
        data: expect.objectContaining({ status: 'ACCEPTED' }),
      }),
    )
    expect(r).toMatchObject({ cerrado: true, postingId: 'post1', cas: { r: 'OK' } })
  })

  it('con cupón: asesor del descuento → su fila Discount → el canje (CouponCode 6b con su Discount ya tomada)', async () => {
    prismaMock.orderDiscount.findFirst.mockResolvedValue({
      couponCodeId: 'cc1',
      amount: D('100.00'),
      couponCode: { discountId: 'd1' },
    } as any)
    await cerrar()
    const raw = (prismaMock.$queryRaw as jest.Mock).mock.calls.map(([sql]) =>
      Array.isArray(sql) ? sql.join('?') : String(sql?.sql ?? sql?.strings?.join('?') ?? sql),
    )
    const asesor = raw.findIndex(t => /pg_advisory_xact_lock/.test(t))
    const fila = raw.findIndex(t => /FOR NO KEY UPDATE/.test(t))
    expect(asesor).toBeGreaterThanOrEqual(0)
    expect(fila).toBeGreaterThan(asesor)
    expect(prismaMock.couponRedemption.create).toHaveBeenCalledWith({
      data: { couponCodeId: 'cc1', orderId: 'ord1', customerId: 'cust1', amountSaved: D('100.00') },
    })
    expect(prismaMock.couponCode.update).toHaveBeenCalledWith({ where: { id: 'cc1' }, data: { currentUses: { increment: 1 } } })
    expect(prismaMock.discount.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { currentUses: { increment: 1 } } })
  })

  it('una cuenta que no está en $0 o ya no está por pagar no se toca (CAS en 0): ni vale, ni canje, ni bitácora', async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 })
    expect(await cerrar()).toEqual({ cerrado: false })
    expect(createSalePostingInTx).not.toHaveBeenCalled()
    expect(prismaMock.couponRedemption.create).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })

  it('«Mi equipo»: se cierra pagado y el pedido sigue su aceptación de hoy (no lo pasa a «Por entregar»)', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ requiresAcceptance: true }) as any)
    const r = await cerrar()
    expect(r).toMatchObject({ cerrado: true, cas: { r: 'NOT_FOLIO' } })
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })
})
