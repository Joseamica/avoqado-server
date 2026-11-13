/**
 * Apartado de 15 minutos por talla (liga de pago por prenda, diseño §5 r3 + r3.1).
 *
 * Disponible en la liga = `Inventory.currentStock` − Σ fichas `ACTIVE` con `expiresAt > now`. El apartado NUNCA toca `Inventory`:
 * el inventario baja una sola vez, en el cierre del cobro. Una ficha = un PaymentIntent para siempre: cambiar talla o importe
 * suelta la ficha (`cambio_de_compra`) y aparta otra. Las tallas sin seguimiento por pieza (sin fila de `Inventory`,
 * `trackInventory = false` o método ≠ QUANTITY) siempre están disponibles: su ficha existe (el cobro siempre tiene `hold.id`) pero
 * no resta a nadie.
 */
import { Prisma, type PaymentLinkStockHold } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { getProductInventoryMethods } from './productInventoryIntegration.service'

export const HOLD_TTL_MS = 15 * 60_000
/** Tope de tallas por familia que lee la disponibilidad (bounded-queries). */
const MAX_VARIANTS = 250

type Db = Prisma.TransactionClient

/** Las tallas que se cuentan por pieza (método QUANTITY). Las demás nunca se agotan por un apartado. */
async function trackedIds(db: Db, venueId: string, productIds: string[]): Promise<{ known: Set<string>; tracked: string[] }> {
  const methods = await getProductInventoryMethods(productIds, db, venueId)
  return { known: new Set(methods.keys()), tracked: productIds.filter(id => methods.get(id) === 'QUANTITY') }
}

/**
 * Piezas libres por talla con seguimiento (las que no tienen fila de `Inventory` no aparecen: sin seguimiento). Las fichas de
 * `except` (el propio navegador en esta liga) no restan. UNA consulta agrupada de fichas para toda la lista.
 */
async function freeUnits(
  db: Db,
  venueId: string,
  tracked: string[],
  now: Date,
  except?: { paymentLinkId: string; browserToken: string },
): Promise<Map<string, number>> {
  if (tracked.length === 0) return new Map()
  const [stock, held] = await Promise.all([
    db.inventory.findMany({ where: { venueId, productId: { in: tracked } }, select: { productId: true, currentStock: true } }),
    db.paymentLinkStockHold.groupBy({
      by: ['productId'],
      where: { productId: { in: tracked }, status: 'ACTIVE', expiresAt: { gt: now }, ...(except ? { NOT: except } : {}) },
      _sum: { quantity: true },
    }),
  ])
  const heldBy = new Map(held.map(h => [h.productId, h._sum.quantity ?? 0]))
  return new Map(stock.map(i => [i.productId, Number(i.currentStock) - (heldBy.get(i.productId) ?? 0)]))
}

export async function variantAvailability(args: {
  paymentLinkId: string
  productGroupId: string
  venueId: string
  browserToken?: string
  now?: Date
}): Promise<Array<{ productId: string; available: boolean; heldByYou: boolean; heldUntil: Date | null }>> {
  const { paymentLinkId, productGroupId, venueId, browserToken } = args
  const now = args.now ?? new Date()
  const variants = await prisma.product.findMany({
    where: { venueId, productGroupId, deletedAt: null },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_VARIANTS,
  })
  const ids = variants.map(v => v.id)
  const mine = browserToken ? { paymentLinkId, browserToken } : undefined
  const { tracked } = await trackedIds(prisma, venueId, ids)
  const [free, own] = await Promise.all([
    freeUnits(prisma, venueId, tracked, now, mine),
    mine
      ? prisma.paymentLinkStockHold.findMany({
          where: { ...mine, productId: { in: ids }, status: 'ACTIVE', expiresAt: { gt: now } },
          select: { productId: true, expiresAt: true },
          take: MAX_VARIANTS,
        })
      : [],
  ])
  const ownBy = new Map(own.map(h => [h.productId, h.expiresAt]))
  return ids.map(productId => {
    const left = free.get(productId)
    const heldUntil = ownBy.get(productId) ?? null
    return { productId, available: left === undefined || left >= 1, heldByYou: heldUntil !== null, heldUntil }
  })
}

export async function takeOrReuseHold(args: {
  paymentLinkId: string
  venueId: string
  productId: string
  browserToken: string
  amountCents: number
  now?: Date
}): Promise<{
  hold: PaymentLinkStockHold
  reused: boolean
  released: Array<{ holdId: string; stripePaymentIntentId: string | null; stripeAccountId: string | null }>
}> {
  const { paymentLinkId, venueId, productId, browserToken, amountCents } = args
  const now = args.now ?? new Date()
  return prisma.$transaction(async tx => {
    // Orden fijo: navegador → producto (un mismo navegador que cambia de talla se serializa consigo mismo).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'pl-hold-token:' + paymentLinkId + ':' + browserToken}))`
    const own = await tx.paymentLinkStockHold.findMany({
      where: { paymentLinkId, browserToken, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const reusable = own.find(
      h => h.productId === productId && h.expiresAt > now && (h.amountCents === null || h.amountCents === amountCents),
    )
    const toRelease = own.filter(h => h !== reusable).map(h => h.id)
    const released = toRelease.length
      ? (
          await tx.paymentLinkStockHold.updateManyAndReturn({
            where: { id: { in: toRelease }, status: 'ACTIVE' },
            data: { status: 'RELEASED', releasedReason: 'cambio_de_compra' },
            select: { id: true, stripePaymentIntentId: true, stripeAccountId: true },
          })
        ).map(h => ({ holdId: h.id, stripePaymentIntentId: h.stripePaymentIntentId, stripeAccountId: h.stripeAccountId }))
      : []
    if (reusable) return { hold: reusable, reused: true, released }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'pl-hold:' + productId}))`
    const { known, tracked } = await trackedIds(tx, venueId, [productId])
    if (!known.has(productId)) throw new NotFoundError('Producto no encontrado')
    const left = (await freeUnits(tx, venueId, tracked, now)).get(productId)
    if (left !== undefined && left < 1) throw new ConflictError('Esa talla se agotó', 'PAYMENT_LINK_VARIANT_SOLD_OUT')

    const hold = await tx.paymentLinkStockHold.create({
      data: { venueId, paymentLinkId, productId, browserToken, amountCents, quantity: 1, expiresAt: new Date(now.getTime() + HOLD_TTL_MS) },
    })
    return { hold, reused: false, released }
  })
}

/**
 * Congela el cuerpo del PaymentIntent ANTES de llamar a Stripe. CAS: sólo una ficha `ACTIVE` sin `intentParams`; el primero gana.
 * Siempre devuelve la ficha como quedó.
 *
 * 🔴 Contrato de quien llama: si `hold.status !== 'ACTIVE'` (otra pestaña del mismo navegador la soltó, o venció), NO crea el
 * intento; y si sí, crea el intento con los `intentParams` DEVUELTOS (no con los suyos: si perdió la carrera son los del ganador).
 */
export async function freezeIntentParams(
  holdId: string,
  args: { amountCents: number; stripeAccountId: string; intentParams: Prisma.InputJsonValue; checkoutSnapshot: Prisma.InputJsonValue },
): Promise<PaymentLinkStockHold> {
  await prisma.paymentLinkStockHold.updateMany({
    where: { id: holdId, status: 'ACTIVE', intentParams: { equals: Prisma.AnyNull } },
    data: args,
  })
  return prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: holdId } })
}

/**
 * Liga el intento a una ficha `ACTIVE`. CAS: sólo si no tiene intento o ya es ese mismo (una ficha = un intento).
 *
 * 🔴 Contrato de quien llama: un 409 `PAYMENT_LINK_HOLD_INTENT_MISMATCH` (ficha soltada o vencida mientras se creaba el intento,
 * u otro intento ya ligado) obliga a CANCELAR en Stripe el intento recién creado y no devolverlo al navegador: nadie más lo
 * cancelaría, porque el `released[]` que soltó la ficha salió sin él.
 */
export async function attachIntent(holdId: string, paymentIntentId: string): Promise<void> {
  const { count } = await prisma.paymentLinkStockHold.updateMany({
    where: { id: holdId, status: 'ACTIVE', OR: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: paymentIntentId }] },
    data: { stripePaymentIntentId: paymentIntentId },
  })
  if (count === 0)
    throw new ConflictError('La ficha de apartado ya no está activa o tiene otro intento de pago', 'PAYMENT_LINK_HOLD_INTENT_MISMATCH')
}

/**
 * Devuelve a ACTIVE una ficha que `takeOrReuseHold` soltó por cambio de compra cuando su intento NO se pudo confirmar cancelado
 * (sigue cobrando, ya cobró sin cierre, o Stripe no contestó). CAS: sólo si sigue `RELEASED/cambio_de_compra` y vigente; si ya
 * se cerró, venció o la tomó el barrido, no hace nada. Peor caso: un apartado de más hasta su vencimiento (lado seguro).
 */
export async function restoreReleasedHold(holdId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.paymentLinkStockHold.updateMany({
    where: { id: holdId, status: 'RELEASED', releasedReason: 'cambio_de_compra', expiresAt: { gt: now } },
    data: { status: 'ACTIVE', releasedReason: null },
  })
  return count > 0
}

export async function releaseHold(holdId: string, reason: string): Promise<void> {
  await prisma.paymentLinkStockHold.updateMany({
    where: { id: holdId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedReason: reason },
  })
}

/** En la transacción del cierre del cobro: la ficha del intento pasa a CONSUMED. Devuelve cuántas cambió (0 si no había o ya no estaba ACTIVE). */
export async function consumeHoldInTx(tx: Prisma.TransactionClient, paymentIntentId: string): Promise<number> {
  const { count } = await tx.paymentLinkStockHold.updateMany({
    where: { stripePaymentIntentId: paymentIntentId, status: 'ACTIVE' },
    data: { status: 'CONSUMED' },
  })
  return count
}
