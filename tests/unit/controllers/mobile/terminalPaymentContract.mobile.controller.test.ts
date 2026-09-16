/**
 * §8 C.1/C.2 — la FORMA HTTP del contrato del desenlace. No existía ninguna prueba de controlador para el GET de
 * estado ni para el POST de cancelación, y son los dos únicos sitios por los que el POS pregunta «¿se cobró?».
 *
 * Lo que fijan estas pruebas es el CONTRATO, no la clasificación (ésa vive en `terminalPaymentDesenlace.test.ts`):
 * que los campos nuevos salgan, que los viejos NO cambien —las apps publicadas sólo leen `status`, `inProgress`,
 * `paymentId` y `cancelDisposition`—, y que el 200 de siempre se conserve.
 */

import type { Request, Response } from 'express'

import { cancelTerminalPayment, getTerminalPaymentStatus } from '@/controllers/mobile/terminal-payment.mobile.controller'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { ConflictError } from '@/errors/AppError'

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: { getPaymentStatus: jest.fn(), cancelPayment: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({ terminalRegistry: { getTerminal: jest.fn() } }))

const getPaymentStatusMock = terminalPaymentService.getPaymentStatus as jest.Mock
const cancelPaymentMock = terminalPaymentService.cancelPayment as jest.Mock
const getTerminalMock = terminalRegistry.getTerminal as jest.Mock

const venueId = 'venue-1'
const requestId = 'REQ-1'

function buildRes() {
  const res = {} as Response & { statusCode: number; payload: any }
  res.statusCode = 200
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code
    return res
  }) as unknown as (typeof res)['status']
  res.json = jest.fn().mockImplementation((body: unknown) => {
    res.payload = body
    return res
  }) as unknown as (typeof res)['json']
  return res
}

function estado(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    venueId,
    terminalId: 'term-1',
    status: 'UNKNOWN',
    amount: 123.45,
    tip: 0.55,
    orderId: null,
    paymentId: null,
    senderDevice: 'tablet',
    lateResult: false,
    cancelDisposition: null,
    failureCode: 'TPV_ERROR',
    outcome: 'UNRESOLVED',
    outcomeEvidence: null,
    evidenceClass: null,
    createdAt: '2026-09-11T10:00:00.000Z',
    updatedAt: '2026-09-11T10:05:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  getTerminalMock.mockReturnValue({ terminalId: 'term-1', venueId, socketId: 'sock-1' })
})

describe('GET /terminal-payment/:requestId — aditivo', () => {
  it('devuelve los campos nuevos SIN tocar los que ya leían las apps publicadas', async () => {
    getPaymentStatusMock.mockResolvedValue(
      estado({
        status: 'COMPLETED',
        paymentId: 'pay-1',
        failureCode: null,
        outcome: 'CHARGED',
        outcomeEvidence: 'PAYMENT_RECORDED',
        evidenceClass: 'TERMINAL',
      }),
    )
    const res = buildRes()
    await getTerminalPaymentStatus({ params: { venueId, requestId } } as unknown as Request, res)

    expect(res.statusCode).toBe(200)
    // Lo de siempre.
    expect(res.payload).toMatchObject({
      success: true,
      inProgress: false,
      status: 'COMPLETED',
      paymentId: 'pay-1',
      cancelDisposition: null,
    })
    // Lo nuevo.
    expect(res.payload).toMatchObject({
      outcome: 'CHARGED',
      outcomeEvidence: 'PAYMENT_RECORDED',
      evidenceClass: 'TERMINAL',
      failureCode: null,
    })
  })

  it('🔴 `inProgress` se calcula sobre el status YA traducido: una FAILED sin evidencia sale UNKNOWN y NO en curso', async () => {
    getPaymentStatusMock.mockResolvedValue(estado({ status: 'UNKNOWN', outcome: 'UNRESOLVED', failureCode: 'TPV_ERROR' }))
    const res = buildRes()
    await getTerminalPaymentStatus({ params: { venueId, requestId } } as unknown as Request, res)
    expect(res.payload).toMatchObject({ inProgress: false, status: 'UNKNOWN', outcome: 'UNRESOLVED', failureCode: 'TPV_ERROR' })
  })

  it('un cobro en vuelo sigue diciendo inProgress true', async () => {
    getPaymentStatusMock.mockResolvedValue(estado({ status: 'CANCEL_REQUESTED' }))
    const res = buildRes()
    await getTerminalPaymentStatus({ params: { venueId, requestId } } as unknown as Request, res)
    expect(res.payload).toMatchObject({ inProgress: true, status: 'CANCEL_REQUESTED', outcome: 'UNRESOLVED' })
  })

  it('una solicitud que no existe sigue siendo 404 NOT_FOUND (no es permiso para volver a cobrar)', async () => {
    getPaymentStatusMock.mockResolvedValue(null)
    const res = buildRes()
    await getTerminalPaymentStatus({ params: { venueId, requestId } } as unknown as Request, res)
    expect(res.statusCode).toBe(404)
    expect(res.payload).toMatchObject({ success: false, status: 'NOT_FOUND' })
  })
})

describe('POST /terminal-payment/cancel — estado durable (§8 C.2)', () => {
  const reqCancel = () =>
    ({ params: { venueId }, body: { terminalId: 'term-1', requestId, reason: 'el cajero canceló' } }) as unknown as Request

  it('intención registrada Y emitida: `success` true como siempre, más el estado durable releído', async () => {
    const payment = estado({ status: 'CANCEL_REQUESTED', failureCode: null })
    cancelPaymentMock.mockResolvedValue({ cancelIntent: 'RECORDED', cancelEmitted: true, payment })
    const res = buildRes()
    await cancelTerminalPayment(reqCancel(), res)

    expect(res.statusCode).toBe(200)
    expect(res.payload).toMatchObject({
      success: true,
      message: 'Cancelación enviada a la terminal',
      requestId,
      cancelIntent: 'RECORDED',
      cancelEmitted: true,
      payment: { status: 'CANCEL_REQUESTED', outcome: 'UNRESOLVED' },
    })
  })

  it('🔴 terminal apagada: la intención SÍ quedó guardada, y ahora se puede distinguir (antes era un `false` mudo)', async () => {
    cancelPaymentMock.mockResolvedValue({
      cancelIntent: 'RECORDED',
      cancelEmitted: false,
      payment: estado({ status: 'CANCEL_REQUESTED', failureCode: null }),
    })
    const res = buildRes()
    await cancelTerminalPayment(reqCancel(), res)

    // `success` conserva su significado de siempre (registrada Y emitida) para no romper a las apps publicadas…
    expect(res.payload.success).toBe(false)
    // …pero el cuerpo ya dice que la cancelación no se perdió.
    expect(res.payload).toMatchObject({ cancelIntent: 'RECORDED', cancelEmitted: false })
    expect(res.payload.message).toMatch(/guardada/i)
  })

  it('el cobro ya tenía desenlace: ALREADY_FINAL con el desenlace adentro, y 200 como siempre', async () => {
    cancelPaymentMock.mockResolvedValue({
      cancelIntent: 'ALREADY_FINAL',
      cancelEmitted: false,
      payment: estado({
        status: 'COMPLETED',
        paymentId: 'pay-1',
        outcome: 'CHARGED',
        outcomeEvidence: 'PAYMENT_RECORDED',
        failureCode: null,
      }),
    })
    const res = buildRes()
    await cancelTerminalPayment(reqCancel(), res)

    expect(res.statusCode).toBe(200)
    expect(res.payload).toMatchObject({
      success: false,
      cancelIntent: 'ALREADY_FINAL',
      payment: { outcome: 'CHARGED', paymentId: 'pay-1' },
    })
  })

  it('no existe esa solicitud: NOT_FOUND con payment null (ya no se dice «Terminal no conectada»)', async () => {
    cancelPaymentMock.mockResolvedValue({ cancelIntent: 'NOT_FOUND', cancelEmitted: false, payment: null })
    const res = buildRes()
    await cancelTerminalPayment(reqCancel(), res)
    expect(res.payload).toMatchObject({ success: false, cancelIntent: 'NOT_FOUND', payment: null })
    expect(res.payload.message).not.toMatch(/no conectada/i)
  })

  it('sin requestId no se cancela un cobro cualquiera, y se dice por qué', async () => {
    cancelPaymentMock.mockResolvedValue({ cancelIntent: 'MISSING_REQUEST_ID', cancelEmitted: false, payment: null })
    const res = buildRes()
    await cancelTerminalPayment({ params: { venueId }, body: { terminalId: 'term-1' } } as unknown as Request, res)
    expect(res.payload).toMatchObject({ success: false, cancelIntent: 'MISSING_REQUEST_ID', payment: null })
    expect(res.payload).not.toHaveProperty('requestId')
  })

  it('falta terminalId ⇒ 400 como siempre', async () => {
    const res = buildRes()
    await cancelTerminalPayment({ params: { venueId }, body: {} } as unknown as Request, res)
    expect(res.statusCode).toBe(400)
    expect(cancelPaymentMock).not.toHaveBeenCalled()
  })

  it('una terminal de otro establecimiento sigue siendo 403 y no llega al servicio', async () => {
    getTerminalMock.mockReturnValue({ terminalId: 'term-1', venueId: 'venue-otro', socketId: 'sock-1' })
    const res = buildRes()
    await cancelTerminalPayment(reqCancel(), res)
    expect(res.statusCode).toBe(403)
    expect(cancelPaymentMock).not.toHaveBeenCalled()
  })

  it('🔴 P2-14: un error TIPADO conserva su código, sus detalles y su estado HTTP (antes: 500 genérico)', async () => {
    cancelPaymentMock.mockRejectedValue(
      new ConflictError('La orden tiene un cobro vivo', 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE', { requestId }),
    )
    const res = buildRes()
    await cancelTerminalPayment(reqCancel(), res)

    expect(res.statusCode).toBe(409)
    expect(res.payload).toMatchObject({
      success: false,
      code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE',
      details: { requestId },
      message: 'La orden tiene un cobro vivo',
    })
  })

  it('un error NO tipado sigue siendo un 500 genérico, sin filtrar el mensaje interno', async () => {
    cancelPaymentMock.mockRejectedValue(new Error('connection terminated unexpectedly'))
    const res = buildRes()
    await cancelTerminalPayment(reqCancel(), res)
    expect(res.statusCode).toBe(500)
    expect(res.payload).toEqual({ success: false, message: 'Error interno del servidor' })
  })
})
