// tests/integration/staffPay/periodos.antesDelInicio.test.ts — E6a-fix F10 (QA E6a H5): los periodos que terminan antes de que
// se activara pago al personal. Contrato con el dashboard (brief E6a-fix, «Contrato de F10»): la lista no los ofrece si no están
// guardados; cerrarlos, su vista previa o un ajuste ⇒ 409 ANTES_DEL_INICIO con el texto (uno GUARDADO, historia de la fase 2,
// sigue con D2: se lista y tiene salida); y el estado por sede de un periodo YA TERMINADO dice si la sede participó EN ESE
// periodo, no su estado de hoy. Hoy = 7-oct-2026; inicio = 1-sep-2026.
import prisma from '@/utils/prismaClient'
import { listarPeriodos } from '@/services/dashboard/staffPay/periodosGuardados'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { agregarAjusteManual, previewAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { Huella } from '@/services/dashboard/staffPay/huella'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, periodoCerrado } from './_mundo'
import { activar, sedeActiva } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

const HOY = new Date('2026-10-07T18:00:00Z')
const OCT2 = new Date('2026-10-02T12:00:00Z')
const NOV2 = new Date('2026-11-02T12:00:00Z')
const TEXTO = 'Pago al personal está activo desde el 1 sep 2026: ese periodo es anterior'
let m: Mundo
beforeEach(async () => {
  m = await crearMundo('antes-del-inicio')
  ;(global as any).__sedes = [m.venueId]
  await activar(m, { desde: '2026-09-01', propinasDesde: null })
})
afterEach(() => borrarMundo(m))

const antesDelInicio = { statusCode: 409, code: 'ANTES_DEL_INICIO', message: TEXTO, details: { inicio: '2026-09-01' } }
const periodos = async () => prisma.servicePayPeriod.count({ where: { organizationId: m.orgId } })
/** La huella REAL de un agosto vacío (sólo su cabecera): sin la guarda, el cierre lo cerraría de verdad, no por HUELLA_CAMBIO. */
const huellaDeAgostoVacio = () => {
  const h = new Huella()
  h.cabecera({ organizationId: m.orgId, start: '2026-08-01', end: '2026-08-31', venueIds: [m.venueId] })
  return h.digest()
}
const ajuste = (fecha: string) => ({
  userId: m.owner,
  venueId: m.venueId,
  sede: m.venueId,
  staffId: m.ana,
  amount: 50,
  reason: 'Bono de agosto',
  fecha,
  ahora: HOY,
})

describe('F10 — lo anterior al inicio de pago al personal', () => {
  it('la lista no ofrece los canónicos sin guardar que terminan antes del inicio; los guardados (fase 2) siguen', async () => {
    const julio = await periodoCerrado(m, '2026-07-01', '2026-07-31')
    const l = await listarPeriodos({ userId: m.owner, venueId: m.venueId, limit: 24, ahora: HOY })
    expect(l.items.map(i => [i.start, i.id === null ? 'sin guardar' : i.estado])).toEqual([
      ['2026-10-01', 'sin guardar'],
      ['2026-09-01', 'sin guardar'],
      ['2026-07-01', 'CLOSED'],
    ])
    expect(l.items.find(i => i.id === julio.id)).toBeTruthy()
  })

  it('cerrar, su vista previa y un ajuste de un periodo SIN GUARDAR anterior al inicio ⇒ 409 ANTES_DEL_INICIO, sin crear el periodo', async () => {
    await expect(previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: HOY })).rejects.toMatchObject(
      antesDelInicio,
    )
    await expect(
      cerrarPeriodo({
        userId: m.owner,
        venueId: m.venueId,
        fecha: '2026-08-15',
        ahora: HOY,
        confirmarHuerfanas: true,
        huellaEsperada: huellaDeAgostoVacio(),
      }),
    ).rejects.toMatchObject(antesDelInicio)
    await expect(previewAjusteManual(ajuste('2026-08-20'))).rejects.toMatchObject(antesDelInicio)
    await expect(agregarAjusteManual({ ...ajuste('2026-08-20'), clientKey: `${m.key}-agosto` })).rejects.toMatchObject(antesDelInicio)
    expect(await periodos()).toBe(0)
  })

  it('liquidar una diferencia con destino en un periodo SIN GUARDAR anterior al inicio ⇒ 409, sin crear el periodo (hermano: `asegurarPeriodo`)', async () => {
    const cs = await clase(m, { staffId: m.ana, inicioIso: '2026-09-10T15:00:00Z', reservas: confirmadas(5) })
    const base = { userId: m.owner, venueId: m.venueId, classSessionId: cs, destinoFecha: '2026-08-20', ahora: HOY }
    await expect(previewLiquidacion(base)).rejects.toMatchObject(antesDelInicio)
    await expect(
      liquidarDiferencia({ ...base, periodoOrigenId: 'x', huellaEsperada: 'x', solicitudId: `${m.key}-liquidar` }),
    ).rejects.toMatchObject(antesDelInicio)
    expect(await periodos()).toBe(0)
  })

  it('un periodo GUARDADO y abierto de antes del inicio (historia de la fase 2) se lista y tiene salida: se cierra con D2 y recibe ajustes', async () => {
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    expect((await listarPeriodos({ userId: m.owner, venueId: m.venueId, limit: 24, ahora: HOY })).items.map(i => i.id)).toContain(agosto.id)
    expect(await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: HOY })).toMatchObject({
      periodo: { id: agosto.id },
      puedeCerrar: true,
    })
    expect(await agregarAjusteManual({ ...ajuste('2026-08-20'), clientKey: `${m.key}-agosto-2` })).toMatchObject({
      periodId: agosto.id,
      amount: '50.00',
    })
  })

  it('desde el inicio todo sigue igual; un periodo CERRADO de antes del inicio se sigue leyendo como cerrado', async () => {
    await periodoCerrado(m, '2026-07-01', '2026-07-31')
    expect(await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-07-15', ahora: HOY })).toMatchObject({
      bloqueos: [{ codigo: 'YA_CERRADO' }],
    })
    expect(await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-09-15', ahora: HOY })).toMatchObject({
      puedeCerrar: true,
      bloqueos: [],
    })
    expect(await previewAjusteManual(ajuste('2026-09-20'))).toMatchObject({ periodo: { start: '2026-09-01', estado: 'OPEN' } })
  })
})

describe('F10 — el estado por sede de un periodo ya terminado es el de ESE periodo (contrato de F10)', () => {
  /**
   * A: activa desde el 1-sep (participó y sigue). B: activa sólo desde el 1-oct (hoy activa; en septiembre NO participó).
   * C: activa del 1 al 30-sep (hoy sin activar; en septiembre SÍ participó). D: activa desde el 1-sep (participó) y hoy sin el
   * plan: ACTIVA_SIN_PLAN gana, porque es lo que bloquea el cierre y lo que la pantalla deja desactivar, también en uno pasado.
   * E: activa sólo el 1-oct (participó en octubre, pero el 2-oct ya no está activa: en curso manda hoy).
   */
  async function cincoSedes() {
    const [B, C, D, E] = [
      (await crearSede(m.orgId, m.key, 'b')).venueId,
      (await crearSede(m.orgId, m.key, 'c')).venueId,
      (await crearSede(m.orgId, m.key, 'd')).venueId,
      (await crearSede(m.orgId, m.key, 'e')).venueId,
    ]
    ;(global as any).__sedes = [m.venueId, B, C, E]
    await sedeActiva(m, B, '2026-10-01')
    await sedeActiva(m, C, '2026-09-01', '2026-09-30')
    await sedeActiva(m, D, '2026-09-01')
    await sedeActiva(m, E, '2026-10-01', '2026-10-01')
    return { A: m.venueId, B, C, D, E }
  }
  const estados = (p: Awaited<ReturnType<typeof previewCierre>>) => Object.fromEntries(p.porSede.map(s => [s.venueId, s.estado]))

  it('septiembre (ya terminó): participó ⇒ ACTIVA, no participó ⇒ SIN_ACTIVAR; ACTIVA_SIN_PLAN se conserva', async () => {
    const s = await cincoSedes()
    const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-09-15', ahora: OCT2 })
    expect(estados(p)).toEqual({
      [s.A]: 'ACTIVA',
      [s.B]: 'SIN_ACTIVAR',
      [s.C]: 'ACTIVA',
      [s.D]: 'ACTIVA_SIN_PLAN',
      [s.E]: 'SIN_ACTIVAR',
    })
    expect(p.bloqueos).toEqual([expect.objectContaining({ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [s.D] })])
  })

  it('octubre ya terminado (2-nov): C sólo participó en septiembre ⇒ SIN_ACTIVAR; E participó el 1-oct ⇒ ACTIVA', async () => {
    const s = await cincoSedes()
    const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-10-15', ahora: NOV2 })
    expect(estados(p)).toEqual({
      [s.A]: 'ACTIVA',
      [s.B]: 'ACTIVA',
      [s.C]: 'SIN_ACTIVAR',
      [s.D]: 'ACTIVA_SIN_PLAN',
      [s.E]: 'ACTIVA',
    })
  })

  it('octubre (en curso): conserva el estado de hoy', async () => {
    const s = await cincoSedes()
    const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-10-15', ahora: OCT2 })
    expect(estados(p)).toEqual({
      [s.A]: 'ACTIVA',
      [s.B]: 'ACTIVA',
      [s.C]: 'SIN_ACTIVAR',
      [s.D]: 'ACTIVA_SIN_PLAN',
      [s.E]: 'SIN_ACTIVAR',
    })
  })
})
