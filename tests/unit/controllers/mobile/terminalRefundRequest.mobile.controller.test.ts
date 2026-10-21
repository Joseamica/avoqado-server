/**
 * A2 (cierre de tarjetas 1a): abrir la devolución en la terminal de una venta de tarjetas de regalo sin su cancelación iniciada
 * responde el rechazo de la regla única (`GiftCardError`, 409 con `code`). El controlador de la ruta del POS lo convertía en un
 * 500 «Error interno del servidor»: la app no sabía que tenía que iniciar «Cancelar venta».
 */
import type { Request, Response } from 'express'

import { requestRefundOnTerminal } from '@/controllers/mobile/terminal-payment.mobile.controller'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { BadRequestError } from '@/errors/AppError'

jest.mock('@/services/terminal-payment.service', () => ({ terminalPaymentService: { requestRefundOnTerminal: jest.fn() } }))
jest.mock('@/communication/sockets/terminal-registry', () => ({ terminalRegistry: { getTerminal: jest.fn() } }))

const abrir = terminalPaymentService.requestRefundOnTerminal as jest.Mock

function llamar() {
  const res = { statusCode: 200, payload: undefined as unknown } as Response & { statusCode: number; payload: any }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  }) as never
  res.json = jest.fn((body: unknown) => {
    res.payload = body
    return res
  }) as never
  const req = {
    params: { venueId: 'v1', terminalId: 'AVQD-T1' },
    body: { paymentId: 'pay-1' },
    authContext: { userId: 'staff-1' },
  } as unknown as Request
  return requestRefundOnTerminal(req, res).then(() => res)
}

describe('POST /terminals/:terminalId/refund-request — rechazos de tarjetas de regalo', () => {
  it('🔴 una venta de tarjetas sin la cancelación iniciada ⇒ 409 con su code y su texto (no un 500)', async () => {
    abrir.mockRejectedValue(
      new GiftCardError(
        'GIFT_CARD_CANCEL_NOT_STARTED',
        'Para devolver la venta de una tarjeta de regalo primero inicia su cancelación en Tarjetas de regalo › Cancelar venta.',
        409,
      ),
    )
    const res = await llamar()
    expect(res.statusCode).toBe(409)
    expect(res.payload).toEqual({
      success: false,
      code: 'GIFT_CARD_CANCEL_NOT_STARTED',
      message: 'Para devolver la venta de una tarjeta de regalo primero inicia su cancelación en Tarjetas de regalo › Cancelar venta.',
    })
  })

  it('regresión: el 400 de un cobro no elegible sigue igual (sin code)', async () => {
    abrir.mockRejectedValue(new BadRequestError('La terminal sólo puede devolver cobros con tarjeta hechos en la terminal.'))
    const res = await llamar()
    expect(res.statusCode).toBe(400)
    expect(res.payload).toEqual({ success: false, message: 'La terminal sólo puede devolver cobros con tarjeta hechos en la terminal.' })
  })
})
