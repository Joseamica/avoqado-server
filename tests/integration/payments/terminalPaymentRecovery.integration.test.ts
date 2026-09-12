/** Real PostgreSQL crash/duplicate proof. Uses only an isolated, caller-selected local test DB. */
import { randomUUID } from 'crypto'
import { Prisma, TerminalPaymentRequestStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  SIN_DESENLACE_ACREDITADO,
  UNRESOLVED_FINANCIAL_OUTCOME,
  desenlaceCanonico,
  terminalPaymentService,
} from '@/services/terminal-payment.service'
import { invalidarVenuesEstrictos } from '@/services/terminal-payment-strictness'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { normalizeTerminalId, terminalRegistry } from '@/communication/sockets/terminal-registry'
import { BadRequestError, OrderAlreadyPaidError, TerminalBusyError } from '@/errors/AppError'

import { logAction } from '@/services/dashboard/activity-log.service'
import { cancelOrder } from '@/services/mobile/order.mobile.service'
jest.mock('@/communication/sockets/managers/socketManager', () => {
  // El índice `@/communication/sockets` reexporta el NOMBRADO `socketManager` (lo usa `cancelOrder`); el resto importa el
  // default. Es el mismo objeto. `getBroadcastingService`: `cancelOrder` avisa al venue al cancelar; aquí no hay a quién.
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  // 🔴 Re-implementar la normalización aquí hacía que las pruebas verificaran la copia del mock
  // y no el código: a la copia le faltaba el `.trim()` de la real. Se usa la de verdad.
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const fixture = `relay-${randomUUID()}`
const venueId = fixture
let orderId: string
const nextRequest = () => randomUUID()
let directEmit: jest.Mock

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  // Watchdog sweeps are global. Never point this test at a shared development/test fixture database.
  // La base de este trabajo en la Mac, o la de CI (`avoqado_*_test_*`): nunca otra.
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: fixture, name: fixture, slug: fixture } })
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: fixture,
      subtotal: new Prisma.Decimal(100),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(100),
    },
  })
  orderId = order.id
})

beforeEach(() => {
  jest.clearAllMocks()
  directEmit = jest.fn()
  const socket = { emit: directEmit, timeout: () => ({ emit: directEmit }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([['fixture-socket', socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
    terminalId,
    venueId,
    socketId: 'fixture-socket',
    terminalPaymentAckVersion: 1,
  }))
})

afterEach(async () => {
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

async function auditRequest(overrides: Record<string, unknown> = {}) {
  return prisma.terminalPaymentRequest.create({
    data: {
      requestId: nextRequest(),
      venueId,
      terminalId: fixture,
      orderId,
      amountCents: 10000,
      expiresAt: new Date(0),
      ...overrides,
    } as Prisma.TerminalPaymentRequestUncheckedCreateInput,
  })
}
/**
 * 🔴 Un Payment de una TERMINAL trae SIEMPRE su procedencia: `source: 'TPV'` y el aparato en que
 * se cobró. La recuperación exige esa atribución FÍSICA antes de cerrar una petición con él —un
 * pago del mismo venue pero de OTRO aparato liberaría el slot de una terminal que quizá sigue
 * ejecutando el suyo—. Un fixture sin procedencia describe un estado imposible y hacía que la
 * recuperación (correctamente) lo rechazara.
 */
async function terminalDelFixture(serial: string = fixture) {
  return prisma.terminal.upsert({
    where: { serialNumber: serial },
    update: {},
    create: { venueId, name: 'fixture terminal', serialNumber: serial, type: 'TPV_ANDROID' },
  })
}

async function auditPayment(overrides: Record<string, unknown> = {}, serial: string = fixture) {
  const terminal = await terminalDelFixture(serial)
  return prisma.payment.create({
    data: {
      venueId,
      orderId,
      source: 'TPV',
      terminalId: terminal.id,
      amount: new Prisma.Decimal(100),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      feePercentage: new Prisma.Decimal(0),
      feeAmount: new Prisma.Decimal(0),
      netAmount: new Prisma.Decimal(100),
      ...overrides,
    } as Prisma.PaymentUncheckedCreateInput,
  })
}
/**
 * Enciende el RÉGIMEN ESTRICTO en el venue de la prueba. El `afterEach` de abajo lo apaga SIEMPRE.
 *
 * 🔴 Por qué hace falta desde el 11-sep: el interruptor por venue (I.6) dejó la **ranura física de la terminal**
 * en el régimen heredado mientras está apagado — que es como sale a producción, para no trabar las 386 filas
 * históricas medidas. El **bloqueo por orden**, en cambio, es estricto SIEMPRE (decisión del founder tras la
 * auditoría de Codex: el riesgo de que un cobro incierto sí haya cobrado NO caduca).
 *
 * Las pruebas que miden la RANURA no se debilitan: se ejecutan en el régimen donde esa garantía vive. Las que
 * miden la ORDEN se quedan fuera a propósito — deben pasar en los DOS regímenes, y de hecho pasan. El corte va
 * en 1970 para que cubra cualquier fila que la prueba siembre.
 */
async function encenderRegimenEstricto(): Promise<void> {
  await prisma.venue.update({
    where: { id: venueId },
    data: { terminalPaymentStrictEnabled: true, terminalPaymentStrictSince: new Date(0) },
  })
  await invalidarVenuesEstrictos()
}

afterEach(async () => {
  // Idempotente y barato: deja el venue en el régimen de fábrica pase lo que pase, incluso si la prueba falló
  // a mitad. Sin esto, una prueba encendida contaminaría a la siguiente con el régimen equivocado.
  await prisma.venue.updateMany({ where: { id: venueId, terminalPaymentStrictEnabled: true }, data: { terminalPaymentStrictEnabled: false } })
  await invalidarVenuesEstrictos()
})

const fixtureSocket = () => ({ socketId: 'fixture-socket', terminalId: fixture, venueId })

describe('Task4 audit round1 regressions', () => {
  it('historical Payment association cannot close a second request even without processor metadata', async () => {
    const payment = await auditPayment()
    await auditRequest({ status: 'COMPLETED', paymentId: payment.id })
    const second = await auditRequest({ terminalId: fixture + '-second' })
    await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, second.requestId, payment.id, venueId))
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: second.id } })).paymentId).toBeNull()
    expect(await prisma.payment.count({ where: { id: payment.id } })).toBe(1)
  })

  it.each([false, true])('socket cannot claim an unassociated Payment (orderless=%s)', async orderless => {
    const request = await auditRequest({ ...(orderless ? { orderId: null } : {}) })
    const payment = await auditPayment()
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: request.requestId, status: 'success', paymentId: payment.id },
      fixtureSocket(),
    )
    expect(await terminalPaymentService.getPaymentStatus(request.requestId, venueId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('COMPLETED')
  })

  it('socket cannot claim a request-tagged Payment captured by a different physical terminal', async () => {
    const request = await auditRequest()
    const terminal = await prisma.terminal.create({
      data: { venueId, name: 'other terminal', serialNumber: nextRequest(), type: 'TPV_ANDROID' },
    })
    const payment = await auditPayment({
      terminalId: terminal.id,
      source: 'TPV',
      processorData: { terminalPaymentRequestId: request.requestId },
    })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: request.requestId, status: 'success', paymentId: payment.id },
      fixtureSocket(),
    )
    expect(await terminalPaymentService.getPaymentStatus(request.requestId, venueId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('COMPLETED')
  })

  // 🔴 El MISMO fraude de atribución que el test de arriba, pero por la puerta que de verdad se usa:
  // las dos llamadas de `payment.tpv.service.ts` entran como REST (el valor por defecto del método).
  // Un Payment cobrado en OTRO aparato cerraba esta solicitud: libera el slot de una terminal que
  // quizá sigue ejecutando el suyo y da por cobrado un importe que no salió de ahí. El Payment NO se
  // toca — sólo se le niega cerrar ESTA petición.
  it('REST close cannot claim a Payment captured by a different physical terminal', async () => {
    const request = await auditRequest({ status: 'SENT' })
    const otherTerminal = await prisma.terminal.create({
      data: { venueId, name: 'other terminal REST', serialNumber: nextRequest(), type: 'TPV_ANDROID' },
    })
    const payment = await auditPayment({
      terminalId: otherTerminal.id,
      source: 'TPV',
      processorData: { terminalPaymentRequestId: request.requestId },
    })
    await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, request.requestId, payment.id, venueId))
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(after.status).toBe('SENT')
    expect(after.paymentId).toBeNull()
    // El dinero capturado se conserva intacto: negar la atribución nunca borra un cobro real.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('COMPLETED')
  })

  // Control POSITIVO. Sin él, un arreglo que niegue TODO pasaría el test de arriba y dejaría cada
  // terminal atorada después de cobrar — que es el otro P1 conocido de esta misma flota.
  // 🔴 Con la FORMA de producción: `Terminal.serialNumber` lleva el prefijo (`AVQD-2841548624`) y
  // `TerminalPaymentRequest.terminalId` es la llave YA normalizada (`2841548624`, ver
  // `schema.prisma:5040`). Un fixture con el mismo string en los dos lados dejaba verde el sabotaje
  // más caro posible —comparar los seriales SIN normalizar—, que en producción le niega el cierre a
  // TODA terminal y deja la flota entera con su solicitud abierta.
  it('REST close still completes the request for the terminal that captured it (serial con prefijo AVQD-)', async () => {
    const llaveNormalizada = `${fixture}-prod`
    const request = await auditRequest({ status: 'SENT', terminalId: llaveNormalizada })
    const payment = await auditPayment({}, `AVQD-${llaveNormalizada.toUpperCase()}`)
    await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, request.requestId, payment.id, venueId))
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(after.status).toBe('COMPLETED')
    expect(after.paymentId).toBe(payment.id)
  })

  // 🔴 Sin identidad ACREDITADA no se cierra. Antes este caso cerraba «por compatibilidad», pero
  // la ausencia de terminal no prueba que el Payment sea del aparato reservado (Codex, 10-sep). Todo
  // token de TPV lleva `terminalSerialNumber` (el login exige una `Terminal`), así que un cierre sin
  // serial no es un cliente viejo: es una llamada sin procedencia. El Payment se conserva y la fila
  // queda para la recuperación; lo que no se hace es dar por cobrado en ESTA terminal.
  it('REST close refuses when no accredited terminal identity is available (Payment kept, row left for recovery)', async () => {
    const request = await auditRequest({ status: 'SENT' })
    const payment = await auditPayment({ terminalId: null })
    await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, request.requestId, payment.id, venueId))
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(after.status).toBe('SENT')
    expect(after.paymentId).toBeNull()
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('COMPLETED')
  })

  // La procedencia AUTENTICADA se conserva aunque la FK `Payment.terminal` no resuelva (terminal movida
  // de venue entre el login y el cobro): el serial del token viaja al cierre y queda en `processorData`.
  it('REST close completes from the authenticated serial when the Terminal FK did not resolve', async () => {
    const llave = `${fixture}-fk-nula`
    const request = await auditRequest({ status: 'SENT', terminalId: llave })
    const payment = await auditPayment({ terminalId: null })
    await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, request.requestId, payment.id, venueId, undefined, 'REST', `AVQD-${llave.toUpperCase()}`),
    )
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(after.status).toBe('COMPLETED')
    expect(after.paymentId).toBe(payment.id)
    const stored = (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).processorData as Record<string, unknown>
    expect(stored.deviceSerialNumber).toBe(`AVQD-${llave.toUpperCase()}`)
  })

  it('REST close refuses when the authenticated serial contradicts the request terminal (Payment kept)', async () => {
    const request = await auditRequest({ status: 'SENT' })
    const payment = await auditPayment({ terminalId: null })
    await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, request.requestId, payment.id, venueId, undefined, 'REST', `AVQD-${nextRequest()}`),
    )
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(after.status).toBe('SENT')
    expect(after.paymentId).toBeNull()
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('COMPLETED')
  })

  // Y el serial guardado en `processorData` sirve de respaldo cuando ni la FK ni el llamador lo traen
  // (p. ej. una recuperación posterior sobre un Payment ya registrado).
  it('REST close falls back to the serial persisted in processorData when the FK is unresolved', async () => {
    const llave = `${fixture}-respaldo`
    const request = await auditRequest({ status: 'SENT', terminalId: llave })
    const payment = await auditPayment({ terminalId: null, processorData: { deviceSerialNumber: `AVQD-${llave.toUpperCase()}` } })
    await prisma.$transaction(tx => terminalPaymentService.closeRowFromPaymentTx(tx, request.requestId, payment.id, venueId))
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(after.status).toBe('COMPLETED')
    expect(after.paymentId).toBe(payment.id)
  })


  it.each([{ amountCents: 10100 }, { tipCents: 100 }, { orderId: 'different-order' }, { terminalId: 'different-terminal' }])(
    'rejects immutable replay conflict %j without another emit',
    async changed => {
      const payment = await auditPayment()
      const request = await auditRequest({ status: 'COMPLETED', paymentId: payment.id })
      await expect(
        terminalPaymentService.sendPaymentToTerminal({
          requestId: request.requestId,
          venueId,
          terminalId: fixture,
          orderId,
          amountCents: 10000,
          requestedBy: fixture,
          ...changed,
        }),
      ).rejects.toBeInstanceOf(BadRequestError)
      expect(directEmit).not.toHaveBeenCalled()
    },
  )

  it.each(['orderId', 'tipCents'] as const)('rejects replay that omits original %s', async omitted => {
    const payment = await auditPayment()
    const request = await auditRequest({ status: 'COMPLETED', paymentId: payment.id, tipCents: 100 })
    const replay: any = {
      requestId: request.requestId,
      venueId,
      terminalId: fixture,
      orderId,
      amountCents: 10000,
      tipCents: 100,
      requestedBy: fixture,
    }
    delete replay[omitted]
    await expect(terminalPaymentService.sendPaymentToTerminal(replay)).rejects.toBeInstanceOf(BadRequestError)
    expect(directEmit).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'FAILED', failureCode: 'ACK_TIMEOUT' },
    { status: 'FAILED', failureCode: 'TPV_ERROR' },
    { status: 'CANCELLED', failureCode: null },
  ])('historical physical slot remains reserved for another sale: %j', async historical => {
    // Mide la RANURA FÍSICA: su garantía vive con el interruptor ENCENDIDO (ver `encenderRegimenEstricto`).
    await encenderRegimenEstricto()
    await auditRequest(historical)
    expect(await terminalPaymentService.getBusyTerminalIds(venueId, [fixture])).toContain(fixture)
    directEmit.mockImplementation((_event, _payload, callback) => callback(new Error('lost ACK')))
    await expect(
      terminalPaymentService.sendPaymentToTerminal({
        requestId: nextRequest(),
        venueId,
        terminalId: fixture,
        amountCents: 10000,
        requestedBy: fixture,
      }),
    ).rejects.toBeInstanceOf(TerminalBusyError)
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('socket details cannot erase the authoritative contract mismatch envelope', async () => {
    const request = await auditRequest()
    const payment = await auditPayment({ amount: new Prisma.Decimal(101) })
    await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, request.requestId, payment.id, venueId, { amountCents: 10100, tipCents: 0 }),
    )
    const before = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(before.failureCode).toBe('CONTRACT_MISMATCH')
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: request.requestId, status: 'success', paymentId: payment.id },
      fixtureSocket(),
    )
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })).resultJson).toMatchObject({
      reconciliationRequired: true,
      requested: { amountCents: 10000 },
      reported: { amountCents: 10100 },
    })
  })

  it('bounded sweeps eventually reach exact payments beyond 200 unresolved rows', async () => {
    const createdAt = new Date(Date.now() - 3600000)
    await prisma.terminalPaymentRequest.createMany({
      data: Array.from({ length: 201 }, (_, index) => ({
        requestId: nextRequest(),
        venueId,
        terminalId: fixture + '-sweep-' + index,
        orderId,
        amountCents: 10000,
        status: 'UNKNOWN' as const,
        expiresAt: new Date(0),
        createdAt: new Date(createdAt.getTime() + index),
      })),
    })
    const last = await prisma.terminalPaymentRequest.findFirstOrThrow({
      where: { venueId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    // El cobro pertenece a la terminal de ESA fila: la recuperación exige que coincida el aparato.
    const payment = await auditPayment({ processorData: { terminalPaymentRequestId: last.requestId } }, last.terminalId)
    await terminalPaymentService.reconcileUnknownRequests()
    await terminalPaymentService.reconcileUnknownRequests()
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: last.id } })).paymentId).toBe(payment.id)
  })
})

describe('Terminal relay uncertainty survives database commits', () => {
  it.each(['failed', 'cancelled'] as const)('an unproven legacy socket %s result remains unknown', async status => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        expiresAt: new Date(0),
      },
    })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId, status },
      {
        socketId: 'fixture-socket',
        terminalId: fixture,
        venueId,
      },
    )
    expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
  })

  it.each([
    { status: 'failed' as const, outcomeEvidence: 'PROCESSOR_DECLINED' as const, expected: 'FAILED' },
    { status: 'cancelled' as const, outcomeEvidence: 'PRE_AUTHORIZATION' as const, expected: 'CANCELLED' },
  ])('accepts explicit $outcomeEvidence evidence from the request-owning socket', async proof => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        expiresAt: new Date(0),
      },
    })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId, ...proof },
      {
        socketId: 'fixture-socket',
        terminalId: fixture,
        venueId,
      },
    )
    expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({ status: proof.expected, paymentId: null })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(false)
  })

  it.each([
    { status: 'FAILED' as const, failureCode: 'TPV_ERROR' },
    { status: 'CANCELLED' as const, failureCode: null },
  ])('historical $status without outcome evidence never permits another authorization', async historical => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        ...historical,
        expiresAt: new Date(0),
      },
    })
    expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    directEmit.mockImplementation((_event, _payload, callback) => callback(new Error('lost ACK')))
    await expect(
      terminalPaymentService.sendPaymentToTerminal({
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-other`,
        orderId,
        amountCents: 10000,
        requestedBy: fixture,
      }),
    ).rejects.toBeInstanceOf(TerminalBusyError)
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('cannot reuse one recorded Payment as success for a different request', async () => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        expiresAt: new Date(0),
      },
    })
    const payment = await prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: new Prisma.Decimal(100),
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(100),
        processorData: { terminalPaymentRequestId: nextRequest() },
      },
    })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId, status: 'success', paymentId: payment.id },
      {
        socketId: 'fixture-socket',
        terminalId: fixture,
        venueId,
      },
    )
    expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
  })

  it('does not emit a charge for an order that is absent from the authenticated venue', async () => {
    directEmit.mockImplementation((_event, _payload, callback) => callback(new Error('lost ACK')))
    await expect(
      terminalPaymentService.sendPaymentToTerminal({
        requestId: nextRequest(),
        venueId,
        terminalId: fixture,
        orderId: nextRequest(),
        amountCents: 10000,
        requestedBy: fixture,
      }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(directEmit).not.toHaveBeenCalled()
    // Ningún cobro admitido: la única fila es la LÁPIDA del rechazo (H.5), que no ocupa terminal ni orden.
    const filas = await prisma.terminalPaymentRequest.findMany({ where: { venueId } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_ORDER_NOT_FOUND' })
  })

  it.each([
    { status: 'TIMED_OUT' as const, failureCode: 'MANUAL_RELEASE' },
    { status: 'FAILED' as const, failureCode: 'ACK_TIMEOUT' },
  ])('does not cancel an order with an unresolved historical $failureCode charge', async unresolved => {
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId: nextRequest(),
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        ...unresolved,
        expiresAt: new Date(0),
      },
    })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
  })

  it.each([undefined, 'payment-that-does-not-exist'])(
    'socket success without committed Payment evidence stays unknown (%s)',
    async paymentId => {
      const requestId = nextRequest()
      await prisma.terminalPaymentRequest.create({
        data: {
          requestId,
          venueId,
          terminalId: fixture,
          orderId,
          amountCents: 10000,
          expiresAt: new Date(0),
        },
      })
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId, status: 'success', paymentId },
        {
          socketId: 'fixture-socket',
          terminalId: fixture,
          venueId,
        },
      )
      expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    },
  )

  it('an unrelated subsequent card payment on the same order cannot reconcile an unknown request', async () => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        expiresAt: new Date(0),
        createdAt: new Date(0),
      },
    })
    await prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: new Prisma.Decimal(100),
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(100),
        idempotencyKey: nextRequest(),
      },
    })
    await terminalPaymentService.reconcileStaleRequests()
    expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
  })

  it('manual release without an execution-end proof preserves the terminal lock', async () => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        status: 'UNKNOWN',
        expiresAt: new Date(0),
      },
    })
    expect(
      await terminalPaymentService.releaseUnknownRequest({ requestId, venueId, reason: 'Sandbox proof', actor: { source: 'SUPERADMIN' } }),
    ).toMatchObject({ released: false, status: 'UNKNOWN' })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
  })

  it('stores exact request correlation with the committed Payment while preserving processor metadata', async () => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        expiresAt: new Date(0),
      },
    })
    const paymentId = await prisma.$transaction(async tx => {
      const payment = await tx.payment.create({
        data: {
          venueId,
          orderId,
          amount: new Prisma.Decimal(100),
          method: 'CREDIT_CARD',
          status: 'COMPLETED',
          feePercentage: new Prisma.Decimal(0),
          feeAmount: new Prisma.Decimal(0),
          netAmount: new Prisma.Decimal(100),
          processorData: { existingMarker: 'preserve' },
        },
      })
      // El cierre REST real viaja con el serial AUTENTICADO del token (identidad obligatoria).
      await terminalPaymentService.closeRowFromPaymentTx(tx, requestId, payment.id, venueId, undefined, 'REST', `AVQD-${fixture.toUpperCase()}`)
      return payment.id
    })
    expect((await prisma.payment.findFirstOrThrow({ where: { id: paymentId, venueId } })).processorData).toMatchObject({
      terminalPaymentRequestId: requestId,
      existingMarker: 'preserve',
    })
  })

  it('concurrent requests on different terminals cannot authorize the same unresolved order', async () => {
    directEmit.mockImplementation((_event, _payload, callback) => callback(new Error('lost ACK')))
    const results = await Promise.allSettled(
      ['a', 'b'].map(suffix =>
        terminalPaymentService.sendPaymentToTerminal({
          requestId: nextRequest(),
          venueId,
          terminalId: `${fixture}-${suffix}`,
          orderId,
          amountCents: 10000,
          requestedBy: fixture,
        }),
      ),
    )
    expect(directEmit).toHaveBeenCalledTimes(1)
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    // UN solo cobro admitido para la venta; el perdedor sólo deja su LÁPIDA (H.6), que no es un cobro.
    const filas = await prisma.terminalPaymentRequest.findMany({ where: { venueId, orderId } })
    expect(filas).toHaveLength(2)
    expect(filas.filter(f => f.status === 'FAILED' && f.failureCode === 'REJECTED_ORDER_BUSY')).toHaveLength(1)
    expect(filas.filter(f => f.failureCode !== 'REJECTED_ORDER_BUSY')).toHaveLength(1)
  })

  // 🔴 REQUISITO DEL FOUNDER (12-sep): «una sucursal puede tener las terminales que quiera y no
  // pueden colisionarse entre sí; desde el POS puedes mandar la orden de cobro a las 50».
  //
  // La prueba de arriba cubre DOS terminales EN CARRERA. El caso real es otro y es SECUENCIAL:
  // el cajero manda el cobro a una terminal, no le contesta, y **se va a la siguiente** — que con
  // 14 aparatos (la sucursal más grande de producción al 12-sep tiene 14) puede repetir 13 veces.
  // Ese recorrido es la forma más fácil de cobrarle dos veces al mismo cliente.
  //
  // Y tiene DOS lados, los dos aquí: la venta rebota en las otras 13 (no hay doble cobro) **y**
  // esas 13 quedan LIBRES para cobrar OTRAS ventas (rebotar una venta no puede dejar inservible
  // media sucursal). El candado de la ORDEN no filtra por terminal a propósito; el de la RANURA
  // sí — son dos candados distintos y esta prueba fija que no se confundan.
  it('una venta ofrecida a 14 terminales UNA TRAS OTRA sólo entra en una, y las otras 13 siguen libres para otras ventas', async () => {
    directEmit.mockImplementation((_event, _payload, callback) => callback(new Error('lost ACK')))
    const terminales = Array.from({ length: 14 }, (_, i) => `${fixture}-t${i}`)

    const desenlaces: string[] = []
    for (const terminalId of terminales) {
      try {
        await terminalPaymentService.sendPaymentToTerminal({
          requestId: nextRequest(),
          venueId,
          terminalId,
          orderId,
          amountCents: 10000,
          requestedBy: fixture,
        })
        desenlaces.push('admitida')
      } catch {
        desenlaces.push('rebotada')
      }
    }

    // UNA sola admisión para la venta, y el SDK de la terminal se tocó UNA sola vez.
    expect(desenlaces.filter(d => d === 'admitida')).toHaveLength(1)
    expect(desenlaces.filter(d => d === 'rebotada')).toHaveLength(13)
    expect(directEmit).toHaveBeenCalledTimes(1)

    const filas = await prisma.terminalPaymentRequest.findMany({ where: { venueId, orderId } })
    expect(filas.filter(f => f.failureCode === 'REJECTED_ORDER_BUSY')).toHaveLength(13)

    // 🔴 El otro lado: SÓLO la terminal que se quedó el cobro está ocupada. Las otras 13 pueden
    // seguir cobrando — si rebotar la venta las reservara, un cobro incierto apagaría la sucursal.
    const ocupadas = await Promise.all(terminales.map(t => terminalPaymentService.isTerminalBusy(t, venueId)))
    expect(ocupadas.filter(Boolean)).toHaveLength(1)
  })

  // 🔴 LA QUEJA QUE ORIGINÓ ESTE TRABAJO: «lo que no puede pasar es que se trabe la terminal».
  //
  // El ciclo completo, contra Postgres: un cobro cuyo desenlace nunca llegó (UNKNOWN) retiene la
  // ranura A PROPÓSITO. Cuando la terminal VUELVE a reportar y pasan 20 min sin que aparezca
  // ningún pago con tarjeta, el servidor suelta la RANURA — y la venta sigue cerrada.
  //
  // Antes del 12-sep esto tenía dos mitades rotas: el árbol había retirado el soltado (la terminal
  // no se liberaba NUNCA) y, aunque se hubiera restaurado, `TIMED_OUT` seguía dentro del predicado
  // de bloqueo en modo estricto — o sea que marcarla no soltaba nada. Las dos aquí.
  it('una terminal atascada se DESTRABA SOLA cuando vuelve y pasa la gracia — y la venta sigue protegida', async () => {
    const terminalId = `${fixture}-atascada`
    const serialNumber = `${fixture}-atascada`
    await prisma.terminal.create({
      data: { venueId, name: 'atascada', serialNumber, type: 'TPV_ANDROID', lastHeartbeat: new Date() },
    })
    const vencida = new Date(Date.now() - 60 * 60_000)
    const row = await auditRequest({ terminalId, status: 'UNKNOWN', expiresAt: vencida, createdAt: vencida })

    // (1) Antes de nada: la terminal está reservada y la venta cerrada. Es el estado del incidente.
    expect(await terminalPaymentService.isTerminalBusy(terminalId, venueId)).toBe(true)

    // (2) Primer barrido: la terminal está reportando, así que se ESTAMPA su regreso. No suelta aún
    //     — la gracia empieza a contar desde que la vimos volver, no desde que se perdió.
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    const trasEstampar = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(trasEstampar.terminalReturnedAt).not.toBeNull()
    expect(trasEstampar.status).toBe('UNKNOWN')
    expect(await terminalPaymentService.isTerminalBusy(terminalId, venueId)).toBe(true)

    // (3) Segundo barrido, ya pasada la gracia. 🔑 La terminal SIGUE latiendo: la gracia sólo cuenta
    //     mientras el aparato está presente — si se vuelve a ir, el estampado se borra y se espera
    //     otra vez (su cola nunca tuvo ocasión de contar lo que pasó). Sin actualizar el latido, el
    //     fixture describiría una terminal ausente y el barrido haría bien en NO soltar.
    const despues = new Date(Date.now() + 21 * 60_000)
    await prisma.terminal.update({ where: { serialNumber }, data: { lastHeartbeat: despues } })
    const resumen = await terminalPaymentService.reconcileUnknownRequests(despues)
    expect(resumen.released).toBe(1)

    const soltada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(soltada).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })

    // (4) 🟢 LA RANURA QUEDÓ LIBRE: la terminal vuelve a servir. Esto es lo que no pasaba.
    expect(await terminalPaymentService.isTerminalBusy(terminalId, venueId)).toBe(false)

    // (5) 🔴 …y la VENTA sigue cerrada: soltamos capacidad, no la obligación. Un cobro nuevo sobre
    //     la MISMA orden —en esta terminal o en cualquier otra de la sucursal— sigue rebotando.
    await expect(
      terminalPaymentService.sendPaymentToTerminal({
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-otra-cualquiera`,
        orderId,
        amountCents: 10000,
        requestedBy: fixture,
      }),
    ).rejects.toThrow()
  })

  it('released terminal does not permit reauthorizing its financially unresolved order', async () => {
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId: nextRequest(),
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        status: 'TIMED_OUT',
        failureCode: 'MANUAL_RELEASE',
        expiresAt: new Date(0),
      },
    })
    directEmit.mockImplementation((_event, _payload, callback) => callback(new Error('lost ACK')))
    await expect(
      terminalPaymentService.sendPaymentToTerminal({
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-other`,
        orderId,
        amountCents: 10000,
        requestedBy: fixture,
      }),
    ).rejects.toBeInstanceOf(TerminalBusyError)
    expect(directEmit).not.toHaveBeenCalled()
  })

  // 🔴 Por la RUTA REAL, no sólo por el método: el registro del cobro de la TPV (`recordOrderPayment`)
  // pasa el serial AUTENTICADO al cierre y lo persiste en `processorData`. Aquí el serial lleva la forma
  // de producción (`AVQD-…` en mayúsculas) y la solicitud la llave normalizada.
  it('recordOrderPayment closes the arbitration row from the authenticated serial and persists the provenance', async () => {
    const serial = `AVQD-${fixture.toUpperCase()}`
    await terminalDelFixture(serial)
    const staff = await prisma.staff.create({
      data: {
        email: `${fixture}-cajero@example.test`,
        firstName: 'Cajero',
        lastName: 'Relevo',
        phone: '5550000001',
        organizations: { create: { organizationId: fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role: 'CASHIER', active: true } },
      },
    })
    const venta = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-ruta-real`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(100),
        createdById: staff.id,
      },
    })
    const request = await auditRequest({ status: 'SENT', orderId: venta.id })
    try {
      await recordOrderPayment(
        venueId,
        venta.id,
        {
          venueId,
          amount: 10000,
          tip: 0,
          status: 'COMPLETED',
          method: 'CREDIT_CARD',
          source: 'TPV',
          splitType: 'FULLPAYMENT',
          staffId: staff.id,
          authorizationNumber: 'AUTH-RUTA-REAL',
          referenceNumber: `REF-${fixture}`,
          idempotencyKey: `llave-${fixture}-ruta-real`,
          paidProductsId: [],
          currency: 'MXN',
          isInternational: false,
          deviceSerialNumber: serial,
          terminalPaymentRequestId: request.requestId,
        } as any,
        staff.id,
      )
      const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
      expect(after.status).toBe('COMPLETED')
      expect(after.paymentId).not.toBeNull()
      const pago = await prisma.payment.findUniqueOrThrow({ where: { id: after.paymentId! } })
      expect((pago.processorData as Record<string, unknown>).deviceSerialNumber).toBe(serial)
      expect((pago.processorData as Record<string, unknown>).terminalPaymentRequestId).toBe(request.requestId)
    } finally {
      await prisma.payment.deleteMany({ where: { venueId, orderId: venta.id } })
      await prisma.terminalPaymentRequest.deleteMany({ where: { venueId, orderId: venta.id } })
      await prisma.order.deleteMany({ where: { id: venta.id } })
      await prisma.staffVenue.deleteMany({ where: { staffId: staff.id } })
      await prisma.staffOrganization.deleteMany({ where: { staffId: staff.id } })
      await prisma.staff.deleteMany({ where: { id: staff.id } })
    }
  })

  it('lost ACK keeps the terminal reserved and replays uncertainty without a second emit', async () => {
    const requestId = nextRequest()
    directEmit.mockImplementation((_event, _payload, callback) => callback(new Error('lost ACK after terminal persisted')))
    const request = { requestId, venueId, terminalId: fixture, amountCents: 10000, requestedBy: fixture }
    expect(await terminalPaymentService.sendPaymentToTerminal(request)).toMatchObject({ requestId, status: 'timeout' })
    const row = await prisma.terminalPaymentRequest.findFirstOrThrow({ where: { venueId, requestId } })
    expect(row.status).toBe('UNKNOWN')
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    expect(await terminalPaymentService.sendPaymentToTerminal(request)).toMatchObject({ status: 'timeout' })
    expect(directEmit).toHaveBeenCalledTimes(1)
  })

  it('cancel without terminal confirmation remains unknown after watchdog and process-local waiter loss', async () => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        status: 'CANCEL_REQUESTED',
        expiresAt: new Date(0),
        updatedAt: new Date(0),
      },
    })
    await terminalPaymentService.reconcileStaleRequests()
    expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
  })

  it('crash before commit rolls back both the real Payment and the request close', async () => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        expiresAt: new Date(Date.now() + 60000),
      },
    })
    await expect(
      prisma.$transaction(async tx => {
        const payment = await tx.payment.create({
          data: {
            venueId,
            orderId,
            amount: new Prisma.Decimal(100),
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            feePercentage: new Prisma.Decimal(0),
            feeAmount: new Prisma.Decimal(0),
            netAmount: new Prisma.Decimal(100),
            idempotencyKey: requestId,
          },
        })
        await terminalPaymentService.closeRowFromPaymentTx(tx, requestId, payment.id, venueId)
        throw new Error('injected crash before commit')
      }),
    ).rejects.toThrow('injected crash before commit')
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: requestId } })).toBe(0)
    expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({ status: 'PENDING', paymentId: null })
  })

  it('committed approval wins a stale cancelled result on retry even after the HTTP response is lost', async () => {
    const requestId = nextRequest()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: fixture,
        orderId,
        amountCents: 10000,
        status: 'CANCELLED',
        resultJson: { requestId, status: 'cancelled' },
        expiresAt: new Date(0),
      },
    })
    const paymentId = await prisma.$transaction(async tx => {
      const payment = await tx.payment.create({
        data: {
          venueId,
          orderId,
          amount: new Prisma.Decimal(100),
          method: 'CREDIT_CARD',
          status: 'COMPLETED',
          feePercentage: new Prisma.Decimal(0),
          feeAmount: new Prisma.Decimal(0),
          netAmount: new Prisma.Decimal(100),
          idempotencyKey: requestId,
        },
      })
      await terminalPaymentService.closeRowFromPaymentTx(tx, requestId, payment.id, venueId, undefined, 'REST', `AVQD-${fixture.toUpperCase()}`)
      return payment.id
    })
    const replay = await terminalPaymentService.sendPaymentToTerminal({
      requestId,
      venueId,
      terminalId: fixture,
      orderId,
      amountCents: 10000,
      requestedBy: fixture,
    })
    expect(replay).toMatchObject({ status: 'success', paymentId })
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: requestId } })).toBe(1)
    expect(directEmit).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════
// SONDA DE CONCILIACIÓN — la evidencia la aporta la propia terminal desde su bandeja durable.
// Ni el reloj, ni un heartbeat, ni una marca de liberación resuelven una fila (auditoría Codex,
// 10-sep). Lo que sí resuelve: un resultado durable CON evidencia (`PRE_AUTHORIZATION` /
// `PROCESSOR_DECLINED`), o que la terminal no tenga la solicitud y la solicitud NUNCA se haya entregado
// a ningún socket (procedencia exactamente `[]`). Una entrega registrada, aunque sin ACK, no se libera:
// la bandeja pudo haberse vaciado después de ejecutarla (plan D, 11-sep).
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('Sonda de conciliación: la terminal aporta la evidencia, nunca el reloj', () => {
  const sonda = () => ({ socketId: 'fixture-socket', terminalId: fixture, venueId })
  const responder = (event: Record<string, unknown>) => (terminalPaymentService as any).handleProbeResultFromSocket(event, sonda())

  it('a CANCELLED row the terminal never confirmed is released ONLY by a durable pre-authorization cancel replay', async () => {
    // Mide la RANURA FÍSICA: su garantía vive con el interruptor ENCENDIDO (ver `encenderRegimenEstricto`).
    await encenderRegimenEstricto()
    const row = await auditRequest({ status: 'CANCELLED', cancelDisposition: 'CANCELLED', acknowledgedAt: new Date(), orderId: null })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    // Un «cancelled» SIN evidencia no libera: sigue siendo incierto.
    expect(await responder({ requestId: row.requestId, disposition: 'RESOLVED', finalResult: { requestId: row.requestId, status: 'cancelled' } })).toBe(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    // Con evidencia de que se canceló ANTES de autorizar: libera y deja rastro.
    expect(
      await responder({
        requestId: row.requestId,
        disposition: 'RESOLVED',
        finalResult: { requestId: row.requestId, status: 'cancelled', outcomeEvidence: 'PRE_AUTHORIZATION' },
      }),
    ).toBe(true)
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe('CANCELLED')
    expect(after.cancelDisposition).toBe('ACCEPTED')
    expect(after.lateResult).toBe(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
  })

  it('a FAILED/ACK_TIMEOUT row is released by a processor-declined replay, never by a bare failure', async () => {
    // Mide la RANURA FÍSICA: su garantía vive con el interruptor ENCENDIDO (ver `encenderRegimenEstricto`).
    await encenderRegimenEstricto()
    const row = await auditRequest({ status: 'FAILED', failureCode: 'ACK_TIMEOUT', acknowledgedAt: null, orderId: null })
    await responder({ requestId: row.requestId, disposition: 'RESOLVED', finalResult: { requestId: row.requestId, status: 'failed' } })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    await responder({
      requestId: row.requestId,
      disposition: 'RESOLVED',
      finalResult: { requestId: row.requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED' },
    })
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe('FAILED')
    expect(after.failureCode).toBe('TPV_CONFIRMED_NO_CHARGE')
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
  })

  it('NOT_FOUND releases only a request that was NEVER delivered to any socket; an acknowledged one is a contradiction and stays', async () => {
    // Codex 11-sep: «sin ACK» no basta; sólo libera una fila NUNCA ENTREGADA (procedencia vacía, no nula).
    const nuncaAcusada = await auditRequest({ status: 'TIMED_OUT', acknowledgedAt: null, orderId: null, deliveryProvenance: { deliveries: [] } })
    await responder({ requestId: nuncaAcusada.requestId, disposition: 'NOT_FOUND' })
    const liberada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: nuncaAcusada.id } })
    expect(liberada.status).toBe('FAILED')
    expect(liberada.failureCode).toBe('TPV_NEVER_RECEIVED')
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)

    const acusada = await auditRequest({ status: 'UNKNOWN', acknowledgedAt: new Date(), orderId: null })
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    await responder({ requestId: acusada.requestId, disposition: 'NOT_FOUND' })
    const retenida = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: acusada.id } })
    expect(retenida.status).toBe('UNKNOWN')
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    // La contradicción (acusó y ya no la tiene) es un incidente que un humano debe ver: 🚨 obligatorio.
    // Sin esto, quitar la guarda del código pasaba desapercibido porque el `where` del updateMany
    // también exige `acknowledgedAt: null` — dos capas, y cada una con su prueba.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Probe contradiction'), expect.objectContaining({ requestId: acusada.requestId }))
    errSpy.mockRestore()
  })

  it('NOT_FOUND does NOT release a request that was handed to a LEGACY socket (delivery trace without ACK): audited once, reservation kept', async () => {
    // Mide la RANURA FÍSICA: su garantía vive con el interruptor ENCENDIDO (ver `encenderRegimenEstricto`).
    await encenderRegimenEstricto()
    // Auditor final (10-sep, P2-1): la PAX de Testarudo corre 2.8.7 —sin bandeja durable ni ACK—. A un socket
    // así el servidor emite UNA vez sin acuse. Tras actualizar el APK, «no la tengo» no acredita que nunca la
    // recibió ni que no la ejecutó: es evidencia clase B (operador), no clase A.
    const legacy = await auditRequest({ status: 'TIMED_OUT', acknowledgedAt: null, lastDeliveredAt: new Date(), deliveryAttempts: 1, orderId: null, deliveryProvenance: { deliveries: [{ protocol: 'LEGACY', ackVersion: 0, cancelDispositionVersion: 0, probeVersion: 0, socketId: 'old-socket', at: new Date().toISOString(), replay: false }] } })
    expect(await responder({ requestId: legacy.requestId, disposition: 'NOT_FOUND' })).toBe(true)
    expect(await responder({ requestId: legacy.requestId, disposition: 'NOT_FOUND' })).toBe(true) // el barrido insiste
    const kept = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: legacy.id } })
    expect(kept.status).toBe('TIMED_OUT')
    expect(kept.failureCode).not.toBe('TPV_NEVER_RECEIVED')
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    const audit = (logAction as jest.Mock).mock.calls
      .map(([params]) => params as { action: string; entityId?: string; data?: Record<string, unknown> })
      .filter(p => p.action === 'TERMINAL_PAYMENT_PROBE_UNACCREDITED' && p.entityId === legacy.id)
    expect(audit).toHaveLength(1)
    expect(audit[0].data?.evidence).toBe('NOT_FOUND_AFTER_DELIVERY')
  })

  it('handing a request to a LEGACY socket (no ACK capability) leaves a durable delivery trace: lastDeliveredAt without acknowledgedAt', async () => {
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
      terminalId,
      venueId,
      socketId: 'fixture-socket',
      terminalPaymentAckVersion: 0, // APK publicado sin ACK ni bandeja (p. ej. PAX 2.8.7)
    }))
    const requestId = nextRequest()
    // La entrega legacy no espera acuse: la promesa queda pendiente del resultado de la terminal; no se espera aquí.
    void terminalPaymentService.sendPaymentToTerminal({ requestId, venueId, terminalId: fixture, amountCents: 10000, requestedBy: fixture })
    let row: Awaited<ReturnType<typeof prisma.terminalPaymentRequest.findFirst>> = null
    for (let i = 0; i < 60 && !row?.lastDeliveredAt; i++) {
      await new Promise(r => setTimeout(r, 50))
      row = await prisma.terminalPaymentRequest.findFirst({ where: { venueId, requestId } })
    }
    expect(directEmit).toHaveBeenCalledTimes(1)
    expect(row?.lastDeliveredAt).toBeTruthy()
    expect(row?.acknowledgedAt).toBeNull()
    expect(row?.deliveryAttempts).toBe(1)
    expect(row?.status).toBe('PENDING')
    const deliveries = (row?.deliveryProvenance as { deliveries?: Array<Record<string, unknown>> } | null)?.deliveries ?? []
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ protocol: 'LEGACY', ackVersion: 0, socketId: 'fixture-socket', replay: false })
    // Sin esto, el temporizador de 5 min del waiter queda colgado en el proceso de jest.
    const pending = (terminalPaymentService as any).pendingPayments.get(requestId)
    if (pending) {
      clearTimeout(pending.timeout)
      ;(terminalPaymentService as any).pendingPayments.delete(requestId)
      pending.resolve({ requestId, status: 'timeout' })
    }
  })

  it('delivery provenance is durable BEFORE the emit, on both paths (legacy and durable)', async () => {
    // Codex 11-sep (2): emitir y escribir después, sin esperar, deja una ventana en la que una entrega real no
    // tiene rastro. La procedencia se escribe y se ESPERA antes de tocar el socket.
    for (const ackVersion of [0, 1]) {
      ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
        terminalId,
        venueId,
        socketId: 'fixture-socket',
        terminalPaymentAckVersion: ackVersion,
      }))
      const requestId = nextRequest()
      let vistoAlEmitir: Promise<unknown> | null = null
      directEmit.mockImplementation((_event: string, _payload: unknown, callback?: (e: Error | null, r?: unknown) => void) => {
        const lectura = prisma.terminalPaymentRequest.findFirst({ where: { venueId, requestId }, select: { deliveryProvenance: true, deliveryAttempts: true } })
        vistoAlEmitir = lectura
        // El ACK sólo DESPUÉS de haber leído lo que había en la fila en el instante del emit.
        if (callback) void lectura.then(() => callback(null, { accepted: true, requestId }))
      })
      const envio = terminalPaymentService.sendPaymentToTerminal({ requestId, venueId, terminalId: fixture, amountCents: 10000, requestedBy: fixture })
      for (let i = 0; i < 60 && !vistoAlEmitir; i++) await new Promise(r => setTimeout(r, 50))
      expect(vistoAlEmitir).not.toBeNull()
      const enElEmit = (await vistoAlEmitir!) as { deliveryProvenance: { deliveries: Array<Record<string, unknown>> }; deliveryAttempts: number }
      expect(enElEmit.deliveryAttempts).toBe(1)
      expect(enElEmit.deliveryProvenance.deliveries).toHaveLength(1)
      expect(enElEmit.deliveryProvenance.deliveries[0]).toMatchObject({ protocol: ackVersion === 0 ? 'LEGACY' : 'DURABLE', ackVersion, replay: false })
      const pending = (terminalPaymentService as any).pendingPayments.get(requestId)
      if (pending) {
        clearTimeout(pending.timeout)
        ;(terminalPaymentService as any).pendingPayments.delete(requestId)
        pending.resolve({ requestId, status: 'timeout' })
      }
      await envio
      // Una solicitud en vuelo por terminal: se retira la fila antes de la siguiente iteración.
      await prisma.terminalPaymentRequest.deleteMany({ where: { venueId, requestId } })
    }
  })

  it('if the provenance cannot be written, nothing is emitted and the row is retained as uncertain', async () => {
    const requestId = nextRequest()
    const spy = jest.spyOn(prisma, '$executeRaw').mockRejectedValueOnce(new Error('db down before emit'))
    const result = await terminalPaymentService.sendPaymentToTerminal({ requestId, venueId, terminalId: fixture, amountCents: 10000, requestedBy: fixture })
    spy.mockRestore()
    expect(result).toMatchObject({ requestId, status: 'timeout' })
    expect(directEmit).not.toHaveBeenCalled()
    const row = await prisma.terminalPaymentRequest.findFirstOrThrow({ where: { venueId, requestId } })
    expect(row.status).toBe('UNKNOWN')
    expect(row.failureCode).toBe('DELIVERY_NOT_RECORDED')
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
  })

  it('deliveryAttempts counts DELIVERIES, not ACKs: an acknowledged delivery is 1 and an acknowledged replay adds exactly 1', async () => {
    // Auditoría 11-sep (P3-3): `recordDelivery` suma al ENTREGAR y el ACK volvía a sumar ⇒ el contador decía 2 por
    // cada entrega durable. Nadie lo lee hoy, y por eso mismo hay que fijarlo antes de que alguien lo use.
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({ terminalId, venueId, socketId: 'fixture-socket', terminalPaymentAckVersion: 1 }))
    const requestId = nextRequest()
    directEmit.mockImplementation((_e: string, _p: unknown, cb?: (e: Error | null, r?: unknown) => void) => cb?.(null, { accepted: true, requestId }))
    const leer = () => prisma.terminalPaymentRequest.findFirst({ where: { venueId, requestId }, select: { acknowledgedAt: true, deliveryAttempts: true, deliveryProvenance: true } })
    const envio = terminalPaymentService.sendPaymentToTerminal({ requestId, venueId, terminalId: fixture, amountCents: 10000, requestedBy: fixture })
    let fila = await leer()
    for (let i = 0; i < 60 && !fila?.acknowledgedAt; i++) {
      await new Promise(r => setTimeout(r, 50))
      fila = await leer()
    }
    expect(fila?.acknowledgedAt).not.toBeNull()
    expect(fila?.deliveryAttempts).toBe(1)
    // Replay de la MISMA fila (SENT, vigente, procedencia DURABLE): una entrega más ⇒ exactamente 2. La entrega se graba
    // ANTES de emitir (con `await`), así que no hay que esperar a ningún acuse para leerla.
    await (terminalPaymentService as any).replayPendingForTerminal(fixture, venueId, 'fixture-socket')
    fila = await leer()
    expect((fila!.deliveryProvenance as { deliveries: unknown[] }).deliveries).toHaveLength(2)
    expect(fila?.deliveryAttempts).toBe(2)
    const pending = (terminalPaymentService as any).pendingPayments.get(requestId)
    if (pending) {
      clearTimeout(pending.timeout)
      ;(terminalPaymentService as any).pendingPayments.delete(requestId)
      pending.resolve({ requestId, status: 'timeout' })
    }
    await envio
    await prisma.terminalPaymentRequest.deleteMany({ where: { venueId, requestId } })
  })

  it('a replay ACK only confirms a PENDING row: it never renews a SENT row nor touches one that is cancelling or closed', async () => {
    // Re-auditoría 11-sep (P2-1): renovar la vigencia de una fila SENT en cada reconexión la dejaba «en curso» para
    // siempre (el vigía nunca la pasa a UNKNOWN, sin 🚨). (P2-3): el filtro de estado es lo único que impide que un ACK
    // tardío reviva a SENT una fila cerrada o en cancelación. Se prueba el método que escribe el ACK, contra Postgres.
    const registrar = (requestId: string) => (terminalPaymentService as any).registrarAckDeReplay(requestId, venueId) as Promise<number>
    const otraTerminal = `${fixture}-ack`
    const pendiente = await auditRequest({ status: 'PENDING', acknowledgedAt: null, orderId: null, terminalId: otraTerminal, expiresAt: new Date(Date.now() + 60_000) })
    expect(await registrar(pendiente.requestId)).toBe(1)
    const confirmada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: pendiente.id } })
    expect(confirmada.status).toBe('SENT')
    expect(confirmada.acknowledgedAt).not.toBeNull()
    await prisma.terminalPaymentRequest.deleteMany({ where: { id: pendiente.id } })
    for (const status of ['SENT', 'CANCEL_REQUESTED', 'COMPLETED', 'UNKNOWN', 'CANCELLED'] as const) {
      const ackPrevio = new Date(Date.now() - 120_000)
      const vence = new Date(Date.now() + 60_000)
      const extra = status === 'COMPLETED' ? { paymentId: (await auditPayment()).id } : {}
      const fila = await auditRequest({ status, acknowledgedAt: ackPrevio, orderId: null, terminalId: otraTerminal, expiresAt: vence, ...extra })
      expect({ status, cambiadas: await registrar(fila.requestId) }).toEqual({ status, cambiadas: 0 })
      const despues = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: fila.id } })
      expect(despues.status).toBe(status)
      expect(despues.expiresAt?.getTime()).toBe(vence.getTime())
      expect(despues.acknowledgedAt?.getTime()).toBe(ackPrevio.getTime())
      await prisma.terminalPaymentRequest.deleteMany({ where: { id: fila.id } })
    }
  })

  it('replay never re-emits a row delivered to a legacy socket nor one of unknown provenance; it re-delivers a durable one with replay provenance', async () => {
    // Codex 11-sep (3): tras actualizar el APK, un intento entregado a una app SIN bandeja se reenviaría a una bandeja
    // que no lo conoce y se ejecutaría otra vez. La procedencia manda, no las capacidades del socket actual.
    // (Una sola fila activa por terminal —índice único de ranura—: los tres casos van en secuencia.)
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({ terminalId, venueId, socketId: 'fixture-socket', terminalPaymentAckVersion: 1 }))
    const vigente = () => new Date(Date.now() + 4 * 60_000)
    const casos: Array<{ nombre: string; provenance: unknown; reenviada: boolean; motivo?: string }> = [
      { nombre: 'legacy', provenance: { deliveries: [{ protocol: 'LEGACY', ackVersion: 0, socketId: 'old-socket', at: new Date().toISOString(), replay: false }] }, reenviada: false, motivo: 'LEGACY_DELIVERY' },
      { nombre: 'desconocida', provenance: null, reenviada: false, motivo: 'UNKNOWN_PROVENANCE' },
      { nombre: 'durable', provenance: { deliveries: [{ protocol: 'DURABLE', ackVersion: 1, socketId: 'old-socket', at: new Date().toISOString(), replay: false }] }, reenviada: true },
    ]
    for (const caso of casos) {
      directEmit.mockClear()
      const row = await auditRequest({ status: 'PENDING', acknowledgedAt: null, orderId: null, expiresAt: vigente(), deliveryProvenance: caso.provenance })
      directEmit.mockImplementation((_e: string, _p: unknown, cb?: (e: Error | null, r?: unknown) => void) => cb?.(null, { accepted: true, requestId: row.requestId }))
      for (let i = 0; i < 2; i++) await (terminalPaymentService as any).replayPendingForTerminal(fixture, venueId, 'fixture-socket')
      const reenviadas = directEmit.mock.calls.filter(([e]) => e === 'terminal:payment_request').map(([, p]) => (p as { requestId: string }).requestId)
      if (caso.reenviada) {
        expect(reenviadas).toContain(row.requestId)
        const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
        const dels = (after.deliveryProvenance as { deliveries: Array<Record<string, unknown>> }).deliveries
        expect(dels.length).toBeGreaterThanOrEqual(2)
        expect(dels[dels.length - 1]).toMatchObject({ protocol: 'DURABLE', replay: true, socketId: 'fixture-socket' })
        // 11-sep: el ACK de un replay se escribía con `void prisma…updateMany(…)` y una consulta de Prisma es PEREZOSA
        // (sólo corre con await/then): la fila acusada se quedaba PENDING, sin `acknowledgedAt` ni vigencia renovada.
        let acusada = after
        for (let i = 0; i < 60 && acusada.status !== 'SENT'; i++) {
          await new Promise(r => setTimeout(r, 50))
          acusada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
        }
        expect(acusada.status).toBe('SENT')
        expect(acusada.acknowledgedAt).not.toBeNull()
      } else {
        expect(reenviadas).not.toContain(row.requestId)
        const skips = (logAction as jest.Mock).mock.calls
          .map(([params]) => params as { action: string; entityId?: string; data?: Record<string, unknown> })
          .filter(p => p.action === 'TERMINAL_PAYMENT_REPLAY_SKIPPED' && p.entityId === row.id)
        expect(skips).toHaveLength(1) // dos barridos, UNA auditoría
        expect(skips[0].data?.reason).toBe(caso.motivo)
      }
      await prisma.terminalPaymentRequest.deleteMany({ where: { id: row.id } })
    }
  })

  it('NOT_FOUND keeps (and audits once) a row with unknown provenance and a row delivered without ACK, even a durable one whose ACK was lost', async () => {
    // Codex 11-sep (3, 4): nulo = procedencia desconocida, nunca «no entregada»; un ACK perdido no acredita nada.
    const historica = await auditRequest({ status: 'TIMED_OUT', acknowledgedAt: null, orderId: null, deliveryProvenance: null })
    const ackPerdido = await auditRequest({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT', acknowledgedAt: null, orderId: null, deliveryProvenance: { deliveries: [{ protocol: 'DURABLE', ackVersion: 1, socketId: 'fixture-socket', at: new Date().toISOString(), replay: false }] } })
    for (const row of [historica, ackPerdido]) {
      expect(await responder({ requestId: row.requestId, disposition: 'NOT_FOUND' })).toBe(true)
      expect(await responder({ requestId: row.requestId, disposition: 'NOT_FOUND' })).toBe(true)
      const kept = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
      expect(kept.status).toBe(row.status)
      expect(kept.failureCode).not.toBe('TPV_NEVER_RECEIVED')
    }
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    const audits = (logAction as jest.Mock).mock.calls
      .map(([params]) => params as { action: string; entityId?: string; data?: Record<string, unknown> })
      .filter(p => p.action === 'TERMINAL_PAYMENT_PROBE_UNACCREDITED')
    expect(audits.filter(p => p.entityId === historica.id).map(p => p.data?.evidence)).toEqual(['NOT_FOUND_UNKNOWN_PROVENANCE'])
    expect(audits.filter(p => p.entityId === ackPerdido.id).map(p => p.data?.evidence)).toEqual(['NOT_FOUND_AFTER_DELIVERY'])
  })

  it('ACTIVE keeps the reservation untouched', async () => {
    const row = await auditRequest({ status: 'UNKNOWN', acknowledgedAt: new Date(), orderId: null })
    expect(await responder({ requestId: row.requestId, disposition: 'ACTIVE' })).toBe(true)
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('UNKNOWN')
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
  })

  it('another terminal cannot answer the probe for a request it does not own', async () => {
    const row = await auditRequest({ status: 'TIMED_OUT', acknowledgedAt: null, orderId: null })
    const ajena = { socketId: 'otro', terminalId: `${fixture}-otra`, venueId }
    expect(await (terminalPaymentService as any).handleProbeResultFromSocket({ requestId: row.requestId, disposition: 'NOT_FOUND' }, ajena)).toBe(false)
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('TIMED_OUT')
  })

  it('a probe answer WITHOUT accredited evidence neither reconciles nor re-marks the row: audited ONCE and not re-probed for a while', async () => {
    // Mide la RANURA FÍSICA: su garantía vive con el interruptor ENCENDIDO (ver `encenderRegimenEstricto`).
    await encenderRegimenEstricto()
    // Medido en hardware (PAX 2841548417, 10-sep 15:01): la fila del 8-sep resuelta por el APK 2.8.7 —sin
    // `outcomeEvidence`— pasaba a UNKNOWN en silencio y el barrido la volvía a «reconciliar» cada 30 s con
    // dos avisos engañosos y sin una sola entrada de auditoría. Sin evidencia no hay nada que reconciliar.
    const row = await auditRequest({ status: 'CANCELLED', cancelDisposition: 'CANCELLED', acknowledgedAt: new Date(), orderId: null, lateResult: false })
    const sinEvidencia = {
      requestId: row.requestId,
      disposition: 'RESOLVED',
      finalResult: { requestId: row.requestId, status: 'cancelled', errorMessage: 'Pago cancelado en la terminal', completedAt: '2026-09-08T15:55:31.709Z' },
    }
    expect(await responder(sinEvidencia)).toBe(true)
    expect(await responder(sinEvidencia)).toBe(true) // el barrido vuelve a preguntar y la terminal contesta lo mismo
    const after = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    // La fila queda EXACTAMENTE como estaba: ni UNKNOWN, ni lateResult, ni desenlace inventado.
    expect(after.status).toBe('CANCELLED')
    expect(after.cancelDisposition).toBe('CANCELLED')
    expect(after.lateResult).toBe(false)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    // Auditoría UNA vez, con lo que la terminal guardó: es la evidencia «clase B» que decide un operador.
    // (`logAction` está mockeado globalmente en integración: se afirma sobre la llamada, no sobre la tabla.)
    const audit = (logAction as jest.Mock).mock.calls
      .map(([params]) => params as { action: string; entityId?: string; data?: Record<string, unknown> })
      .filter(p => p.action === 'TERMINAL_PAYMENT_PROBE_UNACCREDITED' && p.entityId === row.id)
    expect(audit).toHaveLength(1)
    expect(audit[0].data?.terminalOutcome).toMatchObject({ status: 'cancelled', errorMessage: 'Pago cancelado en la terminal' })
    // Y ese request NO se vuelve a sondear en la ventana de espera; los demás sí.
    const otra = await auditRequest({ status: 'TIMED_OUT', acknowledgedAt: null, orderId: null })
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
      terminalId,
      venueId,
      socketId: 'fixture-socket',
      terminalPaymentAckVersion: 1,
      identityVerified: true,
      terminalPaymentProbeVersion: 1,
    }))
    directEmit.mockClear()
    await (terminalPaymentService as any).probeUnresolvedForTerminal(fixture, venueId, 'fixture-socket')
    expect(directEmit.mock.calls.filter(([event]) => event === 'terminal:payment_probe').map(([, payload]) => payload.requestId)).toEqual([otra.requestId])
  })

  it('a NOT_FOUND contradiction (acknowledged row) is audited ONCE and not re-probed within the backoff window', async () => {
    // Re-auditoría 11-sep (P2-2): la rama de contradicción no marcaba la espera ⇒ cada barrido de 30 s re-sondeaba y
    // escribía otro 🚨 y otra fila de bitácora (≈2 880 al día por fila). La evidencia no cambia entre barridos.
    const durable = { protocol: 'DURABLE', ackVersion: 1, cancelDispositionVersion: 1, probeVersion: 1, socketId: 's-viejo', at: new Date().toISOString(), replay: false }
    const row = await auditRequest({ status: 'UNKNOWN', acknowledgedAt: new Date(), orderId: null, deliveryProvenance: { deliveries: [durable] } })
    for (let i = 0; i < 2; i++) await responder({ requestId: row.requestId, disposition: 'NOT_FOUND' })
    const asientos = (logAction as jest.Mock).mock.calls
      .map(([params]) => params as { action: string; entityId?: string })
      .filter(p => p.action === 'TERMINAL_PAYMENT_PROBE_CONTRADICTION' && p.entityId === row.id)
    expect(asientos).toHaveLength(1)
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('UNKNOWN')
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
      terminalId,
      venueId,
      socketId: 'fixture-socket',
      terminalPaymentAckVersion: 1,
      identityVerified: true,
      terminalPaymentProbeVersion: 1,
    }))
    directEmit.mockClear()
    await (terminalPaymentService as any).probeUnresolvedForTerminal(fixture, venueId, 'fixture-socket')
    expect(directEmit.mock.calls.filter(([event]) => event === 'terminal:payment_probe').map(([, payload]) => payload.requestId)).not.toContain(row.requestId)
  })

  it('a RESOLVED success whose Payment cannot be linked is not re-probed every sweep either', async () => {
    const row = await auditRequest({ status: 'TIMED_OUT', acknowledgedAt: new Date(), orderId: null })
    await responder({ requestId: row.requestId, disposition: 'RESOLVED', finalResult: { requestId: row.requestId, status: 'success', paymentId: 'no-existe' } })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true) // sin Payment ligable no se libera
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
      terminalId,
      venueId,
      socketId: 'fixture-socket',
      terminalPaymentAckVersion: 1,
      identityVerified: true,
      terminalPaymentProbeVersion: 1,
    }))
    directEmit.mockClear()
    await (terminalPaymentService as any).probeUnresolvedForTerminal(fixture, venueId, 'fixture-socket')
    expect(directEmit.mock.calls.filter(([event]) => event === 'terminal:payment_probe').map(([, payload]) => payload.requestId)).not.toContain(row.requestId)
  })

  it('the probe is emitted only to an identity-verified terminal that announced the capability, and only for unresolved rows', async () => {
    const sinDesenlace = await auditRequest({ status: 'CANCELLED', cancelDisposition: 'CANCELLED', orderId: null })
    await auditRequest({ status: 'COMPLETED', paymentId: (await auditPayment()).id, orderId: null, terminalId: `${fixture}-done` })
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
      terminalId,
      venueId,
      socketId: 'fixture-socket',
      terminalPaymentAckVersion: 1,
      identityVerified: true,
      terminalPaymentProbeVersion: 1,
    }))
    await (terminalPaymentService as any).probeUnresolvedForTerminal(fixture, venueId, 'fixture-socket')
    const sondas = directEmit.mock.calls.filter(([event]) => event === 'terminal:payment_probe')
    expect(sondas.map(([, payload]) => payload.requestId)).toEqual([sinDesenlace.requestId])

    directEmit.mockClear()
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
      terminalId,
      venueId,
      socketId: 'fixture-socket',
      terminalPaymentAckVersion: 1,
      identityVerified: true, // APK viejo: sin capacidad de sonda ⇒ no se le pregunta, no hay liberación falsa
    }))
    await (terminalPaymentService as any).probeUnresolvedForTerminal(fixture, venueId, 'fixture-socket')
    expect(directEmit.mock.calls.filter(([event]) => event === 'terminal:payment_probe')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Codex, 11-sep (409 al cancelar, P1): cancelar la orden y admitir o registrar un cobro tienen que
// SERIALIZARSE en el mismo lock de la orden. Antes `cancelOrder` leía `paymentStatus`, consultaba la
// reserva y cancelaba en tres pasos sueltos: una admisión o un registro de dinero podía colarse entre
// la lectura y el UPDATE y la orden terminaba CANCELLED con un cobro vivo o ya pagada. Y la admisión
// de un cobro NUEVO no rechazaba una orden cancelada.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('cancelOrder y la admisión de un cobro comparten el lock de la orden', () => {
  const nuevaOrden = (extra: Record<string, unknown> = {}) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(100),
        ...extra,
      } as Prisma.OrderUncheckedCreateInput,
    })
  const esperar = (ms: number) => new Promise(r => setTimeout(r, ms))
  /** Espera a que Postgres muestre una sesión ESPERANDO un lock sobre "Order": así la prueba no depende del reloj. */
  async function esperarBloqueoEnOrder() {
    for (let i = 0; i < 200; i++) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%"Order"%'`
      if (n > 0) return
      await esperar(25)
    }
    throw new Error('Nadie quedó esperando el lock de la orden')
  }
  /** Una transacción que TOMA el lock de la orden y sólo termina su trabajo cuando se le suelta: una admisión o un registro de dinero a medio camino. */
  function retenerOrden(id: string, dentro: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let soltar!: () => void
    const liberar = new Promise<void>(r => (soltar = r))
    let avisarTomado!: () => void
    const lockTomado = new Promise<void>(r => (avisarTomado = r))
    const tx = prisma.$transaction(
      async t => {
        await t.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`
        avisarTomado()
        await liberar
        await dentro(t)
      },
      { timeout: 20_000, maxWait: 10_000 },
    )
    return { lockTomado, soltar: () => soltar(), tx }
  }

  it('a NEW charge is never admitted on a cancelled order: only its tombstone is written and nothing is emitted', async () => {
    const orden = await nuevaOrden({ status: 'CANCELLED' })
    const terminalId = `${fixture}-orden-cancelada`
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((id: string) => ({ terminalId: id, venueId, socketId: 'fixture-socket', terminalPaymentAckVersion: 1 }))
    const requestId = nextRequest()
    // Con código y `requestId`: el POS puede probar que ESTE cobro no se creó y soltar su llave (no es un 400 ambiguo).
    await expect(
      terminalPaymentService.sendPaymentToTerminal({ requestId, venueId, terminalId, amountCents: 10000, requestedBy: fixture, orderId: orden.id }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'ORDER_CANCELLED_NO_NEW_CHARGE', details: { requestId } })
    // Ninguna fila de cobro: sólo la LÁPIDA que prueba el «no se creó» (FAILED, fuera de la ranura y del bloqueo de la orden).
    const filas = await prisma.terminalPaymentRequest.findMany({ where: { venueId, requestId } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_ORDER_CANCELLED', orderId: orden.id })
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('cancelOrder waits for an in-progress admission and then refuses: the order never ends CANCELLED under a live charge', async () => {
    const orden = await nuevaOrden()
    const admision = retenerOrden(orden.id, t =>
      t.terminalPaymentRequest.create({
        data: { requestId: nextRequest(), venueId, terminalId: `${fixture}-admision`, orderId: orden.id, amountCents: 10000, status: 'PENDING', expiresAt: new Date(Date.now() + 60_000), deliveryProvenance: { deliveries: [] } },
      }),
    )
    await admision.lockTomado
    let resuelta = false
    const cancelacion = cancelOrder(venueId, orden.id, 'prueba')
      .then(() => 'cancelada' as const, (e: unknown) => e)
      .finally(() => (resuelta = true))
    await esperarBloqueoEnOrder()
    expect(resuelta).toBe(false) // `cancelOrder` está esperando el lock, no terminó antes
    admision.soltar()
    await admision.tx
    const bloqueador = await prisma.terminalPaymentRequest.findFirstOrThrow({ where: { venueId, orderId: orden.id }, select: { requestId: true } })
    // Un código propio y el cobro que bloquea: sin eso la app no distingue este 409 de cualquier otro (contrato aditivo).
    expect(await cancelacion).toMatchObject({ statusCode: 409, code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE', details: { requestId: bloqueador.requestId } })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })).status).not.toBe('CANCELLED')
  })

  it('cancelOrder waits for an in-progress payment registration and then refuses a paid order', async () => {
    const orden = await nuevaOrden()
    const registro = retenerOrden(orden.id, t => t.order.update({ where: { id: orden.id }, data: { paymentStatus: 'PAID' } }))
    await registro.lockTomado
    let resuelta = false
    const cancelacion = cancelOrder(venueId, orden.id)
      .then(() => 'cancelada' as const, (e: unknown) => e)
      .finally(() => (resuelta = true))
    await esperarBloqueoEnOrder()
    expect(resuelta).toBe(false)
    registro.soltar()
    await registro.tx
    expect(await cancelacion).toMatchObject({ statusCode: 400 })
    const final = await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })
    expect(final.status).not.toBe('CANCELLED')
    expect(final.paymentStatus).toBe('PAID')
  })

  it('an admission that arrives while a cancellation holds the order lock waits, then refuses: no charge row (only its tombstone), nothing emitted', async () => {
    const orden = await nuevaOrden()
    const terminalId = `${fixture}-inversa`
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((id: string) => ({ terminalId: id, venueId, socketId: 'fixture-socket', terminalPaymentAckVersion: 1 }))
    const cancelando = retenerOrden(orden.id, t => t.order.update({ where: { id: orden.id }, data: { status: 'CANCELLED' } }))
    await cancelando.lockTomado
    const requestId = nextRequest()
    let resuelta = false
    const admision = terminalPaymentService
      .sendPaymentToTerminal({ requestId, venueId, terminalId, amountCents: 10000, requestedBy: fixture, orderId: orden.id })
      .then(v => v, (e: unknown) => e)
      .finally(() => (resuelta = true))
    await esperarBloqueoEnOrder()
    expect(resuelta).toBe(false) // la admisión espera el lock de la orden
    cancelando.soltar()
    await cancelando.tx
    expect(await admision).toMatchObject({ statusCode: 400, code: 'ORDER_CANCELLED_NO_NEW_CHARGE' })
    const filas = await prisma.terminalPaymentRequest.findMany({ where: { venueId, requestId } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_ORDER_CANCELLED' })
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('control: with nothing blocking, cancelOrder cancels the order', async () => {
    const orden = await nuevaOrden()
    await cancelOrder(venueId, orden.id, 'prueba')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })).status).toBe('CANCELLED')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// H.5/H.6 (11-sep): TODO rechazo de la admisión que el POS puede leer como «este cobro no se creó» se decide BAJO el
// candado de la terminal y deja una fila LÁPIDA para ese requestId, en la misma transacción. Sin ella, una copia
// posterior del MISMO POST (reintento de transporte, duplicado, entrega tardía de un proxy) encontraba «no hay fila» y,
// con la terminal ya libre o conectada, creaba y entregaba el cobro que la tablet ya había dado por no enviado: la
// tablet soltaba su llave, el cajero cobraba de otra forma y la terminal cobraba también — cobro doble.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('Lápida de admisión: todo «no se creó» deja fila y la misma solicitud repite el mismo rechazo', () => {
  const terminalDe = (sufijo: string) => `${fixture}-lapida-${sufijo}`
  const conectada = (id: string) => ({ terminalId: id, venueId, socketId: 'fixture-socket', terminalPaymentAckVersion: 1 })
  const nuevaOrden = (extra: Record<string, unknown> = {}) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(100),
        ...extra,
      } as Prisma.OrderUncheckedCreateInput,
    })
  /** El resultado o el error: un rechazo no puede tumbar la prueba antes de revisar TODO lo que pasó (sobre todo el emit). */
  const enviar = (envio: Parameters<typeof terminalPaymentService.sendPaymentToTerminal>[0]): Promise<unknown> =>
    terminalPaymentService.sendPaymentToTerminal(envio).then(
      v => v,
      (e: unknown) => e,
    )
  const filasDe = (requestId: string) => prisma.terminalPaymentRequest.findMany({ where: { venueId, requestId } })
  /** El cobro que ocupaba se resuelve con evidencia: ya no retiene la terminal ni la orden. */
  /**
   * Cierra una fila como la cierra `closeRow`: FAILED + `TPV_CONFIRMED_NO_CHARGE` **con la evidencia dentro del
   * sobre**. Sin ese sobre el estado es IMPOSIBLE en producción (`closeRow` degrada a `timeout` cualquier
   * failed/cancelled sin evidencia) y, con la lista blanca de §8 C.1, esa fila sigue bloqueando la terminal — que
   * es exactamente lo correcto: un «no cobré» sin evidencia no acredita nada.
   */
  const resolver = (id: string) =>
    prisma.terminalPaymentRequest.update({
      where: { id },
      data: {
        status: 'FAILED',
        failureCode: 'TPV_CONFIRMED_NO_CHARGE',
        resultJson: { status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'Rechazada por el banco' },
      },
    })

  /** Una transacción que TOMA el candado de admisión de esa terminal (el mismo `pg_advisory_xact_lock` del servicio) y lo suelta cuando se le pide. */
  function retenerCandado(clave: string) {
    let soltar!: () => void
    const liberado = new Promise<void>(r => (soltar = r))
    let avisarTomado!: () => void
    const tomado = new Promise<void>(r => (avisarTomado = r))
    const tx = prisma.$transaction(
      async t => {
        await t.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${clave}, 0))::text`
        avisarTomado()
        await liberado
      },
      { timeout: 20_000, maxWait: 10_000 },
    )
    return { tomado, soltar: () => soltar(), tx }
  }
  /** Espera a que haya `n` sesiones FORMADAS en ese candado exacto (pg_locks por la llave, no por el texto): sin relojes. */
  async function esperarFormados(clave: string, n: number) {
    for (let i = 0; i < 400; i++) {
      const [{ formados }] = await prisma.$queryRaw<Array<{ formados: number }>>`
        WITH k AS (SELECT hashtextextended(${clave}, 0) AS v)
        SELECT count(*)::int AS formados
          FROM pg_locks l, k
         WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
           AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND l.classid::bigint = ((k.v >> 32) & 4294967295)
           AND l.objid::bigint = (k.v & 4294967295)`
      if (formados >= n) return
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`No se formaron ${n} sesiones en el candado de ${clave}`)
  }

  beforeEach(() => {
    // Si una copia se ADMITIERA por error, el ACK perdido la cierra rápido (UNKNOWN) en vez de colgar la prueba 5 min.
    directEmit.mockImplementation((_event: string, _payload: unknown, callback?: (error: Error) => void) =>
      callback?.(new Error('lost ACK')),
    )
  })

  it.each([
    {
      caso: 'no está en el registro',
      entrada: 'ausente',
      httpStatus: 404,
      code: 'TERMINAL_NOT_CONNECTED',
      failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED',
    },
    {
      caso: 'está registrada sin socket',
      entrada: 'sin-socket',
      httpStatus: 422,
      code: 'TERMINAL_NO_SOCKET',
      failureCode: 'REJECTED_TERMINAL_NO_SOCKET',
    },
    {
      caso: 'es de otro establecimiento',
      entrada: 'otro-venue',
      httpStatus: 403,
      code: 'TERMINAL_NOT_IN_VENUE',
      failureCode: 'REJECTED_TERMINAL_OTHER_VENUE',
    },
  ])(
    '(a) terminal que $caso ⇒ $httpStatus $code con lápida; ya conectada, el MISMO requestId repite el rechazo sin crear ni emitir',
    async ({ entrada, httpStatus, code, failureCode }) => {
      // Forma de producción (prefijo y mayúsculas): la lápida guarda la llave NORMALIZADA, igual que toda fila.
      const terminalId = `AVQD-${terminalDe(`caida-${httpStatus}`).toUpperCase()}`
      ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((id: string) =>
        entrada === 'ausente'
          ? null
          : entrada === 'sin-socket'
            ? { ...conectada(id), socketId: null }
            : { ...conectada(id), venueId: `${fixture}-otro-venue` },
      )
      const requestId = nextRequest()
      const envio = {
        requestId,
        venueId,
        terminalId,
        amountCents: 10000,
        tipCents: 500,
        requestedBy: fixture,
        senderDeviceName: 'Sunmi D3',
      }
      const primero = await enviar(envio)
      // La terminal vuelve conectada, de este venue y libre: sin lápida, esta copia tardía se admitiría y se cobraría.
      ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation(conectada)
      const segundo = await enviar(envio)

      expect(directEmit).not.toHaveBeenCalled()
      const filas = await filasDe(requestId)
      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({
        status: 'FAILED',
        failureCode,
        terminalId: normalizeTerminalId(terminalId),
        amountCents: 10000,
        tipCents: 500,
        orderId: null,
        requestedById: fixture,
        senderDevice: 'Sunmi D3',
        deliveryAttempts: 0,
        acknowledgedAt: null,
        lastDeliveredAt: null,
        deliveryProvenance: { deliveries: [] },
      })
      expect(filas[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now())
      expect(primero).toMatchObject({ statusCode: httpStatus, code, details: { requestId } })
      expect(filas[0].resultJson).toMatchObject({ httpStatus, code, message: (primero as Error).message, details: { requestId } })
      expect(segundo).toBeInstanceOf((primero as object).constructor)
      expect(segundo).toMatchObject({ statusCode: httpStatus, code, message: (primero as Error).message, details: { requestId } })
    },
  )

  it('(b) ranura ocupada por A ⇒ 409 con blockingRequest y lápida; A se resuelve; el MISMO requestId repite el 409 sin crear ni emitir', async () => {
    const terminalId = terminalDe('ocupada')
    const a = await auditRequest({
      terminalId,
      orderId: null,
      status: 'UNKNOWN',
      amountCents: 35000,
      senderDevice: 'iPad Caja 1',
      createdAt: new Date(Date.now() - 120_000),
    })
    const requestId = nextRequest()
    const envio = { requestId, venueId, terminalId, amountCents: 10000, requestedBy: fixture }
    const primero = await enviar(envio)
    await resolver(a.id)
    expect(await terminalPaymentService.getBusyTerminalIds(venueId, [terminalId])).not.toContain(terminalId) // la terminal ya está libre
    const segundo = await enviar(envio)

    expect(directEmit).not.toHaveBeenCalled()
    const filas = await filasDe(requestId)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      status: 'FAILED',
      failureCode: 'REJECTED_TERMINAL_BUSY',
      terminalId,
      deliveryProvenance: { deliveries: [] },
    })
    expect(primero).toBeInstanceOf(TerminalBusyError)
    expect(primero).toMatchObject({
      statusCode: 409,
      code: 'TERMINAL_BUSY',
      details: { requestId, blockingRequest: { requestId: a.requestId, amountCents: 35000, senderDevice: 'iPad Caja 1' } },
    })
    // IDÉNTICO (mensaje y bloqueador guardados), aunque A ya no ocupe la terminal.
    expect(segundo).toBeInstanceOf(TerminalBusyError)
    expect((segundo as Error).message).toBe((primero as Error).message)
    expect((segundo as TerminalBusyError).details).toEqual((primero as TerminalBusyError).details)
  })

  it('(c) bloqueador de la orden ⇒ 409 con blockingRequest y lápida; se resuelve; el MISMO requestId repite el 409 sin crear ni emitir', async () => {
    const orden = await nuevaOrden()
    const a = await auditRequest({ terminalId: terminalDe('orden-otra'), orderId: orden.id, status: 'UNKNOWN' })
    const terminalId = terminalDe('orden-libre')
    const requestId = nextRequest()
    const envio = { requestId, venueId, terminalId, orderId: orden.id, amountCents: 10000, requestedBy: fixture }
    const primero = await enviar(envio)
    await resolver(a.id)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orden.id)).toBe(false) // ni A ni la lápida bloquean ya la orden
    const segundo = await enviar(envio)

    expect(directEmit).not.toHaveBeenCalled()
    const filas = await filasDe(requestId)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_ORDER_BUSY', orderId: orden.id, terminalId })
    expect(primero).toBeInstanceOf(TerminalBusyError)
    expect(primero).toMatchObject({
      statusCode: 409,
      code: 'TERMINAL_BUSY',
      details: { requestId, blockingRequest: { requestId: a.requestId } },
    })
    expect(segundo).toBeInstanceOf(TerminalBusyError)
    expect((segundo as Error).message).toBe((primero as Error).message)
    expect((segundo as TerminalBusyError).details).toEqual((primero as TerminalBusyError).details)
  })

  it.each([
    {
      caso: 'cancelada',
      crear: { status: 'CANCELLED' },
      reabrir: { status: 'PENDING' },
      clase: BadRequestError,
      httpStatus: 400,
      code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
      failureCode: 'REJECTED_ORDER_CANCELLED',
    },
    {
      caso: 'ya pagada',
      crear: { paymentStatus: 'PAID' },
      reabrir: { paymentStatus: 'PENDING' },
      clase: OrderAlreadyPaidError,
      httpStatus: 409,
      code: 'ORDER_ALREADY_PAID',
      failureCode: 'REJECTED_ORDER_PAID',
    },
  ])(
    '(d) orden $caso ⇒ $httpStatus $code con lápida; aunque la orden cambie, el MISMO requestId repite el rechazo',
    async ({ crear, reabrir, clase, httpStatus, code, failureCode }) => {
      const orden = await nuevaOrden(crear)
      const terminalId = terminalDe(`orden-${failureCode.toLowerCase()}`)
      const requestId = nextRequest()
      const envio = { requestId, venueId, terminalId, orderId: orden.id, amountCents: 10000, requestedBy: fixture }
      const primero = await enviar(envio)
      // La orden vuelve a estar cobrable: sin lápida, la copia tardía se admitiría.
      await prisma.order.update({ where: { id: orden.id }, data: reabrir as Prisma.OrderUncheckedUpdateInput })
      const segundo = await enviar(envio)

      expect(directEmit).not.toHaveBeenCalled()
      const filas = await filasDe(requestId)
      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({ status: 'FAILED', failureCode, orderId: orden.id, terminalId })
      expect(primero).toBeInstanceOf(clase)
      expect(primero).toMatchObject({ statusCode: httpStatus, code, details: { requestId } })
      expect(segundo).toBeInstanceOf(clase)
      expect(segundo).toMatchObject({ statusCode: httpStatus, code, message: (primero as Error).message, details: { requestId } })
    },
  )

  it('(d) orden inexistente en el venue ⇒ 400 ORDER_NOT_FOUND con lápida; aunque la orden aparezca, el MISMO requestId repite el 400', async () => {
    const ordenId = `${fixture}-orden-${randomUUID().slice(0, 8)}`
    const terminalId = terminalDe('orden-ausente')
    const requestId = nextRequest()
    const envio = { requestId, venueId, terminalId, orderId: ordenId, amountCents: 10000, requestedBy: fixture }
    const primero = await enviar(envio)
    await nuevaOrden({ id: ordenId })
    const segundo = await enviar(envio)

    expect(directEmit).not.toHaveBeenCalled()
    const filas = await filasDe(requestId)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_ORDER_NOT_FOUND', orderId: ordenId })
    expect(primero).toBeInstanceOf(BadRequestError)
    expect(primero).toMatchObject({ statusCode: 400, code: 'ORDER_NOT_FOUND', details: { requestId } })
    expect(segundo).toBeInstanceOf(BadRequestError)
    expect(segundo).toMatchObject({ statusCode: 400, code: 'ORDER_NOT_FOUND', message: (primero as Error).message, details: { requestId } })
  })

  it('(e) dos copias concurrentes del MISMO requestId con la ranura ocupada, que se libera ENTRE sus decisiones: la segunda reproduce la lápida y nunca crea', async () => {
    const terminalId = terminalDe('carrera')
    const clave = normalizeTerminalId(terminalId)
    const a = await auditRequest({ terminalId: clave, orderId: null, status: 'UNKNOWN', amountCents: 20000 })
    const requestId = nextRequest()
    const envio = { requestId, venueId, terminalId, amountCents: 10000, requestedBy: fixture }

    // Fila del candado de la terminal, en este orden: [copia 1, retén, copia 2]. El retén es el hueco en que A se resuelve.
    const portero = retenerCandado(clave)
    await portero.tomado
    const copia1 = enviar(envio)
    await esperarFormados(clave, 1)
    const reten = retenerCandado(clave)
    await esperarFormados(clave, 2)
    let copia2Resuelta = false
    const copia2 = enviar(envio).finally(() => (copia2Resuelta = true))
    await esperarFormados(clave, 3)

    portero.soltar()
    await portero.tx
    const r1 = await copia1 // decidió con A ocupando la ranura
    await reten.tomado
    expect(copia2Resuelta).toBe(false) // la copia 2 sigue formada detrás del retén: todavía no decide
    await resolver(a.id) // A se resuelve ENTRE las dos decisiones
    reten.soltar()
    await reten.tx
    const r2 = await copia2

    expect(directEmit).not.toHaveBeenCalled()
    const filas = await filasDe(requestId)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_TERMINAL_BUSY' })
    expect(r1).toBeInstanceOf(TerminalBusyError)
    expect(r1).toMatchObject({ details: { requestId, blockingRequest: { requestId: a.requestId } } })
    expect(r2).toBeInstanceOf(TerminalBusyError)
    expect((r2 as Error).message).toBe((r1 as Error).message)
    expect((r2 as TerminalBusyError).details).toEqual((r1 as TerminalBusyError).details)
  })

  it('(f) la lápida no bloquea: un requestId NUEVO sobre la misma terminal y la misma orden se admite y se entrega', async () => {
    const orden = await nuevaOrden()
    const terminalId = terminalDe('nueva')
    ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(null)
    const r1 = nextRequest()
    expect(await enviar({ requestId: r1, venueId, terminalId, orderId: orden.id, amountCents: 10000, requestedBy: fixture })).toMatchObject(
      {
        code: 'TERMINAL_NOT_CONNECTED',
      },
    )
    expect(await filasDe(r1)).toEqual([expect.objectContaining({ status: 'FAILED', failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED' })])
    // No ocupa la ranura ni bloquea la orden (FAILED no está en el índice parcial ni en UNRESOLVED_FINANCIAL_OUTCOME).
    expect(await terminalPaymentService.getBusyTerminalIds(venueId, [terminalId])).not.toContain(terminalId)
    expect(await terminalPaymentService.isTerminalBusy(terminalId, venueId)).toBe(false)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orden.id)).toBe(false)
    // Ni el vigía, ni la sonda (aun a una terminal verificada que la declara), ni el replay la tocan ni le emiten nada.
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((id: string) => ({
      ...conectada(id),
      identityVerified: true,
      terminalPaymentProbeVersion: 1,
    }))
    await terminalPaymentService.reconcileStaleRequests()
    await terminalPaymentService.reconcileUnknownRequests()
    expect(await terminalPaymentService.probeUnresolvedForTerminal(terminalId, venueId, 'fixture-socket')).toBe(0)
    await terminalPaymentService.replayPendingForTerminal(terminalId, venueId, 'fixture-socket')
    expect(directEmit).not.toHaveBeenCalled()
    expect(await filasDe(r1)).toEqual([expect.objectContaining({ status: 'FAILED', failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED' })])
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation(conectada)
    const r2 = nextRequest()
    const admitido = await enviar({ requestId: r2, venueId, terminalId, orderId: orden.id, amountCents: 10000, requestedBy: fixture })

    expect(directEmit).toHaveBeenCalledTimes(1)
    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({ requestId: r2, orderId: orden.id }),
      expect.any(Function),
    )
    // En esta prueba el ACK se pierde: el cobro queda PROTEGIDO (incierto), nunca negado.
    expect(admitido).toMatchObject({ requestId: r2, status: 'timeout' })
    const [fila2] = await filasDe(r2)
    expect(fila2).toMatchObject({ status: 'UNKNOWN', orderId: orden.id, terminalId })
  })

  it('(g) sin requestId del cliente no hay lápida: el rechazo sale con su código y no se escribe ninguna fila', async () => {
    const terminalId = terminalDe('sin-llave')
    ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(null)
    const desconectada = await enviar({ venueId, terminalId, amountCents: 10000, requestedBy: fixture })
    const orden = await nuevaOrden({ status: 'CANCELLED' })
    ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation(conectada)
    const cancelada = await enviar({ venueId, terminalId, orderId: orden.id, amountCents: 10000, requestedBy: fixture })

    expect(directEmit).not.toHaveBeenCalled()
    expect(await prisma.terminalPaymentRequest.count({ where: { venueId, terminalId } })).toBe(0)
    expect(desconectada).toMatchObject({ statusCode: 404, code: 'TERMINAL_NOT_CONNECTED' })
    expect(cancelada).toMatchObject({ statusCode: 400, code: 'ORDER_CANCELLED_NO_NEW_CHARGE' })
    // Sin lápida no se afirma un `requestId` correlacionado: nada durable lo respaldaría.
    expect((desconectada as { details?: { requestId?: string } }).details?.requestId).toBeUndefined()
    expect((cancelada as { details?: { requestId?: string } }).details?.requestId).toBeUndefined()
  })

  it('el GET devuelve la lápida como FAILED con su failureCode REJECTED_… (prueba que no se creó: no se traduce a UNKNOWN)', async () => {
    const terminalId = terminalDe('get')
    ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(null)
    const requestId = nextRequest()
    await enviar({ requestId, venueId, terminalId, amountCents: 12345, tipCents: 55, requestedBy: fixture })

    // Las apps POS publicadas sólo leen `status` y sueltan su llave con FAILED: la lápida las destraba sin actualizarlas.
    expect(await terminalPaymentService.getPaymentStatus(requestId, venueId)).toMatchObject({
      requestId,
      status: 'FAILED',
      failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED',
      paymentId: null,
      amount: 123.45,
      tip: 0.55,
    })
  })
})

/**
 * §8 C.1 / I.3 — EQUIVALENCIA entre el predicado de BLOQUEO (SQL, vía Prisma) y el desenlace canónico (TypeScript).
 *
 * 🔴 Por qué contra Postgres REAL y no con un intérprete del `WhereInput`: la divergencia peligrosa no está en la
 * lógica sino en la LÓGICA TRIVALUADA de SQL. Medido el 11-sep contra esta misma base: `NOT { failureCode:
 * { startsWith } }` y `{ failureCode: { notIn: [...] } }` DEJAN FUERA las filas con `failureCode` NULL (el predicado
 * es NULL, no TRUE), y `NOT` alrededor de un filtro de ruta JSON ni siquiera compila en Prisma. Un intérprete escrito
 * por mí habría «probado» la equivalencia de un predicado que en la base se comporta distinto.
 *
 * Recorre el producto cartesiano completo de (status × failureCode × cancelDisposition × resultJson × paymentId) y
 * exige que el conjunto que devuelve la base sea EXACTAMENTE el que la función clasifica UNRESOLVED.
 */
describe('el predicado de bloqueo y el desenlace canónico no pueden divergir', () => {
  const venueTabla = `${fixture}-tabla`
  const ESTADOS = Object.values(TerminalPaymentRequestStatus)
  const CODIGOS = [
    null,
    'ACK_TIMEOUT',
    'ACK_REJECTED',
    'TPV_ERROR',
    'SOCKET_NOT_FOUND',
    'DELIVERY_NOT_RECORDED',
    'TIMED_OUT',
    'AUTO_RELEASED',
    'MANUAL_RELEASE',
    'MANUAL_RECONCILE',
    'CONTRACT_MISMATCH',
    'QA_MANUAL_RESOLVE_NO_MONEY',
    'CODIGO_DESCONOCIDO',
    'TPV_CONFIRMED_NO_CHARGE',
    'TPV_NEVER_RECEIVED',
    'TPV_INBOX_NOT_FOUND',
    'OPERATOR_RECONCILED_NO_CHARGE',
    'REJECTED_TERMINAL_BUSY',
  ]
  const DISPOSICIONES = [null, 'ACTIVE', 'ACCEPTED', 'ALREADY_RESOLVED']
  const SOBRES = [null, {}, { outcomeEvidence: 'PROCESSOR_DECLINED' }, { outcomeEvidence: 'PRE_AUTHORIZATION' }, { outcomeEvidence: 'OTRA' }]

  type FilaTabla = {
    requestId: string
    terminalId: string
    status: TerminalPaymentRequestStatus
    failureCode: string | null
    cancelDisposition: string | null
    resultJson: unknown
    paymentId: string | null
  }

  const universo: FilaTabla[] = []
  let n = 0
  for (const status of ESTADOS)
    for (const failureCode of CODIGOS)
      for (const cancelDisposition of DISPOSICIONES)
        for (const resultJson of SOBRES)
          for (const paymentId of [null, 'pay-tabla']) {
            n += 1
            universo.push({
              // El índice parcial ÚNICO de la ranura es por terminal: cada fila necesita la suya.
              requestId: `tabla-${n}`,
              terminalId: `tabla-t${n}`,
              status,
              failureCode,
              cancelDisposition,
              resultJson,
              paymentId,
            })
          }

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: venueTabla, name: venueTabla, email: `${venueTabla}@example.test`, phone: '5500000001' } })
    await prisma.venue.create({ data: { id: venueTabla, organizationId: venueTabla, name: venueTabla, slug: venueTabla } })
    const expiresAt = new Date(Date.now() + 3_600_000)
    for (let i = 0; i < universo.length; i += 500) {
      await prisma.terminalPaymentRequest.createMany({
        data: universo.slice(i, i + 500).map(f => ({
          requestId: f.requestId,
          venueId: venueTabla,
          terminalId: f.terminalId,
          status: f.status,
          amountCents: 100,
          failureCode: f.failureCode,
          cancelDisposition: f.cancelDisposition,
          paymentId: f.paymentId,
          resultJson: f.resultJson === null ? Prisma.DbNull : (f.resultJson as Prisma.InputJsonValue),
          expiresAt,
        })),
      })
    }
  })

  afterAll(async () => {
    await prisma.terminalPaymentRequest.deleteMany({ where: { venueId: venueTabla } })
    await prisma.venue.deleteMany({ where: { id: venueTabla } })
    await prisma.organization.deleteMany({ where: { id: venueTabla } })
  })

  it(`🔴 la base bloquea EXACTAMENTE las filas que la función llama UNRESOLVED (${1} tabla completa)`, async () => {
    const bloqueadas = await prisma.terminalPaymentRequest.findMany({
      where: { venueId: venueTabla, ...UNRESOLVED_FINANCIAL_OUTCOME },
      select: { requestId: true },
    })
    const enSql = new Set(bloqueadas.map(r => r.requestId))
    const enFuncion = new Set(universo.filter(f => desenlaceCanonico(f as never).outcome === 'UNRESOLVED').map(f => f.requestId))

    const porFila = (id: string) => JSON.stringify(universo.find(f => f.requestId === id))
    const sqlDeMas = [...enSql].filter(id => !enFuncion.has(id)).map(porFila)
    const sqlDeMenos = [...enFuncion].filter(id => !enSql.has(id)).map(porFila)

    // 🔴 «De menos» es el lado que cuesta dinero: la base liberaría una terminal cuyo desenlace nadie acreditó.
    expect({ sqlDeMenos: sqlDeMenos.slice(0, 5), sqlDeMas: sqlDeMas.slice(0, 5) }).toEqual({ sqlDeMenos: [], sqlDeMas: [] })
    expect(enSql.size).toBe(enFuncion.size)
    expect(enSql.size).toBeGreaterThan(0)
  })

  it('P1 la sonda alcanza TODO lo que bloquea: nada retiene una terminal sin tener salida', async () => {
    const sondeables = await prisma.terminalPaymentRequest.findMany({
      where: { venueId: venueTabla, ...SIN_DESENLACE_ACREDITADO },
      select: { requestId: true, status: true, paymentId: true },
    })
    const bloqueadas = await prisma.terminalPaymentRequest.findMany({
      where: { venueId: venueTabla, ...UNRESOLVED_FINANCIAL_OUTCOME },
      select: { requestId: true, status: true },
    })
    const idsSondeables = new Set(sondeables.map(r => r.requestId))
    expect(sondeables.length).toBeGreaterThan(0)
    // Todo lo sondeable bloquea…
    expect(sondeables.filter(r => !new Set(bloqueadas.map(b => b.requestId)).has(r.requestId))).toEqual([])

    // 🔴 …y lo que bloquea SIN estar en vuelo tiene que ser sondeable (P1-4 de Codex, 11-sep). Antes se excluían
    // TODAS las COMPLETED «por ser dinero registrado», y una COMPLETED sin `Payment` no lo es: bloqueaba, la
    // sonda no le preguntaba nunca y la liberación manual sólo acepta UNKNOWN. Terminal muerta sin salida.
    const sinSalida = bloqueadas.filter(b => !['PENDING', 'SENT', 'CANCEL_REQUESTED'].includes(b.status) && !idsSondeables.has(b.requestId))
    expect(sinSalida).toEqual([])

    // Una fila EN VUELO la gobiernan el replay y el vigía, no la sonda.
    expect(sondeables.filter(r => ['PENDING', 'SENT', 'CANCEL_REQUESTED'].includes(r.status))).toEqual([])
    // Una COMPLETED **con** pago sí queda fuera: ésa es dinero registrado y no se reescribe.
    expect(sondeables.filter(r => r.status === 'COMPLETED' && r.paymentId)).toEqual([])
    // Y la COMPLETED **sin** pago tiene que estar dentro: es justo el caso que no tenía salida.
    expect(sondeables.filter(r => r.status === 'COMPLETED' && !r.paymentId).length).toBeGreaterThan(0)
  })

  it('🔴 ninguna LÁPIDA de admisión ocupa la terminal ni se sondea (rechazo probado ≠ desenlace pendiente)', async () => {
    const lapidas = universo.filter(f => f.status === 'FAILED' && (f.failureCode ?? '').startsWith('REJECTED_')).map(f => f.requestId)
    expect(lapidas.length).toBeGreaterThan(0)
    for (const where of [UNRESOLVED_FINANCIAL_OUTCOME, SIN_DESENLACE_ACREDITADO]) {
      const tocadas = await prisma.terminalPaymentRequest.findMany({
        where: { venueId: venueTabla, requestId: { in: lapidas }, ...where },
        select: { requestId: true },
      })
      expect(tocadas).toEqual([])
    }
  })
})
