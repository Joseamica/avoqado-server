/** La regla: superadmin real, o pertenecer al negocio Y tener `venues:manage` ahí. */
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminReal: jest.fn() }))
jest.mock('@/services/staffOrganization.service', () => ({ userHasVenueAccess: jest.fn() }))
jest.mock('@/services/access/access.service', () => ({ getUserAccess: jest.fn(), hasPermission: jest.fn() }))

import { esSuperadminReal } from '@/services/access/rolVigente'
import { userHasVenueAccess } from '@/services/staffOrganization.service'
import { getUserAccess, hasPermission } from '@/services/access/access.service'
import { puedeAdministrarCobros } from '@/services/access/permisoDeCobros'

beforeEach(() => {
  jest.clearAllMocks()
  ;(esSuperadminReal as jest.Mock).mockResolvedValue(false)
  ;(userHasVenueAccess as jest.Mock).mockResolvedValue(true)
  ;(getUserAccess as jest.Mock).mockResolvedValue({ role: 'WAITER', corePermissions: [] })
  ;(hasPermission as jest.Mock).mockReturnValue(false)
})

it('🔴 pertenecer al negocio NO basta: sin venues:manage, no', async () => {
  expect(await puedeAdministrarCobros('s', 'v')).toBe(false)
  expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'venues:manage')
})

it('con venues:manage en ese negocio, sí', async () => {
  ;(hasPermission as jest.Mock).mockReturnValue(true)
  expect(await puedeAdministrarCobros('s', 'v')).toBe(true)
  expect(getUserAccess).toHaveBeenCalledWith('s', 'v')
})

it('sin pertenecer al negocio, no (aunque tuviera el permiso en otro)', async () => {
  ;(userHasVenueAccess as jest.Mock).mockResolvedValue(false)
  ;(hasPermission as jest.Mock).mockReturnValue(true)
  expect(await puedeAdministrarCobros('s', 'v')).toBe(false)
})

it('superadmin real, sí', async () => {
  ;(esSuperadminReal as jest.Mock).mockResolvedValue(true)
  expect(await puedeAdministrarCobros('s', 'v')).toBe(true)
})

it('si resolver los permisos falla, NO (falla cerrado)', async () => {
  ;(getUserAccess as jest.Mock).mockRejectedValue(new Error('db'))
  expect(await puedeAdministrarCobros('s', 'v')).toBe(false)
})
