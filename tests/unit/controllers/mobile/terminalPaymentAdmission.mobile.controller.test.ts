/**
 * La forma HTTP de los rechazos de admisión del cobro POS → terminal (H.5/H.6, 11-sep).
 *
 * Cada rechazo que el servicio decide BAJO el candado deja una lápida para ese `requestId`, y la respuesta lleva
 * `code` + `details.requestId`: es lo que le permite al POS saber que ESE cobro no se creó (y que la misma solicitud
 * repetirá el mismo rechazo). Antes el 400 de «orden cancelada» perdía su código aquí, y «terminal no conectada» salía
 * como un 404 pelón. El contrato es ADITIVO: los campos que ya leían las apps publicadas (`status`, `message`,
 * `errorMessage`, `blockingRequest` en la raíz) se conservan tal cual.
 */

import type { Request, Response } from 'express'

import { getTerminalPaymentStatus, sendTerminalPayment } from '@/controllers/mobile/terminal-payment.mobile.controller'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import {
  BadRequestError,
  OrderAlreadyPaidError,
  TerminalBusyError,
  TerminalPaymentAdmissionRetryError,
  TerminalUnavailableError,
} from '@/errors/AppError'

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: { sendPaymentToTerminal: jest.fn(), getPaymentStatus: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({
  terminalRegistry: { getTerminal: jest.fn() },
}))
jest.mock('@/utils/staff-venue.util', () => ({
  validateStaffVenue: jest.fn().mockResolvedValue('staff-1'),
}))

const sendPaymentToTerminalMock = terminalPaymentService.sendPaymentToTerminal as jest.Mock
const getPaymentStatusMock = terminalPaymentService.getPaymentStatus as jest.Mock
const getTerminalMock = terminalRegistry.getTerminal as jest.Mock

const venueId = 'venue-1'
const requestId = 'REQ-1'

function buildRes() {
  const res = {} as Response & { statusCode?: number; payload?: any }
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code
    return res
  }) as unknown as Response['status']
  res.json = jest.fn().mockImplementation((body: unknown) => {
    res.payload = body
    return res
  }) as unknown as Response['json']
  return res
}

function buildReq(body: Record<string, unknown> = {}) {
  return {
    params: { venueId },
    body: { terminalId: 'T-1', amountCents: 10000, requestId, ...body },
    headers: {},
    authContext: { userId: 'staff-1' },
  } as unknown as Request
}

async function responder(error: unknown) {
  sendPaymentToTerminalMock.mockRejectedValue(error)
  const res = buildRes()
  await sendTerminalPayment(buildReq(), res)
  return res
}

describe('sendTerminalPayment — cada rechazo de admisión sale con su código y details.requestId', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getTerminalMock.mockReturnValue({ terminalId: 't-1', venueId, socketId: 'sock-1' })
  })

  it.each([
    {
      nombre: 'terminal no conectada',
      error: () => new TerminalUnavailableError('La terminal T-1 no está conectada', 404, 'TERMINAL_NOT_CONNECTED', { requestId }),
      httpStatus: 404,
      code: 'TERMINAL_NOT_CONNECTED',
    },
    {
      nombre: 'terminal registrada sin socket',
      error: () =>
        new TerminalUnavailableError('La terminal T-1 está registrada pero no tiene conexión de socket.', 422, 'TERMINAL_NO_SOCKET', {
          requestId,
        }),
      httpStatus: 422,
      code: 'TERMINAL_NO_SOCKET',
    },
    {
      nombre: 'terminal de otro establecimiento',
      error: () =>
        new TerminalUnavailableError('La terminal no pertenece a este establecimiento', 403, 'TERMINAL_NOT_IN_VENUE', { requestId }),
      httpStatus: 403,
      code: 'TERMINAL_NOT_IN_VENUE',
    },
    {
      nombre: 'orden cancelada',
      error: () => new BadRequestError('La cuenta X está cancelada: no se puede cobrar.', 'ORDER_CANCELLED_NO_NEW_CHARGE', { requestId }),
      httpStatus: 400,
      code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
    },
    {
      nombre: 'orden inexistente',
      error: () => new BadRequestError('La cuenta no existe en este establecimiento.', 'ORDER_NOT_FOUND', { requestId }),
      httpStatus: 400,
      code: 'ORDER_NOT_FOUND',
    },
    {
      nombre: 'orden ya pagada',
      error: () => new OrderAlreadyPaidError('La cuenta X ya está pagada por completo.', { requestId }),
      httpStatus: 409,
      code: 'ORDER_ALREADY_PAID',
    },
  ])('$nombre ⇒ $httpStatus con code $code y details.requestId', async ({ error, httpStatus, code }) => {
    const e = error()
    const res = await responder(e)
    expect(res.statusCode).toBe(httpStatus)
    expect(res.payload).toMatchObject({ success: false, code, message: e.message, details: { requestId } })
  })

  it('terminal ocupada ⇒ 409 TERMINAL_BUSY: conserva status/errorMessage/blockingRequest en la raíz y agrega details.requestId', async () => {
    const blockingRequest = { requestId: 'REQ-A', amountCents: 35000, senderDevice: 'iPad Caja 1', ageSeconds: 42 }
    const res = await responder(new TerminalBusyError('La terminal T-1 está ocupada por un cobro de $350.00', blockingRequest, requestId))
    expect(res.statusCode).toBe(409)
    expect(res.payload).toEqual({
      success: false,
      status: 'failed',
      code: 'TERMINAL_BUSY',
      errorMessage: 'La terminal T-1 está ocupada por un cobro de $350.00',
      message: 'La terminal T-1 está ocupada por un cobro de $350.00',
      blockingRequest,
      details: { blockingRequest, requestId },
    })
  })

  it('contención de la admisión ⇒ 503 TERMINAL_PAYMENT_ADMISSION_RETRY con details.requestId: incierto, nunca un 500 sin código', async () => {
    const e = new TerminalPaymentAdmissionRetryError({ requestId })
    const res = await responder(e)
    expect(res.statusCode).toBe(503)
    // `status: 'timeout'` es el desenlace incierto que las apps publicadas ya saben leer: consultar antes de volver a cobrar.
    expect(res.payload).toMatchObject({
      success: false,
      status: 'timeout',
      code: 'TERMINAL_PAYMENT_ADMISSION_RETRY',
      message: e.message,
      errorMessage: e.message,
      details: { requestId },
    })
  })

  it('un conflicto de solicitud (BadRequest sin código) sigue saliendo como 400 con sólo su mensaje', async () => {
    const res = await responder(
      new BadRequestError('Esta solicitud ya pertenece a otro cobro. Consulta el resultado original antes de continuar.'),
    )
    expect(res.statusCode).toBe(400)
    expect(res.payload).toEqual({
      success: false,
      message: 'Esta solicitud ya pertenece a otro cobro. Consulta el resultado original antes de continuar.',
    })
  })

  it('una terminal registrada en OTRO venue ya no se corta antes del servicio: el servicio la rechaza bajo el candado (con lápida)', async () => {
    getTerminalMock.mockReturnValue({ terminalId: 't-1', venueId: 'venue-OTRO', socketId: 'sock-1' })
    const res = await responder(
      new TerminalUnavailableError('La terminal no pertenece a este establecimiento', 403, 'TERMINAL_NOT_IN_VENUE', { requestId }),
    )
    expect(sendPaymentToTerminalMock).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(403)
    expect(res.payload).toMatchObject({ success: false, code: 'TERMINAL_NOT_IN_VENUE', details: { requestId } })
  })
})

describe('getTerminalPaymentStatus — una lápida sale FAILED con su failureCode', () => {
  it('status FAILED (las apps publicadas sueltan su llave con él), inProgress false y failureCode REJECTED_…', async () => {
    getPaymentStatusMock.mockResolvedValue({
      requestId,
      venueId,
      terminalId: 't-1',
      status: 'FAILED',
      failureCode: 'REJECTED_TERMINAL_BUSY',
      amount: 100,
      tip: 0,
      orderId: null,
      paymentId: null,
      senderDevice: null,
      lateResult: false,
      cancelDisposition: null,
      createdAt: '2026-09-11T20:00:00.000Z',
      updatedAt: '2026-09-11T20:00:00.000Z',
    })
    const res = buildRes()
    await getTerminalPaymentStatus({ params: { venueId, requestId } } as unknown as Request, res)
    expect(res.statusCode).toBe(200)
    expect(res.payload).toMatchObject({ success: true, inProgress: false, status: 'FAILED', failureCode: 'REJECTED_TERMINAL_BUSY' })
  })
})
