/**
 * Task 5r — el riel de la TERMINAL lee y escribe el MISMO número que el del dashboard.
 *
 * `processorData.refundedAmount` es «cuánto se ha devuelto ya de este cobro», y la definición
 * única vive en `shared/devueltoDeUnCobro.ts`: **venta + propina**. Este archivo fija las tres
 * cosas que el riel de la terminal tenía distintas:
 *
 *   1. leía sólo `refundedAmount` (pesos) e ignoraba `refundedAmountCents`, el entero exacto
 *      que los dos rieles ya escribían;
 *   2. `isFullyRefunded` se comparaba contra `locked.amount` —la VENTA sola— mientras el
 *      consumidor que de verdad se lee (`payment.tpv.service.ts:1439`) lo recalcula contra
 *      `amount + tipAmount`. Con propina, el dato persistido y el servido se contradecían;
 *   3. un acumulado ilegible valía 0 en silencio y dejaba pasar cualquier reembolso.
 *
 * 🔴 El cobro de este archivo lleva PROPINA a propósito: con `tipAmount = 0` las dos
 * semánticas coinciden y todo pasaría con el defecto vivo.
 *
 * El andamiaje de mocks se copia de `refund.acumuladoBajoCandado.test.ts` (mismo servicio).
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

/** Cobro de $100 de venta + $20 de propina = $120 que el cliente entregó. */
function armar(processorData: Record<string, unknown>) {
  const pago = {
    id: 'pay-orig',
    venueId: VENUE,
    orderId: null,
    order: null,
    method: 'CREDIT_CARD',
    fundsFlow: 'AVOQADO_PROCESSED',
    amount: 100,
    tipAmount: 20,
    status: 'COMPLETED',
    type: 'REGULAR',
    source: 'TPV',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    processedById: 'staff-1',
    processorData,
  }

  ;(prismaMock as any).payment = {
    findUnique: jest.fn().mockResolvedValue(pago),
    findFirst: jest.fn().mockResolvedValue(pago),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund-nuevo', ...a.data })),
    update: jest.fn().mockResolvedValue(pago),
  }
  ;(prismaMock as any).shift = {
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  }
  ;(prismaMock as any).venueTransaction = { create: jest.fn().mockResolvedValue({}) }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  // El ÚNICO `$queryRaw` de este camino sigue siendo el `SELECT … FOR UPDATE` del cobro.
  ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([pago])

  return pago
}

/**
 * Las DOS fotos del mismo cobro, como en `refund.acumuladoBajoCandado.test.ts`: `findUnique`
 * (fuera de la transacción, el PRE-VUELO) devuelve una y el `SELECT … FOR UPDATE` otra.
 *
 * 🔴 Es lo ÚNICO que prueba el camino BAJO EL CANDADO. Con una sola foto, el pre-vuelo del
 * STEP 2 rechaza primero y la prueba pasa aunque la lectura del candado esté rota — se
 * comprobó rompiéndola a propósito: 7 de 7 en verde con el defecto vivo.
 */
function armarDosFotos(pdVieja: Record<string, unknown>, pdBloqueada: Record<string, unknown>) {
  const base = {
    id: 'pay-orig',
    venueId: VENUE,
    orderId: null,
    order: null,
    method: 'CREDIT_CARD',
    fundsFlow: 'AVOQADO_PROCESSED',
    amount: 100,
    tipAmount: 20,
    status: 'COMPLETED',
    type: 'REGULAR',
    source: 'TPV',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    processedById: 'staff-1',
  }
  const fotoVieja = { ...base, processorData: pdVieja }
  const fotoBloqueada = { ...base, processorData: pdBloqueada }

  ;(prismaMock as any).payment = {
    findUnique: jest.fn().mockResolvedValue(fotoVieja),
    findFirst: jest.fn().mockResolvedValue(fotoVieja),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund-nuevo', ...a.data })),
    update: jest.fn().mockResolvedValue(fotoBloqueada),
  }
  ;(prismaMock as any).shift = {
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  }
  ;(prismaMock as any).venueTransaction = { create: jest.fn().mockResolvedValue({}) }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([fotoBloqueada])
}

const cuerpo = (centavos: number) => ({
  venueId: VENUE,
  originalPaymentId: 'pay-orig',
  amount: centavos,
  reason: 'devolución',
  staffId: 'staff-1',
  authorizationNumber: '123456',
  referenceNumber: `ref-${centavos}`,
  isPartialRefund: true,
  currency: 'MXN',
})

/** Lo que se persistió sobre el cobro ORIGINAL. */
const escrito = () => (prismaMock as any).payment.update.mock.calls[0][0].data.processorData as Record<string, any>

beforeEach(() => jest.clearAllMocks())

describe('Task 5r — la terminal usa la misma definición de «lo ya devuelto»', () => {
  it('🔴 lee el ACUMULADO EN CENTAVOS que el dashboard escribió, no sólo los pesos', async () => {
    // Es exactamente lo que el riel del dashboard persiste tras devolver los $120 completos.
    // Con la lectura vieja (`Number(processorData.refundedAmount ?? 0)`) una fila que sólo
    // trae los centavos se leía como 0 y la terminal volvía a ofrecer el cobro entero.
    armar({ refundedAmountCents: 12000 })

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never)).rejects.toThrow(/exceeds remaining refundable/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    // 🔴 Y lo rechaza el PRE-VUELO, antes de abrir la transacción. Sin esta línea la prueba
    // pasaría también con el pre-vuelo roto (lo atraparía el candado) y no guardaría nada de
    // él — comprobado rompiéndolo a propósito.
    expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
  })

  it('🔴 `isFullyRefunded` se decide contra el TOTAL (venta + propina), no contra la venta sola', async () => {
    armar({})

    // Devolver los $100 de venta de un cobro de $120 NO es devolverlo completo: quedan los
    // $20 de propina. Con la comparación vieja (`>= locked.amount`) esto se persistía como
    // `true` mientras el historial de la terminal —que recalcula contra el total— seguía
    // diciendo `false`: el mismo cobro, dos respuestas.
    await refundService.recordRefund(VENUE, cuerpo(10000) as never)

    const pd = escrito()
    expect(pd.refundedAmount).toBe(100)
    expect(pd.refundedAmountCents).toBe(10000)
    expect(pd.isFullyRefunded).toBe(false)
  })

  it('devolver los $120 completos SÍ marca el cobro como totalmente reembolsado', async () => {
    armar({})

    await refundService.recordRefund(VENUE, cuerpo(12000) as never)

    const pd = escrito()
    expect(pd.refundedAmount).toBe(120)
    expect(pd.refundedAmountCents).toBe(12000)
    expect(pd.isFullyRefunded).toBe(true)
  })

  it('🔴 un acumulado ILEGIBLE corta el reembolso en vez de valer 0', async () => {
    // `Number('vaya')` es NaN y `refundAmountInPesos > NaN` es **false**: un acumulado
    // corrupto dejaba pasar TODOS los reembolsos, sin un solo aviso.
    armar({ refundedAmount: 'vaya' })

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never)).rejects.toThrow(/no es un número/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })

  it('acumula en CENTAVOS enteros: dos parciales de $40.33 no arrastran flotantes', async () => {
    armar({ refundedAmount: 40.33, refundedAmountCents: 4033 })

    await refundService.recordRefund(VENUE, cuerpo(4033) as never)

    const pd = escrito()
    expect(pd.refundedAmountCents).toBe(8066)
    expect(pd.refundedAmount).toBe(80.66)
  })

  it('🔴 BAJO EL CANDADO también lee los centavos: el pre-vuelo ve 0 y aun así rechaza', async () => {
    // El pre-vuelo (fuera de la transacción) no ve reembolsos; el candado sí ve los $120 que
    // otro escritor dejó. Sólo la lectura del candado puede rechazar aquí — y es justo la que
    // se saltaba `refundedAmountCents`.
    armarDosFotos({}, { refundedAmountCents: 12000 })

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never)).rejects.toThrow(/exceeds remaining refundable/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })

  it('🔴 BAJO EL CANDADO, un acumulado corto en PESOS no borra los centavos del candado', async () => {
    // Foto vieja con el acumulado de la regla vieja (110, sin la propina de un reembolso
    // previo); bajo el candado ya están los 12000 correctos. Gana el candado.
    armarDosFotos({ refundedAmount: 110, refundedAmountCents: 11000 }, { refundedAmount: 120, refundedAmountCents: 12000 })

    await expect(refundService.recordRefund(VENUE, cuerpo(500) as never)).rejects.toThrow(/exceeds remaining refundable/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })

  // ─── Regresión: el camino de todos los días no cambia ────────────────────────────────

  it('un cobro sin reembolsos previos se comporta igual que siempre', async () => {
    armar({})

    await refundService.recordRefund(VENUE, cuerpo(4000) as never)

    const pd = escrito()
    expect(pd.refundedAmount).toBe(40)
    expect(pd.refundedAmountCents).toBe(4000)
    expect(pd.isFullyRefunded).toBe(false)
    expect(pd.refundHistory).toHaveLength(1)
    expect(pd.refunds).toHaveLength(1)
  })
})

/**
 * ── EL CRUCE DE LOS DOS RIELES ────────────────────────────────────────────────────────────
 *
 * La fuga que originó la tarea no ocurría dentro de un riel sino ENTRE los dos: el dashboard
 * persistía un acumulado corto y la terminal lo leía como autoridad. Esta prueba toma el
 * objeto EXACTO que `refund.dashboard.service` deja escrito y se lo da a `recordRefund`.
 *
 * 🔴 No se fabrica ese objeto a mano: se ejecuta el riel del dashboard de verdad. Escribirlo a
 * mano probaría lo que yo creo que escribe, no lo que escribe.
 */
describe('Task 5r — lo que el dashboard escribe es lo que la terminal lee', () => {
  it('🔴 tras dos reembolsos de $60 por el dashboard, la terminal ya no deja sacar ni $10', async () => {
    // 1) El dashboard devuelve $60 sobre un cobro de $100 + $20, con otros $60 ya devueltos.
    const { issueRefund } = await import('@/services/dashboard/refund.dashboard.service')

    const cobro = {
      id: 'pay-orig',
      venueId: VENUE,
      status: 'COMPLETED',
      type: 'REGULAR',
      method: 'CREDIT_CARD',
      source: 'APP',
      amount: 100,
      tipAmount: 20,
      orderId: 'order-1',
      shiftId: null,
      merchantAccountId: null,
      processorData: {},
      fundsFlow: null,
      tenderTypeId: null,
      tenderCountsAsCash: null,
    }
    const reembolsoPrevio = {
      id: 'refund-A',
      amount: -50,
      tipAmount: -10,
      createdAt: new Date('2026-09-03T10:00:00.000Z'),
      status: 'COMPLETED',
      processorData: { originalPaymentId: 'pay-orig' },
    }

    ;(prismaMock as any).payment = {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'refund-B' }),
      update: jest.fn().mockResolvedValue({ id: 'pay-orig' }),
    }
    ;(prismaMock as any).shift = { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    ;(prismaMock as any).venueTransaction = { create: jest.fn().mockResolvedValue({}) }
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn(), update: jest.fn() }
    ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn() }
    ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
    ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValueOnce([cobro]).mockResolvedValueOnce([reembolsoPrevio])

    await issueRefund({ venueId: VENUE, paymentId: 'pay-orig', amount: 6000, reason: 'RETURNED_GOODS', staffId: 'staff-9' })

    const persistido = (prismaMock as any).payment.update.mock.calls[0][0].data.processorData as Record<string, unknown>
    expect(persistido.refundedAmountCents).toBe(12000)

    // 2) La terminal recibe ESE processorData y pide $10 más. Con el acumulado corto de antes
    //    (110) veía $10 disponibles y los dejaba salir: $130 sobre un cobro de $120.
    jest.clearAllMocks()
    armar(persistido)

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never)).rejects.toThrow(/exceeds remaining refundable/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })
})
