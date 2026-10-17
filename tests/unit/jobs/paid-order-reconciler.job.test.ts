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
 *   4b. una reparación que no escribió (la orden cambió bajo su candado) no se asienta como reconciliada.
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
import { prismaMock } from '../../__helpers__/setup'
import { findSesionesDeValesAtoradas, reconcileOrderFromPayments, retomarCobroDeValesAtorado } from '@/services/tpv/payment.tpv.service'

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
    reconcile: jest.fn().mockResolvedValue({ orderId: 'x', warning: null, written: true }),
    // Sin venta de vales atorada (lo normal): la candidata se cierra de estado como siempre.
    retomarVale: jest.fn().mockResolvedValue(null),
    // R11-4: sin sesiones de vales atoradas de ventas ya cerradas (lo normal).
    findSesionesAtoradas: jest.fn().mockResolvedValue([]),
    // R12-3: sin ventas cerradas por otro canal con su sesión abierta (lo normal).
    findSesionesDeVentasCerradas: jest.fn().mockResolvedValue([]),
    cerrarSesionDeVentaCerrada: jest.fn().mockResolvedValue(false),
    ...over,
  })
}

describe('paid-order-reconciler', () => {
  beforeEach(() => jest.clearAllMocks())

  it('repara cada candidata y deja rastro en ActivityLog con los cobros que la cubren', async () => {
    const reconcile = jest.fn().mockResolvedValue({ orderId: 'x', warning: null, written: true })
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
      .mockResolvedValueOnce({ orderId: 'b', warning: null, written: true })
    const r = await job({ reconcile }).runNow()

    expect(r).toMatchObject({ scanned: 2, reconciled: 1, failed: 1 })
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'b' }))
    // El motivo se REPORTA: una orden que no se pudo cerrar no se esconde.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('paid-order-reconciler'), expect.objectContaining({ orderId: 'a' }))
  })

  it('🔴 una pasada que NO escribió no se audita como reconciliada: se cuenta aparte (Ruling T8-R3)', async () => {
    // `written: false`: las entradas de la orden cambiaron dos veces bajo su candado y la reparación no escribió nada.
    // Asentar ORDER_RECONCILED_PAID ahí mentiría en la bitácora; la orden vuelve a salir en el siguiente tic.
    const reconcile = jest
      .fn()
      .mockResolvedValueOnce({ orderId: 'a', warning: null, written: false })
      .mockResolvedValueOnce({ orderId: 'b', warning: null, written: true })
    const r = await job({ reconcile }).runNow()

    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ scanned: 2, reconciled: 1, notWritten: 1, failed: 0 })
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ORDER_RECONCILED_PAID', entityId: 'b' }))
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

  /**
   * 🔴 R10-3 (Codex recheck-14 #3): la venta de vales cuyo cobro capturado quedó en conciliación (su finalización falló) y la
   * terminal nunca reenvía —lo normal: ya recibió su 201—. Cerrarla sólo de estado la dejaba sin lealtad, cupones, comanda ni
   * descuento para siempre. El barrido la cierra primero por SU sesión (el mismo camino que el reenvío) y sólo si no se puede, de
   * estado.
   */
  describe('🔴 R10-3: la venta de vales con su cobro atorado', () => {
    it('se cierra por su sesión (con inventario y efectos) y NO de estado; el asiento lo dice', async () => {
      const reconcile = jest.fn().mockResolvedValue({ orderId: 'b', warning: null, written: true })
      const retomarVale = jest.fn().mockImplementation(async (_v: string, id: string) => (id === 'a' ? 'PAID' : null))
      const r = await job({ reconcile, retomarVale }).runNow()

      expect(retomarVale).toHaveBeenNthCalledWith(1, 'v1', 'a', AHORA)
      expect(reconcile).toHaveBeenCalledTimes(1)
      expect(reconcile).toHaveBeenCalledWith('b')
      expect(r).toMatchObject({ scanned: 2, reconciled: 2, failed: 0 })
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ORDER_RECONCILED_PAID',
          entityId: 'a',
          data: expect.objectContaining({ effects: 'AREA_TICKET_SESSION_FINALIZED' }),
        }),
      )
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'b', data: expect.objectContaining({ effects: 'ORDER_STATUS_ONLY' }) }),
      )
    })

    it.each(['RECONCILIATION_REQUIRED', 'PARTIALLY_PAID'])(
      'si la sesión tampoco ahora se puede cerrar (%s) ⇒ de estado, como siempre',
      async estado => {
        const reconcile = jest.fn().mockResolvedValue({ orderId: 'a', warning: null, written: true })
        const r = await job({ reconcile, retomarVale: jest.fn().mockResolvedValue(estado) }).runNow()

        expect(reconcile).toHaveBeenCalledTimes(2)
        expect(r).toMatchObject({ reconciled: 2, failed: 0 })
      },
    )

    it('un fallo al retomar no detiene el cierre de estado (y se reporta)', async () => {
      const reconcile = jest.fn().mockResolvedValue({ orderId: 'a', warning: null, written: true })
      const r = await job({ reconcile, retomarVale: jest.fn().mockRejectedValue(new Error('base caída')) }).runNow()

      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(r).toMatchObject({ reconciled: 2, failed: 0 })
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('retomar'), expect.objectContaining({ orderId: 'a' }))
    })

    it('🔴 retoma por el MISMO camino que el reenvío de la terminal', () => {
      expect(defaults.retomarVale).toBe(retomarCobroDeValesAtorado)
    })
  })

  /**
   * 🔴 R11-4 (Codex recheck-15 #4): cerrar de estado no le quita a la sesión su rescate. La venta ya COMPLETED (el primer rescate
   * falló y cerró de estado) sale de las candidatas; una segunda pasada acotada retoma su sesión cuando ya se puede.
   */
  describe('🔴 R11-4: las sesiones de vales atoradas de ventas ya cerradas', () => {
    it('una sesión atorada de una venta COMPLETED se retoma y se asienta AREA_TICKET_SESSION_RECOVERED; acotada a 25 por tic', async () => {
      const findSesionesAtoradas = jest.fn().mockResolvedValue([{ venueId: 'v1', orderId: 'cerrada' }])
      const retomarVale = jest.fn().mockImplementation(async (_v: string, id: string) => (id === 'cerrada' ? 'PAID' : null))
      const r = await job({ findCandidates: jest.fn().mockResolvedValue([]), findSesionesAtoradas, retomarVale }).runNow()

      expect(findSesionesAtoradas).toHaveBeenCalledWith({ limit: 25, now: AHORA, since: new Date('2026-08-03T20:00:00.000Z') })
      expect(retomarVale).toHaveBeenCalledWith('v1', 'cerrada', AHORA)
      expect(r).toMatchObject({ sessionsRecovered: 1, failed: 0 })
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AREA_TICKET_SESSION_RECOVERED',
          entityId: 'cerrada',
          data: expect.objectContaining({ estado: 'PAID', effects: 'AREA_TICKET_SESSION_FINALIZED' }),
        }),
      )
    })

    it('si tampoco ahora se puede (sigue sin existencia) ⇒ sin asiento ni falla: se reintenta más tarde (su espera creció)', async () => {
      const r = await job({
        findCandidates: jest.fn().mockResolvedValue([]),
        findSesionesAtoradas: jest.fn().mockResolvedValue([{ venueId: 'v1', orderId: 'cerrada' }]),
        retomarVale: jest.fn().mockResolvedValue('RECONCILIATION_REQUIRED'),
      }).runNow()

      expect(r).toMatchObject({ sessionsRecovered: 0, failed: 0 })
      expect(logAction).not.toHaveBeenCalled()
    })

    it('un fallo en una sesión no detiene a las demás y se cuenta', async () => {
      const retomarVale = jest.fn().mockRejectedValueOnce(new Error('base caída')).mockResolvedValueOnce('PAID')
      const r = await job({
        findCandidates: jest.fn().mockResolvedValue([]),
        findSesionesAtoradas: jest.fn().mockResolvedValue([
          { venueId: 'v1', orderId: 'x' },
          { venueId: 'v1', orderId: 'y' },
        ]),
        retomarVale,
      }).runNow()

      expect(r).toMatchObject({ sessionsRecovered: 1, failed: 1 })
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('atorada'), expect.objectContaining({ orderId: 'x' }))
    })

    it('lo que la primera pasada ya intentó en este tic no se vuelve a intentar', async () => {
      const retomarVale = jest.fn().mockResolvedValue('RECONCILIATION_REQUIRED')
      await job({
        findSesionesAtoradas: jest.fn().mockResolvedValue([{ venueId: 'v1', orderId: 'a' }]),
        retomarVale,
      }).runNow()

      expect(retomarVale.mock.calls.filter(([, id]) => id === 'a')).toHaveLength(1)
    })

    it('el modo simulación no retoma sesiones', async () => {
      const findSesionesAtoradas = jest.fn().mockResolvedValue([{ venueId: 'v1', orderId: 'cerrada' }])
      await job({ findSesionesAtoradas }).runNow({ dryRun: true })

      expect(findSesionesAtoradas).not.toHaveBeenCalled()
    })

    it('🔴 la selección es UNA consulta acotada del servicio de cobros: tope, orden estable, ventana y espera creciente por fallo', async () => {
      prismaMock.$queryRaw.mockResolvedValue([])
      await defaults.findSesionesAtoradas({ limit: 25, now: AHORA, since: AHORA })

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
      // Plantilla etiquetada: el primer argumento ES el arreglo de textos.
      const sql = Array.from(prismaMock.$queryRaw.mock.calls[0][0] as unknown as string[]).join('?')
      expect(sql).toContain('ORDER BY a."startedAt" ASC, s.id ASC')
      expect(sql).toContain('LIMIT ?')
      expect(sql).toContain('"lastCheckedAt"')
      expect(sql).toMatch(/s\.status = 'RECONCILIATION_REQUIRED' AND a\.status = 'UNKNOWN'/)
      expect(sql).toMatch(/s\.status = 'PAYMENT_PENDING' AND a\.status IN \('PENDING', 'PREPARED'\)/)
      expect(findSesionesDeValesAtoradas).toBeDefined()
    })
  })

  /**
   * 🔴 R12-3 (Codex recheck-16 #4): antes de R10-2, venta $100 = abono de la terminal $50 + pago manual $50 ⇒ venta PAID, vale SALE
   * APPLIED, stock 10 → 9, pero la reserva del vale quedó ACTIVE y la sesión PARTIALLY_PAID ⇒ disponibilidad 8. Nada lo disparaba.
   */
  describe('🔴 R12-3: las reservas viejas de ventas que cerró otro canal antes de R10-2', () => {
    it('cada sesión elegida se cierra y se asienta AREA_TICKET_SESSION_CLOSED_BY_SALE; acotada a 25 por tic y en la ventana', async () => {
      const findSesionesDeVentasCerradas = jest.fn().mockResolvedValue([{ venueId: 'v1', orderId: 'vieja' }])
      const cerrarSesionDeVentaCerrada = jest.fn().mockResolvedValue(true)
      const r = await job({
        findCandidates: jest.fn().mockResolvedValue([]),
        findSesionesDeVentasCerradas,
        cerrarSesionDeVentaCerrada,
      }).runNow()

      expect(findSesionesDeVentasCerradas).toHaveBeenCalledWith({ limit: 25, since: new Date('2026-08-03T20:00:00.000Z') })
      expect(cerrarSesionDeVentaCerrada).toHaveBeenCalledWith('v1', 'vieja')
      expect(r).toMatchObject({ sessionsClosed: 1, failed: 0 })
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          staffId: null,
          action: 'AREA_TICKET_SESSION_CLOSED_BY_SALE',
          entityId: 'vieja',
          data: { sweep: 'paid-order-reconciler', effects: 'RESERVATIONS_RELEASED' },
        }),
      )
    })

    it('la que bajo el candado ya no cumple (otro la cerró en medio) ⇒ sin asiento ni falla', async () => {
      const r = await job({
        findCandidates: jest.fn().mockResolvedValue([]),
        findSesionesDeVentasCerradas: jest.fn().mockResolvedValue([{ venueId: 'v1', orderId: 'vieja' }]),
        cerrarSesionDeVentaCerrada: jest.fn().mockResolvedValue(false),
      }).runNow()

      expect(r).toMatchObject({ sessionsClosed: 0, failed: 0 })
      expect(logAction).not.toHaveBeenCalled()
    })

    it('un fallo en una no detiene a las demás y se cuenta', async () => {
      const cerrarSesionDeVentaCerrada = jest.fn().mockRejectedValueOnce(new Error('base caída')).mockResolvedValueOnce(true)
      const r = await job({
        findCandidates: jest.fn().mockResolvedValue([]),
        findSesionesDeVentasCerradas: jest.fn().mockResolvedValue([
          { venueId: 'v1', orderId: 'x' },
          { venueId: 'v1', orderId: 'y' },
        ]),
        cerrarSesionDeVentaCerrada,
      }).runNow()

      expect(r).toMatchObject({ sessionsClosed: 1, failed: 1 })
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reservas'), expect.objectContaining({ orderId: 'x' }))
    })

    it('el modo simulación no cierra nada', async () => {
      const findSesionesDeVentasCerradas = jest.fn().mockResolvedValue([{ venueId: 'v1', orderId: 'vieja' }])
      await job({ findSesionesDeVentasCerradas }).runNow({ dryRun: true })

      expect(findSesionesDeVentasCerradas).not.toHaveBeenCalled()
    })

    it('🔴 la selección es UNA consulta acotada: ventas PAID con vale SALE y su sesión sin cerrar ni intento vivo; tope, orden estable y ventana', async () => {
      prismaMock.$queryRaw.mockResolvedValue([])
      await defaults.findSesionesDeVentasCerradas({ limit: 25, since: AHORA })

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
      const sql = Array.from(prismaMock.$queryRaw.mock.calls[0][0] as unknown as string[]).join('?')
      expect(sql).toContain(`s.status IN ('MATERIALIZED', 'PARTIALLY_PAID')`)
      expect(sql).toContain('s."activePaymentAttemptId" IS NULL')
      expect(sql).toContain(`o."paymentStatus" = 'PAID'`)
      expect(sql).toMatch(/EXISTS \(\s*SELECT 1 FROM "InventoryPosting" ip/)
      expect(sql).toContain('ORDER BY s."createdAt" ASC, s.id ASC')
      expect(sql).toContain('LIMIT ?')
    })
  })
})
