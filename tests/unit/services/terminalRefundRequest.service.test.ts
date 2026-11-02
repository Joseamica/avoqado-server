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
import { hayDevolucionEnTerminal } from '@/services/storeCredit/terminalRefundMarker'

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
  source: 'TPV', // la cobró nuestra terminal (seDevuelveEnTerminal)
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

/**
 * «Sólo saldo a favor» en la puerta de la terminal (spec 2026-10-30-saldo-a-favor §5.5, Codex plan r2 h6). Con el interruptor prendido,
 * pedir desde el POS una devolución en la TPV exige marcar la excepción (defecto, cobro por error, fraudulento o cuenta cancelada); sin
 * ella —apps viejas incluidas— se rechaza ANTES de mandar nada a la terminal. El registro de lo que la terminal ya devolvió
 * (`refund.tpv.service.ts`) no pasa por aquí: lo prueba `reembolsoDelPos.integration.test.ts`.
 */
describe('requestRefundOnTerminal — «Sólo saldo a favor»', () => {
  const soloSaldo = () => prismaMock.venueSettings.findUnique.mockResolvedValue({ storeCreditOnly: true })
  // `clearAllMocks` no borra lo que una prueba dejó resuelto: cada caso parte del negocio sin el interruptor.
  beforeEach(() => prismaMock.venueSettings.findUnique.mockResolvedValue(null))

  it('🔴 con sólo saldo y sin excepción, abrir la devolución en terminal da 422 y no emite el comando', async () => {
    soloSaldo()

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toMatchObject({
      statusCode: 422,
      code: 'STORE_CREDIT_ONLY',
      message:
        'Este negocio devuelve sólo como saldo a favor. Usa Reembolso → Saldo a favor, o marca que es por defecto o cobro por error.',
    })
    expect(emit).not.toHaveBeenCalled()
    expect(prismaMock.venueSettings.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue-1' } }))
  })

  it('🔴 D-1: sin las llaves el interruptor no restringe: sin excepción, la devolución en terminal se emite', async () => {
    soloSaldo()
    ackWith('opened')
    const llave = process.env.GIFT_CARD_HMAC_KEY
    delete process.env.GIFT_CARD_HMAC_KEY
    try {
      const result = await terminalPaymentService.requestRefundOnTerminal(baseRequest())
      expect(result.status).toBe('opened')
      expect(emit).toHaveBeenCalledTimes(1)
    } finally {
      process.env.GIFT_CARD_HMAC_KEY = llave
    }
  })

  it('una excepción desconocida cuenta como ausente', async () => {
    soloSaldo()
    await expect(
      terminalPaymentService.requestRefundOnTerminal(baseRequest({ storeCreditOnlyException: 'PORQUE_SI' })),
    ).rejects.toMatchObject({ code: 'STORE_CREDIT_ONLY' })
    expect(emit).not.toHaveBeenCalled()
  })

  it.each(['DEFECTIVE', 'ACCIDENTAL_CHARGE', 'FRAUDULENT_CHARGE', 'CANCELLED_ORDER'])('con %s la emite', async excepcion => {
    soloSaldo()
    ackWith('opened')

    const result = await terminalPaymentService.requestRefundOnTerminal(baseRequest({ storeCreditOnlyException: excepcion }))

    expect(result.status).toBe('opened')
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('regresión: sin sólo saldo, una petición vieja sin el campo sigue igual', async () => {
    ackWith('opened')

    const result = await terminalPaymentService.requestRefundOnTerminal(baseRequest())

    expect(result.status).toBe('opened')
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('un cobro no elegible sigue respondiendo su 400 de siempre aunque haya sólo saldo', async () => {
    soloSaldo()
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, method: 'CASH' })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest())).rejects.toBeInstanceOf(BadRequestError)
    expect(emit).not.toHaveBeenCalled()
  })
})

/**
 * S7 (spec 2026-10-30-saldo-a-favor §5.5, opción 1): abrir la devolución no aparta el importe y la terminal devuelve al banco ANTES de
 * avisar. Al emitir el comando queda una marca en memoria (3 min) y, mientras vive, el saldo a favor de ese cobro se rechaza.
 */
describe('requestRefundOnTerminal — la marca «la terminal está devolviendo este cobro»', () => {
  beforeEach(() => prismaMock.venueSettings.findUnique.mockResolvedValue(null))

  it('al emitir el comando deja la marca del cobro', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, id: 'pay-marca' })
    ackWith('opened')

    await terminalPaymentService.requestRefundOnTerminal(baseRequest({ paymentId: 'pay-marca' }))

    expect(emit).toHaveBeenCalledTimes(1)
    expect(hayDevolucionEnTerminal('pay-marca')).toBe(true)
  })

  it('si «sólo saldo» la rechaza antes de emitir, no deja marca', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ storeCreditOnly: true })
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, id: 'pay-sin-marca' })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest({ paymentId: 'pay-sin-marca' }))).rejects.toMatchObject({
      code: 'STORE_CREDIT_ONLY',
    })
    expect(hayDevolucionEnTerminal('pay-sin-marca')).toBe(false)
  })

  it('un cobro no elegible tampoco deja marca', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ ...cardPayment, id: 'pay-efectivo', method: 'CASH' })

    await expect(terminalPaymentService.requestRefundOnTerminal(baseRequest({ paymentId: 'pay-efectivo' }))).rejects.toBeInstanceOf(
      BadRequestError,
    )
    expect(hayDevolucionEnTerminal('pay-efectivo')).toBe(false)
  })
})
