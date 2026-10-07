// tests/integration/staffPay/participacion.lectura.test.ts — participación por sede, fase 3 B10 (diseño r6.1, r4.1, r3.4,
// r2 §6): las piezas que LEEN la participación, preparadas SIN CONECTAR. Ningún camino de producción las usa todavía: aquí se
// prueban directo. La suite vieja (con `'ninguna'` y `rv = rp`) es la que fija que los montos de hoy no cambian.
// Fechas de 2026 en UTC; CDMX = UTC−6, Tijuana = UTC−7 hasta el 1-nov (a las 2:00) y UTC−8 después.
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { valoracionCte, valorarClases } from '@/services/dashboard/staffPay/valoracion'
import {
  AlcanceBarrido,
  comisionBarrible,
  propinasBase,
  RangoSede,
  rangosBarribles,
  rangosConParticipacion,
  reversoDeLoCongelado,
} from '@/services/dashboard/staffPay/fuentesVenta'
import { sedesConVentana } from '@/services/dashboard/staffPay/participacion'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, TZ } from './_mundo'
import { activar, cobro, comision, congelar, esquema, reembolso } from './_ventas'

const TIJ = 'America/Tijuana'
let m: Mundo
const orgsExtra: string[] = []
beforeEach(async () => {
  m = await crearMundo('part-lectura')
})
afterEach(async () => {
  for (const id of orgsExtra.splice(0)) {
    await prisma.venue.deleteMany({ where: { organizationId: id } })
    await prisma.organization.deleteMany({ where: { id } })
  }
  await borrarMundo(m)
})

const iniciar = (desde: string) =>
  prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate(desde) } })
const ventana = (venueId: string, desde: string, hasta: string | null = null, organizationId = m.orgId) =>
  prisma.staffPayVenueWindow.create({
    data: {
      organizationId,
      venueId,
      desde: fechaComoDbDate(desde),
      hasta: hasta ? fechaComoDbDate(hasta) : null,
      activadaPor: m.owner,
      desactivadaPor: hasta ? m.owner : null,
    },
  })
const periodo = (start: string, end: string, status: 'OPEN' | 'CLOSED', venueIds = [m.venueId]) =>
  prisma.servicePayPeriod.create({
    data: {
      organizationId: m.orgId,
      periodStart: fechaComoDbDate(start),
      periodEnd: fechaComoDbDate(end),
      status,
      venueIds,
      ...(status === 'CLOSED' ? { closedAt: new Date(), closedById: m.owner, closeFingerprint: 'manual' } : {}),
    },
  })
async function otraOrg(s: string) {
  const o = await prisma.organization.create({
    data: { name: `${m.key}-${s}`, slug: `${m.key}-${s}`, email: `${m.key}-${s}@example.test`, phone: '5500000000' },
  })
  orgsExtra.push(o.id)
  return o.id
}
/** Una tabla que paga $500 a la Head Coach con cualquier conteo. */
async function tabla500(venueId: string) {
  const t = await prisma.servicePayTable.create({ data: { venueId, name: 'Todas', productIds: [] } })
  const v = await prisma.servicePayTableVersion.create({
    data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1, maxCount: 10 },
  })
  await prisma.servicePayTableCell.createMany({
    data: Array.from({ length: 11 }, (_, count) => ({ versionId: v.id, payLevelId: m.hc, count, amount: new Prisma.Decimal(500) })),
  })
}
const iso = (r: RangoSede[]) => r.map(x => [x.venueId, x.desde.toISOString(), x.hasta.toISOString()])

// ── 1. Clases: `valoracionCte` con `participacion` (r6.1, r4.1) ──────────────────────────────────────────────────────────

describe('valoracionCte con participación (B10, r4.1)', () => {
  it("'real' exige la ventana de la sede en la fecha local de la clase desde el inicio; 'fuera' es justo lo contrario; 'ninguna' es lo de hoy", async () => {
    const b = await crearSede(m.orgId, m.key, 'b')
    await tabla500(m.venueId)
    await tabla500(b.venueId)
    await iniciar('2026-09-01')
    await ventana(m.venueId, '2026-09-01')
    await ventana(b.venueId, '2026-11-01') // B activa desde el 1-nov
    const deB = (inicioIso: string) =>
      clase(m, { staffId: m.ana, inicioIso, venueId: b.venueId, productId: b.productId, reservas: confirmadas(5) })
    const ago20 = await deB('2026-08-20T15:00:00Z') // antes del inicio: regla D2, entra sin ventana
    const oct20 = await deB('2026-10-20T15:00:00Z') // desde el inicio, sin ventana de B: fuera
    const oct31 = await deB('2026-11-01T05:30:00Z') // 23:30 del 31-oct en CDMX: todavía fuera
    const nov01 = await deB('2026-11-01T06:30:00Z') // 00:30 del 1-nov en CDMX: ya entra
    const nov05 = await deB('2026-11-05T15:00:00Z')
    const deA = await clase(m, { staffId: m.ana, inicioIso: '2026-10-20T15:00:00Z', reservas: confirmadas(5) })
    // Una ventana de B en OTRA organización (historia de antes de un traslado) no cuenta para ésta.
    await ventana(b.venueId, '2026-10-01', '2026-10-31', await otraOrg('z'))

    const f = (venueId: string, participacion?: 'ninguna' | 'real' | 'fuera') => ({
      venueId,
      organizationId: m.orgId,
      tz: TZ,
      desde: new Date('2026-08-01T06:00:00Z'),
      hasta: new Date('2026-12-01T06:00:00Z'),
      ahora: new Date('2026-11-10T00:00:00Z'),
      participacion,
    })
    const valoradas = async (venueId: string, participacion?: 'ninguna' | 'real' | 'fuera') =>
      Object.fromEntries(
        (await valorarClases(prisma, f(venueId, participacion), { limite: 100 })).map(c => [c.classSessionId, c.monto?.toFixed(2)]),
      )
    const sorted = (o: Record<string, unknown>) => Object.keys(o).sort()

    expect(sorted(await valoradas(b.venueId))).toEqual([ago20, oct20, oct31, nov01, nov05].sort())
    expect(sorted(await valoradas(b.venueId, 'ninguna'))).toEqual([ago20, oct20, oct31, nov01, nov05].sort())
    expect(await valoradas(b.venueId, 'real')).toEqual({ [ago20]: '500.00', [nov01]: '500.00', [nov05]: '500.00' })
    expect(await valoradas(b.venueId, 'fuera')).toEqual({ [oct20]: '500.00', [oct31]: '500.00' })
    expect(await valoradas(m.venueId, 'real')).toEqual({ [deA]: '500.00' })
    expect(await valoradas(m.venueId, 'fuera')).toEqual({})

    // Sin activar, todo sigue D2: entra con 'real' aunque no haya ninguna ventana.
    await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: null } })
    expect(sorted(await valoradas(b.venueId, 'real'))).toEqual([ago20, oct20, oct31, nov01, nov05].sort())
    expect(await valoradas(b.venueId, 'fuera')).toEqual({})
  })

  it("la rama de anclas no se filtra: una clase anclada entra con 'real' aunque su sede no tenga ventana; 'fuera' + modo periodo truena", async () => {
    const b = await crearSede(m.orgId, m.key, 'b')
    await tabla500(b.venueId)
    await iniciar('2026-09-01')
    const oct = await periodo('2026-10-01', '2026-10-31', 'OPEN', [m.venueId, b.venueId])
    const deB = (inicioIso: string) =>
      clase(m, { staffId: m.ana, inicioIso, venueId: b.venueId, productId: b.productId, reservas: confirmadas(5) })
    const anclada = await deB('2026-10-21T15:00:00Z')
    await prisma.classSessionPayState.create({ data: { classSessionId: anclada, originPeriodId: oct.id } })
    const sinAncla = await deB('2026-10-20T15:00:00Z')
    const f = (participacion: 'ninguna' | 'real' | 'fuera') => ({
      venueId: b.venueId,
      organizationId: m.orgId,
      tz: TZ,
      desde: new Date('2026-10-01T06:00:00Z'),
      hasta: new Date('2026-11-01T06:00:00Z'),
      ahora: new Date('2026-11-02T00:00:00Z'),
      modo: 'periodo' as const,
      periodId: oct.id,
      participacion,
    })
    const ids = async (p: 'ninguna' | 'real') => (await valorarClases(prisma, f(p), { limite: 100 })).map(c => c.classSessionId).sort()
    expect(await ids('ninguna')).toEqual([anclada, sinAncla].sort())
    expect(await ids('real')).toEqual([anclada])
    expect(() => valoracionCte(f('fuera'))).toThrow("'fuera' sólo se usa en modo vivo")
  })
})

// ── 2. `rangosConParticipacion` (r3.4 + r4 + r4.5) ────────────────────────────────────────────────────────────────────────

describe('rangosConParticipacion (B10, r3.4)', () => {
  it('periodo = P más los CERRADOS ANTERIORES a P (no los posteriores), igual para todas las sedes; participación = periodo ∩ ventanas en días civiles', async () => {
    const tij = await crearSede(m.orgId, m.key, 'tij')
    await prisma.venue.update({ where: { id: tij.venueId }, data: { timezone: TIJ } })
    const sinVentana = await crearSede(m.orgId, m.key, 'c')
    await iniciar('2026-09-01')
    await periodo('2026-08-01', '2026-08-31', 'CLOSED') // antes del inicio: no barre
    await periodo('2026-09-01', '2026-09-30', 'CLOSED') // sólo con A en su alcance: el periodo vale igual para las tres
    const oct = await periodo('2026-10-01', '2026-10-31', 'OPEN')
    await periodo('2026-12-01', '2026-12-31', 'CLOSED') // POSTERIOR a P (cierre fuera de orden): no barre
    await ventana(m.venueId, '2026-09-16', '2026-11-10') // a media quincena
    await ventana(tij.venueId, '2026-10-01')
    const a: AlcanceBarrido = {
      organizationId: m.orgId,
      periodo: { id: null, start: '2026-11-01', end: '2026-11-30' },
      sedes: [
        { venueId: m.venueId, tz: TZ },
        { venueId: tij.venueId, tz: TIJ },
        { venueId: sinVentana.venueId, tz: TZ },
      ],
      startDate: '2026-09-01',
    }
    const [A, T, C] = [m.venueId, tij.venueId, sinVentana.venueId]

    let r = await rangosConParticipacion(prisma, a)
    expect(iso(r.periodo)).toEqual([
      [A, '2026-09-01T06:00:00.000Z', '2026-10-01T06:00:00.000Z'],
      [A, '2026-11-01T06:00:00.000Z', '2026-12-01T06:00:00.000Z'],
      [T, '2026-09-01T07:00:00.000Z', '2026-10-01T07:00:00.000Z'],
      [T, '2026-11-01T07:00:00.000Z', '2026-12-01T08:00:00.000Z'],
      [C, '2026-09-01T06:00:00.000Z', '2026-10-01T06:00:00.000Z'],
      [C, '2026-11-01T06:00:00.000Z', '2026-12-01T06:00:00.000Z'],
    ])
    expect(iso(r.participacion)).toEqual([
      [A, '2026-09-16T06:00:00.000Z', '2026-10-01T06:00:00.000Z'],
      [A, '2026-11-01T06:00:00.000Z', '2026-11-11T06:00:00.000Z'],
      [T, '2026-11-01T07:00:00.000Z', '2026-12-01T08:00:00.000Z'],
    ])
    // `rangosBarribles` no cambia en B10: sigue con el filtro por el alcance de cada cerrado (B4 r1).
    expect(iso(await rangosBarribles(prisma, a)).filter(x => x[0] === T)).toEqual([
      [T, '2026-11-01T07:00:00.000Z', '2026-12-01T08:00:00.000Z'],
    ])

    // Octubre se cierra: los contiguos se juntan en uno.
    await prisma.servicePayPeriod.update({
      where: { id: oct.id },
      data: { status: 'CLOSED', closedAt: new Date(), closedById: m.owner, closeFingerprint: 'manual' },
    })
    r = await rangosConParticipacion(prisma, a)
    expect(iso(r.periodo)).toEqual([
      [A, '2026-09-01T06:00:00.000Z', '2026-12-01T06:00:00.000Z'],
      [T, '2026-09-01T07:00:00.000Z', '2026-12-01T08:00:00.000Z'],
      [C, '2026-09-01T06:00:00.000Z', '2026-12-01T06:00:00.000Z'],
    ])
    expect(iso(r.participacion)).toEqual([
      [A, '2026-09-16T06:00:00.000Z', '2026-11-11T06:00:00.000Z'],
      [T, '2026-10-01T07:00:00.000Z', '2026-12-01T08:00:00.000Z'],
    ])

    // Ventanas simuladas (las vistas previas de B11-B12): reemplazan la lectura.
    r = await rangosConParticipacion(prisma, a, { ventanas: [{ venueId: C, desde: '2026-11-05', hasta: null }] })
    expect(iso(r.participacion)).toEqual([[C, '2026-11-05T06:00:00.000Z', '2026-12-01T06:00:00.000Z']])

    // Un periodo que termina antes del inicio no barre nada.
    expect(await rangosConParticipacion(prisma, { ...a, periodo: { id: null, start: '2026-08-01', end: '2026-08-31' } })).toEqual({
      periodo: [],
      participacion: [],
    })
  })
})

// ── 3. Constructores de ventas con `(rp, rv)` y `reversoDeLoCongelado` (r6.1, r6.2, r2 §6) ─────────────────────────────

describe('constructores de ventas con (rp, rv) (B10, r2 §6)', () => {
  it('la venta exige rv; el reverso de lo congelado sólo rp; el de una original que entra en este cierre, su original en rv', async () => {
    await activar(m) // inicio 1-ago, propinas encendidas desde el 1-ago
    const cfg = await esquema(m)
    const ago = await periodo('2026-08-01', '2026-08-31', 'CLOSED')
    const venta = async (dia: string, neto: number, propina: number) => {
      const p = await cobro(m, { iso: `2026-${dia}T18:00:00Z`, monto: 3000, propina, servedById: m.carla })
      const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: `2026-${dia}T18:00:05Z`, neto, pago: p })
      return { p, c }
    }
    const devolver = async (o: Awaited<ReturnType<typeof venta>>, dia: string, neto: number, propina: number) => {
      const p = await reembolso(m, o.p, { iso: `2026-${dia}T19:00:00Z`, monto: 3000, propina })
      const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: `2026-${dia}T19:00:05Z`, neto: -neto, pago: p })
      return { p, c }
    }
    // Congeladas en agosto; se devuelven el 10-sep (fuera de rv).
    const o1 = await venta('08-05', 90, 50)
    await congelar(m, ago.id, { fuente: 'COMMISSION', sourceId: o1.c.id, staffId: m.sofia, monto: 90 })
    await congelar(m, ago.id, { fuente: 'TIP', sourceId: o1.p.id, staffId: m.carla, monto: 50 })
    const r1 = await devolver(o1, '09-10', 90, 50)
    // Congelada pero ANULADA: su reverso no se descuenta (la anulación ya devuelve todo).
    const o5p = await cobro(m, { iso: '2026-08-06T18:00:00Z', monto: 3000 })
    const o5 = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-06T18:00:05Z', neto: 70, pago: o5p, status: 'VOIDED' })
    await congelar(m, ago.id, { fuente: 'COMMISSION', sourceId: o5.id, staffId: m.sofia, monto: 70 })
    await devolver({ p: o5p, c: o5 }, '09-11', 70, 0) // r5
    const v1 = await venta('09-10', 60, 40) // fuera de rv
    const v2 = await venta('09-20', 45, 30) // dentro de rv
    const o3 = await venta('09-12', 30, 20) // original fuera de rv, sin congelar
    const r3 = await devolver(o3, '09-25', 30, 20)
    const o4 = await venta('09-20', 35, 25) // original dentro de rv, sin congelar
    const r4 = await devolver(o4, '09-25', 35, 25)

    const a: AlcanceBarrido = {
      organizationId: m.orgId,
      periodo: { id: null, start: '2026-09-01', end: '2026-09-30' },
      sedes: [{ venueId: m.venueId, tz: TZ }],
      startDate: '2026-08-01',
    }
    const rp = await rangosBarribles(prisma, a)
    const rv: RangoSede[] = [{ venueId: m.venueId, desde: new Date('2026-09-16T06:00:00Z'), hasta: new Date('2026-10-01T06:00:00Z') }]
    const comisiones = async (x: RangoSede[], y: RangoSede[]) =>
      (
        await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT cc.id FROM "CommissionCalculation" cc WHERE cc."venueId" = ${m.venueId} AND ${comisionBarrible(x, y)}`,
        )
      )
        .map(f => f.id)
        .sort()
    const propinas = async (x: RangoSede[], y: RangoSede[]) =>
      Object.fromEntries(
        (
          await prisma.$queryRaw<Array<{ id: string; staffId: string }>>(
            Prisma.sql`SELECT b.id, b."staffId" FROM (${propinasBase(a, x, y)}) b WHERE b."staffId" IS NOT NULL`,
          )
        ).map(f => [f.id, f.staffId]),
      )

    // rv = rp: lo de hoy.
    expect(await comisiones(rp, rp)).toEqual([r1.c.id, v1.c.id, v2.c.id, o3.c.id, r3.c.id, o4.c.id, r4.c.id].sort())
    expect(await propinas(rp, rp)).toEqual(Object.fromEntries([r1.p, v1.p, v2.p, o3.p, r3.p, o4.p, r4.p].map(p => [p.id, m.carla])))
    // rv más chico: la venta del 10-sep no entra; la devolución de la original congelada SÍ (su fecha sólo pide rp).
    expect(await comisiones(rp, rv)).toEqual([r1.c.id, v2.c.id, o4.c.id, r4.c.id].sort())
    expect(await propinas(rp, rv)).toEqual(Object.fromEntries([r1.p, v2.p, o4.p, r4.p].map(p => [p.id, m.carla])))

    // El predicado de las pendientes (B12): exactamente los reversos de lo congelado y no anulado, sin su propio SERVICE.
    const reversos = async () => ({
      COMMISSION: (
        await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT cc.id FROM "CommissionCalculation" cc WHERE cc."venueId" = ${m.venueId} AND ${reversoDeLoCongelado('COMMISSION', 'cc')}`,
        )
      ).map(f => f.id),
      TIP: (
        await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT p.id FROM "Payment" p WHERE p."venueId" = ${m.venueId} AND ${reversoDeLoCongelado('TIP', 'p')}`,
        )
      ).map(f => f.id),
    })
    expect(await reversos()).toEqual({ COMMISSION: [r1.c.id], TIP: [r1.p.id] }) // ni r5 (original anulada) ni r3/r4 (sin congelar)
    // Ya descontados (su propio SERVICE): dejan de serlo.
    const sep = await periodo('2026-09-01', '2026-09-30', 'CLOSED')
    await congelar(m, sep.id, { fuente: 'COMMISSION', sourceId: r1.c.id, staffId: m.sofia, monto: -90 })
    await congelar(m, sep.id, { fuente: 'TIP', sourceId: r1.p.id, staffId: m.carla, monto: -50 })
    expect(await reversos()).toEqual({ COMMISSION: [], TIP: [] })
  })
})

// ── 4. `sedesConVentana` (r4.2) ───────────────────────────────────────────────────────────────────────────────────────────

describe('sedesConVentana (B10, r4.2)', () => {
  it('las sedes con alguna ventana (abierta o cerrada) de ESTA organización, ordenadas y sin repetidos', async () => {
    const b = await crearSede(m.orgId, m.key, 'b')
    const sinVentana = await crearSede(m.orgId, m.key, 'c')
    const z = await otraOrg('z')
    const ajena = await crearSede(z, m.key, 'z')
    await ventana(m.venueId, '2026-09-01', '2026-09-30')
    await ventana(m.venueId, '2026-10-05')
    await ventana(b.venueId, '2026-09-01')
    await ventana(ajena.venueId, '2026-09-01', null, z)
    expect(await sedesConVentana(prisma, m.orgId)).toEqual([m.venueId, b.venueId].sort())
    expect(await sedesConVentana(prisma, m.orgId)).not.toContain(sinVentana.venueId)
  })
})
