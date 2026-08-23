import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  activateCustomerAccount: jest.fn(async () => ({ approvalStatus: 'APPROVED', requestsApproval: false, approvalVersion: 0 })),
}))

import { ensureVenueCustomerActivated } from '@/services/consumer/reservation.consumer.service'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'

/**
 * Fase 1 slice 2 (3/3) — el vínculo Consumer→Customer se vuelve transaccional.
 *
 * Frontera exigida por la auditoría de diseño: una tx CORTA sólo para Consumer + Customer +
 * activación. NO se envuelve `createReservationForConsumer` entero, que después abre sus
 * propias transacciones serializables y puede llamar a Stripe — sostener una tx durante una
 * llamada de red es justo lo que agota el pool.
 */
const VENUE = 'venue-1'
const CONSUMER = 'cons-1'

function armConsumer(overrides: Record<string, unknown> = {}) {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.consumer.findUnique.mockResolvedValue({
    id: CONSUMER,
    email: 'ana@test.com',
    phone: '+525511110000',
    firstName: 'Ana',
    lastName: 'R',
    active: true,
    ...overrides,
  } as any)
}

describe('ensureVenueCustomerActivated — Consumer transaccional (Fase 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    armConsumer()
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prismaMock.customer.findUnique.mockResolvedValue(null)
    prismaMock.customer.create.mockResolvedValue({ id: 'cust-new', venueId: VENUE, active: true } as any)
  })

  it('🔴 Customer nuevo: creación + activación corren DENTRO de una sola transacción', async () => {
    const r = await ensureVenueCustomerActivated(VENUE, CONSUMER)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.customer.create).toHaveBeenCalled()
    expect(activateCustomerAccount).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust-new', venueId: VENUE, origin: 'CONSUMER' })
    expect(r.customer.id).toBe('cust-new')
  })

  it('🔴 Customer que ya existía por consumerId: también se activa (es su primera vez en ESTE venue)', async () => {
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-viejo', venueId: VENUE, active: true } as any)

    await ensureVenueCustomerActivated(VENUE, CONSUMER)
    expect(activateCustomerAccount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: 'cust-viejo' }))
  })

  it('🔴 vínculo por email (contacto de CRM que ahora entra por la app): se liga Y se activa', async () => {
    prismaMock.customer.findUnique.mockImplementation(async ({ where }: any) =>
      where.venueId_email ? { id: 'cust-email', venueId: VENUE, active: true, firstName: null } : null,
    )
    prismaMock.customer.update.mockResolvedValue({ id: 'cust-email', venueId: VENUE, active: true } as any)

    await ensureVenueCustomerActivated(VENUE, CONSUMER)
    expect(prismaMock.customer.update).toHaveBeenCalled()
    expect(activateCustomerAccount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: 'cust-email' }))
  })

  it('devuelve el approvalStatus para que el caller decida si puede reservar', async () => {
    ;(activateCustomerAccount as jest.Mock).mockResolvedValue({ approvalStatus: 'PENDING', requestsApproval: true, approvalVersion: 0 })

    const r = await ensureVenueCustomerActivated(VENUE, CONSUMER)
    expect(r.approvalStatus).toBe('PENDING')
  })

  // ---- Regresiones de Fase 0 -------------------------------------------------------------
  it('regresión: Consumer inactivo → 400 y NO abre transacción', async () => {
    armConsumer({ active: false })

    await expect(ensureVenueCustomerActivated(VENUE, CONSUMER)).rejects.toMatchObject({ statusCode: 400 })
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })

  it('regresión: Customer desactivado en el venue → 401 CUSTOMER_INACTIVE, sin activar', async () => {
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-baja', venueId: VENUE, active: false } as any)

    await expect(ensureVenueCustomerActivated(VENUE, CONSUMER)).rejects.toMatchObject({
      statusCode: 401,
      code: 'CUSTOMER_INACTIVE',
    })
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })
})
