import { Prisma } from '@prisma/client'
import { z } from 'zod'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { grantPackInTx } from '@/services/mobile/creditPack.mobile.service'

/**
 * Paquetes de créditos vendidos en un RENGLÓN de orden (Modo Autoservicio, Fase 0 · 0.d).
 *
 * El renglón guarda la FOTO de lo vendido (`OrderItem.creditPackSnapshot`) y se entrega desde ella, nunca desde el catálogo
 * vigente: si la dueña cambia productos, precio o vigencia, o apaga el paquete entre el cobro y la entrega, la clienta recibe
 * lo que pagó. Contrato para la Fase 1:
 *   · el renglón se crea con `buildCreditPackSnapshot` (el ÚNICO que arma la foto) leyendo el paquete del SERVIDOR;
 *   · `fulfillCreditPacksForOrder` corre en la MISMA transacción que deja la orden pagada;
 *   · `held > 0` ⇒ el pago queda, pero la venta NO se da por entregada en silencio: hay una `MoneyAnomaly`
 *     `CREDIT_PACK_LINE_HELD` por renglón y la Fase 1 marca la venta retenida.
 */

export type CreditPackSnapshot = {
  v: 1
  creditPackId: string
  name: string
  /** Pesos, `toFixed(2)`. */
  price: string
  currency: string
  validityDays: number | null
  items: { productId: string; quantity: number }[]
}

export const CreditPackSnapshotSchema: z.ZodType<CreditPackSnapshot> = z.object({
  v: z.literal(1),
  creditPackId: z.string().min(1),
  name: z.string(),
  price: z.string().regex(/^\d+\.\d{2}$/, 'Precio inválido en la foto del paquete'),
  currency: z.string().min(1),
  validityDays: z.number().int().positive().nullable(),
  items: z
    .array(z.object({ productId: z.string().min(1), quantity: z.number().int().min(1) }))
    .min(1, 'La foto del paquete no trae productos')
    .refine(items => new Set(items.map(i => i.productId)).size === items.length, 'Producto repetido en la foto del paquete'),
})

/** La foto de lo vendido. Sin ids de `CreditPackItem`: cambian cada vez que la dueña edita el paquete. */
export function buildCreditPackSnapshot(pack: {
  id: string
  name: string
  price: Prisma.Decimal
  currency: string
  validityDays: number | null
  items: { productId: string; quantity: number }[]
}): CreditPackSnapshot {
  const foto: CreditPackSnapshot = {
    v: 1,
    creditPackId: pack.id,
    name: pack.name,
    price: pack.price.toFixed(2),
    currency: pack.currency,
    validityDays: pack.validityDays,
    items: pack.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
  }
  // Antes de cobrar, no después: una foto que no se podría entregar no se vende (igual que `sellPackInPerson` con un
  // paquete sin artículos).
  if (!CreditPackSnapshotSchema.safeParse(foto).success) throw new BadRequestError('Este paquete no se puede vender: revisa sus productos')
  return foto
}

export const CREDIT_PACK_LINE_HELD = 'CREDIT_PACK_LINE_HELD' as const

/**
 * Entrega, UNA vez, los paquetes que venden los renglones de una orden ya pagada. Va DENTRO de la transacción que la deja
 * pagada. Nunca lee `CreditPackItem` ni el precio, la vigencia o `active` vigentes: sólo la foto, más la identidad del paquete
 * y de los productos (que sigan siendo del negocio de la orden; un producto archivado se entrega igual).
 *
 * Idempotente: `FOR UPDATE` sobre los renglones serializa dos entregas de la misma orden, y `CreditPackPurchase.orderItemId`
 * único deja a lo más una compra por renglón. Lo imposible de entregar queda retenido con UNA anomalía por renglón.
 */
export async function fulfillCreditPacksForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ delivered: number; skipped: number; held: number }> {
  await tx.$queryRaw`SELECT id FROM "OrderItem" WHERE "orderId" = ${orderId} AND "creditPackId" IS NOT NULL FOR UPDATE`

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      venueId: true,
      customerId: true,
      items: {
        where: { creditPackId: { not: null } },
        select: {
          id: true,
          quantity: true,
          total: true,
          creditPackId: true,
          creditPackSnapshot: true,
          creditPackPurchase: { select: { id: true } },
        },
      },
    },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')

  const result = { delivered: 0, skipped: 0, held: 0 }
  const pendientes = order.items.filter(l => !l.creditPackPurchase)
  result.skipped = order.items.length - pendientes.length
  if (pendientes.length === 0) return result

  const lineas = pendientes.map(l => ({ linea: l, foto: CreditPackSnapshotSchema.safeParse(l.creditPackSnapshot) }))
  const fotos = lineas.flatMap(l => (l.foto.success ? [l.foto.data] : []))
  // Sólo identidad (el editor nunca cambia id ni venueId), en dos consultas para todos los renglones.
  const packIds = [...new Set(fotos.map(f => f.creditPackId))]
  const productIds = [...new Set(fotos.flatMap(f => f.items.map(i => i.productId)))]
  const packsDelVenue = new Set(
    (packIds.length
      ? await tx.creditPack.findMany({ where: { id: { in: packIds }, venueId: order.venueId }, select: { id: true }, take: packIds.length })
      : []
    ).map(p => p.id),
  )
  // SIN filtrar active/deletedAt: un producto archivado se entrega igual; sólo falta si se borró de verdad o es de otro negocio.
  const productosDelVenue = new Set(
    (productIds.length
      ? await tx.product.findMany({
          where: { id: { in: productIds }, venueId: order.venueId },
          select: { id: true },
          take: productIds.length,
        })
      : []
    ).map(p => p.id),
  )

  for (const { linea, foto } of lineas) {
    // El primer motivo que aplique. Cambiar o quitar productos del paquete NO es motivo: se entrega la foto.
    const revisar = (): { motivo: string } | { f: CreditPackSnapshot; customerId: string } => {
      if (!foto.success) return { motivo: 'foto inválida' }
      if (foto.data.creditPackId !== linea.creditPackId) return { motivo: 'la foto es de otro paquete' }
      if (linea.quantity !== 1) return { motivo: `cantidad ${linea.quantity} (se vende de uno en uno)` }
      if (!order.customerId) return { motivo: 'la orden no tiene clienta' }
      if (!packsDelVenue.has(foto.data.creditPackId)) return { motivo: 'el paquete no es del negocio de la orden' }
      if (foto.data.items.some(i => !productosDelVenue.has(i.productId)))
        return { motivo: 'un producto de la foto no es del negocio de la orden' }
      return { f: foto.data, customerId: order.customerId }
    }
    const r = revisar()

    if ('motivo' in r) {
      // createMany + skipDuplicates = INSERT … ON CONFLICT DO NOTHING (molde `giftCardAnomaly.ts`): un P2002 dentro de la
      // transacción la dejaría abortada, y llamar dos veces no debe dejar dos anomalías.
      const insertadas = await tx.moneyAnomaly.createMany({
        data: [
          {
            category: CREDIT_PACK_LINE_HELD,
            stripeEventId: `order-item:${linea.id}`,
            expectedState: { venueId: order.venueId, orderId, orderItemId: linea.id, creditPackId: linea.creditPackId },
            observedState: { motivo: r.motivo },
          },
        ],
        skipDuplicates: true,
      })
      if (insertadas.count > 0) {
        logger.error('🚨 [CREDIT PACK] Renglón pagado que no se puede entregar: queda retenido', {
          venueId: order.venueId,
          orderId,
          orderItemId: linea.id,
          motivo: r.motivo,
        })
      }
      result.held++
      continue
    }

    const { f, customerId } = r
    const compra = await grantPackInTx(tx, {
      pack: {
        id: f.creditPackId,
        venueId: order.venueId,
        price: new Prisma.Decimal(f.price),
        active: true,
        validityDays: f.validityDays,
        maxPerCustomer: null,
        items: f.items.map(i => ({ id: null, productId: i.productId, quantity: i.quantity })),
      },
      venueId: order.venueId,
      customerId,
      amountPaid: linea.total,
      orderItemId: linea.id,
      countSpend: false,
    })
    await tx.activityLog.create({
      data: {
        venueId: order.venueId,
        action: 'CREDIT_PACK_DELIVERED_FROM_ORDER',
        entity: 'CreditPackPurchase',
        entityId: compra.id,
        data: {
          orderId,
          orderItemId: linea.id,
          creditPackId: f.creditPackId,
          customerId,
          amountPaid: linea.total.toFixed(2),
        },
      },
    })
    result.delivered++
  }

  return result
}
