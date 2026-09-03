/**
 * Los dos caminos de mostrador que quedaban sueltos —convertir un presupuesto y abrir un vale de
 * área— también atan su orden al turno de caja del negocio.
 *
 * 🔴 En los dos el disparador es una persona en la caja, AHORA: la fecha del presupuesto no
 * manda (lo que nace hoy es la orden), y el vale se acuña en el propio mostrador. El turno es
 * OPCIONAL en ambos: un negocio que no abrió caja sigue vendiendo.
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
import { openAreaTicket } from '@/services/mobile/areaTicket.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const TURNO = { venueId: VENUE, status: 'OPEN', endTime: null }

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0]?.[0]?.data

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
})

describe('convertToOrder (presupuesto → orden) — cae en el turno del NEGOCIO', () => {
  beforeEach(() => {
    // `estimate` no existe en el prismaMock compartido (tests/__helpers__/setup.ts): se declara
    // AQUÍ y no allá, para no tocar un helper que usan ~200 suites.
    ;(prismaMock as any).estimate = { findFirst: jest.fn(), update: jest.fn() }
    prismaMock.estimate.findFirst.mockResolvedValue({
      id: 'est-1',
      venueId: VENUE,
      status: 'ACCEPTED',
      convertedOrderId: null,
      subtotal: new Prisma.Decimal(100),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(100),
      customerName: 'Ana',
      items: [],
      // `convertToOrder` devuelve el presupuesto pasando por `formatEstimate`, que lee estas
      // dos: sin ellas revienta DESPUÉS de crear la orden y el test parece un fallo del fix.
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      updatedAt: new Date('2026-09-03T10:00:00.000Z'),
    } as any)
    prismaMock.estimate.update.mockResolvedValue({ id: 'est-1' } as any)
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      items: [],
      total: new Prisma.Decimal(100),
      createdAt: new Date('2026-09-03T10:00:00.000Z'),
    } as any)
  })

  it('con turno abierto, la orden convertida nace atada a ese turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)

    await convertToOrder('est-1', VENUE, 'staff-1')

    expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
    expect((prismaMock.shift.findFirst as jest.Mock).mock.calls[0][0].where).toEqual(TURNO)
  })

  it('sin turno abierto la conversión SIGUE ocurriendo, sin turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await convertToOrder('est-1', VENUE, 'staff-1')

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })
})

describe('openAreaTicket (vale de área) — cae en el turno del NEGOCIO', () => {
  // El ejemplo trabajado del propio contrato (`src/lib/areaTicketCode.ts`): partición 47,
  // contador 1, verificador 5. Las particiones válidas son 10..99, así que un `01` se rechaza
  // antes de tocar la base.
  const CODIGO = '9470000015'

  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: 'term-1',
      name: 'Caja 1',
      partition: 47,
      areaTicketLastCounter: 0,
      fulfillmentAreaId: 'area-1',
    } as any)
    // La idempotencia del vale consulta por `findUnique` (llave compuesta venue+código).
    prismaMock.order.findUnique.mockResolvedValue(null)
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.order.create.mockResolvedValue({ id: 'order-vale-1', orderNumber: 'ORD-1', items: [], payments: [] } as any)
  })

  it('con turno abierto, la cuenta del vale nace atada a ese turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)

    await openAreaTicket(VENUE, { code: CODIGO, deviceUid: 'dev-1', staffId: 'staff-1', items: [] } as any).catch(() => undefined)

    expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
    expect((prismaMock.shift.findFirst as jest.Mock).mock.calls[0][0].where).toEqual(TURNO)
  })

  it('sin turno abierto el vale SE ABRE igual, sin turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await openAreaTicket(VENUE, { code: CODIGO, deviceUid: 'dev-1', staffId: 'staff-1', items: [] } as any).catch(() => undefined)

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })
})
