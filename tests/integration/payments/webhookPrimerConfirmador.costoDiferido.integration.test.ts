/**
 * Codex R1 (P1-5, P1-6) del checkpoint 1: el COSTO DIFERIDO de un Payment nacido del webhook (S2) converge o no termina.
 *
 *  · P1-5: el costo persistido es la VERDAD y sus proyecciones (`Payment.feeAmount/netAmount`, `VenueTransaction`) se
 *    reparan siempre a partir de él. Un corte entre «crear el costo» y «proyectarlo» no puede dejar comisión $0 / neto
 *    bruto junto a un costo de $3 marcado como terminado. Si una proyección no se puede reparar, el efecto NO termina
 *    (`costPending` sigue en `true`) y el worker vuelve a intentar.
 *  · P1-6: un REEMBOLSO que llegó mientras el costo esperaba no tenía original que espejar; al cerrar el costo recibe
 *    su costo NEGATIVO, idempotente por Payment del reembolso.
 *
 * `createTransactionCost` se sustituye por un fake que SÓLO inserta la fila del costo (sin proyectar nada): es
 * exactamente el estado que deja un corte tras la primera escritura del servicio real.
 */
import prisma from '@/utils/prismaClient'
import {
  asegurarCostoSincrono,
  convergerCostoDeTransaccion,
  settleDeferredTransactionCost,
} from '@/services/payments/deferredTransactionCost.service'
import * as transactionCost from '@/services/payments/transactionCost.service'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'
import { actores, type Actor, type Fallo } from './actores'

jest.mock('@/services/payments/transactionCost.service', () => {
  const real = jest.requireActual('@/services/payments/transactionCost.service')
  return {
    ...real,
    createTransactionCost: jest.fn(),
    // Codex R3: el costo del reembolso es el REAL, pero observable — una prueba introduce un corte a media página.
    createRefundTransactionCost: jest.fn((...args: unknown[]) => real.createRefundTransactionCost(...args)),
  }
})
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const createTransactionCostMock = transactionCost.createTransactionCost as jest.Mock
const createRefundTransactionCostMock = transactionCost.createRefundTransactionCost as jest.Mock
let f: Fixture

/** La fila del costo tal como la deja el servicio real: comisión al negocio 2.5 % + $0.50 fijo ⇒ $3.00 sobre $100. */
// Codex R6 (diseño B): la unidad de convergencia pasa SU cliente (`tx`) a la creación del costo; el fake inserta con él,
// como el servicio real (con el cliente global, un INSERT ajeno se quedaría esperando el candado de la fila del Payment).
const insertarCosto = async (paymentId: string, amount = 100, db: Pick<typeof prisma, 'transactionCost'> = prisma) =>
  db.transactionCost.create({
    data: {
      paymentId,
      merchantAccountId: f.merchantId,
      transactionType: 'CREDIT',
      amount,
      providerRate: 0.02,
      providerCostAmount: amount * 0.02,
      venueRate: 0.025,
      venueChargeAmount: amount * 0.025,
      venueFixedFee: 0.5,
      grossProfit: amount * 0.005 + 0.5,
      profitMargin: 0.2,
    },
  })

const pagoDelWebhook = async (
  over: { cardBrand?: string | null; status?: 'COMPLETED' | 'PENDING'; tip?: number; amount?: number; provisional?: boolean } = {},
) => {
  const venta = await f.nuevaVenta(over.amount ?? 100)
  const pago = await prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId: venta.id,
      amount: over.amount ?? 100,
      tipAmount: over.tip ?? 0,
      status: over.status ?? 'COMPLETED',
      method: 'CREDIT_CARD',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      cardBrand: over.cardBrand === undefined ? 'VISA' : (over.cardBrand as never),
      merchantAccountId: f.merchantId,
      processedById: f.staffId,
      idempotencyKey: `costo-${Date.now()}-${Math.random()}`,
      // Codex R12-3: lo que decide «listo para calcular» es el MÉTODO acreditado (`methodProvisional: false`, lo escribe el REST
      // de la terminal al consolidar), nunca la marca sola ni el plazo. Por defecto el Payment ya está acreditado: esta suite
      // prueba la convergencia; `provisional: true` representa al nacido del webhook que la terminal todavía no registró.
      processorData: { registradoVia: 'webhook', methodProvisional: over.provisional ?? false, costPending: true },
    },
  })
  await prisma.venueTransaction.create({
    data: {
      venueId: f.venueId,
      paymentId: pago.id,
      type: 'PAYMENT',
      grossAmount: over.amount ?? 100,
      feeAmount: 0,
      netAmount: over.amount ?? 100,
    },
  })
  return pago
}
/** El efecto PENDIENTE que el registrador deja para un Payment nacido del webhook (la obligación durable vive aquí). */
const efectoPendiente = (pago: { id: string; orderId: string | null }) =>
  prisma.paymentEffect.create({
    data: {
      venueId: f.venueId,
      paymentId: pago.id,
      orderId: pago.orderId,
      kind: 'TRANSACTION_COST',
      dedupeKey: `transaction-cost:${pago.id}:v1`,
      payload: payloadVigente,
    },
  })

/** Un reembolso como lo dejan los DOS canales reales: Payment REFUND (fee 0, neto = bruto negativo) + su VenueTransaction REFUND. */
const reembolsoDe = async (
  originalPaymentId: string,
  orderId: string,
  amount = 40,
  tip = 0,
  opciones: { sinVenueTransaction?: boolean } = {},
) => {
  const reembolso = await prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId,
      type: 'REFUND',
      amount: -amount,
      tipAmount: -tip,
      status: 'COMPLETED',
      method: 'CREDIT_CARD',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: -(amount + tip),
      merchantAccountId: f.merchantId,
      processedById: f.staffId,
      processorData: { originalPaymentId },
    },
  })
  if (!opciones.sinVenueTransaction) {
    await prisma.venueTransaction.create({
      data: {
        venueId: f.venueId,
        paymentId: reembolso.id,
        type: 'REFUND',
        grossAmount: -(amount + tip),
        feeAmount: 0,
        netAmount: -(amount + tip),
        status: 'SETTLED',
      },
    })
  }
  return reembolso
}
/** Codex R13-5: la proyección del reembolso sale de su costo negativo persistido (misma regla monetaria que el original). */
const proyeccionDelReembolso = async (refundId: string) => {
  const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: refundId } }))
  const fee = Number((Number(costo.venueChargeAmount) + Number(costo.venueFixedFee)).toFixed(2))
  const net = Number((Number(costo.amount) - fee).toFixed(2))
  const r = await exigir(prisma.payment.findUnique({ where: { id: refundId } }))
  expect(Number(r.feeAmount)).toBeCloseTo(fee, 6)
  expect(Number(r.netAmount)).toBeCloseTo(net, 6)
  const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: refundId } }))
  expect(Number(vt.feeAmount)).toBeCloseTo(fee, 6)
  expect(Number(vt.netAmount)).toBeCloseTo(net, 6)
  expect(Number(vt.netSettlementAmount)).toBeCloseTo(net, 6)
  return { fee, net }
}

const leer = async (paymentId: string) => {
  const p = await exigir(prisma.payment.findUnique({ where: { id: paymentId } }))
  const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId } }))
  return {
    fee: Number(p.feeAmount),
    net: Number(p.netAmount),
    costPending: (p.processorData as Record<string, unknown>).costPending,
    vt: {
      fee: Number(vt.feeAmount),
      net: Number(vt.netAmount),
      settlement: vt.netSettlementAmount === null ? null : Number(vt.netSettlementAmount),
    },
  }
}

const payloadVigente = { reason: 'AWAITING_ACCREDITED_CARD_DATA', deadlineAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }

/**
 * Codex R6 (diseño B): la unidad de convergencia escribe con SU cliente (`tx`), así que un espía sobre el cliente global no la
 * alcanza. Este helper sabotea UNA transacción: envuelve al `tx` en un Proxy que hace fallar `venueTransaction.updateMany`.
 */
const conVenueTransactionFueraDeServicio = () => {
  const realTx = prisma.$transaction.bind(prisma)
  return jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
    realTx(
      (tx: any) =>
        fn(
          new Proxy(tx, {
            get: (objetivo, prop) =>
              prop === 'venueTransaction'
                ? new Proxy(objetivo.venueTransaction, {
                    get: (delegado, metodo) =>
                      metodo === 'updateMany'
                        ? () => Promise.reject(new Error('VenueTransaction fuera de servicio'))
                        : Reflect.get(delegado, metodo),
                  })
                : Reflect.get(objetivo, prop),
          }),
        ),
      opts as never,
    )) as never)
}
const ahora = () => new Date()

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('s2')
  // Codex R3 (P1-5): sin configuración de liquidación el efecto ya NO termina — el fixture la trae de fábrica.
  await f.conLiquidacion()
})

beforeEach(() => {
  jest.clearAllMocks()
  createRefundTransactionCostMock.mockImplementation((...args: unknown[]) =>
    jest.requireActual('@/services/payments/transactionCost.service').createRefundTransactionCost(...args),
  )
  // El fake sólo inserta el costo; NO proyecta (es el estado que deja un corte a media operación del servicio real).
  createTransactionCostMock.mockImplementation(async (paymentId: string, db?: Pick<typeof prisma, 'transactionCost'>) => {
    await insertarCosto(paymentId, 100, db)
    // Devuelve el costo que insertó: `null` significaría «no aplica» (medio sin costo) y cerraría la obligación.
    return { transactionCost: {}, feeAmount: 3, netAmount: 97 }
  })
})

afterEach(() => f.limpiar())
afterAll(() => f.destruir())

describe('Codex R1 · P1-5: el costo diferido repara sus proyecciones desde el costo PERSISTIDO y sólo termina al converger', () => {
  it('con el costo ya en la base (corte tras crearlo) y las proyecciones en $0/bruto: las repara, no las da por hechas', async () => {
    const pago = await pagoDelWebhook()
    await insertarCosto(pago.id)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)

    expect(createTransactionCostMock).not.toHaveBeenCalled()
    expect(await leer(pago.id)).toEqual({ fee: 3, net: 97, costPending: false, vt: { fee: 3, net: 97, settlement: 97 } })
  })

  it('sin costo todavía: lo crea y proyecta desde la fila persistida (no desde lo que devolvió la llamada)', async () => {
    const pago = await pagoDelWebhook()

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)

    expect(createTransactionCostMock).toHaveBeenCalledWith(pago.id, expect.anything())
    expect(await leer(pago.id)).toEqual({ fee: 3, net: 97, costPending: false, vt: { fee: 3, net: 97, settlement: 97 } })
  })

  it('si la VenueTransaction no se puede actualizar, el fallo se PROPAGA (costPending sigue true) y el siguiente intento converge', async () => {
    const pago = await pagoDelWebhook()
    const espia = conVenueTransactionFueraDeServicio()
    try {
      // Codex R2 (P2): un fallo OPERATIVO no es «esperando la marca»: se propaga para que el efecto cuente el intento
      // (backoff y, si persiste, DEAD_LETTER visible) en vez de reprogramarse para siempre con attempts=0.
      // Codex R6 (diseño B): la unidad es UNA transacción — el fallo revierte también el costo recién creado (nada escapa).
      await expect(settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).rejects.toThrow('VenueTransaction fuera de servicio')
      const aMedias = await leer(pago.id)
      expect(aMedias.costPending).toBe(true)
      expect(aMedias.vt).toEqual({ fee: 0, net: 100, settlement: null })
      expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(0)
    } finally {
      espia.mockRestore()
    }

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(await leer(pago.id)).toEqual({ fee: 3, net: 97, costPending: false, vt: { fee: 3, net: 97, settlement: 97 } })
    // El costo se creó UNA vez: el reintento no lo duplica (idempotente por paymentId).
    expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(1)
  })

  it('el segundo cierre es idempotente: nada cambia y no vuelve a crear el costo', async () => {
    const pago = await pagoDelWebhook()
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    createTransactionCostMock.mockClear()
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(createTransactionCostMock).not.toHaveBeenCalled()
    expect(await leer(pago.id)).toEqual({ fee: 3, net: 97, costPending: false, vt: { fee: 3, net: 97, settlement: 97 } })
  })

  it('con el método PROVISIONAL (la terminal todavía no registró) sigue esperando, dentro y FUERA del plazo: no crea costo ni toca nada — Codex R12-3: el plazo no acredita el tipo de tarjeta', async () => {
    const pago = await pagoDelWebhook({ cardBrand: null, provisional: true })
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(false)
    expect(createTransactionCostMock).not.toHaveBeenCalled()
    expect(await leer(pago.id)).toEqual({ fee: 0, net: 100, costPending: true, vt: { fee: 0, net: 100, settlement: null } })
    const efecto = await efectoPendiente(pago)
    const vencido = { ...payloadVigente, deadlineAt: new Date(Date.now() - 60_000).toISOString() }
    expect(await settleDeferredTransactionCost(pago.id, vencido, ahora())).toBe(false)
    expect(createTransactionCostMock).not.toHaveBeenCalled()
    expect((await prisma.paymentEffect.findUniqueOrThrow({ where: { id: efecto.id } })).lastError).toBe(
      'AWAITING_ACCREDITED_CARD_DATA_OVERDUE',
    )
    expect(await leer(pago.id)).toEqual({ fee: 0, net: 100, costPending: true, vt: { fee: 0, net: 100, settlement: null } })
  })

  it('una POSIBLE SEGUNDA CAPTURA (PENDING) nunca recibe costo: termina sin crear nada', async () => {
    const pago = await pagoDelWebhook({ status: 'PENDING' })
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(createTransactionCostMock).not.toHaveBeenCalled()
    expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(0)
  })
})

describe('Codex R1 · P1-6: el reembolso que llegó mientras el costo esperaba recibe su costo NEGATIVO al cerrar', () => {
  it('reembolso parcial antes del cierre: nace su costo negativo proporcional; el segundo cierre no lo duplica', async () => {
    const pago = await pagoDelWebhook()
    const reembolso = await reembolsoDe(pago.id, pago.orderId, 40)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)

    const costoDelReembolso = await prisma.transactionCost.findUnique({ where: { paymentId: reembolso.id } })
    expect(costoDelReembolso).not.toBeNull()
    expect(Number(costoDelReembolso!.amount)).toBe(-40)
    // 2.5 % de $40 = $1.00 que se «des-cobra»; el fijo sólo se devuelve en un reembolso total.
    expect(Number(costoDelReembolso!.venueChargeAmount)).toBeCloseTo(-1, 4)
    expect(Number(costoDelReembolso!.venueFixedFee)).toBe(0)
    expect(Number(costoDelReembolso!.grossProfit)).toBeLessThan(0)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(await prisma.transactionCost.count({ where: { paymentId: reembolso.id } })).toBe(1)
    // Codex R13-5: el cumplimiento incluye la PROYECCIÓN del reembolso: fee −$1.00 (2.5 % × 40), neto −$39.
    expect(await proyeccionDelReembolso(reembolso.id)).toEqual({ fee: -1, net: -39 })
  })

  it('reembolso TOTAL antes del cierre: espeja el costo entero, incluido el fijo', async () => {
    const pago = await pagoDelWebhook()
    const reembolso = await reembolsoDe(pago.id, pago.orderId, 100)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)

    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: reembolso.id } }))
    expect(Number(costo.amount)).toBe(-100)
    expect(Number(costo.venueChargeAmount)).toBeCloseTo(-2.5, 4)
    expect(Number(costo.venueFixedFee)).toBeCloseTo(-0.5, 4)
    // Codex R13-5: fee −$3 y neto −$97 en el Payment y la VenueTransaction del reembolso (original + reembolso suman 0/0).
    expect(await proyeccionDelReembolso(reembolso.id)).toEqual({ fee: -3, net: -97 })
    expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
  })

  it('Codex R13-5 · un reembolso SIN VenueTransaction (la fila financiera no existe) impide converger: PENDIENTE con `REFUND_VENUE_TRANSACTION_MISSING`, `costPending` sigue; el costo negativo queda persistido y proyectado en su Payment; al existir la fila, converge y cierra DONE', async () => {
    const pago = await pagoDelWebhook()
    const obligacion = await efectoPendiente(pago)
    const reembolso = await reembolsoDe(pago.id, pago.orderId, 100, 0, { sinVenueTransaction: true })
    expect(await asegurarCostoSincrono(pago.id)).toBe('PENDIENTE')
    expect(await prisma.transactionCost.count({ where: { paymentId: reembolso.id } })).toBe(1)
    const r = await exigir(prisma.payment.findUnique({ where: { id: reembolso.id } }))
    expect(Number(r.feeAmount)).toBe(-3)
    expect(Number(r.netAmount)).toBe(-97)
    expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: true })
    expect(await prisma.paymentEffect.findUniqueOrThrow({ where: { id: obligacion.id } })).toMatchObject({
      status: 'PENDING',
      lastError: 'REFUND_VENUE_TRANSACTION_MISSING',
    })
    await prisma.venueTransaction.create({
      data: {
        venueId: f.venueId,
        paymentId: reembolso.id,
        type: 'REFUND',
        grossAmount: -100,
        feeAmount: 0,
        netAmount: -100,
        status: 'SETTLED',
      },
    })
    expect(await asegurarCostoSincrono(pago.id)).toBe('CUMPLIDA')
    expect(await proyeccionDelReembolso(reembolso.id)).toEqual({ fee: -3, net: -97 })
    expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
    expect(await prisma.paymentEffect.findUniqueOrThrow({ where: { id: obligacion.id } })).toMatchObject({
      status: 'DONE',
      lastError: null,
    })
  })

  it('un reembolso de OTRO pago no se toca (la conciliación es por originalPaymentId)', async () => {
    const pago = await pagoDelWebhook()
    const otro = await pagoDelWebhook()
    const reembolsoAjeno = await reembolsoDe(otro.id, otro.orderId, 10)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)

    expect(await prisma.transactionCost.findUnique({ where: { paymentId: reembolsoAjeno.id } })).toBeNull()
  })
})

describe('Codex R2 · N3/N4/P1-5: todos los reembolsos, con propina, y los metadatos de liquidación', () => {
  it('N3 · 52 reembolsos en espera reciben TODOS su costo negativo (no sólo los primeros 50) y el segundo cierre no duplica', async () => {
    const pago = await pagoDelWebhook()
    for (let i = 0; i < 52; i++) await reembolsoDe(pago.id, pago.orderId, 1)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    const conCosto = await prisma.transactionCost.count({
      where: { payment: { venueId: f.venueId, type: 'REFUND', orderId: pago.orderId } },
    })
    expect(conCosto).toBe(52)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(await prisma.transactionCost.count({ where: { payment: { venueId: f.venueId, type: 'REFUND', orderId: pago.orderId } } })).toBe(
      52,
    )
  })

  it('N4 · el reembolso TOTAL de base $100 + propina $10 revierte el costo ENTERO (incluido el fijo), no sólo la parte de la base', async () => {
    const pago = await pagoDelWebhook({ tip: 10 })
    await insertarCosto(pago.id, 110) // el costo real se cobra sobre base + propina
    const reembolso = await reembolsoDe(pago.id, pago.orderId, 100, 10)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)

    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: reembolso.id } }))
    expect(Number(costo.amount)).toBe(-110)
    expect(Number(costo.venueChargeAmount)).toBeCloseTo(-2.75, 4)
    expect(Number(costo.venueFixedFee)).toBeCloseTo(-0.5, 4)
  })

  it('N4 · reembolso parcial con propina ($50 + $5) y reembolso SÓLO de propina ($10): proporcionales al total devuelto', async () => {
    const pago = await pagoDelWebhook({ tip: 10 })
    await insertarCosto(pago.id, 110)
    const parcial = await reembolsoDe(pago.id, pago.orderId, 50, 5)
    const soloPropina = await reembolsoDe(pago.id, pago.orderId, 0, 10)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)

    const cp = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: parcial.id } }))
    expect(Number(cp.amount)).toBe(-55)
    expect(Number(cp.venueChargeAmount)).toBeCloseTo(-1.375, 4)
    expect(Number(cp.venueFixedFee)).toBe(0)
    const ct = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: soloPropina.id } }))
    expect(Number(ct.amount)).toBe(-10)
    expect(Number(ct.venueChargeAmount)).toBeCloseTo(-0.25, 4)
    expect(Number(ct.venueFixedFee)).toBe(0)
  })

  it('P1-5 · con el costo ya en la base y la liquidación sin escribir (corte), el cierre repara fecha estimada y configuración de liquidación', async () => {
    const config = await prisma.settlementConfiguration.create({
      data: {
        merchantAccountId: f.merchantId,
        cardType: 'CREDIT',
        settlementDays: 1,
        settlementDayType: 'CALENDAR_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: 'America/Mexico_City',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    })
    try {
      const pago = await pagoDelWebhook()
      await insertarCosto(pago.id)
      expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
      const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: pago.id } }))
      expect(vt.estimatedSettlementDate).not.toBeNull()
      expect(vt.settlementConfigId).toBe(config.id)
      expect(Number(vt.netSettlementAmount)).toBe(97)
      expect(
        ((await exigir(prisma.payment.findUnique({ where: { id: pago.id } }))).processorData as Record<string, unknown>).costPending,
      ).toBe(false)
    } finally {
      await prisma.settlementConfiguration.delete({ where: { id: config.id } })
    }
  })
})

describe('Codex R3 · P1-5, N3 y el redondeo con las escalas REALES de Postgres', () => {
  it('P1-5 · sin configuración de liquidación el cierre NO termina: el costo existe, el efecto queda PENDIENTE con motivo visible y `costPending` sigue; al configurarla después, converge', async () => {
    const pago = await pagoDelWebhook()
    await efectoPendiente(pago)
    await f.sinLiquidacion()
    try {
      expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(false)
      expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(1)
      expect((await leer(pago.id)).costPending).toBe(true)
      expect((await leer(pago.id)).vt).toMatchObject({ fee: 3, net: 97, settlement: 97 }) // las proyecciones sí se reparan; lo que falta es la liquidación
      const efecto = await exigir(prisma.paymentEffect.findFirst({ where: { paymentId: pago.id, kind: 'TRANSACTION_COST' } }))
      expect(efecto.lastError).toBe('AWAITING_SETTLEMENT_CONFIGURATION')
      expect((await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: pago.id } }))).settlementConfigId).toBeNull()
    } finally {
      await f.conLiquidacion()
    }
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: pago.id } }))
    expect(vt.settlementConfigId).not.toBeNull()
    expect(vt.estimatedSettlementDate).not.toBeNull()
    expect((await leer(pago.id)).costPending).toBe(false)
  })

  it('N3 · CORTE entre páginas: el 30º reembolso truena; la unidad es UNA transacción (Codex R6): el primer cierre PROPAGA el fallo y REVIERTE los 29 (nada escapa a medias), y el segundo costea los 52 sin duplicar ninguno', async () => {
    const pago = await pagoDelWebhook()
    for (let i = 0; i < 52; i++) await reembolsoDe(pago.id, pago.orderId, 1)
    let llamadas = 0
    const real = jest.requireActual('@/services/payments/transactionCost.service').createRefundTransactionCost
    createRefundTransactionCostMock.mockImplementation(async (...args: unknown[]) => {
      if (++llamadas === 30) throw new Error('CORTE_ENTRE_PAGINAS')
      return real(...args)
    })

    await expect(settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).rejects.toThrow('CORTE_ENTRE_PAGINAS')
    const costeados = () =>
      prisma.transactionCost.count({ where: { payment: { venueId: f.venueId, type: 'REFUND', orderId: pago.orderId } } })
    expect(await costeados()).toBe(0)
    expect((await leer(pago.id)).costPending).toBe(true)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(await costeados()).toBe(52)
    expect(createRefundTransactionCostMock).toHaveBeenCalledTimes(30 + 52)
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(await costeados()).toBe(52)
  })

  it('P2 · $1.11 al 2.25 %: la columna guarda 0.0250 (escala 4), la comisión proyectada es $0.03 y el neto $1.08 — suman el importe, en Payment y en VenueTransaction', async () => {
    const pago = await pagoDelWebhook({ amount: 1.11 })
    await prisma.transactionCost.create({
      data: {
        paymentId: pago.id,
        merchantAccountId: f.merchantId,
        transactionType: 'CREDIT',
        amount: 1.11,
        providerRate: 0.02,
        providerCostAmount: 0.0222,
        venueRate: 0.0225,
        venueChargeAmount: 0.024975,
        venueFixedFee: 0,
        grossProfit: 0.002775,
        profitMargin: 0.1111,
      },
    })
    expect(Number((await exigir(prisma.transactionCost.findUnique({ where: { paymentId: pago.id } }))).venueChargeAmount)).toBe(0.025)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    const proyeccion = await leer(pago.id)
    expect(proyeccion.fee).toBe(0.03)
    expect(proyeccion.net).toBe(1.08)
    expect(proyeccion.vt.fee).toBe(0.03)
    expect(proyeccion.vt.net).toBe(1.08)
    expect(proyeccion.vt.settlement).toBe(1.08)
    expect(Math.round((proyeccion.fee + proyeccion.net) * 100)).toBe(111)
  })
})

describe('Codex R4 (P3) · los reembolsos ya costeados se excluyen EN LA CONSULTA y el presupuesto por ejecución es configurable', () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.DEFERRED_COST_REFUND_PAGE = '10'
    process.env.DEFERRED_COST_REFUND_MAX_PAGES = '2'
  })
  afterEach(() => {
    process.env = { ...env }
  })

  it('52 reembolsos con páginas de 10 y tope de 2 por ejecución: 20 · 20 · 12 — cada ejecución continúa donde falta trabajo, sin recorrer lo ya costeado, y sólo la última termina', async () => {
    const pago = await pagoDelWebhook()
    await efectoPendiente(pago)
    for (let i = 0; i < 52; i++) await reembolsoDe(pago.id, pago.orderId, 1)
    const costeados = () =>
      prisma.transactionCost.count({ where: { payment: { venueId: f.venueId, type: 'REFUND', orderId: pago.orderId } } })

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(false)
    expect(await costeados()).toBe(20)
    expect((await leer(pago.id)).costPending).toBe(true)
    expect((await exigir(prisma.paymentEffect.findFirst({ where: { paymentId: pago.id, kind: 'TRANSACTION_COST' } }))).lastError).toBe(
      'REFUND_COSTS_CONTINUE_NEXT_RUN',
    )

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(false)
    expect(await costeados()).toBe(40)

    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(await costeados()).toBe(52)
    expect((await leer(pago.id)).costPending).toBe(false)
    // Exactamente un costo por reembolso: nunca se volvió a costear (ni a consultar para saltar) uno ya costeado.
    expect(createRefundTransactionCostMock).toHaveBeenCalledTimes(52)
    expect(new Set(createRefundTransactionCostMock.mock.calls.map(([id]) => id)).size).toBe(52)
  })

  it('un valor inválido en el entorno cae a los valores por defecto (50 por página, 4 páginas por unidad — Codex R6: lote acotado, se confirma y se continúa): 52 reembolsos terminan en una sola ejecución', async () => {
    process.env.DEFERRED_COST_REFUND_PAGE = 'diez'
    process.env.DEFERRED_COST_REFUND_MAX_PAGES = '-1'
    const pago = await pagoDelWebhook()
    for (let i = 0; i < 52; i++) await reembolsoDe(pago.id, pago.orderId, 1)
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora())).toBe(true)
    expect(await prisma.transactionCost.count({ where: { payment: { venueId: f.venueId, type: 'REFUND', orderId: pago.orderId } } })).toBe(
      52,
    )
  })
})

describe('Codex R6 (h) · la unidad de convergencia bajo CONTENCIÓN (NOWAIT) y con el presupuesto VENCIDO', () => {
  const barrera = () => {
    let soltar!: () => void
    let pausado!: () => void
    const liberada = new Promise<void>(r => (soltar = r))
    const enPausa = new Promise<void>(r => (pausado = r))
    /**
     * Espera ACOTADA a la pausa: `false` si el actor instrumentado nunca llegó a la barrera (p. ej. porque un mutante le quitó
     * el candado que lo identifica). Así la prueba cae por ASERCIÓN, no por el timeout de Jest — el runner certificado (Codex
     * R7 (l)) sólo cuenta aserciones.
     */
    const pausadaEn = (ms: number) =>
      Promise.race([
        enPausa.then(() => true),
        new Promise<boolean>(r => {
          const t = setTimeout(() => r(false), ms)
          t.unref?.()
        }),
      ])
    return { soltar, pausado, liberada, enPausa, pausadaEn }
  }
  /**
   * Otra transacción (ajena) sostiene la fila del Payment con la misma fuerza de candado que usa la unidad.
   * Codex R12-13 (l): es un MONTAJE registrado en el conjunto de actores desde su lanzamiento — si la adquisición falla antes
   * de devolver el cleanup, o la transacción ajena rechaza al soltarse, la prueba termina INCONCLUSA con esa causa (nunca se
   * salta `cerrar`). `soltar` va por `liberar`, que captura el error de liberación en vez de propagarlo.
   */
  const filaTomadaPorOtro = async (A: ReturnType<typeof actores>, paymentId: string) => {
    const b = barrera()
    const ajena = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR NO KEY UPDATE`
        b.pausado()
        await b.liberada
      },
      { timeout: 20_000 },
    )
    const montaje = A.montaje('transacción ajena que sostiene la fila del Payment', ajena)
    const llego = await b.pausadaEn(10_000) // el actor instrumentado llegó a la barrera (si no, INCONCLUSO por el montaje)
    return {
      llego,
      montaje,
      soltar: () => A.liberar({ 'fila del Payment (transacción ajena)': async () => (b.soltar(), await montaje.resultado()) }),
    }
  }
  const efecto = (id: string) => exigir(prisma.paymentEffect.findUnique({ where: { id } }))
  /**
   * Una corrida contendida contesta en milisegundos (NOWAIT). Si en vez de contestar se QUEDA ESPERANDO la fila (sin NOWAIT),
   * la carrera lo dice con `'BLOQUEADA'` en 3 s — una aserción, no un timeout de Jest — y el `finally` suelta la fila.
   */

  it('REST · con la fila del Payment tomada por OTRA corrida, el costo síncrono no compite: CONTENDIDA — sin costo, `costPending` intacto, la obligación sigue PENDING; al soltarse la fila, la siguiente corrida converge y cierra', async () => {
    const pago = await pagoDelWebhook()
    const obligacion = await efectoPendiente(pago)
    // Codex R8/R9 (l): la corrida en vuelo se captura al lanzarla; lo observado mientras la fila está tomada se RECOGE y se
    // afirma después de soltar y de asentar al actor.
    const A = actores()
    const otro = await filaTomadaPorOtro(A, pago.id)
    let intento!: Actor<Awaited<ReturnType<typeof asegurarCostoSincrono>>>
    const obs = { desenlace: null as unknown, costos: -1, lectura: null as unknown, estado: '' }
    let fallo: Fallo = null
    try {
      // Codex R13-6: la primera aserción y el lanzamiento del actor van DENTRO del bloque cuyo `finally` suelta la fila: si el
      // montaje no llegó a la barrera, no se lanza nada contra una fila libre, la barrera se suelta igual y `cerrar` lo reporta
      // como INCONCLUSO (montaje fallido), no como un actor colgado.
      expect(otro.llego).toBe(true)
      intento = A.lanzar('costo síncrono contendido', asegurarCostoSincrono(pago.id))
      obs.desenlace = await A.carrera(intento, 3000)
      obs.costos = await prisma.transactionCost.count({ where: { paymentId: pago.id } })
      obs.lectura = await leer(pago.id)
      obs.estado = (await efecto(obligacion.id)).status
    } catch (error) {
      fallo = { error }
    } finally {
      await otro.soltar()
    }
    await A.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A.afirmar(async () => {
      expect(obs.desenlace).toEqual({ estado: 'ASENTADA', ok: true, value: 'CONTENDIDA' })
      expect(createTransactionCostMock).not.toHaveBeenCalled()
      expect(obs.costos).toBe(0)
      expect(obs.lectura).toMatchObject({ fee: 0, net: 100, costPending: true })
      expect(obs.estado).toBe('PENDING')
      await expect(intento.resultado()).resolves.toBe('CONTENDIDA')
    })
    expect(await asegurarCostoSincrono(pago.id)).toBe('CUMPLIDA')
    expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(1)
    expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
    expect((await prisma.paymentEffect.findUniqueOrThrow({ where: { id: obligacion.id } })).status).toBe('DONE')
  })

  it('WORKER · con la fila tomada, `settleDeferredTransactionCost` contesta `false` (se reprograma sin consumir intento) y no toca su obligación reclamada; libre, la termina con SU token', async () => {
    const pago = await pagoDelWebhook()
    const obligacion = await efectoPendiente(pago)
    await prisma.paymentEffect.update({
      where: { id: obligacion.id },
      data: { status: 'PROCESSING', claimToken: 'token-del-worker', leaseUntil: new Date(Date.now() + 60_000), attempts: 1 },
    })
    const cierre = { tipo: 'WORKER' as const, effectId: obligacion.id, claimToken: 'token-del-worker' }
    const A = actores()
    const otro = await filaTomadaPorOtro(A, pago.id)
    let intento!: Actor<boolean>
    const obs = { desenlace: null as unknown, costos: -1, costPending: null as unknown, obligacion: null as unknown }
    let fallo: Fallo = null
    try {
      // Codex R13-6: la primera aserción y el lanzamiento del actor van DENTRO del bloque cuyo `finally` suelta la fila: si el
      // montaje no llegó a la barrera, no se lanza nada contra una fila libre, la barrera se suelta igual y `cerrar` lo reporta
      // como INCONCLUSO (montaje fallido), no como un actor colgado.
      expect(otro.llego).toBe(true)
      intento = A.lanzar('worker contendido', settleDeferredTransactionCost(pago.id, payloadVigente, ahora(), cierre))
      obs.desenlace = await A.carrera(intento, 3000)
      obs.costos = await prisma.transactionCost.count({ where: { paymentId: pago.id } })
      obs.costPending = (await leer(pago.id)).costPending
      obs.obligacion = await efecto(obligacion.id)
    } catch (error) {
      fallo = { error }
    } finally {
      await otro.soltar()
    }
    await A.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A.afirmar(async () => {
      expect(obs.desenlace).toEqual({ estado: 'ASENTADA', ok: true, value: false })
      expect(obs.costos).toBe(0)
      expect(obs.costPending).toBe(true)
      expect(obs.obligacion).toMatchObject({ status: 'PROCESSING', claimToken: 'token-del-worker' })
      await expect(intento.resultado()).resolves.toBe(false)
    })
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora(), cierre)).toBe(true)
    expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
    expect((await prisma.paymentEffect.findUniqueOrThrow({ where: { id: obligacion.id } })).status).toBe('DONE')
  })

  it('Codex R13 (cobertura) · WORKER con un token AJENO: la unidad converge (costo, proyecciones, costPending false) pero la obligación reclamada por OTRO token NO transiciona — sigue PROCESSING con su token; sólo el dueño la cierra DONE', async () => {
    const pago = await pagoDelWebhook()
    const obligacion = await efectoPendiente(pago)
    await prisma.paymentEffect.update({
      where: { id: obligacion.id },
      data: { status: 'PROCESSING', claimToken: 'token-del-dueno', leaseUntil: new Date(Date.now() + 60_000), attempts: 1 },
    })
    // Un cierre que se cree dueño con un token que NO es el de la fila (una corrida vieja, un reclamo perdido).
    const ajeno = { tipo: 'WORKER' as const, effectId: obligacion.id, claimToken: 'token-ajeno' }
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora(), ajeno)).toBe(true)
    expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
    expect(await prisma.paymentEffect.findUniqueOrThrow({ where: { id: obligacion.id } })).toMatchObject({
      status: 'PROCESSING',
      claimToken: 'token-del-dueno',
    })
    // El dueño, con SU token, sí la cierra.
    const dueno = { tipo: 'WORKER' as const, effectId: obligacion.id, claimToken: 'token-del-dueno' }
    expect(await settleDeferredTransactionCost(pago.id, payloadVigente, ahora(), dueno)).toBe(true)
    expect(await prisma.paymentEffect.findUniqueOrThrow({ where: { id: obligacion.id } })).toMatchObject({
      status: 'DONE',
      claimToken: null,
    })
  })

  it('Codex R6 (i) · sin VenueTransaction (la fila financiera no existe) la obligación NO converge: PENDIENTE con `VENUE_TRANSACTION_MISSING` y `costPending` sigue — el costo persistido es la VERDAD (queda, con su proyección en el Payment), pero «existe la fila del costo» no es «obligación cumplida»; al existir la VenueTransaction, converge', async () => {
    const pago = await pagoDelWebhook()
    const obligacion = await efectoPendiente(pago)
    await prisma.venueTransaction.delete({ where: { paymentId: pago.id } })
    expect(await asegurarCostoSincrono(pago.id)).toBe('PENDIENTE')
    expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(1)
    const p = await exigir(prisma.payment.findUnique({ where: { id: pago.id } }))
    expect(p.processorData).toMatchObject({ costPending: true })
    expect(Number(p.feeAmount)).toBe(3)
    expect(await efecto(obligacion.id)).toMatchObject({ status: 'PENDING', lastError: 'VENUE_TRANSACTION_MISSING' })
    await prisma.venueTransaction.create({
      data: { venueId: f.venueId, paymentId: pago.id, type: 'PAYMENT', grossAmount: 100, feeAmount: 0, netAmount: 100 },
    })
    expect(await asegurarCostoSincrono(pago.id)).toBe('CUMPLIDA')
    expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
    expect((await prisma.paymentEffect.findUniqueOrThrow({ where: { id: obligacion.id } })).status).toBe('DONE')
  })

  it('presupuesto VENCIDO · la primera corrida se queda a media unidad y su transacción caduca: NADA suyo escapa; la segunda corrida converge; la escritura TARDÍA de la primera falla contra su transacción cerrada y NO revierte `costPending: false` ni la obligación DONE', async () => {
    const pago = await pagoDelWebhook()
    const obligacion = await efectoPendiente(pago)
    const b = barrera()
    let pidDeLaPrimera = 0
    // La PRIMERA creación del costo se queda esperando (dentro de la unidad, con la fila tomada) hasta que la prueba la suelte.
    createTransactionCostMock.mockImplementationOnce(
      async (paymentId: string, db?: Pick<typeof prisma, 'transactionCost' | '$queryRaw'>) => {
        const [{ pid }] = await (db as typeof prisma).$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        pidDeLaPrimera = pid
        b.pausado()
        await b.liberada
        await insertarCosto(paymentId, 100, db as never) // escritura TARDÍA: su transacción ya venció
        return { transactionCost: {}, feeAmount: 3, netAmount: 97 }
      },
    )
    // Presupuesto corto pero con margen para OBSERVAR la transacción viva antes de que venza (bajo carga, 300 ms no alcanzaban).
    // Codex R8–R10 (l): la primera corrida es un ACTOR — se captura al lanzarla y su desenlace (un rechazo por transacción
    // vencida, que aquí es lo esperado) se examina explícitamente al final; lo observado se recoge y se afirma después.
    const A = actores()
    const primera = A.lanzar(
      'primera corrida (presupuesto vencido)',
      convergerCostoDeTransaccion(pago.id, { tipo: 'REST' }, { presupuestoMs: 2_000 }),
    )
    const enTransaccion = async () => {
      const filas = await prisma.$queryRaw<
        { estado: string | null }[]
      >`SELECT state AS estado FROM pg_stat_activity WHERE pid = ${pidDeLaPrimera}`
      // Medido: la sesión pausada dentro de la unidad está «idle in transaction»; al vencer, Prisma la revierte y la sesión
      // deja de estarlo (sin transacción abierta) — es la liberación del candado, observada, no supuesta con un reloj.
      return filas.length > 0 && filas[0].estado === 'idle in transaction'
    }
    const obs = {
      primeraEnLaBarrera: false,
      vivaAntesDeVencer: false,
      segunda: null as unknown,
      soltada: false,
      convergio: null as unknown,
    }
    let fallo: Fallo = null
    try {
      obs.primeraEnLaBarrera = await b.pausadaEn(10_000) // el actor instrumentado llegó a la barrera
      // Vence el presupuesto de la primera: Postgres revierte su transacción y SUELTA la fila — se OBSERVA (la sesión de la
      // primera deja de estar en transacción), no se supone con un reloj.
      obs.vivaAntesDeVencer = await enTransaccion()
      // Mientras la primera sigue viva (fila tomada), una segunda corrida no compite.
      obs.segunda = await A.carrera(A.lanzar('segunda corrida (contendida)', asegurarCostoSincrono(pago.id)), 3000)
      obs.soltada = await f.esperar(async () => !(await enTransaccion()), 8000)
      obs.convergio = await asegurarCostoSincrono(pago.id)
    } catch (error) {
      fallo = { error }
    } finally {
      b.soltar()
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      // Primero los desenlaces de los actores: la primera ya despertó (el `finally` la soltó) y su escritura tardía fue contra una
      // transacción cerrada — su RECHAZO es lo esperado y se afirma aquí, antes de cualquier otra aserción (Codex R10 (l)).
      await expect(primera.resultado()).rejects.toThrow(/expired|already closed|Transaction API error|P2028/i)
      expect(obs.primeraEnLaBarrera).toBe(true)
      expect(obs.vivaAntesDeVencer).toBe(true)
      expect(obs.segunda).toEqual({ estado: 'ASENTADA', ok: true, value: 'CONTENDIDA' })
      expect(obs.soltada).toBe(true)
      expect(obs.convergio).toBe('CUMPLIDA')
      expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
      expect((await efecto(obligacion.id)).status).toBe('DONE')
      expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(1)
      expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
      expect((await efecto(obligacion.id)).status).toBe('DONE')
    })
  })

  it('Codex R6 (h) · una corrida CONTENDIDA sobre una obligación YA cumplida (`costPending: false`, DONE) no revierte nada: la marca y el cierre se conservan', async () => {
    const pago = await pagoDelWebhook()
    const obligacion = await efectoPendiente(pago)
    expect(await asegurarCostoSincrono(pago.id)).toBe('CUMPLIDA')
    expect(await leer(pago.id)).toMatchObject({ fee: 3, net: 97, costPending: false })
    expect((await efecto(obligacion.id)).status).toBe('DONE')
    const A = actores()
    const otro = await filaTomadaPorOtro(A, pago.id)
    let intento!: Actor<Awaited<ReturnType<typeof asegurarCostoSincrono>>>
    const obs = { desenlace: null as unknown, lectura: null as unknown, estado: '', costos: -1 }
    let fallo: Fallo = null
    try {
      // Codex R13-6: la primera aserción y el lanzamiento del actor van DENTRO del bloque cuyo `finally` suelta la fila: si el
      // montaje no llegó a la barrera, no se lanza nada contra una fila libre, la barrera se suelta igual y `cerrar` lo reporta
      // como INCONCLUSO (montaje fallido), no como un actor colgado.
      expect(otro.llego).toBe(true)
      intento = A.lanzar('costo síncrono contendido sobre una obligación cumplida', asegurarCostoSincrono(pago.id))
      obs.desenlace = await A.carrera(intento, 3000)
      obs.lectura = await leer(pago.id)
      obs.estado = (await efecto(obligacion.id)).status
      obs.costos = await prisma.transactionCost.count({ where: { paymentId: pago.id } })
    } catch (error) {
      fallo = { error }
    } finally {
      await otro.soltar()
    }
    await A.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A.afirmar(async () => {
      expect(obs.desenlace).toEqual({ estado: 'ASENTADA', ok: true, value: 'CONTENDIDA' })
      expect(obs.lectura).toMatchObject({ fee: 3, net: 97, costPending: false })
      expect(obs.estado).toBe('DONE')
      expect(obs.costos).toBe(1)
      await expect(intento.resultado()).resolves.toBe('CONTENDIDA')
    })
    // Libre, una corrida más es idempotente: sigue cumplida, sin segundo costo.
    expect(await asegurarCostoSincrono(pago.id)).toBe('CUMPLIDA')
    expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(1)
  })
})
