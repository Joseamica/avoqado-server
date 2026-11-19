/**
 * 🔴 F1 · Codex android r2 #8: para `payments:reconcile-uncharged` la negativa del PIN no puede revelar si el PIN es de un empleado
 * activo. «PIN desconocido» y «empleado sin autoridad» contestan IDÉNTICO (403 `SUPERVISOR_AUTHORIZATION_REQUIRED`), con el switch
 * del PIN de gerente encendido o apagado. Sólo la Bitácora distingue el motivo, y nunca guarda el PIN.
 *
 * Controlador y servicio REALES; sólo la base va simulada.
 */
import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createOverride } from '@/controllers/mobile/permission-override.mobile.controller'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    permissionOverride: { create: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const NO_SE_COBRO = 'payments:reconcile-uncharged'
const PIN = '987654'
const miembro = (role: StaffRole) => ({
  id: `sv_${role.toLowerCase()}`,
  role,
  permissionSetId: null,
  permissionSet: null,
  staff: { firstName: 'Ana', lastName: 'Ruiz' },
})

async function responder(opts: { permission: string; switchOn: boolean; dueno: ReturnType<typeof miembro> | null; extras?: string[] }) {
  jest.clearAllMocks()
  ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({ id: 'sv_sesion' })
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(opts.dueno)
  ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: opts.switchOn })
  ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(
    opts.extras ? { permissions: opts.extras, deniedPermissions: [] } : null,
  )
  ;(prisma.permissionOverride.create as jest.Mock).mockImplementation(async ({ data }: any) => data)
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  const next: NextFunction = jest.fn()
  const req = {
    params: { venueId: 'venue_1' },
    body: { pin: PIN, permission: opts.permission },
    authContext: { userId: 'user_cajera', venueId: 'venue_1', role: 'CASHIER' },
    ip: '10.0.0.1',
    get: () => 'test-agent',
  } as unknown as Request
  await createOverride(req, res as Response, next)
  expect(next).not.toHaveBeenCalled()
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] }
}

describe('F1 · negativa del PIN que firma «no se cobró»', () => {
  it('pinDesconocidoYSinAutoridad_mismaRespuesta', async () => {
    const casos = [
      { switchOn: true, dueno: null },
      { switchOn: false, dueno: null },
      // Cajero al que el negocio le agregó el permiso: lo tiene, pero no es gerente.
      { switchOn: true, dueno: miembro(StaffRole.CASHIER), extras: [NO_SE_COBRO] },
      { switchOn: false, dueno: miembro(StaffRole.CASHIER), extras: [NO_SE_COBRO] },
      // Mesero sin el permiso.
      { switchOn: true, dueno: miembro(StaffRole.WAITER) },
      { switchOn: false, dueno: miembro(StaffRole.WAITER) },
    ]
    const respuestas = []
    for (const c of casos) respuestas.push(await responder({ permission: NO_SE_COBRO, ...c }))

    expect(respuestas[0]).toEqual({
      status: 403,
      body: { success: false, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED', message: 'Ese PIN no es de un gerente con permiso' },
    })
    for (const r of respuestas) expect(r).toEqual(respuestas[0])
    expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
  })

  it('sólo la Bitácora distingue el motivo, sin el PIN: el sin autoridad queda anotado; el desconocido, como hoy, no', async () => {
    await responder({ permission: NO_SE_COBRO, switchOn: false, dueno: miembro(StaffRole.CASHIER), extras: [NO_SE_COBRO] })
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PERMISSION_OVERRIDE_INSUFFICIENT',
        entityId: NO_SE_COBRO,
        data: expect.objectContaining({ authorizedByStaffVenueId: 'sv_cashier', authorizerRole: StaffRole.CASHIER }),
      }),
    )
    expect(JSON.stringify((logAction as jest.Mock).mock.calls[0][0])).not.toContain(PIN)

    await responder({ permission: NO_SE_COBRO, switchOn: true, dueno: null })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('control: el gerente sí firma, con el switch apagado', async () => {
    const r = await responder({ permission: NO_SE_COBRO, switchOn: false, dueno: miembro(StaffRole.MANAGER) })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ success: true, data: { authorizedBy: { id: 'sv_manager', name: 'Ana Ruiz' } } })
  })

  it('control: los demás permisos conservan sus respuestas (401 PIN desconocido · 403 insuficiente · 403 apagado)', async () => {
    expect(await responder({ permission: 'orders:merge', switchOn: true, dueno: null })).toEqual({
      status: 401,
      body: { success: false, code: 'OVERRIDE_INVALID_PIN', message: 'Código incorrecto' },
    })
    expect(await responder({ permission: 'orders:merge', switchOn: true, dueno: miembro(StaffRole.WAITER) })).toEqual({
      status: 403,
      body: { success: false, code: 'OVERRIDE_INSUFFICIENT', message: 'Ese código tampoco tiene este permiso' },
    })
    expect(await responder({ permission: 'orders:merge', switchOn: false, dueno: miembro(StaffRole.MANAGER) })).toMatchObject({
      status: 403,
      body: { code: 'OVERRIDE_DISABLED' },
    })
  })
})
