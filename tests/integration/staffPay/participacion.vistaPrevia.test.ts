// tests/integration/staffPay/participacion.vistaPrevia.test.ts — fase 3, B11 (diseño r7.3, r5.4, r4.5): la vista previa CON
// MONTOS de activar o desactivar una sede, antes de confirmar. Netos (devoluciones incluidas), clases agregadas en la base y
// las MISMAS reglas de fechas que la escritura. La ruta, el MCP y el service dan los mismos números. Fechas de 2026 en UTC;
// CDMX = UTC−6.
import type { Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import { vistaPreviaParticipacion } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import { getParticipationPreview } from '@/controllers/dashboard/staffPay.dashboard.controller'
import { registerStaffPayTools } from '@/mcp/tools/staffPay'
import type { McpScope } from '@/mcp/scope'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaFija } from './_mundo'
import { activar, cobro, comision, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  organizacionTieneServicePay: jest.fn(async () => ((global as any).__sedes ?? []).length > 0),
  venueHasServicePayAccess: jest.fn(async (v: string) => ((global as any).__sedes ?? []).includes(v)),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

const NOV1 = new Date('2026-11-01T18:00:00Z')
const OCT20 = new Date('2026-10-20T18:00:00Z')
let m: Mundo
let A: string
let B: string
let productoB: string
let cfgB: string

beforeEach(async () => {
  m = await crearMundo('part-vista')
  A = m.venueId
  const b = await crearSede(m.orgId, m.key, 'b')
  B = b.venueId
  productoB = b.productId
  ;(global as any).__sedes = [A, B]
  cfgB = await esquema(m, B, 'Esquema B')
})
afterEach(() => borrarMundo(m))

const vista = (accion: 'activar' | 'desactivar', fecha: string | undefined, ahora?: Date) =>
  vistaPreviaParticipacion({ userId: m.owner, venueId: A, sedeId: B, accion, fecha, ahora })
const cero = { n: 0, total: '0.00' }
const cuenta = (c: { clases?: [number, string, number?]; comisiones?: [number, string]; propinas?: [number, string] }) => ({
  clases: { n: c.clases?.[0] ?? 0, total: c.clases?.[1] ?? '0.00', pendientesDeValoracion: c.clases?.[2] ?? 0 },
  comisiones: c.comisiones ? { n: c.comisiones[0], total: c.comisiones[1] } : cero,
  propinas: c.propinas ? { n: c.propinas[0], total: c.propinas[1] } : cero,
})

describe('activar: entran y quedan fuera (r7.3)', () => {
  beforeEach(async () => {
    await tablaFija(m, B, 500)
    // Octubre abierto; B tiene el plan pero no está activa. $500 de clase y $100 de comisión del 20-oct en B.
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-20T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    await comision(m, { configId: cfgB, staffId: m.sofia, iso: '2026-10-20T18:00:00Z', neto: 100, venueId: B })
  })

  it('el 1-nov: desde el 1-oct entran $600 y no queda nada fuera; desde el 1-nov (o «hoy») no entra nada y quedan fuera $600', async () => {
    expect(await vista('activar', '2026-10-01', NOV1)).toEqual({
      accion: 'activar',
      fecha: '2026-10-01',
      minimo: '2026-10-01',
      maximo: '2026-11-01',
      zona: 'America/Mexico_City',
      entran: cuenta({ clases: [1, '500.00'], comisiones: [1, '100.00'] }),
      quedanFuera: cuenta({}),
    })
    const hoy = await vista('activar', undefined, NOV1)
    expect(hoy).toMatchObject({
      fecha: '2026-11-01',
      entran: cuenta({}),
      quedanFuera: cuenta({ clases: [1, '500.00'], comisiones: [1, '100.00'] }),
    })
    expect(await vista('activar', '2026-11-01', NOV1)).toEqual(hoy)
  })

  it('una fecha que la escritura rechazaría también es 400 aquí, con el mínimo EFECTIVO de la sede', async () => {
    await expect(vista('activar', '2026-09-15', NOV1)).rejects.toMatchObject({
      statusCode: 400,
      code: 'FECHA_FUERA_DE_RANGO',
      details: { desde: '2026-10-01', hasta: '2026-11-01' },
    })
    await expect(vista('activar', '2026-11-02', NOV1)).rejects.toMatchObject({ code: 'FECHA_FUERA_DE_RANGO' })
    // Sin el plan en la sede: lo mismo que contestaría confirmar.
    ;(global as any).__sedes = [A]
    await expect(vista('activar', '2026-10-01', NOV1)).rejects.toMatchObject({ statusCode: 409, code: 'SEDE_SIN_PLAN' })
  })

  it('dos clases de $500 ⇒ clases $1,000; una sin tabla no suma $0: va en pendientesDeValoracion', async () => {
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-21T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    // Producto que ninguna tabla de B cubre (la de B tiene `productIds` vacío = todas; ésta la restringe).
    await prisma.servicePayTable.updateMany({ where: { venueId: B }, data: { productIds: [productoB] } })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-22T15:00:00Z', venueId: B, productId: m.productId, reservas: confirmadas(5) })
    expect(await vista('activar', '2026-10-01', NOV1)).toMatchObject({
      entran: cuenta({ clases: [2, '1000.00', 1], comisiones: [1, '100.00'] }),
    })
  })
})

describe('desactivar: dejan de entrar y permanecen (r5.4)', () => {
  it('+$60 (10-oct) y +$70 (17-oct); hasta el 15-oct ⇒ dejan de entrar $70 y permanecen $60, aun SIN el plan en la sede', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: '2026-10-01T06:00:00Z' })
    await cobro(m, { iso: '2026-10-10T18:00:00Z', propina: 60, servedById: m.carla, venueId: B })
    await cobro(m, { iso: '2026-10-17T18:00:00Z', propina: 70, servedById: m.carla, venueId: B })
    ;(global as any).__sedes = [A] // desactivar no pide el plan (r4.7)
    expect(await vista('desactivar', '2026-10-15', OCT20)).toEqual({
      accion: 'desactivar',
      fecha: '2026-10-15',
      minimo: '2026-09-30', // un día antes de su inicio: así se borraría la activación
      maximo: '2026-10-20',
      zona: 'America/Mexico_City',
      dejanDeEntrar: cuenta({ propinas: [1, '70.00'] }),
      permanecen: cuenta({ propinas: [1, '60.00'] }),
    })
  })

  it('+$60 y su devolución −$60 alrededor de la fecha ⇒ $0, al desactivar y al activar (por neto, nunca por positivos)', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: '2026-10-01T06:00:00Z' })
    const t = await cobro(m, { iso: '2026-10-10T18:00:00Z', propina: 60, servedById: m.carla, venueId: B })
    await reembolso(m, t, { iso: '2026-10-20T17:00:00Z', propina: 60 })
    const d = await vista('desactivar', '2026-10-15', OCT20)
    expect(d).toMatchObject({ dejanDeEntrar: cuenta({}), permanecen: cuenta({ propinas: [2, '0.00'] }) })
    // La misma pareja con B sin activar: activar desde el 15-oct no mete ninguna; queda fuera el neto de $0.
    await prisma.staffPayVenueWindow.deleteMany({ where: { venueId: B } })
    const a = await vista('activar', '2026-10-15', OCT20)
    expect(a).toMatchObject({ entran: cuenta({}), quedanFuera: cuenta({ propinas: [2, '0.00'] }) })
  })
})

describe('la ruta, el MCP y el service dan los mismos números (r7.3)', () => {
  it('activar B desde el 1-ago con $500 de clase y $100 de comisión del 20-ago (reloj real: datos del pasado)', async () => {
    await tablaFija(m, B, 500)
    await activar(m, { desde: '2026-08-01', sedes: [A], propinasDesde: null })
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    await comision(m, { configId: cfgB, staffId: m.sofia, iso: '2026-08-20T18:00:00Z', neto: 100, venueId: B })

    const service = await vista('activar', '2026-08-01')
    expect(service.accion === 'activar' && service.entran).toEqual(cuenta({ clases: [1, '500.00'], comisiones: [1, '100.00'] }))

    let ruta: unknown = null
    let error: unknown = null
    const req = {
      params: { venueId: A, sedeId: B },
      query: { accion: 'activar', fecha: '2026-08-01' },
      body: {},
      authContext: { userId: m.owner },
    } as unknown as Request
    await getParticipationPreview(req, { json: (b: unknown) => (ruta = b) } as unknown as Response, (e?: unknown) => (error = e ?? null))
    expect(error).toBeNull()
    expect(ruta).toEqual(service)

    const herramientas = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
    const acceso = { role: 'OWNER', corePermissions: ['staffpay:read', 'staffpay:close'] }
    const scope = {
      staffId: m.owner,
      activeOrg: m.orgId,
      scopes: ['mcp:read', 'mcp:write'],
      allowedVenueIds: [A, B],
      perVenueAccess: new Map([
        [A, acceso],
        [B, acceso],
      ]),
    } as unknown as McpScope
    registerStaffPayTools({ tool: (...a: unknown[]) => herramientas.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
    const r = await herramientas.get('configure_service_pay')!(
      { venueId: A, accion: 'sede', sede: B, activa: true, fecha: '2026-08-01' },
      {},
    )
    const mcp = JSON.parse(r.content[0].text)
    expect(mcp).toMatchObject({ requiresConfirmation: true, fecha: '2026-08-01' })
    expect(mcp.preview).toEqual(service)
  })
})
