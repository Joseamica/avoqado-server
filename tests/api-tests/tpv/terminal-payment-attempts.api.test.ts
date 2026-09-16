/*
  tests/api-tests/tpv/terminal-payment-attempts.api.test.ts

  S6 (checkpoint 1 del webhook): la capa HTTP de `GET /tpv/venues/:venueId/terminal-payment/attempts/:attemptId`,
  con el Express real y supertest. Lo que la ruta garantiza y que una prueba de servicio no puede demostrar:

    · sin token → 401; un token SIN identidad de terminal (dashboard/POS) → 403: la consulta es de la TERMINAL, no del rol;
    · el venue de la URL tiene que ser el del token (403);
    · un intento que el servidor no conoce, o que no es de esta terminal, es 404 con `outcome: NO_EVIDENCE`, y el cuerpo
      NUNCA dice «no cobrado» — es la misma regla que el GET 404 del POS: sin evidencia no hay veredicto;
    · con la terminal dueña, 200 con el intento y la solicitud por separado.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

import jwt from 'jsonwebtoken'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

const app = require('../../../src/app').default

const venueId = 'clvenueattempt00000000001'
const otroVenue = 'clvenueattempt00000000002'
const serial = 'AVQD-N86ABCDEF12'
const attemptId = 'intento-a'
const requestId = 'solicitud-1'
const RUTA = `/api/v1/tpv/venues/${venueId}/terminal-payment/attempts/${attemptId}`

function token(extra: Record<string, unknown> = {}, tokenVenueId = venueId) {
  return jwt.sign(
    { sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role: 'CASHIER', ...extra },
    process.env.ACCESS_TOKEN_SECRET as string,
    {
      expiresIn: '15m',
    },
  )
}

function filaDeSolicitud(over: Record<string, unknown> = {}) {
  const ahora = new Date()
  return {
    id: 'row-1',
    requestId,
    venueId,
    terminalId: 'n86abcdef12',
    orderId: null,
    amountCents: 10000,
    tipCents: 0,
    status: 'COMPLETED',
    paymentId: 'pago-a',
    closedVia: 'webhook',
    failureCode: null,
    cancelDisposition: null,
    resultJson: null,
    senderDevice: null,
    lateResult: false,
    createdAt: ahora,
    updatedAt: ahora,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.payment.findUnique.mockResolvedValue(null)
  // Codex R4 (P2): S6 resuelve la evidencia del procesador en UNA consulta SQL (contradicciones, último approved propio,
  // último veredicto propio); sin eventos, la terna vacía.
  prismaMock.$queryRaw.mockResolvedValue([{ contradicciones: 0, aprobadoAt: null, veredictoAt: null }] as never)
})

describe('GET /tpv/venues/:venueId/terminal-payment/attempts/:attemptId', () => {
  it('401 sin token', async () => {
    expect((await request(app).get(RUTA)).status).toBe(401)
  })

  it('403 con un token sin identidad de terminal: la consulta es de la terminal, no del rol', async () => {
    const res = await request(app).get(RUTA).set('Authorization', `Bearer ${token()}`)
    expect(res.status).toBe(403)
    expect(res.body.status).toBe('TERMINAL_IDENTITY_REQUIRED')
    expect(prismaMock.terminalPaymentAttemptLink.findUnique).not.toHaveBeenCalled()
  })

  it('403 si el venue de la URL no es el del token', async () => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${token({ terminalSerialNumber: serial }, otroVenue)}`)
    expect(res.status).toBe(403)
    expect(prismaMock.terminalPaymentAttemptLink.findUnique).not.toHaveBeenCalled()
  })

  it('404 NO_EVIDENCE para un intento que el servidor no conoce — y el cuerpo nunca dice «no cobrado»', async () => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${token({ terminalSerialNumber: serial })}`)
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ success: false, status: 'ATTEMPT_NOT_FOUND', outcome: 'NO_EVIDENCE' })
    expect(JSON.stringify(res.body)).not.toContain('NOT_CHARGED')
  })

  it('404 NO_EVIDENCE para un intento de OTRA terminal, indistinguible del desconocido', async () => {
    prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue({
      requestId,
      venueId,
      terminalId: 'otra-terminal',
      createdAt: new Date(),
    } as never)
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${token({ terminalSerialNumber: serial })}`)
    expect(res.status).toBe(404)
    expect(res.body.outcome).toBe('NO_EVIDENCE')
  })

  it('200 con la terminal dueña: el intento y la solicitud, por separado', async () => {
    prismaMock.terminalPaymentAttemptLink.findUnique.mockImplementation(async ({ where }: any) =>
      where.attemptId === attemptId ? ({ requestId, venueId, terminalId: 'n86abcdef12', createdAt: new Date() } as never) : null,
    )
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaDeSolicitud() as never)
    prismaMock.payment.findFirst.mockResolvedValue({
      id: 'pago-a',
      status: 'COMPLETED',
      type: 'REGULAR',
      amount: '100',
      tipAmount: '0',
      idempotencyKey: attemptId,
      terminalPaymentRequestId: requestId,
      processorData: { registradoVia: 'webhook' },
    } as never)
    prismaMock.payment.findUnique.mockResolvedValue({ id: 'pago-a', idempotencyKey: attemptId } as never)

    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${token({ terminalSerialNumber: serial })}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.attempt).toMatchObject({ attemptId, outcome: 'RECORDED', paymentId: 'pago-a', recordedVia: 'webhook', isWinner: true })
    expect(res.body.request).toMatchObject({
      requestId,
      status: 'COMPLETED',
      outcome: 'CHARGED',
      closedVia: 'webhook',
      winnerAttemptId: attemptId,
    })
  })
})
