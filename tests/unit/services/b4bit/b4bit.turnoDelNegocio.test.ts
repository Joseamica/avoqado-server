/**
 * 🔴 AISLAMIENTO DE TENANT: un cobro CRIPTO no puede caer en el turno de OTRO negocio.
 *
 * El defecto (3-sep-2026): `initiateCryptoPayment` validaba el turno con
 * `shift.findUnique({ where: { id: shiftId } })` — **sin `venueId`** — y después persistía ESE
 * mismo id (el que mandó el cliente) en el `Payment`. La `Order` sí resolvía por negocio, así que
 * las dos mitades del MISMO cobro podían apuntar a turnos distintos: el venue A perdía el cobro de
 * su corte y el venue B sumaba dinero ajeno. La regla dura del repo no admite matices — toda
 * consulta filtra por `venueId`.
 *
 * Lo que fija esta prueba: el turno se resuelve UNA sola vez con `turnoAbiertoDelNegocio(tx,
 * venueId)` y ese id va a la Order Y al Payment. El `shiftId` que llegue en la petición se ignora
 * (ninguna app lo manda: `CryptoPaymentRequest` de avoqado-tpv ni siquiera tiene el campo), y
 * `null` —negocio sin turno abierto— es un desenlace legítimo: el cobro no se detiene.
 */
jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    venue: { findUnique: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn() },
    shift: { findUnique: jest.fn(), findFirst: jest.fn() },
    terminal: { findFirst: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  }
  client.$transaction.mockImplementation((cb: any) => cb(client))
  return { __esModule: true, default: client }
})
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn(),
  generateReceiptUrl: jest.fn(),
}))
jest.mock('@/services/venueSalesGuard', () => ({
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { initiateCryptoPayment } from '@/services/b4bit/b4bit.service'

const mockPrisma = prisma as unknown as {
  payment: { create: jest.Mock; update: jest.Mock }
  order: { create: jest.Mock; findUnique: jest.Mock }
  shift: { findUnique: jest.Mock; findFirst: jest.Mock }
  terminal: { findFirst: jest.Mock }
  venueCryptoConfig: { findUnique: jest.Mock }
}
const mockLogAction = logAction as unknown as jest.Mock

const VENUE_A = 'cvenuea000000000000000001'
const TURNO_DE_A = 'cshifta000000000000000001'
/** El turno abierto de OTRO negocio (venue B): válido y OPEN, pero ajeno. Es lo que mandaba el cliente. */
const TURNO_DE_B = 'cshiftb000000000000000001'
const STAFF_ID = 'cstaff0000000000000000001'
const ORDEN_EXISTENTE = 'corder0000000000000000001'

/** Cobro cripto SIN orden previa: crea la orden testigo y el pago en la misma transacción. */
const cobro = (over: Record<string, any> = {}) => ({
  venueId: VENUE_A,
  orgId: 'corg00000000000000000001',
  amount: 5500,
  tip: 0,
  staffId: STAFF_ID,
  // 🔴 El turno de OTRO negocio, tal como llegaría del cliente.
  shiftId: TURNO_DE_B,
  deviceSerialNumber: null,
  rating: null,
  ...over,
})

const datosDeLaOrden = () => mockPrisma.order.create.mock.calls[0]?.[0]?.data
const datosDelPago = () => mockPrisma.payment.create.mock.calls[0]?.[0]?.data

describe('initiateCryptoPayment — el cobro cripto cae en el turno del NEGOCIO', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Si alguien volviera a consultar el turno por id suelto, esto le devolvería el de OTRO venue:
    // es la trampa exacta del defecto, puesta a propósito.
    mockPrisma.shift.findUnique.mockResolvedValue({ id: TURNO_DE_B, status: 'OPEN' })
    mockPrisma.shift.findFirst.mockResolvedValue({ id: TURNO_DE_A })
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    mockPrisma.order.create.mockResolvedValue({ id: 'order-cripto-1', orderNumber: 'CRYPTO-1' })
    mockPrisma.payment.create.mockResolvedValue({ id: 'pay-cripto-1' })
    mockPrisma.payment.update.mockResolvedValue({})
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue(null)
    // La llamada al proveedor va DESPUÉS de la transacción: reventarla ahí deja la orden y el pago
    // ya escritos y observables, sin tener que simular la API de B4Bit.
    global.fetch = jest.fn().mockRejectedValue(new Error('no debió llamarse a B4Bit')) as any
  })

  it('🔴 el Payment NO hereda el turno de otro negocio: cae en el turno de ESTE venue', async () => {
    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(datosDelPago().shiftId).toBe(TURNO_DE_A)
    expect(datosDelPago().shiftId).not.toBe(TURNO_DE_B)
  })

  it('Order y Payment reciben el MISMO turno, resuelto UNA sola vez', async () => {
    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(datosDeLaOrden().shiftId).toBe(TURNO_DE_A)
    expect(datosDelPago().shiftId).toBe(datosDeLaOrden().shiftId)
    // Dos resoluciones serían dos fuentes de verdad para el mismo dato: es de donde salió el defecto.
    expect(mockPrisma.shift.findFirst).toHaveBeenCalledTimes(1)
    expect(mockPrisma.shift.findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE_A, status: 'OPEN', endTime: null })
  })

  it('🔴 nunca consulta un turno por id suelto (un `findUnique` sin `venueId` es la regla rota)', async () => {
    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(mockPrisma.shift.findUnique).not.toHaveBeenCalled()
  })

  it('sobre una orden EXISTENTE el pago también cae en el turno del negocio', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDEN_EXISTENTE, status: 'PENDING', paymentStatus: 'PENDING' })

    await initiateCryptoPayment(cobro({ orderId: ORDEN_EXISTENTE }) as any).catch(() => undefined)

    expect(mockPrisma.order.create).not.toHaveBeenCalled()
    expect(datosDelPago().shiftId).toBe(TURNO_DE_A)
  })

  it('sin turno abierto del negocio, el pago cae SIN turno — nunca en el del cliente — y el cobro no se detiene', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue(null)

    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1)
    expect(datosDelPago().shiftId ?? null).toBeNull()
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })

  it('el dinero fuera de turno deja rastro en la bitácora, con el pago y el negocio', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue(null)

    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CRYPTO_PAYMENT_WITHOUT_SHIFT',
        venueId: VENUE_A,
        entity: 'Payment',
        entityId: 'pay-cripto-1',
        staffId: STAFF_ID,
      }),
    )
  })

  it('con turno abierto NO ensucia la bitácora (el camino normal no es una anomalía)', async () => {
    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(mockLogAction).not.toHaveBeenCalled()
  })
})

/**
 * La respuesta no puede callar dónde cayó el dinero: es el dato que el cajero necesita para
 * entender por qué un cobro no aparece en su corte. Campo NUEVO y opcional — nada se quita.
 */
describe('initiateCryptoPayment — la respuesta dice en qué turno quedó el cobro', () => {
  const respuestaDeB4Bit = () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({ identifier: 'req-b4bit-1', web_url: 'https://pos.b4bit.com/x', address: 'addr', input_currency: 'BTC' }),
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.shift.findUnique.mockResolvedValue({ id: TURNO_DE_B, status: 'OPEN' })
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    mockPrisma.order.create.mockResolvedValue({ id: 'order-cripto-1', orderNumber: 'CRYPTO-1' })
    mockPrisma.payment.create.mockResolvedValue({ id: 'pay-cripto-1' })
    mockPrisma.payment.update.mockResolvedValue({})
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({
      b4bitDeviceId: 'device-uuid',
      b4bitSecretKey: 'abcd',
      status: 'ACTIVE',
    })
    global.fetch = jest.fn().mockResolvedValue(respuestaDeB4Bit()) as any
  })

  it('devuelve el turno del negocio, no el que mandó el cliente', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue({ id: TURNO_DE_A })

    const resultado = await initiateCryptoPayment(cobro() as any)

    expect(resultado.shiftId).toBe(TURNO_DE_A)
  })

  it('devuelve `null` cuando el negocio no tiene turno abierto', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue(null)

    const resultado = await initiateCryptoPayment(cobro() as any)

    expect(resultado.shiftId).toBeNull()
  })
})
