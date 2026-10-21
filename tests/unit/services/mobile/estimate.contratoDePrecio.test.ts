/**
 * IVA por producto, plan 2, tarea 4 — actualizado al fusionar develop f97a82b1 (30-sep): el presupuesto YA NO suma el
 * 16 % encima y la conversión cobra la suma de los precios (IVA dentro, `taxAmount` 0), aun para presupuestos viejos
 * guardados con el IVA sumado. La orden que nace de ahí es `IVA_INCLUIDO`, como el mostrador; marcarla `IVA_APARTE`
 * bloquearía su factura si trae productos al 0 % o exentos.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/utils/staff-venue.util', () => ({
  __esModule: true,
  validateStaffVenue: jest.fn().mockResolvedValue('staff-1'),
}))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  __esModule: true,
  buildOrderItemsData: jest.fn().mockResolvedValue({ itemsData: [], subtotal: 100, itemDiscountTotal: 0 }),
}))

import { Prisma } from '@prisma/client'
import { convertToOrder } from '@/services/mobile/estimate.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0]?.[0]?.data

describe('convertToOrder (presupuesto → orden) — contrato de precio', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    ;(prismaMock as any).estimate = { findFirst: jest.fn(), update: jest.fn() }
    prismaMock.estimate.findFirst.mockResolvedValue({
      id: 'est-1',
      venueId: VENUE,
      status: 'ACCEPTED',
      convertedOrderId: null,
      subtotal: new Prisma.Decimal(100),
      taxAmount: new Prisma.Decimal(16),
      total: new Prisma.Decimal(116),
      customerName: 'Ana',
      items: [],
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      updatedAt: new Date('2026-09-03T10:00:00.000Z'),
    } as any)
    prismaMock.estimate.update.mockResolvedValue({ id: 'est-1' } as any)
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      items: [],
      total: new Prisma.Decimal(116),
      createdAt: new Date('2026-09-03T10:00:00.000Z'),
    } as any)
  })

  it('la orden convertida nace IVA_INCLUIDO: cobra la suma de los precios, con el IVA dentro', async () => {
    await convertToOrder('est-1', VENUE, 'staff-1')

    expect(datosDeLaOrden().contratoDePrecio).toBe('IVA_INCLUIDO')
  })
})
