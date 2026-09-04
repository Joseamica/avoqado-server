import { Decimal } from '@prisma/client/runtime/library'
import { createRefund } from '@/services/mobile/refund.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

const VENUE = 'venue-1'
const STAFF = 'staff-1'

/**
 * 🔴 El reembolso móvil tiene que quedar guardado con la MISMA convención que el del
 * TPV y el del dashboard (`refund.tpv.service.ts:276`, `refund.dashboard.service.ts:403`):
 * monto NEGATIVO + `status: COMPLETED` + `type: REFUND`.
 *
 * Guardarlo como `status: REFUNDED` lo volvía INVISIBLE para el cierre de turno y el
 * cierre de caja, que consultan `status: 'COMPLETED'` (`shift.tpv.service.ts:1342`,
 * `cashCloseout.dashboard.service.ts:74`). El dinero SÍ salía del cajón —se crea un
 * `PAY_OUT`— pero el efectivo esperado no bajaba, así que el conteo acusaba un
 * FALTANTE del tamaño del reembolso. Le echaba la culpa al cajero.
 *
 * Y con `type: REGULAR` tampoco aparecía en el reporte de reembolsos, que exige
 * `type: 'REFUND'` (`refunds.dashboard.service.ts:87`).
 */
describe('createRefund (móvil) — convención canónica de reembolso', () => {
  let createdPayment: any

  beforeEach(() => {
    jest.clearAllMocks()
    createdPayment = undefined
    // El prismaMock compartido (tests/__helpers__/setup.ts) no declara los modelos del
    // cajón. Se agregan AQUÍ y no allá para no tocar un helper que otras sesiones editan.
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn(),
    }
    // Desde la extracción del helper compartido (`services/shared/cashDrawerPosting`),
    // el movimiento entra por `createMany` + `skipDuplicates` en vez de un `create`
    // ciego: mismo movimiento, ahora con llave de idempotencia.
    ;(prismaMock as any).cashDrawerEvent = { create: jest.fn(), createMany: jest.fn().mockResolvedValue({ count: 1 }) }
    prismaMock.order.create.mockResolvedValue({ id: 'order-ref-1', orderNumber: 'REF-1' })
    prismaMock.payment.create.mockImplementation(async (args: any) => {
      createdPayment = args.data
      return { id: 'payment-ref-1', createdAt: new Date('2026-08-13T12:00:00.000Z'), ...args.data }
    })
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
    prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-post-close-1' })
    prismaMock.cashDrawerSession.findFirst.mockResolvedValue(null)
    prismaMock.cashDrawerEvent.create.mockResolvedValue({ id: 'evt-1' })
    prismaMock.staff = { findUnique: jest.fn().mockResolvedValue(null) } as any
  })

  const refundCash = () => createRefund({ venueId: VENUE, amount: 5000, reason: 'Producto defectuoso', method: 'CASH', staffId: STAFF })

  it.each([0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rechaza amount=%p si no es un entero positivo seguro antes de abrir transacción',
    async amount => {
      await expect(createRefund({ venueId: VENUE, amount, reason: 'x', method: 'CASH', staffId: STAFF })).rejects.toThrow(
        /amount.*entero seguro.*centavos/i,
      )

      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    },
  )

  it('guarda el reembolso como COMPLETED + REFUND para que los cortes lo vean', async () => {
    await refundCash()

    expect(createdPayment.status).toBe('COMPLETED')
    expect(createdPayment.type).toBe('REFUND')
  })

  it('el monto es NEGATIVO, para que reste del efectivo esperado', async () => {
    await refundCash()

    expect(Number(createdPayment.amount)).toBe(-50)
    expect(Number(createdPayment.netAmount)).toBe(-50)
  })

  it('conserva el método real del reembolso (una devolución en terminal no es salida de efectivo)', async () => {
    await createRefund({ venueId: VENUE, amount: 5000, reason: 'x', method: 'CREDIT_CARD', staffId: STAFF })

    expect(createdPayment.method).toBe('CREDIT_CARD')
  })

  it('la ORDEN sigue marcándose paymentStatus REFUNDED (regresión: areaTicketV7 lo lee)', async () => {
    await refundCash()

    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'REFUNDED' }) }),
    )
  })

  /**
   * 🔴 Migrado al helper compartido `postCashRefundToDrawer` (2026-08-16) para que
   * exista UN solo lugar que sabe restar del cajón — el otro camino de reembolso
   * (`refund.dashboard.service`, que es el que la app usa de verdad) no restaba y
   * el arqueo inventaba un sobrante del tamaño de lo devuelto.
   *
   * El COMPORTAMIENTO no cambia: mismo PAY_OUT, mismo monto, misma nota, y sólo
   * cuando el dinero salió del cajón. Lo que se gana es la llave de idempotencia.
   */
  describe('cajón de efectivo (helper compartido)', () => {
    const eventoDelCajon = () => (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0]

    it('saca el efectivo del cajón con un PAY_OUT sólo cuando el reembolso fue en efectivo', async () => {
      prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await refundCash()

      expect(eventoDelCajon()).toMatchObject({ type: 'PAY_OUT', sessionId: 'session-1', venueId: VENUE, staffId: STAFF })
      expect(new Decimal(eventoDelCajon().amount).toFixed(2)).toBe('50.00')
    })

    it('conserva la nota "Reembolso: <motivo>" (el corte del POS clasifica por ese prefijo)', async () => {
      prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await refundCash()

      expect(eventoDelCajon().note).toBe('Reembolso: Producto defectuoso')
    })

    it('una devolución hecha en la TERMINAL no toca el cajón', async () => {
      prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await createRefund({ venueId: VENUE, amount: 5000, reason: 'x', method: 'CREDIT_CARD', staffId: STAFF })

      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })

    it('sin caja abierta no se registra movimiento y el reembolso se emite igual', async () => {
      prismaMock.cashDrawerSession.findFirst.mockResolvedValue(null)

      await expect(refundCash()).resolves.toMatchObject({ refundId: 'payment-ref-1' })
      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })

    it('🔴 ahora el movimiento trae llave de idempotencia derivada del reembolso', async () => {
      prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await refundCash()

      expect(eventoDelCajon().localId).toBe('srv-refund:payment-ref-1')
      expect((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].skipDuplicates).toBe(true)
    })
  })

  // 🔴 Regresión del audit 2026-08-13: la convención COMPLETED+REFUND arreglaba
  // el cierre de CAJA (filtra por ventana de tiempo), pero el cierre de TURNO
  // selecciona por `{ shiftId, status: 'COMPLETED' }` — sin shiftId el reembolso
  // seguía invisible y el faltante se le achacaba al cajero.
  describe('shiftId — visible para el cierre de turno', () => {
    it('estampa el turno ABIERTO del NEGOCIO en el Payment y decrementa totalSales (claim condicional)', async () => {
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-1', status: 'OPEN' } as any)
      prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)

      await refundCash()

      // 🔴 Fase 1 (2-sep-2026): el turno es del NEGOCIO. `staffId` YA NO va en el `where`
      // — filtrarlo sacaba de todo turno a quien no había abierto uno. Igualdad EXACTA,
      // no `objectContaining`: con él, volver a colar `staffId` seguiría pasando.
      expect(prismaMock.shift.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: VENUE, endTime: null } }))
      expect(createdPayment.shiftId).toBe('shift-1')
      expect(createdPayment.processorData).toMatchObject({ shiftBackfilled: true })
      expect(createdPayment.processorData.shiftAttributionStatus).toBeUndefined()
      expect(createdPayment.processorData.shiftAttributionPendingReason).toBeUndefined()
      // El claim ES el decremento, condicionado a que el turno SIGA abierto —
      // así el refund nunca se estampa en un turno que cerró en la ventana.
      expect(prismaMock.shift.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // 🔴 `venueId` va en el claim, no sólo `id`: sin él, un `shiftId` que llegara de otro
          // negocio decrementaría SUS ventas. Los tres rieles de reembolso lo llevan igual.
          where: { id: 'shift-1', venueId: VENUE, status: 'OPEN', endTime: null },
          data: { totalSales: { decrement: new Decimal('50.00') } },
        }),
      )
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    })

    it('sin turno abierto, el reembolso se crea sin shiftId y no toca contadores', async () => {
      prismaMock.shift.findFirst.mockResolvedValue(null as any)

      await refundCash()

      expect(createdPayment.shiftId).toBeUndefined()
      expect(createdPayment.processorData).toMatchObject({ shiftBackfilled: false })
      expect(createdPayment.processorData.shiftAttributionStatus).toBeUndefined()
      expect(createdPayment.processorData.shiftAttributionPendingReason).toBeUndefined()
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    })

    it('🔴 si el turno CIERRA entre la lectura y el claim, el refund entra SIN shiftId (nunca en un turno cerrado)', async () => {
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-1', status: 'OPEN' } as any)
      // El updateMany condicional pierde: el turno ya no está OPEN.
      prismaMock.shift.updateMany.mockResolvedValue({ count: 0 } as any)

      await refundCash()

      expect(createdPayment.shiftId).toBeUndefined()
      expect(createdPayment.processorData).toMatchObject({ shiftBackfilled: false })
      expect(createdPayment.processorData.shiftAttributionStatus).toBeUndefined()
      expect(createdPayment.processorData.shiftAttributionPendingReason).toBeUndefined()
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityId: 'payment-ref-1',
            data: expect.objectContaining({
              reason: 'CLAIM_LOST',
              candidateShiftId: 'shift-1',
              observedShiftStatus: 'OPEN',
              channel: 'createRefund',
            }),
          }),
        }),
      )
    })

    it('CLOSING: Order y Payment quedan juntos fuera del turno y audita después del Payment real', async () => {
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-closing', status: 'CLOSING' } as any)

      await refundCash()

      const createdOrder = prismaMock.order.create.mock.calls.at(-1)![0].data
      expect(createdOrder.shiftId ?? null).toBeNull()
      expect(createdPayment.shiftId ?? null).toBeNull()
      expect(createdPayment.processorData).toMatchObject({ shiftBackfilled: false })
      expect(createdPayment.processorData.shiftAttributionStatus).toBeUndefined()
      expect(createdPayment.processorData.shiftAttributionPendingReason).toBeUndefined()
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
        data: {
          action: 'PAYMENT_WITHOUT_SHIFT',
          entity: 'Payment',
          entityId: 'payment-ref-1',
          staffId: STAFF,
          venueId: VENUE,
          data: {
            status: 'PENDING',
            reason: 'SHIFT_NOT_OPEN',
            candidateShiftId: 'shift-closing',
            observedShiftStatus: 'CLOSING',
            paymentId: 'payment-ref-1',
            orderId: 'order-ref-1',
            channel: 'createRefund',
            amountPesos: '-50.00',
            tipPesos: '0.00',
            totalPesos: '-50.00',
          },
        },
      })
      expect(prismaMock.payment.create.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.activityLog.create.mock.invocationCallOrder[0])
    })

    it('sin candidato crea la señal común NO_SHIFT', async () => {
      prismaMock.shift.findFirst.mockResolvedValue(null)

      await refundCash()

      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'PAYMENT_WITHOUT_SHIFT',
            data: expect.objectContaining({ reason: 'NO_SHIFT', channel: 'createRefund' }),
          }),
        }),
      )
    })

    it('si falla algo posterior, revierte juntos el refund y la conciliación de CLOSING', async () => {
      const committed = { orders: [] as any[], payments: [] as any[], audits: [] as any[] }
      let auditAlcanzada = false

      prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
        const staged = { orders: [...committed.orders], payments: [...committed.payments], audits: [...committed.audits] }
        const tx = {
          shift: {
            findFirst: jest.fn().mockResolvedValue({ id: 'shift-closing', status: 'CLOSING' }),
            updateMany: jest.fn(),
          },
          order: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              const row = { id: 'order-staged', orderNumber: 'REF-STAGED', ...data }
              staged.orders.push(row)
              return row
            }),
          },
          payment: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              const row = { id: 'payment-staged', createdAt: new Date('2026-09-03T12:00:00.000Z'), ...data }
              staged.payments.push(row)
              return row
            }),
          },
          activityLog: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              auditAlcanzada = true
              staged.audits.push(data)
              return { id: 'audit-staged' }
            }),
          },
          venueSettings: { findUnique: jest.fn().mockResolvedValue({ enableShifts: true }) },
          venueTransaction: {
            create: jest.fn().mockRejectedValue(new Error('fallo posterior al asiento')),
          },
        }

        const result = await callback(tx)
        committed.orders = staged.orders
        committed.payments = staged.payments
        committed.audits = staged.audits
        return result
      })

      await expect(refundCash()).rejects.toThrow('fallo posterior al asiento')

      expect(auditAlcanzada).toBe(true)
      expect(committed).toEqual({ orders: [], payments: [], audits: [] })
      expect(prismaMock.cashDrawerSession.findFirst).not.toHaveBeenCalled()
    })

    it('si falla después de un claim OPEN, revierte también su decremento', async () => {
      const committed = { totalSales: 300, orders: [] as any[], payments: [] as any[] }

      prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
        const staged = { totalSales: committed.totalSales, orders: [...committed.orders], payments: [...committed.payments] }
        const tx = {
          shift: {
            findFirst: jest.fn().mockResolvedValue({ id: 'shift-open', status: 'OPEN' }),
            updateMany: jest.fn().mockImplementation(async () => {
              staged.totalSales -= 50
              return { count: 1 }
            }),
          },
          order: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              const row = { id: 'order-staged', orderNumber: 'REF-STAGED', ...data }
              staged.orders.push(row)
              return row
            }),
          },
          payment: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              const row = { id: 'payment-staged', createdAt: new Date('2026-09-03T12:00:00.000Z'), ...data }
              staged.payments.push(row)
              return row
            }),
          },
          activityLog: { create: jest.fn() },
          venueTransaction: {
            create: jest.fn().mockRejectedValue(new Error('fallo posterior al claim')),
          },
        }

        const result = await callback(tx)
        committed.totalSales = staged.totalSales
        committed.orders = staged.orders
        committed.payments = staged.payments
        return result
      })

      await expect(refundCash()).rejects.toThrow('fallo posterior al claim')

      expect(committed).toEqual({ totalSales: 300, orders: [], payments: [] })
      expect(prismaMock.cashDrawerSession.findFirst).not.toHaveBeenCalled()
    })
  })
})
