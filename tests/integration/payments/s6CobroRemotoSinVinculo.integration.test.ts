/*
  tests/integration/payments/s6CobroRemotoSinVinculo.integration.test.ts

  QA físico 14-oct-2026 (PAX A910S): el camino de cobro de la PAX/Blumon NO emite `terminal:payment_attempt_opened`, así
  que su cobro REMOTO (solicitud del POS) nunca tiene vínculo — en producción, 0 vínculos en 8 cobros remotos de PAX en 30
  días. Su Payment sí trae la solicitud, y S6 sólo acreditaba un Payment sin vínculo si NO traía solicitud: tras reiniciar
  la app, la PAX recibía `paymentContradiction` y pintaba «posible cobro doble» sobre un cobro sano.

  🔴 Lo que fija esta suite: sin vínculo, el Payment de una solicitud ASIGNADA a esta terminal y cobrado por esta terminal
  es propio. Todo lo demás —solicitud de otra terminal, serial de otra terminal, referencias que no coinciden— sigue siendo
  contradicción.
*/
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { crearFixture, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn(() => null), emitDurableTerminalPaymentResult: jest.fn() },
}))

let f: Fixture
beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('s6pax')
})
afterEach(() => f.limpiar())
afterAll(() => f.destruir())

const consultar = (attemptId: string) =>
  terminalPaymentService.consultarIntentoDeTerminal({ attemptId, venueId: f.venueId, terminalSerial: f.serial })

/** Un Payment escrito a mano, para las formas que el REST no produce (referencias cruzadas). */
async function pagoDirecto(attemptId: string, datos: { columna?: string; huella?: string; conciliacion?: string; serial?: string }) {
  const orden = await f.nuevaVenta()
  return prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId: orden.id,
      amount: 100,
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      idempotencyKey: attemptId,
      terminalPaymentRequestId: datos.columna ?? null,
      processorData: {
        deviceSerialNumber: datos.serial ?? f.serial,
        ...(datos.huella ? { terminalPaymentRequestId: datos.huella } : {}),
        ...(datos.conciliacion ? { reconciliation: { kind: 'POSSIBLE_SECOND_CAPTURE', requestId: datos.conciliacion } } : {}),
      },
    },
  })
}

describe('S6 · cobro remoto SIN vínculo (PAX/Blumon)', () => {
  it('el cobro de una solicitud de ESTA terminal es propio: RECORDED, sin contradicción', async () => {
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }), f.staffId)
    expect(pago.terminalPaymentRequestId).toBe(solicitud.requestId)

    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({
      outcome: 'RECORDED',
      paymentId: pago.id,
      paymentContradiction: false,
      linkedAt: null,
      isWinner: true,
    })
    // La solicitud se publica como con vínculo: la TPV compara la suya y cierra su bandeja con el ganador.
    expect(estado!.requestId).toBe(solicitud.requestId)
    expect(estado!.request).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, winnerAttemptId: A })
  })

  it('un SEGUNDO cargo de esa misma solicitud se ve como segunda captura (con su ganador), no como contradicción', async () => {
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const B = randomUUID()
    const ganador = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }), f.staffId)
    const segunda = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: B, requestId: solicitud.requestId }), f.staffId)
    expect(segunda.status).toBe('PENDING')

    const estado = await consultar(B)
    expect(estado!.attempt).toMatchObject({
      outcome: 'SECOND_CAPTURE_EVIDENCE',
      paymentId: segunda.id,
      winnerPaymentId: ganador.id,
      paymentContradiction: false,
      isWinner: false,
    })
    // Sin vínculos, nombrar OTRO intento como ganador no está acreditado: se publica su Payment, no su intento.
    expect(estado!.request).toMatchObject({ paymentId: ganador.id, winnerAttemptId: null })
  })

  it('CONTRADICCIÓN · la solicitud es de OTRA terminal del mismo negocio', async () => {
    const ajena = await f.solicitud({ terminalId: 'otra-terminal' })
    const A = randomUUID()
    await pagoDirecto(A, { columna: ajena.requestId, huella: ajena.requestId })

    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentId: null, paymentContradiction: true })
  })

  it('CONTRADICCIÓN · la solicitud es de esta terminal, pero el serial del cobro es de OTRA', async () => {
    const solicitud = await f.solicitud()
    const A = randomUUID()
    await pagoDirecto(A, { columna: solicitud.requestId, serial: 'AVQD-OTRA' })

    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentContradiction: true })
  })

  it('CONTRADICCIÓN · la única referencia es la conciliación, y es de OTRA terminal (ya no entra por la rama del serial)', async () => {
    const ajena = await f.solicitud({ terminalId: 'otra-terminal' })
    const A = randomUUID()
    await pagoDirecto(A, { conciliacion: ajena.requestId })

    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentContradiction: true })
    expect(estado!.request).toBeNull()
  })

  it('CONTRADICCIÓN · la columna y la huella apuntan a solicitudes DISTINTAS', async () => {
    const propia = await f.solicitud({ status: 'COMPLETED' })
    const otra = await f.solicitud({ terminalId: 'otra-terminal' })
    const A = randomUUID()
    await pagoDirecto(A, { columna: propia.requestId, huella: otra.requestId })

    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentContradiction: true })
  })
})
