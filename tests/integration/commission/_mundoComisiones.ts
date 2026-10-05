// tests/integration/commission/_mundoComisiones.ts
/**
 * Mundo de las pruebas de comisiones de la fase 3 de pago por servicio (Bloque A), contra Postgres REAL.
 *
 * Un negocio con su esquema de comisión, tres personas (Ana y Bea venden, Owner administra), órdenes con o sin renglones
 * por categoría, cobros, devoluciones y el worker de efectos corrido A MANO sobre los efectos de ESTE negocio — nunca
 * `claimPaymentEffects`, que reclama los de toda la base y se llevaría los de otra prueba.
 */
import { Prisma, PrismaClient, TierPeriod } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getPeriodDateRange } from '@/services/dashboard/commission/commission-utils'
import {
  enqueuePaymentCommissionInTx,
  enqueueRefundPaymentEffectsInTx,
  runClaimedPaymentEffect,
  type PaymentEffectKind,
} from '@/services/tpv/paymentEffects.service'

const D = (n: number) => new Prisma.Decimal(n)

/** Estas pruebas escriben y borran: sólo en la base de este plan o en una de CI, y sólo en esta Mac. */
export function asegurarBaseDePrueba(): void {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  const permitida = /^\/(av-db-25-pago-f3|avoqado_[a-z0-9]+_test_|codex_testarudo_test_)/.test(url.pathname)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !permitida) throw new Error(`Base de prueba no permitida: ${url.pathname}`)
}

export interface MundoComisiones {
  key: string
  orgId: string
  venueId: string
  ana: string
  bea: string
  owner: string
  /** El esquema de la prueba: 10 %, a quien cobró, «con IVA», «lo cobrado» (salvo lo que pida la prueba). */
  configId: string
}

let reloj = Date.parse('2026-10-01T15:00:00Z')
/** Un instante nuevo por llamada: los cobros y devoluciones de una prueba quedan en un orden estable. */
export const despues = (): Date => new Date((reloj += 60_000))
let seq = 0

export async function crearMundoComisiones(
  nombre: string,
  esquema: Partial<Prisma.CommissionConfigUncheckedCreateInput> = {},
): Promise<MundoComisiones> {
  const key = `com-${nombre}-${process.pid}-${Date.now()}`
  const org = await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })
  const venue = await prisma.venue.create({ data: { organizationId: org.id, name: key, slug: key, timezone: 'America/Mexico_City' } })
  const persona = async (n: string) =>
    (await prisma.staff.create({ data: { email: `${key}-${n}@example.test`, firstName: n, lastName: 'QA', active: true } })).id
  const [ana, bea, owner] = [await persona('ana'), await persona('bea'), await persona('owner')]
  await prisma.staffVenue.createMany({
    data: [
      { staffId: ana, venueId: venue.id, role: 'WAITER', active: true },
      { staffId: bea, venueId: venue.id, role: 'WAITER', active: true },
      { staffId: owner, venueId: venue.id, role: 'OWNER', active: true },
    ],
  })
  const config = await prisma.commissionConfig.create({
    data: {
      venueId: venue.id,
      name: 'Comisión 10 %',
      createdById: owner,
      recipient: 'PROCESSOR',
      defaultRate: D(0.1),
      includeTax: true,
      categoryIds: [],
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      ...esquema,
    },
  })
  return { key, orgId: org.id, venueId: venue.id, ana, bea, owner, configId: config.id }
}

export async function categoria(m: MundoComisiones): Promise<string> {
  return (await prisma.menuCategory.create({ data: { venueId: m.venueId, name: 'Clases', slug: `${m.key}-c${++seq}` } })).id
}

export interface VentaDePrueba {
  subtotal: number
  discountAmount?: number
  taxAmount?: number
  contratoDePrecio?: 'IVA_INCLUIDO' | 'IVA_APARTE'
  renglones?: Array<{ categoryId: string; precio: number; iva?: number }>
}

/** Una orden ya pagada con su total canónico (IVA aparte suma; incluido no). Sus cobros se crean con `cobro`. */
export async function orden(m: MundoComisiones, v: VentaDePrueba): Promise<string> {
  const contratoDePrecio = v.contratoDePrecio ?? 'IVA_INCLUIDO'
  const total = Math.max(0, v.subtotal - (v.discountAmount ?? 0)) + (contratoDePrecio === 'IVA_APARTE' ? (v.taxAmount ?? 0) : 0)
  const order = await prisma.order.create({
    data: {
      venueId: m.venueId,
      orderNumber: `${m.key}-${++seq}`,
      subtotal: D(v.subtotal),
      discountAmount: D(v.discountAmount ?? 0),
      taxAmount: D(v.taxAmount ?? 0),
      contratoDePrecio,
      total: D(total),
      paidAmount: D(total),
      remainingBalance: D(0),
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
  })
  for (const r of v.renglones ?? []) {
    // Sin `taxRate`: el default (16 %) no exige «IVA por producto» encendido en el negocio (trigger `IVA_POR_PRODUCTO_APAGADO`).
    // La comisión no lo lee: el IVA de la línea es `OrderItem.taxAmount`.
    const product = await prisma.product.create({
      data: { venueId: m.venueId, categoryId: r.categoryId, name: 'Producto', sku: `${m.key}-p${++seq}`, price: D(r.precio) },
    })
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        productName: 'Producto',
        quantity: 1,
        unitPrice: D(r.precio),
        taxAmount: D(r.iva ?? 0),
        total: D(r.precio),
      },
    })
  }
  return order.id
}

/**
 * Un cobro COMPLETED de la orden; lo cobra Ana salvo que la prueba diga otra persona. Con `db` se crea dentro de esa
 * transacción y con `createdAt` con esa fecha (las carreras de confirmación de A1b).
 */
export async function cobro(
  m: MundoComisiones,
  orderId: string,
  monto: number,
  o: { propina?: number; staffId?: string; createdAt?: Date; db?: Prisma.TransactionClient } = {},
): Promise<string> {
  const propina = o.propina ?? 0
  const pago = await (o.db ?? prisma).payment.create({
    data: {
      venueId: m.venueId,
      orderId,
      amount: D(monto),
      tipAmount: D(propina),
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      processedById: o.staffId ?? m.ana,
      feePercentage: 0,
      feeAmount: D(0),
      netAmount: D(monto + propina),
      createdAt: o.createdAt ?? despues(),
    },
  })
  return pago.id
}

/** El commit financiero de la terminal: la comisión se congela como efecto, en la misma transacción. */
export function planear(paymentId: string): Promise<void> {
  return prisma.$transaction(tx => enqueuePaymentCommissionInTx(tx, paymentId))
}

/**
 * Una devolución como la deja el commit financiero (terminal o dashboard): la fila REFUND y su reverso EN COLA, en UNA
 * transacción. `createdAt` se puede fijar para probar que el reverso no depende de la fecha (Codex plan r1-1).
 */
export async function devolver(
  m: MundoComisiones,
  originalPaymentId: string,
  venta: number,
  propina = 0,
  createdAt: Date = despues(),
): Promise<string> {
  const original = await prisma.payment.findUniqueOrThrow({ where: { id: originalPaymentId } })
  return prisma.$transaction(async tx => {
    const refund = await tx.payment.create({
      data: {
        venueId: m.venueId,
        orderId: original.orderId,
        amount: D(-venta),
        tipAmount: D(-propina),
        method: 'CASH',
        status: 'COMPLETED',
        type: 'REFUND',
        processedById: m.owner,
        feePercentage: 0,
        feeAmount: D(0),
        netAmount: D(-(venta + propina)),
        processorData: { originalPaymentId },
        createdAt,
      },
    })
    await enqueueRefundPaymentEffectsInTx(tx, refund.id, originalPaymentId)
    return refund.id
  })
}

/** El worker de efectos, sólo sobre las comisiones pendientes de ESTE negocio, en el orden en que nacieron. */
export async function procesarEfectos(m: MundoComisiones): Promise<void> {
  const pendientes = await prisma.paymentEffect.findMany({
    where: { venueId: m.venueId, kind: 'COMMISSION', status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100,
  })
  for (const e of pendientes) {
    const claimToken = `prueba-${e.id}`
    const leaseUntil = new Date(Date.now() + 60_000)
    await prisma.paymentEffect.update({
      where: { id: e.id },
      data: { status: 'PROCESSING', claimToken, leaseUntil, attempts: e.attempts + 1 },
    })
    const hecho = await runClaimedPaymentEffect({
      id: e.id,
      venueId: e.venueId,
      paymentId: e.paymentId,
      orderId: e.orderId,
      kind: e.kind as PaymentEffectKind,
      dedupeKey: e.dedupeKey,
      payload: e.payload as Prisma.InputJsonValue,
      attempts: e.attempts + 1,
      claimToken,
      leaseUntil,
    })
    if (!hecho) throw new Error(`El efecto ${e.id} no se pudo procesar`)
  }
}

/** La comisión VIVA (no anulada) que suma lo que se pide, al centavo. */
export async function netoVivo(where: Prisma.CommissionCalculationWhereInput): Promise<string> {
  const r = await prisma.commissionCalculation.aggregate({ where: { ...where, status: { not: 'VOIDED' } }, _sum: { netCommission: true } })
  return (r._sum.netCommission ?? D(0)).toFixed(2)
}

/** Una venta cobrada con su comisión (10 %) ya materializada por el camino de la terminal. */
export async function ventaConComision(m: MundoComisiones, monto = 100) {
  const orderId = await orden(m, { subtotal: monto })
  const pago = await cobro(m, orderId, monto)
  await planear(pago)
  await procesarEfectos(m)
  const comision = await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: pago } })
  return { orderId, pago, comision }
}

/** La comisión sumada al resumen del mes EN CURSO, como la deja el agregador (H2c y la colisión con el agregador). */
export async function sumadaAUnResumen(
  m: MundoComisiones,
  calculationId: string,
  staffId: string,
  neto: number,
  status: 'CALCULATED' | 'PAID' = 'CALCULATED',
): Promise<string> {
  const periodo = getPeriodDateRange(TierPeriod.MONTHLY, new Date(), 'America/Mexico_City')
  const s = await prisma.commissionSummary.create({
    data: {
      venueId: m.venueId,
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
  await prisma.commissionCalculation.update({
    where: { id: calculationId },
    data: { status: 'AGGREGATED', summaryId: s.id, aggregatedAt: new Date() },
  })
  return s.id
}

/**
 * Barrera REAL para las carreras (mismo patrón que `barreraDelPeriodo` de staffPay): un cliente aparte toma el candado de
 * UNA fila; las operaciones bajo prueba se quedan esperándolo; un observador cuenta las sesiones detenidas por ESTE
 * bloqueador (directo o en cadena, por su `pg_backend_pid()`); sólo entonces se suelta. Nada de `sleep`.
 */
export async function barreraDeFila(tabla: 'Order' | 'CommissionCalculation', id: string) {
  const url = process.env.DATABASE_URL
  const bloqueador = new PrismaClient({ datasources: { db: { url } } })
  const observador = new PrismaClient({ datasources: { db: { url } } })
  let soltarTx!: () => void
  let tomado!: (pid: number) => void
  const suelto = new Promise<void>(r => (soltarTx = r))
  const listo = new Promise<number>(r => (tomado = r))
  const tx = bloqueador.$transaction(
    async t => {
      const [{ pid }] = await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      await t.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${tabla}"`)} WHERE id = ${id} FOR UPDATE`)
      tomado(pid)
      await suelto
    },
    { maxWait: 10_000, timeout: 60_000 },
  )
  const pidBloqueador = await Promise.race([listo, tx.then(() => -1)])
  if (pidBloqueador < 0) throw new Error(`La barrera no pudo tomar el candado de ${tabla} ${id}`)
  let cerrada = false
  return {
    /** Espera hasta ver `n` sesiones detenidas por el candado de ESTE bloqueador (directo o en cadena). */
    async esperarA(n: number) {
      const limite = Date.now() + 15_000
      for (;;) {
        const [{ esperando }] = await observador.$queryRaw<Array<{ esperando: number }>>`
          WITH RECURSIVE espera(pid) AS (
            SELECT a.pid FROM pg_stat_activity a WHERE pg_blocking_pids(a.pid) @> ARRAY[${pidBloqueador}::int]
            UNION
            SELECT a.pid FROM pg_stat_activity a JOIN espera e ON pg_blocking_pids(a.pid) @> ARRAY[e.pid]
          )
          SELECT COUNT(*)::int AS esperando FROM espera`
        if (esperando >= n) return
        if (Date.now() > limite) throw new Error(`La barrera esperaba ${n} sesiones detenidas por su candado y vio ${esperando}`)
        await new Promise(r => setTimeout(r, 10))
      }
    },
    /** Suelta el candado y cierra los dos clientes. Se puede llamar más de una vez (va en un `finally`). */
    async soltar() {
      if (cerrada) return
      cerrada = true
      soltarTx()
      await tx
      await Promise.all([bloqueador.$disconnect(), observador.$disconnect()])
    },
  }
}

/** Borra lo de ESTE negocio en el orden que piden las llaves (`Restrict` de Payment, Order, CommissionConfig, PaymentLink). */
export async function borrarMundoComisiones(m: MundoComisiones | undefined): Promise<void> {
  if (!m?.venueId) return
  const v = { venueId: m.venueId }
  await prisma.activityLog.deleteMany({ where: v })
  await prisma.paymentEffect.deleteMany({ where: v })
  await prisma.commissionClawback.deleteMany({ where: { calculation: v } })
  await prisma.commissionPayout.deleteMany({ where: v })
  await prisma.commissionCalculation.deleteMany({ where: v })
  await prisma.commissionSummary.deleteMany({ where: v })
  await prisma.checkoutSession.deleteMany({ where: { paymentLink: v } })
  await prisma.paymentLink.deleteMany({ where: v })
  await prisma.ecommerceMerchant.deleteMany({ where: v })
  await prisma.inventoryPosting.deleteMany({ where: v })
  await prisma.venueTransaction.deleteMany({ where: v })
  await prisma.payment.deleteMany({ where: v })
  await prisma.shift.deleteMany({ where: v })
  await prisma.order.deleteMany({ where: v })
  await prisma.product.deleteMany({ where: v })
  await prisma.menuCategory.deleteMany({ where: v })
  await prisma.commissionConfig.deleteMany({ where: v })
  await prisma.venue.delete({ where: { id: m.venueId } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: m.key } } })
  await prisma.organization.delete({ where: { id: m.orgId } })
}
