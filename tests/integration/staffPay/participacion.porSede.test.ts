// tests/integration/staffPay/participacion.porSede.test.ts — fase 3, B12 (diseño r5.4, r4.5, r3.7(3), r5.8.8, r4.9.10): la
// vista previa del cierre POR SEDE —qué entra y qué queda fuera, con montos— y la foto única. «Fuera» = completa − reales
// (completa = `[startDate, ∞)` en cada sede del alcance), por NETO: una devolución sale con su original. Nada de esto entra a la
// huella ni cambia qué se paga. Fechas de 2026 en UTC; CDMX = UTC−6.
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { activarSede, desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { AlcanceBarrido, sqlVentasDelPeriodo } from '@/services/dashboard/staffPay/fuentesVenta'
import { rangosConParticipacion } from '@/services/dashboard/staffPay/rangos'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaFija, TZ } from './_mundo'
import { activar, cobro, comision, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

const OCT2 = new Date('2026-10-02T12:00:00Z')
const NOV1 = new Date('2026-11-01T18:00:00Z')
const NOV2 = new Date('2026-11-02T12:00:00Z')
const OCT = '2026-10-15'
const cero = { n: 0, total: '0.00' }
let m: Mundo
let A: string
let B: string
let productoB: string
let cfgB: string

beforeEach(async () => {
  m = await crearMundo('part-porsede')
  A = m.venueId
  const b = await crearSede(m.orgId, m.key, 'b')
  B = b.venueId
  productoB = b.productId
  ;(global as any).__sedes = [A, B]
  cfgB = await esquema(m, B, 'Esquema B')
})
afterEach(() => borrarMundo(m))

const preview = (fecha: string, ahora: Date, o: Partial<Parameters<typeof previewCierre>[0]> = {}) =>
  previewCierre({ userId: m.owner, venueId: A, fecha, ahora, ...o })
const cerrar = async (fecha: string, ahora: Date) =>
  cerrarPeriodo({
    userId: m.owner,
    venueId: A,
    fecha,
    ahora,
    confirmarHuerfanas: true,
    huellaEsperada: (await preview(fecha, ahora)).huella,
  })
const propinaB = (iso: string, monto: number) => cobro(m, { iso, propina: monto, servedById: m.carla, venueId: B })
const comisionB = (iso: string, neto: number, pago?: { id: string; orderId: string }) =>
  comision(m, { configId: cfgB, staffId: m.sofia, iso, neto, pago, venueId: B })
const sedeDe = (p: Awaited<ReturnType<typeof previewCierre>>, venueId: string) => p.porSede.find(s => s.venueId === venueId)!
const cuenta = (c: { clases?: [number, string, number?]; comisiones?: [number, string]; propinas?: [number, string] }) => ({
  clases: { n: c.clases?.[0] ?? 0, total: c.clases?.[1] ?? '0.00', pendientesDeValoracion: c.clases?.[2] ?? 0 },
  comisiones: c.comisiones ? { n: c.comisiones[0], total: c.comisiones[1] } : cero,
  propinas: c.propinas ? { n: c.propinas[0], total: c.propinas[1] } : cero,
})

describe('«fuera» por sede (r5.8.8)', () => {
  it('B sin activar con dos clases de $500 ⇒ fuera.clases $1,000 y entra $0; una sin tabla no suma $0: pendientesDeValoracion 1', async () => {
    await tablaFija(m, A, 300)
    await tablaFija(m, B, 500)
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-19T15:00:00Z', reservas: confirmadas(5) }) // A, entra
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-20T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-21T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    const p = await preview(OCT, NOV2)
    expect(p).toMatchObject({ puedeCerrar: true, clases: 1, totalServicios: '300.00' })
    expect(p.porSede).toEqual(
      [
        {
          venueId: A,
          nombre: `${m.key}-pn`,
          estado: 'ACTIVA',
          entra: cuenta({ clases: [1, '300.00'] }),
          fuera: cuenta({}),
          pendientes: cero,
        },
        {
          venueId: B,
          nombre: `${m.key}-b`,
          estado: 'SIN_ACTIVAR',
          entra: cuenta({}),
          fuera: cuenta({ clases: [2, '1000.00'] }),
          pendientes: cero,
        },
      ].sort((x, y) => (x.venueId < y.venueId ? -1 : 1)),
    )
    // Un producto que ninguna tabla de B cubre: fuera, pero sin monto ⇒ pendiente de valorar.
    await prisma.servicePayTable.updateMany({ where: { venueId: B }, data: { productIds: [productoB] } })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-22T15:00:00Z', venueId: B, productId: m.productId, reservas: confirmadas(5) })
    expect(sedeDe(await preview(OCT, NOV2), B).fuera.clases).toEqual({ n: 2, total: '1000.00', pendientesDeValoracion: 1 })
    // Y una de A (activa) sin coach: entra al recorrido pero no se puede valuar ⇒ bloquea (EXCEPCIONES) y se cuenta aparte.
    await clase(m, { staffId: null, inicioIso: '2026-10-23T15:00:00Z', reservas: confirmadas(5) })
    const conExcepcion = await preview(OCT, NOV2)
    expect(conExcepcion.bloqueos).toEqual([{ codigo: 'EXCEPCIONES', n: 1 }])
    expect(sedeDe(conExcepcion, A).entra.clases).toEqual({ n: 1, total: '300.00', pendientesDeValoracion: 1 })
  })

  it('+$60 (10-oct) y su devolución −$60 (20-oct) alrededor de la activación de B el 15-oct ⇒ entra $0 y fuera $0 (por neto)', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    const t = await propinaB('2026-10-10T18:00:00Z', 60)
    await reembolso(m, t, { iso: '2026-10-20T18:00:00Z', propina: 60 })
    await activarSede({ userId: m.owner, venueId: A, sedeId: B, desde: '2026-10-15', ahora: NOV1 })
    const b = sedeDe(await preview(OCT, NOV2), B)
    expect(b).toMatchObject({ estado: 'ACTIVA', entra: cuenta({}) })
    expect(b.fuera.propinas.total).toBe('0.00')
  })

  it('Codex 2 (r3.5): septiembre abierto [A]; B con plan y activa el 3-nov; $100 del 10-sep ⇒ al previsualizar septiembre el 5-nov, B entra $0 y fuera 1 propina de $100', async () => {
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
    await propinaB('2026-09-10T18:00:00Z', 100)
    ;(global as any).__sedes = [A, B]
    await activarSede({ userId: m.owner, venueId: A, sedeId: B, ahora: new Date('2026-11-03T18:00:00Z') })
    const p = await preview('2026-09-15', new Date('2026-11-05T18:00:00Z'))
    expect(p).toMatchObject({ propinas: 0, totalVentas: '0.00' })
    expect(sedeDe(p, B)).toMatchObject({ estado: 'ACTIVA', entra: cuenta({}), fuera: cuenta({ propinas: [1, '100.00'] }) })
  })

  it('tercer escenario (r3.5): $100 de propina + $30 de comisión del 20-oct en B, activada el 1-nov ⇒ octubre: B entra $0 y fuera $130', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    await propinaB('2026-10-20T18:00:00Z', 100)
    await comisionB('2026-10-20T18:00:05Z', 30)
    await activarSede({ userId: m.owner, venueId: A, sedeId: B, ahora: NOV1 })
    const b = sedeDe(await preview(OCT, NOV2), B)
    expect(b).toMatchObject({ entra: cuenta({}), fuera: cuenta({ comisiones: [1, '30.00'], propinas: [1, '100.00'] }) })
  })

  it('una sede activa sin plan dice ACTIVA_SIN_PLAN (la del bloqueo); una sin plan ni ventana, SIN_PLAN', async () => {
    const C = (await crearSede(m.orgId, m.key, 'c')).venueId
    await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: null })
    await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-10-01'),
        periodEnd: fechaComoDbDate('2026-10-31'),
        venueIds: [A, B, C],
      },
    })
    ;(global as any).__sedes = [A]
    const p = await preview(OCT, NOV2)
    expect(p.bloqueos).toEqual([{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [B], otrasConPlan: true }])
    expect(Object.fromEntries(p.porSede.map(s => [s.venueId, s.estado]))).toEqual({
      [A]: 'ACTIVA',
      [B]: 'ACTIVA_SIN_PLAN',
      [C]: 'SIN_PLAN',
    })
  })
})

describe('entra + fuera = el barrido con la ventana COMPLETA, por neto, por sede y fuente (r4.9.10)', () => {
  it('B activa desde el 15-oct con clases, propinas, comisiones y una devolución a cada lado; la suma de entra cuadra con el preview', async () => {
    await tablaFija(m, A, 300)
    await tablaFija(m, B, 500)
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    await activarSede({ userId: m.owner, venueId: A, sedeId: B, desde: '2026-10-15', ahora: NOV1 })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-05T15:00:00Z', reservas: confirmadas(5) })
    for (const dia of ['10', '20']) {
      await clase(m, { staffId: m.ana, inicioIso: `2026-10-${dia}T15:00:00Z`, venueId: B, productId: productoB, reservas: confirmadas(5) })
      const t = await propinaB(`2026-10-${dia}T18:00:00Z`, 70)
      await reembolso(m, t, { iso: `2026-10-${dia}T19:00:00Z`, propina: 20 })
      await comisionB(`2026-10-${dia}T18:00:05Z`, 45)
    }
    await cobro(m, { iso: '2026-10-07T18:00:00Z', propina: 15, servedById: m.carla }) // A
    const p = await preview(OCT, NOV2)
    // Lo que entra, sumado por sede, es lo que el preview pone en el cierre.
    const suma = (f: (s: (typeof p.porSede)[number]) => string) =>
      p.porSede.reduce((acc, s) => acc.plus(f(s)), new Prisma.Decimal(0)).toFixed(2)
    expect(suma(s => s.entra.clases.total)).toBe(p.totalServicios)
    expect(new Prisma.Decimal(suma(s => s.entra.comisiones.total)).plus(suma(s => s.entra.propinas.total)).toFixed(2)).toBe(p.totalVentas)
    // El barrido con la ventana COMPLETA [inicio, ∞) en cada sede del alcance, calculado aparte con las piezas del cierre.
    const a: AlcanceBarrido = {
      organizationId: m.orgId,
      periodo: { id: null, start: '2026-10-01', end: '2026-10-31' },
      sedes: [A, B].sort().map(venueId => ({ venueId, tz: TZ })),
      startDate: '2026-10-01',
    }
    const completas = await rangosConParticipacion(prisma, a, {
      ventanas: a.sedes.map(s => ({ venueId: s.venueId, desde: '2026-10-01', hasta: null })),
    })
    const filas = await prisma.$queryRaw<Array<{ venueId: string; fuente: string; n: number; total: Prisma.Decimal }>>`
      SELECT v."venueId", v.fuente, COUNT(*)::int AS n, SUM(v.monto) AS total FROM (${sqlVentasDelPeriodo(a, completas)!}) v
      GROUP BY v."venueId", v.fuente`
    for (const s of p.porSede) {
      for (const [campo, fuente] of [
        ['comisiones', 'COMMISSION'],
        ['propinas', 'TIP'],
      ] as const) {
        const f = filas.find(x => x.venueId === s.venueId && x.fuente === fuente)
        const entra = s.entra[campo]
        const fuera = s.fuera[campo]
        expect([entra.n + fuera.n, new Prisma.Decimal(entra.total).plus(fuera.total).toFixed(2)]).toEqual([
          f?.n ?? 0,
          new Prisma.Decimal(f?.total ?? 0).toFixed(2),
        ])
      }
      // B14-fix F6: entra + fuera de clases = TODAS las de la sede, con su monto conocido del fixture (A: una de $300; B: dos
      // de $500, una de cada lado del 15-oct).
      expect([s.entra.clases.n + s.fuera.clases.n, new Prisma.Decimal(s.entra.clases.total).plus(s.fuera.clases.total).toFixed(2)]).toEqual(
        s.venueId === A ? [1, '300.00'] : [2, '1000.00'],
      )
    }
    expect(sedeDe(p, B)).toMatchObject({
      entra: cuenta({ clases: [1, '500.00'], comisiones: [1, '45.00'], propinas: [2, '50.00'] }),
      fuera: cuenta({ clases: [1, '500.00'], comisiones: [1, '45.00'], propinas: [2, '50.00'] }),
    })
  })
})

describe('una sola foto (r4.5, r5.4)', () => {
  it('desactivar B ENTRE dos lecturas internas del preview no mezcla: todo dice lo de antes; la siguiente vista previa ya ve lo nuevo', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: '2026-10-01T06:00:00Z' })
    await propinaB('2026-10-10T18:00:00Z', 60)
    await propinaB('2026-10-17T18:00:00Z', 70)
    let corrio = false
    const p = await preview(OCT, NOV2, {
      entreLecturas: async () => {
        await desactivarSede({ userId: m.owner, venueId: A, sedeId: B, hasta: '2026-10-15', ahora: NOV2 })
        await propinaB('2026-10-11T18:00:00Z', 5) // y una venta nueva, que tampoco se ve
        corrio = true
      },
    })
    expect(corrio).toBe(true)
    expect(p).toMatchObject({ propinas: 2, totalVentas: '130.00' })
    expect(sedeDe(p, B)).toMatchObject({ estado: 'ACTIVA', entra: cuenta({ propinas: [2, '130.00'] }), fuera: cuenta({}) })
    // Después: B quedó activa hasta el 15-oct ($60 y la nueva de $5 entran; la de $70 del 17-oct queda fuera).
    const despues = sedeDe(await preview(OCT, NOV2), B)
    expect(despues).toMatchObject({
      estado: 'SIN_ACTIVAR',
      entra: cuenta({ propinas: [2, '65.00'] }),
      fuera: cuenta({ propinas: [1, '70.00'] }),
    })
  })

  it('el alcance también sale de la foto: si el periodo se cierra entre la preparación y la foto, la vista previa es la del cerrado', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    await cobro(m, { iso: '2026-10-10T18:00:00Z', propina: 40, servedById: m.carla })
    const antes = await preview(OCT, NOV2)
    const p = await preview(OCT, NOV2, {
      trasPreparar: async () => {
        await cerrarPeriodo({
          userId: m.owner,
          venueId: A,
          fecha: OCT,
          ahora: NOV2,
          confirmarHuerfanas: true,
          huellaEsperada: antes.huella,
        })
      },
    })
    expect(p).toMatchObject({ puedeCerrar: false, bloqueos: [{ codigo: 'YA_CERRADO' }], total: '40.00', huella: '' })
  })
})

describe('fuera de la huella (r3.6)', () => {
  it('lo que cambia sólo «fuera» o las pendientes no cambia la huella, y el cierre con la huella vieja pasa', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: '2026-09-01T06:00:00Z' })
    const sep = await cobro(m, { iso: '2026-09-10T18:00:00Z', propina: 50, servedById: m.carla })
    await cerrar('2026-09-15', OCT2)
    await cobro(m, { iso: '2026-10-10T18:00:00Z', propina: 40, servedById: m.carla })
    const antes = await preview(OCT, NOV2)
    await propinaB('2026-10-12T18:00:00Z', 90) // B sin activar: queda fuera
    await reembolso(m, sep, { iso: '2026-11-01T18:00:00Z', propina: 50 }) // de noviembre: pendiente, no línea de octubre
    const despues = await preview(OCT, NOV2)
    expect(sedeDe(despues, B).fuera.propinas).toEqual({ n: 1, total: '90.00' })
    expect(despues.pendientes).toMatchObject({ n: 1, total: '-50.00' })
    expect(despues.huella).toBe(antes.huella)
    expect((await cerrar(OCT, NOV2)).total).toBe('40.00')
  })
})
