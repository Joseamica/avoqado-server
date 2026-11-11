/**
 * Retiro de caja con PIN de gerente (v4). Corre el `checkPermission` REAL de la ruta con los permisos de fábrica
 * (sólo la base va simulada). Molde: `mobile.giftCards.pinDeGerente.test.ts`; aquí la ruta lleva DOS `checkPermission`
 * (`payments:create` y `cash-drawer:pay-out`).
 */
const mockStaffVenueFindUnique = jest.fn()
const mockConsumeOverride = jest.fn()
const mockBuscarRetiro = jest.fn()

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
jest.mock('@/services/mobile/cash-drawer.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/cash-drawer.mobile.service'),
  buscarRetiroPorLlave: (...a: unknown[]) => mockBuscarRetiro(...a),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import { devolverRetiroYaRegistrado } from '@/controllers/mobile/cash-drawer.mobile.controller'
import { ponerLlaveDelRetiro } from '@/lib/llaveDelRetiro'

const RUTA = '/venues/:venueId/cash-drawer/pay-out'
const URL = '/api/v1/mobile/venues/v1/cash-drawer/pay-out'

const cadena = (ruta: string) => {
  const capa = (mobileRouter as any).stack.find((l: any) => l.route?.path === ruta && l.route.methods.post)
  return capa.route.stack.map((rl: any) => rl.handle) as any[]
}

/** Corre la cadena desde `devolverRetiroYaRegistrado` en adelante (el JWT ya está en authContext). */
async function correr(role: StaffRole, body: object, headers: Record<string, string> = {}) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: 'POST',
    originalUrl: URL,
    params: { venueId: 'v1' },
    headers,
    body,
    authContext: { userId: 'u1', venueId: 'v1', role },
  }
  const out: { status?: number; json?: any; llego: boolean; autorizo?: string } = { llego: false }
  const res: any = { status: (s: number) => ((out.status = s), res), json: (j: unknown) => ((out.json = j), res) }
  const handlers = cadena(RUTA)
  const desde = handlers.indexOf(devolverRetiroYaRegistrado)
  const pasos = handlers.slice(desde, handlers.length - 1) // sin el controlador final
  for (const h of pasos) {
    let avanzo = false
    await h(req, res, (err?: unknown) => {
      if (err) throw err
      avanzo = true
    })
    if (!avanzo) return out
  }
  out.llego = true
  out.autorizo = req.authContext.overrideAuthorizedBy
  return out
}

beforeEach(() => {
  jest.clearAllMocks()
  mockBuscarRetiro.mockResolvedValue(null)
})

describe('POST /cash-drawer/pay-out con PIN de gerente', () => {
  it('orden de la cadena: permiso base, atajo, llave, permiso del retiro, controlador', () => {
    const h = cadena(RUTA)
    const permisos = h.filter(x => typeof x.requiredPermission === 'string').map(x => x.requiredPermission)
    expect(permisos).toEqual(['payments:create', 'cash-drawer:pay-out'])
    const i = (f: unknown) => h.indexOf(f)
    expect(h[i(devolverRetiroYaRegistrado) - 1].requiredPermission).toBe('payments:create')
    expect(i(ponerLlaveDelRetiro)).toBe(i(devolverRetiroYaRegistrado) + 1)
    expect(h[i(ponerLlaveDelRetiro) + 1].requiredPermission).toBe('cash-drawer:pay-out')
  })

  it('el gerente pasa sin token', async () => {
    const out = await correr(StaffRole.MANAGER, { localId: 'loc-1', amount: 5000 })
    expect(out.llego).toBe(true)
    expect(mockConsumeOverride).not.toHaveBeenCalled()
  })

  it('el cajero sin token recibe 403 overridable', async () => {
    const out = await correr(StaffRole.CASHIER, { localId: 'loc-1', amount: 5000 })
    expect(out.llego).toBe(false)
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'cash-drawer:pay-out', overridable: true })
  })

  it('el cajero con la atada a ESE retiro pasa y se sabe quién autorizó', async () => {
    mockConsumeOverride.mockResolvedValue({ authorizedById: 'sv-gerente' })
    const out = await correr(StaffRole.CASHIER, { localId: 'loc-1', amount: 5000 }, { 'x-permission-override': 'tok' })
    expect(out).toMatchObject({ llego: true, autorizo: 'sv-gerente' })
    expect(mockConsumeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok', permission: 'cash-drawer:pay-out', operationKey: 'pay-out:loc-1:500000' }),
    )
  })

  it('un token suelto no sirve aunque el cuerpo no traiga llave', async () => {
    mockConsumeOverride.mockResolvedValue(null)
    const out = await correr(StaffRole.CASHIER, { amount: 5000 }, { 'x-permission-override': 'suelto' })
    expect(out.llego).toBe(false)
    expect(out.status).toBe(403)
    expect(mockConsumeOverride).toHaveBeenCalledWith(expect.objectContaining({ operationKey: 'pay-out:sin-llave' }))
  })

  it('un retiro ya registrado se devuelve 200 sin consumir nada aunque la autorización haya vencido', async () => {
    mockBuscarRetiro.mockResolvedValue({ id: 'e1', type: 'PAY_OUT', localId: 'loc-1' })
    const out = await correr(StaffRole.CASHIER, { localId: 'loc-1', amount: 5000 }, { 'x-permission-override': 'vencido' })
    expect(out.status).toBe(200)
    expect(out.json).toEqual({ success: true, data: { id: 'e1', type: 'PAY_OUT', localId: 'loc-1' }, authorizedBy: null })
    expect(mockBuscarRetiro).toHaveBeenCalledWith('v1', 'loc-1')
    expect(mockConsumeOverride).not.toHaveBeenCalled()
  })

  it('/sync marca `puedeRetirar` según el permiso del retiro (cajero no, gerente sí)', async () => {
    const h = cadena('/venues/:venueId/cash-drawer/sync')
    const permisos = h.filter(x => typeof x.requiredPermission === 'string').map(x => x.requiredPermission)
    expect(permisos).toEqual(['payments:create'])
    const marca = h[h.findIndex(x => x.requiredPermission === 'payments:create') + 1] // la capa que sigue al permiso base
    for (const [role, esperado] of [
      [StaffRole.CASHIER, false],
      [StaffRole.MANAGER, true],
    ] as const) {
      mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
      const req: any = { params: { venueId: 'v1' }, authContext: { userId: 'u1', venueId: 'v1', role } }
      await marca(req, {}, () => {})
      expect(req.puedeRetirar).toBe(esperado)
    }
  })

  it('pay-in sigue con payments:create', () => {
    const permisos = cadena('/venues/:venueId/cash-drawer/pay-in')
      .filter(x => typeof x.requiredPermission === 'string')
      .map(x => x.requiredPermission)
    expect(permisos).toEqual(['payments:create'])
  })
})
