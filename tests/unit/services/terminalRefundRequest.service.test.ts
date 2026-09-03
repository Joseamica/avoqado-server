/**
 * Abrir una devolución en la terminal desde el POS.
 *
 * 🔑 El invariante que cuidan estos tests: **si el cobro no es elegible, la
 * terminal no se entera.** Un `terminal:refund_request` emitido de más manda a
 * un cajero a devolver algo que no debía —efectivo, un cobro que nunca se
 * completó, uno de otro negocio, o uno ya devuelto— y esa pantalla, con el
 * cliente enfrente, es muy difícil de deshacer.
 */

import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { BadRequestError, TerminalBusyError } from '@/errors/AppError'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
  socketManager: { getServer: jest.fn() },
}))

jest.mock('@/communication/sockets/terminal-registry', () => {
  const normalizeTerminalId = (id: string) => id.replace(/^AVQD-/i, '').toLowerCase()
  return {
    normalizeTerminalId,
    terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
  }
})

const prismaMock = prisma as any
const mockedGetServer = (socketManager as unknown as { getServer: jest.Mock }).getServer
const mockedGetTerminal = terminalRegistry.getTerminal as jest.Mock

let emit: jest.Mock

const cardPayment = {
  id: 'pay-1',
  venueId: 'venue-1',
  status: 'COMPLETED',
  method: 'CREDIT_CARD',
  amount: 100,
  tipAmount: 20,
  processorData: {},
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    terminalId: 'AVQD-T1',
    venueId: 'venue-1',
    paymentId: 'pay-1',
    requestedBy: 'user-1',
    ...overrides,
  } as any
}

/** Responde el ACK de la terminal en cuanto se emitió el evento. */
function ackWith(status: 'opened' | 'rejected', errorMessage?: string) {
  emit.mockImplementation((_event: string, payload: any) => {
    setImmediate(() => terminalPaymentService.handleRefundRequestResult({ requestId: payload.requestId, status, errorMessage }))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  emit = jest.fn()
  mockedGetServer.mockReturnValue({ to: jest.fn(() => ({ emit })) })
  mockedGetTerminal.mockImplementation((id: string) => ({
    socketId: `sock-${id}`,
    venueId: 'venue-1',
    terminalId: id.replace(/^AVQD-/i, '').toLowerCase(),
  }))
  prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment })
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
})

describe('requestRefundOnTerminal — abrir la devolución en el aparato', () => {
  it('con un cobro con tarjeta elegible, emite terminal:refund_request y resuelve con el ACK', async () => {
    ackWith('opened')

    const result = await terminalPaymentService.requestRefundOnTerminal(baseRequest({ reason: 'Producto defectuoso' }))

    expect(result.status).toBe('opened')
    expect(emit).toHaveBeenCalledTimes(1)
    const [event, payload] = emit.mock.calls[0]
    expect(event).toBe('terminal:refund_request')
    expect(payload).toMatchObject({
      paymentId: 'pay-1',
      venueId: 'venue-1',
      maxRefundableCents: 12000,
      reason: 'Producto defectuoso',
    })
    expect(payload.requestId).toEqual(expect.any(String))
  })

  it('respeta el requestId del cliente (idempotencia del POS)', async () => {
    ackWith('opened')

    await terminalPaymentService.requestRefundOnTerminal(baseRequest({ requestId: 'req-fijo' }))

    expect(emit.mock.calls[0][1].requestId).toBe('req-fijo')
  })

  it('la terminal puede contestar que NO pudo abrirla, y eso llega tal cual', async () => {
    // Un rechazo de la terminal no se disfraza de éxito.
    ackWith('rejected', 'La app está en otra pantalla')

    const result = await terminalPaymentService.requestRefundOnTerminal(baseRequest())

    expect(result).toMatchObject({ status: 'rejected', errorMessage: 'La app está en otra pantalla' })
  })

  it('🔴 un cobro en EFECTIVO nunca llega a la terminal', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, method: 'CASH' })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toBeInstanceOf(BadRequestError)
    expect(emit).not.toHaveBeenCalled()
  })

  it('🔴 un cobro que no se completó nunca llega a la terminal', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, status: 'PENDING' })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toBeInstanceOf(BadRequestError)
    expect(emit).not.toHaveBeenCalled()
  })

  it('🔴 un cobro de OTRO negocio nunca llega a la terminal', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, venueId: 'venue-ajeno' })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toBeInstanceOf(BadRequestError)
    expect(emit).not.toHaveBeenCalled()
  })

  it('🔴 un cobro ya devuelto completo nunca llega a la terminal', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, processorData: { refundedAmount: 120 } })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toBeInstanceOf(BadRequestError)
    expect(emit).not.toHaveBeenCalled()
  })

  it('un cobro que no existe no emite nada', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(null)

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toBeInstanceOf(BadRequestError)
    expect(emit).not.toHaveBeenCalled()
  })

  it('una devolución parcial previa deja pasar el resto', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, processorData: { refundedAmount: 50 } })
    ackWith('opened')

    await terminalPaymentService.requestRefundOnTerminal(baseRequest())

    expect(emit.mock.calls[0][1].maxRefundableCents).toBe(7000)
  })

  it('🔴 no se le habla a una terminal de otro negocio, aunque el cobro sí sea nuestro', async () => {
    mockedGetTerminal.mockReturnValue({ socketId: 'sock-x', venueId: 'venue-ajeno', terminalId: 't1' })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toBeInstanceOf(BadRequestError)
    expect(emit).not.toHaveBeenCalled()
  })

  it('una terminal no conectada falla claro y sin emitir', async () => {
    mockedGetTerminal.mockReturnValue(undefined)

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toThrow(/no está conectada/)
    expect(emit).not.toHaveBeenCalled()
  })

  it('🔴 una terminal a media venta NO recibe la devolución encima', async () => {
    // Quitarle la pantalla al cliente que está pagando es peor que esperar.
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue({
      requestId: 'req-cobro-en-curso',
      amountCents: 5000,
      senderDevice: 'Caja 1',
      createdAt: new Date(),
    })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toBeInstanceOf(TerminalBusyError)
    expect(prismaMock.terminalPaymentRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ terminalId: 't1', venueId: 'venue-1' }) }),
    )
    expect(emit).not.toHaveBeenCalled()
  })

  it('un ACK sin solicitud pendiente no truena ni inventa un desenlace', () => {
    expect(terminalPaymentService.handleRefundRequestResult({ requestId: 'no-existe', status: 'opened' })).toBe(false)
  })
})
