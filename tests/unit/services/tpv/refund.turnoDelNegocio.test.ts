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
    processedById: 'staff-1',
  }
  ;(prismaMock as any).payment = {
    findUnique: jest.fn().mockResolvedValue(original),
    findFirst: jest.fn().mockResolvedValue(original),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund', ...a.data })),
    update: jest.fn().mockResolvedValue(original),
  }
  ;(prismaMock as any).shift = {
    findFirst: jest.fn().mockResolvedValue({ id: 'shift-negocio' }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
  it('🔴 ignora el shiftId del cuerpo y resuelve el turno abierto del negocio', async () => {
    armar()

    await refundService.recordRefund(VENUE, cuerpo({ shiftId: 'shift-de-otro-lado' }) as never)

    expect(datosDelPagoCreado().shiftId).toBe('shift-negocio')
    // …y el turno se resolvió por NEGOCIO, nunca por persona ni por el cuerpo.
    for (const call of (prismaMock as any).shift.findFirst.mock.calls) {
      expect(call[0].where).toEqual({ venueId: VENUE, status: 'OPEN', endTime: null })
    }
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
    //    Con `shiftId` nulo el reembolso queda fuera de todo turno de forma coherente, y
    //    reatribuible después (`scripts/reatribuir-cobros-al-turno.ts`).
    expect(datosDelPagoCreado().shiftId).toBeUndefined()
  })

  it('sin turno abierto el reembolso se registra sin turno y no decrementa ninguno', async () => {
    armar()
    ;(prismaMock as any).shift.findFirst.mockResolvedValue(null)

    await refundService.recordRefund(VENUE, cuerpo({ shiftId: 'shift-de-otro-lado' }) as never)

    expect(datosDelPagoCreado().shiftId).toBeUndefined()
    expect((prismaMock as any).shift.updateMany).not.toHaveBeenCalled()
    expect((prismaMock as any).shift.update).not.toHaveBeenCalled()
  })
})
