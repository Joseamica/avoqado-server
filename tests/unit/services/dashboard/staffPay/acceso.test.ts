import fs from 'fs'
import path from 'path'
import { prismaMock } from '@tests/__helpers__/setup'
import { COMO_SE_CONSIGUE_EL_PLAN } from '@/services/dashboard/staffPay/textos'

const mockPlan = jest.fn()
const mockLote = jest.fn()
const mockGetUserAccess = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockPlan(...a),
  // El lote replica la regla de una sede (basePlan.service): aquí, sobre el mismo mock.
  venuesWithFeatureAccess: async (ids: string[], code: string) => {
    mockLote(ids, code)
    const s = new Set<string>()
    for (const id of ids) if (await mockPlan(id, code)) s.add(id)
    return s
  },
}))
jest.mock('@/services/access/access.service', () => ({
  getUserAccess: (...a: unknown[]) => mockGetUserAccess(...a),
  hasPermission: (access: { corePermissions: string[] }, p: string) => access.corePermissions.includes(p),
}))

import {
  assertPermisoEnSedes,
  assertPermisoEnTodasLasSedes,
  exigirPermisoEnSedes,
  MENSAJE_SIN_ACTIVAR,
  organizacionActivada,
  organizacionDeLaSedeActivada,
  sedesConPermiso,
  sedesConServicePay,
  sedesLegibles,
  sedesLegiblesDe,
  venueHasServicePayAccess,
} from '@/services/dashboard/staffPay/acceso'

describe('acceso — feature nueva', () => {
  beforeEach(() => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'pn' }, { id: 'bsf' }])
    mockPlan.mockResolvedValue(true)
  })

  it('el gate es la función SERVICE_PAY del plan, nunca el módulo', async () => {
    mockPlan.mockResolvedValueOnce(false)
    await expect(venueHasServicePayAccess('pn')).resolves.toBe(false)
    expect(mockPlan).toHaveBeenCalledWith('pn', 'SERVICE_PAY')
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
    mockPlan.mockResolvedValue(false)
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

describe('acceso — tope de sedes con el módulo (Codex bloque A #2): nunca recorta en silencio', () => {
  const ids = (n: number, desde = 0) => Array.from({ length: n }, (_, i) => ({ id: `v${String(desde + i).padStart(4, '0')}` }))
  beforeEach(() => {
    prismaMock.venue.findMany.mockReset()
    mockPlan.mockReset()
  })

  it('con más de 500 sedes con el módulo se niega con la explicación, en vez de cerrar sin la 501', async () => {
    prismaMock.venue.findMany.mockResolvedValueOnce(ids(500)).mockResolvedValueOnce(ids(1, 500)).mockResolvedValue([])
    mockPlan.mockResolvedValue(true)
    await expect(sedesConServicePay('org1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'DEMASIADAS_SEDES',
      message: expect.stringMatching(/más de 500 sedes con Pago por servicio en su plan.*contacta a Avoqado/),
    })
  })

  it('más de 500 sedes en la organización pero pocas con el módulo: las recorre todas y devuelve sólo esas', async () => {
    prismaMock.venue.findMany.mockResolvedValueOnce(ids(500)).mockResolvedValueOnce(ids(100, 500)).mockResolvedValue([])
    mockPlan.mockImplementation(async (id: string) => ['v0003', 'v0560'].includes(id))
    await expect(sedesConServicePay('org1')).resolves.toEqual(['v0003', 'v0560'])
    // Por páginas con cursor (id), cada una acotada; sin una consulta de módulo por sede.
    expect(prismaMock.venue.findMany.mock.calls[1][0]).toMatchObject({ where: { organizationId: 'org1', id: { gt: 'v0499' } } })
    for (const [arg] of prismaMock.venue.findMany.mock.calls) expect(arg?.take).toBeLessThanOrEqual(501)
  })
})

describe('acceso — fase 3: el plan en lote y la activación (spec §7.1, §10)', () => {
  it('las sedes del alcance salen del plan, resuelto en UN lote por página', async () => {
    mockLote.mockClear()
    prismaMock.venue.findMany.mockReset()
    prismaMock.venue.findMany.mockResolvedValueOnce([{ id: 'bsf' }, { id: 'pn' }]).mockResolvedValue([])
    mockPlan.mockImplementation(async (id: string) => id === 'pn')
    await expect(sedesConServicePay('org1')).resolves.toEqual(['pn'])
    expect(mockLote).toHaveBeenCalledTimes(1)
    expect(mockLote).toHaveBeenCalledWith(['bsf', 'pn'], 'SERVICE_PAY')
  })

  it('activada = la organización tiene fecha de inicio; desde una sede se resuelve su organización', async () => {
    prismaMock.organization.findUnique.mockResolvedValueOnce({ staffPayStartDate: null })
    await expect(organizacionActivada('org1')).resolves.toBe(false)
    prismaMock.organization.findUnique.mockResolvedValueOnce({ staffPayStartDate: new Date('2026-10-01T06:00:00Z') })
    await expect(organizacionActivada('org1')).resolves.toBe(true)
    expect(prismaMock.organization.findUnique).toHaveBeenLastCalledWith({ where: { id: 'org1' }, select: { staffPayStartDate: true } })

    prismaMock.venue.findUnique.mockResolvedValueOnce({ organizationId: 'org1' })
    prismaMock.organization.findUnique.mockResolvedValueOnce({ staffPayStartDate: new Date('2026-10-01T06:00:00Z') })
    await expect(organizacionDeLaSedeActivada('pn')).resolves.toBe(true)
    prismaMock.venue.findUnique.mockResolvedValueOnce(null)
    await expect(organizacionDeLaSedeActivada('nadie')).resolves.toBe(false)
  })

  it('el mensaje de «sin activar» dice qué falta, dónde se prende y a quién pedírselo, con un solo nombre', () => {
    expect(MENSAJE_SIN_ACTIVAR).toMatch(/no está activado/)
    expect(MENSAJE_SIN_ACTIVAR).toMatch(/Periodos/)
    // Activar pide staffpay:close en TODAS las sedes con el plan (activacion.service): quien no lo tiene sabe a quién ir.
    expect(MENSAJE_SIN_ACTIVAR).toMatch(/cerrar periodos en todas las sucursales/)
    expect(MENSAJE_SIN_ACTIVAR).toMatch(/pídeselo al dueño del negocio/)
    expect(MENSAJE_SIN_ACTIVAR).not.toMatch(/Pago por servicio/) // el nombre visible es «Pago al personal» (resolución 14)
  })

  it('«cómo se consigue el plan» se escribe UNA sola vez en el server (revisión de C2): las rutas, el MCP y los servicios la importan', () => {
    const SRC = path.join(__dirname, '../../../../../src')
    const archivos = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const full = path.join(dir, e.name)
        return e.isDirectory() ? archivos(full) : e.name.endsWith('.ts') ? [full] : []
      })
    const conLaFrase = archivos(SRC)
      .filter(f => fs.readFileSync(f, 'utf8').includes('se contrata suelto por sucursal'))
      .map(f => path.relative(SRC, f))
    expect(conLaFrase).toEqual(['services/dashboard/staffPay/textos.ts'])
    expect(COMO_SE_CONSIGUE_EL_PLAN).toBe('viene en el plan Pro o se contrata suelto por sucursal')
  })

  it('sin ninguna sede con el plan, una operación de organización se niega y dice cómo se consigue', async () => {
    prismaMock.venue.findMany.mockReset()
    prismaMock.venue.findMany.mockResolvedValueOnce([{ id: 'pn' }]).mockResolvedValue([])
    mockPlan.mockResolvedValue(false)
    await expect(assertPermisoEnTodasLasSedes('u1', 'org1', 'staffpay:close')).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/viene en el plan Pro o se contrata suelto por sucursal/),
    })
  })
})
