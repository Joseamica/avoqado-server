/**
 * 🔴 DINERO (hz:e82938e1:D19, encargo 01765a): el uso que gasta el descuento de cuenta del POS (Mesas de ANDROID/WINDOWS) en el
 * tope de usos del catálogo (`Discount.currentUses` / `maxTotalUses`, «primeros 100»). Antes el POS revisaba el tope y nunca sumaba.
 *
 * Las filas que sumaron quedan con `OrderDiscount.usoContado`; sólo esas devuelven su uso (al quitarlas, al borrarse su cuenta vacía
 * o al convertirse en cortesía en un folio). Una fila vieja o de otro camino (motor de la TPV, Mostrador, cupón) cuenta aparte.
 *
 * Todo corre en la transacción de quien llama, con la cuenta YA bloqueada (Order → Discount, el orden de siempre), y con reintento
 * por traba (S5b): `withDeadlockRetry` o `executeHttpOperation`.
 */
import { Prisma } from '@prisma/client'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import type { TxConReintento } from '@/utils/serializableRetry'
import { descuentoSinUsos } from './discount.service'

/** Lo que un cupón ya apartó del mismo descuento: una venta con cupón sin pagar (el canje sube el contador al cobrar). */
const APARTADO_DEL_CUPON = { status: { notIn: ['CANCELLED', 'DELETED'] }, couponRedemption: { is: null } } satisfies Prisma.OrderWhereInput

/**
 * Suma UN uso del descuento, o rechaza con el texto de siempre si ya no hay.
 *
 * - En línea: la condición va DENTRO del UPDATE y contra el tope VIGENTE de la fila (no el que se leyó antes): con dos cajas pidiendo
 *   el último uso, la segunda espera el candado de la fila y Postgres vuelve a evaluar con el valor nuevo (Codex r1 #2). Cuenta también
 *   los usos que un cupón del mismo descuento ya apartó en una venta sin pagar, como `apartarCupon` (Codex r1 #3).
 * - De la cola sin red (`enLaCola`): lo que la mesa ya dio no se rechaza; el uso cuenta aunque pase del tope y, si pasa, queda el rastro
 *   `DESCUENTO_SOBRE_TOPE` en la bitácora del negocio, con el valor medido bajo el candado (Codex r1 #1 y #7).
 */
export async function sumarUsoDelDescuentoEnTx(
  tx: TxConReintento,
  d: {
    venueId: string
    discountId: string
    nombre: string
    /** El tope que se leyó (sólo decide si vale la pena contar apartados; el UPDATE compara contra el VIGENTE). */
    maxTotalUses: number | null
    orderId: string
    staffId?: string | null
    enLaCola?: boolean
  },
): Promise<void> {
  const enLaCola = d.enLaCola === true
  const apartados =
    enLaCola || d.maxTotalUses == null
      ? 0
      : await tx.orderDiscount.count({
          where: { couponCode: { discountId: d.discountId }, order: { venueId: d.venueId, ...APARTADO_DEL_CUPON } },
        })
  const sumados = await tx.$executeRaw`
    UPDATE "Discount" SET "currentUses" = "currentUses" + 1
    WHERE id = ${d.discountId} AND "venueId" = ${d.venueId}
      AND (${enLaCola} OR "maxTotalUses" IS NULL OR "currentUses" + ${apartados} < "maxTotalUses")`
  if (sumados === 0) throw descuentoSinUsos(d.nombre)
  if (!enLaCola) return
  const ahora = await tx.discount.findFirst({
    where: { id: d.discountId, venueId: d.venueId },
    select: { currentUses: true, maxTotalUses: true },
  })
  if (ahora?.maxTotalUses != null && ahora.currentUses > ahora.maxTotalUses) {
    await writeLegacyActivityAuditTx(tx, {
      staffId: d.staffId ?? null,
      venueId: d.venueId,
      action: 'DESCUENTO_SOBRE_TOPE',
      entity: 'Order',
      entityId: d.orderId,
      data: {
        orderId: d.orderId,
        discountId: d.discountId,
        nombre: d.nombre,
        usos: ahora.currentUses,
        tope: ahora.maxTotalUses,
        camino: 'mesa',
        sinRed: true,
      },
    })
  }
}

/** Devuelve UN uso (nunca baja de 0). Sólo para una fila con `usoContado`. */
export async function devolverUsoDelDescuentoEnTx(tx: TxConReintento, venueId: string, discountId: string): Promise<void> {
  await tx.discount.updateMany({
    where: { id: discountId, venueId, currentUses: { gt: 0 } },
    data: { currentUses: { decrement: 1 } },
  })
}

/**
 * La cuenta se va a BORRAR (el barrido de cuentas vacías abandonadas): sus filas con `usoContado` devuelven su uso antes, en esta
 * transacción (Codex r1 #4). Sin esto, un «primer uso» quedaba gastado sin venta ni fila desde la cual devolverlo. Una cuenta tiene
 * pocas filas; el tope de lectura es defensivo. Devuelve cuántos usos regresó.
 */
export async function devolverUsosDeCuentaQueSeBorraEnTx(tx: TxConReintento, venueId: string, orderId: string): Promise<number> {
  const filas = await tx.orderDiscount.findMany({
    where: { orderId, order: { venueId }, usoContado: true, discountId: { not: null } },
    select: { discountId: true },
    orderBy: { id: 'asc' },
    take: 200,
  })
  // Por id de descuento ascendente: dos barridos nunca toman las mismas filas `Discount` en orden contrario.
  const ids = filas.map(f => f.discountId!).sort()
  for (const id of ids) await devolverUsoDelDescuentoEnTx(tx, venueId, id)
  return ids.length
}
