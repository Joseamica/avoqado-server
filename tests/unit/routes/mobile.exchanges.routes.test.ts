const mockStaffVenueFindUnique = jest.fn()
const mockConsumeOverride = jest.fn()

jest.mock('@/middlewares/validation', () => {
  const actual = jest.requireActual('@/middlewares/validation')
  return { ...actual, validateRequest: jest.fn(actual.validateRequest) }
})

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: async () => ({ active: true }) },
    staffVenue: { findFirst: async () => null, findUnique: (...a: unknown[]) => mockStaffVenueFindUnique(...a) },
    venue: { findUnique: async () => null },
    // Con una fila menor que OWNER, el resolutor pregunta en UNA consulta si es dueña de la org del venue (P2-6).
    staffOrganization: { findUnique: async () => null, findFirst: async () => null },
    venueRolePermission: { findUnique: async () => null },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: jest.fn(),
}))
jest.mock('@/services/mobile/permission-override.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/permission-override.mobile.service'),
  consumePermissionOverride: (...a: unknown[]) => mockConsumeOverride(...a),
  isManagerPinOverrideEnabled: async () => true,
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { StaffRole } from '@prisma/client'
import mobileRouter, { permisoDeCambio } from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { validateRequest } from '@/middlewares/validation'
import { createExchangeSchema } from '@/schemas/mobile/exchange.mobile.schema'
import { createExchange } from '@/controllers/mobile/exchange.mobile.controller'

const validatorIndex = jest.mocked(validateRequest).mock.calls.findIndex(([schema]) => schema === createExchangeSchema)
const validator = jest.mocked(validateRequest).mock.results[validatorIndex]?.value

async function correr(role: StaffRole, body: unknown, headers: Record<string, string> = {}) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: 'POST',
    originalUrl: '/api/v1/mobile/venues/v1/exchanges',
    params: { venueId: 'v1' },
    headers,
    body,
    authContext: { userId: 'u1', venueId: 'v1', role },
  }
  const out: { status?: number; json?: any; next: boolean } = { next: false }
  const res: any = {
    status: (s: number) => ((out.status = s), res),
    json: (j: unknown) => ((out.json = j), res),
  }
  await permisoDeCambio(req, res, () => {
    out.next = true
  })
  return out
}

beforeEach(() => jest.clearAllMocks())

describe('exchange mobile route permissions', () => {
  it('the route chain is authenticate → validate → permisoDeCambio → controller', () => {
    const layer = (mobileRouter as any).stack.find((l: any) => l.route?.path === '/venues/:venueId/exchanges' && l.route.methods.post)
    expect(validator).toEqual(expect.any(Function))
    expect(layer?.route.stack.map((l: any) => l.handle)).toEqual([authenticateTokenMiddleware, validator, permisoDeCambio, createExchange])
    expect(permisoDeCambio.requiredPermission).toBe('payments:refund')
  })

  it('a CASHIER passes payments:refund; a WAITER gets the overridable 403', async () => {
    const body = { settlement: { kind: 'EVEN', method: null, expectedDifferenceCents: 0 } }
    expect(await correr(StaffRole.CASHIER, body)).toEqual({ next: true })
    expect(await correr(StaffRole.WAITER, body)).toMatchObject({
      next: false,
      status: 403,
      json: { required: 'payments:refund', overridable: true },
    })
  })

  it('PAYOUT CASH with cashFromNonCash asks payments:refund-to-cash: CASHIER 403, MANAGER passes', async () => {
    const body = { settlement: { kind: 'PAYOUT', method: 'CASH', cashFromNonCash: true } }
    expect(await correr(StaffRole.CASHIER, body)).toMatchObject({
      next: false,
      status: 403,
      json: { required: 'payments:refund-to-cash', overridable: true },
    })
    expect(await correr(StaffRole.MANAGER, body)).toEqual({ next: true })
  })

  it.each([
    { kind: 'PAYOUT', method: 'CASH' },
    { kind: 'PAYOUT', method: 'CASH', cashFromNonCash: false },
    { kind: 'PAYOUT', method: 'BANK_TRANSFER', cashFromNonCash: true },
    { kind: 'COLLECT', method: 'CASH', cashFromNonCash: true },
  ])('uses only the base permission outside the explicit cash override: %j', async settlement => {
    expect(await correr(StaffRole.CASHIER, { settlement })).toEqual({ next: true })
  })

  it.each([
    [{ kind: 'PAYOUT', method: 'CASH', cashFromNonCash: true }, 'payments:refund-to-cash'],
    [{ kind: 'EVEN', method: null }, 'payments:refund'],
  ])('consumes exactly one manager override for %j', async (settlement, permission) => {
    mockConsumeOverride.mockResolvedValue({ authorizedById: 'c0000000000000000000000001' })
    expect(await correr(StaffRole.WAITER, { settlement }, { 'x-permission-override': 'tok' })).toEqual({ next: true })
    expect(mockConsumeOverride).toHaveBeenCalledTimes(1)
    expect(mockConsumeOverride).toHaveBeenCalledWith(expect.objectContaining({ permission, venueId: 'v1' }))
  })
})
