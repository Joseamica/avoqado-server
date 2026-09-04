/**
 * Fase 2 del «turno de caja del negocio»: el reembolso de la TPV se ata al turno abierto
 * del NEGOCIO, nunca al que manda la terminal.
 *
 * La Fase 1 movió los 8 sitios que atan dinero al helper `turnoAbiertoDelNegocio`, pero
 * este camino quedaba ANULADO: `recordRefund` leía `refundData.shiftId` y sólo caía al
 * helper cuando venía vacío. Y venía lleno — medido el 3-sep-2026:
 *
 *   1. la ruta valida con `recordFastPaymentParamsSchema`, que declara **sólo `params`**;
 *      `validateRequest` no parsea ni reemplaza el body cuando el esquema no trae `body`,
 *      así que `req.body.shiftId` llega crudo al controlador;
 *   2. el DTO de la PAX DECLARA el campo (`RefundRequest.kt` → `RefundRecorder.kt:265`,
 *      `shiftId = context.shiftId`).
 *
 * ⚠️ CORRECCIÓN MEDIDA (3-sep-2026): el punto 2 se escribió como «la PAX lo manda de verdad» y
 * eso es FALSO. `context.shiftId` vale `null` en los dos constructores de producción
 * (`PaymentScreen.kt:566` en Blumon, `RecordAngelPayRefundUseCase.kt:598` en AngelPay) y Gson
 * —`GsonConverterFactory.create()`, sin `serializeNulls()`— omite los nulos, así que la llave
 * ni siquiera viaja. El hueco que se cerró era REAL en el código del servidor; lo que no era
 * real es que hubiera un turno del cliente ganando en la calle.
 *
 * Estas pruebas siguen valiendo, y valen MÁS así: fijan que mande el SERVIDOR aunque algún día
 * un cliente empiece a mandar un turno. Lo que no se puede seguir afirmando es que hoy exista
 * un `shiftId` del cliente que rescatar (p. ej. para un reembolso «tardío»: tampoco los hay,
 * los reembolsos no tienen cola durable y `RefundRecorder` corta a los 25 s).
 *
 * Resultado: en el camino Blumon normal el reembolso caía en el turno que cree la
 * TERMINAL. Y el decremento de `totalSales` iba por id solo —sin `venueId` ni `status`—,
 * así que aceptaba un turno de otro negocio y uno ya CERRADO, moviendo un conteo firmado
 * sin dejar rastro.
 *
 * El andamiaje de mocks se copia de `refund.cashDrawer.test.ts` (mismo servicio bajo
 * prueba), más los mocks de `shift` que esta prueba necesita.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashRefundToDrawer: jest.fn().mockResolvedValue('POSTED'),
}))
jest.mock('@/services/dashboard/inventoryRestock.service', () => ({ restockOrderItems: jest.fn().mockResolvedValue({}) }))
jest.mock('@/services/payments/transactionCost.service', () => ({ createRefundTransactionCost: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  createRefundCommission: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn().mockRejectedValue(new Error('sin recibo')),
}))
jest.mock('@/services/wallet/stampLedger.service', () => ({ reverseStampForOrder: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderRefunded: jest.fn().mockResolvedValue(null) }))

import * as refundService from '@/services/tpv/refund.tpv.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { restockOrderItems } from '@/services/dashboard/inventoryRestock.service'
import { postCashRefundToDrawer } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

/** El pago original que se va a reembolsar, y todos los mocks que el camino necesita. */
function armar() {
  const original = {
    id: 'pay-orig',
    venueId: VENUE,
    orderId: null,
    order: null,
    method: 'CASH',
    fundsFlow: 'CASH_DRAWER',
    amount: 300,
    tipAmount: 0,
    status: 'COMPLETED',
    type: 'REGULAR',
    processorData: {},
    source: 'TPV',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    tenderRevision: null,
    tenderLabel: null,
    tenderCountsAsCash: null,
    tenderCaptureTip: null,
    tenderSatFormaPago: null,
    processedById: 'staff-1',
    processor: 'blumon',
  }
  ;(prismaMock as any).payment = {
    findUnique: jest.fn().mockResolvedValue(original),
    findFirst: jest.fn().mockResolvedValue(original),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund', ...a.data })),
    update: jest.fn().mockResolvedValue(original),
  }
  ;(prismaMock as any).shift = {
    findFirst: jest.fn().mockResolvedValue({ id: 'shift-negocio', status: 'OPEN' }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  ;(prismaMock as any).activityLog = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
  }
  ;(prismaMock as any).venueTransaction = { create: jest.fn().mockResolvedValue({}) }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([original])
  return original
}

/**
 * El cuerpo que la PAX manda de verdad. `shiftId` va incluido a propósito: es
 * EXACTAMENTE lo que esta prueba tiene que ver ignorado. El `as never` es porque el
 * campo ya no existe en `RefundRequestData` — la terminal lo sigue mandando y el
 * servidor lo descarta, que es el contrato que no se rompe.
 */
const cuerpo = (extra: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  originalPaymentId: 'pay-orig',
  amount: 20000, // centavos
  reason: 'cliente',
  staffId: 'staff-1',
  authorizationNumber: '123456',
  referenceNumber: 'ref-1',
  isPartialRefund: true,
  currency: 'MXN',
  ...extra,
})

const datosDelPagoCreado = () => (prismaMock as any).payment.create.mock.calls[0][0].data
const decremento = () => (prismaMock as any).shift.updateMany.mock.calls[0]?.[0] ?? (prismaMock as any).shift.update.mock.calls[0]?.[0]

beforeEach(() => jest.clearAllMocks())

describe('fase 2 — el reembolso se ata al turno del NEGOCIO, no al que manda la terminal', () => {
  it('acota la lectura inicial al paymentId y venue sin observar pagos de otro negocio', async () => {
    armar()

    await refundService.recordRefund(VENUE, cuerpo() as never, 'staff-autenticado')

    expect((prismaMock as any).payment.findFirst).toHaveBeenCalledWith({
      where: { id: 'pay-orig', venueId: VENUE },
      include: { order: true, receipts: true },
    })
  })

  it('si la reasignación gana antes del lock aborta sin refund/Shift/audit monetario y deja señal para el venue solicitante', async () => {
    const original = armar()
    Object.assign(original, { orderId: 'order-a', order: null })

    const paymentCreate = jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'refund-cross-tenant', ...data }))
    const paymentUpdate = jest.fn().mockResolvedValue(original)
    const shiftFindFirst = jest.fn().mockResolvedValue({ id: 'shift-a', status: 'OPEN' })
    const shiftUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
    const transactionAuditCreate = jest.fn().mockResolvedValue({ id: 'audit-monetary-a' })
    const orderAndPaymentLocks = jest
      .fn()
      // El job ya movió Order + Payment a B antes de que esta tx tomara el primer lock.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...original,
          venueId: 'venue-b',
          orderId: 'order-b',
        },
      ])
    ;(prismaMock as any).activityLog.findFirst.mockResolvedValue({ id: 'marker-a-b' })
    ;(prismaMock as any).$transaction.mockImplementationOnce(async (callback: any) =>
      callback({
        ...(prismaMock as any),
        $queryRaw: orderAndPaymentLocks,
        payment: {
          findMany: jest.fn().mockResolvedValue([]),
          create: paymentCreate,
          update: paymentUpdate,
        },
        shift: { findFirst: shiftFindFirst, updateMany: shiftUpdateMany },
        activityLog: { create: transactionAuditCreate },
        venueTransaction: { create: jest.fn().mockResolvedValue({}) },
      }),
    )

    await expect(refundService.recordRefund(VENUE, cuerpo() as never, 'staff-autenticado')).rejects.toMatchObject({
      statusCode: 409,
      code: 'REFUND_AUTHORITY_CHANGED',
    })

    expect(orderAndPaymentLocks).toHaveBeenCalledTimes(1)
    expect(paymentCreate).not.toHaveBeenCalled()
    expect(paymentUpdate).not.toHaveBeenCalled()
    expect(shiftFindFirst).not.toHaveBeenCalled()
    expect(shiftUpdateMany).not.toHaveBeenCalled()
    expect(transactionAuditCreate).not.toHaveBeenCalled()
    expect((prismaMock as any).activityLog.findFirst).toHaveBeenCalledWith({
      where: {
        action: 'ORDER_VENUE_REASSIGNED',
        entity: 'Order',
        entityId: 'order-a',
        venueId: VENUE,
        createdAt: { gte: expect.any(Date) },
        data: { path: ['fromVenueId'], equals: VENUE },
      },
      select: { id: true },
    })
    expect((prismaMock as any).activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'REFUND_AUTHORITY_CHANGED',
        entity: 'Payment',
        entityId: 'pay-orig',
        staffId: 'staff-autenticado',
        venueId: VENUE,
        data: expect.objectContaining({
          status: 'PENDING',
          reason: 'TENANT_AUTHORITY_CHANGED',
          channel: 'recordRefund',
          originalPaymentId: 'pay-orig',
          expectedOrderId: 'order-a',
        }),
      }),
    })
  })

  it.each([
    ['la Order desapareció', [[]]],
    ['el Payment cambió de relación', [[{ id: 'order-a' }], []]],
  ])('%s: devuelve conflicto genérico y no fabrica una señal de reasignación', async (_case, rawResults) => {
    const original = armar()
    Object.assign(original, { orderId: 'order-a', order: null })
    const queryRaw = jest.fn()
    for (const rows of rawResults) queryRaw.mockResolvedValueOnce(rows)
    ;(prismaMock as any).$transaction.mockImplementationOnce(async (callback: any) =>
      callback({
        ...(prismaMock as any),
        $queryRaw: queryRaw,
        payment: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          update: jest.fn(),
        },
      }),
    )

    await expect(refundService.recordRefund(VENUE, cuerpo() as never, 'staff-autenticado')).rejects.toMatchObject({
      statusCode: 409,
      code: 'REFUND_AUTHORITY_UNAVAILABLE',
    })

    expect((prismaMock as any).activityLog.findFirst).toHaveBeenCalledTimes(1)
    expect((prismaMock as any).activityLog.create).not.toHaveBeenCalled()
  })

  it('usa sólo la fila Payment bloqueada para semántica, merchant y snapshot post-commit', async () => {
    const outer = armar()
    Object.assign(outer, {
      method: 'CASH',
      fundsFlow: 'CASH_DRAWER',
      merchantAccountId: 'merchant-outer-stale',
      terminalId: 'terminal-outer-stale',
    })
    const locked = {
      ...outer,
      method: 'CREDIT_CARD',
      fundsFlow: 'PROCESSOR',
      source: 'APP',
      merchantAccountId: 'merchant-locked',
      terminalId: 'terminal-locked',
      tenderTypeId: 'tender-locked',
      tenderRevision: 7,
      tenderLabel: 'Tarjeta segura',
      tenderCountsAsCash: false,
      tenderCaptureTip: true,
      tenderSatFormaPago: '04',
      processedById: 'staff-original-locked',
      processor: 'angelpay',
    }
    ;(prismaMock as any).$queryRaw.mockResolvedValue([locked])

    await refundService.recordRefund(
      VENUE,
      cuerpo({ merchantAccountId: 'merchant-hostil-de-otro-tenant', tpvId: 'terminal-hostil' }) as never,
      'staff-autenticado',
    )

    const lockedPaymentQuery = (prismaMock as any).$queryRaw.mock.calls[0][0]
    const lockedPaymentSql = String(lockedPaymentQuery.sql).replace(/\s+/g, ' ')
    for (const column of [
      '"method"',
      '"source"',
      '"fundsFlow"',
      '"merchantAccountId"',
      '"terminalId"',
      '"processedById"',
      '"tenderTypeId"',
      '"tenderCountsAsCash"',
    ]) {
      expect(lockedPaymentSql).toContain(column)
    }
    expect(datosDelPagoCreado()).toMatchObject({
      method: 'CREDIT_CARD',
      fundsFlow: 'PROCESSOR',
      source: 'APP',
      merchantAccountId: 'merchant-locked',
      terminalId: 'terminal-locked',
      tenderTypeId: 'tender-locked',
      tenderRevision: 7,
      tenderLabel: 'Tarjeta segura',
      tenderCountsAsCash: false,
      tenderCaptureTip: true,
      tenderSatFormaPago: '04',
    })
    expect(postCashRefundToDrawer).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'CREDIT_CARD',
        fundsFlow: 'PROCESSOR',
        tenderTypeId: 'tender-locked',
        tenderCountsAsCash: false,
      }),
    )
  })

  it('el actor autenticado gobierna Payment, historial, cajón, audit y restock aunque el body mande otro staffId', async () => {
    const original = armar()
    Object.assign(original, {
      orderId: 'order-1',
      order: { id: 'order-1', total: 200, tipAmount: 0 },
    })
    ;(prismaMock as any).$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]).mockResolvedValueOnce([original])
    ;(prismaMock as any).payment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ amount: -200 }])

    await refundService.recordRefund(VENUE, cuerpo({ staffId: 'staff-hostil' }) as never, 'staff-autenticado')

    expect(datosDelPagoCreado().processedById).toBe('staff-autenticado')
    expect((prismaMock as any).payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          processorData: expect.objectContaining({
            refundHistory: [expect.objectContaining({ staffId: 'staff-autenticado' })],
          }),
        },
      }),
    )
    expect(postCashRefundToDrawer).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'staff-autenticado' }))
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'REFUND_CREATED', staffId: 'staff-autenticado' }))
    expect(restockOrderItems).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'staff-autenticado' }))
  })

  it('🔴 ignora el shiftId del cuerpo y resuelve el turno abierto del negocio', async () => {
    armar()

    await refundService.recordRefund(VENUE, cuerpo({ shiftId: 'shift-de-otro-lado' }) as never)

    expect(datosDelPagoCreado().shiftId).toBe('shift-negocio')
    // …y el turno se resolvió por NEGOCIO, nunca por persona ni por el cuerpo.
    for (const call of (prismaMock as any).shift.findFirst.mock.calls) {
      expect(call[0].where).toEqual({ venueId: VENUE, endTime: null })
    }
    expect((prismaMock as any).activityLog.create).not.toHaveBeenCalled()
  })

  it('🔴 el decremento de totalSales sólo toca un turno ABIERTO del MISMO venue', async () => {
    armar()

    await refundService.recordRefund(VENUE, cuerpo({ shiftId: 'shift-de-otro-lado' }) as never)

    const upd = decremento()
    expect(upd).toBeDefined()
    expect(upd.where).toMatchObject({ id: 'shift-negocio', venueId: VENUE, status: 'OPEN' })
  })

  // ─── Regresión: lo que NO se puede romper ───────────────────────────────────

  it('🔴 si el turno cerró entre la lectura y el claim, el pago NO se sella con ese turno', async () => {
    armar()
    // El turno existía al leerlo y ya no estaba OPEN al reclamarlo: `count: 0`.
    ;(prismaMock as any).shift.updateMany.mockResolvedValue({ count: 0 })

    await expect(refundService.recordRefund(VENUE, cuerpo() as never)).resolves.toMatchObject({ id: 'pay-refund' })

    // 1) El dinero ya salió de la caja física: que el turno se moviera no tumba el registro.
    expect((prismaMock as any).payment.create).toHaveBeenCalledTimes(1)
    // 2) 🔴 Y —la aserción que faltaba en la primera versión— el `Payment` NO queda apuntando
    //    a ese turno. Sellarlo dejaría un REFUND colgando de un turno CERRADO al que nunca se
    //    le restó: el cierre selecciona estrictamente por `shiftId`, así que un recálculo
    //    desde los pagos discreparía de su propio `totalSales` por el monto del reembolso.
    //    Con `shiftId` nulo el reembolso queda fuera del corte firmado y la conciliación
    //    explica el claim perdido sin reatribuirlo silenciosamente.
    expect(datosDelPagoCreado().shiftId).toBeUndefined()
  })

  it('CLOSING: atribuye la conciliación al actor autenticado, no al staffId controlado por el body', async () => {
    armar()
    ;(prismaMock as any).shift.findFirst.mockResolvedValue({ id: 'shift-closing', status: 'CLOSING' })

    await refundService.recordRefund(VENUE, cuerpo({ staffId: 'staff-del-body' }) as never, 'staff-autenticado')

    expect((prismaMock as any).shift.updateMany).not.toHaveBeenCalled()
    expect(datosDelPagoCreado().shiftId).toBeUndefined()
    expect((prismaMock as any).activityLog.create).toHaveBeenCalledTimes(1)
    expect((prismaMock as any).activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Payment',
        entityId: 'pay-refund',
        staffId: 'staff-autenticado',
        venueId: VENUE,
        data: {
          status: 'PENDING',
          reason: 'SHIFT_NOT_OPEN',
          candidateShiftId: 'shift-closing',
          observedShiftStatus: 'CLOSING',
          paymentId: 'pay-refund',
          orderId: null,
          channel: 'recordRefund',
          amountPesos: '-200.00',
          tipPesos: '0.00',
          totalPesos: '-200.00',
        },
      },
    })
    expect((prismaMock as any).payment.create.mock.invocationCallOrder[0]).toBeLessThan(
      (prismaMock as any).activityLog.create.mock.invocationCallOrder[0],
    )
  })

  it('claim perdido: deja conciliación con el candidato OPEN y no sella el turno', async () => {
    armar()
    ;(prismaMock as any).shift.updateMany.mockResolvedValue({ count: 0 })

    await refundService.recordRefund(VENUE, cuerpo() as never)

    expect(datosDelPagoCreado().shiftId).toBeUndefined()
    expect((prismaMock as any).activityLog.create).toHaveBeenCalledTimes(1)
    expect((prismaMock as any).activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityId: 'pay-refund',
          data: expect.objectContaining({
            reason: 'CLAIM_LOST',
            candidateShiftId: 'shift-negocio',
            observedShiftStatus: 'OPEN',
            channel: 'recordRefund',
          }),
        }),
      }),
    )
  })

  it('rollback stateful CLOSING: un fallo posterior revierte refund y audit sin escribir fuera del tx', async () => {
    const original = armar()
    const committed = { payments: [] as any[], audits: [] as any[] }
    let stagedAntesDelFallo: typeof committed | null = null

    ;(prismaMock as any).$transaction.mockImplementationOnce(async (callback: any) => {
      const staged = { payments: [...committed.payments], audits: [...committed.audits] }
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: original.id,
            venueId: original.venueId,
            orderId: original.orderId,
            status: original.status,
            type: original.type,
            amount: original.amount,
            tipAmount: original.tipAmount,
            processorData: original.processorData,
          },
        ]),
        shift: {
          findFirst: jest.fn().mockResolvedValue({ id: 'shift-closing', status: 'CLOSING' }),
          updateMany: jest.fn(),
        },
        payment: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            const row = { id: 'refund-staged', ...data }
            staged.payments.push(row)
            return row
          }),
          update: jest.fn().mockImplementation(async () => {
            stagedAntesDelFallo = { payments: [...staged.payments], audits: [...staged.audits] }
            throw new Error('fallo posterior al audit TPV')
          }),
        },
        activityLog: {
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            staged.audits.push(data)
            return { id: 'audit-staged' }
          }),
        },
        venueSettings: { findUnique: jest.fn().mockResolvedValue({ enableShifts: true }) },
        venueTransaction: { create: jest.fn() },
      }

      const result = await callback(tx)
      Object.assign(committed, staged)
      return result
    })

    await expect(refundService.recordRefund(VENUE, cuerpo() as never)).rejects.toThrow('fallo posterior al audit TPV')

    expect(stagedAntesDelFallo).toEqual({ payments: [expect.any(Object)], audits: [expect.any(Object)] })
    expect(committed).toEqual({ payments: [], audits: [] })
    expect((prismaMock as any).activityLog.create).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
    expect(postCashRefundToDrawer).not.toHaveBeenCalled()
  })

  it('sin turno abierto el reembolso se registra sin turno, no decrementa y deja señal común', async () => {
    armar()
    ;(prismaMock as any).shift.findFirst.mockResolvedValue(null)

    await refundService.recordRefund(VENUE, cuerpo({ shiftId: 'shift-de-otro-lado' }) as never)

    expect(datosDelPagoCreado().shiftId).toBeUndefined()
    expect((prismaMock as any).shift.updateMany).not.toHaveBeenCalled()
    expect((prismaMock as any).shift.update).not.toHaveBeenCalled()
    expect((prismaMock as any).activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'PAYMENT_WITHOUT_SHIFT',
          data: expect.objectContaining({ reason: 'NO_SHIFT', channel: 'recordRefund' }),
        }),
      }),
    )
  })
})
