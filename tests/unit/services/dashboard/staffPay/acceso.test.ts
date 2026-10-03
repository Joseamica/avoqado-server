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

import {
  assertPermisoEnSedes,
  assertPermisoEnTodasLasSedes,
  exigirPermisoEnSedes,
  sedesConPermiso,
  sedesLegibles,
  sedesLegiblesDe,
  venueHasServicePayAccess,
} from '@/services/dashboard/staffPay/acceso'

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

describe('acceso — fase 2: assertPermisoEnSedes y sedesLegiblesDe', () => {
  it('pasa con permiso en todas y falla con la explicación si falta en una', async () => {
    mockGetUserAccess.mockImplementation(async (_u: string, v: string) => ({
      corePermissions: v === 'v2' ? ['staffpay:read'] : ['staffpay:read', 'staffpay:close'],
    }))
    await expect(assertPermisoEnSedes('u', ['v1'], 'staffpay:close', 'falta')).resolves.toBeUndefined()
    await expect(assertPermisoEnSedes('u', ['v1', 'v2'], 'staffpay:close', 'Necesitas cerrar en todas')).rejects.toThrow(
      'Necesitas cerrar en todas',
    )
  })
  it('sin membresía en una sede (getUserAccess lanza) también se niega', async () => {
    mockGetUserAccess.mockImplementation(async (_u: string, v: string) => {
      if (v === 'v2') throw new Error('no membership')
      return { corePermissions: ['staffpay:close'] }
    })
    await expect(assertPermisoEnSedes('u', ['v1', 'v2'], 'staffpay:close', 'Necesitas cerrar en todas')).rejects.toThrow(
      'Necesitas cerrar en todas',
    )
  })
  it('sedesLegiblesDe filtra el alcance del PERIODO por permiso, aunque la sede ya no tenga el módulo (Codex R1-1)', async () => {
    // Lo histórico no depende del módulo de hoy: el módulo «apagado» no cambia el resultado.
    mockIsModuleEnabled.mockResolvedValue(false)
    mockGetUserAccess.mockImplementation(async (_u: string, v: string) => ({ corePermissions: v === 'pn' ? ['staffpay:read'] : [] }))
    await expect(sedesLegiblesDe('u', ['bsf', 'pn'])).resolves.toEqual({ venueIds: ['pn'], parcial: true })
  })
})

describe('acceso — permisos resueltos ANTES de una transacción (revisión A8, Importante 2)', () => {
  it('sedesConPermiso devuelve sólo las sedes con el permiso, sin repetidas y sin las que no tienen membresía', async () => {
    mockGetUserAccess.mockImplementation(async (_u: string, v: string) => {
      if (v === 'x') throw new Error('no membership')
      return { corePermissions: v === 'bsf' ? ['staffpay:read'] : ['staffpay:close'] }
    })
    await expect(sedesConPermiso('u', ['pn', 'bsf', 'x', 'pn'], 'staffpay:close')).resolves.toEqual(['pn'])
  })
  it('exigirPermisoEnSedes (pura) pasa con todas dentro y niega con la explicación si falta una', () => {
    expect(() => exigirPermisoEnSedes(new Set(['pn', 'bsf']), ['pn'], 'falta')).not.toThrow()
    expect(() => exigirPermisoEnSedes(new Set(['pn']), ['pn', 'bsf'], 'Necesitas cerrar en todas')).toThrow(
      expect.objectContaining({ statusCode: 403, message: 'Necesitas cerrar en todas' }),
    )
  })
})
