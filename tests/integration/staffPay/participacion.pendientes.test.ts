// tests/integration/staffPay/participacion.pendientes.test.ts — fase 3, B12 (diseño r6.2, r6.6.9, r5.1): las DEVOLUCIONES
// PENDIENTES. Algo que el sobre ya pagó (congelado) y cuya devolución o reverso todavía no entra en un cierre se VE —en el
// recibo abierto, en la vista previa del cierre y al registrar un ajuste manual— con cuándo se descontará solo. Es EXACTAMENTE
// la rama de reversos del barrido (`reversoDeLoCongelado`), con las sedes autorizadas filtradas antes de contar. Un ajuste
// manual no se liga: si el dueño registra los dos, se descuentan los dos (r5.1). Fechas de 2026 en UTC; CDMX = UTC−6.
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { devolucionesPendientes } from '@/services/dashboard/staffPay/devolucionesPendientes'
import { reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { agregarAjusteManual, previewAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { anularComision } from '@/services/dashboard/commission/commission-calculation.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, crearMundo, crearSede, Mundo } from './_mundo'
import { activar, cobro, comision, congelar, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  // Quien pregunta LEE sólo las sedes de `__legibles` (por defecto todas).
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => {
    const legibles: string[] | undefined = (global as any).__legibles
    const venue = legibles ? venueIds.filter(v => legibles.includes(v)) : venueIds
    return { venueIds: [...new Set(venue)].sort(), parcial: venue.length < new Set(venueIds).size }
  }),
}))

const OCT2 = new Date('2026-10-02T12:00:00Z')
const OCT20 = new Date('2026-10-20T18:00:00Z')
const NOV2 = new Date('2026-11-02T12:00:00Z')
const DIC2 = new Date('2026-12-02T12:00:00Z')
const AGO = '2026-08-15'
const SEP = '2026-09-15'
const OCT = '2026-10-15'
const NOV = '2026-11-15'
const OCTUBRE = { start: '2026-10-01', end: '2026-10-31' }
let m: Mundo
let A: string
let B: string

beforeEach(async () => {
  m = await crearMundo('part-pend')
  A = m.venueId
  B = (await crearSede(m.orgId, m.key, 'b')).venueId
  ;(global as any).__sedes = [A, B]
  ;(global as any).__legibles = undefined
})
afterEach(() => borrarMundo(m))

const preview = (fecha: string, ahora: Date) => previewCierre({ userId: m.owner, venueId: A, fecha, ahora })
const cerrar = async (fecha: string, ahora: Date) =>
  cerrarPeriodo({
    userId: m.owner,
    venueId: A,
    fecha,
    ahora,
    confirmarHuerfanas: true,
    huellaEsperada: (await preview(fecha, ahora)).huella,
  })
const propina = (venueId: string, iso: string, monto: number) => cobro(m, { iso, propina: monto, servedById: m.carla, venueId })
const pendientes = (sedes: string[], o: { staffId?: string; excluirPeriodo?: { start: string; end: string } } = {}) =>
  devolucionesPendientes(prisma, { organizationId: m.orgId, sedes, ...o })
const recibo = (fecha: string, sede?: string) => reciboDePersona({ userId: m.owner, venueId: A, staffId: m.carla, fecha, sede, limit: 50 })
const avisoDe = (fecha: string, ahora: Date, amount = -50) =>
  previewAjusteManual({ userId: m.owner, venueId: A, sede: A, staffId: m.carla, amount, reason: 'Devolución de propina', fecha, ahora })
const alCerrar = (start: string, end: string) => ({ tipo: 'AL_CERRAR', periodo: { start, end } })

describe('sedes autorizadas: se filtran ANTES de contar, sumar y paginar (r6.2)', () => {
  it('un encargado sólo de A no ve el −$50 de B: ni en la cuenta, ni en el total, ni en las páginas; con el filtro de sede del recibo, igual', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: '2026-09-01T06:00:00Z' })
    const enB = await propina(B, '2026-09-10T18:00:00Z', 50)
    const enA = await propina(A, '2026-09-11T18:00:00Z', 40)
    await cerrar(SEP, OCT2) // +$50 y +$40 congelados
    await reembolso(m, enB, { iso: '2026-10-10T18:00:00Z', propina: 50 })
    await reembolso(m, enA, { iso: '2026-10-12T18:00:00Z', propina: 40 })

    const soloA = await pendientes([A])
    expect(soloA).toMatchObject({ n: 1, total: '-40.00', truncado: false })
    expect(soloA.items.map(i => i.venueId)).toEqual([A])
    expect(soloA.porDestino).toEqual([
      { seDescuenta: alCerrar('2026-10-01', '2026-10-31'), n: 1, total: '-40.00', porSede: [{ venueId: A, n: 1, total: '-40.00' }] },
    ])
    expect(await pendientes([A, B])).toMatchObject({ n: 2, total: '-90.00' })

    // El recibo abierto de noviembre de Carla (octubre sigue abierto: las dos se descuentan al cerrar octubre).
    ;(global as any).__legibles = [A]
    const rA = await recibo(NOV)
    expect(rA.pendientes).toMatchObject({ n: 1, total: '-40.00' })
    expect(rA.pendientes!.items.map(i => i.venueId)).toEqual([A])
    ;(global as any).__legibles = undefined
    const conFiltro = await recibo(NOV, A)
    expect(conFiltro.pendientes).toMatchObject({ n: 1, total: '-40.00' })
    expect(conFiltro.pendientes!.items.map(i => i.venueId)).toEqual([A])
    expect((await recibo(NOV)).pendientes).toMatchObject({ n: 2, total: '-90.00' })

    // El aviso del ajuste manual: las sedes donde quien pregunta tiene staffpay:read.
    ;(global as any).__legibles = [A]
    const pv = await avisoDe('2026-10-20', OCT20)
    expect(pv.avisoPendientes).toMatchObject({ n: 1, total: '-40.00' })
    expect(pv.avisoPendientes.items.map(i => i.venueId)).toEqual([A])
  })
})

describe('cuándo se descuenta: el Destino (r6.2)', () => {
  it('octubre abierto con −$50 del 10-oct y −$30 del 1-dic; al previsualizar noviembre ⇒ [−$50 al cerrar octubre, −$30 al cerrar diciembre]; lo de noviembre ya es línea del cierre', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: '2026-09-01T06:00:00Z' })
    const t50 = await propina(A, '2026-09-10T18:00:00Z', 50)
    const t30 = await propina(A, '2026-09-11T18:00:00Z', 30)
    const t20 = await propina(A, '2026-09-12T18:00:00Z', 20)
    await cerrar(SEP, OCT2)
    await reembolso(m, t50, { iso: '2026-10-10T18:00:00Z', propina: 50 })
    await reembolso(m, t30, { iso: '2026-12-01T18:00:00Z', propina: 30 })
    await reembolso(m, t20, { iso: '2026-11-15T18:00:00Z', propina: 20 }) // en noviembre: entra como línea, no es pendiente
    const p = await preview(NOV, DIC2)
    expect(p).toMatchObject({ propinas: 1, totalVentas: '-20.00' })
    expect(p.pendientes).toEqual({
      n: 2,
      total: '-80.00',
      porDestino: [
        { seDescuenta: alCerrar('2026-10-01', '2026-10-31'), n: 1, total: '-50.00', porSede: [{ venueId: A, n: 1, total: '-50.00' }] },
        { seDescuenta: alCerrar('2026-12-01', '2026-12-31'), n: 1, total: '-30.00', porSede: [{ venueId: A, n: 1, total: '-30.00' }] },
      ],
    })
    expect(p.porSede.find(s => s.venueId === A)!.pendientes).toEqual({ n: 2, total: '-80.00' })
    expect(p.porSede.find(s => s.venueId === B)!.pendientes).toEqual({ n: 0, total: '0.00' })
    // Sin excluir ningún periodo, también la de noviembre.
    expect(await pendientes([A, B])).toMatchObject({ n: 3, total: '-100.00' })
    expect(await pendientes([A, B], { excluirPeriodo: { start: '2026-11-01', end: '2026-11-30' } })).toMatchObject({ n: 2 })
  })

  it('un origen CERRADO ⇒ PERIODO_POSTERIOR_A; cerrar fuera de orden un periodo anterior (agosto) no la consume; octubre sí', async () => {
    await activar(m, { desde: '2026-08-01', sedes: [A], propinasDesde: '2026-08-01T06:00:00Z' })
    const t = await propina(A, '2026-09-10T18:00:00Z', 50)
    await cerrar(SEP, OCT2) // agosto sigue abierto
    const dev = await reembolso(m, t, { iso: '2026-09-25T18:00:00Z', propina: 50 }) // capturada tarde: septiembre ya cerró
    const posterior = { tipo: 'PERIODO_POSTERIOR_A', origen: { start: '2026-09-01', end: '2026-09-30' } }
    const antes = await pendientes([A])
    expect(antes).toMatchObject({ n: 1, total: '-50.00' })
    expect(antes.items).toEqual([
      expect.objectContaining({
        fuente: 'TIP',
        sourceId: dev.id,
        venueId: A,
        staffId: m.carla,
        fecha: '2026-09-25',
        monto: '-50.00',
        seDescuenta: posterior,
      }),
    ])
    // Agosto, cerrado DESPUÉS de septiembre: su vista previa la sigue mostrando pendiente y su cierre no la toca.
    expect((await preview(AGO, OCT2)).pendientes).toMatchObject({ n: 1, porDestino: [{ seDescuenta: posterior }] })
    await cerrar(AGO, OCT2)
    expect(await prisma.serviceEarning.count({ where: { sourceId: dev.id } })).toBe(0)
    expect((await pendientes([A])).items[0].seDescuenta).toEqual(posterior)
    // Octubre (posterior a septiembre) la lleva como línea: ya no es pendiente, y su cierre la congela.
    const oct = await preview(OCT, NOV2)
    expect(oct).toMatchObject({ propinas: 1, totalVentas: '-50.00', pendientes: { n: 0, total: '0.00', porDestino: [] } })
    await cerrar(OCT, NOV2)
    expect(await pendientes([A])).toMatchObject({ n: 0, total: '0.00', items: [], truncado: false })
  })
})

describe('el Destino con periodos QUINCENALES', () => {
  it('cada devolución cae en SU quincena canónica (1-15 o 16-fin); una quincena cerrada ⇒ PERIODO_POSTERIOR_A con ella de origen', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: '2026-09-01T06:00:00Z' })
    await prisma.organization.update({ where: { id: m.orgId }, data: { servicePayPeriodicity: 'SEMIMONTHLY' } })
    const cerrada = (start: string, end: string) =>
      prisma.servicePayPeriod.create({
        data: {
          organizationId: m.orgId,
          periodStart: fechaComoDbDate(start),
          periodEnd: fechaComoDbDate(end),
          venueIds: [A],
          status: 'CLOSED',
          closedAt: OCT2,
          closedById: m.owner,
          closeFingerprint: 'manual',
        },
      })
    const q1 = await cerrada('2026-09-01', '2026-09-15')
    await cerrada('2026-10-01', '2026-10-15')
    const congelada = async (iso: string, devIso: string, monto: number) => {
      const t = await propina(A, iso, monto)
      await congelar(m, q1.id, { fuente: 'TIP', sourceId: t.id, staffId: m.carla, monto })
      return reembolso(m, t, { iso: devIso, propina: monto })
    }
    await congelada('2026-09-05T18:00:00Z', '2026-09-20T18:00:00Z', 11) // 2.ª de septiembre, abierta
    await congelada('2026-09-06T18:00:00Z', '2026-10-10T18:00:00Z', 12) // 1.ª de octubre, cerrada
    await congelada('2026-09-07T18:00:00Z', '2026-10-31T18:00:00Z', 13) // 2.ª de octubre (el 31), abierta
    expect((await pendientes([A])).porDestino.map(d => [d.seDescuenta, d.total])).toEqual([
      [alCerrar('2026-09-16', '2026-09-30'), '-11.00'],
      [{ tipo: 'PERIODO_POSTERIOR_A', origen: { start: '2026-10-01', end: '2026-10-15' } }, '-12.00'],
      [alCerrar('2026-10-16', '2026-10-31'), '-13.00'],
    ])
  })
})

describe('la MISMA regla que el barrido (reversoDeLoCongelado)', () => {
  it('+$100 de comisión congelada, −$40 del 10-oct y anulación ⇒ la cascada anula el reverso y ya no aparece; la anulación devuelve −$100', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: null })
    const cfg = await esquema(m)
    const venta = await cobro(m, { iso: '2026-09-10T18:00:00Z', monto: 3000 })
    const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-09-10T18:00:05Z', neto: 100, pago: venta })
    await cerrar(SEP, OCT2)
    const dev = await reembolso(m, venta, { iso: '2026-10-10T18:00:00Z', monto: 1200 })
    const rev = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-10-10T18:00:05Z', neto: -40, pago: dev })
    expect((await pendientes([A])).items).toEqual([
      expect.objectContaining({
        fuente: 'COMMISSION',
        sourceId: rev.id,
        staffId: m.sofia,
        monto: '-40.00',
        seDescuenta: alCerrar('2026-10-01', '2026-10-31'),
      }),
    ])
    expect((await pendientes([A], { staffId: m.carla })).n).toBe(0)
    await anularComision({ calculationId: c.id, venueId: A, actorId: m.owner, motivo: 'Venta capturada por error' })
    expect(await pendientes([A])).toMatchObject({ n: 0, total: '0.00' })
    expect(await preview(OCT, NOV2)).toMatchObject({ comisiones: 0, reversos: 1, totalVentas: '-100.00', pendientes: { n: 0 } })
  })

  it('+$50 congelados, −$50 MANUAL y después −$50 automático ⇒ el acumulado queda en −$50 (el ajuste libre es del dueño, r5.1); el aviso lo dijo antes', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: '2026-09-01T06:00:00Z' })
    const t = await propina(A, '2026-09-10T18:00:00Z', 50)
    await cerrar(SEP, OCT2)
    await reembolso(m, t, { iso: '2026-10-10T18:00:00Z', propina: 50 })
    const pv = await avisoDe('2026-10-20', OCT20)
    expect(pv.avisoPendientes).toMatchObject({ n: 1, total: '-50.00', truncado: false })
    expect(pv.avisoPendientes.items[0]).toMatchObject({
      staffId: m.carla,
      monto: '-50.00',
      seDescuenta: alCerrar('2026-10-01', '2026-10-31'),
    })
    expect(pv.avisoPendientes.porDestino.map(d => d.seDescuenta)).toEqual([alCerrar('2026-10-01', '2026-10-31')])
    // El dueño registra el −$50 a mano de todos modos.
    await agregarAjusteManual({
      userId: m.owner,
      venueId: A,
      sede: A,
      staffId: m.carla,
      amount: -50,
      reason: 'Devolución de propina',
      fecha: '2026-10-20',
      clientKey: `${m.key}-manual-50`,
      ahora: OCT20,
    })
    const oct = await cerrar(OCT, NOV2)
    const total = (periodId: string) =>
      prisma.staffPayStatement.findUniqueOrThrow({ where: { periodId_staffId: { periodId, staffId: m.carla } } })
    expect((await total(oct.periodId)).total.toFixed(2)).toBe('-100.00')
    const acumulado = await prisma.staffPayStatement.aggregate({
      where: { staffId: m.carla, period: { organizationId: m.orgId } },
      _sum: { total: true },
    })
    expect(acumulado._sum.total?.toFixed(2)).toBe('-50.00')
  })
})

describe('se ve en los tres lugares, con su Destino (r5.1)', () => {
  it('recibo ABIERTO, vista previa del cierre y aviso del ajuste dicen «−$50 al cerrar octubre»; el recibo cerrado no lleva pendientes', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: '2026-09-01T06:00:00Z' })
    const t = await propina(A, '2026-09-10T18:00:00Z', 50)
    const sep = await cerrar(SEP, OCT2)
    const dev = await reembolso(m, t, { iso: '2026-10-10T18:00:00Z', propina: 50 })
    const item = {
      fuente: 'TIP',
      sourceId: dev.id,
      venueId: A,
      staffId: m.carla,
      persona: 'Carla QA',
      fecha: '2026-10-10',
      monto: '-50.00',
    }
    const destino = alCerrar('2026-10-01', '2026-10-31')
    const nov = await recibo(NOV)
    expect(nov.pendientes).toMatchObject({ n: 1, total: '-50.00', items: [{ ...item, seDescuenta: destino }] })
    // En octubre ya es un renglón del recibo abierto: no se repite como pendiente.
    const oct = await recibo(OCT)
    expect(oct).toMatchObject({ total: '-50.00', pendientes: { n: 0, items: [] } })
    expect((await preview(NOV, DIC2)).pendientes).toMatchObject({ n: 1, porDestino: [{ seDescuenta: destino }] })
    expect((await avisoDe('2026-10-20', OCT20)).avisoPendientes.items).toEqual([expect.objectContaining({ ...item, seDescuenta: destino })])
    expect((await recibo(SEP)).periodo.estado).toBe('CLOSED')
    expect((await recibo(SEP)).pendientes).toBeNull()
    expect(sep.total).toBe('50.00')
  })
})

describe('tope de 50 con totales exactos', () => {
  it('52 devoluciones pendientes ⇒ 50 renglones en orden estable y truncado; n y total del conjunto entero', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: '2026-09-01T06:00:00Z' })
    const sep = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        venueIds: [A],
        status: 'CLOSED',
        closedAt: OCT2,
        closedById: m.owner,
        closeFingerprint: 'manual',
      },
    })
    let esperado = 0
    for (let i = 1; i <= 52; i++) {
      const dia = String(1 + (i % 28)).padStart(2, '0')
      const t = await propina(A, `2026-09-${dia}T18:00:00Z`, i)
      await congelar(m, sep.id, { fuente: 'TIP', sourceId: t.id, staffId: m.carla, monto: i })
      await reembolso(m, t, { iso: `2026-10-${dia}T18:00:00Z`, propina: i })
      esperado += i
    }
    const r = await pendientes([A])
    expect(r).toMatchObject({ n: 52, total: (-esperado).toFixed(2), truncado: true })
    expect(r.items).toHaveLength(50)
    const llave = r.items.map(i => `${i.fecha}|${i.fuente}|${i.sourceId}`)
    expect(llave).toEqual([...llave].sort())
    expect(await pendientes([A])).toEqual(r) // estable
    expect(r.porDestino).toEqual([
      {
        seDescuenta: alCerrar(OCTUBRE.start, OCTUBRE.end),
        n: 52,
        total: (-esperado).toFixed(2),
        porSede: [{ venueId: A, n: 52, total: (-esperado).toFixed(2) }],
      },
    ])
  })

  it('sin activar no hay nada pendiente', async () => {
    expect(await pendientes([A, B])).toEqual({ n: 0, total: '0.00', porDestino: [], items: [], truncado: false })
  })
})
