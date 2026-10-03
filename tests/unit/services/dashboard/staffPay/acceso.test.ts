import { prismaMock } from '@tests/__helpers__/setup'

const mockIsModuleEnabled = jest.fn()
const mockGetUserAccess = jest.fn()
jest.mock('@/services/modules/module.service', () => ({
  MODULE_CODES: { SERVICE_PAY: 'SERVICE_PAY' },
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockIsModuleEnabled(...a) },
}))
jest.mock('@/services/access/access.service', () => ({
  getUserAccess: (...a: unknown[]) => mockGetUserAccess(...a),
  hasPermission: (access: { corePermissions: string[] }, p: string) => access.corePermissions.includes(p),
}))

import { assertPermisoEnTodasLasSedes, sedesLegibles, venueHasServicePayAccess } from '@/services/dashboard/staffPay/acceso'

describe('acceso — feature nueva', () => {
  beforeEach(() => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'pn' }, { id: 'bsf' }])
    mockIsModuleEnabled.mockResolvedValue(true)
  })

  it('el gate es el módulo SERVICE_PAY', async () => {
    mockIsModuleEnabled.mockResolvedValueOnce(false)
    await expect(venueHasServicePayAccess('pn')).resolves.toBe(false)
    expect(mockIsModuleEnabled).toHaveBeenCalledWith('pn', 'SERVICE_PAY')
  })

  it('una operación de organización exige el permiso en TODAS las sedes con el módulo', async () => {
    mockGetUserAccess.mockImplementation(async (_u: string, v: string) => ({ corePermissions: v === 'pn' ? ['staffpay:manage'] : [] }))
    await expect(assertPermisoEnTodasLasSedes('u1', 'org1', 'staffpay:manage')).rejects.toThrow('todas las sedes')
  })

  it('sin membresía en una sede (getUserAccess lanza) también se niega', async () => {
    mockGetUserAccess.mockImplementation(async (_u: string, v: string) => {
      if (v === 'bsf') throw new Error('no membership')
      return { corePermissions: ['staffpay:manage'] }
    })
    await expect(assertPermisoEnTodasLasSedes('u1', 'org1', 'staffpay:manage')).rejects.toThrow('todas las sedes')
  })

  it('lectura: devuelve sólo las sedes legibles y marca parcial', async () => {
    mockGetUserAccess.mockImplementation(async (_u: string, v: string) => ({ corePermissions: v === 'pn' ? ['staffpay:read'] : [] }))
    await expect(sedesLegibles('u1', 'org1')).resolves.toEqual({ venueIds: ['pn'], parcial: true })
  })
})

describe('acceso — regresión', () => {
  it('una organización sin sedes con el módulo no autoriza nada', async () => {
    prismaMock.venue.findMany.mockResolvedValue([])
    await expect(assertPermisoEnTodasLasSedes('u1', 'org1', 'staffpay:manage')).rejects.toThrow()
  })
})
