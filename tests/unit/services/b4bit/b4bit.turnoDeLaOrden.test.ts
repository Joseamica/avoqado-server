/**
 * La orden testigo de un cobro CRIPTO cae en el turno de caja del NEGOCIO.
 *
 * 🔴 Y el turno se resuelve por `venueId`, NO se reusa el `shiftId` del parámetro — que es la
 * decisión que esta prueba fija. `initiateCryptoPayment` recibe `shiftId` del cliente y arriba
 * sólo comprueba que ese turno esté OPEN, **no que sea de este negocio**: el `Payment` hereda ese
 * hueco desde antes y no se toca aquí (es el camino del dinero), pero la orden no tiene por qué
 * heredarlo. En el caso normal coinciden — `openShiftForVenue` obliga a un solo turno abierto por
 * venue.
 */
jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    venue: { findUnique: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn() },
    shift: { findUnique: jest.fn(), findFirst: jest.fn() },
    terminal: { findFirst: jest.fn() },
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

import prisma from '@/utils/prismaClient'
import { initiateCryptoPayment } from '@/services/b4bit/b4bit.service'

const mockPrisma = prisma as unknown as {
  payment: { create: jest.Mock }
  order: { create: jest.Mock; findUnique: jest.Mock }
  shift: { findUnique: jest.Mock; findFirst: jest.Mock }
  terminal: { findFirst: jest.Mock }
  venueCryptoConfig: { findUnique: jest.Mock }
}

const VENUE_ID = 'cvenue0000000000000000001'
const STAFF_ID = 'cstaff000000000000000001'

/** Cobro cripto sin orden previa: es el camino que crea la orden testigo. */
const cobro = () => ({
  venueId: VENUE_ID,
  amount: 5500,
  tip: 0,
  staffId: STAFF_ID,
  shiftId: 'turno-que-mando-el-cliente',
  deviceSerialNumber: null,
  rating: null,
})

const datosDeLaOrden = () => mockPrisma.order.create.mock.calls[0]?.[0]?.data

describe('initiateCryptoPayment — la orden testigo cae en el turno del NEGOCIO', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.shift.findUnique.mockResolvedValue({ id: 'turno-que-mando-el-cliente', status: 'OPEN' })
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    mockPrisma.order.create.mockResolvedValue({ id: 'order-cripto-1', orderNumber: 'CRYPTO-1' })
    mockPrisma.payment.create.mockResolvedValue({ id: 'pay-cripto-1' })
    // La llamada al proveedor va después de la transacción: reventarla ahí deja la orden ya
    // creada y observable sin tener que simular la API de B4Bit.
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue(null)
  })

  it('la orden lleva el turno resuelto POR VENUE, no el que mandó el cliente', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue({ id: 'turno-real-del-negocio' })

    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(datosDeLaOrden().shiftId).toBe('turno-real-del-negocio')
    // 🔴 La consulta va acotada al venue: un `shiftId` ajeno simplemente no existe aquí.
    expect(mockPrisma.shift.findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE_ID, status: 'OPEN', endTime: null })
  })

  it('sin turno abierto del negocio, la orden nace sin turno (el cobro no se detiene)', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue(null)

    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(mockPrisma.order.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })
})
