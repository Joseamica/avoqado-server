/**
 * 1b S4 (Q16): cambiar el destino y mostrar el código otro día son de GERENTE, y por eso viven en rutas con
 * `checkPermission('giftCards:manage')`: es el único lugar que honra el PIN del gerente (`x-permission-override`). El cajero
 * sin PIN recibe el 403 con `overridable: true` (la app abre el teclado); con el PIN pasa con UN solo consumo y el controller
 * recibe quién autorizó.
 *
 * Corre el `checkPermission` REAL de la ruta con los permisos de fábrica (sólo la base va simulada). Molde:
 * `mobile.refundToCash.permisoCondicional.test.ts`.
 */
const mockStaffVenueFindUnique = jest.fn()
const mockConsumeOverride = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: async () => ({ active: true }) },
    staffVenue: { findFirst: async () => null, findUnique: (...a: unknown[]) => mockStaffVenueFindUnique(...a) },
    venue: { findUnique: async () => null },
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
import mobileRouter from '@/routes/mobile.routes'

/** El `checkPermission` que monta la ruta REAL (el único manejador con `requiredPermission`). */
function permisoDe(ruta: string) {
  const capa = (mobileRouter as any).stack.find((l: any) => l.route?.path === ruta && l.route.methods.post)
  const conPermiso = capa.route.stack.map((rl: any) => rl.handle).filter((h: any) => typeof h.requiredPermission === 'string')
  expect(conPermiso).toHaveLength(1)
  return conPermiso[0]
}

async function correr(ruta: string, url: string, role: StaffRole, headers: Record<string, string> = {}) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: 'POST',
    originalUrl: url,
    params: { venueId: 'v1', giftCardId: 'gc1' },
    headers,
    body: { operationKey: 'cambia-0001' },
    authContext: { userId: 'u1', venueId: 'v1', role },
  }
  const out: { status?: number; json?: any; next: boolean; autorizo?: string } = { next: false }
  const res: any = {
    status: (s: number) => ((out.status = s), res),
    json: (j: unknown) => ((out.json = j), res),
  }
  await permisoDe(ruta)(req, res, () => {
    out.next = true
    out.autorizo = req.authContext.overrideAuthorizedBy
  })
  return out
}

beforeEach(() => jest.clearAllMocks())

describe.each([
  ['change-destination', '/venues/:venueId/gift-cards/:giftCardId/change-destination'],
  ['reveal-manager', '/venues/:venueId/gift-cards/:giftCardId/reveal-manager'],
])('Q16: %s acepta el PIN del gerente', (nombre, ruta) => {
  const url = `/api/v1/mobile/venues/v1/gift-cards/gc1/${nombre}`

  it('la ruta exige giftCards:manage', () => {
    expect(permisoDe(ruta).requiredPermission).toBe('giftCards:manage')
  })

  it('🔴 CASHIER sin encabezado ⇒ 403 con overridable: true (la app pide el PIN)', async () => {
    const out = await correr(ruta, url, StaffRole.CASHIER)
    expect(out.next).toBe(false)
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'giftCards:manage', overridable: true })
    expect(mockConsumeOverride).not.toHaveBeenCalled()
  })

  it('🔴 CASHIER con el PIN ⇒ llega al controller con quién autorizó, y el PIN se consume UNA vez para ESTA ruta', async () => {
    mockConsumeOverride.mockResolvedValue({ authorizedById: 'sv-gerente' })
    const out = await correr(ruta, url, StaffRole.CASHIER, { 'x-permission-override': 'tok' })
    expect(out).toMatchObject({ next: true, autorizo: 'sv-gerente' })
    expect(mockConsumeOverride).toHaveBeenCalledTimes(1)
    expect(mockConsumeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok', venueId: 'v1', permission: 'giftCards:manage', route: `POST ${url}` }),
    )
  })

  it('MANAGER sin encabezado ⇒ pasa', async () => {
    expect(await correr(ruta, url, StaffRole.MANAGER)).toMatchObject({ next: true })
    expect(mockConsumeOverride).not.toHaveBeenCalled()
  })
})
