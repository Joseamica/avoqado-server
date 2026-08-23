import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  decideCustomerApproval: jest.fn(async () => ({ approvalStatus: 'APPROVED', approvalVersion: 3, changed: true })),
}))

import { decideCustomerApprovalFromDashboard, listCustomersAwaitingApproval } from '@/services/dashboard/customer.dashboard.service'
import { decideCustomerApproval } from '@/services/public/customerBookingAccess.service'

/**
 * Fase 1 slice 4 — la decisión del staff, vista desde el dashboard.
 *
 * La lógica (lock, write-CAS, ActivityLog, outbox) ya vive probada en
 * `customerBookingAccess.service`. Lo que se prueba aquí es la costura: que la organización
 * se derive del VENUE y no del token, que todo corra en UNA transacción, y que la bandeja
 * "en espera" no se le escape a otro negocio.
 */
const VENUE = 'venue-1'
const DECIDE = decideCustomerApproval as jest.Mock

describe('decideCustomerApprovalFromDashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    DECIDE.mockResolvedValue({ approvalStatus: 'APPROVED', approvalVersion: 3, changed: true })
    prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE, organizationId: 'org-1' } as any)
  })

  it('🔴 deriva organizationId del VENUE, no del token del que aprueba', async () => {
    const r = await decideCustomerApprovalFromDashboard(VENUE, 'cust-1', {
      decision: 'APPROVED',
      expectedVersion: 2,
      actorStaffId: 'staff-1',
    })

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(DECIDE).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerId: 'cust-1', venueId: VENUE, organizationId: 'org-1', actorStaffId: 'staff-1' }),
    )
    expect(r.approvalVersion).toBe(3)
  })

  it('🔴 venue inexistente → 404 y no se decide nada', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)

    await expect(
      decideCustomerApprovalFromDashboard(VENUE, 'cust-1', { decision: 'REJECTED', expectedVersion: 0, actorStaffId: 'staff-1' }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(DECIDE).not.toHaveBeenCalled()
  })

  it('🔴 el motivo del rechazo viaja tal cual (es lo que ve el cliente en el correo)', async () => {
    DECIDE.mockResolvedValue({ approvalStatus: 'REJECTED', approvalVersion: 1, changed: true })

    await decideCustomerApprovalFromDashboard(VENUE, 'cust-1', {
      decision: 'REJECTED',
      reason: 'No es alumna del estudio',
      expectedVersion: 0,
      actorStaffId: 'staff-1',
    })

    expect(DECIDE).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'No es alumna del estudio' }))
  })
})

describe('listCustomersAwaitingApproval', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.customer.findMany.mockResolvedValue([] as any)
    prismaMock.customer.count.mockResolvedValue(0 as any)
  })

  it('🔴 filtra por venue Y por PENDING — nunca lista clientes de otro negocio', async () => {
    await listCustomersAwaitingApproval(VENUE, { page: 1, pageSize: 20 })

    const where = prismaMock.customer.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ venueId: VENUE, approvalStatus: 'PENDING' })
  })

  it('🔴 ordena por más antiguo primero: quien lleva más esperando se atiende antes', async () => {
    await listCustomersAwaitingApproval(VENUE, { page: 1, pageSize: 20 })

    expect(prismaMock.customer.findMany.mock.calls[0][0].orderBy).toEqual({ approvalRequestedAt: 'asc' })
  })
})
