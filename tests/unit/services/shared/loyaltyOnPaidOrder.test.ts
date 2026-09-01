/**
 * Lealtad al quedar PAGADA una orden — UNA regla, compartida por todos los canales.
 *
 * Nació de un defecto real (2026-09-01, Testarudo Cafe): el sello de la tarjeta
 * digital sólo subía cuando la orden se cobraba en la PAX. El MISMO café pagado en
 * efectivo desde el Sunmi (`payCashOrder`) no daba sello ni puntos, porque ese
 * camino nunca llamó a `earnPoints`. La regla vivía copiada dentro de
 * `payment.tpv.service.ts` y nadie más la tenía.
 *
 * Contrato que fijan estas pruebas:
 *   · métricas de visita para TODOS los clientes de la orden;
 *   · puntos/sellos SÓLO para el primario (o el `customerId` heredado si no hay
 *     `OrderCustomer`);
 *   · `LoyaltyTransaction.createdById` es un StaffVenue.id, así que el Staff.id se
 *     traduce aquí y no en cada llamador;
 *   · NUNCA lanza: corre después de que el dinero ya entró.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
  },
}))

jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  earnPoints: jest.fn(),
}))

jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  updateCustomerMetrics: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'

const staffVenueFindFirst = prisma.staffVenue.findFirst as jest.Mock
const orderCustomerFindMany = prisma.orderCustomer.findMany as jest.Mock
const earnPointsMock = earnPoints as jest.Mock
const metricsMock = updateCustomerMetrics as jest.Mock

const VENUE = 'venue-1'
const ORDER = 'order-1'

describe('awardLoyaltyForPaidOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    staffVenueFindFirst.mockResolvedValue({ id: 'sv-1' })
    earnPointsMock.mockResolvedValue({ pointsEarned: 0, newBalance: 0 })
    metricsMock.mockResolvedValue(undefined)
  })

  it('métricas para TODOS los clientes de la orden, puntos SÓLO para el primario', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Ana', lastName: null } },
      { customerId: 'cust-B', isPrimary: false, customer: { id: 'cust-B', firstName: 'Beto', lastName: null } },
    ])

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90, staffId: 'staff-1' })

    expect(metricsMock).toHaveBeenCalledTimes(2)
    expect(metricsMock).toHaveBeenCalledWith('cust-A', 90)
    expect(metricsMock).toHaveBeenCalledWith('cust-B', 90)

    expect(earnPointsMock).toHaveBeenCalledTimes(1)
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 90, ORDER, 'sv-1')
  })

  it('el Staff.id se traduce a StaffVenue.id del MISMO venue — es lo que espera createdById', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
    ])

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, staffId: 'staff-1' })

    expect(staffVenueFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: 'staff-1', venueId: VENUE }) }),
    )
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, 'sv-1')
  })

  it('sin staff no se consulta StaffVenue y el sello sale sin autor', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
    ])

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50 })

    expect(staffVenueFindFirst).not.toHaveBeenCalled()
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, undefined)
  })

  it('sin OrderCustomer cae al customerId heredado de la orden', async () => {
    orderCustomerFindMany.mockResolvedValue([])

    await awardLoyaltyForPaidOrder({
      venueId: VENUE,
      orderId: ORDER,
      orderTotal: 120,
      staffId: 'staff-1',
      legacyCustomer: { id: 'cust-L', firstName: 'Lucía', lastName: 'Ríos' },
    })

    expect(metricsMock).toHaveBeenCalledWith('cust-L', 120)
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-L', 120, ORDER, 'sv-1')
  })

  it('una orden sin cliente no toca lealtad ni métricas', async () => {
    orderCustomerFindMany.mockResolvedValue([])

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 120, staffId: 'staff-1', legacyCustomer: null })

    expect(metricsMock).not.toHaveBeenCalled()
    expect(earnPointsMock).not.toHaveBeenCalled()
  })

  it('🔴 NUNCA lanza: si earnPoints truena, el cobro (que ya entró) no se entera', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
    ])
    earnPointsMock.mockRejectedValue(new Error('Loyalty program not enabled'))

    await expect(awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, staffId: 'staff-1' })).resolves.toBeUndefined()
    expect(metricsMock).toHaveBeenCalledWith('cust-A', 50)
  })

  it('🔴 NUNCA lanza: si falla la consulta de clientes, tampoco', async () => {
    orderCustomerFindMany.mockRejectedValue(new Error('connection reset'))

    await expect(awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, staffId: 'staff-1' })).resolves.toBeUndefined()
    expect(earnPointsMock).not.toHaveBeenCalled()
  })

  it('un fallo de métricas de un cliente no le quita el sello al primario', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
    ])
    metricsMock.mockRejectedValue(new Error('deadlock'))

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, staffId: 'staff-1' })

    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, 'sv-1')
  })
})
