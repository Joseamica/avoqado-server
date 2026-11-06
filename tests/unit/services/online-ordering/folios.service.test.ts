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
import {
  cerrarFoliosDelDiaTerminado,
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

    await expect(syncPaidFolios({ venueId: 'v1' }, NOW)).resolves.toBe(2)

    expect(prismaMock.onlineOrder.findMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', requiresAcceptance: false, status: 'PENDING_ACCEPTANCE', order: CUENTA_SALDADA },
      select: { orderId: true, venueId: true },
      orderBy: { id: 'asc' },
      take: 100,
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(logAction).toHaveBeenCalledTimes(2)
    // El job lo corre para todos los negocios.
    await syncPaidFolios({}, NOW)
    expect((prismaMock.onlineOrder.findMany.mock.calls[1][0] as any).where).not.toHaveProperty('venueId')
  })

  it('la lectura pasa por `readCandidates` (el job la reintenta); una fila que truena se registra y la pasada sigue', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([
      { orderId: 'ord1', venueId: 'v1' },
      { orderId: 'ord2', venueId: 'v1' },
    ] as any)
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(new Error('se cayó la conexión'))
    const read = jest.fn((leer: () => Promise<unknown>) => leer())

    await expect(syncPaidFolios({}, NOW, read as any)).resolves.toBe(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('folio'), expect.objectContaining({ orderId: 'ord1' }))
  })

  it('una fila que perdió contra el aparato (STALE) no cuenta', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([{ orderId: 'ord1', venueId: 'v1' }] as any)
    prismaMock.onlineOrder.findFirst.mockResolvedValue(folio({ status: 'ACCEPTED' }) as any)
    await expect(syncPaidFolios({ venueId: 'v1' }, NOW)).resolves.toBe(0)
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

  it('R4: lee sólo folios cerrados en los últimos 7 días con la cuenta saldada y viva, con tope y orden estable', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([])
    await syncPaidClosedFolios({ venueId: 'v1' }, NOW)
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

    await expect(syncPaidClosedFolios({}, NOW)).resolves.toBe(2)

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

    await expect(syncPaidClosedFolios({}, NOW)).resolves.toBe(0)
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenCalledTimes(1)
    expect(notifyOrderEvent).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('una fila que truena se registra y la pasada sigue', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([cerrado('A'), cerrado('B')] as any)
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(new Error('candado'))
    await expect(syncPaidClosedFolios({}, NOW)).resolves.toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('folio'), expect.objectContaining({ onlineOrderId: 'oo-A' }))
  })
})

describe('cerrarFoliosDelDiaTerminado (decisión 18: «Entregado» al terminar el día del negocio)', () => {
  const fila = (k: string, status = 'ACCEPTED') => ({ id: `oo-${k}`, orderId: `ord-${k}`, venueId: 'v1', status, orderNumber: `F-${k}` })
  /** El texto SQL de la lectura: junta las partes fijas y los fragmentos `Prisma.raw` del template. */
  const sqlLeido = () => {
    const [strings, ...valores] = (prismaMock.$queryRaw as jest.Mock).mock.calls[0]
    const aplanar = (x: any): string =>
      Array.isArray(x) ? x.join(' ') : x && typeof x === 'object' && 'strings' in x ? x.strings.join(' ') : ''
    return [aplanar(strings), ...valores.map(aplanar)].join(' ')
  }

  it('lee con tope sólo folios (requiresAcceptance = false) ACCEPTED o READY cuyo día del negocio de `acceptedAt` ya terminó, con el corte de las 04:00', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([])
    await expect(cerrarFoliosDelDiaTerminado({ venueId: 'v1' }, NOW)).resolves.toBe(0)
    const sql = sqlLeido()
    expect(sql).toContain('"requiresAcceptance" = false')
    expect(sql).toMatch(/IN \('ACCEPTED', 'READY'\)/)
    expect(sql).toContain('oo."acceptedAt"')
    expect(sql).toContain("INTERVAL '4 hours'")
    expect(sql).toContain("ELSE 'America/Mexico_City'") // zona desconocida ⇒ la de respaldo
    expect(sql).toContain('LIMIT')
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })

  it('cada fila: un CAS sobre el estado leído y requiresAcceptance:false que sólo escribe estado y completedAt; avisa y audita después', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([fila('A'), fila('B', 'READY')])
    await expect(cerrarFoliosDelDiaTerminado({}, NOW)).resolves.toBe(2)
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'oo-A', status: 'ACCEPTED', requiresAcceptance: false },
      data: { status: 'COMPLETED', completedAt: NOW },
    })
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'oo-B', status: 'READY', requiresAcceptance: false },
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
    await expect(cerrarFoliosDelDiaTerminado({}, NOW)).resolves.toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('folio'), expect.objectContaining({ onlineOrderId: 'oo-A' }))
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'oo-C' }))
  })

  it('la lectura pasa por `readCandidates` (el job la reintenta)', async () => {
    const readCandidates = jest.fn(async () => [])
    await expect(cerrarFoliosDelDiaTerminado({}, NOW, readCandidates as any)).resolves.toBe(0)
    expect(readCandidates).toHaveBeenCalledTimes(1)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})
