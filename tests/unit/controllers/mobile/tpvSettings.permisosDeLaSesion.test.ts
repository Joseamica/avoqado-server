/**
 * GET /mobile/venues/:venueId/settings trae `permisosDeLaSesion`: la lista EFECTIVA de quien pregunta (la misma del login),
 * para que un POS con sesión vieja decida con los permisos vigentes. Aditivo y opcional: si la lectura falla, se omite.
 */
import type { Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import { resolveStaffVenuePermissions } from '@/lib/resolveEffectivePermissions'
import { getTpvSettings } from '@/services/dashboard/tpv.dashboard.service'

jest.mock('@/services/dashboard/tpv.dashboard.service', () => ({ getTpvSettings: jest.fn() }))
jest.mock('@/services/customer-display/posPollFingerprints', () => ({
  ...jest.requireActual('@/services/customer-display/posPollFingerprints'),
  collectPollFingerprints: jest.fn(async () => ({})),
}))

import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'

const venueId = 'venue-123'

function makeRes() {
  const res: any = {}
  res.json = jest.fn((b: any) => ((res.__json = b), res))
  res.status = jest.fn(() => res)
  return res as Response & { __json: any }
}

const req = { params: { venueId }, headers: {}, authContext: { userId: 'staff-1', venueId } } as unknown as Request

async function pedir() {
  const res = makeRes()
  await getVenueTpvSettings(req, res, jest.fn())
  return res.__json.data
}

describe('getVenueTpvSettings — permisosDeLaSesion', () => {
  beforeEach(() => {
    prismaMock.terminal.findMany.mockResolvedValue([])
    ;(getTpvSettings as jest.Mock).mockResolvedValue({})
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE', type: 'RESTAURANT' })
  })

  it('trae los permisos efectivos de quien pregunta', async () => {
    prismaMock.staffVenue.findUnique.mockResolvedValue({ role: 'MANAGER', active: true, staff: { active: true }, permissionSetId: null, permissionSet: null })
    prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
    expect((await pedir()).permisosDeLaSesion).toContain('cash-drawer:pay-out')

    prismaMock.staffVenue.findUnique.mockResolvedValue({ role: 'CASHIER', active: true, staff: { active: true }, permissionSetId: null, permissionSet: null })
    expect((await pedir()).permisosDeLaSesion).not.toContain('cash-drawer:pay-out')
  })

  it('si un negocio se lo quitó al gerente, no lo trae', async () => {
    prismaMock.staffVenue.findUnique.mockResolvedValue({ role: 'MANAGER', active: true, staff: { active: true }, permissionSetId: null, permissionSet: null })
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: [], deniedPermissions: ['cash-drawer:pay-out'] })
    expect((await pedir()).permisosDeLaSesion).not.toContain('cash-drawer:pay-out')
  })

  it('una membresía inactiva o una cuenta inactiva recibe [] (presente y vacío)', async () => {
    prismaMock.staffVenue.findUnique.mockResolvedValue({ role: 'MANAGER', active: false, staff: { active: true } })
    expect((await pedir()).permisosDeLaSesion).toEqual([])
    prismaMock.staffVenue.findUnique.mockResolvedValue({ role: 'MANAGER', active: true, staff: { active: false } })
    expect((await pedir()).permisosDeLaSesion).toEqual([])
  })

  it('con un Conjunto de Permisos asignado, la lista es la misma que da el login', async () => {
    const permissionSet = { id: 'ps1', permissions: ['cash-drawer:pay-out', 'orders:read'] }
    const sv = { role: 'CASHIER', active: true, staff: { active: true }, permissionSetId: 'ps1', permissionSet }
    prismaMock.staffVenue.findUnique.mockResolvedValue(sv)
    prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
    expect((await pedir()).permisosDeLaSesion).toEqual(resolveStaffVenuePermissions(sv as any, null))
  })

  it('si la lectura de permisos falla, se omite el campo y la respuesta sigue', async () => {
    prismaMock.staffVenue.findUnique.mockRejectedValue(new Error('db'))
    const data = await pedir()
    expect(data).not.toHaveProperty('permisosDeLaSesion')
    expect(data.terminals).toEqual([])
  })
})
