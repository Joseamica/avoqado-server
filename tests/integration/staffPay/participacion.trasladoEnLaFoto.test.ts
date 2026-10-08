// tests/integration/staffPay/participacion.trasladoEnLaFoto.test.ts — fase 3, B14-fix F2 (Codex participación r1 #2): las lecturas
// preparan sus sedes ANTES de la foto (permisos, módulos) y las leen DENTRO. Un traslado que confirma justo entre las dos saca a la
// sede de la organización; lo que vende después es dinero de OTRA. Dentro de la foto se relee la pertenencia: GET /sedes la omite
// y la vista previa de activarla responde «sede ajena» (409), nunca los $100. El escenario de Codex: O1 activada desde el 1-oct, B
// sin ventanas ni devengos (así el traslado se permite), traslado con el controlador REAL y $100 de comisión de B en O2.
import prisma from '@/utils/prismaClient'
import * as foto from '@/services/dashboard/staffPay/foto'
import { estadoSedes } from '@/services/dashboard/staffPay/sedes.service'
import { vistaPreviaParticipacion } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import { reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { crearSede } from './_mundo'
import { activar, comision, esquema } from './_ventas'
import { prepararParticipacion } from './_participacion'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds: [...new Set(venueIds)].sort(), parcial: false })),
  permisosPorSede: jest.fn(
    async (_u: string, venueIds: string[], permisos: string[]) => new Map(venueIds.map(v => [v, new Set(permisos)])),
  ),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
}))

const p = prepararParticipacion('part-traslado-foto')
const OCT7 = new Date('2026-10-07T18:00:00Z') // 12:00 del 7-oct en CDMX

describe('B14-fix F2: un traslado entre la preparación y la foto nunca enseña dinero de otra organización', () => {
  let B: string
  let o2: string
  let cfgB: string

  beforeEach(async () => {
    const m = p.m()
    B = (await crearSede(m.orgId, m.key, 'b')).venueId
    ;(global as any).__sedes = [m.venueId, B] // B tiene el plan: se podría activar
    await activar(m, { desde: '2026-10-01', sedes: [m.venueId], propinasDesde: null })
    o2 = await p.otraOrg('o2')
    cfgB = await esquema(m, B, 'Esquema B')
  })
  // B ya es de O2: sus comisiones y su esquema no los borra el mundo de O1 (y frenarían el borrado de la sede).
  afterEach(async () => {
    await prisma.commissionCalculation.deleteMany({ where: { venueId: B } })
    await prisma.commissionConfig.deleteMany({ where: { venueId: B } })
  })

  /** Justo ANTES de abrir la foto (después de preparar sedes, permisos y plan): trasladar B a O2 y venderle $100 allá. */
  function trasladarAntesDeLaFoto() {
    const real = foto.enUnaFoto
    const espia = jest.spyOn(foto, 'enUnaFoto').mockImplementationOnce((async (fn: any, o: any) => {
      expect(await p.trasladar(B, o2)).toMatchObject({ status: 200 })
      await comision(p.m(), { configId: cfgB, staffId: p.m().sofia, iso: '2026-10-06T18:00:00Z', neto: 100, venueId: B })
      return real(fn, o)
    }) as typeof foto.enUnaFoto)
    p.espiar(espia)
    return espia
  }

  it('GET /sedes: la sede trasladada no sale (antes: «fuera» con los $100 que vendió en O2)', async () => {
    const m = p.m()
    const espia = trasladarAntesDeLaFoto()
    const e = await estadoSedes({ userId: m.owner, venueId: m.venueId, ahora: OCT7 })
    expect(espia).toHaveBeenCalledTimes(1)
    expect(await p.sedeDe(B)).toMatchObject({ organizationId: o2 })
    expect(e.sedes.map(s => s.venueId)).toEqual([m.venueId])
    expect(JSON.stringify(e)).not.toContain('100.00')
    // La siguiente lectura (ya sin traslado de por medio) tampoco la ve: ya no es de la organización.
    expect((await estadoSedes({ userId: m.owner, venueId: m.venueId, ahora: OCT7 })).sedes.map(s => s.venueId)).toEqual([m.venueId])
  })

  it('vista previa de activar la sede trasladada: 409 «sede ajena», nunca los $100', async () => {
    const m = p.m()
    trasladarAntesDeLaFoto()
    const r = vistaPreviaParticipacion({ userId: m.owner, venueId: m.venueId, sedeId: B, accion: 'activar', ahora: OCT7 })
    await expect(r).rejects.toMatchObject({ statusCode: 409, code: 'SEDE_EN_OTRA_ORGANIZACION' })
    await expect(r).rejects.toThrow(`La sede ${m.key}-b ya no pertenece a esta organización`)
  })

  it('reporte abierto (en su foto desde F3): la sede trasladada sale del alcance; sus $100 nunca', async () => {
    const m = p.m()
    trasladarAntesDeLaFoto()
    const r = await reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-10-06', offset: 0, limit: 50 })
    expect(r.venueIds).toEqual([m.venueId])
    expect(r.tarjetas.total).toBe('0.00')
  })
})
