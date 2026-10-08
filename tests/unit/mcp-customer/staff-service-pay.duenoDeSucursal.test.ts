// tests/unit/mcp-customer/staff-service-pay.duenoDeSucursal.test.ts — fase 3, B14-fix ronda 1 (R5; intención del founder: «si es
// owner, que avise»): para las acciones de toda la organización desde una conexión limitada (B14-fix2), DUEÑO es también quien
// tiene rol OWNER en TODAS las sedes que la acción abarca, aunque no tenga membresía de la organización (cuentas viejas, como la de
// Mindform). OWNER en A y B, conexión sólo de A ⇒ aviso, no negativa; OWNER sólo en A ⇒ negativa. Se revalida al confirmar.
// La regla (`revisarConexion`/`confirmarConexion`) y la lectura (`esDueno`) son las reales; la base va simulada (la consulta real,
// en `tests/integration/staffPay/mcp.duenoDeSucursal.test.ts`).
import type { McpScope } from '../../../src/mcp/scope'
import { esDueno } from '../../../src/mcp/tools/staffPay.alcanceDeLaAccion'
import { confirmarConexion, huellaConFuera, revisarConexion } from '../../../src/mcp/tools/staffPay.conexion'

const mockCount = jest.fn()
const mockDuenoOrg = jest.fn()
const NOMBRES: Record<string, string> = { A: 'Prado Norte', B: 'Bosques' }

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { count: (...a: unknown[]) => mockCount(...a) },
    venue: {
      findMany: async (q: { where: { id: { in: string[] } } }) =>
        q.where.id.in.filter(id => NOMBRES[id]).map(id => ({ id, name: NOMBRES[id] })),
    },
  },
}))
jest.mock('@/services/staffOrganization.service', () => ({ esDuenoDeLaOrganizacion: (...a: unknown[]) => mockDuenoOrg(...a) }))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({ sedesConServicePay: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/participacion', () => ({ sedesConVentana: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/cierre.alcance', () => ({ alcanceDelPreview: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/recibos.service', () => ({ sedesDeRecibo: jest.fn() }))

const soloA = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['A'] } as unknown as McpScope
/** Cuántas de las sedes pedidas tiene como OWNER activa en la organización (lo que contesta la base). */
const ownerEn = (sedes: string[]) =>
  mockCount.mockImplementation(
    async (q: { where: { venueId: { in: string[] } } }) => q.where.venueId.in.filter(v => sedes.includes(v)).length,
  )
const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeEach(() => {
  jest.clearAllMocks()
  mockDuenoOrg.mockResolvedValue(false) // sin membresía de la organización (la regla única dice «no»)
})

describe('R5: dueño de TODAS las sedes que abarca la acción', () => {
  it('OWNER en A y B sin membresía, conexión sólo de A ⇒ dueño: aviso con B, no negativa', async () => {
    ownerEn(['A', 'B'])
    const r = await revisarConexion(soloA, 'cierre', ['A', 'B'])
    expect(r.negada).toBeNull()
    expect(r.fuera).toEqual([{ venueId: 'B', nombre: 'Bosques' }])
    expect(r.aviso).toBe(
      'Ojo: esta conexión es sólo de Prado Norte, pero el cierre de este periodo incluye también Bosques. Si confirmas, se cierran todas.',
    )
    // La consulta: OWNER ACTIVA, en las sedes de la acción (todas, sin repetir), dentro de la organización de la conexión.
    expect(mockCount).toHaveBeenCalledWith({
      where: { staffId: 's1', active: true, role: 'OWNER', venueId: { in: ['A', 'B'] }, venue: { organizationId: 'o1' } },
    })
  })

  it('OWNER sólo en A ⇒ no es dueño: FUERA_DE_LA_CONEXION sin datos de B', async () => {
    ownerEn(['A'])
    const r = await revisarConexion(soloA, 'cierre', ['A', 'B'])
    expect(r.aviso).toBe('')
    expect(json(r.negada!)).toEqual({
      ok: false,
      code: 'FUERA_DE_LA_CONEXION',
      error:
        'Esta acción incluye Bosques, que no está en esta conexión. Hazla desde el dashboard o con una conexión que incluya todas las sedes.',
    })
  })

  it('OWNER sólo en la sede de FUERA (B) tampoco basta: tienen que ser TODAS las que abarca', async () => {
    ownerEn(['B'])
    expect(await esDueno(soloA, ['A', 'B'])).toBe(false)
    expect((await revisarConexion(soloA, 'pagado', ['A', 'B'])).negada).not.toBeNull()
  })

  it('se revalida al confirmar: OWNER en A y B en la vista previa, sólo en A al confirmar ⇒ negativa, nada que escribir', async () => {
    ownerEn(['A', 'B'])
    const vista = await revisarConexion(soloA, 'cierre', ['A', 'B'])
    const huella = huellaConFuera('h'.repeat(64), vista.fuera)
    ownerEn(['A'])
    const c = await confirmarConexion(soloA, 'cierre', ['A', 'B'], huella)
    expect('respuesta' in c && c.respuesta && json(c.respuesta)).toMatchObject({ ok: false, code: 'FUERA_DE_LA_CONEXION' })
    // Y siguiendo de dueño, confirma con la huella del service.
    ownerEn(['A', 'B'])
    expect(await confirmarConexion(soloA, 'cierre', ['A', 'B'], huella)).toMatchObject({ respuesta: null, huella: 'h'.repeat(64) })
  })

  it('las otras dos formas de ser dueño siguen igual: SUPERADMIN y la regla única de la organización (sin preguntar las sedes)', async () => {
    ownerEn([])
    expect(await esDueno({ ...soloA, isSuperAdmin: true } as McpScope, ['A', 'B'])).toBe(true)
    expect(mockDuenoOrg).not.toHaveBeenCalled()
    mockDuenoOrg.mockResolvedValue(true)
    expect(await esDueno(soloA, ['A', 'B'])).toBe(true)
    expect(mockDuenoOrg).toHaveBeenCalledWith('s1', 'o1')
    expect(mockCount).not.toHaveBeenCalled()
  })

  it('sin sedes que revisar no hay dueño de sucursal (nunca «todas» de una lista vacía)', async () => {
    ownerEn(['A'])
    expect(await esDueno(soloA, [])).toBe(false)
    expect(mockCount).not.toHaveBeenCalled()
  })

  it('sedes repetidas cuentan una vez', async () => {
    ownerEn(['A', 'B'])
    expect(await esDueno(soloA, ['B', 'A', 'B'])).toBe(true)
    expect(mockCount).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ venueId: { in: ['B', 'A'] } }) }))
  })
})
