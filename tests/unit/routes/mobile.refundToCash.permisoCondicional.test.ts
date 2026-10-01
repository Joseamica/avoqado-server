/**
 * POST /mobile/venues/:venueId/payments/:paymentId/refund — devolver con «Efectivo de la caja» pide
 * `payments:refund-to-cash` EN LUGAR de `payments:refund` (founder, 1-oct-2026; la dependencia refund-to-cash → refund
 * deja la autorización equivalente).
 *
 * 🔴 UNA sola revisión por petición: el código del encargado (`x-permission-override`) es de un solo uso y de UN permiso.
 * Con dos revisiones encadenadas, un mesero que escogía efectivo gastaba el código en `payments:refund` y la segunda
 * lo rechazaba — callejón sin salida y una bitácora `PERMISSION_OVERRIDE_USED` falsa.
 *
 * Corre el `checkPermission` REAL con los permisos de fábrica (sólo la base va simulada).
 */
const mockStaffVenueFindUnique = jest.fn()
const mockConsumeOverride = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: async () => ({ active: true }) },
    staffVenue: { findFirst: async () => null, findUnique: (...a: unknown[]) => mockStaffVenueFindUnique(...a) },
    venue: { findUnique: async () => null },
    staffOrganization: { findUnique: async () => null },
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
import mobileRouter, { permisoDeReembolso } from '@/routes/mobile.routes'

async function correr(role: StaffRole, body: unknown, headers: Record<string, string> = {}) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: 'POST',
    originalUrl: '/api/v1/mobile/venues/v1/payments/p1/refund',
    params: { venueId: 'v1', paymentId: 'p1' },
    headers,
    body,
    authContext: { userId: 'u1', venueId: 'v1', role },
  }
  const out: { status?: number; json?: any; next: boolean } = { next: false }
  const res: any = {
    status: (s: number) => ((out.status = s), res),
    json: (j: unknown) => ((out.json = j), res),
  }
  await permisoDeReembolso(req, res, () => {
    out.next = true
  })
  return out
}

beforeEach(() => jest.clearAllMocks())

describe('el reembolso móvil revisa UN permiso según «Devolver con»', () => {
  it('🔴 CASHIER con refundMethod CASH ⇒ 403 con el permiso nuevo (overridable por el código del encargado)', async () => {
    const out = await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'CASH' })
    expect(out.next).toBe(false)
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash', overridable: true })
  })

  it('🔴 WAITER (sin payments:refund) + CASH + código del encargado para refund-to-cash ⇒ pasa con UN solo consumo', async () => {
    mockConsumeOverride.mockResolvedValue({ authorizedById: 'sv-gerente' })
    const out = await correr(StaffRole.WAITER, { refundMethod: 'CASH' }, { 'x-permission-override': 'tok' })
    expect(out.next).toBe(true)
    expect(mockConsumeOverride).toHaveBeenCalledTimes(1)
    expect(mockConsumeOverride).toHaveBeenCalledWith(expect.objectContaining({ permission: 'payments:refund-to-cash', venueId: 'v1' }))
  })

  it('CASHIER con transferencia ⇒ pasa por payments:refund', async () => {
    expect(await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'BANK_TRANSFER' })).toEqual({ next: true })
  })

  it('sin efectivo la revisión es payments:refund: el WAITER recibe ESE 403', async () => {
    const out = await correr(StaffRole.WAITER, { refundMethod: 'BANK_TRANSFER' })
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund' })
  })

  it('CASHIER sin refundMethod («por el mismo medio») ⇒ pasa', async () => {
    expect(await correr(StaffRole.CASHIER, { amount: 5000 })).toEqual({ next: true })
    expect(await correr(StaffRole.CASHIER, undefined)).toEqual({ next: true })
  })

  it('MANAGER con refundMethod CASH ⇒ pasa', async () => {
    expect(await correr(StaffRole.MANAGER, { amount: 5000, refundMethod: 'CASH' })).toEqual({ next: true })
  })

  it('la ruta tiene UNA sola revisión de permiso, justo antes del controlador', () => {
    const capa = (mobileRouter as any).stack.find(
      (l: any) => l.route?.path === '/venues/:venueId/payments/:paymentId/refund' && l.route.methods.post,
    )
    const handlers = capa.route.stack.map((rl: any) => rl.handle)
    const conPermiso = handlers.filter((h: any) => typeof h.requiredPermission === 'string')
    expect(conPermiso).toEqual([permisoDeReembolso])
    expect((permisoDeReembolso as any).requiredPermission).toBe('payments:refund')
    expect(handlers.indexOf(permisoDeReembolso)).toBe(handlers.length - 2)
  })
})
