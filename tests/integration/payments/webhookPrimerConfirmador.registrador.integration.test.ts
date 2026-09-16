/**
 * S0 + S3 del checkpoint 1 (webhook como primer confirmador): el REGISTRADOR COMPARTIDO.
 * Diseño en `docs/superpowers/plans/2026-09-12-webhook-primer-confirmador.md` («Diseño de S0 + S3»).
 *
 *  · S0: UNA solicitud tiene UN ganador financiero canónico, decidido dentro de la transacción del registrador
 *    (candado sobre la fila de la solicitud, antes de reclamar turno). El segundo intento acreditado es una POSIBLE
 *    SEGUNDA CAPTURA: Payment PENDING con marcador de conciliación, sin turno, sin VenueTransaction, sin tocar lo
 *    pagado de la orden, con bitácora. `closeRowFromPaymentTx` devuelve el desenlace y escribe la columna
 *    `Payment.terminalPaymentRequestId` junto con `paymentId`; una fila COMPLETED sin `paymentId` (cerrada por socket
 *    antes del registro) SÍ liga al primer registro.
 *  · S0-a: la deduplicación por referencia sin llave exige identidad suficiente (orden, importe, propina).
 *  · S3: el registro posterior con la misma llave ENRIQUECE lo vacío (marca, PAN enmascarado, modo de entrada) y
 *    nunca el dinero; una contradicción se señala y no se fusiona.
 *
 * Las 4 adversariales de `webhookPrimerConfirmador.legacy.integration.test.ts` (bloque B) se vuelven verdes con esto.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { consolidarRegistroRepetido } from '@/services/tpv/registroRepetido'
import * as registroRepetido from '@/services/tpv/registroRepetido'
import { esEvidenciaDeConciliacion } from '@/services/tpv/segundaCaptura'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture, type IntentoRest, exigir } from './webhookCheckpoint.fixture'
import { actores, type Fallo } from './actores'
import { NS_CANDADO_INTENTO } from '@/services/tpv/candadoDeIntento'
import { NS_CANDADO_REFERENCIA, llaveDeReferencia } from '@/services/tpv/candadoDeReferencia'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const MARCA_SEGUNDA_CAPTURA = 'POSSIBLE_SECOND_CAPTURE'
let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('s0')
})

beforeEach(() => {
  jest.clearAllMocks()
  const socket = { emit: jest.fn(), timeout: () => ({ emit: jest.fn() }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([['fixture-socket', socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
    terminalId,
    venueId: f.venueId,
    socketId: 'fixture-socket',
    terminalPaymentAckVersion: 1,
  }))
})

afterEach(() => f.limpiar())
afterAll(() => f.destruir())

const pago = (id: string) => exigir(prisma.payment.findUnique({ where: { id } }))
const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const bitacora = (action: string) => (logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === action).map(([p]) => p)

async function turnoAbierto() {
  return prisma.shift.create({ data: { venueId: f.venueId, staffId: f.staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 } })
}

describe('S0 · un ganador por solicitud', () => {
  it('fila COMPLETED sin paymentId (cerrada por socket antes del registro): el primer REST liga y gana; el segundo es segunda captura', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id, status: 'COMPLETED', resultJson: { status: 'success' } })
    const [A, B] = [randomUUID(), randomUUID()]

    const ganador = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }),
      f.staffId,
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: ganador.id })
    expect((await pago(ganador.id)).terminalPaymentRequestId).toBe(solicitud.requestId)

    const segunda = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: B, requestId: solicitud.requestId }),
      f.staffId,
    )
    expect(segunda.id).not.toBe(ganador.id)
    const guardada = await pago(segunda.id)
    expect(guardada.status).toBe('PENDING')
    expect(guardada.terminalPaymentRequestId).toBe(solicitud.requestId)
    expect((guardada.processorData as any).reconciliation).toMatchObject({
      kind: MARCA_SEGUNDA_CAPTURA,
      requestId: solicitud.requestId,
      winnerPaymentId: ganador.id,
    })
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)
  })

  it('la segunda captura no reclama turno, no crea VenueTransaction, no altera lo pagado de la orden y deja bitácora', async () => {
    const turno = await turnoAbierto()
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const [A, B] = [randomUUID(), randomUUID()]

    const ganador = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }),
      f.staffId,
    )
    const segunda = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: B, requestId: solicitud.requestId }),
      f.staffId,
    )

    const guardada = await pago(segunda.id)
    expect(guardada.status).toBe('PENDING')
    expect(guardada.shiftId).toBeNull()
    expect(guardada.orderId).toBe(venta.id)
    const turnoDespues = await exigir(prisma.shift.findUnique({ where: { id: turno.id } }))
    expect(Number(turnoDespues.totalSales)).toBe(100)
    expect(turnoDespues.totalOrders).toBe(1)
    expect(await prisma.venueTransaction.count({ where: { paymentId: segunda.id } })).toBe(0)
    expect(await prisma.venueTransaction.count({ where: { paymentId: ganador.id } })).toBe(1)
    const orden = await exigir(prisma.order.findUnique({ where: { id: venta.id } }))
    expect(orden.paymentStatus).toBe('PAID')
    expect(Number(orden.paidAmount)).toBe(100)
    expect(bitacora('TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE')).toEqual([
      expect.objectContaining({
        venueId: f.venueId,
        entity: 'Payment',
        entityId: segunda.id,
        data: expect.objectContaining({ requestId: solicitud.requestId, winnerPaymentId: ganador.id }),
      }),
    ])
  })

  it('en venta rápida (sin orden) la segunda captura cuelga de la MISMA venta del ganador: no nace otra venta', async () => {
    const solicitud = await f.solicitud({ orderId: null })
    const [A, B] = [randomUUID(), randomUUID()]

    const ganador = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }), f.staffId)
    const segunda = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: B, requestId: solicitud.requestId }), f.staffId)

    const guardada = await pago(segunda.id)
    expect(guardada.status).toBe('PENDING')
    expect(guardada.orderId).toBe(ganador.orderId)
    expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(1)
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)
    // P1-4 (Codex): la rama de evidencia sale ANTES de allocations, efectos, turno y costos.
    expect(await prisma.paymentAllocation.count({ where: { paymentId: segunda.id } })).toBe(0)
    expect(await prisma.paymentEffect.count({ where: { paymentId: segunda.id } })).toBe(0)
    expect(await prisma.venueTransaction.count({ where: { paymentId: segunda.id } })).toBe(0)
    expect(await prisma.transactionCost.count({ where: { paymentId: segunda.id } })).toBe(0)
    expect(guardada.shiftId).toBeNull()
    // El 2xx devuelve el Payment de B (nunca el de A) y trae recibo: la terminal lo exige para dar por REGISTRADO el intento.
    expect((segunda as any).possibleSecondCapture).toEqual({ requestId: solicitud.requestId, winnerPaymentId: ganador.id })
    expect((segunda as any).digitalReceipt?.receiptUrl).toEqual(expect.any(String))
  })

  it('la venta rápida con turno abierto: el turno no crece con la segunda captura', async () => {
    const turno = await turnoAbierto()
    const solicitud = await f.solicitud({ orderId: null })
    await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId }), f.staffId)
    await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId }), f.staffId)
    const turnoDespues = await exigir(prisma.shift.findUnique({ where: { id: turno.id } }))
    expect(Number(turnoDespues.totalSales)).toBe(100)
    expect(turnoDespues.totalOrders).toBe(1)
  })

  it('el reintento del PROPIO ganador (misma llave) sigue siendo idempotente, no una segunda captura', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const datos = f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId })

    const primero = await recordOrderPayment(f.venueId, venta.id, datos, f.staffId)
    const reintento = await recordOrderPayment(f.venueId, venta.id, datos, f.staffId)

    expect(reintento.id).toBe(primero.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
    expect(bitacora('TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE')).toEqual([])
  })
})

describe('S0 · closeRowFromPaymentTx dice lo que hizo y escribe la columna junto con paymentId', () => {
  async function pagoElegible(orderId: string | null, over: Record<string, unknown> = {}) {
    const terminal = await exigir(prisma.terminal.findFirst({ where: { venueId: f.venueId } }))
    const orden = orderId ?? (await f.nuevaVenta()).id
    return prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: orden,
        source: 'TPV',
        terminalId: terminal.id,
        amount: new Prisma.Decimal(100),
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(100),
        ...over,
      } as Prisma.PaymentUncheckedCreateInput,
    })
  }

  it('liga una fila en vuelo: bound=true, columna y paymentId en la misma escritura', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const p = await pagoElegible(venta.id)

    const desenlace = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, solicitud.requestId, p.id, f.venueId),
    )

    // S8: el desenlace también dice el estado previo y si disparó la alarma canónica (aquí no: estaba en vuelo).
    expect(desenlace).toEqual({ bound: true, reopened: false, contractMismatch: false, previousStatus: 'SENT', alarmed: false })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: p.id })
    expect((await pago(p.id)).terminalPaymentRequestId).toBe(solicitud.requestId)
  })

  it('una fila COMPLETED sin paymentId (cerrada por socket) SÍ liga al primer Payment; la segunda vez dice ALREADY_BOUND', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id, status: 'COMPLETED' })
    const p1 = await pagoElegible(venta.id)
    const p2 = await pagoElegible(venta.id)

    expect(
      await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, solicitud.requestId, p1.id, f.venueId)),
    ).toMatchObject({ bound: true })
    expect(
      await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, solicitud.requestId, p2.id, f.venueId)),
    ).toEqual({ bound: false, reason: 'ALREADY_BOUND' })
    expect((await fila(solicitud.requestId)).paymentId).toBe(p1.id)
    expect((await pago(p2.id)).terminalPaymentRequestId).toBeNull()
  })

  it('un Payment de OTRA terminal no liga y lo dice (TERMINAL_MISMATCH); una solicitud inexistente, NO_REQUEST', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const otra = await prisma.terminal.create({
      data: { venueId: f.venueId, name: 'otra', serialNumber: `AVQD-${randomUUID().slice(0, 10)}`, type: 'TPV_ANDROID' },
    })
    const p = await pagoElegible(venta.id, { terminalId: otra.id })

    expect(await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, solicitud.requestId, p.id, f.venueId))).toEqual(
      { bound: false, reason: 'TERMINAL_MISMATCH' },
    )
    expect(await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, randomUUID(), p.id, f.venueId))).toEqual({
      bound: false,
      reason: 'NO_REQUEST',
    })
    expect((await fila(solicitud.requestId)).paymentId).toBeNull()
  })
})

describe('S0 · asociación inválida: el requestId del payload no decide qué cobro sale de ventas (P1-2)', () => {
  it('otra terminal autenticada registra NORMAL (COMPLETED) sin ligar la solicitud ajena ni volverse segunda captura', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const ganador = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId }),
      f.staffId,
    )

    const ajeno = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId, serialAutenticado: 'AVQD-N86AJENA' }),
      f.staffId,
    )

    expect(await pago(ajeno.id)).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: null })
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)
    expect(bitacora('TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE')).toEqual([])
  })

  it('sin serial autenticado (llamada sin identidad) no se arbitra: cobro normal sin ligar', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })

    const registrado = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), requestId: solicitud.requestId, serialAutenticado: null }),
      f.staffId,
    )

    expect(await pago(registrado.id)).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: null })
    expect((await fila(solicitud.requestId)).paymentId).toBeNull()
  })

  it('un intento ya vinculado (S1) a OTRA solicitud no se clasifica contra ésta', async () => {
    const venta = await f.nuevaVenta()
    const otra = await f.solicitud({ orderId: (await f.nuevaVenta()).id, status: 'COMPLETED' })
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    await prisma.terminalPaymentAttemptLink.create({
      data: { requestId: otra.requestId, attemptId, venueId: f.venueId, terminalId: f.llaveTerminal },
    })

    const registrado = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }),
      f.staffId,
    )

    expect(await pago(registrado.id)).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: null })
    expect((await fila(solicitud.requestId)).paymentId).toBeNull()
  })
})

describe('S0 · vales (P1-3): B llega cuando la sesión de vales ya la pagó A', () => {
  it('A gana y prepara el intento de vales; B queda como segunda captura en vez de rebotar con 409', async () => {
    const venta = await f.nuevaVenta()
    const cajaDeVales = await prisma.terminal.create({
      data: {
        venueId: f.venueId,
        name: 'caja de vales',
        serialNumber: `AVQD-VALES${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`,
        type: 'TPV_ANDROID',
        deviceUid: `${f.fixture}-uid-${randomUUID().slice(0, 6)}`,
        canCheckoutAreaTickets: true,
      } as Prisma.TerminalUncheckedCreateInput,
    })
    const sesion = await prisma.areaTicketCheckoutSession.create({
      data: {
        venueId: f.venueId,
        terminalId: cajaDeVales.id,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        orderId: venta.id,
        status: 'MATERIALIZED',
      } as Prisma.AreaTicketCheckoutSessionUncheckedCreateInput,
    })
    const solicitud = await f.solicitud({ orderId: venta.id })
    const [A, B] = [randomUUID(), randomUUID()]

    const ganador = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }),
      f.staffId,
    )
    expect(await prisma.areaTicketPaymentAttempt.count({ where: { checkoutSessionId: sesion.id } })).toBe(1)

    const segunda = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: B, requestId: solicitud.requestId }),
      f.staffId,
    )

    expect((await pago(segunda.id)).status).toBe('PENDING')
    expect(await prisma.areaTicketPaymentAttempt.count({ where: { checkoutSessionId: sesion.id } })).toBe(1)
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)
  })
})

describe('S0 · los retornos idempotentes REPARAN el vínculo si falta (P1-5)', () => {
  it('el reintento con requestId liga una solicitud COMPLETED sin paymentId al Payment que ya existía', async () => {
    const venta = await f.nuevaVenta()
    const attemptId = randomUUID()
    const primero = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId }), f.staffId)
    const solicitud = await f.solicitud({ orderId: venta.id, status: 'COMPLETED' })

    const reintento = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }),
      f.staffId,
    )

    expect(reintento.id).toBe(primero.id)
    expect(await fila(solicitud.requestId)).toMatchObject({ paymentId: primero.id, closedVia: 'terminal' })
    expect((await pago(primero.id)).terminalPaymentRequestId).toBe(solicitud.requestId)
  })
})

describe('S0-a · identidad suficiente para deduplicar por referencia sin llave', () => {
  it('misma referencia con DISTINTO importe no devuelve el Payment ajeno (orden y venta rápida)', async () => {
    const venta = await f.nuevaVenta()
    const ref = `REF-COLISION-${randomUUID().slice(0, 6)}`
    const primero = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID(), ref }), f.staffId)
    const otraVenta = await f.nuevaVenta(50)

    const segundo = await recordOrderPayment(
      f.venueId,
      otraVenta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), ref, sinLlave: true, amount: 5000 }),
      f.staffId,
    )
    const rapido = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), ref, sinLlave: true, amount: 2500 }),
      f.staffId,
    )

    expect(new Set([primero.id, segundo.id, rapido.id]).size).toBe(3)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: ref } })).toBe(3)
  })

  it('misma referencia, mismo importe, misma orden y sin llave sigue siendo el reintento legacy: uno solo', async () => {
    const venta = await f.nuevaVenta()
    const ref = `REF-LEGACY-${randomUUID().slice(0, 6)}`
    const primero = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID(), ref }), f.staffId)

    const reintento = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), ref, sinLlave: true }),
      f.staffId,
    )

    expect(reintento.id).toBe(primero.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
  })

  it('misma referencia y mismo importe pero sobre OTRA orden: es otra venta, no un reintento', async () => {
    const venta = await f.nuevaVenta()
    const ref = `REF-OTRA-${randomUUID().slice(0, 6)}`
    const primero = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID(), ref }), f.staffId)
    const otraVenta = await f.nuevaVenta()

    const segundo = await recordOrderPayment(
      f.venueId,
      otraVenta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), ref, sinLlave: true }),
      f.staffId,
    )

    expect(segundo.id).not.toBe(primero.id)
    expect(segundo.orderId).toBe(otraVenta.id)
  })
})

describe('S3 · el registro posterior enriquece, no duplica', () => {
  it('con la misma llave rellena marca, PAN enmascarado y modo de entrada vacíos; el dinero no se toca', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const sinTarjeta = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }),
      f.staffId,
    )
    expect((await pago(sinTarjeta.id)).cardBrand).toBeNull()

    const conTarjeta = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({
        attemptId,
        requestId: solicitud.requestId,
        tarjeta: { cardBrand: 'VISA', maskedPan: '411111******1111', entryMode: 'CONTACTLESS', last4: '1111' },
      }),
      f.staffId,
    )

    expect(conTarjeta.id).toBe(sinTarjeta.id)
    const enriquecido = await pago(sinTarjeta.id)
    expect(enriquecido).toMatchObject({ cardBrand: 'VISA', maskedPan: '411111******1111', entryMode: 'CONTACTLESS', status: 'COMPLETED' })
    expect(Number(enriquecido.amount)).toBe(100)
    expect((enriquecido.processorData as any).last4).toBe('1111')
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
  })

  it('lo ya acreditado no se pisa: una marca distinta en el reintento es contradicción, no relleno', async () => {
    const venta = await f.nuevaVenta()
    const attemptId = randomUUID()
    const primero = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId, tarjeta: { cardBrand: 'VISA', maskedPan: '411111******1111' } }),
      f.staffId,
    )

    await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId, tarjeta: { cardBrand: 'MASTERCARD', maskedPan: '555555******4444' } }),
      f.staffId,
    )

    expect(await pago(primero.id)).toMatchObject({ cardBrand: 'VISA', maskedPan: '411111******1111' })
    expect(bitacora('TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION')).toHaveLength(1)
  })

  it('una contradicción de importe o propina no se fusiona: el Payment queda intacto y queda bitácora', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const primero = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }),
      f.staffId,
    )

    const contradictorio = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId, amount: 12000, tip: 500 }),
      f.staffId,
    )

    expect(contradictorio.id).toBe(primero.id)
    const intacto = await pago(primero.id)
    expect(Number(intacto.amount)).toBe(100)
    expect(Number(intacto.tipAmount)).toBe(0)
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
    expect(bitacora('TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION')).toEqual([
      expect.objectContaining({
        entityId: primero.id,
        data: expect.objectContaining({
          existente: expect.objectContaining({ amount: 100, tip: 0 }),
          entrante: expect.objectContaining({ amount: 120, tip: 5 }),
        }),
      }),
    ])
  })
})

describe('Codex R1 · P1-1c (diseño S0-a): sin llave, la referencia exige la misma terminal', () => {
  it('dos APK viejos (sin llave) de DOS terminales con la misma referencia e importe en el mismo segundo ⇒ dos Payments', async () => {
    const R = `${Date.now()}`
    const a = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const b = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: 'AVQD-N86OTRATERMINAL' }),
      f.staffId,
    )
    expect(b.id).not.toBe(a.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
  })

  it('el reintento legacy de la MISMA terminal (misma referencia, importe y serial) sigue siendo uno solo', async () => {
    const R = `${Date.now()}`
    const a = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const otraVez = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    expect(otraVez.id).toBe(a.id)
  })
})

describe('Codex R1 · P1-1c: dos llaves DISTINTAS nunca se deduplican por referencia', () => {
  it('misma referencia, importe, propina, orden y afiliación pero llaves distintas ⇒ dos Payments (venta con orden)', async () => {
    const venta = await f.nuevaVenta(200)
    const R = `${Date.now()}`
    const p1 = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R }), f.staffId)
    const p2 = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R }), f.staffId)
    expect(p2.id).not.toBe(p1.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
  })

  it('misma referencia y llaves distintas en venta rápida ⇒ dos Payments', async () => {
    const R = `${Date.now()}`
    const p1 = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R }), f.staffId)
    const p2 = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R }), f.staffId)
    expect(p2.id).not.toBe(p1.id)
  })

  it('sin llave (APK legacy) la misma referencia con identidad suficiente SIGUE deduplicando', async () => {
    const venta = await f.nuevaVenta(200)
    const R = `${Date.now()}`
    const p1 = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R, sinLlave: true }),
      f.staffId,
    )
    const p2 = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R, sinLlave: true }),
      f.staffId,
    )
    expect(p2.id).toBe(p1.id)
  })
})

describe('Codex R2 · P1-1: el reintento legacy elige SU Payment entre los candidatos de la misma referencia', () => {
  it('venta rápida: A con llave en la terminal T1 y B sin llave en T2 comparten referencia; el replay de B devuelve B (no crea un tercero)', async () => {
    const R = `${Date.now()}`
    const a = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R }), f.staffId)
    const b = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: 'AVQD-N86OTRATERMINAL' }),
      f.staffId,
    )
    expect(b.id).not.toBe(a.id)
    const replay = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: 'AVQD-N86OTRATERMINAL' }),
      f.staffId,
    )
    expect(replay.id).toBe(b.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
  })

  it('con orden: mismo caso sobre una orden de $200 pagada por A (llave, T1) y B (sin llave, T2); el replay de B devuelve B', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(200)
    const a = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R }), f.staffId)
    const b = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: 'AVQD-N86OTRATERMINAL' }),
      f.staffId,
    )
    expect(b.id).not.toBe(a.id)
    const replay = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: 'AVQD-N86OTRATERMINAL' }),
      f.staffId,
    )
    expect(replay.id).toBe(b.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
  })
})

describe('Codex R2 · P1-1: el candidato correcto puede NO ser el primero de la lista', () => {
  it('dos legacy sin llave de terminales distintas: la más NUEVA es de otra terminal y el replay de la más VIEJA devuelve la vieja', async () => {
    const R = `${Date.now()}`
    const vieja = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: 'AVQD-N86TERMINALVIEJA' }),
      f.staffId,
    )
    const nueva = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: 'AVQD-N86TERMINALNUEVA' }),
      f.staffId,
    )
    expect(nueva.id).not.toBe(vieja.id)
    // La lista viene «más reciente primero»: la NUEVA (otra terminal) se descarta y la VIEJA, segunda, es la elegida.
    const replay = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: 'AVQD-N86TERMINALVIEJA' }),
      f.staffId,
    )
    expect(replay.id).toBe(vieja.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
  })
})

describe('Codex R2 · P2-2: el enriquecimiento se decide sobre la fila VIGENTE y bloqueada, no sobre la copia del llamador', () => {
  it('una copia VIEJA que aún cree provisional el método no puede pisar lo que otro registro ya acreditó: es contradicción', async () => {
    const A = randomUUID()
    const nacido = await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: (await f.nuevaVenta()).id,
        amount: 100,
        tipAmount: 0,
        status: 'COMPLETED',
        method: 'CREDIT_CARD',
        source: 'TPV',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        idempotencyKey: A,
        merchantAccountId: f.merchantId,
        processedById: f.staffId,
        processorData: { registradoVia: 'webhook', methodProvisional: true, costPending: true, deviceSerialNumber: f.serial },
      },
      include: { receipts: true },
    })
    // Otro registro acredita el método REAL (crédito) mientras el llamador conserva su copia vieja (provisional).
    await consolidarRegistroRepetido(nacido, { ...f.registroDeLaTerminal({ attemptId: A }), method: 'CREDIT_CARD' }, f.venueId, null)
    expect(
      ((await exigir(prisma.payment.findUnique({ where: { id: nacido.id } }))).processorData as Record<string, unknown>).methodProvisional,
    ).toBe(false)

    // La copia vieja llega con DÉBITO: sobre la fila vigente ya no es provisional ⇒ contradicción, el método no se pisa.
    await consolidarRegistroRepetido(nacido, { ...f.registroDeLaTerminal({ attemptId: A }), method: 'DEBIT_CARD' }, f.venueId, null)
    const despues = await exigir(prisma.payment.findUnique({ where: { id: nacido.id } }))
    expect(despues.method).toBe('CREDIT_CARD')
    expect((despues.processorData as Record<string, unknown>).methodProvisional).toBe(false)
    // La bitácora está mockeada en esta suite: se comprueba la llamada, con el Payment y el campo en contradicción.
    const contradicciones = (logAction as jest.Mock).mock.calls
      .map(([p]) => p)
      .filter(p => p?.action === 'TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION' && p?.entityId === nacido.id)
    expect(contradicciones).toHaveLength(1)
    expect(contradicciones[0].data.campos).toContain('method')
  })
})

describe('Codex R3 · R3-1: la identidad se resuelve sobre TODOS los candidatos de la referencia, no sobre los primeros diez', () => {
  const serialDe = (i: number) => `AVQD-N86R3T${String(i).padStart(2, '0')}`
  const legacyDesde = (i: number, ref: string, amount = 10000) =>
    f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref, serialAutenticado: serialDe(i), amount })

  it('venta rápida: once legacy sin llave de once terminales con la misma referencia e importe; el replay de la más VIEJA la encuentra en la segunda página en vez de crear la doceava', async () => {
    const R = `${Date.now()}`
    const vieja = await recordFastPayment(f.venueId, legacyDesde(0, R), f.staffId)
    for (let i = 1; i <= 10; i++) await recordFastPayment(f.venueId, legacyDesde(i, R), f.staffId)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(11)

    const replay = await recordFastPayment(f.venueId, legacyDesde(0, R), f.staffId)
    expect(replay.id).toBe(vieja.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(11)
  })

  it('con orden: once terminales pagan $100 de una cuenta de $1,100 con la misma referencia; el replay de la primera devuelve la primera, no una doceava', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(1100)
    const primera = await recordOrderPayment(f.venueId, venta.id, legacyDesde(0, R), f.staffId)
    for (let i = 1; i <= 10; i++) await recordOrderPayment(f.venueId, venta.id, legacyDesde(i, R), f.staffId)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(11)

    const replay = await recordOrderPayment(f.venueId, venta.id, legacyDesde(0, R), f.staffId)
    expect(replay.id).toBe(primera.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(11)
  })

  it('los discriminadores van en la CONSULTA: doce cobros de OTRO importe con la misma referencia no son candidatos y no desplazan al reintento legítimo', async () => {
    const R = `${Date.now()}`
    const legitimo = await recordFastPayment(f.venueId, legacyDesde(0, R, 10000), f.staffId)
    for (let i = 1; i <= 12; i++) await recordFastPayment(f.venueId, legacyDesde(i, R, 5000), f.staffId)

    const replay = await recordFastPayment(f.venueId, legacyDesde(0, R, 10000), f.staffId)
    expect(replay.id).toBe(legitimo.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(13)
  })
})

describe('Codex R3 · R3-2: la asociación concurrente de una llave nunca confirma el Payment equivocado', () => {
  it('B legacy sin llave; K1 y K2 (llaves distintas, sin vínculo) esperan JUNTOS el candado de B: uno se queda con B y el otro NACE aparte — la carrera se observa en Postgres, con el bloqueador identificado', async () => {
    const R = `${Date.now()}`
    // La misma autorización en los tres: un reintento REAL repite auth y referencia; una auth distinta ya es contradicción.
    const auth = `AUTH-${R.slice(-6)}`
    const B = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth }),
      f.staffId,
    )

    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let pidDelCandado = 0
    const candado = prisma.$transaction(
      async tx => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${B.id} FOR UPDATE`
        pidDelCandado = pid
        await suelto
      },
      { timeout: 20_000 },
    )
    expect(await f.esperar(async () => pidDelCandado > 0)).toBe(true)
    const lineaBase = await f.pidsQueEsperan('consolidacion')

    const K1 = randomUUID()
    const K2 = randomUUID()
    // Codex R8/R9 (l): los dos registros en vuelo se capturan al lanzarlos; lo que se observa bajo el candado se RECOGE y se
    // afirma DESPUÉS de soltar y de asentar a los dos actores — ningún desenlace (ni un 503) aterriza detrás de una aserción.
    // Codex R12-13 (l): la transacción que sostiene el candado es un MONTAJE registrado desde su lanzamiento — si falla, la
    // prueba es INCONCLUSA con su causa, nunca una aserción financiera fallida a secas.
    const A = actores()
    const montaje = A.montaje('transacción que sostiene el candado de B', candado)
    const k1 = A.lanzar('K1', recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: K1, ref: R, auth }), f.staffId))
    const k2 = A.lanzar('K2', recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: K2, ref: R, auth }), f.staffId))
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    let fallo: Fallo = null
    try {
      // Barrera OBSERVABLE e IDENTIFICADA: los DOS registros ya eligieron a B y esperan el candado de la consolidación.
      // Postgres encola: el primero está bloqueado por ESTA transacción (pid) y el segundo por el primero — la cadena
      // termina siempre en el candado de la prueba, nunca en un bloqueador ajeno.
      enEspera = await f.esperarBloqueados('consolidacion', 2, 5000, lineaBase)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'candado de B': () => soltar() })
    }
    await A.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A.afirmar(async () => {
      await expect(montaje.resultado()).resolves.toBeUndefined()
      // NINGUNO de los dos rechaza: un 503 («no pude confirmar») aquí significaría que la relectura bajo el candado no fue una
      // fotografía NUEVA (Codex R6-2 (c): READ COMMITTED explícito — bajo REPEATABLE READ el segundo no ve la llave que el
      // primero acaba de escribir y su FOR UPDATE falla por serialización).
      // Codex R11 (l): cada desenlace se afirma POR SEPARADO — un `Promise.all` de los dos `resultado()` entregaba sólo el
      // PRIMER rechazo y marcaba examinado al segundo sin que nadie lo viera. Si K1 cae aquí, `afirmar` examina a K2 igual.
      const r1 = await k1.resultado().then(
        v => ({ ok: true as const, v }),
        e => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
      )
      expect(r1).toMatchObject({ ok: true })
      const r2 = await k2.resultado().then(
        v => ({ ok: true as const, v }),
        e => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
      )
      expect(r2).toMatchObject({ ok: true })
      expect(enEspera).toHaveLength(2)
      const enCola = new Set([pidDelCandado, ...enEspera.map(x => x.pid)])
      expect(enEspera.some(x => x.bloqueadoPor.includes(pidDelCandado))).toBe(true)
      for (const x of enEspera) expect(x.bloqueadoPor.some(b => enCola.has(b))).toBe(true)
      const [p1, p2] = [
        (r1 as { ok: true; v: { id: string; idempotencyKey: string | null } }).v,
        (r2 as { ok: true; v: { id: string; idempotencyKey: string | null } }).v,
      ]
      expect(new Set([p1.id, p2.id]).size).toBe(2)
      const conB = await pago(B.id)
      expect([K1, K2]).toContain(conB.idempotencyKey)
      const nuevo = p1.id === B.id ? p2 : p1
      expect(nuevo.id).not.toBe(B.id)
      expect(nuevo.idempotencyKey).toBe(conB.idempotencyKey === K1 ? K2 : K1)
      expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
    })
  })

  it('bajo el candado, una fila que OTRO escritor ya acreditó con su llave deja de ser este cobro: la consolidación devuelve null y no toca nada', async () => {
    const R = `${Date.now()}`
    const B = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const copia = await exigir(prisma.payment.findUnique({ where: { id: B.id }, include: { receipts: true } }))
    const K1 = randomUUID()
    const K2 = randomUUID()
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let pidDelCandado = 0
    const candado = prisma.$transaction(
      async tx => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${B.id} FOR UPDATE`
        pidDelCandado = pid
        await suelto
        // El OTRO escritor acredita su llave antes de soltar el candado.
        await tx.payment.update({ where: { id: B.id }, data: { idempotencyKey: K1 } })
      },
      { timeout: 20_000 },
    )
    expect(await f.esperar(async () => pidDelCandado > 0)).toBe(true)
    const lineaBase = await f.pidsQueEsperan('consolidacion')

    // Codex R11 (l): la consolidación en vuelo es un ACTOR del protocolo — si la observación bajo el candado cae, su desenlace
    // se examina igual (un rechazo ⇒ INCONCLUSO con el fallo original), nunca queda un `await` sin ejecutar detrás de una aserción.
    // Codex R12-13 (l): la transacción que ESCRIBE K1 bajo el candado es un MONTAJE — si su UPDATE falla, la prueba es
    // INCONCLUSA con esa causa (antes se tragaba con `.catch` y sólo quedaba una aserción financiera fallida).
    const A = actores()
    const montaje = A.montaje('transacción que escribe K1 bajo el candado', candado)
    const consolidacion = A.lanzar(
      'consolidación K2',
      consolidarRegistroRepetido(copia, f.registroDeLaTerminal({ attemptId: K2, ref: R }), f.venueId, null),
    )
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    let fallo: Fallo = null
    try {
      enEspera = await f.esperarBloqueados('consolidacion', 1, 5000, lineaBase)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'candado de B': () => soltar() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      await expect(montaje.resultado()).resolves.toBeUndefined()
      await expect(consolidacion.resultado()).resolves.toBeNull()
      expect(enEspera).toHaveLength(1)
      expect(enEspera[0].bloqueadoPor).toContain(pidDelCandado)
      expect((await pago(B.id)).idempotencyKey).toBe(K1)
    })
  })

  it('si al asociar la llave ésta YA pertenece a otro Payment (violación de unicidad), la consolidación devuelve a ese DUEÑO durable y deja al candidato intacto', async () => {
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    const B = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth }),
      f.staffId,
    )
    const K = randomUUID()
    const dueno = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: K, ref: `${R}X` }), f.staffId)
    const copia = await exigir(prisma.payment.findUnique({ where: { id: B.id }, include: { receipts: true } }))

    const resultado = await consolidarRegistroRepetido(copia, f.registroDeLaTerminal({ attemptId: K, ref: R, auth }), f.venueId, null)

    expect(resultado?.id).toBe(dueno.id)
    expect((await pago(B.id)).idempotencyKey).toBeNull()
    expect((await pago(dueno.id)).idempotencyKey).toBe(K)
  })
})

describe('Codex R3 · P1-3: el slot de la afiliación se CONGELA en el registro (processorData.pricingSlot)', () => {
  let M2: { id: string; externalMerchantId: string }
  beforeAll(async () => {
    M2 = await f.afiliacionSecundaria()
    await f.conTarifas({ secundaria: { merchantAccountId: M2.id } })
  })
  afterAll(() => f.sinTarifas())

  it('venta rápida y orden: por la afiliación PRIMARY → PRIMARY; por la SECONDARY → SECONDARY; una afiliación que ya no está en la configuración → null (nunca «otra» tarifa)', async () => {
    const a = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID() }), f.staffId)
    expect((await pago(a.id)).processorData).toMatchObject({ pricingSlot: 'PRIMARY' })
    const venta = await f.nuevaVenta()
    const o = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID() }), f.staffId)
    expect((await pago(o.id)).processorData).toMatchObject({ pricingSlot: 'PRIMARY' })

    const b = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID() }), merchantAccountId: M2.id },
      f.staffId,
    )
    expect((await pago(b.id)).processorData).toMatchObject({ pricingSlot: 'SECONDARY' })

    await f.quitarDeLaConfiguracion(M2.id)
    try {
      const c = await recordFastPayment(
        f.venueId,
        { ...f.registroDeLaTerminal({ attemptId: randomUUID() }), merchantAccountId: M2.id },
        f.staffId,
      )
      expect((await pago(c.id)).processorData).toMatchObject({ pricingSlot: null })
      // El cobro NO se interrumpe por no tener slot: se registra y el costo queda pendiente (no se calcula con otra tarifa).
      expect((await pago(c.id)).status).toBe('COMPLETED')
      expect(await prisma.transactionCost.count({ where: { paymentId: c.id } })).toBe(0)
    } finally {
      await f.devolverALaConfiguracion(M2.id)
    }
  })
})

// ═══════════════════ Codex R4 · la resolución por referencia DEMUESTRA o no demuestra; nunca crea a ciegas ═══════════════════

describe('Codex R4 · R4-6: una contradicción bajo el candado con identidad DÉBIL es una COLISIÓN de referencia — evidencia, no absorción ni venta nueva', () => {
  const legacy = (ref: string, auth: string, amount = 10000) =>
    f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref, auth, amount })

  it('con orden: misma referencia, importe, terminal y orden pero OTRA autorización: el segundo nace PENDING POSSIBLE_REFERENCE_COLLISION colgado de la venta, el original queda intacto, la orden sigue pagada UNA vez y hay bitácora', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(100)
    const original = await recordOrderPayment(f.venueId, venta.id, legacy(R, 'AUTH-1'), f.staffId)
    expect(original.status).toBe('COMPLETED')

    const otro = await recordOrderPayment(f.venueId, venta.id, legacy(R, 'AUTH-2'), f.staffId)

    expect(otro.id).not.toBe(original.id)
    expect(otro.status).toBe('PENDING')
    expect((otro as unknown as { possibleReferenceCollision: unknown }).possibleReferenceCollision).toMatchObject({
      referenceNumber: R,
      candidates: [original.id],
    })
    expect(esEvidenciaDeConciliacion(otro)).toBe(true)
    const durable = await pago(otro.id)
    expect(durable).toMatchObject({ status: 'PENDING', orderId: venta.id, authorizationNumber: 'AUTH-2' })
    expect(durable.processorData).toMatchObject({
      reconciliation: {
        kind: 'POSSIBLE_REFERENCE_COLLISION',
        referenceNumber: R,
        candidates: [{ paymentId: original.id, campos: ['authorizationNumber'] }],
      },
    })
    // Fuera de ventas: sin turno, sin VenueTransaction, sin efectos, sin costo.
    expect(await prisma.venueTransaction.count({ where: { paymentId: otro.id } })).toBe(0)
    expect(await prisma.paymentEffect.count({ where: { paymentId: otro.id } })).toBe(0)
    expect(await prisma.transactionCost.count({ where: { paymentId: otro.id } })).toBe(0)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R, status: 'COMPLETED' } })).toBe(1)
    // El original NO se tocó (no se «enriqueció» con la autorización ajena) y la respuesta lleva recibo (la terminal lo exige).
    expect((await pago(original.id)).authorizationNumber).toBe('AUTH-1')
    expect((otro as unknown as { digitalReceipt: { receiptUrl: string } }).digitalReceipt.receiptUrl).toBeTruthy()
    expect(bitacora('TERMINAL_PAYMENT_POSSIBLE_REFERENCE_COLLISION')).toHaveLength(1)
    expect(bitacora('TERMINAL_PAYMENT_POSSIBLE_REFERENCE_COLLISION')[0].data).toMatchObject({ referenceNumber: R })
  })

  it('venta rápida: la colisión cuelga de la venta del candidato que contradijo — no nace otra venta', async () => {
    const R = `${Date.now()}`
    const ventasAntes = await prisma.order.count({ where: { venueId: f.venueId } })
    const original = await recordFastPayment(f.venueId, legacy(R, 'AUTH-1'), f.staffId)
    const otro = await recordFastPayment(f.venueId, legacy(R, 'AUTH-2'), f.staffId)
    expect(otro.status).toBe('PENDING')
    expect(otro.orderId).toBe(original.orderId)
    expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(ventasAntes + 1)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R, status: 'COMPLETED' } })).toBe(1)
  })

  it('el reintento REAL (misma autorización) sigue siendo uno solo: la colisión exige contradicción, no sólo repetición', async () => {
    const R = `${Date.now()}`
    const original = await recordFastPayment(f.venueId, legacy(R, 'AUTH-1'), f.staffId)
    const replay = await recordFastPayment(f.venueId, legacy(R, 'AUTH-1'), f.staffId)
    expect(replay.id).toBe(original.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(1)
  })

  it('un candidato que contradice NO tapa a otro que sí es este cobro: se excluye y se sigue con el resto', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(200)
    const mio = await recordOrderPayment(f.venueId, venta.id, legacy(R, 'AUTH-MIO'), f.staffId)
    // Otro cargo real con la misma referencia sobre la misma venta (otra autorización): queda como evidencia…
    const evidencia = await recordOrderPayment(f.venueId, venta.id, legacy(R, 'AUTH-OTRO'), f.staffId)
    expect(evidencia.status).toBe('PENDING')
    // …y el replay del MÍO (misma autorización) me devuelve el mío, aunque la evidencia PENDING sea más reciente.
    const replay = await recordOrderPayment(f.venueId, venta.id, legacy(R, 'AUTH-MIO'), f.staffId)
    expect(replay.id).toBe(mio.id)
  })
})

describe('Codex R4 · R4-1/R4-2: sin demostración no hay registro nuevo — la terminal REINTENTA (503), nunca nace un duplicado', () => {
  afterEach(() => jest.restoreAllMocks())

  it('R4-1 · la búsqueda AGOTADA (más candidatos de los que se pueden examinar) rechaza con 503 reintentable y crea CERO Payments', async () => {
    const R = `${Date.now()}`
    const antes = await prisma.payment.count({ where: { venueId: f.venueId } })
    const real = prisma.payment.findMany.bind(prisma.payment)
    const ajeno = (i: number) => ({
      id: `fantasma-${i}`,
      orderId: null,
      amount: new Prisma.Decimal(100),
      tipAmount: new Prisma.Decimal(0),
      merchantAccountId: f.merchantId,
      idempotencyKey: null,
      terminalPaymentRequestId: null,
      processorData: { deviceSerialNumber: 'AVQD-OTRATERMINAL' },
      createdAt: new Date(Date.now() - i * 1000),
      receipts: [],
    })
    // Cada página de la referencia viene LLENA de candidatos de otra terminal: la identidad nunca se resuelve.
    jest
      .spyOn(prisma.payment, 'findMany')
      .mockImplementation(((args: { where?: { AND?: { referenceNumber?: string }[] } }) =>
        args?.where?.AND?.[0]?.referenceNumber === R
          ? Promise.resolve(Array.from({ length: 10 }, (_, i) => ajeno(i)))
          : real(args as never)) as never)

    await expect(
      recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId),
    ).rejects.toMatchObject({ statusCode: 503, code: 'PAYMENT_REGISTRATION_UNRESOLVED_SEARCH_EXHAUSTED' })
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(antes)
  })

  it('R4-1 · la frontera de la página es INMUTABLE: si entre la primera y la segunda página otro escritor le acredita su llave al décimo candidato, el undécimo (el legítimo) se encuentra igual', async () => {
    const R = `${Date.now()}`
    const serialDe = (i: number) => `AVQD-N86R4T${String(i).padStart(2, '0')}`
    const legacyDesde = (i: number) =>
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, serialAutenticado: serialDe(i) })
    const vieja = await recordFastPayment(f.venueId, legacyDesde(0), f.staffId)
    for (let i = 1; i <= 10; i++) await recordFastPayment(f.venueId, legacyDesde(i), f.staffId)
    const real = prisma.payment.findMany.bind(prisma.payment)
    let paginas = 0
    // Tras la PRIMERA página de la referencia, «otro escritor» le acredita una llave al último de esa página (el que era la
    // frontera): con un cursor sobre la llave mutable la segunda página partía de su posición NUEVA y saltaba a la undécima.
    jest.spyOn(prisma.payment, 'findMany').mockImplementation((async (args: { where?: { AND?: { referenceNumber?: string }[] } }) => {
      const lote = (await real(args as never)) as { id: string }[]
      if (args?.where?.AND?.[0]?.referenceNumber === R && ++paginas === 1 && lote.length === 10) {
        await prisma.payment.update({ where: { id: lote[9].id }, data: { idempotencyKey: `K-ganada-${R}` } })
      }
      return lote
    }) as never)

    const replay = await recordFastPayment(f.venueId, legacyDesde(0), f.staffId)
    expect(replay.id).toBe(vieja.id)
    expect(paginas).toBeGreaterThanOrEqual(2)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(11)
  })

  it('R4-2 · una consolidación INCIERTA (la transacción del candado revienta antes de comprobar) rechaza con 503 y no crea nada', async () => {
    const R = `${Date.now()}`
    await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const antes = await prisma.payment.count({ where: { venueId: f.venueId } })
    // La PRIMERA transacción del registro sin llave es la de la consolidación (candado sobre el candidato).
    jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('candado vencido'))

    await expect(
      recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId),
    ).rejects.toMatchObject({ statusCode: 503, code: 'PAYMENT_REGISTRATION_UNRESOLVED_CONSOLIDATION_UNCERTAIN' })
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(antes)
  })

  it('R4-2 · perder la identidad cinco veces seguidas agota el presupuesto: 503, no un Payment nuevo', async () => {
    const R = `${Date.now()}`
    await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const antes = await prisma.payment.count({ where: { venueId: f.venueId } })
    const espia = jest
      .spyOn(registroRepetido, 'consolidarRegistroRepetidoDetallado')
      .mockResolvedValue({ estado: 'PERDIDO', motivo: 'LLAVE' })

    await expect(
      recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId),
    ).rejects.toMatchObject({ statusCode: 503, code: 'PAYMENT_REGISTRATION_UNRESOLVED_RETRY_BUDGET_EXHAUSTED' })
    expect(espia).toHaveBeenCalledTimes(5)
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(antes)
  })

  it('P2 · cuando la llave ya tiene DUEÑO durable, la respuesta es el dueño (con SU recibo), no el candidato con el que se entró', async () => {
    const R = `${Date.now()}`
    const candidato = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    const dueno = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: `${R}-dueno` }), f.staffId)
    const duenoConRecibo = await exigir(prisma.payment.findUnique({ where: { id: dueno.id }, include: { receipts: true } }))
    jest.spyOn(registroRepetido, 'consolidarRegistroRepetidoDetallado').mockResolvedValue({ estado: 'DUENO', registro: duenoConRecibo })

    const respuesta = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    expect(respuesta.id).toBe(dueno.id)
    expect(respuesta.id).not.toBe(candidato.id)
    expect((respuesta as unknown as { digitalReceipt: { receiptUrl: string } }).digitalReceipt.receiptUrl).toContain(
      duenoConRecibo.receipts[0].accessKey,
    )
  })
})

describe('Codex R5 · R5-1: un candidato que CONTRADICE nunca se vuelve el ganador de la solicitud', () => {
  const legacy = (ref: string, auth: string, extra: Partial<IntentoRest> = {}) =>
    f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref, auth, ...extra })

  it('venta rápida: B legacy (misma referencia, OTRA autorización) ya registrado; K1 llega con el requestId de Q y sin vínculo: colisión ⇒ evidencia y Q sigue SIN ganador (B no queda ligada a Q); el cargo REAL K2 (mismo requestId) gana Q como COMPLETED — no como segunda captura', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const pagoB = await recordFastPayment(f.venueId, legacy(R, 'AUTH-B'), f.staffId)
    expect(pagoB.status).toBe('COMPLETED')

    const k1 = await recordFastPayment(f.venueId, legacy(R, 'AUTH-K1', { requestId: solicitud.requestId }), f.staffId)
    expect(k1.status).toBe('PENDING')
    expect(esEvidenciaDeConciliacion(k1)).toBe(true)
    // La contradicción NO «reparó» la solicitud con el candidato ajeno: Q sigue en vuelo y B no está ligada a Q.
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    expect((await pago(pagoB.id)).terminalPaymentRequestId).toBeNull()

    const k2 = await recordFastPayment(f.venueId, legacy(`${R}7`, 'AUTH-K2', { requestId: solicitud.requestId }), f.staffId)
    expect(k2.status).toBe('COMPLETED')
    expect(esEvidenciaDeConciliacion(k2)).toBe(false)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: k2.id })
    expect((await pago(k2.id)).terminalPaymentRequestId).toBe(solicitud.requestId)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, status: 'COMPLETED' } })).toBe(2)
  })

  it('con orden: la colisión sobre la cuenta de la solicitud tampoco liga la solicitud al candidato que contradijo', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(100)
    const solicitud = await f.solicitud({ orderId: venta.id })
    const pagoB = await recordOrderPayment(f.venueId, venta.id, legacy(R, 'AUTH-B'), f.staffId)
    const k1 = await recordOrderPayment(f.venueId, venta.id, legacy(R, 'AUTH-K1', { requestId: solicitud.requestId }), f.staffId)
    expect(k1.status).toBe('PENDING')
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    expect((await pago(pagoB.id)).terminalPaymentRequestId).toBeNull()
  })
})

describe('Codex R5 · R5-6: un Payment legacy con `type` NULL sigue siendo candidato por referencia', () => {
  it('venta rápida: el original con type NULL (fila anterior al default REGULAR); el replay legacy (misma referencia, importe, terminal y autorización) devuelve ESE Payment y no nace otro', async () => {
    const R = `${Date.now()}`
    const original = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    await prisma.$executeRaw`UPDATE "Payment" SET "type" = NULL WHERE "id" = ${original.id}`
    expect((await pago(original.id)).type).toBeNull()

    const replay = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )

    expect(replay.id).toBe(original.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(1)
  })

  it('con orden: el mismo replay legacy sobre una cuenta pagada por un Payment con type NULL no la cobra dos veces', async () => {
    const R = `${Date.now()}`
    const venta = await f.nuevaVenta(100)
    const original = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    await prisma.$executeRaw`UPDATE "Payment" SET "type" = NULL WHERE "id" = ${original.id}`
    const replay = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    expect(replay.id).toBe(original.id)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id } })).toBe(1)
  })
})

describe('Codex R7 · R7-1: la consolidación por referencia es un escritor MÁS del protocolo por intento — candado del intento → Payment, y S1 releído bajo el candado', () => {
  afterEach(() => jest.restoreAllMocks())
  const barrera = () => {
    let soltar!: () => void
    let pausado!: () => void
    const liberada = new Promise<void>(r => (soltar = r))
    const enPausa = new Promise<void>(r => (pausado = r))
    /** Espera ACOTADA a la pausa (`false` si el actor instrumentado nunca llegó): la prueba cae por ASERCIÓN, no por el timeout de Jest. */
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
  /** Los dos lados del candado consultivo del intento en `pg_locks`: dueño, quien espera y quién bloquea a quién. */
  const candados = (A: string) =>
    prisma.$queryRaw<{ pid: number; granted: boolean; bloqueadores: number[]; estado: string | null }[]>`
      SELECT l.pid, l.granted, pg_blocking_pids(l.pid) AS bloqueadores, a.state AS estado
      FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.classid = ${NS_CANDADO_INTENTO}::oid AND l.objsubid = 2
        AND l.objid::bigint = ((hashtext(${A})::bigint % 4294967296 + 4294967296) % 4294967296)`
  const publicar = (requestId: string, A: string) =>
    terminalPaymentService.handleAttemptOpenedFromSocket(
      { requestId, attemptId: A },
      { socketId: 's', terminalId: f.serial, venueId: f.venueId },
    )
  /** El REST de A ya buscó por referencia (encontró a B) y calculó `exigeLlave` FUERA de la transacción; se pausa ANTES de consolidar. */
  const pausarTrasLaBusqueda = () => {
    const b = barrera()
    const real = prisma.terminalPaymentAttemptLink.findUnique.bind(prisma.terminalPaymentAttemptLink)
    jest.spyOn(prisma.terminalPaymentAttemptLink, 'findUnique').mockImplementationOnce((async (args: unknown) => {
      const r = await real(args as never)
      b.pausado()
      await b.liberada
      return r
    }) as never)
    return b
  }
  const escenario = async () => {
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    // B: venta legacy de $100, referencia R, sin llave, sin solicitud — nada que contradiga al entrante.
    const B = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth }),
      f.staffId,
    )
    const Q = await f.solicitud()
    const A = randomUUID()
    return { R, auth, B, Q, A }
  }
  const comprobar = async (e: Awaited<ReturnType<typeof escenario>>, pagoA: { id: string; idempotencyKey: string | null }) => {
    // A tiene su propio Payment (nunca B), B sigue sin llave, Q apunta a A, dos ventas con la referencia R.
    expect(pagoA.id).not.toBe(e.B.id)
    expect(pagoA.idempotencyKey).toBe(e.A)
    expect((await pago(e.B.id)).idempotencyKey).toBeNull()
    expect((await pago(e.B.id)).terminalPaymentRequestId).toBeNull()
    expect(await fila(e.Q.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: e.R, type: { not: 'REFUND' } } })).toBe(2)
  }

  it('la publicación del vínculo A→Q está ABIERTA (candado tomado, INSERT sin commit) cuando el REST de A va a consolidar sobre B: la consolidación ESPERA el candado del intento (pg_locks: bloqueador = la transacción del vínculo); al commitear el vínculo, relee S1, deja a B en paz y A nace aparte y gana Q', async () => {
    const e = await escenario()
    const b1 = pausarTrasLaBusqueda()
    // Codex R8/R9 (l): el REST y el vínculo en vuelo se capturan al lanzarlos (`actores`); lo observado bajo los candados
    // se RECOGE y se afirma DESPUÉS de soltar las barreras y de asentar a los dos actores — ningún desenlace (ni un 503 del
    // REST) aterriza detrás de una aserción caída; si alguno no se asienta o rechaza sin que la prueba lo examine, la prueba
    // termina INCONCLUSA conservando el fallo original.
    const A = actores()
    const rest = A.lanzar(
      'REST de A',
      recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: e.A, requestId: e.Q.requestId, ref: e.R, auth: e.auth }), f.staffId),
    )
    let link: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof publicar>>>> | null = null
    const b2 = barrera()
    const observado = {
      restEnLaBarrera: false,
      vinculoEnLaBarrera: false,
      consolidacionEsperando: false,
      filas: [] as Awaited<ReturnType<typeof candados>>,
    }
    let fallo: Fallo = null
    try {
      observado.restEnLaBarrera = await b1.pausadaEn(10_000) // el actor instrumentado llegó a la barrera
      const webhookService = await import('@/services/tpv/angelpay-webhook.service')
      const realRecuperar = webhookService.recuperarEventosDebilesPorVinculo
      jest.spyOn(webhookService, 'recuperarEventosDebilesPorVinculo').mockImplementationOnce(async (a, rid, tx) => {
        const r = await realRecuperar(a, rid, tx) // el vínculo ya está insertado (sin commit) y el candado del intento tomado
        b2.pausado()
        await b2.liberada
        return r
      })
      link = A.lanzar('vínculo A→Q', publicar(e.Q.requestId, e.A))
      observado.vinculoEnLaBarrera = await b2.pausadaEn(10_000) // el actor instrumentado llegó a la barrera
      b1.soltar() // el REST continúa: su consolidación pide el candado del intento y se queda esperando
      observado.consolidacionEsperando = await f.esperar(async () => (await candados(e.A)).some(c => !c.granted), 5000)
      observado.filas = await candados(e.A)
    } catch (error) {
      fallo = { error }
    } finally {
      b2.soltar()
      b1.soltar()
    }
    await A.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A.afirmar(async () => {
      // Primero los desenlaces de los actores (un 503 aquí es una ASERCIÓN caída sobre el REST, no un error suelto)…
      await expect(link!.resultado()).resolves.toMatchObject({ success: true, outcome: 'LINKED' })
      await expect(rest.resultado()).resolves.toMatchObject({ id: expect.any(String) })
      // …y después lo observado en Postgres mientras el vínculo estaba abierto.
      expect(observado.restEnLaBarrera).toBe(true)
      expect(observado.vinculoEnLaBarrera).toBe(true)
      expect(observado.consolidacionEsperando).toBe(true)
      const dueno = observado.filas.find(c => c.granted)
      const esperando = observado.filas.find(c => !c.granted)
      expect(dueno).toBeDefined()
      expect(esperando).toBeDefined()
      expect(esperando!.bloqueadores).toContain(dueno!.pid)
      expect(dueno!.estado).toBe('idle in transaction')
      expect(esperando!.estado).toBe('active')
      await comprobar(e, await rest.resultado())
    })
  })

  it('el vínculo A→Q se publica y COMMITEA entre la búsqueda y la consolidación (el escenario exacto de Codex): bajo el candado la consolidación relee S1, B ya no es este cobro y A nace aparte y gana Q', async () => {
    const e = await escenario()
    const b1 = pausarTrasLaBusqueda()
    const A = actores()
    const rest = A.lanzar(
      'REST de A',
      recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: e.A, requestId: e.Q.requestId, ref: e.R, auth: e.auth }), f.staffId),
    )
    let restEnLaBarrera = false
    let vinculo: Awaited<ReturnType<typeof publicar>> | null = null
    let fallo: Fallo = null
    try {
      restEnLaBarrera = await b1.pausadaEn(10_000) // el actor instrumentado llegó a la barrera
      vinculo = await publicar(e.Q.requestId, e.A)
    } catch (error) {
      fallo = { error }
    } finally {
      b1.soltar()
    }
    await A.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A.afirmar(async () => {
      await expect(rest.resultado()).resolves.toMatchObject({ id: expect.any(String) })
      expect(restEnLaBarrera).toBe(true)
      expect(vinculo).toMatchObject({ success: true, outcome: 'LINKED' })
      await comprobar(e, await rest.resultado())
    })
  })

  it('…y si además el webhook CONFIRMA A por el vínculo en esa ventana, el REST resuelve al Payment de A (el confirmado), no a B', async () => {
    const e = await escenario()
    const b1 = pausarTrasLaBusqueda()
    const A = actores()
    const rest = A.lanzar(
      'REST de A',
      recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: e.A, requestId: e.Q.requestId, ref: e.R, auth: e.auth }), f.staffId),
    )
    let restEnLaBarrera = false
    let vinculo: Awaited<ReturnType<typeof publicar>> | null = null
    let confirmacion: Awaited<ReturnType<typeof processAngelPayWebhook>> | null = null
    let fallo: Fallo = null
    try {
      restEnLaBarrera = await b1.pausadaEn(10_000) // el actor instrumentado llegó a la barrera
      vinculo = await publicar(e.Q.requestId, e.A)
      confirmacion = await processAngelPayWebhook({
        payload: f.eventoAngelPay(e.A, { transactionId: e.R }),
        eventId: f.nuevoEventId(),
        merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
        retryDelaysMs: [0],
      })
    } catch (error) {
      fallo = { error }
    } finally {
      b1.soltar()
    }
    await A.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A.afirmar(async () => {
      await expect(rest.resultado()).resolves.toMatchObject({ id: expect.any(String) })
      expect(restEnLaBarrera).toBe(true)
      expect(vinculo).toMatchObject({ success: true, outcome: 'LINKED' })
      expect(confirmacion?.action).toBe('CONFIRMED')
      const pagoA = await rest.resultado()
      await comprobar(e, pagoA)
      expect(pagoA.id).toBe((await fila(e.Q.requestId)).paymentId)
      expect(await fila(e.Q.requestId)).toMatchObject({ closedVia: 'webhook' })
    })
  })
})

describe('Codex R12 (pasada exhaustiva) · R12-6: un `paymentId` en un resultado NO-success del socket no decide quién ganó — ni el productor lo escribe ni el lector le cree sin procedencia', () => {
  const MARCA_PUNTERO = 'TERMINAL_PAYMENT_UNACCREDITED_WINNER_IGNORED'
  let otroSerial: string
  beforeAll(async () => {
    otroSerial = `AVQD-N86OTRA${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'Otra terminal', serialNumber: otroSerial, type: 'TPV_ANDROID' } })
  })
  afterAll(async () => {
    await prisma.terminal.deleteMany({ where: { serialNumber: otroSerial } })
  })
  const socketDeLaTerminal = () => ({ socketId: 'fixture-socket', terminalId: f.serial, venueId: f.venueId })
  /** B: una venta ANTERIOR de $100 cobrada en OTRA terminal del mismo negocio, sin solicitud. */
  const ventaAjenaB = async () => {
    const pagoB = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), serialAutenticado: otroSerial }), deviceSerialNumber: otroSerial },
      f.staffId,
    )
    expect(pagoB.status).toBe('COMPLETED')
    return pagoB
  }
  const vincular = async (requestId: string, attemptId = randomUUID()) => {
    const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
      { requestId, attemptId },
      { socketId: 's', terminalId: f.serial, venueId: f.venueId },
    )
    expect(ack.success).toBe(true)
    return attemptId
  }
  const sinGanador = (row: { paymentId: string | null; resultJson: unknown }) => {
    expect(row.paymentId).toBeNull()
    expect(row.resultJson).not.toHaveProperty('paymentId')
  }
  /** Lo que se afirma cuando el cargo AUTÉNTICO A ganó la solicitud Q y B quedó intacto. */
  const ganoElAutentico = async (Q: string, pagoA: { id: string }, pagoB: { id: string }) => {
    expect(await pago(pagoA.id)).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: Q })
    expect(esEvidenciaDeConciliacion(await pago(pagoA.id))).toBe(false)
    expect(await fila(Q)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id })
    expect((await fila(Q)).resultJson).toMatchObject({ status: 'success', paymentId: pagoA.id })
    expect(await pago(pagoB.id)).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: null })
    expect(bitacora('TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE')).toEqual([])
  }

  it('PRODUCTOR: timeout / failed / cancelled (con evidencia) que traen `paymentId` cierran la fila SIN ganador — ni en la columna ni en `resultJson`', async () => {
    const pagoB = await ventaAjenaB()
    // Una solicitud en vuelo por terminal (índice, que UNKNOWN también retiene): se abren y cierran una por una, la del
    // timeout al final. `false` = sin waiter HTTP; la fila sí se cerró.
    const q1 = await f.solicitud()
    expect(
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId: q1.requestId, status: 'failed', outcomeEvidence: 'PRE_AUTHORIZATION', paymentId: pagoB.id },
        socketDeLaTerminal(),
      ),
    ).toBe(false)
    expect(await fila(q1.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'TPV_CONFIRMED_NO_CHARGE' })
    sinGanador(await fila(q1.requestId))
    const q2 = await f.solicitud()
    expect(
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId: q2.requestId, status: 'cancelled', outcomeEvidence: 'PRE_AUTHORIZATION', paymentId: pagoB.id },
        socketDeLaTerminal(),
      ),
    ).toBe(false)
    expect(await fila(q2.requestId)).toMatchObject({ status: 'CANCELLED', cancelDisposition: 'ACCEPTED' })
    sinGanador(await fila(q2.requestId))
    const q3 = await f.solicitud()
    expect(
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId: q3.requestId, status: 'timeout', paymentId: pagoB.id },
        socketDeLaTerminal(),
      ),
    ).toBe(false)
    // Un `timeout` conserva la ranura (UNKNOWN): lo que se afirma es que NO tiene ganador.
    expect(await fila(q3.requestId)).toMatchObject({ status: 'UNKNOWN' })
    sinGanador(await fila(q3.requestId))
    expect(await pago(pagoB.id)).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: null })
  })

  it('PRODUCTOR (resultado tardío): un timeout con `paymentId` sobre una fila ya UNKNOWN tampoco escribe ganador', async () => {
    const pagoB = await ventaAjenaB()
    const Q = await f.solicitud({ status: 'UNKNOWN', failureCode: 'TIMED_OUT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: Q.requestId, status: 'timeout', paymentId: pagoB.id },
      socketDeLaTerminal(),
    )
    expect(await fila(Q.requestId)).toMatchObject({ status: 'UNKNOWN', lateResult: true })
    sinGanador(await fila(Q.requestId))
  })

  describe('el escenario de Codex: `{requestId: Q, status: timeout, paymentId: B}` admitido, y después el approved AUTÉNTICO de A por $100', () => {
    it('A registrado por VENTA RÁPIDA gana Q (COMPLETED, ligado, resultado tardío) — nunca «segunda captura de B»', async () => {
      const pagoB = await ventaAjenaB()
      const Q = await f.solicitud()
      const A = await vincular(Q.requestId)
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId: Q.requestId, status: 'timeout', paymentId: pagoB.id },
        socketDeLaTerminal(),
      )
      const pagoA = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Q.requestId }), f.staffId)
      await ganoElAutentico(Q.requestId, pagoA, pagoB)
      expect((await fila(Q.requestId)).lateResult).toBe(true)
    })

    it('A registrado CON ORDEN gana Q', async () => {
      const pagoB = await ventaAjenaB()
      const venta = await f.nuevaVenta(100)
      const Q = await f.solicitud({ orderId: venta.id })
      const A = await vincular(Q.requestId)
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId: Q.requestId, status: 'timeout', paymentId: pagoB.id },
        socketDeLaTerminal(),
      )
      const pagoA = await recordOrderPayment(
        f.venueId,
        venta.id,
        f.registroDeLaTerminal({ attemptId: A, requestId: Q.requestId }),
        f.staffId,
      )
      await ganoElAutentico(Q.requestId, pagoA, pagoB)
      expect(await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).toMatchObject({ paymentStatus: 'PAID' })
    })

    it('A confirmado por WEBHOOK gana Q', async () => {
      const pagoB = await ventaAjenaB()
      const Q = await f.solicitud()
      const A = await vincular(Q.requestId)
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId: Q.requestId, status: 'timeout', paymentId: pagoB.id },
        socketDeLaTerminal(),
      )
      const confirmacion = await processAngelPayWebhook({
        payload: f.eventoAngelPay(A),
        eventId: f.nuevoEventId(),
        merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
        retryDelaysMs: [0],
      })
      expect(confirmacion.action).toBe('CONFIRMED')
      const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
      await ganoElAutentico(Q.requestId, pagoA, pagoB)
    })
  })

  describe('LECTOR (independiente del productor): una fila HISTÓRICA que ya apunta a B — un puntero sin procedencia no excluye el cargo auténtico', () => {
    const filaContaminada = async (pagoB: { id: string }, over: Record<string, unknown> = {}) =>
      f.solicitud({ status: 'TIMED_OUT', paymentId: pagoB.id, resultJson: { status: 'timeout', paymentId: pagoB.id }, ...over })
    const punteroIgnorado = (Q: string, pagoB: { id: string }) =>
      expect(bitacora(MARCA_PUNTERO)).toEqual([
        expect.objectContaining({
          venueId: f.venueId,
          entity: 'TerminalPaymentRequest',
          data: expect.objectContaining({ requestId: Q, ignoredPaymentId: pagoB.id, reason: expect.any(String) }),
        }),
      ])

    it('venta rápida: A gana Q, el puntero a B se ignora con bitácora, B sigue siendo su propia venta', async () => {
      const pagoB = await ventaAjenaB()
      const Q = await filaContaminada(pagoB)
      const A = await vincular(Q.requestId)
      const pagoA = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Q.requestId }), f.staffId)
      await ganoElAutentico(Q.requestId, pagoA, pagoB)
      punteroIgnorado(Q.requestId, pagoB)
    })

    it('con orden: A gana Q por el registrador con orden, el puntero a B se ignora con bitácora', async () => {
      const pagoB = await ventaAjenaB()
      const venta = await f.nuevaVenta(100)
      const Q = await filaContaminada(pagoB, { orderId: venta.id })
      const A = await vincular(Q.requestId)
      const pagoA = await recordOrderPayment(
        f.venueId,
        venta.id,
        f.registroDeLaTerminal({ attemptId: A, requestId: Q.requestId }),
        f.staffId,
      )
      await ganoElAutentico(Q.requestId, pagoA, pagoB)
      punteroIgnorado(Q.requestId, pagoB)
    })

    it('webhook: A gana Q por el webhook, el puntero a B se ignora con bitácora', async () => {
      const pagoB = await ventaAjenaB()
      const Q = await filaContaminada(pagoB)
      const A = await vincular(Q.requestId)
      const confirmacion = await processAngelPayWebhook({
        payload: f.eventoAngelPay(A),
        eventId: f.nuevoEventId(),
        merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
        retryDelaysMs: [0],
      })
      expect(confirmacion.action).toBe('CONFIRMED')
      const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
      await ganoElAutentico(Q.requestId, pagoA, pagoB)
      punteroIgnorado(Q.requestId, pagoB)
    })

    it('un puntero a un cobro de ESTA terminal pero de otra venta (sin la etiqueta de Q) tampoco es el ganador: A gana', async () => {
      const otraVenta = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID() }), f.staffId)
      const Q = await filaContaminada(otraVenta)
      const A = await vincular(Q.requestId)
      const pagoA = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Q.requestId }), f.staffId)
      await ganoElAutentico(Q.requestId, pagoA, otraVenta)
      punteroIgnorado(Q.requestId, otraVenta)
    })
  })

  describe('el ganador LEGÍTIMO se conserva (la defensa del lector no convierte a todo puntero en contaminado)', () => {
    it('ganador acreditado y luego REEMBOLSADO: un intento nuevo sigue siendo segunda captura, el ganador no cambia', async () => {
      const Q = await f.solicitud()
      const W = await vincular(Q.requestId)
      const pagoW = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: W, requestId: Q.requestId }), f.staffId)
      expect(await fila(Q.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoW.id })
      await prisma.payment.update({ where: { id: pagoW.id }, data: { status: 'REFUNDED' } })
      const A = await vincular(Q.requestId)
      const pagoA = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Q.requestId }), f.staffId)
      expect(pagoA.status).toBe('PENDING')
      expect(esEvidenciaDeConciliacion(await pago(pagoA.id))).toBe(true)
      expect(await fila(Q.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoW.id })
      expect(bitacora(MARCA_PUNTERO)).toEqual([])
      expect(bitacora('TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE')).toHaveLength(1)
    })

    it('fila histórica ligada SÓLO por `processorData.terminalPaymentRequestId` (sin la columna): sigue siendo el ganador', async () => {
      const Q = await f.solicitud()
      const W = await vincular(Q.requestId)
      const pagoW = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: W, requestId: Q.requestId }), f.staffId)
      await prisma.payment.update({ where: { id: pagoW.id }, data: { terminalPaymentRequestId: null } })
      const A = await vincular(Q.requestId)
      const pagoA = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Q.requestId }), f.staffId)
      expect(pagoA.status).toBe('PENDING')
      expect(await fila(Q.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoW.id })
      expect(bitacora(MARCA_PUNTERO)).toEqual([])
    })
  })
})

describe('Codex R12 (pasada exhaustiva) · R12-7: dos replays SIMULTÁNEOS sin llave del mismo cargo crean UNA venta — la resolución por referencia y la creación van bajo la misma exclusión', () => {
  const legacy = (ref: string, auth: string, extra: Partial<IntentoRest> = {}) =>
    f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref, auth, ...extra })
  /**
   * Cada replay se afirma POR SEPARADO y como ASERCIÓN (Codex R11 (l)): NINGUNO rechaza. Un 503 («no pude confirmar») aquí
   * significaría que la relectura bajo el candado no fue una fotografía nueva (READ COMMITTED explícito, Codex R6-2 (c)) — y
   * tiene que caer como aserción, no como error suelto.
   */
  const acreditado = async <T>(actor: { resultado: () => Promise<T> }): Promise<T> => {
    const desenlaceDelReplay = await actor.resultado().then(
      v => ({ ok: true as const, v }),
      e => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
    )
    expect(desenlaceDelReplay).toMatchObject({ ok: true })
    return (desenlaceDelReplay as { ok: true; v: T }).v
  }

  /**
   * La prueba SOSTIENE el candado de la referencia desde su propia transacción: los dos registros llegan, resuelven «ausencia»
   * fuera de la transacción de creación (los dos), y al entrar a crear tienen que ESPERAR — se observa en Postgres, con el
   * bloqueador identificado (este pid). Al soltar, Postgres los encola: el primero crea y commitea; el segundo vuelve a
   * resolver YA con el candado y encuentra el cargo del primero.
   */
  // Codex R12-13 (l): la transacción que sostiene el candado es un MONTAJE del conjunto de actores de la prueba; se suelta con
  // `liberar` (que captura un error de liberación) y su desenlace se examina en la fase de aserciones.
  // Codex R13-6: la primera espera (`esperar`) y la consulta del montaje (`pidsQueEsperan`) van DENTRO del bloque cuyo `finally`
  // suelta la barrera, y el helper NUNCA rechaza: todo fallo suyo o del cuerpo se devuelve como `fallo` para que el llamador llegue
  // SIEMPRE a `A.cerrar(fallo)` — si la segunda consulta falla, la barrera se suelta igual y la prueba termina INCONCLUSA con causa,
  // no con la transacción colgada y sin veredicto.
  const sosteniendoElCandado = async (A: ReturnType<typeof actores>, ref: string, cuerpo: (lineaBase: number[]) => Promise<void>) => {
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let pidDelCandado = 0
    const candado = prisma.$transaction(
      async tx => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NS_CANDADO_REFERENCIA}::int, hashtext(${llaveDeReferencia(f.venueId, ref)}))::text`
        pidDelCandado = pid
        await suelto
      },
      { timeout: 20_000 },
    )
    const montaje = A.montaje('transacción que sostiene el candado de la referencia', candado)
    let fallo: Fallo = null
    try {
      if (!(await f.esperar(async () => pidDelCandado > 0))) throw new Error('el candado de la referencia nunca se tomó')
      const lineaBase = await f.pidsQueEsperan('referencia')
      await cuerpo(lineaBase)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'candado de la referencia': () => soltar() })
    }
    return { pid: pidDelCandado, montaje, fallo }
  }

  it('venta rápida: los dos esperan JUNTOS el candado de la referencia (bloqueados por la prueba), y al soltar nace UN Payment, UNA venta y UN ingreso — los dos reciben el MISMO resultado', async () => {
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    const A = actores()
    let r1!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof recordFastPayment>>>>
    let r2!: typeof r1
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    const { pid, montaje, fallo } = await sosteniendoElCandado(A, R, async lineaBase => {
      r1 = A.lanzar('replay-1', recordFastPayment(f.venueId, legacy(R, auth), f.staffId))
      r2 = A.lanzar('replay-2', recordFastPayment(f.venueId, legacy(R, auth), f.staffId))
      enEspera = await f.esperarBloqueados('referencia', 2, 5000, lineaBase)
    })
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      await expect(montaje.resultado()).resolves.toBeUndefined()
      // El DINERO primero: un cargo, un Payment, una venta, un ingreso — y el mismo resultado para los dos replays.
      const [p1, p2] = [await acreditado(r1), await acreditado(r2)]
      expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
      expect(p1.id).toBe(p2.id)
      expect(p1.status).toBe('COMPLETED')
      expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(1)
      expect(await prisma.venueTransaction.count({ where: { paymentId: p1.id } })).toBe(1)
      // El MECANISMO: los DOS esperaron el candado de la referencia, bloqueados por esta transacción (o en cadena, por el otro).
      expect(enEspera).toHaveLength(2)
      for (const e of enEspera) expect(e.bloqueadoPor).toEqual(expect.arrayContaining([expect.any(Number)]))
      expect(enEspera.some(e => e.bloqueadoPor.includes(pid))).toBe(true)
    })
  })

  it('con orden: igual — un Payment, la orden PAGADA una vez, un ingreso, y el mismo resultado para los dos', async () => {
    const R = `${Date.now()}`
    const auth = `AUTH-${R.slice(-6)}`
    const venta = await f.nuevaVenta(100)
    const A = actores()
    let r1!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof recordOrderPayment>>>>
    let r2!: typeof r1
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    const { pid, montaje, fallo } = await sosteniendoElCandado(A, R, async lineaBase => {
      r1 = A.lanzar('replay-1', recordOrderPayment(f.venueId, venta.id, legacy(R, auth), f.staffId))
      r2 = A.lanzar('replay-2', recordOrderPayment(f.venueId, venta.id, legacy(R, auth), f.staffId))
      enEspera = await f.esperarBloqueados('referencia', 2, 5000, lineaBase)
    })
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      await expect(montaje.resultado()).resolves.toBeUndefined()
      const [p1, p2] = [await acreditado(r1), await acreditado(r2)]
      expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
      expect(p1.id).toBe(p2.id)
      expect(p1.status).toBe('COMPLETED')
      const orden = await exigir(prisma.order.findUnique({ where: { id: venta.id } }))
      expect(orden.paymentStatus).toBe('PAID')
      expect(Number(orden.paidAmount)).toBe(100)
      expect(await prisma.venueTransaction.count({ where: { paymentId: p1.id } })).toBe(1)
      expect(enEspera).toHaveLength(2)
      expect(enEspera.some(e => e.bloqueadoPor.includes(pid))).toBe(true)
    })
  })

  it('CONTROL: dos cargos legítimamente DISTINTOS con la MISMA referencia (dos clientes en el mismo segundo: $100 y $150) que compiten por el mismo candado siguen siendo DOS ventas — el candado serializa, no deduplica', async () => {
    const R = `${Date.now()}`
    const A = actores()
    let r1!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof recordFastPayment>>>>
    let r2!: typeof r1
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    const { montaje, fallo } = await sosteniendoElCandado(A, R, async lineaBase => {
      r1 = A.lanzar('cargo-1', recordFastPayment(f.venueId, legacy(R, 'AUTH-UNO', { amount: 10000 }), f.staffId))
      r2 = A.lanzar('cargo-2', recordFastPayment(f.venueId, legacy(R, 'AUTH-DOS', { amount: 15000 }), f.staffId))
      enEspera = await f.esperarBloqueados('referencia', 2, 5000, lineaBase)
    })
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      await expect(montaje.resultado()).resolves.toBeUndefined()
      const [p1, p2] = [await acreditado(r1), await acreditado(r2)]
      expect(p1.id).not.toBe(p2.id)
      expect([p1.status, p2.status]).toEqual(['COMPLETED', 'COMPLETED'])
      expect(await prisma.payment.count({ where: { venueId: f.venueId, status: 'COMPLETED' } })).toBe(2)
      expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(2)
      expect([Number(p1.amount), Number(p2.amount)].sort()).toEqual([100, 150])
      // También los cargos distintos se serializan por referencia (es lo que permite volver a resolver bajo el candado).
      expect(enEspera).toHaveLength(2)
    })
  })

  it('un registro CON llave no toma el candado de la referencia (lo protege el índice único del intento): no espera aunque la prueba lo sostenga', async () => {
    const R = `${Date.now()}`
    const A = actores()
    let registro!: ReturnType<typeof A.lanzar<Awaited<ReturnType<typeof recordFastPayment>>>>
    let desenlace: Awaited<ReturnType<typeof A.carrera>> | null = null
    const { montaje, fallo } = await sosteniendoElCandado(A, R, async () => {
      registro = A.lanzar(
        'registro con llave',
        recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R }), f.staffId),
      )
      desenlace = await A.carrera(registro, 4000)
    })
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      await expect(montaje.resultado()).resolves.toBeUndefined()
      expect(desenlace).toMatchObject({ estado: 'ASENTADA', ok: true, value: expect.objectContaining({ status: 'COMPLETED' }) })
    })
  })
})
