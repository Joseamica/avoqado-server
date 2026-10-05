/**
 * Medición de los posibles defectos del módulo de comisiones (spec de pago por servicio §11,
 * relevo de la fase 3 §3.1) — contra Postgres REAL.
 *
 * Codex los dedujo leyendo el código y nadie los había reproducido. Cada prueba afirma el
 * comportamiento CORRECTO: si sale en rojo, el defecto es real.
 *
 *   H1  pago duplicado: dos `createPayouts` simultáneos del mismo resumen.
 *   H2  deuda perdida: `applyClawbacksToSummary` recorta el neto a 0 y la deuda sobrante desaparece;
 *       y el clawback que se captura en el dashboard ¿descuenta algo del siguiente pago?
 *   H3  entrada no sumada: un cálculo que llega entre la suma y la marca del agregador.
 *   H5  (encontrado al medir) un resumen YA PAGADO del periodo en curso recibe comisiones nuevas.
 *
 * Las carreras se fuerzan sin `sleep`: una conexión aparte toma `FOR UPDATE` sobre la fila del
 * resumen; las operaciones bajo prueba se quedan esperando ese candado (la llave foránea del
 * INSERT pide `FOR KEY SHARE`, el UPDATE pide la fila) y se sueltan cuando todas llegaron.
 *
 * Correr (base creada para esto, nunca av-db-25):
 *   TEST_DATABASE_URL=… npx jest --selectProjects integration \
 *     --runTestsByPath tests/integration/commission/defectos-de-comisiones.integration.test.ts
 */
import { ClawbackReason, CommissionCalcStatus, CommissionSummaryStatus, PrismaClient, TierPeriod } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { aggregateVenueCommissions, approveSummary } from '@/services/dashboard/commission/commission-aggregation.service'
import { applyClawbacksToSummary, createClawback } from '@/services/dashboard/commission/commission-clawback.service'
import { approvePayout, completePayout, createPayouts } from '@/services/dashboard/commission/commission-payout.service'
import { getPeriodDateRange } from '@/services/dashboard/commission/commission-utils'

const suffix = `${Date.now()}-${process.pid}`
const TZ = 'America/Mexico_City'
let orgId: string
let venueId: string
let jefaId: string
let configId: string
const vendedoras: string[] = []

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Comisiones ${suffix}`, email: `com-${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `com-${suffix}`, slug: `com-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  jefaId = (await prisma.staff.create({ data: { email: `jefa-${suffix}@example.test`, firstName: 'Jefa', lastName: 'Dueña' } })).id
  configId = (
    await prisma.commissionConfig.create({
      data: { venueId, name: 'Comisión 10 %', defaultRate: 0.1, createdById: jefaId, aggregationPeriod: TierPeriod.MONTHLY },
    })
  ).id
})

afterAll(async () => {
  await prisma.commissionPayout.deleteMany({ where: { venueId } })
  await prisma.commissionClawback.deleteMany({ where: { calculation: { venueId } } })
  await prisma.commissionCalculation.deleteMany({ where: { venueId } })
  await prisma.commissionSummary.deleteMany({ where: { venueId } })
  await prisma.commissionConfig.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: { in: [jefaId, ...vendedoras] } } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: orgId } })
})

/** Una vendedora nueva por prueba: cada caso tiene su propio resumen y no se pisan. */
async function vendedora(nombre: string) {
  const s = await prisma.staff.create({ data: { email: `${nombre}-${suffix}@example.test`, firstName: nombre, lastName: 'Prueba' } })
  await prisma.staffVenue.create({ data: { staffId: s.id, venueId, role: 'WAITER' } })
  vendedoras.push(s.id)
  return s.id
}

function calculo(staffId: string, neto: number, extra: Record<string, unknown> = {}) {
  return prisma.commissionCalculation.create({
    data: {
      venueId,
      staffId,
      configId,
      baseAmount: neto * 10,
      effectiveRate: 0.1,
      grossCommission: neto,
      netCommission: neto,
      calcType: 'PERCENTAGE',
      ...extra,
    },
  })
}

async function resumen(staffId: string, neto: number, status: CommissionSummaryStatus, periodo = getPeriodDateRange(TierPeriod.MONTHLY, new Date(), TZ)) {
  return prisma.commissionSummary.create({
    data: {
      venueId,
      staffId,
      periodType: TierPeriod.MONTHLY,
      periodStart: periodo.start,
      periodEnd: periodo.end,
      totalSales: neto * 10,
      totalCommissions: neto,
      grossAmount: neto,
      netAmount: neto,
      grandTotal: neto,
      paymentCount: 1,
      status,
    },
  })
}

/**
 * Una conexión aparte toma `FOR UPDATE` sobre la fila del resumen y la sostiene hasta que
 * `esperando` operaciones estén formadas detrás de ella (o pasen 4 s).
 */
async function candadoSobreElResumen(summaryId: string) {
  const url = process.env.DATABASE_URL
  const bloqueador = new PrismaClient({ datasources: { db: { url } } })
  const observador = new PrismaClient({ datasources: { db: { url } } })
  let soltar!: () => void
  let tomado!: (pid: number) => void
  const suelto = new Promise<void>(r => (soltar = r))
  const listo = new Promise<number>(r => (tomado = r))
  const tx = bloqueador.$transaction(
    async t => {
      const [{ pid }] = await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      await t.$queryRaw`SELECT id FROM "CommissionSummary" WHERE id = ${summaryId} FOR UPDATE`
      tomado(pid)
      await suelto
    },
    { maxWait: 10_000, timeout: 60_000 },
  )
  const pid = await listo
  return {
    /** Espera a que `n` conexiones estén bloqueadas detrás del candado; devuelve cuántas llegaron. */
    async esperarA(n: number): Promise<number> {
      const hasta = Date.now() + 4_000
      for (;;) {
        const [{ c }] = await observador.$queryRaw<Array<{ c: number }>>`
          SELECT count(*)::int AS c FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
        if (c >= n || Date.now() > hasta) return c
        await new Promise(r => setTimeout(r, 25))
      }
    },
    async soltar() {
      soltar()
      await tx
      await Promise.all([bloqueador.$disconnect(), observador.$disconnect()])
    },
  }
}

describe('H1 · pago duplicado en createPayouts', () => {
  it('control: en secuencia, el segundo pago del mismo resumen se rechaza', async () => {
    const staffId = await vendedora('secuencia')
    const s = await resumen(staffId, 100, CommissionSummaryStatus.APPROVED)
    await createPayouts(venueId, { summaryIds: [s.id] }, jefaId)
    await expect(createPayouts(venueId, { summaryIds: [s.id] }, jefaId)).rejects.toThrow(/already have active payouts/)
  })

  it('🔴 dos clics simultáneos sobre el mismo resumen crean UN solo pago', async () => {
    const staffId = await vendedora('dobleclic')
    const s = await resumen(staffId, 100, CommissionSummaryStatus.APPROVED)

    const candado = await candadoSobreElResumen(s.id)
    const a = createPayouts(venueId, { summaryIds: [s.id] }, jefaId)
    const b = createPayouts(venueId, { summaryIds: [s.id] }, jefaId)
    const formadas = await candado.esperarA(2)
    await candado.soltar()
    const resultados = await Promise.allSettled([a, b])

    const vivos = await prisma.commissionPayout.findMany({ where: { summaryId: s.id, status: { not: 'CANCELLED' } } })
    expect({ formadas, exitos: resultados.filter(r => r.status === 'fulfilled').length, pagosVivos: vivos.length }).toEqual({
      formadas: 2,
      exitos: 1,
      pagosVivos: 1,
    })
  })

  it('🔴 consecuencia: si existen dos pagos del mismo resumen, el segundo NO se puede completar', async () => {
    const staffId = await vendedora('consecuencia')
    const s = await resumen(staffId, 100, CommissionSummaryStatus.APPROVED)
    const candado = await candadoSobreElResumen(s.id)
    const a = createPayouts(venueId, { summaryIds: [s.id] }, jefaId)
    const b = createPayouts(venueId, { summaryIds: [s.id] }, jefaId)
    await candado.esperarA(2)
    await candado.soltar()
    const creados = (await Promise.allSettled([a, b])).flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    // Con el arreglo sólo hay un pago y esta prueba no tiene nada que demostrar.
    if (creados.length < 2) return

    await approvePayout(creados[0].id, venueId, jefaId)
    await completePayout(creados[0].id, venueId, 'SPEI-1')
    await approvePayout(creados[1].id, venueId, jefaId)
    await expect(completePayout(creados[1].id, venueId, 'SPEI-2')).rejects.toThrow()
  })
})

describe('H2 · deuda de clawbacks', () => {
  it('🔴 applyClawbacksToSummary: un clawback mayor que el neto no hace desaparecer la deuda sobrante', async () => {
    const staffId = await vendedora('deuda')
    const s = await resumen(staffId, 100, CommissionSummaryStatus.CALCULATED)
    const c = await calculo(staffId, 150, { status: CommissionCalcStatus.AGGREGATED, summaryId: s.id })
    await prisma.commissionClawback.create({
      data: { calculationId: c.id, summaryId: s.id, amount: 150, reason: ClawbackReason.REFUND, createdById: jefaId },
    })

    await applyClawbacksToSummary(s.id, venueId)

    const despues = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: s.id } })
    const pendiente = await prisma.commissionClawback.aggregate({
      where: { calculation: { staffId }, appliedAt: null },
      _sum: { amount: true },
    })
    // 100 de comisión − 150 de clawback = −50: esos 50 deben seguir en algún lado.
    const saldo = Number(despues.netAmount) - Number(pendiente._sum.amount ?? 0)
    expect(saldo).toBe(-50)
  })

  it('🔴 el clawback capturado en el dashboard (resumen ya pagado) se descuenta del siguiente pago', async () => {
    const staffId = await vendedora('siguiente')
    const anterior = getPeriodDateRange(TierPeriod.MONTHLY, new Date(Date.now() - 40 * 86_400_000), TZ)
    const pagado = await resumen(staffId, 100, CommissionSummaryStatus.APPROVED, anterior)
    const c = await calculo(staffId, 100, { status: CommissionCalcStatus.AGGREGATED, summaryId: pagado.id })
    const [p] = await createPayouts(venueId, { summaryIds: [pagado.id] }, jefaId)
    await approvePayout(p.id, venueId, jefaId)
    await completePayout(p.id, venueId, 'SPEI-ANTERIOR')

    // El cliente devolvió la venta: se captura el clawback desde el dashboard.
    await createClawback(c.id, venueId, { reason: ClawbackReason.REFUND }, jefaId)

    // Mes siguiente: 200 de comisión nueva, aprobada y pagada.
    const nuevo = await resumen(staffId, 200, CommissionSummaryStatus.APPROVED)
    const [siguiente] = await createPayouts(venueId, { summaryIds: [nuevo.id] }, jefaId)

    expect(Number(siguiente.amount)).toBe(100) // 200 − 100 que se le pagaron de más
  })

  it('🔴 anular una comisión YA sumada y sin pagar la quita del resumen', async () => {
    const staffId = await vendedora('anulada')
    const s = await resumen(staffId, 100, CommissionSummaryStatus.CALCULATED)
    const c = await calculo(staffId, 100, { status: CommissionCalcStatus.AGGREGATED, summaryId: s.id })

    const r = await createClawback(c.id, venueId, { reason: ClawbackReason.REFUND }, jefaId)
    expect(r).toEqual({ voided: true, calculationId: c.id })

    const despues = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: s.id } })
    expect(Number(despues.netAmount)).toBe(0)
  })
})

describe('H3 · el agregador suma antes y marca después', () => {
  it('🔴 un cálculo que llega a media agregación no queda marcado sin sumar', async () => {
    const staffId = await vendedora('agregador')
    await calculo(staffId, 10)
    await aggregateVenueCommissions(venueId, TierPeriod.MONTHLY) // crea el resumen del mes
    const s = await prisma.commissionSummary.findFirstOrThrow({ where: { venueId, staffId } })

    await calculo(staffId, 20) // pendiente de agregar: lo que el agregador SÍ ve
    const candado = await candadoSobreElResumen(s.id)
    const agregacion = aggregateVenueCommissions(venueId, TierPeriod.MONTHLY)
    const formadas = await candado.esperarA(1) // ya sumó (groupBy) y espera para escribir
    await calculo(staffId, 30) // llega en medio: no estaba en la suma
    await candado.soltar()
    await agregacion

    const final = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: s.id } })
    const marcados = await prisma.commissionCalculation.aggregate({
      where: { summaryId: s.id, status: CommissionCalcStatus.AGGREGATED },
      _sum: { netCommission: true },
    })
    // Lo que quedó marcado como sumado a este resumen es exactamente lo que el resumen suma.
    expect({ formadas, resumen: Number(final.totalCommissions) }).toEqual({ formadas: 1, resumen: Number(marcados._sum.netCommission) })
  })
})

describe('H5 · comisiones nuevas sobre un resumen ya pagado del periodo en curso', () => {
  it('🔴 la comisión que entra después de pagar se puede pagar, y sólo ella', async () => {
    const staffId = await vendedora('pagadoamedias')
    await calculo(staffId, 50)
    await aggregateVenueCommissions(venueId, TierPeriod.MONTHLY)
    const s = await prisma.commissionSummary.findFirstOrThrow({ where: { venueId, staffId } })
    await approveSummary(s.id, venueId, jefaId) // nada impide aprobar a medio mes
    const [p] = await createPayouts(venueId, { summaryIds: [s.id] }, jefaId)
    await approvePayout(p.id, venueId, jefaId)
    await completePayout(p.id, venueId, 'SPEI-QUINCENA')

    await calculo(staffId, 30) // venta del día siguiente
    await aggregateVenueCommissions(venueId, TierPeriod.MONTHLY)

    const reabierto = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: s.id } })
    const pendientePorPagar = await (async () => {
      if (reabierto.status === CommissionSummaryStatus.PAID) return null
      await approveSummary(s.id, venueId, jefaId)
      const [segundo] = await createPayouts(venueId, { summaryIds: [s.id] }, jefaId)
      return Number(segundo.amount)
    })().catch((e: Error) => `rechazado: ${e.message}`)

    expect({ status: reabierto.status, net: Number(reabierto.netAmount), pendientePorPagar }).toEqual({
      status: expect.anything(),
      net: expect.any(Number),
      pendientePorPagar: 30,
    })
  })
})
