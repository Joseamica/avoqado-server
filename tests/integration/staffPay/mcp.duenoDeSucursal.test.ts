// tests/integration/staffPay/mcp.duenoDeSucursal.test.ts — fase 3, B14-fix ronda 1 (R5; intención del founder: «si es owner, que
// avise»), contra la base REAL: la cuenta vieja de Mindform (rol OWNER en `StaffVenue`, SIN membresía de la organización) es dueña
// para las acciones de toda la organización desde una conexión limitada si es OWNER en TODAS las sedes que la acción abarca. El
// dueño del mundo es OWNER sólo en A y no tiene membresía: conexión de A, acción sobre A y B ⇒ negativa; OWNER también en B ⇒
// aviso; esa fila inactiva o con otro rol ⇒ negativa otra vez. Al confirmar se vuelve a leer.
import prisma from '@/utils/prismaClient'
import type { McpScope } from '@/mcp/scope'
import { confirmarConexion, huellaConFuera, revisarConexion } from '@/mcp/tools/staffPay.conexion'
import { borrarMundo, crearMundo, crearSede, Mundo } from './_mundo'

let m: Mundo
let b: string
let scope: McpScope
beforeAll(async () => {
  m = await crearMundo('mcp-dueno-sucursal')
  b = (await crearSede(m.orgId, m.key, 'bosques')).venueId
  scope = { staffId: m.owner, activeOrg: m.orgId, allowedVenueIds: [m.venueId], perVenueAccess: new Map() }
})
afterAll(() => borrarMundo(m))

const codigo = (r: { content: Array<{ text: string }> } | null) => (r ? JSON.parse(r.content[0].text).code : null)
const filaEnB = () => prisma.staffVenue.findUnique({ where: { staffId_venueId: { staffId: m.owner, venueId: b } } })

describe('R5: dueño de sucursal en la base real', () => {
  it('sin membresía de la organización y OWNER sólo en A ⇒ FUERA_DE_LA_CONEXION', async () => {
    expect(await prisma.staffOrganization.count({ where: { staffId: m.owner } })).toBe(0)
    const r = await revisarConexion(scope, 'cierre', [m.venueId, b])
    expect(codigo(r.negada)).toBe('FUERA_DE_LA_CONEXION')
  })

  it('OWNER también en B ⇒ dueño: aviso con B y confirma con la huella del service', async () => {
    await prisma.staffVenue.create({ data: { staffId: m.owner, venueId: b, role: 'OWNER', active: true } })
    const r = await revisarConexion(scope, 'cierre', [m.venueId, b])
    expect(r.negada).toBeNull()
    expect(r.fuera).toEqual([{ venueId: b, nombre: `${m.key}-bosques` }])
    expect(r.aviso).toMatch(/^Ojo: esta conexión es sólo de .*, pero el cierre de este periodo incluye también .*-bosques\./)
    const c = await confirmarConexion(scope, 'cierre', [m.venueId, b], huellaConFuera('h'.repeat(64), r.fuera))
    expect(c).toMatchObject({ respuesta: null, huella: 'h'.repeat(64) })
  })

  it('la fila de B inactiva, o con otro rol, ya no cuenta (y al confirmar se vuelve a leer)', async () => {
    const vista = await revisarConexion(scope, 'pagado', [m.venueId, b])
    expect(vista.negada).toBeNull()
    await prisma.staffVenue.update({ where: { id: (await filaEnB())!.id }, data: { active: false } })
    const c = await confirmarConexion(scope, 'pagado', [m.venueId, b], huellaConFuera('h'.repeat(64), vista.fuera))
    expect('respuesta' in c && codigo(c.respuesta)).toBe('FUERA_DE_LA_CONEXION')
    await prisma.staffVenue.update({ where: { id: (await filaEnB())!.id }, data: { active: true, role: 'MANAGER' } })
    expect(codigo((await revisarConexion(scope, 'cierre', [m.venueId, b])).negada)).toBe('FUERA_DE_LA_CONEXION')
  })
})
