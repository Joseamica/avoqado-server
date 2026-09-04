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
function armar(processorData: Record<string, unknown>, filas: Array<Record<string, unknown>> = []) {
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
    findMany: jest.fn().mockResolvedValue(filas),
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
  // El ÚNICO `$queryRaw` de este camino sigue siendo el `SELECT … FOR UPDATE` del cobro:
  // las filas de reembolso se leen con `findMany`, arriba.
  ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([pago])

  return pago
}

/** Un reembolso ya registrado de este cobro, negativo en las dos columnas. */
const filaDeReembolso = (venta: number, propina: number, status = 'COMPLETED') => ({ amount: venta, tipAmount: propina, status })

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
  it('acumulado largo sin filas: conserva el split explícito y fuerza conciliación sin reclamar OPEN', async () => {
    armar({ refundedAmount: 60, refundedAmountCents: 6000 }, [])
    ;(prismaMock as any).shift.findFirst.mockResolvedValue({ id: 'shift-open', status: 'OPEN' })
    ;(prismaMock as any).shift.updateMany.mockResolvedValue({ count: 1 })
    ;(prismaMock as any).activityLog.create.mockResolvedValue({ id: 'audit-history-1' })

    await refundService.recordRefund(VENUE, { ...cuerpo(3000), tipRefundCents: 1000 } as never, 'staff-1')

    const refund = (prismaMock as any).payment.create.mock.calls[0][0].data
    expect(Number(refund.amount)).toBe(-20)
    expect(Number(refund.tipAmount)).toBe(-10)
    expect(Number(refund.netAmount)).toBe(-30)
    expect(refund.shiftId ?? null).toBeNull()
    expect(refund.processorData).toMatchObject({
      amountCents: 3000,
      shiftBackfilled: false,
      shiftAttributionPendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
    })
    expect((prismaMock as any).shift.updateMany).not.toHaveBeenCalled()
    expect((prismaMock as any).activityLog.create).toHaveBeenCalledTimes(1)
    expect((prismaMock as any).activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Payment',
        entityId: 'pay-refund-nuevo',
        staffId: 'staff-1',
        venueId: VENUE,
        data: {
          status: 'PENDING',
          reason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
          candidateShiftId: 'shift-open',
          observedShiftStatus: 'OPEN',
          paymentId: 'pay-refund-nuevo',
          orderId: null,
          channel: 'recordRefund',
          amountPesos: '-20.00',
          tipPesos: '-10.00',
          totalPesos: '-30.00',
          shiftAttributionStatus: 'PENDING',
          unclassifiedPriorRefundPesos: '60.00',
        },
      },
    })
  })

  it.each([0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rechaza amount=%p si no es un entero positivo seguro antes de abrir transacción',
    async amount => {
      armar({})

      await expect(refundService.recordRefund(VENUE, cuerpo(amount) as never, 'staff-1')).rejects.toThrow(
        /amount.*entero seguro.*centavos/i,
      )

      expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
      expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    },
  )

  it.each([-0.5, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rechaza tipRefundCents=%p si no es un entero no negativo seguro antes de abrir transacción',
    async tipRefundCents => {
      armar({})

      await expect(refundService.recordRefund(VENUE, { ...cuerpo(1000), tipRefundCents } as never, 'staff-1')).rejects.toThrow(
        /tipRefundCents.*entero seguro.*centavos/i,
      )

      expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
      expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    },
  )

  it('🔴 lee el ACUMULADO EN CENTAVOS que el dashboard escribió, no sólo los pesos', async () => {
    // Es exactamente lo que el riel del dashboard persiste tras devolver los $120 completos.
    // Con la lectura vieja (`Number(processorData.refundedAmount ?? 0)`) una fila que sólo
    // trae los centavos se leía como 0 y la terminal volvía a ofrecer el cobro entero.
    armar({ refundedAmountCents: 12000 })

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never, 'staff-1')).rejects.toThrow(/exceeds remaining refundable/i)
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
    await refundService.recordRefund(VENUE, cuerpo(10000) as never, 'staff-1')

    const pd = escrito()
    expect(pd.refundedAmount).toBe(100)
    expect(pd.refundedAmountCents).toBe(10000)
    expect(pd.isFullyRefunded).toBe(false)
  })

  it('devolver los $120 completos SÍ marca el cobro como totalmente reembolsado', async () => {
    armar({})

    await refundService.recordRefund(VENUE, cuerpo(12000) as never, 'staff-1')

    const pd = escrito()
    expect(pd.refundedAmount).toBe(120)
    expect(pd.refundedAmountCents).toBe(12000)
    expect(pd.isFullyRefunded).toBe(true)
  })

  it('🔴 un acumulado ILEGIBLE corta el reembolso en vez de valer 0', async () => {
    // `Number('vaya')` es NaN y `refundAmountInPesos > NaN` es **false**: un acumulado
    // corrupto dejaba pasar TODOS los reembolsos, sin un solo aviso.
    armar({ refundedAmount: 'vaya' })

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never, 'staff-1')).rejects.toThrow(/no es un número/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })

  it('acumula en CENTAVOS enteros: dos parciales de $40.33 no arrastran flotantes', async () => {
    armar({ refundedAmount: 40.33, refundedAmountCents: 4033 })

    await refundService.recordRefund(VENUE, cuerpo(4033) as never, 'staff-1')

    const pd = escrito()
    expect(pd.refundedAmountCents).toBe(8066)
    expect(pd.refundedAmount).toBe(80.66)
  })

  it('🔴 BAJO EL CANDADO también lee los centavos: el pre-vuelo ve 0 y aun así rechaza', async () => {
    // El pre-vuelo (fuera de la transacción) no ve reembolsos; el candado sí ve los $120 que
    // otro escritor dejó. Sólo la lectura del candado puede rechazar aquí — y es justo la que
    // se saltaba `refundedAmountCents`.
    armarDosFotos({}, { refundedAmountCents: 12000 })

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never, 'staff-1')).rejects.toThrow(/exceeds remaining refundable/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })

  it('🔴 BAJO EL CANDADO, un acumulado corto en PESOS no borra los centavos del candado', async () => {
    // Foto vieja con el acumulado de la regla vieja (110, sin la propina de un reembolso
    // previo); bajo el candado ya están los 12000 correctos. Gana el candado.
    armarDosFotos({ refundedAmount: 110, refundedAmountCents: 11000 }, { refundedAmount: 120, refundedAmountCents: 12000 })

    await expect(refundService.recordRefund(VENUE, cuerpo(500) as never, 'staff-1')).rejects.toThrow(/exceeds remaining refundable/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })

  it('🔴 EL ÚLTIMO PASO DE LA FUGA: las FILAS mandan sobre un acumulado corto (los $130 sobre $120)', async () => {
    // El cobro arrastra `refundedAmount: 110` de dos reembolsos viejos del dashboard escritos
    // con la regla vieja; las filas dicen la verdad: $120, o sea el cobro entero.
    //
    // Con el acumulado SOLO —que es lo que este riel leía— la terminal veía $10 disponibles y
    // los sacaba: $130 sobre $120. Lo que lo hacía inofensivo hoy era una MEDICIÓN («ningún
    // cobro vivo tiene dos reembolsos»), no el código.
    armar({ refundedAmount: 110, refundedAmountCents: 11000 }, [filaDeReembolso(-50, -10), filaDeReembolso(-50, -10)])

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never, 'staff-1')).rejects.toThrow(/exceeds remaining refundable/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    // Y lo rechaza el CANDADO, no el pre-vuelo: el pre-vuelo sólo ve el acumulado (110) y
    // cree que quedan $10. Sin esta línea la prueba no distinguiría los dos caminos.
    expect((prismaMock as any).$transaction).toHaveBeenCalled()
  })

  it('las filas se consultan DENTRO de la transacción, acotadas a este cobro y a este negocio', async () => {
    armar({}, [filaDeReembolso(-50, -10)])

    await refundService.recordRefund(VENUE, cuerpo(1000) as never, 'staff-1')

    const args = (prismaMock as any).payment.findMany.mock.calls[0][0]
    expect(args.where).toMatchObject({ venueId: VENUE, type: 'REFUND' })
    expect(args.where.processorData).toEqual({ path: ['originalPaymentId'], equals: 'pay-orig' })
    // El `select` es lo que hace imposible recortar `tipAmount` sin que TypeScript lo vea.
    expect(args.select).toEqual({ amount: true, tipAmount: true, status: true })
    expect(args.take).toBe(1_001)
  })

  it('falla ruidosamente si un cobro rebasa el máximo verificable de reembolsos', async () => {
    armar({}, Array(1_001).fill(filaDeReembolso(-0.01, 0)))

    await expect(refundService.recordRefund(VENUE, cuerpo(1) as never, 'staff-1')).rejects.toThrow(/más de 1000 reembolsos/i)

    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    expect((prismaMock as any).payment.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1_001 }))
  })

  it('🔴 una fila de reembolso que NO completó no infla el piso ni rechaza de más', async () => {
    // Contar dinero que nunca salió rechazaría un reembolso legítimo. Misma restricción que
    // `summarizeRefunds` (`orderBalance.ts`), el precedente que cita el módulo compartido.
    armar({}, [filaDeReembolso(-50, -10, 'PENDING')])

    await refundService.recordRefund(VENUE, cuerpo(12000) as never, 'staff-1')

    expect(escrito().refundedAmountCents).toBe(12000)
  })

  // ─── Regresión: el camino de todos los días no cambia ────────────────────────────────

  it('🔴 reequilibra hacia PROPINA cuando la venta restante no alcanza', async () => {
    // Cobro original: $100 venta + $20 propina. Ya salieron $90 exclusivamente de venta.
    // Pedir otros $30 con `tipRefundCents=0` cabe en el TOTAL restante ($30), pero llevaría
    // la venta devuelta a $120. Como el procesador ya movió el dinero, el backend no puede
    // rechazar y dejarlo sin asiento: toma los $10 restantes de venta y los otros $20 de tip.
    armar({}, [filaDeReembolso(-90, 0)])

    await refundService.recordRefund(VENUE, { ...cuerpo(3000), tipRefundCents: 0 } as never, 'staff-1')

    const data = (prismaMock as any).payment.create.mock.calls[0][0].data
    expect(Number(data.amount)).toBe(-10)
    expect(Number(data.tipAmount)).toBe(-20)
  })

  it('🔴 reequilibra hacia VENTA cuando la propina restante no alcanza', async () => {
    // Ya se devolvieron $15 de propina. Otros $10 caben holgadamente en el total, pero
    // excederían los $20 de propina originales. Se usan los $5 restantes de propina y los
    // otros $5 se registran como venta para no perder el asiento del dinero ya devuelto.
    armar({}, [filaDeReembolso(0, -15)])

    await refundService.recordRefund(VENUE, { ...cuerpo(1000), tipRefundCents: 1000 } as never, 'staff-1')

    const data = (prismaMock as any).payment.create.mock.calls[0][0].data
    expect(Number(data.amount)).toBe(-5)
    expect(Number(data.tipAmount)).toBe(-5)
  })

  it('honra tipRefundCents=0 cuando el monto cabe completo en la venta restante', async () => {
    armar({})

    await refundService.recordRefund(VENUE, { ...cuerpo(10000), tipRefundCents: 0 } as never, 'staff-1')

    const data = (prismaMock as any).payment.create.mock.calls[0][0].data
    expect(Number(data.amount)).toBe(-100)
    expect(Number(data.tipAmount)).toBe(0)
  })

  it('un APK viejo que pide el total sin propina conserva el asiento completo', async () => {
    armar({})

    await refundService.recordRefund(VENUE, { ...cuerpo(12000), tipRefundCents: 0 } as never, 'staff-1')

    const data = (prismaMock as any).payment.create.mock.calls[0][0].data
    expect(Number(data.amount)).toBe(-100)
    expect(Number(data.tipAmount)).toBe(-20)
  })

  it('un cobro sin reembolsos previos se comporta igual que siempre', async () => {
    armar({})

    await refundService.recordRefund(VENUE, cuerpo(4000) as never, 'staff-1')

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
      findFirst: jest.fn().mockResolvedValue({ orderId: 'order-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'refund-B' }),
      update: jest.fn().mockResolvedValue({ id: 'pay-orig' }),
    }
    ;(prismaMock as any).shift = { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    ;(prismaMock as any).venueTransaction = { create: jest.fn().mockResolvedValue({}) }
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn(), update: jest.fn() }
    ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn() }
    ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
    ;(prismaMock as any).$queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'order-1' }])
      .mockResolvedValueOnce([cobro])
      .mockResolvedValueOnce([reembolsoPrevio])

    await issueRefund({ venueId: VENUE, paymentId: 'pay-orig', amount: 6000, reason: 'RETURNED_GOODS', staffId: 'staff-9' })

    const persistido = (prismaMock as any).payment.update.mock.calls[0][0].data.processorData as Record<string, unknown>
    expect(persistido.refundedAmountCents).toBe(12000)

    // 2) La terminal recibe ESE processorData y pide $10 más. Con el acumulado corto de antes
    //    (110) veía $10 disponibles y los dejaba salir: $130 sobre un cobro de $120.
    jest.clearAllMocks()
    armar(persistido)

    await expect(refundService.recordRefund(VENUE, cuerpo(1000) as never, 'staff-1')).rejects.toThrow(/exceeds remaining refundable/i)
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })
})
