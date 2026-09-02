/**
 * Fase 0 del turno de caja del negocio: NINGUNA orden cobrada se queda «abierta».
 *
 * Caso semilla ORD-1788276418170 (Testarudo, 1-sep-2026): el `Payment` quedó COMPLETED y la
 * transición a PAID nunca aterrizó, así que el Cierre del día la lista como pendiente para
 * siempre — y esa pantalla es de sólo lectura, no hay forma de cerrarla desde el producto.
 *
 * Lo que estas pruebas protegen:
 *   1. cada candidata se repara y deja rastro en `ActivityLog` con los cobros que la cubren.
 *   2. 🔴 el modo simulación no toca NADA: ni repara ni escribe bitácora. Es lo que hace
 *      seguro correr el barrido a mano contra producción antes de aplicarlo.
 *   3. una orden que la transacción del cobro no pudo cerrar NO detiene a las demás, y su
 *      fallo no se disfraza de éxito en la bitácora.
 *   4. el barrido no se encima consigo mismo.
 *   5. 🔴 cierra SIEMPRE por `reconcileOrderFromPayments`, el MISMO camino del cobro que
 *      seleccionó el criterio. Con otro cerrador, un venue con cargos por servicio quedaría
 *      elegido por el criterio y rechazado por el cierre para siempre.
 *   6. la ventana de 30 días acota el tic, y un `since` explícito la abre para el script a
 *      mano — que es el único que debe alcanzar el rezago viejo.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { PaidOrderReconcilerJob, defaults } from '@/jobs/paid-order-reconciler.job'
import { reconcileOrderFromPayments } from '@/services/tpv/payment.tpv.service'

const noopCron = { start: jest.fn(), stop: jest.fn() }
const AHORA = new Date('2026-09-02T20:00:00Z')

/** `paymentIds` trae TODOS los COMPLETED (reembolsos incluidos): es rastro, no la suma que manda. */
const candidata = (id: string) => ({
  id,
  venueId: 'v1',
  orderNumber: `ORD-${id}`,
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  base: '65.00',
  pagado: '65.00',
  paymentIds: [`pay-${id}`],
})

type Overrides = NonNullable<ConstructorParameters<typeof PaidOrderReconcilerJob>[0]>

function job(over: Overrides = {}) {
  return new PaidOrderReconcilerJob({
    cron: noopCron,
    now: () => AHORA,
    retryEntry: (fn: () => Promise<unknown>) => fn() as never,
    findCandidates: jest.fn().mockResolvedValue([candidata('a'), candidata('b')]),
    reconcile: jest.fn().mockResolvedValue({ orderId: 'x', warning: null }),
    ...over,
  })
}

describe('paid-order-reconciler', () => {
  beforeEach(() => jest.clearAllMocks())

  it('repara cada candidata y deja rastro en ActivityLog con los cobros que la cubren', async () => {
    const reconcile = jest.fn().mockResolvedValue({ orderId: 'x', warning: null })
    const r = await job({ reconcile }).runNow()

    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(reconcile).toHaveBeenNthCalledWith(1, 'a')
    expect(reconcile).toHaveBeenNthCalledWith(2, 'b')
    expect(r).toMatchObject({ scanned: 2, reconciled: 2, failed: 0, skipped: 0, dryRun: false })

    // La forma del asiento es el contrato: quién NO lo hizo (`staffId: null`), qué se cerró,
    // cómo estaba antes, con qué cobros, y —🔴 addendum del controller— que la reparación
    // sólo movió el ESTADO: sin vale de inventario y sin lealtad.
    expect(logAction).toHaveBeenCalledWith({
      staffId: null,
      venueId: 'v1',
      action: 'ORDER_RECONCILED_PAID',
      entity: 'Order',
      entityId: 'a',
      data: {
        orderNumber: 'ORD-a',
        before: { status: 'CONFIRMED', paymentStatus: 'PENDING' },
        base: '65.00',
        pagado: '65.00',
        paymentIds: ['pay-a'],
        sweep: 'paid-order-reconciler',
        effects: 'ORDER_STATUS_ONLY',
      },
    })
    expect(logAction).toHaveBeenCalledTimes(2)
  })

  it('en modo simulación lista las candidatas y NO repara ni escribe bitácora', async () => {
    const reconcile = jest.fn()
    const r = await job({ reconcile }).runNow({ dryRun: true })

    expect(reconcile).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
    expect(r.candidates.map(c => c.id)).toEqual(['a', 'b'])
    expect(r).toMatchObject({ scanned: 2, reconciled: 0, failed: 0, dryRun: true })
  })

  it('un fallo en una orden no detiene a las demás y se cuenta como failed, sin bitácora de éxito', async () => {
    const reconcile = jest
      .fn()
      .mockRejectedValueOnce(new Error('vale de inventario roto'))
      .mockResolvedValueOnce({ orderId: 'b', warning: null })
    const r = await job({ reconcile }).runNow()

    expect(r).toMatchObject({ scanned: 2, reconciled: 1, failed: 1 })
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'b' }))
    // El motivo se REPORTA: una orden que no se pudo cerrar no se esconde.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('paid-order-reconciler'), expect.objectContaining({ orderId: 'a' }))
  })

  it('no se encima consigo mismo', async () => {
    const lento = job({ findCandidates: jest.fn(() => new Promise(res => setTimeout(() => res([]), 20))) as never })
    const [a, b] = await Promise.all([lento.runNow(), lento.runNow()])

    expect([a.skipped, b.skipped].sort()).toEqual([0, 1])
  })

  it('🔴 cierra por el MISMO camino del cobro, nunca por otro', () => {
    expect(defaults.reconcile).toBe(reconcileOrderFromPayments)
  })

  it('mira 30 días hacia atrás por default; un `since` explícito manda', async () => {
    const porDefault = jest.fn().mockResolvedValue([])
    await job({ findCandidates: porDefault }).runNow({ dryRun: true })
    expect(porDefault).toHaveBeenCalledWith({
      graceMs: 5 * 60 * 1000,
      limit: 50,
      now: AHORA,
      since: new Date('2026-08-03T20:00:00.000Z'),
    })

    // El rezago de diciembre-2025 sólo lo alcanza quien pida explícitamente esa ventana:
    // el script a mano de la fase 5, nunca el tic de cada 10 minutos.
    const explicito = jest.fn().mockResolvedValue([])
    const desde = new Date('2025-01-01T00:00:00Z')
    await job({ findCandidates: explicito }).runNow({ dryRun: true, since: desde })
    expect(explicito).toHaveBeenCalledWith(expect.objectContaining({ since: desde }))
  })
})
