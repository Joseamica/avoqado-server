// tests/integration/staffPay/participacion.ventas.test.ts — fase 3, B11 (diseño r3.5, r4.2, r4.9.5, r5.8.6): las VENTAS con la
// participación por sede, conectada al cierre. Una venta entra sólo los días en que su sede estaba ACTIVA; las devoluciones,
// los reversos y las anulaciones de lo que el sobre ya pagó se descuentan aunque la sede ya no esté activa (sigue en el
// alcance por historia). Sin el filtro de B4 r1: lo reemplaza la ventana. Fechas de 2026 en UTC; CDMX = UTC−6.
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { guardarAjusteDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { anularComision } from '@/services/dashboard/commission/commission-calculation.service'
import { activarSede, desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import * as rangos from '@/services/dashboard/staffPay/rangos'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaFija } from './_mundo'
import { activar, cobro, comision, esquema, reembolso, sedeActiva } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

// Cada mes ya terminó en CDMX en estos «ahora».
const OCT2 = new Date('2026-10-02T12:00:00Z')
const NOV2 = new Date('2026-11-02T12:00:00Z')
const DIC1 = new Date('2026-12-01T12:00:00Z')
const DIC2 = new Date('2026-12-02T12:00:00Z')
const ENE2 = new Date('2027-01-02T12:00:00Z')
const SEP = '2026-09-15'
const OCT = '2026-10-15'
const NOV = '2026-11-15'
const DIC = '2026-12-15'
let m: Mundo
let A: string
let B: string
let cfgB: string
let n = 0

beforeEach(async () => {
  m = await crearMundo('part-ventas')
  A = m.venueId
  B = (await crearSede(m.orgId, m.key, 'b')).venueId
  ;(global as any).__sedes = [A, B]
  cfgB = await esquema(m, B, 'Esquema B')
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
const totalDe = async (periodId: string, staffId: string) =>
  (await prisma.staffPayStatement.findUnique({ where: { periodId_staffId: { periodId, staffId } } }))?.total.toFixed(2) ?? null
const propinaB = (iso: string, propina: number) => cobro(m, { iso, propina, servedById: m.carla, venueId: B })
const comisionB = (iso: string, neto: number, pago?: { id: string; orderId: string }) =>
  comision(m, { configId: cfgB, staffId: m.sofia, iso, neto, pago, venueId: B })
const activarB = (o: { desde?: string; ahora: Date }) => activarSede({ userId: m.owner, venueId: A, sedeId: B, ...o })
const desactivarB = (hasta: string, ahora: Date) => desactivarSede({ userId: m.owner, venueId: A, sedeId: B, hasta, ahora })
const neto = async (staffId: string) =>
  (
    await prisma.staffPayStatement.aggregate({ where: { staffId, period: { organizationId: m.orgId } }, _sum: { total: true } })
  )._sum.total?.toFixed(2) ?? '0.00'

describe('los escenarios del diseño (r3.5, r4.9.5)', () => {
  it('Codex 1: B pierde el plan el 1-oct y no se desactiva ⇒ el cierre se BLOQUEA; desactivada «hasta el 30-sep», octubre paga $40 (la liquidación), no la propina de $100 del 5-oct', async () => {
    await tablaFija(m, B, 500)
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: '2026-09-01T06:00:00Z' })
    const cB = await clase(m, { staffId: m.ana, inicioIso: '2026-09-10T15:00:00Z', venueId: B, reservas: confirmadas(5) })
    const sep = await cerrar(SEP, OCT2)
    ;(global as any).__sedes = [A] // B pierde el plan el 1-oct
    await propinaB('2026-10-05T18:00:00Z', 100) // la pagó por fuera
    // +$40 de la clase de septiembre, liquidados en octubre: amplía octubre con B.
    await guardarAjusteDeClase({
      venueId: B,
      classSessionId: cB,
      payCountOverride: null,
      payAmountOverride: 540,
      payExcluded: false,
      reason: 'Monto acordado QA',
      actorId: m.owner,
    })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: B, classSessionId: cB, destinoFecha: OCT, ahora: OCT2 })
    await liquidarDiferencia({
      userId: m.owner,
      venueId: B,
      classSessionId: cB,
      destinoFecha: OCT,
      ahora: OCT2,
      periodoOrigenId: sep.periodId,
      huellaEsperada: pv.huella,
      solicitudId: `${m.key}-liq-${++n}`,
      ampliarAlcance: true,
    })
    // Se le olvida desactivar B: el cierre se bloquea y dice qué hacer.
    const bloqueado = await preview(OCT, NOV2)
    expect(bloqueado.puedeCerrar).toBe(false)
    expect(bloqueado.bloqueos).toEqual([{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [B], otrasConPlan: true }])
    await expect(cerrar(OCT, NOV2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SEDE_ACTIVA_SIN_PLAN',
      message: expect.stringMatching(/^Desactiva la sede .+-b indicando su último día/),
      details: { venueIds: [B], otrasConPlan: true },
    })
    await desactivarB('2026-09-30', NOV2)
    const p = await preview(OCT, NOV2)
    expect(p).toMatchObject({ puedeCerrar: true, bloqueos: [], propinas: 0, totalVentas: '0.00', totalAjustes: '40.00', total: '40.00' })
    expect((await cerrar(OCT, NOV2)).total).toBe('40.00')
  })

  it('Codex 2: septiembre abierto [A]; B obtiene el plan y se activa el 3-nov; al cerrar septiembre el 5-nov B está en el alcance y paga $0', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: '2026-09-01T06:00:00Z' })
    ;(global as any).__sedes = [A]
    await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        venueIds: [A],
      },
    })
    const t = await propinaB('2026-09-10T18:00:00Z', 100)
    ;(global as any).__sedes = [A, B]
    expect(await activarB({ ahora: new Date('2026-11-03T18:00:00Z') })).toMatchObject({ ventana: { desde: '2026-11-03' } })
    const NOV5 = new Date('2026-11-05T18:00:00Z')
    const p = await preview(SEP, NOV5)
    expect(p.periodo.venueIds).toEqual([A, B].sort())
    expect(p).toMatchObject({ propinas: 0, totalVentas: '0.00' })
    const r = await cerrar(SEP, NOV5)
    expect(r).toMatchObject({ total: '0.00', venueIds: [A, B].sort() })
    expect(await prisma.serviceEarning.count({ where: { sourceId: t.id } })).toBe(0)
  })

  it.each([
    ['por defecto (hoy, 1-nov)', '0.00', undefined, 0],
    ['«desde el 1-oct», antes de cerrar octubre', '130.00', '2026-10-01', 2],
  ])(
    'tercer escenario: $100 de propina + $30 de comisión del 20-oct en B, activada %s ⇒ octubre paga $%s',
    async (_, total, desde, lineas) => {
      await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
      await propinaB('2026-10-20T18:00:00Z', 100)
      await comisionB('2026-10-20T18:00:05Z', 30)
      await activarB({ desde, ahora: new Date('2026-11-01T18:00:00Z') })
      const p = await preview(OCT, NOV2)
      expect(p.comisiones + p.propinas).toBe(lineas)
      expect(p.totalVentas).toBe(total)
      expect((await cerrar(OCT, NOV2)).total).toBe(total)
    },
  )

  it.each([
    ['«desde hoy» a las 12:05 del 1-nov: entran las dos (el día empieza a las 00:00)', '2026-11-01T18:05:00Z', undefined, '75.00', 2],
    ['«desde el 2-nov», elegido el 2-nov: ninguna', '2026-11-02T18:00:00Z', '2026-11-02', '0.00', 0],
  ])('media jornada: propinas de $25 (11:00) y $50 (13:00) del 1-nov; %s', async (_, ahora, desde, total, propinas) => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    await propinaB('2026-11-01T17:00:00Z', 25)
    await propinaB('2026-11-01T19:00:00Z', 50)
    await activarB({ desde, ahora: new Date(ahora) })
    expect(await preview(NOV, DIC2)).toMatchObject({ propinas, totalVentas: total })
  })

  it('primera inclusión tardía: B activa desde el 1-nov, $80 del 20-nov y nada guardado hasta el 2-dic ⇒ noviembre paga $80; diciembre no se lleva un noviembre abierto', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    await activarB({ desde: '2026-11-01', ahora: new Date('2026-11-01T18:00:00Z') })
    const c = await comisionB('2026-11-20T18:00:00Z', 80)
    expect(await preview(DIC, ENE2)).toMatchObject({ comisiones: 0, totalVentas: '0.00' })
    expect(await preview(NOV, DIC2)).toMatchObject({ comisiones: 1, totalVentas: '80.00' })
    const nov = await cerrar(NOV, DIC2)
    expect(nov.total).toBe('80.00')
    expect(await prisma.serviceEarning.findFirstOrThrow({ where: { sourceId: c.id } })).toMatchObject({ periodId: nov.periodId })
  })

  it('sale y vuelve: B [1-sep, 30-sep] y otra vez desde el 1-dic ⇒ diciembre paga $30 tardíos del 28-sep + $40 del 5-dic = $70; nunca los $100 del 20-oct ni los $80 del 15-nov', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: null })
    await sedeActiva(m, B, '2026-09-01', '2026-09-30')
    await cerrar(SEP, OCT2)
    await cerrar(OCT, NOV2)
    await cerrar(NOV, DIC1)
    await activarB({ ahora: DIC1 }) // por defecto hoy: 1-dic
    // Capturadas tarde, después de cerrar noviembre.
    const c30 = await comisionB('2026-09-28T18:00:00Z', 30)
    await comisionB('2026-10-20T18:00:00Z', 100)
    await comisionB('2026-11-15T18:00:00Z', 80)
    const c40 = await comisionB('2026-12-05T18:00:00Z', 40)
    const p = await preview(DIC, ENE2)
    expect(p).toMatchObject({ comisiones: 2, totalVentas: '70.00' })
    const dic = await cerrar(DIC, ENE2)
    const lineas = await prisma.serviceEarning.findMany({ where: { periodId: dic.periodId }, select: { sourceId: true }, take: 10 })
    expect(lineas.map(l => l.sourceId).sort()).toEqual([c30.id, c40.id].sort())
  })

  it('+$60 (10-oct) y su devolución −$60 (20-oct) alrededor de la desactivación «hasta el 15-oct» ⇒ $0; una original fuera de la ventana y su devolución: ninguna', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: '2026-10-01T06:00:00Z' })
    const t60 = await propinaB('2026-10-10T18:00:00Z', 60)
    const d60 = await reembolso(m, t60, { iso: '2026-10-20T18:00:00Z', propina: 60 })
    const t70 = await propinaB('2026-10-17T18:00:00Z', 70) // después de su último día
    await reembolso(m, t70, { iso: '2026-10-18T18:00:00Z', propina: 70 })
    await desactivarB('2026-10-15', new Date('2026-10-20T18:00:00Z'))
    expect(await preview(OCT, NOV2)).toMatchObject({ propinas: 2, totalVentas: '0.00' })
    const oct = await cerrar(OCT, NOV2)
    const lineas = await prisma.serviceEarning.findMany({ where: { periodId: oct.periodId }, select: { sourceId: true }, take: 10 })
    expect(lineas.map(l => l.sourceId).sort()).toEqual([t60.id, d60.id].sort())
    expect(await totalDe(oct.periodId, m.carla)).toBe('0.00')
  })

  it('comisión +$100, devolución −$40 y después anulación ⇒ $0 acumulado', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: null })
    const venta = await cobro(m, { iso: '2026-10-10T18:00:00Z', monto: 3000, venueId: B })
    const c = await comisionB('2026-10-10T18:00:05Z', 100, venta)
    const oct = await cerrar(OCT, NOV2)
    const dev = await reembolso(m, venta, { iso: '2026-11-05T18:00:00Z', monto: 1200 })
    await comisionB('2026-11-05T18:00:05Z', -40, dev)
    const nov = await cerrar(NOV, DIC2)
    await anularComision({ calculationId: c.id, venueId: B, actorId: m.owner, motivo: 'Venta capturada por error' })
    const dic = await cerrar(DIC, ENE2)
    expect([await totalDe(oct.periodId, m.sofia), await totalDe(nov.periodId, m.sofia), await totalDe(dic.periodId, m.sofia)]).toEqual([
      '100.00',
      '-40.00',
      '-60.00',
    ])
    expect(await neto(m.sofia)).toBe('0.00')
  })
})

describe('las devoluciones y anulaciones de lo que el sobre ya pagó no esperan a que la sede vuelva (r4.2)', () => {
  it('+$50 congelados en septiembre; B «hasta el 30-sep» y sin plan; −$50 el 10-oct se descuenta en octubre (B por historia); B vuelve el 1-dic y no se barre otra vez ⇒ $0', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: '2026-09-01T06:00:00Z' })
    const t = await propinaB('2026-09-10T18:00:00Z', 50)
    const sep = await cerrar(SEP, OCT2)
    expect(await totalDe(sep.periodId, m.carla)).toBe('50.00')
    await desactivarB('2026-09-30', OCT2)
    ;(global as any).__sedes = [A]
    await reembolso(m, t, { iso: '2026-10-10T18:00:00Z', propina: 50 })
    const oct = await cerrar(OCT, NOV2)
    expect(oct.venueIds).toEqual([A, B].sort())
    expect(await totalDe(oct.periodId, m.carla)).toBe('-50.00')
    await cerrar(NOV, DIC1)
    ;(global as any).__sedes = [A, B]
    await activarB({ ahora: DIC1 })
    const dic = await cerrar(DIC, ENE2)
    expect(await totalDe(dic.periodId, m.carla)).toBeNull()
    expect(await neto(m.carla)).toBe('0.00')
  })

  it('con B en el alcance sólo por historia (desactivada y sin plan), la anulación de su comisión congelada se aplica en el cierre', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: null })
    const c = await comisionB('2026-09-10T18:00:00Z', 90)
    const sep = await cerrar(SEP, OCT2)
    expect(await totalDe(sep.periodId, m.sofia)).toBe('90.00')
    await desactivarB('2026-09-30', OCT2)
    ;(global as any).__sedes = [A]
    await anularComision({ calculationId: c.id, venueId: B, actorId: m.owner, motivo: 'Venta capturada por error' })
    expect(await preview(OCT, NOV2)).toMatchObject({ reversos: 1, totalVentas: '-90.00' })
    const oct = await cerrar(OCT, NOV2)
    expect(await totalDe(oct.periodId, m.sofia)).toBe('-90.00')
    expect(await neto(m.sofia)).toBe('0.00')
  })
})

describe('sin el filtro de B4 r1 y con los rangos una vez por operación (r3.4, r4.5)', () => {
  it('un septiembre cerrado SIN B en su alcance (de antes de B11) no le quita a B lo que vendió estando activa: su comisión tardía del 20-sep entra en octubre', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: null })
    // Septiembre se cerró con las reglas de antes (alcance = guardadas ∪ con plan, y B había perdido el plan ese día).
    await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        status: 'CLOSED',
        venueIds: [A],
        closedAt: OCT2,
        closedById: m.owner,
        closeFingerprint: 'manual',
      },
    })
    const tardia = await comisionB('2026-09-20T18:00:00Z', 25)
    expect(await preview(OCT, NOV2)).toMatchObject({ comisiones: 1, totalVentas: '25.00' })
    const oct = await cerrar(OCT, NOV2)
    expect(await prisma.serviceEarning.findFirstOrThrow({ where: { sourceId: tardia.id } })).toMatchObject({ periodId: oct.periodId })
  })

  it('la vista previa y el cierre calculan periodo y participación UNA vez, aunque recorran varios lotes', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: '2026-10-01T06:00:00Z' })
    for (const dia of ['11', '12', '13']) {
      await propinaB(`2026-10-${dia}T18:00:00Z`, 10)
      await comisionB(`2026-10-${dia}T18:00:05Z`, 10)
    }
    const espia = jest.spyOn(rangos, 'rangosConParticipacion')
    try {
      const p = await previewCierre({ userId: m.owner, venueId: A, fecha: OCT, ahora: NOV2, tamLote: 1 })
      expect(p).toMatchObject({ comisiones: 3, propinas: 3, totalVentas: '60.00' })
      expect(espia).toHaveBeenCalledTimes(1)
      espia.mockClear()
      const r = await cerrarPeriodo({
        userId: m.owner,
        venueId: A,
        fecha: OCT,
        ahora: NOV2,
        tamLote: 1,
        confirmarHuerfanas: true,
        huellaEsperada: p.huella,
      })
      expect(r.total).toBe('60.00')
      expect(espia).toHaveBeenCalledTimes(1)
    } finally {
      espia.mockRestore()
    }
  })
})
