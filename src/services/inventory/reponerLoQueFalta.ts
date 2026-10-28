// src/services/inventory/reponerLoQueFalta.ts
/**
 * «Regresa al almacén lo que salió menos lo que ya regresó», renglón por renglón y una sola vez (decisión «A» del founder,
 * 28-oct; promesa y plan en docs/audit/2026-10-28-inventario-reponer-lo-que-falta/).
 *
 * - «Salió» es la regla de HOY (`renglonesQueSeReponen`): no se cambia qué cuenta, así que nunca se repone más que hoy. Única
 *   excepción: la venta nueva de un cambio que nunca registró su venta no regresa nada.
 * - «Ya resuelto» son las líneas CUSTOMER_RETURN de la venta (las que se reponen y las `NO_REPONER`), más, para devoluciones
 *   anteriores a este arreglo, los artículos de las devoluciones sin anotación.
 * - Quien devuelve (la TPV, el panel o el POS, y el Cambio) lo calcula y anota DENTRO de su transacción, bajo el candado de la
 *   orden: dos devoluciones a la vez no reponen dos veces. El stock se aplica después del commit con `applyCustomerReturnPosting`.
 */
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { esValeRevendido } from '@/services/shared/renglonDeVale'
import { createCustomerReturnPostingInTx } from './inventoryPosting.service'

const TOPE = 500

type Db = Pick<Prisma.TransactionClient, 'orderItem' | 'inventoryPosting' | 'inventoryPostingLine' | 'exchange' | 'payment'>

/**
 * CUÁNTO repone hoy cada renglón de la venta, sin escribir nada: la cantidad original (o la elegida en `items`), sin productos
 * sueltos, sin vales revendidos y sin renglones liberados de área-ticket que esta cuenta no dedujo. NO mira si el inventario está
 * prendido: eso lo decide quien repone (`restockItem`) o la anotación (`createCustomerReturnPostingInTx`). Es la regla única que
 * usan `restockOrderItems` y «lo que falta por reponer» (`inventory/reponerLoQueFalta.ts`).
 */
export async function renglonesQueSeReponen(
  db: Pick<Prisma.TransactionClient, 'orderItem' | 'inventoryPosting'>,
  venueId: string,
  orderId: string,
  items?: Array<{ orderItemId: string; quantity: number }>,
): Promise<Array<{ orderItemId: string; productId: string; quantity: number }>> {
  const selected = items ? new Map(items.map(item => [item.orderItemId, item.quantity])) : null
  const result: Array<{ orderItemId: string; productId: string; quantity: number }> = []
  let cursor: string | undefined
  do {
    const page = await db.orderItem.findMany({
      where: { orderId, order: { venueId }, productId: { not: null }, ...(selected ? { id: { in: [...selected.keys()] } } : {}) },
      select: {
        id: true,
        productId: true,
        quantity: true,
        areaTicketLineId: true,
        releasedAreaTicketLineId: true,
        areaTicketLine: { select: { areaTicket: { select: { orderId: true } } } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    const releasedIds = page.filter(item => item.areaTicketLineId && !item.areaTicketLine?.areaTicket.orderId).map(item => item.id)
    const ownPosting = releasedIds.length
      ? await db.inventoryPosting.findUnique({
          where: { venueId_sourceKind_sourceId_effectKind: { venueId, sourceKind: 'ORDER', sourceId: orderId, effectKind: 'SALE' } },
          select: {
            lines: {
              where: { effectKey: { in: releasedIds } },
              select: { effectKey: true },
              take: 100,
            },
          },
        })
      : null
    const deductionIds = new Set(ownPosting?.lines.map(line => line.effectKey))
    for (const item of page) {
      const quantity = selected ? (selected.get(item.id) ?? 0) : item.quantity
      if (!item.productId || quantity <= 0) continue
      // El posting propio también acredita una deducción PENDIENTE: su reposición la compensa cuando se recupere.
      if (esValeRevendido(item) || (item.areaTicketLineId && !item.areaTicketLine?.areaTicket.orderId && !deductionIds.has(item.id)))
        continue
      result.push({ orderItemId: item.id, productId: item.productId, quantity })
    }
    cursor = page.length === 100 ? page[page.length - 1].id : undefined
  } while (cursor)
  return result
}

export interface Falta {
  orderItemId: string
  productId: string
  falta: number
}

/** La venta nueva de un cambio que nunca registró su venta (cancelado, o cobro tardío tras liberarlo): no salió nada. */
async function nuncaSalio(db: Db, venueId: string, orderId: string): Promise<boolean> {
  const cambio = await db.exchange.findFirst({ where: { venueId, newOrderId: orderId }, select: { status: true, reviewReason: true } })
  return !!cambio && (cambio.status === 'CANCELLED' || (cambio.status === 'NEEDS_REVIEW' && cambio.reviewReason === 'LATE_CHARGE_AFTER_RELEASE'))
}

/** Lo ya resuelto de cada renglón. Rebasar el tope no adivina: devuelve `null` y quien llama no repone nada. */
async function yaResuelto(db: Db, venueId: string, orderId: string): Promise<Map<string, number> | null> {
  const lineas = await db.inventoryPostingLine.findMany({
    where: { posting: { venueId, orderId, effectKind: 'CUSTOMER_RETURN' }, orderItemId: { not: null } },
    select: { orderItemId: true, expectedQuantityBase: true, posting: { select: { sourceId: true } } },
    take: TOPE + 1,
  })
  // Devoluciones anteriores a este arreglo: sus artículos cuentan como resueltos si la devolución no tiene anotación. Las de un
  // cambio nunca caen aquí (el Cambio anota siempre, y no hay cambios anteriores a este arreglo en producción).
  const devoluciones = await db.payment.findMany({
    where: { venueId, orderId, type: 'REFUND', status: 'COMPLETED' },
    select: { id: true, processorData: true },
    take: TOPE + 1,
  })
  if (lineas.length > TOPE || devoluciones.length > TOPE) {
    logger.error('Venta con demasiados regresos o devoluciones: no se repone nada', { venueId, orderId })
    return null
  }
  const resuelto = new Map<string, number>()
  const suma = (orderItemId: string, cantidad: number) => resuelto.set(orderItemId, (resuelto.get(orderItemId) ?? 0) + cantidad)
  for (const l of lineas) suma(l.orderItemId!, Number(l.expectedQuantityBase))
  const anotadas = new Set(lineas.map(l => l.posting.sourceId))
  for (const d of devoluciones) {
    if (anotadas.has(d.id)) continue
    const datos = d.processorData as { exchange?: unknown; refundedItems?: Array<{ orderItemId?: unknown; quantity?: unknown }> } | null
    if (datos?.exchange || !Array.isArray(datos?.refundedItems)) continue
    for (const item of datos.refundedItems)
      if (typeof item.orderItemId === 'string' && typeof item.quantity === 'number' && Number.isFinite(item.quantity))
        suma(item.orderItemId, item.quantity)
  }
  return resuelto
}

/** Lo que falta por reponer de cada renglón de la venta (sólo los que tienen algo). */
export async function faltaPorReponerEnTx(db: Db, venueId: string, orderId: string): Promise<Map<string, Falta>> {
  const falta = new Map<string, Falta>()
  const renglones = await renglonesQueSeReponen(db, venueId, orderId)
  if (renglones.length === 0 || (await nuncaSalio(db, venueId, orderId))) return falta
  const resuelto = await yaResuelto(db, venueId, orderId)
  if (!resuelto) return falta
  for (const r of renglones) {
    const queda = Math.max(0, r.quantity - (resuelto.get(r.orderItemId) ?? 0))
    if (queda > 0) falta.set(r.orderItemId, { orderItemId: r.orderItemId, productId: r.productId, falta: queda })
  }
  return falta
}

/**
 * ¿Con esta devolución la venta queda toda devuelta? La misma suma de siempre (`crossedFullRefundThreshold` de la terminal), leída
 * dentro de la transacción y bajo el candado de la orden: lo devuelto de VENTA contra la mercancía (total sin propina).
 */
export async function quedaTodaDevueltaEnTx(
  db: Pick<Prisma.TransactionClient, 'order' | 'payment'>,
  venueId: string,
  orderId: string,
  estaVezPesos: number,
): Promise<boolean> {
  const orden = await db.order.findUnique({ where: { id: orderId }, select: { venueId: true, total: true, tipAmount: true } })
  if (!orden || orden.venueId !== venueId) return false
  // Misma lectura que hacía la terminal (venta de cada devolución COMPLETED), acotada: una venta no tiene mil devoluciones.
  const devoluciones = await db.payment.findMany({
    where: { venueId, orderId, type: 'REFUND', status: 'COMPLETED' },
    select: { amount: true },
    take: TOPE + 1,
  })
  if (devoluciones.length > TOPE) {
    logger.error('Venta con demasiadas devoluciones: no se repone el inventario de la devolución completa', { venueId, orderId })
    return false
  }
  const mercancia = Math.max(0, Number(orden.total) - Number(orden.tipAmount ?? 0))
  if (mercancia <= 0.01) return false
  const total = devoluciones.reduce((sum, d) => sum + Math.abs(Number(d.amount)), 0)
  return total - estaVezPesos < mercancia - 0.01 && total >= mercancia - 0.01
}

export interface Regreso {
  postingId: string | null
  /** Recetas de restaurante: siguen por `restockItem` después del commit, como hoy (no entran a este saldo de piezas). */
  recetas: Array<{ orderItemId: string; quantity: number }>
}

/**
 * Anota UN regreso por devolución (la llave del posting es la devolución): lo que se repone y lo resuelto que no vuelve al estante.
 * Sin `eligibility`, la anotación toma la del momento, como hoy en la terminal y en el panel.
 */
export async function anotarRegresoEnTx(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    orderId: string
    refundPaymentId: string
    staffId?: string | null
    motivo: string
    reponer: Array<{ orderItemId: string; productId: string; cantidad: number; eligibility?: { inventoryMethod: string | null; eligible: boolean } }>
    noReponer: Array<{ orderItemId: string; productId: string; cantidad: number }>
  },
): Promise<Regreso> {
  const reponer = args.reponer.filter(r => r.cantidad > 0)
  const noReponer = args.noReponer.filter(r => r.cantidad > 0)
  if (reponer.length === 0 && noReponer.length === 0) return { postingId: null, recetas: [] }
  const productIds = [...new Set(reponer.map(r => r.productId))]
  const recetas = productIds.length
    ? await tx.product.findMany({
        where: { venueId: args.venueId, id: { in: productIds }, trackInventory: true, inventoryMethod: 'RECIPE' },
        select: { id: true },
        take: productIds.length,
      })
    : []
  const deReceta = new Set(recetas.map(p => p.id))
  const posting = await createCustomerReturnPostingInTx(tx, {
    venueId: args.venueId,
    refundPaymentId: args.refundPaymentId,
    orderId: args.orderId,
    staffId: args.staffId,
    motivo: args.motivo,
    lines: [
      ...reponer.map(r => ({ orderItemId: r.orderItemId, productId: r.productId, quantity: r.cantidad, eligibility: r.eligibility })),
      ...noReponer.map(r => ({ orderItemId: r.orderItemId, productId: r.productId, quantity: r.cantidad, noReponer: { reason: 'NOT_RESTOCKED' } })),
    ],
  })
  return {
    postingId: posting?.id ?? null,
    recetas: reponer.filter(r => deReceta.has(r.productId)).map(r => ({ orderItemId: r.orderItemId, quantity: r.cantidad })),
  }
}

/** La venta quedó toda devuelta: se anota el regreso de TODO lo que falta, con la elegibilidad del momento. */
export async function anotarRegresoDeLaVentaEnTx(
  tx: Prisma.TransactionClient,
  args: { venueId: string; orderId: string; refundPaymentId: string; staffId?: string | null },
): Promise<Regreso> {
  const falta = await faltaPorReponerEnTx(tx, args.venueId, args.orderId)
  return anotarRegresoEnTx(tx, {
    ...args,
    motivo: 'Devolución: regresa al inventario',
    reponer: [...falta.values()].map(f => ({ orderItemId: f.orderItemId, productId: f.productId, cantidad: f.falta })),
    noReponer: [],
  })
}

/**
 * Devolución por ARTÍCULOS (panel y POS): cada artículo devuelto queda resuelto, topado por lo que falta de su renglón; el elegido
 * para reponer vuelve al estante y el otro queda `NO_REPONER`. La venta nueva de un cambio que nunca salió no regresa nada.
 */
export async function anotarRegresoDeArticulosEnTx(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    orderId: string
    refundPaymentId: string
    staffId?: string | null
    articulos: ReadonlyArray<{ orderItemId: string; quantity: number }>
    reponerIds: ReadonlySet<string>
  },
): Promise<Regreso> {
  const falta = await faltaPorReponerEnTx(tx, args.venueId, args.orderId)
  const pedidos = new Map<string, number>()
  for (const a of args.articulos) pedidos.set(a.orderItemId, (pedidos.get(a.orderItemId) ?? 0) + a.quantity)
  const reponer: Array<{ orderItemId: string; productId: string; cantidad: number }> = []
  const noReponer: Array<{ orderItemId: string; productId: string; cantidad: number }> = []
  for (const [orderItemId, cantidad] of pedidos) {
    const f = falta.get(orderItemId)
    if (!f) continue
    const linea = { orderItemId, productId: f.productId, cantidad: Math.min(cantidad, f.falta) }
    ;(args.reponerIds.has(orderItemId) ? reponer : noReponer).push(linea)
  }
  return anotarRegresoEnTx(tx, { ...args, motivo: 'Devolución: regresa al inventario', reponer, noReponer })
}
