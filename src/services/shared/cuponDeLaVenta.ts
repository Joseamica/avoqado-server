/**
 * El cupón en una venta de caja (D5, 5-nov-2026). Antes ninguna puerta de creación ligaba la fila al cupón (`/mobile/orders` lo
 * perdía como descuento libre y `/tpv/with-items` sólo aceptaba descuentos del catálogo) y sólo el cobro de terminal lo contaba:
 * producción tenía 8 cupones activos y 0 canjes. Como en Square y Toast, se aplica al crear y se canjea al quedar pagada.
 */
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { validateCouponCode, type CouponValidationResult } from '../dashboard/coupon.dashboard.service'
import { calculateDiscountCents } from './discount.service'

export const CUPON_CAMBIO_DE_VALOR = 'El cupón cambió de valor. Quítalo y vuelve a aplicarlo.'

/** Lo que ve la cajera. `validateCouponCode` conserva su inglés porque lo usan otras puertas que ya lo leen así. */
export function textoDeRechazoDeCupon(r: Pick<CouponValidationResult, 'errorCode' | 'limite'>): string {
  switch (r.errorCode) {
    case 'NOT_FOUND':
      return 'No encontramos ese código de cupón.'
    case 'INACTIVE':
      return 'Este cupón está inactivo.'
    case 'NOT_STARTED':
      return 'Este cupón todavía no está vigente.'
    case 'EXPIRED':
      return 'Este cupón ya venció.'
    case 'USAGE_LIMIT':
      return 'Este cupón ya alcanzó su límite de usos.'
    case 'MIN_PURCHASE':
      return `Este cupón pide una compra mínima de $${(r.limite ?? 0).toFixed(2)}.`
    case 'CUSTOMER_LIMIT':
      return `Este cliente ya usó este cupón ${r.limite ?? 1} ${r.limite === 1 ? 'vez' : 'veces'}.`
    default:
      return 'Este cupón no es válido.'
  }
}

export interface CuponDeLaVenta {
  id: string
  code: string
  /** La fila COMPLETA del catálogo: de ella salen el monto, el tope y la fila de la orden. */
  discount: any
  /** La compra mínima que rige, para revisarla cuando la base sólo se conoce después (una venta con combos). */
  minimo: number | null
}

/**
 * Valida el cupón contra lo que vale la venta y lo devuelve, o lanza el 400 con el texto de la caja. `basePesos` es lo que queda
 * tras los descuentos de renglón: la misma base que el monto, para que el mínimo y la rebaja midan lo mismo. Sin base (la venta trae
 * combos que todavía no se arman) el mínimo lo revisa quien la conozca, con `minimo`.
 */
export async function cuponDeLaVenta(
  db: Prisma.TransactionClient,
  venueId: string,
  codigo: string,
  basePesos: number | undefined,
  customerId: string | null | undefined,
): Promise<CuponDeLaVenta> {
  const v = await validateCouponCode(venueId, codigo, basePesos, customerId ?? undefined, db)
  if (!v.valid || !v.coupon) throw new BadRequestError(textoDeRechazoDeCupon(v))
  // ponytail: un cupón por producto o categoría se rechaza en caja; repartirlo por renglón es otro trabajo (hoy 0 en producción).
  if (v.coupon.discount.scope !== 'ORDER') {
    throw new BadRequestError('Este cupón sólo aplica a ciertos productos y todavía no se puede usar en caja.')
  }
  const discount = await db.discount.findFirst({ where: { id: v.coupon.discount.id, venueId } })
  if (!discount) throw new BadRequestError(textoDeRechazoDeCupon({ errorCode: 'NOT_FOUND' }))
  return { id: v.coupon.id, code: v.coupon.code, discount, minimo: v.minimo ?? null }
}

/** Una venta sin cobrar que ya trae el cupón: su uso está apartado aunque todavía no cuente. */
const EN_VUELO = { paymentStatus: { in: ['PENDING', 'PARTIAL'] }, status: { notIn: ['CANCELLED', 'DELETED'] } } satisfies Prisma.OrderWhereInput

/**
 * 🔴 El último uso no se gasta dos veces (Codex r1 #1). Validar y canjear van separados (se canjea al cobrar), así que dos cajas podían
 * crear dos ventas con el último uso y cobrar las dos. Aquí, en la transacción que crea la venta y bajo un candado del cupón, cuentan los
 * canjes MÁS las ventas sin cobrar que ya lo traen. Una venta abandonada lo aparta hasta que se cancela, como un apartado de Square.
 * El canje (`finalizeCouponsForOrder`) nunca rechaza: para entonces el dinero ya se cobró con la rebaja.
 */
export async function apartarCupon(
  tx: Prisma.TransactionClient,
  venueId: string,
  cupon: CuponDeLaVenta,
  customerId: string | null | undefined,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`avoqado:cupon:v1:${cupon.id}`}, 0))::text`)
  const fresco = await tx.couponCode.findFirst({
    where: { id: cupon.id, discount: { venueId } },
    select: {
      currentUses: true,
      maxUses: true,
      maxUsesPerCustomer: true,
      discount: { select: { id: true, currentUses: true, maxTotalUses: true, maxUsesPerCustomer: true } },
    },
  })
  if (!fresco) throw new BadRequestError(textoDeRechazoDeCupon({ errorCode: 'NOT_FOUND' }))
  const agotado = () => new BadRequestError(textoDeRechazoDeCupon({ errorCode: 'USAGE_LIMIT' }))
  if (fresco.maxUses != null) {
    const enVuelo = await tx.orderDiscount.count({ where: { couponCodeId: cupon.id, order: { venueId, ...EN_VUELO } } })
    if (fresco.currentUses + enVuelo >= fresco.maxUses) throw agotado()
  }
  if (fresco.discount.maxTotalUses != null) {
    const enVuelo = await tx.orderDiscount.count({ where: { couponCode: { discountId: fresco.discount.id }, order: { venueId, ...EN_VUELO } } })
    if (fresco.discount.currentUses + enVuelo >= fresco.discount.maxTotalUses) throw agotado()
  }
  const porCliente = fresco.maxUsesPerCustomer ?? fresco.discount.maxUsesPerCustomer
  if (porCliente != null && customerId) {
    const delCupon = fresco.maxUsesPerCustomer != null ? { couponCodeId: cupon.id } : { couponCode: { discountId: fresco.discount.id } }
    const [canjes, enVuelo] = await Promise.all([
      tx.couponRedemption.count({ where: { ...delCupon, customerId } }),
      tx.orderDiscount.count({ where: { ...delCupon, order: { venueId, customerId, ...EN_VUELO } } }),
    ])
    if (canjes + enVuelo >= porCliente) throw new BadRequestError(textoDeRechazoDeCupon({ errorCode: 'CUSTOMER_LIMIT', limite: porCliente }))
  }
}

/** En centavos enteros, como las apps: en pesos flotantes, 10 % de $21.35 daba $2.13 y la caja rebajaba $2.14. */
export function montoDelCupon(discount: any, basePesos: number): number {
  return calculateDiscountCents(discount, Math.round(basePesos * 100)) / 100
}

/** La fila de cuenta ya armada, ligada al cupón: el canje y el reporte la encuentran por `couponCodeId`. */
export function ligarCupon(fila: Prisma.OrderDiscountUncheckedCreateInput, cupon: CuponDeLaVenta): Prisma.OrderDiscountUncheckedCreateInput {
  return {
    ...fila,
    discountId: cupon.discount.id,
    couponCodeId: cupon.id,
    type: cupon.discount.type,
    value: cupon.discount.value,
    name: `${cupon.discount.name} (${cupon.code})`,
    isManual: false,
  }
}

/**
 * El canje: cuenta el cupón cuando la venta quedó PAGADA, nunca en un abono. Idempotente por `CouponRedemption.orderId` (único):
 * un segundo paso del cierre no cuenta otra vez, y un cierre simultáneo pierde en el índice sin lanzar.
 */
export async function finalizeCouponsForOrder(venueId: string, orderId: string): Promise<void> {
  const [fila] = await prisma.orderDiscount.findMany({
    where: { orderId, couponCodeId: { not: null } },
    include: { couponCode: { select: { id: true, code: true, discountId: true } } },
    orderBy: { id: 'asc' },
    take: 1,
  })
  if (!fila?.couponCode) return

  const order = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { customerId: true, paymentStatus: true } })
  if (order?.paymentStatus !== 'PAID') return
  if (await prisma.couponRedemption.findUnique({ where: { orderId } })) return

  const { id: couponCodeId, code, discountId } = fila.couponCode
  try {
    await prisma.$transaction(async tx => {
      await tx.couponRedemption.create({ data: { couponCodeId, orderId, customerId: order.customerId, amountSaved: fila.amount } })
      await tx.couponCode.update({ where: { id: couponCodeId }, data: { currentUses: { increment: 1 } } })
      await tx.discount.update({ where: { id: discountId }, data: { currentUses: { increment: 1 } } })
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return
    throw error
  }
  logger.info('✅ Cupón canjeado al quedar pagada la venta', { orderId, venueId, couponCode: code, amountSaved: fila.amount.toString() })
}
