/**
 * Editar/borrar los permisos de un rol se autoriza con el rol REAL en ESE venue (el que dejó
 * `checkPermission` en `req.resolvedRole`), nunca con el del token (Codex H8, 24-sep).
 *
 * El token lleva el rol del venue en el que se emitió: un OWNER del venue A que es MANAGER en B
 * podía borrar en B los permisos personalizados de roles por encima de MANAGER.
 */
const borrar = jest.fn()
const actualizar = jest.fn()
jest.mock('../../../../src/services/dashboard/rolePermission.service', () => ({
  ...jest.requireActual('../../../../src/services/dashboard/rolePermission.service'),
  deleteRolePermissions: (...a: unknown[]) => borrar(...a),
  updateRolePermissions: (...a: unknown[]) => actualizar(...a),
}))

import {
  deleteRolePermissions,
  getRoleHierarchyInfo,
  updateRolePermissions,
} from '../../../../src/controllers/dashboard/rolePermission.controller'

function res() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
}

beforeEach(() => {
  jest.clearAllMocks()
  borrar.mockResolvedValue({ ok: true })
  actualizar.mockResolvedValue({ isCustom: true })
})

it('🔴 borrar usa el rol resuelto en el venue (MANAGER), no el del token (OWNER)', async () => {
  const req = {
    params: { venueId: 'venue-B', role: 'ADMIN' },
    authContext: { userId: 'u1', role: 'OWNER', venueId: 'venue-A' },
    resolvedRole: 'MANAGER',
  } as any
  await deleteRolePermissions(req, res(), jest.fn())
  expect(borrar).toHaveBeenCalledWith('venue-B', 'ADMIN', 'MANAGER')
})

it('🔴 sin rol resuelto se rechaza: nunca cae al rol del token', async () => {
  const next = jest.fn()
  const req = { params: { venueId: 'venue-B', role: 'ADMIN' }, authContext: { userId: 'u1', role: 'OWNER' } } as any
  await deleteRolePermissions(req, res(), next)
  expect(borrar).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledWith(expect.any(Error))
})

it('🔴 actualizar tampoco cae al rol del token si falta el resuelto', async () => {
  const next = jest.fn()
  const req = {
    params: { venueId: 'venue-B', role: 'ADMIN' },
    body: { permissions: ['menu:read'] },
    authContext: { userId: 'u1', role: 'OWNER' },
  } as any
  await updateRolePermissions(req, res(), next)
  expect(actualizar).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledWith(expect.any(Error))
})

it('la jerarquía reporta los roles modificables según el rol resuelto', async () => {
  const r = res()
  const req = { authContext: { userId: 'u1', role: 'OWNER' }, resolvedRole: 'MANAGER' } as any
  await getRoleHierarchyInfo(req, r, jest.fn())
  expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userRole: 'MANAGER' }) }))
})
