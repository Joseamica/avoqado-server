/**
 * D10-B (founder, 2-nov: «B», se deja cobrar y sólo se avisa). Una caja intenta cobrar con tarjeta y queda en duda; otra cobra en
 * efectivo la MISMA venta:
 *  · la venta se cobra igual (POS en vivo y su cola sin red, terminal, panel) y queda UN `CASH_WITH_CARD_IN_DOUBT`;
 *  · el asiento va después del commit: si la consulta o el asiento fallan o se cuelgan, el cobro no se entera;
 *  · si después el banco o la terminal acreditan la tarjeta, su Payment se registra y salta el 🚨 para revisar y devolver.
 *
 * Contra Postgres real: «en duda», las llaves y el cierre de la fila son cosas de la base, no de un mock.
 */
import { randomUUID } from 'crypto'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigir, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
// El asiento se escribe de verdad: la configuración de integración deja `logAction` en `jest.fn()`.
jest.mock('@/services/dashboard/activity-log.service', () => jest.requireActual('@/services/dashboard/activity-log.service'))

const ACCION = 'CASH_WITH_CARD_IN_DOUBT'
let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('d10b')
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
  jest.restoreAllMocks()
  await prisma.paymentEffect.deleteMany({ where: { venueId: f.venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.posSyncIntent.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
  await prisma.customer.deleteMany({ where: { venueId: f.venueId } })
})
afterAll(() => f.destruir())

const asientos = (orderId: string) =>
  prisma.activityLog.findMany({ where: { venueId: f.venueId, action: ACCION, entityId: orderId }, take: 10 })
const cobros = (orderId: string) =>
  prisma.payment.findMany({ where: { venueId: f.venueId, orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 10 })
const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const orden = (orderId: string) => exigir(prisma.order.findUnique({ where: { id: orderId } }))
const pausa = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const gritos = (texto: string) => (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes(texto))

/** El rastro corre DESPUÉS de responder: se espera a que aparezca; para «no hay» o «no se repite», se le da tiempo de sobra. */
const esperarAsiento = async (orderId: string) => {
  expect(await f.esperar(async () => (await asientos(orderId)).length > 0)).toBe(true)
}
const darleTiempoAlRastro = () => pausa(400)

/** La tarjeta que otra caja intentó sobre esta venta: la terminal nunca contestó (la fila más común de una duda). */
const tarjetaEnDuda = (orderId: string, over: Record<string, unknown> = {}) =>
  f.solicitud({ orderId, status: 'UNKNOWN', failureCode: 'TIMED_OUT', expiresAt: new Date(Date.now() - 60_000), ...over })

const efectivoDelPos = (orderId: string, over: Partial<Parameters<typeof payCashOrder>[2]> = {}) =>
  payCashOrder(f.venueId, orderId, { amount: 10000, tip: 0, staffId: f.staffId, idempotencyKey: randomUUID(), ...over })

/** El efectivo de la terminal: el mismo registrador que la tarjeta, sin afiliación. */
const registroEnEfectivo = (attemptId: string, over: Record<string, unknown> = {}) => ({
  ...f.registroDeLaTerminal({ attemptId, sinMerchant: true }),
  method: 'CASH',
  authorizationNumber: undefined,
  ...over,
})
const efectivoDeLaTerminal = (orderId: string, attemptId: string = randomUUID(), over: Record<string, unknown> = {}) =>
  recordOrderPayment(f.venueId, orderId, registroEnEfectivo(attemptId, over) as any, f.staffId)

const payCashEnCola = (orderId: string, amountCents = 10000) => ({
  id: randomUUID(),
  seq: 1,
  type: 'PAY_CASH' as const,
  payload: { orderId, amountCents, tipCents: 0, method: 'CASH' },
})
const colaDelPos = (intent: ReturnType<typeof payCashEnCola>) =>
  processIntents({
    venueId: f.venueId,
    staffId: f.staffId,
    deviceId: `aparato-${f.fixture}`,
    intents: [intent],
    authorizeIntent: () => true,
  })

/** Una venta de fiado: lo único que se puede «liquidar» desde el panel. */
const ventaConSaldo = async (total = 100) => {
  const venta = await f.nuevaVenta(total)
  await prisma.order.update({ where: { id: venta.id }, data: { remainingBalance: total, payLater: true } })
  return venta
}

describe('D10-B · la venta se cobra igual y queda UN rastro', () => {
  it('POS en vivo con la terminal sin contestar (UNKNOWN): cobra, cierra la venta y deja UN asiento con la solicitud y el importe', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await tarjetaEnDuda(venta.id)

    const cobro = await efectivoDelPos(venta.id, { tip: 500 })

    expect(cobro).toMatchObject({ status: 'COMPLETED', method: 'CASH', amount: 10000, tipAmount: 500 })
    expect(await orden(venta.id)).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
    await esperarAsiento(venta.id)
    const [asiento, ...otros] = await asientos(venta.id)
    expect(otros).toEqual([])
    expect(asiento).toMatchObject({ entity: 'Order', entityId: venta.id, venueId: f.venueId, staffId: f.staffId })
    expect(asiento.data).toEqual({ requestId: solicitud.requestId, paymentId: cobro.paymentId, amount: 100, tipAmount: 5 })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('tarjeta en duda'),
      expect.objectContaining({ venueId: f.venueId, orderId: venta.id, requestId: solicitud.requestId, paymentId: cobro.paymentId }),
    )
    // Avisar no resuelve la duda: la fila sigue esperando su evidencia, para que un aprobado tardío la encuentre.
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
  })

  it.each([
    ['en vuelo (SENT)', { status: 'SENT', failureCode: null, expiresAt: new Date(Date.now() + 60_000) }],
    ['ranura suelta, venta en duda (TIMED_OUT/AUTO_RELEASED)', { status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' }],
    [
      'cerrada por la terminal sin Payment (COMPLETED sin pago)',
      { status: 'COMPLETED', failureCode: null, resultJson: { status: 'success' } },
    ],
  ])('POS en vivo con el cobro %s: también cuenta como duda', async (_nombre, estado) => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await tarjetaEnDuda(venta.id, estado)

    const cobro = await efectivoDelPos(venta.id)

    expect(cobro.status).toBe('COMPLETED')
    await esperarAsiento(venta.id)
    expect((await asientos(venta.id))[0].data).toMatchObject({ requestId: solicitud.requestId, paymentId: cobro.paymentId })
  })

  it('la cola sin red del POS (PAY_CASH): se registra y deja UN asiento; reenviar el mismo lote no repite ni el cobro ni el asiento', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await tarjetaEnDuda(venta.id)
    const intent = payCashEnCola(venta.id)

    const [ack] = await colaDelPos(intent)
    expect(ack).toMatchObject({ status: 'ACKED' })
    await esperarAsiento(venta.id)

    const [repetido] = await colaDelPos(intent)
    expect(repetido).toMatchObject({ status: 'ACKED' })
    await darleTiempoAlRastro()

    expect(await cobros(venta.id)).toHaveLength(1)
    const lista = await asientos(venta.id)
    expect(lista).toHaveLength(1)
    expect(lista[0].data).toMatchObject({ requestId: solicitud.requestId, amount: 100 })
  })

  it('el efectivo de la terminal, en vivo y de su cola: cobra y deja UN asiento por cobro', async () => {
    const viva = await f.nuevaVenta(100)
    const solicitudViva = await tarjetaEnDuda(viva.id)
    const cobroVivo = await efectivoDeLaTerminal(viva.id)
    expect(cobroVivo.status).toBe('COMPLETED')
    await esperarAsiento(viva.id)
    expect((await asientos(viva.id))[0].data).toEqual({
      requestId: solicitudViva.requestId,
      paymentId: cobroVivo.id,
      amount: 100,
      tipAmount: 0,
    })
    await prisma.terminalPaymentRequest.deleteMany({ where: { requestId: solicitudViva.requestId } })

    const deLaCola = await f.nuevaVenta(100)
    const solicitudCola = await tarjetaEnDuda(deLaCola.id)
    const cobroCola = await efectivoDeLaTerminal(deLaCola.id, randomUUID(), { isOfflineReplay: true })
    expect(cobroCola.status).toBe('COMPLETED')
    await esperarAsiento(deLaCola.id)
    expect((await asientos(deLaCola.id))[0].data).toMatchObject({ requestId: solicitudCola.requestId, paymentId: cobroCola.id })
  })

  it('el pago manual del panel con efectivo sobre esa venta: cobra y deja UN asiento', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await tarjetaEnDuda(venta.id)

    const pago = await createManualPayment(f.venueId, f.staffId, {
      orderId: venta.id,
      amount: '100.00',
      tipAmount: '0',
      method: 'CASH',
      source: 'OTHER',
    } as any)

    expect(pago.status).toBe('COMPLETED')
    await esperarAsiento(venta.id)
    const lista = await asientos(venta.id)
    expect(lista).toHaveLength(1)
    expect(lista[0]).toMatchObject({ staffId: f.staffId })
    expect(lista[0].data).toEqual({ requestId: solicitud.requestId, paymentId: pago.id, amount: 100, tipAmount: 0 })
  })

  it('liquidar una cuenta desde el panel (efectivo a nombre del negocio): liquida y deja UN asiento', async () => {
    const venta = await ventaConSaldo()
    const solicitud = await tarjetaEnDuda(venta.id)

    const resultado = await settleOrder(f.venueId, venta.id, undefined, f.staffId)

    expect(resultado.settledAmount).toBe(100)
    await esperarAsiento(venta.id)
    const [asiento] = await asientos(venta.id)
    const [pago] = await cobros(venta.id)
    expect(asiento).toMatchObject({ staffId: f.staffId })
    expect(asiento.data).toEqual({ requestId: solicitud.requestId, paymentId: pago.id, amount: 100, tipAmount: 0 })
  })

  it('liquidar el saldo de un cliente: sólo la cuenta con la tarjeta en duda deja asiento', async () => {
    const cliente = await prisma.customer.create({
      data: { venueId: f.venueId, firstName: 'Fiado', phone: `+5255${Date.now() % 100_000_000}` },
    })
    const conDuda = await ventaConSaldo()
    const sinDuda = await ventaConSaldo()
    await prisma.orderCustomer.createMany({
      data: [conDuda, sinDuda].map(v => ({ orderId: v.id, customerId: cliente.id, isPrimary: true })),
    })
    const solicitud = await tarjetaEnDuda(conDuda.id)

    const resultado = await settleCustomerBalance(f.venueId, cliente.id, undefined, f.staffId)

    expect(resultado.settledOrderCount).toBe(2)
    await esperarAsiento(conDuda.id)
    await darleTiempoAlRastro()
    const [pago] = await cobros(conDuda.id)
    expect((await asientos(conDuda.id)).map(a => a.data)).toEqual([
      { requestId: solicitud.requestId, paymentId: pago.id, amount: 100, tipAmount: 0 },
    ])
    expect(await asientos(sinDuda.id)).toEqual([])
  })
})

describe('D10-B · el rastro sólo acompaña efectivo NUEVO sobre una venta en duda', () => {
  it('reintento del POS con la misma llave: devuelve el mismo pago y no repite el asiento', async () => {
    const venta = await f.nuevaVenta(100)
    await tarjetaEnDuda(venta.id)
    const idempotencyKey = randomUUID()

    const primero = await efectivoDelPos(venta.id, { idempotencyKey })
    await esperarAsiento(venta.id)
    const segundo = await efectivoDelPos(venta.id, { idempotencyKey })
    await darleTiempoAlRastro()

    expect(segundo.paymentId).toBe(primero.paymentId)
    expect(await cobros(venta.id)).toHaveLength(1)
    expect(await asientos(venta.id)).toHaveLength(1)
  })

  it('reintento de la terminal con la misma llave, y la ráfaga sin llave sobre la venta ya saldada: UN cobro y UN asiento', async () => {
    const conLlave = await f.nuevaVenta(100)
    await tarjetaEnDuda(conLlave.id)
    const attemptId = randomUUID()
    const primero = await efectivoDeLaTerminal(conLlave.id, attemptId)
    await esperarAsiento(conLlave.id)
    const segundo = await efectivoDeLaTerminal(conLlave.id, attemptId)
    await darleTiempoAlRastro()
    expect(segundo.id).toBe(primero.id)
    expect(await asientos(conLlave.id)).toHaveLength(1)
    await prisma.terminalPaymentRequest.deleteMany({ where: { venueId: f.venueId } })

    const rafaga = await f.nuevaVenta(100)
    await tarjetaEnDuda(rafaga.id)
    const toque1 = await efectivoDeLaTerminal(rafaga.id, randomUUID(), { idempotencyKey: undefined, referenceNumber: `R1-${randomUUID()}` })
    await esperarAsiento(rafaga.id)
    const toque2 = await efectivoDeLaTerminal(rafaga.id, randomUUID(), { idempotencyKey: undefined, referenceNumber: `R2-${randomUUID()}` })
    await darleTiempoAlRastro()
    expect(toque2.id).toBe(toque1.id)
    expect(await cobros(rafaga.id)).toHaveLength(1)
    expect(await asientos(rafaga.id)).toHaveLength(1)
  })

  it('sin tarjeta en duda no hay asiento: venta sin intentos, intento acreditado o la duda es de OTRA venta', async () => {
    const sinIntentos = await f.nuevaVenta(100)
    const rechazada = await f.nuevaVenta(100)
    await f.solicitud({ orderId: rechazada.id, status: 'FAILED', failureCode: 'BANK_DECLINED', resultJson: { status: 'failed' } })
    const vecina = await f.nuevaVenta(100)
    const conDudaAjena = await f.nuevaVenta(100)
    await tarjetaEnDuda(vecina.id)

    for (const venta of [sinIntentos, rechazada, conDudaAjena]) {
      expect((await efectivoDelPos(venta.id)).status).toBe('COMPLETED')
    }
    await darleTiempoAlRastro()

    for (const venta of [sinIntentos, rechazada, conDudaAjena]) expect(await asientos(venta.id)).toEqual([])
    expect(await prisma.activityLog.count({ where: { venueId: f.venueId, action: ACCION } })).toBe(0)
  })

  it('otro medio declarado a mano (transferencia) no es efectivo: se registra sin asiento y sin preguntar por la terminal', async () => {
    const venta = await f.nuevaVenta(100)
    await tarjetaEnDuda(venta.id)
    const espia = jest.spyOn(terminalPaymentService, 'findChargeBlockingOrderCancel')

    const cobro = await efectivoDelPos(venta.id, { method: 'BANK_TRANSFER', externalSource: 'SPEI' })

    expect(cobro).toMatchObject({ status: 'COMPLETED', method: 'BANK_TRANSFER' })
    await darleTiempoAlRastro()
    expect(espia).not.toHaveBeenCalled()
    expect(await asientos(venta.id)).toEqual([])
  })

  it('el cobro con tarjeta de la terminal no paga una consulta de más ni deja este asiento', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await f.solicitud({ orderId: venta.id })
    const espia = jest.spyOn(terminalPaymentService, 'findChargeBlockingOrderCancel')

    await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId }),
      f.staffId,
    )

    await darleTiempoAlRastro()
    expect(espia).not.toHaveBeenCalled()
    expect(await asientos(venta.id)).toEqual([])
  })
})

describe('D10-B · el rastro nunca tumba ni demora el cobro', () => {
  const caminos: [string, (orderId: string) => Promise<unknown>][] = [
    ['POS', orderId => efectivoDelPos(orderId)],
    ['terminal', orderId => efectivoDeLaTerminal(orderId)],
  ]

  it.each(caminos)('%s: si la consulta de la duda truena, el cobro sale, sin asiento y con su aviso', async (_camino, cobrar) => {
    const venta = await f.nuevaVenta(100)
    await tarjetaEnDuda(venta.id)
    jest.spyOn(terminalPaymentService, 'findChargeBlockingOrderCancel').mockRejectedValueOnce(new Error('base caída'))

    await cobrar(venta.id)

    expect(await orden(venta.id)).toMatchObject({ paymentStatus: 'PAID' })
    expect(await f.esperar(async () => (logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('no se pudo revisar')))).toBe(
      true,
    )
    expect(await asientos(venta.id)).toEqual([])
  })

  it.each(caminos)('%s: si la consulta de la duda se cuelga, el cobro responde sin esperarla', async (_camino, cobrar) => {
    const venta = await f.nuevaVenta(100)
    await tarjetaEnDuda(venta.id)
    jest.spyOn(terminalPaymentService, 'findChargeBlockingOrderCancel').mockImplementationOnce(() => new Promise(() => undefined))

    await cobrar(venta.id)

    expect(await orden(venta.id)).toMatchObject({ paymentStatus: 'PAID' })
  })

  it.each(caminos)('%s: si escribir el asiento falla, el cobro sale y sigue el aviso en el log', async (_camino, cobrar) => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await tarjetaEnDuda(venta.id)
    const real = prisma.activityLog.create.bind(prisma.activityLog)
    jest
      .spyOn(prisma.activityLog, 'create')
      .mockImplementation(((args: { data: { action: string } }) =>
        args.data.action === ACCION ? Promise.reject(new Error('asiento roto')) : real(args as any)) as any)

    await cobrar(venta.id)

    expect(await orden(venta.id)).toMatchObject({ paymentStatus: 'PAID' })
    expect(
      await f.esperar(async () =>
        (logger.warn as jest.Mock).mock.calls.some(
          c => String(c[0]).includes('tarjeta en duda') && c[1]?.requestId === solicitud.requestId,
        ),
      ),
    ).toBe(true)
    await darleTiempoAlRastro()
    expect(await asientos(venta.id)).toEqual([])
  })
})

/**
 * Punto 3: lo que hace el servidor con un aprobado tardío sobre una venta ya pagada en efectivo. Cada prueba mide lo mismo:
 * el Payment nace y no se pierde, la fila se concilia, el efectivo sigue intacto, la venta sigue cerrada y salta el 🚨 con bitácora.
 */
describe('D10-B · si después la tarjeta SÍ pasó', () => {
  const sobrepagos = (orderId: string) =>
    prisma.activityLog.findMany({ where: { venueId: f.venueId, entityId: orderId, action: 'SOBREPAGO_DETECTADO' }, take: 10 })

  const pagadaEnEfectivoConDuda = async (estado: Record<string, unknown> = {}) => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await tarjetaEnDuda(venta.id, estado)
    const efectivo = await efectivoDelPos(venta.id)
    return { venta, solicitud, efectivo }
  }

  const exigirLaAlerta = async (ventaId: string, requestId: string, efectivoId: string, tarjetaId: string, estadoPrevio: string) => {
    expect(await f.esperar(async () => (await sobrepagos(ventaId)).length > 0)).toBe(true)
    await darleTiempoAlRastro()
    const lista = await cobros(ventaId)
    expect(lista.map(p => [p.id, p.method, p.status, Number(p.amount)])).toEqual(
      expect.arrayContaining([
        [efectivoId, 'CASH', 'COMPLETED', 100],
        [tarjetaId, 'CREDIT_CARD', 'COMPLETED', 100],
      ]),
    )
    expect(lista).toHaveLength(2)
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: tarjetaId, lateResult: true })
    expect(await orden(ventaId)).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
    expect(Number((await orden(ventaId)).paidAmount)).toBe(200)
    expect(Number((await orden(ventaId)).remainingBalance)).toBe(0)
    expect(gritos(`Payment recorded for an already-${estadoPrevio} request`)).toHaveLength(1)
    expect(gritos('🚨 [Sobrepago]')).toHaveLength(1)
    const [asiento, ...otros] = await sobrepagos(ventaId)
    expect(otros).toEqual([])
    expect(asiento.data).toMatchObject({ overpaidBy: 100, totalPaid: 200, orderTotal: 100, wasAlreadyPaid: true, paymentId: tarjetaId })
  }

  it('por REST de la terminal (`/fast`, como el cobro de la tablet) sobre la fila UNKNOWN: el dinero se registra y salta el 🚨', async () => {
    const { venta, solicitud, efectivo } = await pagadaEnEfectivoConDuda()

    const tarjeta = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId }),
      f.staffId,
    )

    expect(tarjeta.orderId).toBe(venta.id)
    await exigirLaAlerta(venta.id, solicitud.requestId, efectivo.paymentId, tarjeta.id, 'UNKNOWN')
  })

  it('por REST sobre la fila con la ranura ya suelta (TIMED_OUT/AUTO_RELEASED): igual', async () => {
    const { venta, solicitud, efectivo } = await pagadaEnEfectivoConDuda({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })

    const tarjeta = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId }),
      f.staffId,
    )

    await exigirLaAlerta(venta.id, solicitud.requestId, efectivo.paymentId, tarjeta.id, 'TIMED_OUT')
  })

  it('por webhook de AngelPay, sin REST de la terminal: el dinero se registra, salta el 🚨 y queda la bitácora del webhook', async () => {
    const { venta, solicitud, efectivo } = await pagadaEnEfectivoConDuda()
    const attemptId = randomUUID()
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId, requestId: solicitud.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
    })

    const { action, paymentId } = await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })

    expect(action).toBe('CONFIRMED')
    await exigirLaAlerta(venta.id, solicitud.requestId, efectivo.paymentId, paymentId!, 'UNKNOWN')
    expect(await fila(solicitud.requestId)).toMatchObject({ closedVia: 'webhook' })
    expect(
      await prisma.activityLog.count({
        where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK', entityId: solicitud.requestId },
      }),
    ).toBe(1)
  })

  it('la historia completa queda en la bitácora: el efectivo sobre la duda y, después, el sobrepago que nombra a la tarjeta', async () => {
    const { venta, solicitud, efectivo } = await pagadaEnEfectivoConDuda()
    await esperarAsiento(venta.id)

    const tarjeta = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId }),
      f.staffId,
    )

    await exigirLaAlerta(venta.id, solicitud.requestId, efectivo.paymentId, tarjeta.id, 'UNKNOWN')
    const lista = await asientos(venta.id)
    expect(lista.map(a => a.data)).toEqual([{ requestId: solicitud.requestId, paymentId: efectivo.paymentId, amount: 100, tipAmount: 0 }])
  })

  it('con la terminal todavía en vuelo (SENT): sin el 🚨 de la fila, pero el de sobrepago sí salta', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await f.solicitud({ orderId: venta.id })
    await efectivoDelPos(venta.id)

    const tarjeta = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId }),
      f.staffId,
    )

    expect(await f.esperar(async () => (await sobrepagos(venta.id)).length > 0)).toBe(true)
    expect(gritos('🚨 [Sobrepago]')).toHaveLength(1)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: tarjeta.id })
    expect((await sobrepagos(venta.id))[0].data).toMatchObject({ overpaidBy: 100, paymentId: tarjeta.id })
  })

  it('con efectivo parcial: si entre los dos pasan de la cuenta, salta; si la completan justo, no hay sobrepago', async () => {
    const pasada = await f.nuevaVenta(100)
    const dudaPasada = await tarjetaEnDuda(pasada.id)
    await efectivoDelPos(pasada.id, { amount: 6000 })
    expect(await orden(pasada.id)).toMatchObject({ paymentStatus: 'PARTIAL' })
    const tarjetaPasada = await recordOrderPayment(
      f.venueId,
      pasada.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: dudaPasada.requestId }),
      f.staffId,
    )
    expect(await f.esperar(async () => (await sobrepagos(pasada.id)).length > 0)).toBe(true)
    expect((await sobrepagos(pasada.id))[0].data).toMatchObject({ overpaidBy: 60, totalPaid: 160, paymentId: tarjetaPasada.id })
    await prisma.terminalPaymentRequest.deleteMany({ where: { requestId: dudaPasada.requestId } })

    const exacta = await f.nuevaVenta(100)
    const dudaExacta = await tarjetaEnDuda(exacta.id, { amountCents: 4000 })
    await efectivoDelPos(exacta.id, { amount: 6000 })
    await recordOrderPayment(
      f.venueId,
      exacta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: dudaExacta.requestId, amount: 4000 }),
      f.staffId,
    )
    await darleTiempoAlRastro()
    expect(await orden(exacta.id)).toMatchObject({ paymentStatus: 'PAID' })
    expect(await sobrepagos(exacta.id)).toEqual([])
    // El cierre tardío de la fila sí se grita: la duda se resolvió por dinero, no por sobrepago.
    expect(gritos('Payment recorded for an already-UNKNOWN request').length).toBeGreaterThanOrEqual(1)
  })
})
