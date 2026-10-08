// tests/integration/commission/resumenesCalculados.integration.test.ts
/**
 * E6a-fix2 C6 (full-testing): «Resumen de Comisiones» contradecía al recibo y al KPI «Calculado» porque leía los montos que
 * GUARDÓ el job diario en `CommissionSummary`. Medido en la base de QA (av-db-25-pago-f3-qa, 8-oct), cada diferencia tiene su
 * causa, y esta prueba reproduce cada una con datos propios:
 *
 *   Main Owner $230.00 vs $222.38   el job sumó DOS veces una comisión de $7.62 (paymentCount 60, 59 filas ligadas; ventas
 *                                   guardadas $254.00 de más): el incremento no es idempotente.
 *   María $103.56 vs $103.57        el resumen guardó la suma SIN redondear (103.5642) y el recibo suma renglones redondeados.
 *   Admin Venue 1 sept. ($75.00)    sin ningún resumen: 15 comisiones del 30-sep, después de la última pasada del mes; el job
 *                                   sólo agrega el periodo EN CURSO, así que nunca entran.
 *   Admin Venue 1 oct. $15 vs $10   el reverso de −$5.00 de la devolución de hoy todavía no se agrega.
 *   Main Owner oct. $0 vs $42.62    lo cobrado hoy, igual.
 *   Carlos $37.77                   ya lo pagó el flujo viejo: es CALCULADO de verdad (lo explica la nota del dashboard).
 *
 * Ahora la tabla lee lo CALCULADO con la fuente del KPI: comisiones vivas (sin anuladas, con sus reversos), por persona y
 * periodo de agregación de la sede, en su zona. La forma de la respuesta no cambia.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/commission/resumenesCalculados.integration.test.ts --ci
 */
import { Prisma, TierPeriod } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getCommissionSummaries, resumenesCalculados } from '@/services/dashboard/commission/commission-aggregation.service'
import { getStaffCommissions, getVenueCommissionStats } from '@/services/dashboard/commission/commission-calculation.service'
import { getPeriodDateRange } from '@/services/dashboard/commission/commission-utils'
import { getSummaries } from '@/controllers/dashboard/commission.dashboard.controller'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from './_mundoComisiones'

const D = (n: number) => new Prisma.Decimal(n)
let m: MundoComisiones

beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('resumenes')
})
afterEach(() => borrarMundoComisiones(m))

/** Una comisión como la deja el motor: `netCommission` ya redondeado a centavos. */
async function comision(
  staffId: string,
  iso: string,
  neto: number,
  o: { base?: number; status?: 'CALCULATED' | 'AGGREGATED' | 'VOIDED'; summaryId?: string } = {},
) {
  return prisma.commissionCalculation.create({
    data: {
      venueId: m.venueId,
      staffId,
      configId: m.configId,
      baseAmount: D(o.base ?? neto * 10),
      effectiveRate: D(0.1),
      grossCommission: D(neto),
      netCommission: D(neto),
      calcType: 'PERCENTAGE',
      status: o.status ?? (o.summaryId ? 'AGGREGATED' : 'CALCULATED'),
      summaryId: o.summaryId ?? null,
      calculatedAt: new Date(iso),
      ...(o.status === 'VOIDED' ? { voidedAt: new Date(iso), voidReason: 'prueba' } : {}),
    },
  })
}

/** Un resumen con lo que GUARDÓ el job (puede no cuadrar con sus filas: es lo que se mide). Mensual, en CDMX. */
async function resumen(staffId: string, mes: '2026-08' | '2026-09' | '2026-10', guardado: number, pagos: number, status = 'CALCULATED') {
  const rango = {
    '2026-08': ['2026-08-01T06:00:00.000Z', '2026-09-01T05:59:59.999Z'],
    '2026-09': ['2026-09-01T06:00:00.000Z', '2026-10-01T05:59:59.999Z'],
    '2026-10': ['2026-10-01T06:00:00.000Z', '2026-11-01T05:59:59.999Z'],
  }[mes]
  return (
    await prisma.commissionSummary.create({
      data: {
        venueId: m.venueId,
        staffId,
        periodType: TierPeriod.MONTHLY,
        periodStart: new Date(rango[0]),
        periodEnd: new Date(rango[1]),
        totalSales: D(guardado * 10),
        totalCommissions: D(guardado),
        grossAmount: D(guardado),
        netAmount: D(guardado),
        grandTotal: D(guardado),
        paymentCount: pagos,
        status: status as any,
      },
    })
  ).id
}

/** El mundo de la QA, en chico. */
async function mundoDeLaQa() {
  // María: el resumen guardó la suma sin redondear (18.3981 + 11.7174 + 34.5072 = 64.6227 → 64.62); las filas suman 64.63.
  const maria = await resumen(m.ana, '2026-09', 64.62, 3)
  await comision(m.ana, '2026-09-07T01:48:55Z', 18.4, { summaryId: maria })
  await comision(m.ana, '2026-09-08T19:17:41Z', 11.72, { summaryId: maria })
  await comision(m.ana, '2026-09-09T19:25:25Z', 34.51, { summaryId: maria })
  // Main Owner: la comisión de $7.62 sumada DOS veces (3 pagos contados, 2 filas ligadas), más un reverso.
  const owner = await resumen(m.bea, '2026-09', 7.62 + 7.62 + 20 - 5, 4)
  await comision(m.bea, '2026-09-22T13:27:35Z', 7.62, { summaryId: owner })
  await comision(m.bea, '2026-09-23T15:00:00Z', 20, { summaryId: owner })
  await comision(m.bea, '2026-09-26T15:38:47Z', -5, { summaryId: owner })
  // Admin: comisiones de septiembre sin resumen (después de la última pasada); la de las 23:30 del 30-sep en CDMX es 1-oct UTC.
  await comision(m.owner, '2026-09-30T09:31:03Z', 5)
  await comision(m.owner, '2026-10-01T05:30:00Z', 5)
  // Admin en octubre: el resumen guardó 3 × $5 y el reverso de hoy (−$5) todavía no se agrega.
  const adminOct = await resumen(m.owner, '2026-10', 15, 3)
  for (const iso of ['2026-10-01T16:50:01Z', '2026-10-02T05:20:15Z', '2026-10-02T19:43:51Z'])
    await comision(m.owner, iso, 5, { summaryId: adminOct })
  await comision(m.owner, '2026-10-08T04:20:36Z', -5)
  // Carlos: lo pagó el flujo viejo; sigue siendo CALCULADO.
  const carlos = await resumen(m.bea, '2026-08', 37.77, 1, 'PAID')
  await comision(m.bea, '2026-08-20T18:00:00Z', 37.77, { summaryId: carlos })
  await prisma.commissionPayout.create({
    data: { venueId: m.venueId, staffId: m.bea, summaryId: carlos, amount: D(37.77), paymentMethod: 'CASH', status: 'PAID' },
  })
  // Una anulada nunca cuenta (ni en el KPI).
  await comision(m.ana, '2026-10-03T18:00:00Z', 100, { status: 'VOIDED' })
  return { maria, owner, adminOct, carlos }
}

const fila = (filas: any[], staffId: string, inicio: string) =>
  filas.find(f => f.staffId === staffId && f.periodStart.toISOString() === inicio)
const SEP = '2026-09-01T06:00:00.000Z'
const OCT = '2026-10-01T06:00:00.000Z'
const AGO = '2026-08-01T06:00:00.000Z'

describe('C6 · la tabla «Resumen de Comisiones» dice lo CALCULADO, con la fuente del KPI', () => {
  it('cada persona y periodo: comisiones vivas, sin anuladas, con sus reversos; no lo que guardó el job', async () => {
    const r = await mundoDeLaQa()
    const filas = await getCommissionSummaries(m.venueId)
    const montos = (f: any) => f && { comision: f.totalCommissions.toFixed(2), neto: f.netAmount.toFixed(2), pagos: f.paymentCount }
    expect(montos(fila(filas, m.ana, SEP))).toEqual({ comision: '64.63', neto: '64.63', pagos: 3 }) // redondeo por renglón
    expect(montos(fila(filas, m.bea, SEP))).toEqual({ comision: '22.62', neto: '22.62', pagos: 3 }) // sin la doble suma
    expect(montos(fila(filas, m.owner, SEP))).toEqual({ comision: '10.00', neto: '10.00', pagos: 2 }) // sin resumen
    expect(montos(fila(filas, m.owner, OCT))).toEqual({ comision: '10.00', neto: '10.00', pagos: 4 }) // con el reverso de hoy
    expect(montos(fila(filas, m.bea, AGO))).toEqual({ comision: '37.77', neto: '37.77', pagos: 1 }) // pagado por el flujo viejo
    expect(fila(filas, m.ana, OCT)).toBeUndefined() // sólo una anulada: no hay nada calculado
    expect(filas).toHaveLength(5)
    // Lo que sí viene del resumen guardado (cuando existe): su id y su estado.
    expect(fila(filas, m.ana, SEP)).toMatchObject({ id: r.maria, status: 'CALCULATED' })
    expect(fila(filas, m.bea, AGO)).toMatchObject({ id: r.carlos, status: 'PAID', _count: { calculations: 1, payouts: 1 } })
    // Sin resumen: un id propio que no choca y el estado «calculado».
    const sinResumen = fila(filas, m.owner, SEP)
    expect(sinResumen).toMatchObject({ status: 'CALCULATED', periodEnd: new Date('2026-10-01T05:59:59.999Z') })
    expect(new Set(filas.map(f => f.id)).size).toBe(filas.length)
  })

  it('la suma de la tabla es EXACTAMENTE el KPI «Calculado» (misma fuente, mismo redondeo)', async () => {
    await mundoDeLaQa()
    const filas = await getCommissionSummaries(m.venueId)
    const suma = filas.reduce((s: Prisma.Decimal, f: any) => s.plus(f.netAmount), D(0))
    const kpi = await getVenueCommissionStats(m.venueId)
    expect(suma.toFixed(2)).toBe(D(kpi.totalCalculated).toFixed(2))
    expect(suma.toFixed(2)).toBe('145.02')
  })

  it('la forma de la respuesta no cambia: los mismos campos, la persona con su staffVenueId, orden por periodo y apellido', async () => {
    await mundoDeLaQa()
    const filas = await getCommissionSummaries(m.venueId)
    const campos = [...Object.values(Prisma.CommissionSummaryScalarFieldEnum), 'staff', 'approvedBy', '_count'].sort()
    for (const f of filas) expect(Object.keys(f).sort()).toEqual(campos)
    const sv = await prisma.staffVenue.findFirstOrThrow({ where: { staffId: m.owner, venueId: m.venueId }, select: { id: true } })
    expect(fila(filas, m.owner, OCT).staff).toEqual({
      id: m.owner,
      firstName: 'owner',
      lastName: 'QA',
      email: `${m.key}-owner@example.test`,
      staffVenueId: sv.id,
    })
    // El más reciente primero; dentro del periodo, por apellido (aquí todos «QA») y nombre.
    expect(filas.map(f => f.periodStart.toISOString())).toEqual([OCT, SEP, SEP, SEP, AGO])
    expect(filas.slice(1, 4).map(f => f.staff.firstName)).toEqual(['ana', 'bea', 'owner'])
  })

  it('filtros de siempre: persona y periodo', async () => {
    await mundoDeLaQa()
    expect((await getCommissionSummaries(m.venueId, { staffId: m.owner })).map(f => f.periodStart.toISOString())).toEqual([OCT, SEP])
    const desdeSep = await getCommissionSummaries(m.venueId, { periodStart: new Date(SEP) })
    expect(desdeSep.map(f => f.periodStart.toISOString())).toEqual([OCT, SEP, SEP, SEP])
    expect(await getCommissionSummaries(m.venueId, { status: 'PAID' as any })).toHaveLength(1)
  })

  it('acotada en el servidor: un tope por encima de lo que pidan, y el total verdadero en la respuesta', async () => {
    await mundoDeLaQa()
    expect(await getCommissionSummaries(m.venueId, { limite: 2 })).toHaveLength(2)
    // El total es el de ANTES del tope: un recorte nunca es silencioso.
    expect(await resumenesCalculados(m.venueId, { limite: 2 })).toMatchObject({ total: 5, filas: expect.any(Array) })
    // Un límite hostil no pasa del tope (500): el LIMIT de la consulta es el último parámetro.
    const espia = jest.spyOn(prisma, '$queryRaw')
    try {
      await getCommissionSummaries(m.venueId, { limite: 1_000_000 })
      const sql = espia.mock.calls[espia.mock.calls.length - 1][0] as unknown as Prisma.Sql
      expect(sql.values[sql.values.length - 1]).toBe(500)
    } finally {
      espia.mockRestore()
    }
    let cuerpo: any
    await getSummaries({ params: { venueId: m.venueId }, query: {} } as any, { json: (b: any) => (cuerpo = b) } as any, jest.fn())
    expect(cuerpo.data).toHaveLength(5)
    expect(cuerpo.total).toBe(5)
  })

  it('el hermano: el historial de la persona en Equipo (getStaffCommissions) trae los mismos montos vivos', async () => {
    await mundoDeLaQa()
    const r = await getStaffCommissions(m.bea, m.venueId)
    expect(r.summaries.map((s: any) => [s.periodStart.toISOString(), s.netAmount.toFixed(2)])).toEqual([
      [SEP, '22.62'],
      [AGO, '37.77'],
    ])
  })

  it('E6a-fix4: con 13 periodos el historial trae 12 renglones y summariesTotal dice 13 (y con pocos, el total real)', async () => {
    for (let mes = 0; mes < 13; mes++) await comision(m.ana, new Date(Date.UTC(2025, 8 + mes, 15, 18)).toISOString(), 10)
    const r = await getStaffCommissions(m.ana, m.venueId)
    expect(r.summaries).toHaveLength(12)
    expect(r.summariesTotal).toBe(13)
    await mundoDeLaQa()
    expect((await getStaffCommissions(m.bea, m.venueId)).summariesTotal).toBe(2)
  })

  it.each(Object.values(TierPeriod))(
    'el periodo de cada renglón es el MISMO que usa el job (%s, en la zona de la sede, en las orillas)',
    async periodo => {
      await prisma.commissionConfig.update({ where: { id: m.configId }, data: { aggregationPeriod: periodo } })
      const instantes = ['2026-10-05T06:30:00Z', '2026-01-01T07:00:00Z', '2026-12-31T23:00:00Z', '2026-03-15T12:00:00Z']
      for (const iso of instantes) await comision(m.ana, iso, 1)
      const filas = await getCommissionSummaries(m.venueId)
      for (const iso of instantes) {
        const { start, end } = getPeriodDateRange(periodo, new Date(iso), 'America/Mexico_City')
        const f = filas.find(x => x.periodStart.getTime() === start.getTime())
        expect({ iso, end: f?.periodEnd.toISOString(), tipo: f?.periodType }).toEqual({ iso, end: end.toISOString(), tipo: periodo })
      }
    },
  )
})
