/**
 * La frontera del relay POS→terminal: cómo entra el CLIENTE de la venta.
 *
 * 🔴 Por qué un `customerId` mal formado NO puede devolver 400: este endpoint es el que
 * dispara el cobro con tarjeta. Rechazarlo por el formato de un id de cliente le impide
 * cobrar al comercio por un dato que ni siquiera toca el dinero — el peor intercambio
 * posible. Es la MISMA lección que ya costó un incidente con `terminalPaymentRequestId`
 * (`min(1)`, no `min(8)`: un id de 7 caracteres bloqueó un cobro para siempre) y la que
 * gobierna `customerId` en `/fast` (`.catch(undefined)`).
 *
 * Así que la regla aquí es: normalizar y DESCARTAR, nunca rechazar.
 *
 * La ruta no pasa por Zod (`mobile.routes.ts`: sólo auth + permiso + controller), así que
 * esta normalización es la única frontera que existe — de ahí el test al controller.
 */

import type { Request, Response } from 'express'

import { sendTerminalPayment } from '@/controllers/mobile/terminal-payment.mobile.controller'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: { sendPaymentToTerminal: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({
  terminalRegistry: { getTerminal: jest.fn() },
}))
jest.mock('@/utils/staff-venue.util', () => ({
  validateStaffVenue: jest.fn().mockResolvedValue('staff-1'),
}))

const sendPaymentToTerminalMock = terminalPaymentService.sendPaymentToTerminal as jest.Mock
const getTerminalMock = terminalRegistry.getTerminal as jest.Mock

const venueId = 'venue-1'

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

function buildReq(body: Record<string, unknown>) {
  return {
    params: { venueId },
    body: { terminalId: 'T-1', amountCents: 10000, ...body },
    headers: {},
    authContext: { userId: 'staff-1' },
  } as unknown as Request
}

/** Lo que de verdad se le pasó al servicio (y por tanto acabará en la fila). */
function argumentosDelServicio() {
  return sendPaymentToTerminalMock.mock.calls[0]?.[0]
}

describe('sendTerminalPayment — el cliente que el POS adjunta al cobro con tarjeta', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getTerminalMock.mockReturnValue({ terminalId: 't-1', venueId, socketId: 'sock-1' })
    sendPaymentToTerminalMock.mockResolvedValue({ requestId: 'REQ-1', status: 'success' })
  })

  it('pasa el customerId al servicio (hoy se descartaba en la desestructuración)', async () => {
    const res = buildRes()
    await sendTerminalPayment(buildReq({ customerId: 'cust-1' }), res)

    expect(argumentosDelServicio().customerId).toBe('cust-1')
    expect(res.statusCode).toBe(200)
  })

  it('normaliza espacios — el POS puede mandar el id con padding', async () => {
    await sendTerminalPayment(buildReq({ customerId: '  cust-1  ' }), buildRes())
    expect(argumentosDelServicio().customerId).toBe('cust-1')
  })

  it('sin cliente manda null explícito: la venta anónima queda idéntica a hoy', async () => {
    await sendTerminalPayment(buildReq({}), buildRes())
    expect(argumentosDelServicio().customerId).toBeNull()
  })

  it('🔴 un customerId absurdamente largo se DESCARTA y el cobro procede', async () => {
    // Con un límite de body de 1 MB, sin cota ese string acabaría en la columna y en el
    // meta del logger de CADA cobro. Pero rechazarlo impediría cobrar.
    const res = buildRes()
    await sendTerminalPayment(buildReq({ customerId: 'x'.repeat(5000) }), res)

    expect(argumentosDelServicio().customerId).toBeNull()
    expect(res.statusCode).toBe(200) // el cobro NO se rechazó
  })

  it('🔴 un customerId de tipo equivocado tampoco rechaza el cobro', async () => {
    const res = buildRes()
    await sendTerminalPayment(buildReq({ customerId: { nope: true } }), res)

    expect(argumentosDelServicio().customerId).toBeNull()
    expect(res.statusCode).toBe(200)
  })

  it('un customerId en blanco es "sin cliente", no un id vacío', async () => {
    await sendTerminalPayment(buildReq({ customerId: '   ' }), buildRes())
    expect(argumentosDelServicio().customerId).toBeNull()
  })

  it('REGRESIÓN: las validaciones que SÍ rechazan siguen rechazando', async () => {
    // El cliente es aditivo: no relaja la frontera que ya existía.
    const res = buildRes()
    await sendTerminalPayment(buildReq({ amountCents: 0, customerId: 'cust-1' }), res)

    expect(res.statusCode).toBe(400)
    expect(sendPaymentToTerminalMock).not.toHaveBeenCalled()
  })
})
