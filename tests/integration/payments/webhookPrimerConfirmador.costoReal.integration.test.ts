/**
 * Codex R3 (P1-3, P1-5 y las pruebas exigidas): el COSTO REAL —sin fakes— de un Payment nacido del webhook, calculado
 * con las tarifas de la base (proveedor, precio al negocio por slot y liquidación) después de que el REST acreditó el
 * método real. Con y sin orden. Y las dos obligaciones DURABLES nuevas:
 *
 *  · P1-3: la tarifa que se le cobra al negocio es la del slot que la afiliación ocupaba AL COBRAR (`pricingSlot`
 *    congelado en el registro). Si el negocio retira esa afiliación de su configuración antes de calcular el costo, se
 *    cobra con la tarifa contratada entonces (SECONDARY 2.5 %), nunca con la de otra afiliación (PRIMARY 8 %). Sin slot
 *    acreditable, el costo queda PENDIENTE con motivo visible en el efecto — el cobro nunca se interrumpe.
 *  · P1-5: sin configuración de liquidación el efecto NO termina: queda como obligación durable con motivo visible y
 *    converge cuando alguien la configura.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { ordenarIngresosSinCandado, processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { NS_CANDADO_INTENTO, OPCIONES_DE_TRANSACCION_DEL_INTENTO, candadoDeIntento } from '@/services/tpv/candadoDeIntento'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import * as registrador from '@/services/tpv/payment.tpv.service'
import { claimPendingAngelPayEvents, runClaimedAngelPayEvent } from '@/services/tpv/angelpayEventWorker.service'
import {
  anotarCostoNoCalculado,
  asegurarCostoSincrono,
  settleDeferredTransactionCost,
} from '@/services/payments/deferredTransactionCost.service'
import * as costoDeTransaccion from '@/services/payments/transactionCost.service'
import * as configuracionDePagos from '@/services/organization-payment-config.service'
import * as moduloRepetido from '@/services/tpv/registroRepetido'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { processBlumonPaymentWebhook } from '@/services/tpv/blumon-webhook.service'
import { blumonPaymentAuditJob } from '@/jobs/blumon-payment-audit.job'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { claimPaymentEffects, runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'
import { actores, type Fallo } from './actores'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

let f: Fixture
let M2: { id: string; externalMerchantId: string }

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('costo')
  M2 = await f.afiliacionSecundaria()
  // PRIMARY al 8 % (crédito) y SECONDARY al 2.5 %: el caso de Codex — $1,000 por M2 son $25, no $80.
  await f.conTarifas({
    primary: { creditRate: 0.08, internationalRate: 0.045, fixed: 0.5 },
    secundaria: { merchantAccountId: M2.id, tasas: { creditRate: 0.025, fixed: 0.5 } },
  })
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(() => f.limpiar())
afterAll(() => f.destruir())

const pago = (id: string) => exigir(prisma.payment.findUnique({ where: { id } }))
const efectoDe = (paymentId: string) => exigir(prisma.paymentEffect.findFirst({ where: { paymentId, kind: 'TRANSACTION_COST' } }))
const cerrar = async (paymentId: string, ahora = new Date()) => {
  const efecto = await efectoDe(paymentId)
  return settleDeferredTransactionCost(paymentId, efecto.payload as Record<string, unknown>, ahora)
}
const enTresHoras = () => new Date(Date.now() + 3 * 60 * 60_000)
/**
 * Codex R12-3: un cobro nacido del webhook lleva el método PROVISIONAL y su costo no se calcula hasta que el REST de la terminal
 * lo acredita — el plazo ya no «calcula con lo que hay». Este REST es el paso que antes se saltaban las pruebas del webhook.
 */
async function restQueAcredita(attemptId: string, requestId: string, ref: string, merchant = M2, tarjeta: Record<string, unknown> = {}) {
  return recordFastPayment(
    f.venueId,
    {
      ...f.registroDeLaTerminal({
        attemptId,
        requestId,
        ref,
        tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP', ...tarjeta },
      }),
      merchantAccountId: merchant.id,
      ...tarjeta,
    },
    f.staffId,
  )
}

async function vincular(requestId: string, attemptId = randomUUID()) {
  const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
    { requestId, attemptId },
    { socketId: 's', terminalId: f.serial, venueId: f.venueId },
  )
  expect(ack.success).toBe(true)
  return attemptId
}
async function webhook(attemptId: string, over: Record<string, unknown> = {}, merchant?: { id: string; externalMerchantId: string }) {
  const eventId = f.nuevoEventId()
  const result = await processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId, over),
    eventId,
    merchantAccount: merchant ?? { id: f.merchantId, externalMerchantId: f.merchantExternalId },
    retryDelaysMs: [0],
  })
  return { result, eventId }
}
const restDebitoInternacional = (attemptId: string, requestId: string, ref: string) => ({
  ...f.registroDeLaTerminal({ attemptId, requestId, ref, tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' } }),
  method: 'DEBIT_CARD',
  isInternational: true,
})

async function comprobarCostoInternacional(paymentId: string) {
  expect(await cerrar(paymentId)).toBe(true)
  const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId } }))
  expect(costo).toMatchObject({ merchantAccountId: f.merchantId, transactionType: 'INTERNATIONAL' })
  expect(Number(costo.venueRate)).toBeCloseTo(0.045, 6)
  expect(Number(costo.venueChargeAmount)).toBeCloseTo(4.5, 4)
  expect(Number(costo.venueFixedFee)).toBeCloseTo(0.5, 4)
  const p = await pago(paymentId)
  expect(Number(p.feeAmount)).toBe(5)
  expect(Number(p.netAmount)).toBe(95)
  expect((p.processorData as Record<string, unknown>).costPending).toBe(false)
  const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId } }))
  expect(Number(vt.feeAmount)).toBe(5)
  expect(Number(vt.netAmount)).toBe(95)
  expect(Number(vt.netSettlementAmount)).toBe(95)
  expect(vt.settlementConfigId).not.toBeNull()
  expect(vt.estimatedSettlementDate).not.toBeNull()
  // Idempotente: el segundo cierre no crea otro costo ni mueve las proyecciones.
  expect(await cerrar(paymentId)).toBe(true)
  expect(await prisma.transactionCost.count({ where: { paymentId } })).toBe(1)
}

describe('Codex R3 · el costo REAL tras webhook repetido/recuperado → REST con débito internacional', () => {
  it('venta rápida: el webhook confirma, un webhook repetido no acredita nada, el REST trae débito internacional y el costo nace con la tarifa INTERNACIONAL de la afiliación acreditada, proyectado en Payment y VenueTransaction con liquidación', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R })).result.action).toBe('CONFIRMED')
    expect(['CONFIRMED', 'MATCHED']).toContain((await webhook(A, { transactionId: R })).result.action)
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect((nacido.processorData as Record<string, unknown>).methodProvisional).toBe(true)

    const rest = await recordFastPayment(f.venueId, restDebitoInternacional(A, solicitud.requestId, R), f.staffId)
    expect(rest.id).toBe(nacido.id)
    await comprobarCostoInternacional(nacido.id)
  })

  it('con orden: el mismo recorrido sobre una cuenta de $100', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R })).result.action).toBe('CONFIRMED')
    expect(['CONFIRMED', 'MATCHED']).toContain((await webhook(A, { transactionId: R })).result.action)
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))

    const rest = await recordOrderPayment(f.venueId, venta.id, restDebitoInternacional(A, solicitud.requestId, R), f.staffId)
    expect(rest.id).toBe(nacido.id)
    await comprobarCostoInternacional(nacido.id)
  })
})

describe('Codex R3 · P1-3: la afiliación retirada de la configuración cobra con su tarifa CONGELADA, o queda pendiente y visible', () => {
  afterEach(() => f.devolverALaConfiguracion(M2.id))

  it('M2 cobró como SECONDARY (2.5 %); el negocio la retira antes del costo; el costo diferido usa 2.5 % sobre M2 — no el 8 % de PRIMARY', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(nacido.merchantAccountId).toBe(M2.id)
    expect(nacido.processorData).toMatchObject({ pricingSlot: 'SECONDARY' })

    await f.quitarDeLaConfiguracion(M2.id)
    // Codex R12-3: vencido el plazo NO se calcula con el crédito provisional — se espera al REST de la terminal, que acredita.
    expect(await cerrar(nacido.id, enTresHoras())).toBe(false)
    expect(await efectoDe(nacido.id)).toMatchObject({ status: 'PENDING', lastError: 'AWAITING_ACCREDITED_CARD_DATA_OVERDUE' })
    const rest = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({
          attemptId: A,
          requestId: solicitud.requestId,
          ref: R,
          tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' },
        }),
        merchantAccountId: M2.id,
      },
      f.staffId,
    )
    expect(rest.id).toBe(nacido.id)
    expect(await cerrar(nacido.id, enTresHoras())).toBe(true)
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: nacido.id } }))
    expect(costo.merchantAccountId).toBe(M2.id)
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(Number(costo.venueChargeAmount)).toBeCloseTo(2.5, 4)
    expect(Number((await pago(nacido.id)).feeAmount)).toBe(3)
  })

  it('sin slot congelado (M2 ya estaba fuera de la configuración AL cobrar): el costo no se calcula con otra tarifa — el efecto queda pendiente con motivo visible, y SIGUE pendiente aunque M2 vuelva a la configuración (Codex R9-1)', async () => {
    await f.quitarDeLaConfiguracion(M2.id)
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(nacido.status).toBe('COMPLETED')
    expect(nacido.processorData).toMatchObject({ pricingSlot: null })

    expect(await cerrar(nacido.id, enTresHoras())).toBe(false)
    expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(0)
    expect((await pago(nacido.id)).processorData).toMatchObject({ costPending: true })
    expect((await efectoDe(nacido.id)).lastError).toBe('AFFILIATION_PRICING_UNRESOLVED')

    // Codex R9-1: devolver M2 a la configuración (SECONDARY, 2.5 % vigente desde antes del cobro) NO acredita el cargo de
    // ayer — al cobrar no tenía tarifa contratada, y eso es un hecho histórico. Sigue pendiente y visible.
    await f.devolverALaConfiguracion(M2.id)
    expect(await cerrar(nacido.id, enTresHoras())).toBe(false)
    expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(0)
    expect((await pago(nacido.id)).processorData).toMatchObject({ costPending: true })
    expect((await efectoDe(nacido.id)).lastError).toBe('AFFILIATION_PRICING_UNRESOLVED')
  })
})

describe('Codex R3 · P1-5: sin configuración de liquidación el efecto NO termina', () => {
  afterEach(() => f.conLiquidacion())

  it('el costo existe pero la liquidación no se puede proyectar: el efecto sigue pendiente con motivo visible; al configurarla, converge', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R })).result.action).toBe('CONFIRMED')
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({
        attemptId: A,
        requestId: solicitud.requestId,
        ref: R,
        tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' },
      }),
      f.staffId,
    )

    await f.sinLiquidacion()
    expect(await cerrar(nacido.id)).toBe(false)
    expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(1)
    expect((await pago(nacido.id)).processorData).toMatchObject({ costPending: true })
    expect((await efectoDe(nacido.id)).lastError).toBe('AWAITING_SETTLEMENT_CONFIGURATION')
    expect((await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: nacido.id } }))).settlementConfigId).toBeNull()

    await f.conLiquidacion()
    expect(await cerrar(nacido.id)).toBe(true)
    const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: nacido.id } }))
    expect(vt.settlementConfigId).not.toBeNull()
    expect(vt.estimatedSettlementDate).not.toBeNull()
    expect((await pago(nacido.id)).processorData).toMatchObject({ costPending: false })
  })
})

describe('Codex R4-3 · la tarifa se congela DE VERDAD (las tasas), no sólo la etiqueta del slot', () => {
  let M3: { id: string; externalMerchantId: string } | null = null
  afterEach(async () => {
    // Deshacer: PRIMARY = la afiliación del fixture, SECONDARY = M2 al 2.5 %.
    await prisma.venuePaymentConfig.update({
      where: { venueId: f.venueId },
      data: { primaryAccountId: f.merchantId, secondaryAccountId: M2.id },
    })
    await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate: 0.025 } })
  })

  it('M2 cobró como SECONDARY (2.5 %); después el negocio pone a M3 en SECONDARY, edita esa tarifa al 8 % EN SITIO y mueve M2 a PRIMARY (8 %): el costo diferido sigue al 2.5 % sobre M2', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(nacido.processorData).toMatchObject({
      pricingSlot: 'SECONDARY',
      pricing: { merchantAccountId: M2.id, venue: { accountType: 'SECONDARY', creditRate: '0.025' }, provider: { creditRate: '0.02' } },
    })

    M3 = M3 ?? (await f.afiliacionSecundaria())
    await prisma.venuePaymentConfig.update({ where: { venueId: f.venueId }, data: { primaryAccountId: M2.id, secondaryAccountId: M3.id } })
    await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate: 0.08 } })

    // Codex R12-3: el REST de la terminal acredita el método; el costo converge con la tarifa CONGELADA, no con la de hoy.
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(nacido.id)
    expect(await cerrar(nacido.id, enTresHoras())).toBe(true)
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: nacido.id } }))
    expect(costo.merchantAccountId).toBe(M2.id)
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(Number(costo.venueChargeAmount)).toBeCloseTo(2.5, 4)
    expect(Number(costo.providerRate)).toBeCloseTo(0.02, 6)
    expect(Number((await pago(nacido.id)).feeAmount)).toBe(3)
    // Trazabilidad: la fila de tarifa (editada) sigue existiendo y se referencia; la verdad son las tasas congeladas.
    expect(costo.venuePricingStructureId).not.toBeNull()
  })

  it('el REST de la terminal también congela las tasas: el costo síncrono usa el 2.5 % y, cuando la tarifa SECONDARY pasa al 8 % un segundo después, ni el costo ya escrito ni un cierre repetido se mueven', async () => {
    const p = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' } }),
        merchantAccountId: M2.id,
      },
      f.staffId,
    )
    expect((await pago(p.id)).processorData).toMatchObject({ pricing: { merchantAccountId: M2.id, venue: { creditRate: '0.025' } } })
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
    // Codex R11 (P3): la perturbación prometida en el título ocurre de verdad — y no cambia nada de lo ya cobrado.
    await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate: 0.08 } })
    expect(await cerrar(p.id)).toBe(true)
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(1)
    expect(Number((await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))).venueRate)).toBeCloseTo(0.025, 6)
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
  })
})

describe('Codex R4-4 · la obligación de costo es DURABLE para todo cobro con tarjeta, también por REST', () => {
  afterEach(() => f.devolverALaConfiguracion(M2.id))
  const tarjeta = { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' }

  it('REST normal con tarjeta: el efecto TRANSACTION_COST nace dentro de la transacción financiera y queda DONE en la misma llamada', async () => {
    const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(1)
    const efecto = await efectoDe(p.id)
    expect(efecto).toMatchObject({ status: 'DONE', lastError: null })
    expect(efecto.payload).toMatchObject({ reason: 'ASSURE_COST' })
    expect(efecto.completedAt).not.toBeNull()
  })

  it('REST por una afiliación retirada ANTES de cobrar (sin slot ni tarifa): el cobro pasa, el costo NO se inventa, la obligación queda PENDIENTE y visible (AFFILIATION_PRICING_UNRESOLVED + costPending) y sigue pendiente al devolver la afiliación (Codex R9-1)', async () => {
    await f.quitarDeLaConfiguracion(M2.id)
    const p = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id },
      f.staffId,
    )
    expect(p.status).toBe('COMPLETED')
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    const efecto = await efectoDe(p.id)
    expect(efecto).toMatchObject({ status: 'PENDING', lastError: 'AFFILIATION_PRICING_UNRESOLVED' })
    // El worker no compite con el cálculo síncrono por el mismo costo: la obligación del REST nace con su primer intento un
    // minuto después (la de un webhook nace lista, porque ahí NO hay cálculo síncrono).
    expect(efecto.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000)
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: true })

    // Codex R9-1: devolver M2 a la configuración no acredita un cargo que se hizo SIN tarifa contratada: sigue pendiente.
    await f.devolverALaConfiguracion(M2.id)
    expect(await cerrar(p.id)).toBe(false)
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'AFFILIATION_PRICING_UNRESOLVED' })
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: true })
    expect(Number((await pago(p.id)).feeAmount)).toBe(0)
  })

  it('con orden: el mismo comportamiento (obligación pendiente y visible, y sigue pendiente al devolver la afiliación)', async () => {
    await f.quitarDeLaConfiguracion(M2.id)
    const venta = await f.nuevaVenta(100)
    const p = await recordOrderPayment(
      f.venueId,
      venta.id,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id },
      f.staffId,
    )
    expect(p.status).toBe('COMPLETED')
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'AFFILIATION_PRICING_UNRESOLVED' })
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
    await f.devolverALaConfiguracion(M2.id)
    expect(await cerrar(p.id)).toBe(false)
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'AFFILIATION_PRICING_UNRESOLVED' })
    expect(Number((await pago(p.id)).feeAmount)).toBe(0)
  })

  it('Codex R6 (diseño B) · `costPending` NACE con la obligación, no lo decide el cálculo síncrono: si la unidad síncrona falla por un error OPERATIVO (la base se cae a media unidad), NADA suyo escapa (sin costo, sin marca) y el Payment ya dice `costPending: true` desde su creación — venta rápida; converge después', async () => {
    const espia = jest.spyOn(costoDeTransaccion, 'createTransactionCost').mockRejectedValueOnce(new Error('ECONNRESET'))
    const p = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
    espia.mockRestore()
    expect(p.status).toBe('COMPLETED')
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'TRANSACTION_COST_FAILED' })
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: true })
    expect(Number((await pago(p.id)).feeAmount)).toBe(0)
    expect(await cerrar(p.id)).toBe(true)
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(1)
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: false })
  })

  it('con orden: `costPending` también nace con la obligación cuando la unidad síncrona falla por un error operativo', async () => {
    const espia = jest.spyOn(costoDeTransaccion, 'createTransactionCost').mockRejectedValueOnce(new Error('ECONNRESET'))
    const venta = await f.nuevaVenta(100)
    const p = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), f.staffId)
    espia.mockRestore()
    expect(p.status).toBe('COMPLETED')
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'TRANSACTION_COST_FAILED' })
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: true })
    expect(await cerrar(p.id)).toBe(true)
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: false })
  })

  it('Codex R7 (P2-d) · un snapshot de tarifa ILEGIBLE (congelado bajo OTRA afiliación) NO se lee como ausente: no nace un costo con la configuración de hoy, la obligación queda PENDIENTE y visible (INVALID_PRICING_SNAPSHOT + costPending) y converge al reparar el snapshot con la tarifa CONGELADA', async () => {
    // La unidad síncrona falla por un error operativo para que el Payment quede con su obligación pendiente y SIN costo.
    const espia = jest.spyOn(costoDeTransaccion, 'createTransactionCost').mockRejectedValueOnce(new Error('ECONNRESET'))
    const p = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id },
      f.staffId,
    )
    espia.mockRestore()
    expect(p.status).toBe('COMPLETED')
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    expect((await pago(p.id)).processorData).toMatchObject({ pricing: { merchantAccountId: M2.id, slot: 'SECONDARY' } })
    // El snapshot congelado dice OTRA afiliación: un dato que ya no describe este cobro. Ni se ignora ni se cae a la de hoy.
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = jsonb_set("processorData", '{pricing,merchantAccountId}', to_jsonb(${'M9-otra-afiliacion'}::text)) WHERE "id" = ${p.id}`
    // La unidad NO lanza: un snapshot ilegible es una obligación con nombre (PENDIENTE), no un fallo operativo que escape.
    await expect(cerrar(p.id)).resolves.toBe(false)
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'INVALID_PRICING_SNAPSHOT' })
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: true })
    expect(Number((await pago(p.id)).feeAmount)).toBe(0)
    // Reparado el snapshot (vuelve a decir la afiliación acreditada), la MISMA obligación converge con la tarifa CONGELADA
    // (SECONDARY 2.5 %), nunca con la configuración vigente. Codex R8: para que la frase «congelada frente a la de hoy»
    // quede DEMOSTRADA, la tarifa SECONDARY de hoy se edita al 8 % EN SITIO antes de reparar — si la unidad la tomara de la
    // configuración, cobraría $8, no $2.50.
    await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate: 0.08 } })
    try {
      await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = jsonb_set("processorData", '{pricing,merchantAccountId}', to_jsonb(${M2.id}::text)) WHERE "id" = ${p.id}`
      expect(await cerrar(p.id)).toBe(true)
      const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
      expect(costo.merchantAccountId).toBe(M2.id)
      expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
      expect(Number(costo.venueChargeAmount)).toBeCloseTo(2.5, 4)
      expect((await pago(p.id)).processorData).toMatchObject({ costPending: false })
      expect(Number((await pago(p.id)).feeAmount)).toBe(3)
    } finally {
      await prisma.venuePricingStructure.updateMany({
        where: { venueId: f.venueId, accountType: 'SECONDARY' },
        data: { creditRate: 0.025 },
      })
    }
  })

  it('efectivo: sin procesador no hay obligación de costo', async () => {
    const p = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinMerchant: true }), method: 'CASH' },
      f.staffId,
    )
    expect(await prisma.paymentEffect.count({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })).toBe(0)
  })
})

describe('Codex R8-2 / R9-1 · un snapshot SIN_TARIFA (M2 en SECONDARY sin estructura al cobrar, o fuera de la configuración) NUNCA cobra PRIMARY, ni el slot de hoy, ni una tarifa que apareció DESPUÉS: pendiente y visible hasta una acreditación EXPLÍCITA del cargo', () => {
  const tarjeta = { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' }
  let secundariaOriginal = ''
  const configuracionBase = () =>
    prisma.venuePaymentConfig.update({ where: { venueId: f.venueId }, data: { primaryAccountId: f.merchantId, secondaryAccountId: M2.id } })
  const secundariaVigente = (active: boolean) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { active } })
  const nuevaSecundaria = (creditRate: number, effectiveFrom: Date) =>
    prisma.venuePricingStructure.create({
      data: {
        venueId: f.venueId,
        accountType: 'SECONDARY',
        debitRate: creditRate,
        creditRate,
        amexRate: creditRate,
        internationalRate: creditRate,
        includesTax: true,
        fixedFeePerTransaction: 0.5,
        effectiveFrom,
        active: true,
      },
    })
  beforeAll(async () => {
    secundariaOriginal = (await exigir(prisma.venuePricingStructure.findFirst({ where: { venueId: f.venueId, accountType: 'SECONDARY' } })))
      .id
  })
  afterEach(async () => {
    await configuracionBase()
    await prisma.venuePricingStructure.deleteMany({
      where: { venueId: f.venueId, accountType: 'SECONDARY', id: { not: secundariaOriginal } },
    })
    await prisma.venuePricingStructure.update({
      where: { id: secundariaOriginal },
      data: { active: true, creditRate: 0.025, fixedFeePerTransaction: 0.5 },
    })
    await prisma.organizationPricingStructure.deleteMany({ where: { organizationId: f.fixture } })
  })

  const comprobarPendiente = async (paymentId: string) => {
    expect(await prisma.transactionCost.count({ where: { paymentId } })).toBe(0)
    expect(await efectoDe(paymentId)).toMatchObject({ status: 'PENDING', lastError: 'AFFILIATION_PRICING_UNRESOLVED' })
    expect((await pago(paymentId)).processorData).toMatchObject({ costPending: true })
    expect(Number((await pago(paymentId)).feeAmount)).toBe(0)
  }

  it('el escenario de Codex por REST: M2 sigue configurada como SECONDARY, sin estructura SECONDARY vigente y con PRIMARY (8 %) disponible ⇒ el cobro pasa (COMPLETED), NO nace costo, la obligación queda PENDING con motivo y costPending — y NINGUNA tarifa posterior la resuelve: ni mover M2 a PRIMARY, ni una SECONDARY creada hoy con vigencia posterior, ni una creada hoy RETRODATADA, ni reactivar la original, ni editarla', async () => {
    await secundariaVigente(false)
    const p = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id },
      f.staffId,
    )
    expect(p.status).toBe('COMPLETED')
    expect(p.merchantAccountId).toBe(M2.id)
    // El registrador congela EXACTAMENTE «slot SECONDARY, sin tarifa»: legible, de la misma afiliación, `venue: null`.
    expect((await pago(p.id)).processorData).toMatchObject({
      pricingSlot: 'SECONDARY',
      pricing: { merchantAccountId: M2.id, slot: 'SECONDARY', venue: null },
    })
    await comprobarPendiente(p.id)

    // Cambio posterior de slot: hoy M2 es PRIMARY (8 % vigente desde ANTES del cobro). El slot HISTÓRICO sigue sin tarifa.
    await prisma.venuePaymentConfig.update({
      where: { venueId: f.venueId },
      data: { primaryAccountId: M2.id, secondaryAccountId: f.merchantId },
    })
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)
    await configuracionBase()

    // Una SECONDARY al 8 % creada HOY, vigente desde mañana: no es la tarifa de este cobro.
    await nuevaSecundaria(0.08, new Date(Date.now() + 24 * 60 * 60_000))
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)

    // Codex R9-1: una SECONDARY al 2.5 % creada HOY y RETRODATADA (vigente «desde 2025»): tampoco — apareció después del cobro.
    await nuevaSecundaria(0.025, new Date('2025-06-01T00:00:00Z'))
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)

    // Codex R9-1: reactivar la fila original (misma fila, mismas tasas): tampoco — al cobrar no estaba vigente.
    await secundariaVigente(true)
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)

    // Codex R9-1: la fila original editada EN SITIO al 8 %: tampoco (las filas se editan en sitio; «a la fecha del cobro» no acredita).
    await prisma.venuePricingStructure.update({ where: { id: secundariaOriginal }, data: { creditRate: 0.08 } })
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)
  })

  it('Codex R9-1 · `slot: null` (M2 FUERA de la configuración al cobrar) ⇒ hoy M2 como PRIMARY (8 % vigente desde antes del cobro) NO acredita el cargo: sigue pendiente; y en OTRO slot con tarifa (SECONDARY 2.5 %) tampoco', async () => {
    await f.quitarDeLaConfiguracion(M2.id)
    const p = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id },
      f.staffId,
    )
    expect(p.status).toBe('COMPLETED')
    expect((await pago(p.id)).processorData).toMatchObject({
      pricingSlot: null,
      pricing: { merchantAccountId: M2.id, slot: null, venue: null },
    })
    await comprobarPendiente(p.id)

    await prisma.venuePaymentConfig.update({
      where: { venueId: f.venueId },
      data: { primaryAccountId: M2.id, secondaryAccountId: f.merchantId },
    })
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)

    await configuracionBase() // M2 en SECONDARY, con su 2.5 % vigente desde antes del cobro
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)
  })

  it('el mismo escenario por WEBHOOK (costo diferido, sin cálculo síncrono): pendiente con motivo, y sigue pendiente aunque la afiliación se retire o la tarifa del slot histórico se reactive', async () => {
    await secundariaVigente(false)
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(nacido.status).toBe('COMPLETED')
    expect(nacido.processorData).toMatchObject({
      pricingSlot: 'SECONDARY',
      pricing: { merchantAccountId: M2.id, slot: 'SECONDARY', venue: null },
    })

    // El REST nunca volvió: vencido el plazo se intenta con lo que hay — y lo que hay NO acredita ninguna tarifa.
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
    await comprobarPendiente(nacido.id)
    // Codex R12-3: mientras el método es provisional la unidad ni siquiera calcula; el REST tardío lo acredita y AHORA SÍ entra
    // la unidad — y «sin tarifa contratada al cobrar» sigue mandando: ni el cálculo síncrono del REST ni el worker cobran al 8 %.
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(nacido.id)
    expect((await pago(nacido.id)).processorData).toMatchObject({ methodProvisional: false })
    await comprobarPendiente(nacido.id)
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
    await comprobarPendiente(nacido.id)
    await f.quitarDeLaConfiguracion(M2.id)
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
    await comprobarPendiente(nacido.id)
    await configuracionBase()
    await secundariaVigente(true)
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
    await comprobarPendiente(nacido.id)
  })

  it('con orden: el cobro pasa y la cuenta queda pagada; el costo queda pendiente y visible, nunca al 8 % de PRIMARY, y sigue pendiente al reactivar la tarifa', async () => {
    await secundariaVigente(false)
    const venta = await f.nuevaVenta(100)
    const p = await recordOrderPayment(
      f.venueId,
      venta.id,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id },
      f.staffId,
    )
    expect(p.status).toBe('COMPLETED')
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
    await comprobarPendiente(p.id)
    await secundariaVigente(true)
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)
  })

  it('Codex R10 (P2) · SIN_TARIFA y el negocio se queda SIN configuración de pagos (ni del venue ni de la organización): la obligación conserva AFFILIATION_PRICING_UNRESOLVED y sigue PENDING sin consumir intentos — no muere como fallo operativo (TRANSACTION_COST_FAILED → DEAD_LETTER)', async () => {
    await secundariaVigente(false)
    const p = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id },
      f.staffId,
    )
    await comprobarPendiente(p.id)
    const intentosAntes = (await efectoDe(p.id)).attempts
    const config = await exigir(prisma.venuePaymentConfig.findUnique({ where: { venueId: f.venueId } }))
    await prisma.venuePaymentConfig.delete({ where: { venueId: f.venueId } })
    try {
      await expect(cerrar(p.id)).resolves.toBe(false)
      await comprobarPendiente(p.id)
      expect((await efectoDe(p.id)).attempts).toBe(intentosAntes)
    } finally {
      await prisma.venuePaymentConfig.create({
        data: {
          venueId: f.venueId,
          primaryAccountId: config.primaryAccountId,
          secondaryAccountId: config.secondaryAccountId,
          tertiaryAccountId: config.tertiaryAccountId,
        },
      })
    }
  })

  it('Codex R9 (P2) · un replay NORMAL (mismo cobro, sin llave, con datos de tarjeta y serial) conserva el snapshot BYTE A BYTE — incluido `pricing.venue: null` — y la obligación sigue diciendo AFFILIATION_PRICING_UNRESOLVED, nunca INVALID_PRICING_SNAPSHOT', async () => {
    await secundariaVigente(false)
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    const registro = {
      ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth, tarjeta }),
      merchantAccountId: M2.id,
    }
    const p = await recordFastPayment(f.venueId, registro, f.staffId)
    const antes = (await pago(p.id)).processorData as Record<string, unknown>
    expect(antes.pricing).toMatchObject({ merchantAccountId: M2.id, slot: 'SECONDARY', venue: null })
    // El replay idéntico (otro attemptId sin llave: el APK viejo reintenta) consolida sobre el MISMO Payment y lo enriquece.
    const replay = await recordFastPayment(f.venueId, { ...registro, attemptId: randomUUID() }, f.staffId)
    expect(replay.id).toBe(p.id)
    const despues = (await pago(p.id)).processorData as Record<string, unknown>
    expect(despues.pricing).toEqual(antes.pricing)
    expect(despues.pricing).toHaveProperty('venue', null)
    await expect(cerrar(p.id)).resolves.toBe(false)
    await comprobarPendiente(p.id)
  })

  it('Codex R9 (P2) · lo mismo con un snapshot VÁLIDO: un nulo anidado SEMÁNTICO (`venue.fixedFeePerTransaction: null` = sin cargo fijo) sobrevive al replay y el costo converge con la tarifa CONGELADA, sin cargo fijo', async () => {
    // La SECONDARY contratada sin cargo fijo: el snapshot lleva `fixedFeePerTransaction: null` (un dato, no un hueco).
    await prisma.venuePricingStructure.update({ where: { id: secundariaOriginal }, data: { fixedFeePerTransaction: null } })
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    const espia = jest.spyOn(costoDeTransaccion, 'createTransactionCost').mockRejectedValueOnce(new Error('ECONNRESET'))
    const registro = {
      ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth, tarjeta }),
      merchantAccountId: M2.id,
    }
    const p = await recordFastPayment(f.venueId, registro, f.staffId)
    espia.mockRestore()
    const antes = (await pago(p.id)).processorData as Record<string, unknown>
    expect(antes.pricing).toMatchObject({
      merchantAccountId: M2.id,
      slot: 'SECONDARY',
      venue: { creditRate: '0.025', fixedFeePerTransaction: null },
    })
    const replay = await recordFastPayment(f.venueId, { ...registro, attemptId: randomUUID() }, f.staffId)
    expect(replay.id).toBe(p.id)
    expect((await pago(p.id)).processorData).toHaveProperty('pricing', antes.pricing)
    expect((await pago(p.id)).processorData).toHaveProperty(['pricing', 'venue', 'fixedFeePerTransaction'], null)
    // Con la tarifa de hoy devuelta a $0.50 de cargo fijo, el costo sigue siendo el CONGELADO: 2.5 % y SIN cargo fijo.
    await prisma.venuePricingStructure.update({ where: { id: secundariaOriginal }, data: { fixedFeePerTransaction: 0.5 } })
    expect(await cerrar(p.id)).toBe(true)
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(Number(costo.venueFixedFee)).toBe(0)
    expect(Number((await pago(p.id)).feeAmount)).toBe(2.5)
  })

  it('Codex R9 (P2) · una tarifa HEREDADA de la organización: un Payment SIN snapshot (anterior al registrador, con `pricingSlot` legacy) converge con las tasas heredadas y `venuePricingStructureId` queda null — antes reventaba por la FK (el id es de OTRA tabla) y el costo no se recuperaba nunca', async () => {
    // El venue deja de tener SECONDARY propia y la hereda de su organización (2.5 %).
    await secundariaVigente(false)
    await prisma.organizationPricingStructure.create({
      data: {
        organizationId: f.fixture,
        accountType: 'SECONDARY',
        debitRate: 0.025,
        creditRate: 0.025,
        amexRate: 0.025,
        internationalRate: 0.025,
        includesTax: true,
        fixedFeePerTransaction: 0.5,
        effectiveFrom: new Date('2025-01-01T00:00:00Z'),
        active: true,
      },
    })
    const espia = jest.spyOn(costoDeTransaccion, 'createTransactionCost').mockRejectedValueOnce(new Error('ECONNRESET'))
    const p = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id },
      f.staffId,
    )
    espia.mockRestore()
    // Un Payment de ANTES del registrador: sin `pricing`, sólo el slot legacy (`pricingSlot`).
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = ("processorData" - 'pricing') WHERE "id" = ${p.id}`
    expect((await pago(p.id)).processorData).not.toHaveProperty('pricing')
    // `.resolves`: si la unidad revienta por la FK (el defecto), esta ASERCIÓN es la que cae — no un error suelto de Prisma.
    await expect(cerrar(p.id)).resolves.toBe(true)
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
    expect(costo.merchantAccountId).toBe(M2.id)
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(costo.venuePricingStructureId).toBeNull()
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: false })
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
  })
})

describe('Codex R10-1 · una lectura que FALLA al congelar la tarifa (proveedor, tarifa del negocio o configuración) NUNCA convierte el cobro en «sin snapshot»: el cobro se registra, la evidencia obtenida se conserva y el costo queda pendiente con motivo — jamás PRIMARY, ni al recuperarse la base', () => {
  const tarjeta = { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' }
  const secundariaVigente = (active: boolean) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { active } })
  afterEach(async () => {
    jest.restoreAllMocks()
    await secundariaVigente(true)
  })
  const fallaElProveedor = () => jest.spyOn(prisma.providerCostStructure, 'findFirst').mockRejectedValueOnce(new Error('ECONNRESET'))
  const fallaLaTarifa = () =>
    jest.spyOn(configuracionDePagos, 'getEffectivePricingForSlot').mockRejectedValueOnce(new Error('connection terminated'))
  const fallaLaConfiguracion = () =>
    jest.spyOn(configuracionDePagos, 'getEffectivePaymentConfig').mockRejectedValueOnce(new Error('ECONNRESET'))
  const pendienteSinLeer = async (paymentId: string, motivo: string) => {
    expect(await prisma.transactionCost.count({ where: { paymentId } })).toBe(0)
    expect(await efectoDe(paymentId)).toMatchObject({ status: 'PENDING', lastError: motivo })
    expect((await pago(paymentId)).processorData).toMatchObject({ costPending: true })
    expect(Number((await pago(paymentId)).feeAmount)).toBe(0)
  }
  const registroM2 = () => ({ ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id })

  it('REST rápido · falla la consulta del PROVEEDOR y la base se recupera: el cobro pasa, el snapshot conserva la tarifa del negocio (2.5 %) con `capturaFallida.proveedor`, y el costo converge con esa tarifa — no con PRIMARY', async () => {
    fallaElProveedor()
    const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
    expect(p.status).toBe('COMPLETED')
    expect((await pago(p.id)).processorData).toMatchObject({
      pricing: { slot: 'SECONDARY', venue: { creditRate: '0.025' }, provider: null, capturaFallida: { proveedor: 'ECONNRESET' } },
    })
    // El cálculo síncrono no dependía del snapshot del proveedor: ya convergió (o converge ahora) con la tarifa congelada.
    await expect(cerrar(p.id)).resolves.toBe(true)
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(Number(costo.providerRate)).toBeCloseTo(0.02, 6)
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
  })

  it('Codex R13 (cobertura) · ABORTO SQL REAL dentro de la transacción de captura (una sentencia falla en Postgres y la transacción queda abortada: las lecturas siguientes fallan de verdad): el cobro pasa, el snapshot lleva `capturaFallida` con el error de Postgres, el costo queda pendiente con PRICING_CAPTURE_FAILED y nunca se congela PRIMARY ni la tarifa de hoy', async () => {
    const real = configuracionDePagos.getEffectivePaymentConfig
    jest.spyOn(configuracionDePagos, 'getEffectivePaymentConfig').mockImplementationOnce(async (venueId, db) => {
      // Una sentencia que Postgres rechaza DENTRO de la transacción de captura: a partir de aquí la transacción está abortada.
      await (db as typeof prisma).$queryRaw`SELECT 1/0`
      return real(venueId, db)
    })
    const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
    expect(p.status).toBe('COMPLETED')
    const snapshot = ((await pago(p.id)).processorData as Record<string, unknown>).pricing as Record<string, unknown>
    expect(snapshot).toMatchObject({ merchantAccountId: M2.id, slot: null, venue: null })
    expect(JSON.stringify(snapshot.capturaFallida)).toMatch(/division by zero/)
    await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
    // Al «recuperarse» la base no se relee la tarifa de hoy: el marcador es durable.
    await expect(cerrar(p.id)).resolves.toBe(false)
    await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
    expect(((await pago(p.id)).processorData as Record<string, unknown>).pricing).toEqual(snapshot)
  })

  it('REST rápido · el escenario de Codex: M2 en SECONDARY sin tarifa, PRIMARY al 8 %, y al cobrar falla la consulta del PROVEEDOR ⇒ el cobro pasa, el snapshot es SIN_TARIFA (la evidencia del negocio) y el costo queda pendiente con AFFILIATION_PRICING_UNRESOLVED — nunca $80 de PRIMARY, tampoco al recuperarse la base', async () => {
    await secundariaVigente(false)
    fallaElProveedor()
    const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
    expect(p.status).toBe('COMPLETED')
    expect((await pago(p.id)).processorData).toMatchObject({
      pricing: { slot: 'SECONDARY', venue: null, provider: null, capturaFallida: { proveedor: 'ECONNRESET' } },
    })
    await pendienteSinLeer(p.id, 'AFFILIATION_PRICING_UNRESOLVED')
    await expect(cerrar(p.id)).resolves.toBe(false)
    await pendienteSinLeer(p.id, 'AFFILIATION_PRICING_UNRESOLVED')
  })

  it('REST rápido · falla la lectura de la TARIFA del negocio y la base se recupera: el cobro pasa, el snapshot dice `capturaFallida.negocio` (no «sin tarifa», no «sin snapshot»), el costo queda pendiente con PRICING_CAPTURE_FAILED y NO se relee la tarifa de hoy al recuperarse la base; un replay conserva el marcador', async () => {
    fallaLaTarifa()
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    const registro = {
      ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth, tarjeta }),
      merchantAccountId: M2.id,
    }
    const p = await recordFastPayment(f.venueId, registro, f.staffId)
    expect(p.status).toBe('COMPLETED')
    expect(p.merchantAccountId).toBe(M2.id)
    const antes = (await pago(p.id)).processorData as Record<string, unknown>
    expect(antes.pricing).toMatchObject({ slot: 'SECONDARY', venue: null, capturaFallida: { negocio: 'connection terminated' } })
    expect((antes.pricing as Record<string, unknown>).provider).not.toBeNull()
    await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
    // La base ya responde y SECONDARY tiene 2.5 % «a la fecha del cobro»: no se reconstruye la historia.
    await expect(cerrar(p.id)).resolves.toBe(false)
    await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
    // Un replay del mismo cobro (APK viejo, sin llave) no borra ni cambia el marcador.
    const replay = await recordFastPayment(f.venueId, { ...registro, attemptId: randomUUID() }, f.staffId)
    expect(replay.id).toBe(p.id)
    expect((await pago(p.id)).processorData).toHaveProperty('pricing', antes.pricing)
    await expect(cerrar(p.id)).resolves.toBe(false)
    await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
  })

  it('con orden · falla la lectura de la CONFIGURACIÓN al congelar: la cuenta queda pagada, el snapshot lleva `capturaFallida.configuracion`, el costo pendiente con PRICING_CAPTURE_FAILED y sigue así al recuperarse la base', async () => {
    fallaLaConfiguracion()
    const venta = await f.nuevaVenta(100)
    const p = await recordOrderPayment(f.venueId, venta.id, registroM2(), f.staffId)
    expect(p.status).toBe('COMPLETED')
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
    expect((await pago(p.id)).processorData).toMatchObject({
      pricing: { slot: null, venue: null, capturaFallida: { configuracion: 'ECONNRESET' } },
    })
    await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
    await expect(cerrar(p.id)).resolves.toBe(false)
    await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
  })

  it('WEBHOOK · falla la lectura de la TARIFA al congelar el cobro nacido del webhook: COMPLETED, `capturaFallida.negocio`, y el costo diferido queda pendiente con PRICING_CAPTURE_FAILED — nunca PRIMARY, tampoco al vencer el plazo con la base ya sana', async () => {
    fallaLaTarifa()
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(nacido.status).toBe('COMPLETED')
    expect(nacido.processorData).toMatchObject({
      pricing: { merchantAccountId: M2.id, slot: 'SECONDARY', venue: null, capturaFallida: { negocio: 'connection terminated' } },
    })
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
    await pendienteSinLeer(nacido.id, 'PRICING_CAPTURE_FAILED')
    expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(0)
    // Codex R12-3: con el método provisional la unidad ni siquiera entra (la puerta del worker anota el motivo del snapshot); el
    // REST tardío acredita el método y AHORA la UNIDAD, con la base ya sana, tiene que dejar el MISMO motivo — nunca recapturar.
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(nacido.id)
    expect((await pago(nacido.id)).processorData).toMatchObject({ methodProvisional: false })
    await pendienteSinLeer(nacido.id, 'PRICING_CAPTURE_FAILED')
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
    await pendienteSinLeer(nacido.id, 'PRICING_CAPTURE_FAILED')
  })

  it('el motivo PRICING_CAPTURE_FAILED es público: la lectura de efectos lo muestra tal cual (no «requiere revisión»)', async () => {
    fallaLaTarifa()
    const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
    const { listPaymentEffects } = await import('@/services/tpv/paymentEffectsRead.service')
    const r = await listPaymentEffects({ venueId: f.venueId, kind: 'TRANSACTION_COST', status: 'PENDING' })
    expect(r.items.find(i => i.paymentId === p.id)?.lastError).toBe('PRICING_CAPTURE_FAILED')
  })
})

describe('Codex R11-1 · la captura lee la configuración y la tarifa del negocio desde UNA MISMA vista consistente de la base: una reasignación del slot y una edición de la tarifa que se cuelan ENTRE las dos lecturas no pueden congelar M2 con una tarifa que M2 nunca tuvo', () => {
  const tarjeta = { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' }
  let M3: { id: string; externalMerchantId: string } | null = null
  const secundariaAl = (creditRate: number) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate } })
  afterEach(async () => {
    jest.restoreAllMocks()
    // Deshacer la intercalación: SECONDARY = M2 al 2.5 %.
    await prisma.venuePaymentConfig.update({
      where: { venueId: f.venueId },
      data: { primaryAccountId: f.merchantId, secondaryAccountId: M2.id },
    })
    await secundariaAl(0.025)
    await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { active: true } })
    await prisma.organizationPricingStructure.deleteMany({ where: { organizationId: f.fixture } })
  })
  const registroM2 = () => ({ ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }), merchantAccountId: M2.id })
  /**
   * La intercalación de Codex, DURANTE la captura: la configuración ya se leyó (M2 ocupa SECONDARY al 2.5 %) y, ANTES de leer
   * la tarifa, un administrador —por OTRA conexión, el cliente global— pone a M3 en SECONDARY y edita esa estructura al 8 %
   * EN SITIO (dos operaciones ordinarias del superadmin). Ninguna lectura falla. Devuelve si la intercalación llegó a ocurrir.
   */
  const intercalarEntreLasDosLecturas = () => {
    const leerConfiguracion = configuracionDePagos.getEffectivePaymentConfig
    let intercalado = false
    jest.spyOn(configuracionDePagos, 'getEffectivePaymentConfig').mockImplementationOnce(async (venueId, db) => {
      const leida = await leerConfiguracion(venueId, db)
      M3 = M3 ?? (await f.afiliacionSecundaria())
      await prisma.venuePaymentConfig.update({ where: { venueId: f.venueId }, data: { secondaryAccountId: M3.id } })
      await secundariaAl(0.08)
      intercalado = true
      return leida
    })
    return () => intercalado
  }
  const snapshotConsistente = async (paymentId: string) => {
    const datos = (await pago(paymentId)).processorData as Record<string, unknown>
    // La vista capturada: M2 en SECONDARY con el 2.5 % — nunca «M2 con el 8 % que sólo tuvo M3».
    expect(datos.pricing).toMatchObject({
      merchantAccountId: M2.id,
      slot: 'SECONDARY',
      venue: { accountType: 'SECONDARY', creditRate: '0.025' },
      provider: { creditRate: '0.02' },
    })
    expect(datos.pricing).not.toHaveProperty('capturaFallida')
  }
  const costoEsAl25 = async (paymentId: string) => {
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId } }))
    expect(costo.merchantAccountId).toBe(M2.id)
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(Number(costo.venueChargeAmount)).toBeCloseTo(2.5, 4)
    const p = await pago(paymentId)
    expect(Number(p.feeAmount)).toBe(3) // $100 × 2.5 % + $0.50 — no $8.50
    expect(Number(p.netAmount)).toBe(97)
  }
  /** Codex R12-17: lo que el REST promete es costo SÍNCRONO — se afirma INMEDIATAMENTE después del registro, antes de reparar nada. */
  const costoSincronoAl25 = async (paymentId: string) => {
    await costoEsAl25(paymentId)
    expect((await pago(paymentId)).processorData).toMatchObject({ costPending: false })
  }
  /** Convergencia (o cierre repetido): repara si hace falta y el resultado es el mismo 2.5 %. */
  const costoAl25 = async (paymentId: string, ahora = new Date()) => {
    await expect(cerrar(paymentId, ahora)).resolves.toBe(true)
    await costoEsAl25(paymentId)
  }

  it('REST rápido · entre las dos lecturas M3 sustituye a M2 en SECONDARY y esa tarifa pasa al 8 %: el snapshot es M2 + SECONDARY + 2.5 % (la vista capturada), el costo síncrono cobra $2.50 + $0.50 — NUNCA $8', async () => {
    const ocurrio = intercalarEntreLasDosLecturas()
    const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
    expect(ocurrio()).toBe(true)
    expect(p.status).toBe('COMPLETED')
    expect(p.merchantAccountId).toBe(M2.id)
    // Hoy SECONDARY es de M3 al 8 %: la configuración de hoy ya no describe el cobro, y el snapshot no la refleja.
    expect((await exigir(prisma.venuePaymentConfig.findUnique({ where: { venueId: f.venueId } }))).secondaryAccountId).toBe(M3!.id)
    await snapshotConsistente(p.id)
    // Codex R12-17: síncrono de verdad — el costo y fee/net ya están escritos al volver el REST; el cierre repetido no los mueve.
    await costoSincronoAl25(p.id)
    await costoAl25(p.id)
  })

  it('con orden · la misma intercalación por el registrador con orden: la cuenta queda pagada, el snapshot es M2 + 2.5 % y el costo converge al 2.5 %', async () => {
    const ocurrio = intercalarEntreLasDosLecturas()
    const venta = await f.nuevaVenta(100)
    const p = await recordOrderPayment(f.venueId, venta.id, registroM2(), f.staffId)
    expect(ocurrio()).toBe(true)
    expect(p.status).toBe('COMPLETED')
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
    await snapshotConsistente(p.id)
    await costoSincronoAl25(p.id)
    await costoAl25(p.id)
  })

  it('WEBHOOK · el cobro nacido del webhook pasa por la misma captura: con la intercalación, snapshot M2 + 2.5 % y el costo diferido converge al 2.5 %', async () => {
    const ocurrio = intercalarEntreLasDosLecturas()
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
    expect(ocurrio()).toBe(true)
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(nacido.status).toBe('COMPLETED')
    await snapshotConsistente(nacido.id)
    // Codex R12-3: el REST acredita el método; el snapshot (M2 + 2.5 %) ya estaba congelado y no se toca.
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(nacido.id)
    await snapshotConsistente(nacido.id)
    await costoAl25(nacido.id, enTresHoras())
  })

  it('ORGANIZACIÓN · la tarifa SECONDARY es HEREDADA de la organización (el venue no tiene la suya): la organización la edita al 8 % ENTRE las dos lecturas y el snapshot sigue siendo 2.5 % (origen organización, la vista capturada); el costo síncrono cobra $2.50 + $0.50', async () => {
    // El venue deja de tener SECONDARY propia; la organización la aporta al 2.5 %.
    await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { active: false } })
    const heredada = await prisma.organizationPricingStructure.create({
      data: {
        organizationId: f.fixture,
        accountType: 'SECONDARY',
        debitRate: 0.025,
        creditRate: 0.025,
        amexRate: 0.025,
        internationalRate: 0.025,
        includesTax: true,
        fixedFeePerTransaction: 0.5,
        effectiveFrom: new Date('2025-01-01T00:00:00Z'),
        active: true,
      },
    })
    // La intercalación, DURANTE la captura: la configuración ya se leyó y, ANTES de leer la tarifa (que caerá a la de la
    // organización), la organización la edita al 8 % EN SITIO por otra conexión. La lectura de la organización también tiene
    // que salir de la MISMA vista de la captura — no del cliente global.
    const leerConfiguracion = configuracionDePagos.getEffectivePaymentConfig
    let intercalado = false
    jest.spyOn(configuracionDePagos, 'getEffectivePaymentConfig').mockImplementationOnce(async (venueId, db) => {
      const leida = await leerConfiguracion(venueId, db)
      await prisma.organizationPricingStructure.update({ where: { id: heredada.id }, data: { creditRate: 0.08 } })
      intercalado = true
      return leida
    })
    const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
    expect(intercalado).toBe(true)
    expect(p.status).toBe('COMPLETED')
    const datos = (await pago(p.id)).processorData as Record<string, unknown>
    expect(datos.pricing).toMatchObject({
      merchantAccountId: M2.id,
      slot: 'SECONDARY',
      venue: { accountType: 'SECONDARY', source: 'organization', creditRate: '0.025' },
    })
    expect(datos.pricing).not.toHaveProperty('capturaFallida')
    // Hoy la organización ya dice 8 %: el snapshot no la refleja, y el costo síncrono cobró con la vista capturada.
    expect(Number((await exigir(prisma.organizationPricingStructure.findUnique({ where: { id: heredada.id } }))).creditRate)).toBeCloseTo(
      0.08,
      6,
    )
    await costoSincronoAl25(p.id)
    expect((await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))).venuePricingStructureId).toBeNull()
    await costoAl25(p.id)
  })

  it('Codex R11 (P2) · un `pricing: null` CON afiliación (dato viejo o alterado) SOBREVIVE a un replay normal: la consolidación no lo borra, el lector sigue diciendo INVALIDO y la obligación queda pendiente con INVALID_PRICING_SNAPSHOT — nunca «sin snapshot» ⇒ tarifa de hoy', async () => {
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    jest.spyOn(configuracionDePagos, 'getEffectivePricingForSlot').mockRejectedValueOnce(new Error('connection terminated'))
    const registro = {
      ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth, tarjeta }),
      merchantAccountId: M2.id,
    }
    const p = await recordFastPayment(f.venueId, registro, f.staffId)
    expect(p.status).toBe('COMPLETED')
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING' })
    // El dato que R10 protege: un escritor viejo (o una mano) dejó `pricing: null` en un cobro CON afiliación.
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || '{"pricing": null}'::jsonb WHERE "id" = ${p.id}`
    expect((await pago(p.id)).processorData).toHaveProperty('pricing', null)
    await expect(cerrar(p.id)).resolves.toBe(false)
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'INVALID_PRICING_SNAPSHOT' })
    // Un replay NORMAL del mismo cobro (APK viejo, sin llave, con datos de tarjeta) consolida sobre el MISMO Payment…
    const replay = await recordFastPayment(f.venueId, { ...registro, attemptId: randomUUID() }, f.staffId)
    expect(replay.id).toBe(p.id)
    // …y el `pricing: null` sigue ahí: la limpieza de nulos sólo toca lo que el relleno completa, nunca el snapshot.
    expect((await pago(p.id)).processorData).toHaveProperty('pricing', null)
    await expect(cerrar(p.id)).resolves.toBe(false)
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'INVALID_PRICING_SNAPSHOT' })
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    expect(Number((await pago(p.id)).feeAmount)).toBe(0)
  })
})

describe('Codex R13 (cobertura) · CONSOLIDACIÓN de un registro repetido: el snapshot se conserva EXACTAMENTE en sus cuatro estados (VALIDO / SIN_TARIFA / CAPTURA_FALLIDA / INVALIDO) y `costPending` nunca se copia de una lectura obsoleta', () => {
  const tarjeta = { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' }
  const secundariaVigente = (active: boolean) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { active } })
  afterEach(async () => {
    jest.restoreAllMocks()
    await secundariaVigente(true)
    await f.conLiquidacion(M2.id)
  })
  const snapshotDe = async (id: string) => ((await pago(id)).processorData as Record<string, unknown>).pricing
  const legacyM2 = (ref: string, auth: string, extra: Record<string, unknown> = {}) => ({
    ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref, auth, tarjeta }),
    merchantAccountId: M2.id,
    ...extra,
  })
  /** El replay NORMAL de un APK viejo: sin llave, misma referencia y autorización, con datos de tarjeta que ENRIQUECEN. */
  const replayDe = (ref: string, auth: string) => legacyM2(ref, auth, { last4: '1234', bank: 'BANCO DE PRUEBA', typeOfCard: 'CREDIT' })

  // Tabla tipada (no `as const`): con la aserción constante TypeScript no puede inferir el tipo de retorno de las preparaciones
  // dentro de la tabla que `it.each` recibe (TS7024, «referenced directly or indirectly in one of its return expressions»).
  const casosDeSnapshot: [string, () => Promise<void>, { estado: string }][] = [
    ['VALIDO (M2 en SECONDARY al 2.5 %)', async () => undefined, { estado: 'VALIDO' }],
    [
      'SIN_TARIFA (SECONDARY sin estructura vigente al cobrar)',
      async () => void (await secundariaVigente(false)),
      { estado: 'SIN_TARIFA' },
    ],
    [
      'CAPTURA_FALLIDA (la lectura de la tarifa falló al cobrar)',
      async () =>
        void jest.spyOn(configuracionDePagos, 'getEffectivePricingForSlot').mockRejectedValueOnce(new Error('connection terminated')),
      { estado: 'CAPTURA_FALLIDA' },
    ],
  ]
  it.each(casosDeSnapshot)(
    'snapshot %s: un replay normal consolida SIN tocar el snapshot (byte a byte) ni su lectura',
    async (_n, preparar, lectura) => {
      const R = `${Date.now()}`
      const auth = `AUTH-${R.slice(-6)}`
      await preparar()
      const p = await recordFastPayment(f.venueId, legacyM2(R, auth), f.staffId)
      expect(p.status).toBe('COMPLETED')
      const antes = await snapshotDe(p.id)
      expect(costoDeTransaccion.leerTarifaCongelada({ pricing: antes as never }, M2.id)).toMatchObject(lectura)
      // Hoy la tarifa es otra (8 %): un snapshot sustituido o perdido se notaría en la relectura.
      await prisma.venuePricingStructure.updateMany({
        where: { venueId: f.venueId, accountType: 'SECONDARY' },
        data: { creditRate: 0.08, active: true },
      })
      try {
        const replay = await recordFastPayment(f.venueId, replayDe(R, auth), f.staffId)
        expect(replay.id).toBe(p.id)
        expect(await snapshotDe(p.id)).toEqual(antes)
        expect(costoDeTransaccion.leerTarifaCongelada({ pricing: (await snapshotDe(p.id)) as never }, M2.id)).toMatchObject(lectura)
        // El enriquecimiento sí llegó (la consolidación escribió): sólo el snapshot es intocable.
        expect((await pago(p.id)).processorData).toMatchObject({ last4: '1234', bank: 'BANCO DE PRUEBA' })
      } finally {
        await prisma.venuePricingStructure.updateMany({
          where: { venueId: f.venueId, accountType: 'SECONDARY' },
          data: { creditRate: 0.025 },
        })
      }
    },
  )

  it('snapshot INVALIDO (`pricing: null` con afiliación): un replay normal lo conserva tal cual — el lector sigue diciendo INVALIDO', async () => {
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    const p = await recordFastPayment(f.venueId, legacyM2(R, auth), f.staffId)
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || '{"pricing": null}'::jsonb WHERE "id" = ${p.id}`
    expect(costoDeTransaccion.leerTarifaCongelada({ pricing: null }, M2.id)).toMatchObject({ estado: 'INVALIDO' })
    const replay = await recordFastPayment(f.venueId, replayDe(R, auth), f.staffId)
    expect(replay.id).toBe(p.id)
    expect((await pago(p.id)).processorData).toHaveProperty('pricing', null)
    expect((await pago(p.id)).processorData).toMatchObject({ last4: '1234' })
  })

  it('`costPending` NO se copia de una lectura obsoleta: la obligación converge (costPending: false, DONE) ENTRE la lectura previa del replay y su consolidación bajo el candado — después del replay sigue false y DONE', async () => {
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    // El costo síncrono del registro NO converge (sin configuración de liquidación): costPending true, obligación PENDING.
    await f.sinLiquidacion(M2.id)
    const p = await recordFastPayment(f.venueId, legacyM2(R, auth), f.staffId)
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: true })
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'AWAITING_SETTLEMENT_CONFIGURATION' })
    await f.conLiquidacion(M2.id)
    // Intercalación: con la lectura previa del candidato YA hecha por el registrador y ANTES de que la consolidación tome la fila,
    // la obligación converge por otra conexión (costPending: false, DONE). La consolidación tiene que decidir sobre la fila VIGENTE.
    const realConsolidar = moduloRepetido.consolidarRegistroRepetidoDetallado
    let convergioEnMedio: string | null = null
    jest.spyOn(moduloRepetido, 'consolidarRegistroRepetidoDetallado').mockImplementationOnce(async (...args) => {
      convergioEnMedio = await asegurarCostoSincrono(p.id)
      return realConsolidar(...args)
    })
    const replay = await recordFastPayment(f.venueId, replayDe(R, auth), f.staffId)
    expect(replay.id).toBe(p.id)
    expect(convergioEnMedio).toBe('CUMPLIDA')
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: false, last4: '1234' })
    expect(await efectoDe(p.id)).toMatchObject({ status: 'DONE' })
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
  })
})

describe('Codex R12 (pasada exhaustiva) · la familia de la tarifa congelada: afiliación en DOS slots (R12-2), VALIDO sin configuración de hoy (R12-8), el plazo no acredita el tipo de tarjeta (R12-3), consulta acotada del slot (R12-14)', () => {
  const tarjeta = { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' }
  const registroM2 = (extra: Record<string, unknown> = {}) => ({
    ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta }),
    merchantAccountId: M2.id,
    ...extra,
  })
  const configuracionBase = () =>
    prisma.venuePaymentConfig.upsert({
      where: { venueId: f.venueId },
      update: { primaryAccountId: f.merchantId, secondaryAccountId: M2.id, tertiaryAccountId: null },
      create: { venueId: f.venueId, primaryAccountId: f.merchantId, secondaryAccountId: M2.id },
    })
  const pendienteSinLeer = async (paymentId: string, motivo: string) => {
    expect(await prisma.transactionCost.count({ where: { paymentId } })).toBe(0)
    expect(await efectoDe(paymentId)).toMatchObject({ status: 'PENDING', lastError: motivo })
    expect((await pago(paymentId)).processorData).toMatchObject({ costPending: true })
    expect(Number((await pago(paymentId)).feeAmount)).toBe(0)
  }
  afterEach(async () => {
    jest.restoreAllMocks()
    await configuracionBase()
    await prisma.organizationPaymentConfig.deleteMany({ where: { organizationId: f.fixture } })
    await prisma.venuePricingStructure.deleteMany({
      where: { venueId: f.venueId, accountType: 'SECONDARY', effectiveFrom: { gt: new Date('2025-01-01T00:00:00Z') } },
    })
  })

  describe('R12-2 · la afiliación ocupa DOS slots (PRIMARY al 8 % y SECONDARY al 2.5 %): nadie elige — captura fallida por configuración ambigua, pendiente y visible', () => {
    // La configuración ambigua sólo puede existir como dato HISTÓRICO (el CHECK `VenuePaymentConfig_slots_distintos`, NOT VALID,
    // impide escribirla desde ahora): la prueba la fabrica soltando el CHECK un instante y volviéndolo a poner, tal como quedan
    // las filas anteriores a la migración.
    const CHECK_SLOTS =
      'CHECK (("secondaryAccountId" IS NULL OR "secondaryAccountId" <> "primaryAccountId") AND ("tertiaryAccountId" IS NULL OR "tertiaryAccountId" <> "primaryAccountId") AND ("secondaryAccountId" IS NULL OR "tertiaryAccountId" IS NULL OR "secondaryAccountId" <> "tertiaryAccountId")) NOT VALID'
    const enDosSlots = async () => {
      await prisma.$executeRawUnsafe('ALTER TABLE "VenuePaymentConfig" DROP CONSTRAINT IF EXISTS "VenuePaymentConfig_slots_distintos"')
      try {
        await prisma.venuePaymentConfig.update({
          where: { venueId: f.venueId },
          data: { primaryAccountId: M2.id, secondaryAccountId: M2.id },
        })
      } finally {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "VenuePaymentConfig" ADD CONSTRAINT "VenuePaymentConfig_slots_distintos" ${CHECK_SLOTS}`,
        )
      }
    }

    it('el CHECK de la base rechaza ESCRIBIR la misma afiliación en dos slots (el respaldo contra dos ediciones concurrentes); las filas históricas quedan como están', async () => {
      await expect(
        prisma.venuePaymentConfig.update({ where: { venueId: f.venueId }, data: { primaryAccountId: M2.id, secondaryAccountId: M2.id } }),
      ).rejects.toThrow(/slots_distintos|check constraint/i)
      await expect(
        prisma.organizationPaymentConfig.create({ data: { organizationId: f.fixture, primaryAccountId: M2.id, tertiaryAccountId: M2.id } }),
      ).rejects.toThrow(/slots_distintos|check constraint/i)
    })

    it('REST rápido: el cobro pasa (COMPLETED), el snapshot dice `capturaFallida.configuracion: AFILIACION_EN_VARIOS_SLOTS`, ninguna tarifa se lee y el costo queda PENDING con PRICING_CAPTURE_FAILED — ni $8 ni $2.50 de comisión arbitraria', async () => {
      await enDosSlots()
      const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
      expect(p.status).toBe('COMPLETED')
      expect((await pago(p.id)).processorData).toMatchObject({
        pricing: {
          merchantAccountId: M2.id,
          slot: null,
          venue: null,
          capturaFallida: { configuracion: expect.stringMatching(/AFILIACION_EN_VARIOS_SLOTS: PRIMARY,SECONDARY/) },
        },
      })
      await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
      await expect(cerrar(p.id)).resolves.toBe(false)
      await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
    })

    it('con orden: la cuenta queda PAGADA y el costo pendiente con el motivo visible', async () => {
      await enDosSlots()
      const venta = await f.nuevaVenta(100)
      const p = await recordOrderPayment(f.venueId, venta.id, registroM2(), f.staffId)
      expect(p.status).toBe('COMPLETED')
      expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
      await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
    })

    it('WEBHOOK: el cobro nacido del webhook con la afiliación en dos slots también queda pendiente con el motivo, nunca con una comisión elegida por orden', async () => {
      await enDosSlots()
      const R = `${Date.now()}`
      const solicitud = await f.solicitud()
      const A = await vincular(solicitud.requestId)
      expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
      const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
      expect(nacido.processorData).toMatchObject({
        pricing: { capturaFallida: { configuracion: expect.stringMatching(/AFILIACION_EN_VARIOS_SLOTS/) } },
      })
      await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
      expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(0)
    })

    it('un Payment SIN snapshot (anterior al registrador, con `pricingSlot` legacy) y la afiliación HOY en dos slots: el costo no se calcula con ninguno — pendiente con PRICING_CAPTURE_FAILED', async () => {
      const espia = jest.spyOn(costoDeTransaccion, 'createTransactionCost').mockRejectedValueOnce(new Error('ECONNRESET'))
      const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
      espia.mockRestore()
      // Se le quita el snapshot (dato anterior al registrador) y se le deja el slot legacy; la obligación sigue PENDING.
      await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" - 'pricing' WHERE "id" = ${p.id}`
      expect((await pago(p.id)).processorData).toMatchObject({ pricingSlot: 'SECONDARY', costPending: true })
      await enDosSlots()
      await expect(cerrar(p.id)).resolves.toBe(false)
      await pendienteSinLeer(p.id, 'PRICING_CAPTURE_FAILED')
    })
  })

  describe('R12-8 · un snapshot VALIDO converge SIN la configuración de pagos de hoy', () => {
    it('el negocio borra su configuración de pagos (venue y organización) después del cobro: el costo converge con la tarifa CONGELADA (2.5 %), la afiliación se resuelve por `findUnique` y la configuración no se consulta', async () => {
      const espia = jest.spyOn(costoDeTransaccion, 'createTransactionCost').mockRejectedValueOnce(new Error('ECONNRESET'))
      const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
      espia.mockRestore()
      expect((await pago(p.id)).processorData).toMatchObject({ pricing: { slot: 'SECONDARY', venue: { creditRate: '0.025' } } })
      await prisma.venuePaymentConfig.deleteMany({ where: { venueId: f.venueId } })
      await prisma.organizationPaymentConfig.deleteMany({ where: { organizationId: f.fixture } })
      const configuracion = jest.spyOn(configuracionDePagos, 'getEffectivePaymentConfig')
      await expect(cerrar(p.id)).resolves.toBe(true)
      expect(configuracion).not.toHaveBeenCalled()
      const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
      expect(costo.merchantAccountId).toBe(M2.id)
      expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
      expect(Number((await pago(p.id)).feeAmount)).toBe(3)
      expect((await pago(p.id)).processorData).toMatchObject({ costPending: false })
    })
  })

  describe('R12-3 · el PLAZO no acredita el tipo de tarjeta: el cobro nacido del webhook espera al REST de la terminal (escalando la espera), y el REST tardío decide débito / AMEX / internacional', () => {
    const casos: Array<[string, Record<string, unknown>, number, number]> = [
      ['DÉBITO (2 %)', { method: 'DEBIT_CARD', cardBrand: 'VISA' }, 0.02, 2.5],
      ['AMEX (3.5 %)', { method: 'CREDIT_CARD', cardBrand: 'AMERICAN_EXPRESS' }, 0.035, 4],
      ['INTERNACIONAL (4.5 %)', { method: 'CREDIT_CARD', cardBrand: 'VISA', isInternational: true }, 0.045, 5],
    ]
    for (const [nombre, tarjetaRest, tasa, fee] of casos) {
      it(`webhook primero → el plazo vence sin REST: la obligación sigue PENDING con AWAITING_ACCREDITED_CARD_DATA_OVERDUE (nada se calcula con el crédito inventado) → el REST tardío acredita ${nombre} y el costo converge con ESA tarifa`, async () => {
        const R = `${Date.now()}`
        const solicitud = await f.solicitud()
        const A = await vincular(solicitud.requestId)
        expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
        const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
        expect((nacido.processorData as Record<string, unknown>).methodProvisional).toBe(true)
        // Antes del plazo: espera (motivo visible, sin consumir intentos).
        await expect(cerrar(nacido.id)).resolves.toBe(false)
        expect(await efectoDe(nacido.id)).toMatchObject({ status: 'PENDING', lastError: 'AWAITING_ACCREDITED_CARD_DATA' })
        // Vencido el plazo: se ESCALA, no se calcula.
        await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
        expect(await efectoDe(nacido.id)).toMatchObject({ status: 'PENDING', lastError: 'AWAITING_ACCREDITED_CARD_DATA_OVERDUE' })
        expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(0)
        expect(Number((await pago(nacido.id)).feeAmount)).toBe(0)
        // El REST tardío de la terminal acredita el método/marca: el costo converge con la tarifa que corresponde.
        const rest = await recordFastPayment(
          f.venueId,
          {
            ...f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId, ref: R, tarjeta: { ...tarjeta, ...tarjetaRest } }),
            ...tarjetaRest,
            merchantAccountId: M2.id,
          },
          f.staffId,
        )
        expect(rest.id).toBe(nacido.id)
        expect((await pago(nacido.id)).processorData).toMatchObject({ methodProvisional: false })
        await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(true)
        const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: nacido.id } }))
        expect(Number(costo.venueRate)).toBeCloseTo(tasa, 6)
        expect(Number((await pago(nacido.id)).feeAmount)).toBe(fee)
        expect(Number((await pago(nacido.id)).netAmount)).toBe(100 - fee)
        const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: nacido.id } }))
        expect(Number(vt.feeAmount)).toBe(fee)
        expect((await pago(nacido.id)).processorData).toMatchObject({ costPending: false })
      })
    }

    it('carrera worker ↔ REST: con la fila del Payment tomada por la consolidación del REST, el worker no calcula (CONTENDIDO, sin consumir intento); al soltarla, el siguiente intento ya ve el método ACREDITADO por el REST', async () => {
      const R = `${Date.now()}`
      const solicitud = await f.solicitud()
      const A = await vincular(solicitud.requestId)
      expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
      const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
      let soltar!: () => void
      const suelto = new Promise<void>(r => (soltar = r))
      let tomado = false
      const candado = prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${nacido.id} FOR UPDATE`
          tomado = true
          await suelto
        },
        { timeout: 20_000 },
      )
      try {
        // La carrera se monta de verdad: el worker entra sólo cuando el candado YA está tomado (si entrara antes, vería la
        // fila libre y contestaría por el método provisional, no por la contención — otra pregunta).
        expect(await f.esperar(async () => tomado)).toBe(true)
        // El worker, con el plazo vencido, encuentra la fila tomada: no calcula con el método provisional ni con ningún otro.
        const { convergerCostoDeTransaccion } = await import('@/services/payments/deferredTransactionCost.service')
        await expect(convergerCostoDeTransaccion(nacido.id)).resolves.toBe('CONTENDIDO')
        expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(0)
      } finally {
        soltar()
        await candado
      }
      const rest = await recordFastPayment(
        f.venueId,
        {
          ...f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId, ref: R, tarjeta: { ...tarjeta, cardBrand: 'VISA' } }),
          method: 'DEBIT_CARD',
          merchantAccountId: M2.id,
        },
        f.staffId,
      )
      expect(rest.id).toBe(nacido.id)
      await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(true)
      expect(Number((await exigir(prisma.transactionCost.findUnique({ where: { paymentId: nacido.id } }))).venueRate)).toBeCloseTo(0.02, 6)
    })

    it('un llamador DIRECTO de la unidad de convergencia (sin pasar por el worker) tampoco calcula con el método provisional: PENDIENTE con AWAITING_ACCREDITED_CARD_DATA, sin costo ni comisión', async () => {
      const R = `${Date.now()}`
      const solicitud = await f.solicitud()
      const A = await vincular(solicitud.requestId)
      expect((await webhook(A, { transactionId: R }, M2)).result.action).toBe('CONFIRMED')
      const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
      expect((nacido.processorData as Record<string, unknown>).methodProvisional).toBe(true)
      // El criterio vive DENTRO de la unidad (no sólo en la puerta del worker): un backfill o un script que la llame directo
      // recibe la misma espera, con el motivo escrito, y no un costo de crédito sobre un cargo cuyo método nadie acreditó.
      const { convergerCostoDeTransaccion } = await import('@/services/payments/deferredTransactionCost.service')
      await expect(convergerCostoDeTransaccion(nacido.id)).resolves.toBe('PENDIENTE')
      expect(await efectoDe(nacido.id)).toMatchObject({ status: 'PENDING', lastError: 'AWAITING_ACCREDITED_CARD_DATA' })
      expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(0)
      expect(Number((await pago(nacido.id)).feeAmount)).toBe(0)
      expect((await pago(nacido.id)).processorData).toMatchObject({ costPending: true })
    })
  })

  describe('R12-14 · la captura resuelve el slot con una consulta ACOTADA (la estructura vigente ganadora), no con la lista entera', () => {
    it('con varias estructuras SECONDARY elegibles (una vigente más antigua y otra más reciente), la captura congela la más reciente y `getEffectivePricingForSlot` es la que se consulta', async () => {
      // Una segunda SECONDARY vigente, más reciente, al 3 %: gana por `effectiveFrom` desc (misma regla que la lista).
      await prisma.venuePricingStructure.create({
        data: {
          venueId: f.venueId,
          accountType: 'SECONDARY',
          debitRate: 0.03,
          creditRate: 0.03,
          amexRate: 0.03,
          internationalRate: 0.03,
          includesTax: true,
          fixedFeePerTransaction: 0.5,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          active: true,
        },
      })
      const acotada = jest.spyOn(configuracionDePagos, 'getEffectivePricingForSlot')
      const lista = jest.spyOn(configuracionDePagos, 'getEffectivePricing')
      const p = await recordFastPayment(f.venueId, registroM2(), f.staffId)
      expect(acotada).toHaveBeenCalled()
      expect(lista).not.toHaveBeenCalled()
      expect((await pago(p.id)).processorData).toMatchObject({ pricing: { slot: 'SECONDARY', venue: { creditRate: '0.03' } } })
      const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
      expect(Number(costo.venueRate)).toBeCloseTo(0.03, 6)
    })
  })
})

describe('Codex R12-1 · la tarifa de un cobro nacido del webhook se captura AL INGRESO (la primera evidencia bancaria aceptada) y viaja en el evento durable: S4 registra con ESA captura, nunca con la tarifa de horas después', () => {
  const secundariaAl = (creditRate: number) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate } })
  const secundariaVigente = (active: boolean) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { active } })
  /** S4 real: reclama y corre lo PENDING (el receptor dejó 60 s de exclusiva; la prueba la vence). */
  const correrWorker = async () => {
    await prisma.providerEventLog.updateMany({
      where: { eventId: { startsWith: `angelpay-${f.fixture}` }, status: 'PENDING' },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    })
    const claims = await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })
    const desenlaces: string[] = []
    for (const claim of claims) desenlaces.push(await runClaimedAngelPayEvent(claim))
    return desenlaces
  }
  const eventoDe = (eventId: string) => exigir(prisma.providerEventLog.findFirst({ where: { eventId: `angelpay-${eventId}` } }))
  const nacidoDe = (A: string) => exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
  let M3: { id: string; externalMerchantId: string } | null = null
  afterEach(async () => {
    jest.restoreAllMocks()
    await prisma.venuePaymentConfig.update({
      where: { venueId: f.venueId },
      data: { primaryAccountId: f.merchantId, secondaryAccountId: M2.id },
    })
    await secundariaVigente(true)
    await secundariaAl(0.025)
    await prisma.organizationPricingStructure.deleteMany({ where: { organizationId: f.fixture } })
  })

  it('el receptor captura la tarifa AL INGRESO y la persiste DENTRO del evento (`_avoqado.tarifaCongeladaAlIngreso`) antes de registrar; el Payment nace con exactamente ESA captura (mismo `frozenAt`)', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const { eventId } = await webhook(A, { transactionId: R }, M2)
    const evento = await eventoDe(eventId)
    const persistida = ((evento.payload as Record<string, unknown>)._avoqado as Record<string, unknown>).tarifaCongeladaAlIngreso as Record<
      string,
      unknown
    >
    expect(persistida).toMatchObject({
      slot: 'SECONDARY',
      pricing: { merchantAccountId: M2.id, venue: { accountType: 'SECONDARY', creditRate: '0.025' } },
    })
    const nacido = await nacidoDe(A)
    expect((nacido.processorData as Record<string, unknown>).pricing).toEqual(persistida.pricing)
  })

  it('el escenario de Codex: corte inmediatamente después del ingreso durable → un administrador edita SECONDARY al 8 % → S4 recupera: el Payment nace con la captura del INGRESO (2.5 %) y el costo converge a $2.50 + $0.50, nunca $8.50', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    // El proceso «muere» en el registro: el evento queda PENDING con su captura ya persistida.
    const corte = jest.spyOn(registrador, 'recordFastPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const { result, eventId } = await webhook(A, { transactionId: R }, M2)
    corte.mockRestore()
    expect(result.action).not.toBe('CONFIRMED')
    expect(await eventoDe(eventId)).toMatchObject({ status: 'PENDING' })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })).toBe(0)
    // Horas después: la estructura del mismo slot se edita EN SITIO al 8 %.
    await secundariaAl(0.08)
    expect(await correrWorker()).toEqual(['PROCESSED'])
    const nacido = await nacidoDe(A)
    expect(nacido.status).toBe('COMPLETED')
    expect(nacido.processorData).toMatchObject({ pricing: { merchantAccountId: M2.id, slot: 'SECONDARY', venue: { creditRate: '0.025' } } })
    expect((nacido.processorData as Record<string, unknown>).pricing).not.toHaveProperty('capturaFallida')
    // El REST acredita el método; el costo usa la tarifa HISTÓRICA.
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(nacido.id)
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(true)
    expect(Number((await exigir(prisma.transactionCost.findUnique({ where: { paymentId: nacido.id } }))).venueRate)).toBeCloseTo(0.025, 6)
    expect(Number((await pago(nacido.id)).feeAmount)).toBe(3)
  })

  it('corte tras el ingreso + el slot REASIGNADO (M3 ocupa SECONDARY y M2 sale de la configuración) antes de recuperar: S4 registra con la captura del ingreso (M2 en SECONDARY al 2.5 %), VALIDO, y converge al 2.5 %', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const corte = jest.spyOn(registrador, 'recordFastPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const { eventId } = await webhook(A, { transactionId: R }, M2)
    corte.mockRestore()
    expect(await eventoDe(eventId)).toMatchObject({ status: 'PENDING' })
    M3 = M3 ?? (await f.afiliacionSecundaria())
    await prisma.venuePaymentConfig.update({ where: { venueId: f.venueId }, data: { secondaryAccountId: M3.id } })
    await secundariaAl(0.08)
    expect(await correrWorker()).toEqual(['PROCESSED'])
    const nacido = await nacidoDe(A)
    expect(nacido.merchantAccountId).toBe(M2.id)
    expect(nacido.processorData).toMatchObject({ pricing: { merchantAccountId: M2.id, slot: 'SECONDARY', venue: { creditRate: '0.025' } } })
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(nacido.id)
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(true)
    expect(Number((await exigir(prisma.transactionCost.findUnique({ where: { paymentId: nacido.id } }))).venueRate)).toBeCloseTo(0.025, 6)
  })

  it('tarifa HEREDADA de la organización al ingreso (el venue no tiene SECONDARY propia) → la organización la edita al 8 % antes de recuperar: S4 registra con la captura del ingreso (2.5 %, origen organización) y converge al 2.5 %', async () => {
    await secundariaVigente(false)
    const heredada = await prisma.organizationPricingStructure.create({
      data: {
        organizationId: f.fixture,
        accountType: 'SECONDARY',
        debitRate: 0.025,
        creditRate: 0.025,
        amexRate: 0.025,
        internationalRate: 0.025,
        includesTax: true,
        fixedFeePerTransaction: 0.5,
        effectiveFrom: new Date('2025-01-01T00:00:00Z'),
        active: true,
      },
    })
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const corte = jest.spyOn(registrador, 'recordFastPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const { eventId } = await webhook(A, { transactionId: R }, M2)
    corte.mockRestore()
    const persistida = ((await eventoDe(eventId)).payload as Record<string, unknown>)._avoqado as Record<string, unknown>
    expect(persistida.tarifaCongeladaAlIngreso).toMatchObject({ pricing: { venue: { source: 'organization', creditRate: '0.025' } } })
    await prisma.organizationPricingStructure.update({ where: { id: heredada.id }, data: { creditRate: 0.08 } })
    expect(await correrWorker()).toEqual(['PROCESSED'])
    const nacido = await nacidoDe(A)
    expect(nacido.processorData).toMatchObject({ pricing: { venue: { source: 'organization', creditRate: '0.025' } } })
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(nacido.id)
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(true)
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: nacido.id } }))
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(costo.venuePricingStructureId).toBeNull()
  })

  it('un evento recuperable SIN captura al ingreso (anterior a esta regla): S4 registra el cobro con el marcador `capturaFallida.total: SIN_CAPTURA_AL_INGRESO` — pendiente con PRICING_CAPTURE_FAILED, nunca VALIDO desde la configuración de hoy', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const R = `${Date.now()}`
    const eventId = f.nuevoEventId()
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${eventId}`,
        type: 'send_transaction',
        payload: { ...f.eventoAngelPay(A, { transactionId: R }), _avoqado: { receivedByMerchantAccountId: M2.id } } as never,
        venueId: f.venueId,
        status: 'PENDING',
        attemptId: A,
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    })
    expect(await correrWorker()).toEqual(['PROCESSED'])
    const nacido = await nacidoDe(A)
    expect(nacido.status).toBe('COMPLETED')
    expect(nacido.processorData).toMatchObject({
      pricing: {
        merchantAccountId: M2.id,
        slot: null,
        venue: null,
        capturaFallida: { total: expect.stringMatching(/SIN_CAPTURA_AL_INGRESO/) },
      },
    })
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(nacido.id)
    await expect(cerrar(nacido.id, enTresHoras())).resolves.toBe(false)
    expect(await efectoDe(nacido.id)).toMatchObject({ status: 'PENDING', lastError: 'PRICING_CAPTURE_FAILED' })
    expect(await prisma.transactionCost.count({ where: { paymentId: nacido.id } })).toBe(0)
  })
})

describe('Codex R13-1 · el REST que CREA con la misma llave ANTES de S4 consume la captura del INGRESO durable (la primera evidencia bancaria aceptada del mismo cargo), nunca captura «ahora»; un evento pertinente SIN captura conserva la incertidumbre; sin evento previo, captura al cobrar', () => {
  const secundariaAl = (creditRate: number) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate } })
  const correrWorker = async () => {
    await prisma.providerEventLog.updateMany({
      where: { eventId: { startsWith: `angelpay-${f.fixture}` }, status: 'PENDING' },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    })
    const claims = await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })
    const desenlaces: string[] = []
    for (const claim of claims) desenlaces.push(await runClaimedAngelPayEvent(claim))
    return desenlaces
  }
  const eventoDe = (eventId: string) => exigir(prisma.providerEventLog.findFirst({ where: { eventId: `angelpay-${eventId}` } }))
  const capturaPersistida = async (eventId: string) =>
    ((await eventoDe(eventId)).payload as Record<string, unknown>)._avoqado as Record<string, unknown>
  const snapshotDe = (p: { processorData: unknown }) => (p.processorData as Record<string, unknown>).pricing as Record<string, unknown>
  /** Ingreso durable de A por M2 (2.5 %) cuyo registrador «muere»: evento PENDING con su captura persistida, sin Payment. */
  const ingresoDurableSinPayment = async (A: string, R: string) => {
    const corte = jest.spyOn(registrador, 'recordFastPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const corteOrden = jest.spyOn(registrador, 'recordOrderPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const { result, eventId } = await webhook(A, { transactionId: R }, M2)
    corte.mockRestore()
    corteOrden.mockRestore()
    expect(result.action).not.toBe('CONFIRMED')
    expect(await eventoDe(eventId)).toMatchObject({ status: 'PENDING' })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })).toBe(0)
    const persistida = await capturaPersistida(eventId)
    expect(persistida.tarifaCongeladaAlIngreso).toMatchObject({ slot: 'SECONDARY', pricing: { venue: { creditRate: '0.025' } } })
    return { eventId, captura: persistida.tarifaCongeladaAlIngreso as { pricing: Record<string, unknown> } }
  }
  afterEach(async () => {
    jest.restoreAllMocks()
    await secundariaAl(0.025)
  })

  it('venta rápida · corte tras el ingreso → SECONDARY editada al 8 % → el REST con la MISMA llave llega ANTES de S4: el Payment nace con la captura del INGRESO (2.5 %, mismo `frozenAt`), el costo síncrono es $3 (no $8.50) y S4 encuentra después ese Payment y conserva el snapshot', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const { eventId, captura } = await ingresoDurableSinPayment(A, R)
    await secundariaAl(0.08)
    const p = await restQueAcredita(A, solicitud.requestId, R)
    expect(p.status).toBe('COMPLETED')
    expect(snapshotDe(p)).toEqual(captura.pricing)
    expect(snapshotDe(p)).toMatchObject({ merchantAccountId: M2.id, slot: 'SECONDARY', venue: { creditRate: '0.025' } })
    expect(snapshotDe(p).frozenAt).toBe(captura.pricing.frozenAt)
    // El costo síncrono del REST ya convergió con la tarifa HISTÓRICA: $2.50 + $0.50.
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
    expect(Number((await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))).venueRate)).toBeCloseTo(0.025, 6)
    // Después: el evento queda PROCESSED apuntando a ESE Payment (lo estampa el backfill del REST o lo retoma S4 — lo que siga
    // PENDING lo reclama el worker) y el snapshot sigue siendo el del ingreso; no nace un segundo Payment.
    await correrWorker()
    expect(await f.esperar(async () => (await eventoDe(eventId)).status === 'PROCESSED', 5000)).toBe(true)
    expect(await eventoDe(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(snapshotDe(await pago(p.id))).toEqual(captura.pricing)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })).toBe(1)
  })

  it('con ORDEN · el mismo escenario por `recordOrderPayment`: el Payment nace con la captura del ingreso (2.5 %, mismo `frozenAt`), fee $3, y S4 lo conserva', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const A = await vincular(solicitud.requestId)
    const { eventId, captura } = await ingresoDurableSinPayment(A, R)
    await secundariaAl(0.08)
    const p = await recordOrderPayment(
      f.venueId,
      venta.id,
      {
        ...f.registroDeLaTerminal({
          attemptId: A,
          requestId: solicitud.requestId,
          ref: R,
          tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' },
        }),
        merchantAccountId: M2.id,
      },
      f.staffId,
    )
    expect(p.status).toBe('COMPLETED')
    expect(p.orderId).toBe(venta.id)
    expect(snapshotDe(p)).toEqual(captura.pricing)
    expect(snapshotDe(p).frozenAt).toBe(captura.pricing.frozenAt)
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
    await correrWorker()
    expect(await f.esperar(async () => (await eventoDe(eventId)).status === 'PROCESSED', 5000)).toBe(true)
    expect(await eventoDe(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(snapshotDe(await pago(p.id))).toEqual(captura.pricing)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })).toBe(1)
  })

  it('evento pertinente SIN captura (anterior a la regla) y el REST llega antes de S4: el cobro nace con `capturaFallida.total: SIN_CAPTURA_AL_INGRESO` — pendiente con PRICING_CAPTURE_FAILED, sin costo, nunca VALIDO desde la configuración de hoy', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const R = `${Date.now()}`
    const eventId = f.nuevoEventId()
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${eventId}`,
        type: 'send_transaction',
        payload: { ...f.eventoAngelPay(A, { transactionId: R }), _avoqado: { receivedByMerchantAccountId: M2.id } } as never,
        venueId: f.venueId,
        status: 'PENDING',
        attemptId: A,
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    })
    const p = await restQueAcredita(A, solicitud.requestId, R)
    expect(p.status).toBe('COMPLETED')
    expect(snapshotDe(p)).toMatchObject({
      merchantAccountId: M2.id,
      slot: null,
      venue: null,
      capturaFallida: { total: expect.stringMatching(/SIN_CAPTURA_AL_INGRESO/) },
    })
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'PRICING_CAPTURE_FAILED' })
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    expect((await pago(p.id)).processorData).toMatchObject({ costPending: true })
    await correrWorker()
    expect(await f.esperar(async () => (await eventoDe(eventId)).status === 'PROCESSED', 5000)).toBe(true)
    expect(await eventoDe(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(snapshotDe(await pago(p.id))).toMatchObject({ capturaFallida: { total: expect.stringMatching(/SIN_CAPTURA_AL_INGRESO/) } })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })).toBe(1)
  })

  it('CONTROL · sin evento previo del intento, el REST captura AL COBRAR (la tarifa vigente: 8 % ⇒ fee $8.50)', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    await secundariaAl(0.08)
    const p = await restQueAcredita(A, solicitud.requestId, R)
    expect(snapshotDe(p)).toMatchObject({ merchantAccountId: M2.id, slot: 'SECONDARY', venue: { creditRate: '0.08' } })
    expect(snapshotDe(p)).not.toHaveProperty('capturaFallida')
    expect(Number((await pago(p.id)).feeAmount)).toBe(8.5)
  })

  it('PERTENENCIA · el evento durable del intento fue recibido por OTRA afiliación (M2) y el REST atribuye el cobro a PRIMARY: la captura de M2 no se consume ni se captura «ahora» — el costo queda pendiente con motivo (`EVIDENCIA_DE_INGRESO_DE_OTRA_AFILIACION`)', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    await ingresoDurableSinPayment(A, R)
    const p = await restQueAcredita(A, solicitud.requestId, R, { id: f.merchantId, externalMerchantId: f.merchantExternalId })
    expect(p.status).toBe('COMPLETED')
    expect(p.merchantAccountId).toBe(f.merchantId)
    expect(snapshotDe(p)).toMatchObject({
      merchantAccountId: f.merchantId,
      slot: null,
      venue: null,
      capturaFallida: { total: expect.stringMatching(/EVIDENCIA_DE_INGRESO_DE_OTRA_AFILIACION/) },
    })
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'PRICING_CAPTURE_FAILED' })
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
  })
})

/**
 * Codex R16-2: OBSERVATORIO del candado del intento. Instrumenta `prisma.$transaction` (un Proxy sobre el cliente de cada
 * transacción) para registrar, desde la PROPIA conexión de cada actor, quién PIDE el candado de qué intento (`pg_backend_pid()` justo
 * antes de la sentencia `pg_advisory_xact_lock(NS_CANDADO_INTENTO, hashtext(llave))`) y a quién le fue CONCEDIDO (cuando la sentencia
 * vuelve). Con eso la espera se ATRIBUYE en vez de inferirse de «algún advisory sin conceder» (cualquier pid, cualquier llave): el
 * actor es un pid que pidió ESA llave y aún no la tiene; el poseedor, el pid al que ESA llave le fue concedida; y en `pg_locks` (esta
 * base, el `classid` del namespace, el `objid` de la llave) el actor figura sin conceder con el poseedor entre `pg_blocking_pids`. Un
 * waiter ajeno —otra llave, otro bloqueador— no la satisface (contraprueba abajo). Opcionalmente pausa un actor DENTRO de su
 * transacción justo después de la sentencia que lleva un marcador SQL (`pausarTras`), como hacía `pausarElIngreso`.
 */
type PeticionDeCandado = { pid: number; llave: string; concedido: boolean }
type EsperaAtribuida = { actor: number; poseedor: number }
const observatorioDeCandados = (
  opciones: { pausarTras?: { marcador: string; b: { pausado: () => void; liberada: Promise<void> } } } = {},
) => {
  const peticiones: PeticionDeCandado[] = []
  const realTx = prisma.$transaction.bind(prisma)
  let pausado = false
  jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, opts?: unknown) => {
    if (typeof fn !== 'function') return realTx(fn as never, opts as never)
    return realTx(async (tx: any) => {
      const proxy = new Proxy(tx, {
        get: (objetivo, prop) =>
          prop === '$queryRaw'
            ? async (...args: any[]) => {
                const sql = Array.isArray(args[0]) ? args[0].join('?') : ''
                let peticion: PeticionDeCandado | null = null
                if (sql.includes('pg_advisory_xact_lock(') && args[1] === NS_CANDADO_INTENTO && typeof args[2] === 'string') {
                  const [{ pid }] = await objetivo.$queryRaw`SELECT pg_backend_pid() AS pid`
                  peticion = { pid, llave: args[2], concedido: false }
                  peticiones.push(peticion)
                }
                const r = await objetivo.$queryRaw(...args)
                if (peticion) peticion.concedido = true
                if (opciones.pausarTras && sql.includes(opciones.pausarTras.marcador) && !pausado) {
                  pausado = true
                  opciones.pausarTras.b.pausado()
                  await opciones.pausarTras.b.liberada
                }
                return r
              }
            : Reflect.get(objetivo, prop),
      })
      return (fn as (t: unknown) => Promise<unknown>)(proxy)
    }, opts as never)
  }) as never)
  /** Los dos lados del candado consultivo de ESA llave en `pg_locks`: pid, si está concedido y quién lo bloquea. */
  const candadosDe = (llave: string) =>
    prisma.$queryRaw<{ pid: number; granted: boolean; bloqueadores: number[] }[]>`
      SELECT l.pid, l.granted, pg_blocking_pids(l.pid) AS bloqueadores
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = current_database() AND l.locktype = 'advisory' AND l.classid = ${NS_CANDADO_INTENTO}::oid AND l.objsubid = 2
        AND l.objid::bigint = ((hashtext(${llave})::bigint % 4294967296 + 4294967296) % 4294967296)`
  /**
   * La espera del candado del intento `llave`, atribuida, o `null`: exige un actor que PIDIÓ esa llave y no la tiene, un poseedor al
   * que esa llave le fue CONCEDIDA, y que en `pg_locks` el actor esté sin conceder sobre esa llave con el poseedor bloqueándolo.
   */
  const esperaAtribuida = async (llave: string): Promise<EsperaAtribuida | null> => {
    const poseedor = peticiones.find(pet => pet.llave === llave && pet.concedido)?.pid
    const actor = peticiones.find(pet => pet.llave === llave && !pet.concedido)?.pid
    if (poseedor === undefined || actor === undefined) return null
    const filas = await candadosDe(llave)
    const delActor = filas.find(fila => fila.pid === actor && !fila.granted)
    const delPoseedor = filas.find(fila => fila.pid === poseedor && fila.granted)
    return delActor && delPoseedor && delActor.bloqueadores.includes(poseedor) ? { actor, poseedor } : null
  }
  return { peticiones, esperaAtribuida }
}

describe('Codex R14-1 · la PRIMERA evidencia durable del intento gobierna la tarifa para TODOS los orígenes (webhook, S4 y REST), la selección va serializada con el ingreso (candado del intento) y el primer aprobado se elige ANTES de cualquier límite', () => {
  const secundariaAl = (creditRate: number) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate } })
  const eventoDe = (eventId: string) => exigir(prisma.providerEventLog.findFirst({ where: { eventId: `angelpay-${eventId}` } }))
  /** La captura persistida al ingreso del evento; si el evento viaja SIN ella, cae por ASERCIÓN (nunca un TypeError sobre `undefined`). */
  const capturaDe = async (eventId: string) => {
    const captura = (((await eventoDe(eventId)).payload as Record<string, unknown>)._avoqado as Record<string, unknown>)
      .tarifaCongeladaAlIngreso as { pricing: Record<string, unknown> } | undefined
    expect(captura).toMatchObject({ pricing: expect.anything() })
    return captura!
  }
  const snapshotDe = (p: { processorData: unknown }) => (p.processorData as Record<string, unknown>).pricing as Record<string, unknown>
  const costoDe = (paymentId: string) => exigir(prisma.transactionCost.findUnique({ where: { paymentId } }))
  /** Un evento aprobado del intento cuyo registrador «muere»: PENDING con su captura persistida, sin Payment. */
  const ingresoSinPayment = async (A: string, R: string) => {
    const corte = jest.spyOn(registrador, 'recordFastPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const corteOrden = jest.spyOn(registrador, 'recordOrderPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const { result, eventId } = await webhook(A, { transactionId: R }, M2)
    corte.mockRestore()
    corteOrden.mockRestore()
    expect(result.action).not.toBe('CONFIRMED')
    expect(await eventoDe(eventId)).toMatchObject({ status: 'PENDING' })
    return { eventId, captura: await capturaDe(eventId) }
  }
  const claimsDelIntento = async (limit: number) => {
    const claims = await claimPendingAngelPayEvents({ now: new Date(), limit })
    const desenlaces: string[] = []
    for (const claim of claims) desenlaces.push(await runClaimedAngelPayEvent(claim))
    return desenlaces
  }
  /** Barrera de dos lados: el actor avisa que está en pausa (`pausado` → `pausada`) y la prueba lo suelta (`liberar` → `liberada`). */
  const barrera = () => {
    let liberar!: () => void
    let pausado!: () => void
    const liberada = new Promise<void>(r => (liberar = r))
    const pausada = new Promise<void>(r => (pausado = r))
    const pausadaEn = (ms: number) =>
      Promise.race([
        pausada.then(() => true),
        new Promise<boolean>(r => {
          const t = setTimeout(() => r(false), ms)
          t.unref?.()
        }),
      ])
    return { liberar, pausado, liberada, pausada, pausadaEn }
  }
  afterEach(async () => {
    jest.restoreAllMocks()
    await secundariaAl(0.025)
  })

  it('WEBHOOK · E1 (2.5 %) → el registrador de E1 muere → SECONDARY editada al 8 % → E2 (otro eventId, MISMO intento) crea el Payment: nace con la captura de E1 (mismo `frozenAt`), fee $3 — nunca con la captura posterior de E2 (8 %); S4 sella E1 sobre ese único Payment', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const { eventId: e1, captura } = await ingresoSinPayment(A, R)
    await secundariaAl(0.08)
    const { result, eventId: e2 } = await webhook(A, { transactionId: R }, M2)
    expect(result.action).toBe('CONFIRMED')
    const p = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(p.status).toBe('COMPLETED')
    // E2 capturó 8 % al ingreso — pero la PRIMERA evidencia del intento es E1: el Payment nace con ESA captura.
    expect((await capturaDe(e2)).pricing).toMatchObject({ venue: { creditRate: '0.08' } })
    expect(snapshotDe(p)).toEqual(captura.pricing)
    expect(snapshotDe(p)).toMatchObject({ merchantAccountId: M2.id, slot: 'SECONDARY', venue: { creditRate: '0.025' } })
    expect(await eventoDe(e2)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    // El REST acredita el método (crédito) y la unidad de costo converge con la tarifa HISTÓRICA de E1: $2.50 + $0.50.
    const acreditado = await restQueAcredita(A, solicitud.requestId, R)
    expect(acreditado.id).toBe(p.id)
    await expect(cerrar(p.id)).resolves.toBe(true)
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
    expect(Number((await costoDe(p.id)).venueRate)).toBeCloseTo(0.025, 6)
    await prisma.providerEventLog.updateMany({ where: { eventId: `angelpay-${e1}` }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    await claimsDelIntento(25)
    expect(await eventoDe(e1)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(snapshotDe(await pago(p.id))).toEqual(captura.pricing)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })).toBe(1)
  })

  it('S4 · E1 (2.5 %) y E2 (8 %, tras la edición) quedan PENDING y el worker procesa E2 ANTES que E1: el Payment nace con la captura de E1; E1 se sella después sobre el mismo Payment', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const { eventId: e1, captura } = await ingresoSinPayment(A, R)
    await secundariaAl(0.08)
    const { eventId: e2, captura: capturaE2 } = await ingresoSinPayment(A, R)
    expect(capturaE2.pricing).toMatchObject({ venue: { creditRate: '0.08' } })
    // E2 primero: sólo E2 es reclamable (E1 sigue con exclusiva del receptor en el futuro).
    await prisma.providerEventLog.updateMany({
      where: { eventId: `angelpay-${e1}` },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    })
    await prisma.providerEventLog.updateMany({ where: { eventId: `angelpay-${e2}` }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    expect(await claimsDelIntento(1)).toHaveLength(1)
    const p = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(await eventoDe(e2)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(snapshotDe(p)).toEqual(captura.pricing)
    expect(snapshotDe(p)).toMatchObject({ venue: { creditRate: '0.025' } })
    await prisma.providerEventLog.updateMany({ where: { eventId: `angelpay-${e1}` }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    await claimsDelIntento(25)
    expect(await eventoDe(e1)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })).toBe(1)
    expect(snapshotDe(await pago(p.id))).toEqual(captura.pricing)
  })

  it('CARRERA · el REST toma el candado del intento y captura «ahora» (2.5 %) sin evidencia previa; la edición al 8 % y el ingreso de E1 llegan mientras el REST sigue abierto: el ingreso ESPERA el candado (pg_locks) y, al soltarse, E1 se sella sobre el Payment del REST — snapshot 2.5 % del REST, fee $3, un solo Payment', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const Act = actores()
    const b = barrera()
    let capturaDelRest = 0
    // La captura «ahora» del REST corre DENTRO de su transacción del dinero (con el candado del intento tomado): se detiene en su
    // SEGUNDA lectura (la tarifa del slot), cuando su vista REPEATABLE READ ya quedó fijada por la primera (la configuración) —
    // la edición al 8 % que llega durante la pausa es invisible para esa captura (R11-1) y el REST congela 2.5 %.
    const real = configuracionDePagos.getEffectivePricingForSlot
    jest.spyOn(configuracionDePagos, 'getEffectivePricingForSlot').mockImplementationOnce(async (venueId, slot, at, db) => {
      capturaDelRest++
      b.pausado()
      await b.liberada
      return real(venueId, slot, at, db)
    })
    let ingreso!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof webhook>>>>
    let espera = null as EsperaAtribuida | null
    let fallo: Fallo = null
    const obs = observatorioDeCandados()
    const rest = Act.lanzar('REST', restQueAcredita(A, solicitud.requestId, R))
    try {
      // Acotada: si la captura no pasa por `getEffectivePricingForSlot` (otro camino de lectura), la pausa nunca llega y la prueba
      // cae por ASERCIÓN, no por el timeout de Jest.
      expect(await b.pausadaEn(5000)).toBe(true)
      expect(capturaDelRest).toBe(1)
      await secundariaAl(0.08)
      ingreso = Act.lanzar('ingreso de E1', webhook(A, { transactionId: R }, M2))
      // El ingreso de E1 ESPERA el candado del intento — la propiedad bajo prueba, por aserción y ATRIBUIDA (Codex R16-2): el actor
      // pidió la llave de A y no la tiene; el poseedor es la transacción del REST, a la que A le fue concedida y que lo bloquea.
      expect(await f.esperar(async () => (espera = await obs.esperaAtribuida(A)) !== null, 5000)).toBe(true)
      expect(await prisma.providerEventLog.count({ where: { attemptId: A } })).toBe(0)
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ 'captura del REST': () => b.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      const p = await rest.resultado()
      const { result, eventId } = await ingreso.resultado()
      expect(p.status).toBe('COMPLETED')
      expect(espera).toEqual({ actor: expect.any(Number), poseedor: expect.any(Number) })
      expect(espera!.actor).not.toBe(espera!.poseedor)
      expect(result.action).not.toBe('ERROR')
      expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })).toBe(1)
      // La captura del REST (2.5 %, anterior a la edición) es la primera evidencia: E1 (8 % al ingreso) NO la sustituye.
      expect(snapshotDe(await pago(p.id))).toMatchObject({ merchantAccountId: M2.id, slot: 'SECONDARY', venue: { creditRate: '0.025' } })
      expect((await capturaDe(eventId)).pricing).toMatchObject({ venue: { creditRate: '0.08' } })
      expect(await eventoDe(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
      expect(Number((await pago(p.id)).feeAmount)).toBe(3)
      expect(Number((await costoDe(p.id)).venueRate)).toBeCloseTo(0.025, 6)
    })
  })

  it('LÍMITE · diez eventos NO aprobados del intento (declined) preceden al approved con captura (2.5 %): el REST consume ESA captura (CON_CAPTURA) — el primer aprobado se elige antes del límite, nunca captura «ahora» (8 %)', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    for (let i = 0; i < 10; i++) {
      const { result } = await webhook(A, { status: 'declined', transactionId: `${R}-${i}` }, M2)
      expect(result.action).toBe('NOT_APPROVED')
    }
    const { captura } = await ingresoSinPayment(A, R)
    await secundariaAl(0.08)
    const p = await restQueAcredita(A, solicitud.requestId, R)
    expect(p.status).toBe('COMPLETED')
    expect(snapshotDe(p)).toEqual(captura.pricing)
    expect(snapshotDe(p)).toMatchObject({ venue: { creditRate: '0.025' } })
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
  })

  it('ORDEN DURABLE · bajo el candado, un ingreso posterior NUNCA se ordena antes que uno anterior: con el evento previo del intento fechado 1 s en el FUTURO, el siguiente ingreso nace con `createdAt` estrictamente posterior', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const { eventId: e1 } = await webhook(A, { status: 'declined', transactionId: `${R}-1` }, M2)
    const futuro = new Date(Date.now() + 1000)
    await prisma.providerEventLog.updateMany({ where: { eventId: `angelpay-${e1}` }, data: { createdAt: futuro } })
    const { eventId: e2 } = await webhook(A, { status: 'declined', transactionId: `${R}-2` }, M2)
    expect((await eventoDe(e2)).createdAt.getTime()).toBeGreaterThan(futuro.getTime())
  })
})

describe('Codex R5 · R5-2: la tarifa se congela sobre la afiliación DEFINITIVA (la que queda tras TIER-2/3), nunca sobre la que mandó el APK', () => {
  const SERIAL_M2 = `SN-M2-${randomUUID().slice(0, 8)}`
  const conTarjeta = (extra: Record<string, unknown>) => ({
    ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' } }),
    ...extra,
  })
  beforeAll(() => prisma.merchantAccount.update({ where: { id: M2.id }, data: { blumonSerialNumber: SERIAL_M2 } }))

  it('merchantAccountId INEXISTENTE (configuración vieja del APK) + blumonSerialNumber que resuelve a M2: el Payment nace atribuido a M2 con el snapshot de M2 (SECONDARY 2.5 %) y el costo síncrono cobra 2.5 %', async () => {
    const p = await recordFastPayment(
      f.venueId,
      conTarjeta({ merchantAccountId: `inexistente-${randomUUID()}`, blumonSerialNumber: SERIAL_M2 }),
      f.staffId,
    )
    const durable = await pago(p.id)
    expect(durable.merchantAccountId).toBe(M2.id)
    expect(durable.processorData).toMatchObject({
      pricingSlot: 'SECONDARY',
      pricing: { merchantAccountId: M2.id, slot: 'SECONDARY', venue: { accountType: 'SECONDARY', creditRate: '0.025' } },
    })
    const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
    expect(costo.merchantAccountId).toBe(M2.id)
    expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
    expect(Number(durable.feeAmount)).toBe(3)
  })

  it('merchantAccountId INACTIVO (M1) recuperado por serial a M2: el snapshot es de M2 — y si el negocio retira M2 de su configuración antes del costo diferido, sigue cobrando 2.5 % (con el snapshot de M1 habría caído al 8 % de PRIMARY)', async () => {
    await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: false } })
    let p: { id: string }
    try {
      p = await recordFastPayment(f.venueId, conTarjeta({ merchantAccountId: f.merchantId, blumonSerialNumber: SERIAL_M2 }), f.staffId)
    } finally {
      await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: true } })
    }
    const durable = await pago(p.id)
    expect(durable.merchantAccountId).toBe(M2.id)
    expect(durable.processorData).toMatchObject({ pricingSlot: 'SECONDARY', pricing: { merchantAccountId: M2.id, slot: 'SECONDARY' } })

    // El costo síncrono nunca llegó a persistir (el proceso murió): se simula y el negocio retira M2 antes del diferido.
    await prisma.transactionCost.deleteMany({ where: { paymentId: p.id } })
    await prisma.paymentEffect.updateMany({
      where: { paymentId: p.id, kind: 'TRANSACTION_COST' },
      data: { status: 'PENDING', completedAt: null },
    })
    await f.quitarDeLaConfiguracion(M2.id)
    try {
      expect(await cerrar(p.id)).toBe(true)
      const costo = await exigir(prisma.transactionCost.findUnique({ where: { paymentId: p.id } }))
      expect(costo.merchantAccountId).toBe(M2.id)
      expect(Number(costo.venueRate)).toBeCloseTo(0.025, 6)
      expect(Number((await pago(p.id)).feeAmount)).toBe(3)
    } finally {
      await f.devolverALaConfiguracion(M2.id)
    }
  })
})

describe('Codex R5 · R5-3: UN solo criterio de cumplimiento del costo síncrono, compartido con el worker', () => {
  const conTarjeta = () =>
    f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' } })
  const obligacion = (paymentId: string) => exigir(prisma.paymentEffect.findFirst({ where: { paymentId, kind: 'TRANSACTION_COST' } }))

  it('venta rápida por REST: la comisión REAL (8 % + $0.50 de PRIMARY) queda proyectada en Payment y VenueTransaction y la obligación cierra DONE — la venta rápida descartaba el resultado y cerraba con comisión 0', async () => {
    const p = await recordFastPayment(f.venueId, conTarjeta(), f.staffId)
    const durable = await pago(p.id)
    expect(Number(durable.feeAmount)).toBe(8.5)
    expect(Number(durable.netAmount)).toBe(91.5)
    expect((durable.processorData as Record<string, unknown>).costPending).toBe(false)
    const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: p.id } }))
    expect(Number(vt.feeAmount)).toBe(8.5)
    expect(Number(vt.netAmount)).toBe(91.5)
    expect(Number(vt.netSettlementAmount)).toBe(91.5)
    expect(vt.settlementConfigId).not.toBeNull()
    expect(await obligacion(p.id)).toMatchObject({ status: 'DONE', lastError: null })
  })

  it('con orden: la misma proyección y el mismo cierre', async () => {
    const venta = await f.nuevaVenta(100)
    const p = await recordOrderPayment(f.venueId, venta.id, conTarjeta(), f.staffId)
    expect(Number((await pago(p.id)).feeAmount)).toBe(8.5)
    const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: p.id } }))
    expect(Number(vt.netSettlementAmount)).toBe(91.5)
    expect(vt.settlementConfigId).not.toBeNull()
    expect(await obligacion(p.id)).toMatchObject({ status: 'DONE', lastError: null })
  })

  it('sin configuración de liquidación: el costo y sus proyecciones se persisten pero la obligación NO cierra (PENDING, AWAITING_SETTLEMENT_CONFIGURATION) — «existe la fila del costo» no es «obligación cumplida»; al configurarla converge', async () => {
    await f.sinLiquidacion()
    try {
      const p = await recordFastPayment(f.venueId, conTarjeta(), f.staffId)
      expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(1)
      expect(Number((await pago(p.id)).feeAmount)).toBe(8.5)
      const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: p.id } }))
      expect(Number(vt.feeAmount)).toBe(8.5)
      expect(vt.settlementConfigId).toBeNull()
      expect(await obligacion(p.id)).toMatchObject({ status: 'PENDING', lastError: 'AWAITING_SETTLEMENT_CONFIGURATION' })

      await f.conLiquidacion()
      expect(await cerrar(p.id)).toBe(true)
      expect((await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: p.id } }))).settlementConfigId).not.toBeNull()
    } finally {
      await f.conLiquidacion()
    }
  })

  it('P2-e / R6 (diseño B) · `costPending` tiene UN criterio: «la obligación no ha convergido». Nace true con la obligación (también por REST); con el costo persistido pero sin liquidación sigue true; un fallo síncrono posterior sólo anota y NO cierra; al configurar la liquidación converge a false', async () => {
    await f.sinLiquidacion()
    try {
      const p = await recordFastPayment(f.venueId, conTarjeta(), f.staffId)
      expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(1)
      expect(await obligacion(p.id)).toMatchObject({ status: 'PENDING', lastError: 'AWAITING_SETTLEMENT_CONFIGURATION' })
      expect(((await pago(p.id)).processorData as Record<string, unknown>).costPending).toBe(true)
      await anotarCostoNoCalculado(p.id, new Error('ECONNRESET'))
      expect(await obligacion(p.id)).toMatchObject({ status: 'PENDING', lastError: 'TRANSACTION_COST_FAILED' })
      expect(((await pago(p.id)).processorData as Record<string, unknown>).costPending).toBe(true)
      await f.conLiquidacion()
      expect(await cerrar(p.id)).toBe(true)
      expect(((await pago(p.id)).processorData as Record<string, unknown>).costPending).toBe(false)
    } finally {
      await f.conLiquidacion()
    }
  })
})

describe('Codex R6 · R6-1: la deduplicación por referencia usa la afiliación DEFINITIVA (tras TIER-2/3), no la que mandó el APK', () => {
  const SERIAL_M2 = `SN-M2-R6-${randomUUID().slice(0, 8)}`
  const legacyConSerial = (ref: string, merchantAccountId: string) => ({
    ...f.registroDeLaTerminal({
      attemptId: randomUUID(),
      sinLlave: true,
      ref,
      tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' },
    }),
    merchantAccountId,
    blumonSerialNumber: SERIAL_M2,
  })
  const ventasFinancieras = () => prisma.venueTransaction.count({ where: { venueId: f.venueId } })
  beforeAll(() => prisma.merchantAccount.update({ where: { id: M2.id }, data: { blumonSerialNumber: SERIAL_M2 } }))

  it('venta rápida: el primer registro (merchant INEXISTENTE + serial de M2) nace atribuido a M2 con el valor del APK como evidencia; el replay IDÉNTICO sin llave devuelve el MISMO Payment y no crea otro movimiento financiero', async () => {
    const R = `${Date.now()}`
    const inexistente = `inexistente-${randomUUID()}`
    const antes = await ventasFinancieras()
    const primero = await recordFastPayment(f.venueId, legacyConSerial(R, inexistente), f.staffId)
    expect(primero.merchantAccountId).toBe(M2.id)
    expect((await pago(primero.id)).processorData).toMatchObject({ merchantAccountIdFromApk: inexistente })
    expect(await ventasFinancieras()).toBe(antes + 1)

    const replay = await recordFastPayment(f.venueId, legacyConSerial(R, inexistente), f.staffId)

    expect(replay.id).toBe(primero.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(1)
    expect(await ventasFinancieras()).toBe(antes + 1)
  })

  it('con orden: merchant INACTIVO (M1) recuperado por serial a M2; el replay idéntico sin llave no cobra la cuenta dos veces', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(100)
    const antes = await ventasFinancieras()
    await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: false } })
    try {
      const primero = await recordOrderPayment(f.venueId, venta.id, legacyConSerial(R, f.merchantId), f.staffId)
      expect(primero.merchantAccountId).toBe(M2.id)
      const replay = await recordOrderPayment(f.venueId, venta.id, legacyConSerial(R, f.merchantId), f.staffId)
      expect(replay.id).toBe(primero.id)
      expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id } })).toBe(1)
      expect(await ventasFinancieras()).toBe(antes + 1)
    } finally {
      await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: true } })
    }
  })

  it('una resolución INCIERTA de la afiliación (la base falla al buscar por serial) no se lee como «sin afiliación»: rechaza con 503 reintentable y no crea nada', async () => {
    const R = `${Date.now()}`
    const espia = jest.spyOn(prisma.merchantAccount, 'findFirst').mockRejectedValueOnce(new Error('ECONNRESET'))
    try {
      await expect(recordFastPayment(f.venueId, legacyConSerial(R, `inexistente-${randomUUID()}`), f.staffId)).rejects.toMatchObject({
        code: 'PAYMENT_REGISTRATION_UNRESOLVED_AFFILIATION_RESOLUTION_UNCERTAIN',
      })
    } finally {
      espia.mockRestore()
    }
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(0)
  })
})

describe('Codex R7 · R7-2: la configuración de enrutamiento de HOY no demuestra que un cargo HISTÓRICO sea distinto — un replay demostrado conserva la identidad registrada', () => {
  const SERIAL = `SN-R7-${randomUUID().slice(0, 8)}`
  const legacy = (ref: string, over: Record<string, unknown> = {}) => ({
    ...f.registroDeLaTerminal({
      attemptId: randomUUID(),
      sinLlave: true,
      ref,
      auth: `AUTH-${ref.slice(-6)}`,
      tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' },
    }),
    merchantAccountId: f.merchantId,
    blumonSerialNumber: SERIAL,
    ...over,
  })
  const ventasFinancieras = () => prisma.venueTransaction.count({ where: { venueId: f.venueId } })
  /** El negocio DESACTIVA M1 y mueve el serial a M2 entre el registro y el replay. */
  const cambiarElEnrutamiento = async () => {
    await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: false, blumonSerialNumber: null } })
    await prisma.merchantAccount.update({ where: { id: M2.id }, data: { blumonSerialNumber: SERIAL } })
  }
  const restaurarElEnrutamiento = async () => {
    await prisma.merchantAccount.update({ where: { id: M2.id }, data: { blumonSerialNumber: null } })
    await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: true, blumonSerialNumber: SERIAL } })
  }
  beforeAll(() => prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { blumonSerialNumber: SERIAL } }))
  afterAll(() => prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { blumonSerialNumber: null } }))
  afterEach(restaurarElEnrutamiento)

  it('venta rápida: registro bajo M1 (activa) → el negocio desactiva M1 y mueve el serial a M2 → el replay IDÉNTICO sin llave (el APK sigue mandando M1) resuelve a M2 pero encuentra SU Payment: mismo Payment, afiliación histórica M1 intacta, ningún movimiento financiero nuevo', async () => {
    const R = `${Date.now()}`
    const antes = await ventasFinancieras()
    const primero = await recordFastPayment(f.venueId, legacy(R), f.staffId)
    expect(primero.merchantAccountId).toBe(f.merchantId)
    await cambiarElEnrutamiento()
    const replay = await recordFastPayment(f.venueId, legacy(R), f.staffId)
    expect(replay.id).toBe(primero.id)
    expect((await pago(primero.id)).merchantAccountId).toBe(f.merchantId)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(1)
    expect(await ventasFinancieras()).toBe(antes + 1)
  })

  it('con orden: el mismo replay tras el cambio de enrutamiento no cobra la cuenta dos veces ni cambia la afiliación registrada', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(100)
    const antes = await ventasFinancieras()
    const primero = await recordOrderPayment(f.venueId, venta.id, legacy(R), f.staffId)
    expect(primero.merchantAccountId).toBe(f.merchantId)
    await cambiarElEnrutamiento()
    const replay = await recordOrderPayment(f.venueId, venta.id, legacy(R), f.staffId)
    expect(replay.id).toBe(primero.id)
    expect((await pago(primero.id)).merchantAccountId).toBe(f.merchantId)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id } })).toBe(1)
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
    expect(await ventasFinancieras()).toBe(antes + 1)
  })

  it('identidad INCIERTA: el replay llega SIN afiliación del APK y el serial ya apunta a M2 (el registro es de M1, misma autorización) — no nace una venta: queda como EVIDENCIA de colisión (PENDING, sin movimiento financiero)', async () => {
    const R = `${Date.now()}`
    const antes = await ventasFinancieras()
    const primero = await recordFastPayment(f.venueId, legacy(R), f.staffId)
    await cambiarElEnrutamiento()
    const replay = await recordFastPayment(f.venueId, legacy(R, { merchantAccountId: undefined }), f.staffId)
    expect(replay.id).not.toBe(primero.id)
    expect(replay.status).toBe('PENDING')
    expect((replay.processorData as Record<string, any>).reconciliation).toMatchObject({ kind: 'POSSIBLE_REFERENCE_COLLISION' })
    expect(await ventasFinancieras()).toBe(antes + 1)
    expect((await pago(primero.id)).merchantAccountId).toBe(f.merchantId)
  })

  it('otra AUTORIZACIÓN con otra afiliación sí demuestra otro cargo: nace una venta nueva', async () => {
    const R = `${Date.now()}`
    const antes = await ventasFinancieras()
    const primero = await recordFastPayment(f.venueId, legacy(R), f.staffId)
    await cambiarElEnrutamiento()
    const otro = await recordFastPayment(
      f.venueId,
      legacy(R, { merchantAccountId: undefined, authorizationNumber: 'OTRA-AUTH' }),
      f.staffId,
    )
    expect(otro.id).not.toBe(primero.id)
    expect(otro.status).toBe('COMPLETED')
    expect(otro.merchantAccountId).toBe(M2.id)
    expect(await ventasFinancieras()).toBe(antes + 2)
  })

  // Codex R8-1: un replay legacy SIN merchant y SIN autorización (el contrato los admite: el serial sustituye al merchant) quedaba
  // fuera de la búsqueda por referencia —la OR de afiliación exigía intersección de identidades o la MISMA autorización— y nacía
  // como venta nueva tras un cambio de enrutamiento. La afiliación ya no filtra en SQL: el candidato llega a la regla de identidad.
  const evidencia = (p: { status: string; processorData: unknown }) => {
    expect(p.status).toBe('PENDING')
    expect((p.processorData as Record<string, any>).reconciliation).toMatchObject({ kind: 'POSSIBLE_REFERENCE_COLLISION' })
  }
  it('Codex R8-1 · venta rápida: el APK legacy no manda merchant NI autorización (sólo el serial); el negocio mueve el serial de M1 a M2; el replay IDÉNTICO (sin merchant, sin autorización, sin llave) NO nace como venta: identidad INCIERTA ⇒ evidencia PENDING, sin movimiento financiero, el registro de M1 intacto', async () => {
    const R = `${Date.now()}`
    const antes = await ventasFinancieras()
    const primero = await recordFastPayment(
      f.venueId,
      legacy(R, { merchantAccountId: undefined, authorizationNumber: undefined }),
      f.staffId,
    )
    expect(primero.merchantAccountId).toBe(f.merchantId)
    expect(primero.authorizationNumber).toBeNull()
    await cambiarElEnrutamiento()
    const replay = await recordFastPayment(
      f.venueId,
      legacy(R, { merchantAccountId: undefined, authorizationNumber: undefined }),
      f.staffId,
    )
    expect(replay.id).not.toBe(primero.id)
    evidencia(replay)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R, status: 'COMPLETED' } })).toBe(1)
    expect((await pago(primero.id)).merchantAccountId).toBe(f.merchantId)
    expect(await ventasFinancieras()).toBe(antes + 1)
  })

  it('Codex R8-1 · con orden: el mismo replay sin merchant ni autorización no cobra la cuenta dos veces (evidencia PENDING colgada de la venta, la orden sigue pagada UNA vez)', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(100)
    const antes = await ventasFinancieras()
    const primero = await recordOrderPayment(
      f.venueId,
      venta.id,
      legacy(R, { merchantAccountId: undefined, authorizationNumber: undefined }),
      f.staffId,
    )
    expect(primero.merchantAccountId).toBe(f.merchantId)
    await cambiarElEnrutamiento()
    const replay = await recordOrderPayment(
      f.venueId,
      venta.id,
      legacy(R, { merchantAccountId: undefined, authorizationNumber: undefined }),
      f.staffId,
    )
    expect(replay.id).not.toBe(primero.id)
    evidencia(replay)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id, status: 'COMPLETED' } })).toBe(1)
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
    expect(await ventasFinancieras()).toBe(antes + 1)
  })

  it('Codex R8-1 · autorización en UN solo lado (el registro la tiene y el replay no, o al revés) tampoco demuestra otro cargo: evidencia PENDING, nunca venta nueva', async () => {
    // El registro CON autorización, el replay SIN ella.
    const R1 = `${Date.now()}`
    const antes = await ventasFinancieras()
    const conAuth = await recordFastPayment(f.venueId, legacy(R1), f.staffId)
    await cambiarElEnrutamiento()
    const replaySinAuth = await recordFastPayment(
      f.venueId,
      legacy(R1, { merchantAccountId: undefined, authorizationNumber: undefined }),
      f.staffId,
    )
    expect(replaySinAuth.id).not.toBe(conAuth.id)
    evidencia(replaySinAuth)
    await restaurarElEnrutamiento()
    // Al revés: el registro SIN autorización, el replay CON ella.
    const R2 = `${Date.now()}-b`
    const sinAuth = await recordFastPayment(
      f.venueId,
      legacy(R2, { merchantAccountId: undefined, authorizationNumber: undefined }),
      f.staffId,
    )
    await cambiarElEnrutamiento()
    const replayConAuth = await recordFastPayment(f.venueId, legacy(R2, { merchantAccountId: undefined }), f.staffId)
    expect(replayConAuth.id).not.toBe(sinAuth.id)
    evidencia(replayConAuth)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: { in: [R1, R2] }, status: 'COMPLETED' } })).toBe(2)
    expect(await ventasFinancieras()).toBe(antes + 2)
  })
})

describe('Codex R12 (pasada exhaustiva) · R12-10: los escritores de Blumon parchan `processorData` de forma ATÓMICA — una lectura vieja nunca repone `costPending: true` ni pisa el snapshot ni los enriquecimientos', () => {
  const serialBlumon = `BL${Date.now()}`
  afterEach(async () => {
    jest.restoreAllMocks()
    await prisma.providerEventLog.deleteMany({
      where: { eventId: { startsWith: 'blumon-tpv' }, payload: { path: ['serialNumber'], equals: f.serialCrudo } },
    })
    await prisma.providerEventLog.deleteMany({ where: { eventId: { startsWith: `blumon-tpv-audit-${serialBlumon}` } } })
    await prisma.merchantAccount.update({ where: { id: M2.id }, data: { blumonSerialNumber: null } })
  })
  const blumon = (reference: string, amount: string, operationNumber?: number) =>
    processBlumonPaymentWebhook({
      lastFour: '1234',
      cardType: 'CREDITO',
      brand: 'VISA',
      bank: 'BANCO',
      amount,
      reference,
      authorizationCode: `AUTH-${reference.slice(-6)}`,
      operationType: 'VENTA',
      membership: 'MEM-BLUMON',
      serialNumber: f.serialCrudo,
      ...(operationNumber ? { operationNumber } : {}),
    } as Parameters<typeof processBlumonPaymentWebhook>[0])

  /** El cobro nace del webhook de AngelPay (método provisional ⇒ costo PENDIENTE) y queda listo para converger. */
  const cobroConCostoPendiente = async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    await webhook(A, { transactionId: R }, M2)
    const nacido = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect((nacido.processorData as Record<string, unknown>).costPending).toBe(true)
    return { R, A, requestId: solicitud.requestId, id: nacido.id }
  }
  type Cobro = Awaited<ReturnType<typeof cobroConCostoPendiente>>
  /** La convergencia COMPLETA: el REST acredita el método y la obligación cierra DONE con `costPending: false`. */
  const convergencia = async (c: Cobro) => {
    await restQueAcredita(c.A, c.requestId, c.R)
    // La unidad síncrona del REST: calcula el costo y cierra la obligación DONE (el `cerrar` de esta suite no reclama la fila).
    expect(await asegurarCostoSincrono(c.id)).toBe('CUMPLIDA')
    expect((await pago(c.id)).processorData).toMatchObject({ costPending: false })
    expect(await efectoDe(c.id)).toMatchObject({ status: 'DONE' })
  }
  /** Lo que un escritor de Blumon NUNCA puede deshacer: false/DONE, el snapshot completo y los enriquecimientos previos. */
  const todoConservado = async (c: Cobro, clavesDelEscritor: string[]) => {
    const pd = (await pago(c.id)).processorData as Record<string, unknown>
    expect(pd.costPending).toBe(false)
    expect(pd.pricing).toMatchObject({ merchantAccountId: M2.id, slot: 'SECONDARY', venue: { creditRate: '0.025' } })
    expect(pd.terminalPaymentRequestId).toBe(c.requestId)
    expect(pd.deviceSerialNumber).toBe(f.serial)
    for (const k of clavesDelEscritor) expect(pd).toHaveProperty(k)
    expect(await efectoDe(c.id)).toMatchObject({ status: 'DONE' })
    expect(Number((await pago(c.id)).feeAmount)).toBe(3)
  }
  /** Detiene al escritor JUSTO después de su lectura del Payment, completa la convergencia y lo reanuda con su copia vieja. */
  const convergerDuranteLaLectura = (c: Cobro) => {
    const original = prisma.payment.findMany.bind(prisma.payment)
    let convergido = false
    jest.spyOn(prisma.payment, 'findMany').mockImplementationOnce((async (args: unknown) => {
      const leido = await original(args as never)
      convergido = true
      await convergencia(c)
      return leido
    }) as never)
    return () => convergido
  }

  it('webhook MATCHED: lee `costPending: true`, la convergencia termina (false/DONE), escribe — y el cargo sigue en false/DONE con el snapshot, la etiqueta de la solicitud y las llaves de Blumon', async () => {
    const c = await cobroConCostoPendiente()
    const convergido = convergerDuranteLaLectura(c)
    const r = await blumon(c.R, '100.00')
    expect(r.action).toBe('MATCHED')
    expect(convergido()).toBe(true)
    await todoConservado(c, ['blumonWebhookReceived', 'blumonAuthCode', 'blumonMembership', 'blumonOperationNumber'])
  })

  it('idempotencia ATÓMICA: un segundo webhook MATCHED sobre el mismo cobro no pisa la primera recepción (`blumonWebhookReceived`, auth) — el «si no lo tenía ya» se decide en la misma sentencia', async () => {
    const c = await cobroConCostoPendiente()
    await convergencia(c)
    expect((await blumon(c.R, '100.00')).action).toBe('MATCHED')
    const primera = (await pago(c.id)).processorData as Record<string, unknown>
    // Otro evento (número de operación distinto ⇒ otro eventId) que casa por referencia con OTRA autorización.
    const segundo = await processBlumonPaymentWebhook({
      lastFour: '1234',
      cardType: 'CREDITO',
      brand: 'VISA',
      bank: 'BANCO',
      amount: '100.00',
      reference: c.R,
      authorizationCode: 'AUTH-OTRA',
      operationType: 'VENTA',
      operationNumber: Number(String(Date.now()).slice(-9)),
      serialNumber: f.serialCrudo,
    } as Parameters<typeof processBlumonPaymentWebhook>[0])
    expect(segundo.action).toBe('MATCHED')
    const despues = (await pago(c.id)).processorData as Record<string, unknown>
    expect(despues.blumonWebhookReceived).toBe(primera.blumonWebhookReceived)
    expect(despues.blumonAuthCode).toBe(primera.blumonAuthCode)
    expect(despues.costPending).toBe(false)
  })

  it('webhook DISCREPANCY (importe distinto, casado por número de operación): la rama de discrepancia tampoco repone el pendiente ni pisa nada', async () => {
    const c = await cobroConCostoPendiente()
    // Sólo el tier por número de operación casa sin exigir el importe: es el único camino a la rama de discrepancia.
    const op = Number(String(Date.now()).slice(-9))
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || ${JSON.stringify({ blumonOperationNumber: op })}::jsonb WHERE "id" = ${c.id}`
    const convergido = convergerDuranteLaLectura(c)
    const r = await blumon(c.R, '150.00', op)
    expect(r.action).toBe('DISCREPANCY')
    expect(convergido()).toBe(true)
    await todoConservado(c, ['blumonDiscrepancy'])
  })

  it('job de auditoría (cobro sin webhook): la marca antispam se estampa con parche atómico — convergencia entre su lectura y su escritura, o antes: false/DONE intacto', async () => {
    const c = await cobroConCostoPendiente()
    // Elegible para el barrido: afiliación con serial Blumon que SÍ entrega webhooks, cobro de hace 8 h (fuera de la ventana de 30 min
    // en cualquier zona de sesión de Postgres) y sin marca previa.
    await prisma.merchantAccount.update({ where: { id: M2.id }, data: { blumonSerialNumber: serialBlumon } })
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `blumon-tpv-audit-${serialBlumon}`,
        type: 'VENTA',
        payload: { serialNumber: serialBlumon } as never,
        status: 'PROCESSED',
      },
    })
    await prisma.payment.update({ where: { id: c.id }, data: { createdAt: new Date(Date.now() - 8 * 60 * 60_000) } })
    // Un escritor que LEE antes de escribir converge EN MEDIO (la lectura del job es la primera `findUnique` desde aquí); uno
    // atómico no lee y converge DESPUÉS de estampar — los dos órdenes tienen que dejar el mismo estado final.
    let convergido = false
    const original = prisma.payment.findUnique.bind(prisma.payment)
    jest.spyOn(prisma.payment, 'findUnique').mockImplementationOnce((async (args: unknown) => {
      const leido = await original(args as never)
      convergido = true
      await convergencia(c)
      return leido
    }) as never)
    expect(await blumonPaymentAuditJob.runOnce()).toBe(1)
    if (!convergido) await convergencia(c)
    await todoConservado(c, ['webhookAuditAlertedAt'])
  })
})

describe('Codex R12 (pasada exhaustiva) · R12-15: el costo NEGATIVO de un reembolso posterior a DONE es una obligación DURABLE — registrada en la MISMA transacción del reembolso, bajo el mutex del original; el worker la cumple copiando el costo original', () => {
  afterEach(() => jest.restoreAllMocks())
  const efectoDelOriginal = (paymentId: string) =>
    exigir(prisma.paymentEffect.findFirst({ where: { paymentId, kind: 'TRANSACTION_COST' } }))
  const costoDe = (paymentId: string) => prisma.transactionCost.findUnique({ where: { paymentId } })
  /** Un cobro REST de $100 CONVERGIDO: costo $3.00 (2.5 % + $0.50) y obligación DONE. */
  const originalConvergido = async () => {
    // Por M2 (SECONDARY al 2.5 % + $0.50): $3.00 sobre $100 — la PRIMARY de esta suite está al 8 % a propósito.
    const p = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({ attemptId: randomUUID(), tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' } }),
        merchantAccountId: M2.id,
      },
      f.staffId,
    )
    expect(p.status).toBe('COMPLETED')
    expect(await asegurarCostoSincrono(p.id)).toBe('CUMPLIDA')
    expect(await efectoDelOriginal(p.id)).toMatchObject({ status: 'DONE' })
    expect(Number((await pago(p.id)).feeAmount)).toBe(3)
    return p
  }
  const reembolsoTpv = (p: { id: string; orderId: string }, amount = 10000) =>
    recordRefund(
      f.venueId,
      {
        venueId: f.venueId,
        originalPaymentId: p.id,
        originalOrderId: p.orderId,
        amount,
        reason: 'CUSTOMER_REQUEST',
        authorizationNumber: `RF-${randomUUID().slice(0, 6)}`,
        referenceNumber: randomUUID(),
        isPartialRefund: amount !== 10000,
        currency: 'MXN',
        processor: 'angelpay',
        idempotencyKey: randomUUID(),
      } as Parameters<typeof recordRefund>[1],
      f.staffId,
    )
  const reembolsoDashboard = (p: { id: string }, amount = 10000) =>
    issueRefund({ venueId: f.venueId, paymentId: p.id, amount, tipRefundCents: 0, reason: 'CUSTOMER_REQUEST' as never, staffId: f.staffId })
  /** El worker REAL de efectos: reclama y corre lo que haya vencido. */
  const correrEfectos = async () => {
    const claims = await claimPaymentEffects({ now: new Date() })
    const r: boolean[] = []
    for (const c of claims) r.push(await runClaimedPaymentEffect(c))
    return { claims, r }
  }
  const unSoloCostoNegativo = async (original: { id: string }, refundId: string, ratio = 1) => {
    const costo = await exigir(costoDe(refundId))
    expect(Number(costo.amount)).toBeCloseTo(-100 * ratio, 6)
    expect(Number(costo.venueChargeAmount)).toBeCloseTo(-2.5 * ratio, 6)
    expect(Number(costo.venueFixedFee)).toBe(ratio === 1 ? -0.5 : 0)
    expect(
      await prisma.transactionCost.count({
        where: { payment: { type: 'REFUND', processorData: { path: ['originalPaymentId'], equals: original.id } } },
      }),
    ).toBe(1)
    expect(await efectoDelOriginal(original.id)).toMatchObject({ status: 'DONE' })
    expect((await pago(original.id)).processorData).toMatchObject({ costPending: false })
    // El original conserva SU proyección; el reembolso lleva la suya en negativo.
    expect(Number((await pago(original.id)).feeAmount)).toBe(3)
    expect(Number((await pago(original.id)).netAmount)).toBe(97)
    await proyeccionDelReembolso(refundId, ratio)
  }
  /**
   * Codex R13-5: las PROYECCIONES del reembolso (su Payment y su VenueTransaction) salen de su costo negativo PERSISTIDO con la
   * misma regla monetaria que el original: $100 con fee $3 ⇒ el reembolso total lleva fee −$3 y neto −$97 (y las proyecciones de
   * original + reembolso suman 0/0); un parcial de $40 ⇒ fee −$1.00 (2.5 % × 40, sin fijo) y neto −$39.
   */
  const proyeccionDelReembolso = async (refundId: string, ratio = 1) => {
    const fee = -(2.5 * ratio + (ratio === 1 ? 0.5 : 0))
    const net = -100 * ratio - fee
    const r = await pago(refundId)
    expect(Number(r.feeAmount)).toBeCloseTo(fee, 6)
    expect(Number(r.netAmount)).toBeCloseTo(net, 6)
    const vt = await exigir(prisma.venueTransaction.findUnique({ where: { paymentId: refundId } }))
    expect(Number(vt.feeAmount)).toBeCloseTo(fee, 6)
    expect(Number(vt.netAmount)).toBeCloseTo(net, 6)
    expect(Number(vt.netSettlementAmount)).toBeCloseTo(net, 6)
    expect(Number(vt.grossAmount)).toBeCloseTo(-100 * ratio, 6)
  }

  describe.each([
    [
      'TPV (recordRefund)',
      (p: { id: string; orderId: string }, amount?: number) => reembolsoTpv(p, amount),
      (r: unknown) => (r as { id: string }).id,
    ],
    [
      'dashboard (issueRefund)',
      (p: { id: string; orderId: string }, amount?: number) => reembolsoDashboard(p, amount),
      (r: unknown) => (r as { refundId: string }).refundId,
    ],
  ] as const)('reembolso por %s', (canal, reembolsar, idDe) => {
    it(`reembolso por ${canal} · original DONE → reembolso → la creación síncrona del costo negativo FALLA (transitorio) → la obligación quedó reabierta en la transacción del reembolso → el worker crea EXACTAMENTE un costo negativo con las proyecciones correctas`, async () => {
      const original = await originalConvergido()
      const real = costoDeTransaccion.createRefundTransactionCost
      const corte = jest.spyOn(costoDeTransaccion, 'createRefundTransactionCost').mockImplementationOnce(async () => {
        throw new Error('fallo transitorio del costo negativo')
      })
      const refundId = idDe(await reembolsar(original))
      corte.mockRestore()
      expect(await costoDe(refundId)).toBeNull()
      // Durable: la obligación del original volvió a PENDING dentro de la transacción del reembolso.
      expect(await efectoDelOriginal(original.id)).toMatchObject({ status: 'PENDING', lastError: 'REFUND_COST' })
      // Codex R13-5: la MARCA también se reactiva al registrar trabajo nuevo — el original ya no anuncia costo final mientras
      // su obligación esté pendiente; el reembolso, sin costo todavía, no lleva proyección (fee 0, neto −100).
      expect((await pago(original.id)).processorData).toMatchObject({ costPending: true })
      expect(Number((await pago(refundId)).feeAmount)).toBe(0)
      expect(Number((await pago(refundId)).netAmount)).toBe(-100)
      const { r } = await correrEfectos()
      expect(r).toContain(true)
      await unSoloCostoNegativo(original, refundId)
      expect(real).toBeDefined()
    })

    it(`reembolso por ${canal} · Codex R13-5 · costo negativo YA EXISTENTE con proyecciones INCOMPLETAS (fee 0 / neto −100 en Payment y VenueTransaction): la siguiente corrida de la unidad las repara desde el costo persistido y converge`, async () => {
      const original = await originalConvergido()
      const refundId = idDe(await reembolsar(original))
      expect(await f.esperar(async () => (await costoDe(refundId)) !== null, 4000)).toBe(true)
      await correrEfectos()
      await unSoloCostoNegativo(original, refundId)
      // Las proyecciones del reembolso se pierden (una escritura vieja, un dato anterior a la regla); el costo negativo queda.
      await prisma.payment.update({ where: { id: refundId }, data: { feeAmount: 0, netAmount: -100 } })
      await prisma.venueTransaction.updateMany({
        where: { paymentId: refundId },
        data: { feeAmount: 0, netAmount: -100, netSettlementAmount: -100 },
      })
      await prisma.paymentEffect.updateMany({
        where: { paymentId: original.id, kind: 'TRANSACTION_COST' },
        data: { status: 'PENDING', nextAttemptAt: new Date(Date.now() - 1000), completedAt: null, lastError: 'REFUND_COST' },
      })
      const { r } = await correrEfectos()
      expect(r).toContain(true)
      expect(await prisma.transactionCost.count({ where: { paymentId: refundId } })).toBe(1)
      await unSoloCostoNegativo(original, refundId)
    })

    it(`reembolso por ${canal} · Codex R13-5 · PARCIAL ($40 de $100): inmediatamente después del reembolso (costo síncrono) el reembolso lleva fee −$1.00 y neto −$39; el worker no lo mueve`, async () => {
      const original = await originalConvergido()
      const refundId = idDe(await reembolsar(original, 4000))
      expect(await f.esperar(async () => (await costoDe(refundId)) !== null, 4000)).toBe(true)
      expect(await f.esperar(async () => Number((await pago(refundId)).feeAmount) !== 0, 4000)).toBe(true)
      await proyeccionDelReembolso(refundId, 0.4)
      await correrEfectos()
      await unSoloCostoNegativo(original, refundId, 0.4)
    })

    it(`reembolso por ${canal} · CONTROL: si la creación síncrona SÍ funciona, el worker que retoma la obligación no duplica nada (sigue habiendo UN costo negativo)`, async () => {
      const original = await originalConvergido()
      const refundId = idDe(await reembolsar(original))
      // El dashboard crea el costo síncrono en segundo plano (fire-and-forget): se espera a que aterrice antes de medir.
      expect(await f.esperar(async () => (await costoDe(refundId)) !== null, 4000)).toBe(true)
      await correrEfectos()
      await unSoloCostoNegativo(original, refundId)
    })
  })

  it('parcial ($40 de $100): el costo negativo copia el costo original a prorrata, nunca consulta tarifas nuevas', async () => {
    const original = await originalConvergido()
    // La tarifa de HOY cambia al 8 %: el costo negativo tiene que salir del costo ORIGINAL (2.5 %), no de la tarifa nueva.
    await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate: 0.08 } })
    try {
      jest.spyOn(costoDeTransaccion, 'createRefundTransactionCost').mockImplementationOnce(async () => {
        throw new Error('fallo transitorio')
      })
      const refund = await reembolsoTpv(original, 4000)
      await correrEfectos()
      await unSoloCostoNegativo(original, refund.id, 0.4)
    } finally {
      await prisma.venuePricingStructure.updateMany({
        where: { venueId: f.venueId, accountType: 'SECONDARY' },
        data: { creditRate: 0.025 },
      })
    }
  })

  it('CONCURRENCIA con una corrida YA RECLAMADA: el reembolso espera el mutex del original (la unidad de costo lo tiene), y al soltarse reabre la obligación que esa corrida cerró — un solo costo negativo', async () => {
    const original = await originalConvergido()
    const efecto = await efectoDelOriginal(original.id)
    // Una corrida reclamada, en vuelo: PROCESSING con token y la fila del Payment tomada con el mismo candado que la unidad.
    await prisma.paymentEffect.update({
      where: { id: efecto.id },
      data: { status: 'PROCESSING', claimToken: 'corrida-en-vuelo', leaseUntil: new Date(Date.now() + 60_000) },
    })
    // Codex R13-6: la corrida en vuelo es un MONTAJE del conjunto de actores y el reembolso un actor lanzado desde el principio;
    // la primera espera y la observación del bloqueo van DENTRO del bloque cuyo `finally` suelta la barrera; `cerrar` corre siempre.
    const A = actores()
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let pid = 0
    const corrida = A.montaje(
      'corrida reclamada que sostiene la fila del original',
      prisma.$transaction(
        async tx => {
          const [{ pid: mio }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${original.id} FOR NO KEY UPDATE`
          pid = mio
          await suelto
          // La corrida termina: cierra DONE (como hace la unidad con su token) y suelta el candado al commitear.
          await tx.paymentEffect.update({
            where: { id: efecto.id },
            data: { status: 'DONE', claimToken: null, leaseUntil: null, completedAt: new Date() },
          })
        },
        { timeout: 20_000 },
      ),
    )
    let reembolso!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof reembolsoTpv>>>>
    let bloqueado = false
    let fallo: Fallo = null
    try {
      if (!(await f.esperar(async () => pid > 0))) throw new Error('la corrida nunca tomó la fila del original')
      jest.spyOn(costoDeTransaccion, 'createRefundTransactionCost').mockImplementationOnce(async () => {
        throw new Error('fallo transitorio')
      })
      reembolso = A.lanzar('reembolso TPV', reembolsoTpv(original))
      // El reembolso está detenido en el candado del original (FOR UPDATE), bloqueado por la corrida.
      bloqueado = await f.esperar(async () => {
        const filas = await prisma.$queryRaw<{ pid: number; bloqueadoPor: number[] }[]>`
          SELECT pid, pg_blocking_pids(pid) AS "bloqueadoPor" FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM "Payment"%FOR UPDATE%'`
        return filas.some(fila => fila.bloqueadoPor.includes(pid))
      }, 5000)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'fila del original (corrida reclamada)': () => soltar() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      await expect(corrida.resultado()).resolves.toBeUndefined()
      const refund = await reembolso.resultado()
      expect(bloqueado).toBe(true)
      // Al soltarse, el reembolso vio la obligación DONE y la reabrió: el worker crea el costo negativo una sola vez.
      expect(await efectoDelOriginal(original.id)).toMatchObject({ status: 'PENDING', lastError: 'REFUND_COST' })
      expect((await pago(original.id)).processorData).toMatchObject({ costPending: true })
      await correrEfectos()
      await unSoloCostoNegativo(original, refund.id)
    })
  })
})

describe('Codex R15-1 · un ingreso que entra SIN candado (la espera venció, 55P03) conserva la evidencia del banco pero NO acredita ningún orden histórico: queda MARCADO (`_avoqado.ingresoSinCandado`), el selector responde ORDEN_NO_ACREDITADO para TODO el intento (captura fallida `EVIDENCIA_DE_INGRESO_SIN_ORDEN`, pendiente hasta acreditar) y la recuperación lo ORDENA bajo el candado —después de todo lo del intento, sin el reloj— sellando `ordenadoEn` sin quitar la marca', () => {
  const secundariaAl = (creditRate: number) =>
    prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate } })
  const eventoDe = (eventId: string) => exigir(prisma.providerEventLog.findFirst({ where: { eventId: `angelpay-${eventId}` } }))
  const snapshotDe = (p: { processorData: unknown }) => (p.processorData as Record<string, unknown>).pricing as Record<string, unknown>
  /** La marca durable del ingreso sin candado, tal como quedó en el evento (`_avoqado.ingresoSinCandado`), o `undefined`. */
  const marcaDe = async (eventId: string) =>
    (((await eventoDe(eventId)).payload as Record<string, unknown>)._avoqado as Record<string, unknown> | undefined)?.ingresoSinCandado as
      | { en?: string; ordenadoEn?: string }
      | undefined
  const pagos = (A: string) => prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: A } })
  const sinOrden = { capturaFallida: { total: expect.stringMatching(/EVIDENCIA_DE_INGRESO_SIN_ORDEN/) } }
  /** Un aprobado del intento ingresado CON candado cuyo registrador «muere»: PENDING con su captura (2.5 %), sin Payment. */
  const ingresoSinPayment = async (A: string, R: string) => {
    const corte = jest.spyOn(registrador, 'recordFastPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const corteOrden = jest.spyOn(registrador, 'recordOrderPayment').mockRejectedValueOnce(new Error('corte tras el ingreso durable'))
    const { result, eventId } = await webhook(A, { transactionId: R }, M2)
    corte.mockRestore()
    corteOrden.mockRestore()
    expect(result.action).not.toBe('CONFIRMED')
    expect(await eventoDe(eventId)).toMatchObject({ status: 'PENDING', paymentId: null })
    expect(await marcaDe(eventId)).toBeUndefined()
    return eventId
  }
  /** S4 real sobre lo PENDING del fixture (vence la exclusiva del receptor y el backoff). */
  const correrWorker = async () => {
    await prisma.providerEventLog.updateMany({
      where: { eventId: { startsWith: `angelpay-${f.fixture}` }, status: 'PENDING' },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    })
    const claims = await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })
    const desenlaces: string[] = []
    for (const claim of claims) desenlaces.push(await runClaimedAngelPayEvent(claim))
    return desenlaces
  }
  const barrera = () => {
    let liberar!: () => void
    let pausado!: () => void
    const liberada = new Promise<void>(r => (liberar = r))
    const pausada = new Promise<void>(r => (pausado = r))
    const pausadaEn = (ms: number) =>
      Promise.race([
        pausada.then(() => true),
        new Promise<boolean>(r => {
          const t = setTimeout(() => r(false), ms)
          t.unref?.()
        }),
      ])
    return { liberar, pausado, liberada, pausadaEn }
  }
  /**
   * OTRA transacción sostiene el candado del intento A hasta que la prueba lo suelta. Es un MONTAJE registrado al lanzarlo (Codex
   * R12-13 / R15-3): si rechaza o no se asienta, la prueba termina INCONCLUSA nombrándolo — nunca como una aserción financiera.
   */
  const sostenerCandado = (Act: ReturnType<typeof actores>, A: string) => {
    const b = barrera()
    const ajena = Act.montaje(
      'candado ajeno del intento',
      prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NS_CANDADO_INTENTO}::int, hashtext(${A}))::text`
          b.pausado()
          await b.liberada
        },
        { timeout: 20_000 },
      ),
    )
    return { b, ajena }
  }
  const ESPERA_ORIGINAL = process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS
  const restaurarEspera = () => {
    if (ESPERA_ORIGINAL === undefined) delete process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS
    else process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS = ESPERA_ORIGINAL
  }
  /**
   * Un aprobado del intento que entra por el FALLBACK: con el candado sostenido por otra transacción y la espera acortada a 300 ms,
   * el ingreso vence (55P03) y persiste sin serializar; el registrador (bajo el mismo candado) también vence y el evento queda
   * PENDING/PROCESSING_ERROR para S4. La protección (montaje + espera + env) empieza ANTES del lanzamiento y se restaura en un
   * `finally` exterior aunque `cerrar` lance (Codex R15-3).
   */
  const ingresoPorElFallback = async (A: string, over: Record<string, unknown>, cuantos = 1): Promise<string[]> => {
    const Act = actores()
    const { b, ajena } = sostenerCandado(Act, A)
    let fallo: Fallo = null
    const ids: string[] = []
    process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS = '300'
    try {
      try {
        expect(await b.pausadaEn(10_000)).toBe(true)
        for (let i = 0; i < cuantos; i++) {
          const ingreso = Act.lanzar(`ingreso por el fallback #${i + 1}`, webhook(A, over, M2))
          // Acotado por el propio `lock_timeout` (300 ms al ingresar + 300 ms en el registrador); el reloj sólo cae si algo se cuelga.
          const desenlace = await Act.carrera(ingreso, 10_000)
          expect(desenlace).toMatchObject({ estado: 'ASENTADA', ok: true })
          const { result, eventId } = (desenlace as Extract<typeof desenlace, { ok: true }>).value
          ids.push(eventId)
          expect(result).toMatchObject({ action: 'ERROR', errorReason: 'PROCESSING_ERROR' })
          expect(await eventoDe(eventId)).toMatchObject({ status: 'PENDING', paymentId: null })
          expect(await marcaDe(eventId)).toEqual({ en: expect.any(String) })
        }
        expect(await pagos(A)).toBe(0)
      } catch (error) {
        fallo = { error }
      } finally {
        await Act.liberar({ 'candado ajeno': () => b.liberar() })
      }
      await Act.cerrar(fallo)
      await Act.afirmar(async () => {
        await ajena.resultado()
      })
    } finally {
      restaurarEspera()
    }
    return ids
  }
  afterEach(async () => {
    jest.restoreAllMocks()
    restaurarEspera()
    await secundariaAl(0.025)
  })

  it('FALLBACK · E1 (2.5 %, PENDING, fechado 5 s en el FUTURO) → SECONDARY al 8 % → OTRA transacción sostiene el candado y E2 (aprobado, mismo intento) entra por el fallback: se persiste MARCADO y sin orden, con `createdAt` ANTERIOR a E1 (la prioridad inventada); S4 lo ordena DESPUÉS de E1 bajo el candado (`ordenadoEn`), el Payment nace con `capturaFallida.total: EVIDENCIA_DE_INGRESO_SIN_ORDEN` —nunca $8.50 ni $3—, los dos eventos se sellan sobre ese único Payment, la marca PERMANECE y el REST no la levanta', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const e1 = await ingresoSinPayment(A, R)
    // 5 s en el futuro: cada ingreso por el fallback tarda ~0.6 s (300 ms al ingresar + 300 ms en el registrador) y el reloj nunca lo alcanza.
    const futuro = new Date(Date.now() + 5000)
    await prisma.providerEventLog.updateMany({ where: { eventId: `angelpay-${e1}` }, data: { createdAt: futuro } })
    await secundariaAl(0.08)
    const [e2] = await ingresoPorElFallback(A, { transactionId: R })
    // Sin candado el evento se fechó con el reloj: quedó ANTES de E1 — la prioridad histórica que NO puede acreditarse.
    expect((await eventoDe(e2)).createdAt.getTime()).toBeLessThan(futuro.getTime())
    // S4: ordena E2 bajo el candado (DESPUÉS de E1 aunque E1 esté en el futuro — sin el reloj) y registra con incertidumbre.
    expect((await correrWorker()).sort()).toEqual(['PROCESSED', 'PROCESSED'])
    const p = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(p.status).toBe('COMPLETED')
    expect(snapshotDe(p)).toMatchObject({ merchantAccountId: M2.id, slot: null, venue: null, ...sinOrden })
    expect(await pagos(A)).toBe(1)
    expect(await eventoDe(e1)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    const e2Ordenado = await eventoDe(e2)
    expect(e2Ordenado).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(e2Ordenado.createdAt.getTime()).toBeGreaterThan(futuro.getTime())
    const marca = await marcaDe(e2)
    expect(marca).toEqual({ en: expect.any(String), ordenadoEn: expect.any(String) })
    // El REST acredita el MÉTODO, no el orden: el costo sigue pendiente con motivo público — sin costo ni comisión, nunca $8.50 ni $3.
    expect((await restQueAcredita(A, solicitud.requestId, R)).id).toBe(p.id)
    await expect(cerrar(p.id, enTresHoras())).resolves.toBe(false)
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'PRICING_CAPTURE_FAILED' })
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    const despues = await pago(p.id)
    expect(snapshotDe(despues)).toMatchObject(sinOrden)
    expect(despues.processorData).toMatchObject({ costPending: true })
    expect(Number(despues.feeAmount ?? 0)).toBe(0)
    // Idempotente: otra pasada del worker no reordena ni vuelve a sellar.
    expect(await correrWorker()).toEqual([])
    expect(await marcaDe(e2)).toEqual(marca)
    expect((await eventoDe(e2)).createdAt.getTime()).toBe(e2Ordenado.createdAt.getTime())
  })

  it('RECUPERACIÓN ANTES DEL PRIMER PAYMENT · sin evidencia previa, E2 entra por el fallback (marcado, sin orden); el siguiente INGRESO normal del intento (E3, rechazado) lo ordena bajo el candado —`max(createdAt)+1 ms`, y E3 nace DESPUÉS de él— sellando `ordenadoEn`; el REST que después crea el Payment sigue viendo ORDEN_NO_ACREDITADO: un orden de recuperación no acredita la prioridad histórica', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const [e2] = await ingresoPorElFallback(A, { transactionId: R })
    const antes = (await eventoDe(e2)).createdAt
    // Ingreso NORMAL (con candado) de un rechazo del mismo intento: ordena PRIMERO lo pendiente y nace después de ello.
    const { result: r3, eventId: e3 } = await webhook(A, { status: 'declined', transactionId: `${R}-3` }, M2)
    expect(r3.action).toBe('NOT_APPROVED')
    const e2Ordenado = await eventoDe(e2)
    expect(await marcaDe(e2)).toEqual({ en: expect.any(String), ordenadoEn: expect.any(String) })
    expect(e2Ordenado.createdAt.getTime()).toBe(antes.getTime() + 1)
    expect((await eventoDe(e3)).createdAt.getTime()).toBeGreaterThan(e2Ordenado.createdAt.getTime())
    expect(await marcaDe(e3)).toBeUndefined()
    // El REST crea el Payment: ORDEN_NO_ACREDITADO — nunca la captura de E2 (2.5 %) ni la tarifa de hoy.
    const p = await restQueAcredita(A, solicitud.requestId, R)
    expect(p.status).toBe('COMPLETED')
    expect(snapshotDe(p)).toMatchObject({ merchantAccountId: M2.id, slot: null, venue: null, ...sinOrden })
    expect(await efectoDe(p.id)).toMatchObject({ status: 'PENDING', lastError: 'PRICING_CAPTURE_FAILED' })
    expect(await prisma.transactionCost.count({ where: { paymentId: p.id } })).toBe(0)
    // El backfill del REST (fuera de la petición) o S4 sellan E2 sobre ESE Payment; el snapshot conserva la incertidumbre.
    await correrWorker()
    expect(await f.esperar(async () => (await eventoDe(e2)).status === 'PROCESSED', 5000)).toBe(true)
    expect(await eventoDe(e2)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(await pagos(A)).toBe(1)
    expect(snapshotDe(await pago(p.id))).toMatchObject(sinOrden)
  })

  it('VARIOS PENDIENTES · E1 (PENDING, 5 s en el FUTURO) y, con el candado sostenido por OTRA transacción, E2 y E3 entran por el fallback; S4 los ordena por `id` bajo el candado, cada uno estrictamente DESPUÉS del anterior (`max(createdAt)+1 ms`, nunca con el reloj: los dos quedan después del futuro de E1), sella `ordenadoEn` en ambos, y el ÚNICO Payment nace con `EVIDENCIA_DE_INGRESO_SIN_ORDEN` con los tres eventos sellados sobre él', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const e1 = await ingresoSinPayment(A, R)
    // 5 s en el futuro: cada ingreso por el fallback tarda ~0.6 s (300 ms al ingresar + 300 ms en el registrador) y el reloj nunca lo alcanza.
    const futuro = new Date(Date.now() + 5000)
    await prisma.providerEventLog.updateMany({ where: { eventId: `angelpay-${e1}` }, data: { createdAt: futuro } })
    const [e2, e3] = await ingresoPorElFallback(A, { transactionId: R }, 2)
    for (const e of [e2, e3]) expect((await eventoDe(e)).createdAt.getTime()).toBeLessThan(futuro.getTime())
    expect((await correrWorker()).sort()).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED'])
    const p = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(snapshotDe(p)).toMatchObject({ merchantAccountId: M2.id, slot: null, ...sinOrden })
    expect(await pagos(A)).toBe(1)
    const ordenados = (await Promise.all([e2, e3].map(e => eventoDe(e)))).sort((a, b) => (a.id < b.id ? -1 : 1))
    for (const e of ordenados) {
      expect(e).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
      expect(e.createdAt.getTime()).toBeGreaterThan(futuro.getTime())
    }
    expect(ordenados[1].createdAt.getTime()).toBeGreaterThan(ordenados[0].createdAt.getTime())
    expect(await marcaDe(e2)).toEqual({ en: expect.any(String), ordenadoEn: expect.any(String) })
    expect(await marcaDe(e3)).toEqual({ en: expect.any(String), ordenadoEn: expect.any(String) })
    expect(await eventoDe(e1)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect(await marcaDe(e1)).toBeUndefined()
  })

  it('CANDADO · la recuperación de S4 (`ordenarIngresosSinCandado`) corre en transacción PROPIA con el candado del intento PRIMERO y revalida el claim: con un token que no es el vigente no ordena nada; con el candado sostenido por OTRA transacción ESPERA (pg_locks) sin ordenar; al soltarse ordena el pendiente y sella `ordenadoEn`, y el worker registra después con incertidumbre', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const [e2] = await ingresoPorElFallback(A, { transactionId: R })
    const filaE2 = await eventoDe(e2)
    // Claim que ya NO es el vigente (o nunca lo fue): no ordena y no falla.
    expect(await ordenarIngresosSinCandado({ llave: A, eventLogId: filaE2.id, claimToken: randomUUID() })).toEqual({ ordenados: 0 })
    expect(await marcaDe(e2)).toEqual({ en: expect.any(String) })
    // El worker real reclama E2 (token vigente); la recuperación con ese token compite con OTRA transacción que sostiene el candado.
    await prisma.providerEventLog.updateMany({ where: { id: filaE2.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    const claims = await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })
    expect(claims.map(c => c.id)).toEqual([filaE2.id])
    const [claim] = claims
    const Act = actores()
    const obs = observatorioDeCandados()
    const { b, ajena } = sostenerCandado(Act, A)
    let recuperacion!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof ordenarIngresosSinCandado>>>>
    let espera = null as EsperaAtribuida | null
    let fallo: Fallo = null
    try {
      expect(await b.pausadaEn(10_000)).toBe(true)
      recuperacion = Act.lanzar(
        'recuperación bajo el candado',
        ordenarIngresosSinCandado({ llave: A, eventLogId: claim.id, claimToken: claim.claimToken }),
      )
      // La propiedad bajo prueba, por aserción y ATRIBUIDA (Codex R16-2): la recuperación pidió la llave de A y ESPERA, bloqueada
      // por la transacción ajena a la que A le fue concedida…
      expect(await f.esperar(async () => (espera = await obs.esperaAtribuida(A)) !== null, 5000)).toBe(true)
      // …y mientras espera no ha ordenado nada.
      expect(await marcaDe(e2)).toEqual({ en: expect.any(String) })
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ 'candado ajeno': () => b.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      await ajena.resultado()
      expect(await recuperacion.resultado()).toEqual({ ordenados: 1 })
      expect(espera).toEqual({ actor: expect.any(Number), poseedor: expect.any(Number) })
      expect(espera!.actor).not.toBe(espera!.poseedor)
      expect(await marcaDe(e2)).toEqual({ en: expect.any(String), ordenadoEn: expect.any(String) })
      expect((await eventoDe(e2)).createdAt.getTime()).toBe(filaE2.createdAt.getTime() + 1)
    })
    // El worker termina su claim: ya no hay nada que ordenar, y registra con la incertidumbre conservada.
    expect(await runClaimedAngelPayEvent(claim)).toBe('PROCESSED')
    const p = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(snapshotDe(p)).toMatchObject({ merchantAccountId: M2.id, slot: null, ...sinOrden })
    expect(await eventoDe(e2)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
    expect((await eventoDe(e2)).createdAt.getTime()).toBe(filaE2.createdAt.getTime() + 1)
  })

  /**
   * Codex R15-1 (Codex: «las dos direcciones ingreso↔REST para fast y orden, observando el PID del actor que espera»): pausa el INGRESO
   * del evento DENTRO de su transacción, con el candado del intento ya tomado y el evento todavía sin insertar (justo después de la
   * lectura con el marcador SQL «ingreso del intento»). Codex R16-2: es el observatorio de candados con la pausa incorporada.
   */
  const pausarElIngreso = (b: ReturnType<typeof barrera>) => observatorioDeCandados({ pausarTras: { marcador: 'ingreso del intento', b } })
  /** La INVERSA de las carreras de R14-1: el ingreso de E1 tiene el candado; el REST (rápido o con orden) ESPERA y consume SU captura. */
  const inversaIngresoPrimero = async (conOrden: boolean) => {
    const R = `${Date.now()}`
    const venta = conOrden ? await f.nuevaVenta() : null
    const solicitud = await f.solicitud(venta ? { orderId: venta.id } : {})
    const A = await vincular(solicitud.requestId)
    const Act = actores()
    const b = barrera()
    const obs = pausarElIngreso(b)
    const registro = () =>
      venta
        ? recordOrderPayment(
            f.venueId,
            venta.id,
            {
              ...f.registroDeLaTerminal({
                attemptId: A,
                requestId: solicitud.requestId,
                ref: R,
                tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' },
              }),
              merchantAccountId: M2.id,
            },
            f.staffId,
          )
        : restQueAcredita(A, solicitud.requestId, R)
    let rest!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof registro>>>>
    let espera = null as EsperaAtribuida | null
    let fallo: Fallo = null
    // E1 captura 2.5 % al ingreso (antes del candado) y se pausa DENTRO de su transacción con el candado tomado, sin insertar todavía.
    const ingreso = Act.lanzar('ingreso de E1 (en vuelo)', webhook(A, { transactionId: R }, M2))
    try {
      expect(await b.pausadaEn(5000)).toBe(true)
      expect(await prisma.providerEventLog.count({ where: { attemptId: A } })).toBe(0)
      await secundariaAl(0.08)
      rest = Act.lanzar(conOrden ? 'REST con orden' : 'REST rápido', registro())
      // La propiedad bajo prueba, por aserción y ATRIBUIDA (Codex R16-2): el REST pidió la llave de A y ESPERA, bloqueado por la
      // transacción del ingreso, a la que A le fue concedida.
      expect(await f.esperar(async () => (espera = await obs.esperaAtribuida(A)) !== null, 5000)).toBe(true)
      expect(await pagos(A)).toBe(0)
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ 'ingreso pausado': () => b.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      const { result, eventId } = await ingreso.resultado()
      const p = await rest.resultado()
      expect(espera).toEqual({ actor: expect.any(Number), poseedor: expect.any(Number) })
      expect(espera!.actor).not.toBe(espera!.poseedor)
      expect(p.status).toBe('COMPLETED')
      if (venta) expect(p.orderId).toBe(venta.id)
      expect(result.action).not.toBe('ERROR')
      expect(await pagos(A)).toBe(1)
      // El REST consumió la captura del INGRESO (2.5 %, el `frozenAt` de E1), no la tarifa vigente al cobrar (8 %): fee $3, nunca $8.50.
      const captura = (((await eventoDe(eventId)).payload as Record<string, unknown>)._avoqado as Record<string, unknown>)
        .tarifaCongeladaAlIngreso as { pricing: Record<string, unknown> } | undefined
      expect(captura).toMatchObject({ pricing: { venue: { creditRate: '0.025' } } })
      expect(snapshotDe(await pago(p.id))).toEqual(captura!.pricing)
      expect(await marcaDe(eventId)).toBeUndefined()
      expect(await eventoDe(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
      expect(Number((await pago(p.id)).feeAmount)).toBe(3)
      if (venta) expect(await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).toMatchObject({ paymentStatus: 'PAID' })
    })
  }

  it('INVERSA · venta RÁPIDA: el INGRESO de E1 tiene el candado del intento (pausado con el evento aún sin insertar); la edición al 8 % y el REST llegan mientras tanto: el REST ESPERA el candado (pg_locks) y, al soltarse, consume la captura del ingreso — snapshot 2.5 % con el `frozenAt` de E1, fee $3, un solo Payment', async () => {
    await inversaIngresoPrimero(false)
  })

  it('INVERSA · con ORDEN: el INGRESO de E1 tiene el candado; `recordOrderPayment` ESPERA (pg_locks) y consume la captura del ingreso — snapshot 2.5 % con el `frozenAt` de E1, fee $3, la cuenta pagada UNA vez', async () => {
    await inversaIngresoPrimero(true)
  })

  it('CARRERA con ORDEN · `recordOrderPayment` toma el candado del intento y captura «ahora» (2.5 %) sin evidencia previa; la edición al 8 % y el ingreso de E1 llegan mientras sigue abierto: el ingreso ESPERA el candado (pg_locks) y, al soltarse, E1 se sella sobre el Payment del REST — snapshot 2.5 %, fee $3, la cuenta pagada UNA vez', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const A = await vincular(solicitud.requestId)
    const Act = actores()
    const b = barrera()
    let capturaDelRest = 0
    const real = configuracionDePagos.getEffectivePricingForSlot
    jest.spyOn(configuracionDePagos, 'getEffectivePricingForSlot').mockImplementationOnce(async (venueId, slot, at, db) => {
      capturaDelRest++
      b.pausado()
      await b.liberada
      return real(venueId, slot, at, db)
    })
    let ingreso!: ReturnType<typeof Act.lanzar<Awaited<ReturnType<typeof webhook>>>>
    let espera = null as EsperaAtribuida | null
    let fallo: Fallo = null
    const obs = observatorioDeCandados()
    const rest = Act.lanzar(
      'REST con orden',
      recordOrderPayment(
        f.venueId,
        venta.id,
        {
          ...f.registroDeLaTerminal({
            attemptId: A,
            requestId: solicitud.requestId,
            ref: R,
            tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' },
          }),
          merchantAccountId: M2.id,
        },
        f.staffId,
      ),
    )
    try {
      expect(await b.pausadaEn(5000)).toBe(true)
      expect(capturaDelRest).toBe(1)
      await secundariaAl(0.08)
      ingreso = Act.lanzar('ingreso de E1', webhook(A, { transactionId: R }, M2))
      // Codex R16-2: espera ATRIBUIDA — el ingreso pidió la llave de A y la transacción del dinero de `recordOrderPayment` lo bloquea.
      expect(await f.esperar(async () => (espera = await obs.esperaAtribuida(A)) !== null, 5000)).toBe(true)
      expect(await prisma.providerEventLog.count({ where: { attemptId: A } })).toBe(0)
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ 'captura del REST': () => b.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      const p = await rest.resultado()
      const { result, eventId } = await ingreso.resultado()
      expect(p.status).toBe('COMPLETED')
      expect(p.orderId).toBe(venta.id)
      expect(espera).toEqual({ actor: expect.any(Number), poseedor: expect.any(Number) })
      expect(espera!.actor).not.toBe(espera!.poseedor)
      expect(result.action).not.toBe('ERROR')
      expect(await pagos(A)).toBe(1)
      expect(snapshotDe(await pago(p.id))).toMatchObject({ merchantAccountId: M2.id, slot: 'SECONDARY', venue: { creditRate: '0.025' } })
      expect(await marcaDe(eventId)).toBeUndefined()
      expect(await eventoDe(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: p.id })
      expect(Number((await pago(p.id)).feeAmount)).toBe(3)
      expect(await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).toMatchObject({ paymentStatus: 'PAID' })
    })
  })
})

describe('Codex R16-2 · la espera del candado del intento se observa ATRIBUIDA (actor, poseedor y llave del intento), nunca como «algún advisory sin conceder»', () => {
  afterEach(() => jest.restoreAllMocks())
  /** La sonda VIEJA: cualquier advisory sin conceder, de cualquier pid y de cualquier llave. */
  const sinConceder = async () =>
    (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0].n
  const barrera = () => {
    let liberar!: () => void
    let pausado!: () => void
    const liberada = new Promise<void>(r => (liberar = r))
    const pausada = new Promise<void>(r => (pausado = r))
    const pausadaEn = (ms: number) =>
      Promise.race([
        pausada.then(() => true),
        new Promise<boolean>(r => {
          const t = setTimeout(() => r(false), ms)
          t.unref?.()
        }),
      ])
    return { liberar, pausado, liberada, pausadaEn }
  }
  /** OTRA transacción sostiene el candado del intento `llave` hasta que la prueba lo suelta (montaje registrado al lanzarlo). */
  const sostener = (Act: ReturnType<typeof actores>, llave: string, nombre: string) => {
    const b = barrera()
    const montaje = Act.montaje(
      nombre,
      prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NS_CANDADO_INTENTO}::int, hashtext(${llave}))::text`
          b.pausado()
          await b.liberada
        },
        { timeout: 20_000 },
      ),
    )
    return { b, montaje }
  }
  /** Un actor que PIDE el candado del intento por el camino real (`candadoDeIntento`, en transacción propia) y termina al obtenerlo. */
  const pedir = (llave: string) => prisma.$transaction(async tx => candadoDeIntento(tx, llave), OPCIONES_DE_TRANSACCION_DEL_INTENTO)

  it('CONTRAPRUEBA · un waiter AJENO (la llave B, bloqueado por el poseedor de B) deja un advisory sin conceder en pg_locks —la sonda vieja lo contaría— y NO satisface la atribución al intento A; un actor que pide la llave de A sí la satisface, con el poseedor de A como bloqueador y una pareja de pids DISTINTA de la de B', async () => {
    const A = randomUUID()
    const B = randomUUID()
    const obs = observatorioDeCandados()
    const Act = actores()
    const hA = sostener(Act, A, 'poseedor de A')
    const hB = sostener(Act, B, 'poseedor de B')
    let wB!: ReturnType<typeof Act.lanzar<void>>
    let wA!: ReturnType<typeof Act.lanzar<void>>
    const vistas = {
      viejaConWaiterAjeno: 0,
      atribuidaConWaiterAjeno: [] as (EsperaAtribuida | null)[],
      deA: null as EsperaAtribuida | null,
      deB: null as EsperaAtribuida | null,
    }
    let fallo: Fallo = null
    try {
      expect(await hA.b.pausadaEn(5000)).toBe(true)
      expect(await hB.b.pausadaEn(5000)).toBe(true)
      wB = Act.lanzar('waiter ajeno (llave B)', pedir(B))
      // La sonda vieja se satisface con el waiter ajeno (un advisory sin conceder, de otra llave)…
      expect(await f.esperar(async () => (vistas.viejaConWaiterAjeno = await sinConceder()) >= 1, 5000)).toBe(true)
      // …y la atribuida al intento A, NO — tres lecturas seguidas, con el waiter ajeno formado.
      for (let i = 0; i < 3; i++) vistas.atribuidaConWaiterAjeno.push(await obs.esperaAtribuida(A))
      wA = Act.lanzar('actor (llave A)', pedir(A))
      expect(await f.esperar(async () => (vistas.deA = await obs.esperaAtribuida(A)) !== null, 5000)).toBe(true)
      vistas.deB = await obs.esperaAtribuida(B)
    } catch (error) {
      fallo = { error }
    } finally {
      await Act.liberar({ 'poseedor de A': () => hA.b.liberar(), 'poseedor de B': () => hB.b.liberar() })
    }
    await Act.cerrar(fallo)
    await Act.afirmar(async () => {
      await hA.montaje.resultado()
      await hB.montaje.resultado()
      await wA.resultado()
      await wB.resultado()
      expect(vistas.viejaConWaiterAjeno).toBeGreaterThanOrEqual(1)
      expect(vistas.atribuidaConWaiterAjeno.map(v => (v ? 'ATRIBUIDA' : 'NINGUNA'))).toEqual(['NINGUNA', 'NINGUNA', 'NINGUNA'])
      // La pareja de A: el actor es el pid que PIDIÓ A (visto desde su conexión) y el poseedor el pid al que A le fue concedida.
      const pidieronA = obs.peticiones.filter(pet => pet.llave === A).map(pet => pet.pid)
      const pidieronB = obs.peticiones.filter(pet => pet.llave === B).map(pet => pet.pid)
      expect(vistas.deA).toEqual({ actor: pidieronA[1], poseedor: pidieronA[0] })
      expect(vistas.deB).toEqual({ actor: pidieronB[1], poseedor: pidieronB[0] })
      expect(vistas.deA!.actor).not.toBe(vistas.deA!.poseedor)
      expect(new Set([vistas.deA!.actor, vistas.deA!.poseedor, vistas.deB!.actor, vistas.deB!.poseedor]).size).toBe(4)
    })
  })
})
