/**
 * 🔴 DINERO (hz:e82938e1:D19, encargo 01765a): el ÚNICO dueño del uso que gastan las ventas del POS (Mesas y Mostrador de
 * ANDROID/WINDOWS, y la venta de la cola de la TPV que entra por aquí) en el tope de usos del catálogo (`Discount.currentUses` /
 * `maxTotalUses`, «primeros 100»). Antes Mesas revisaba el tope y nunca sumaba, y el Mostrador sumaba DESPUÉS de guardar la venta,
 * fuera de su transacción y sin volver a revisar.
 *
 * Decide bajo el MISMO candado que el cupón (`bloquearDescuentoDelCupon`) y con la fila `Discount` tomada, así que el contador, el tope
 * vigente y los usos que un cupón apartó en una venta sin pagar se leen juntos y nadie más los mueve mientras tanto (Codex r1 #2 y #3,
 * r2 #1 y #2). Todo va en la transacción de quien llama, que ya tiene la cuenta (Order → candado del descuento → fila `Discount`, el
 * orden de `apartarCupon` en la TPV) y corre con reintento por traba (S5b).
 *
 * Las filas de Mesas que sumaron quedan con `OrderDiscount.usoContado`; sólo ésas devuelven su uso (al quitarlas, al borrarse su cuenta
 * vacía o al convertirse en cortesía en un folio). El motor de la TPV y el canje del cupón cuentan por su lado.
 */
import { Prisma } from '@prisma/client'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import type { TxConReintento } from '@/utils/serializableRetry'
import { bloquearDescuentoDelCupon } from './cuponDeLaVenta'
import { descuentoSinUsos } from './discount.service'

/** Lo que un cupón ya apartó del mismo descuento: una venta con cupón sin pagar (el canje sube el contador al cobrar). */
const APARTADO_DEL_CUPON = { status: { notIn: ['CANCELLED', 'DELETED'] }, couponRedemption: { is: null } } satisfies Prisma.OrderWhereInput

type FilaDelContador = { id: string; name: string; currentUses: number; maxTotalUses: number | null }

/** Las filas `Discount`, tomadas en UNA pasada por id ascendente (`FOR NO KEY UPDATE`, el modo del UPDATE del contador). */
async function tomarFilas(tx: TxConReintento, venueId: string, ids: string[]): Promise<FilaDelContador[]> {
  if (ids.length === 0) return []
  const filas = await tx.$queryRaw<FilaDelContador[]>`
    SELECT id, name, "currentUses", "maxTotalUses" FROM "Discount"
    WHERE "venueId" = ${venueId} AND id = ANY(${ids}::text[])
    ORDER BY id
    FOR NO KEY UPDATE`
  const pedidos = new Set(ids)
  return (filas ?? []).filter(f => pedidos.has(f.id))
}

/**
 * Suma UN uso de cada descuento de la venta (uno por venta aunque se repita), o rechaza la venta entera con el texto de siempre.
 *
 * - En línea: rechaza si `currentUses + apartados del cupón >= tope`, todo leído bajo el candado (dos cajas con el último uso: pasa una).
 * - De la cola sin red (`enLaCola`): lo que ya pasó frente al cliente nunca se rechaza. El uso cuenta aunque pase del tope y, si pasa,
 *   queda `DESCUENTO_SOBRE_TOPE` en la bitácora del negocio EN ESTA transacción (Codex r1 #1 y #7, r2 #3). Sin `staffId` en la fila (va
 *   en `data`): una referencia a una persona dada de baja no puede tumbar la venta (Codex r2 #4).
 */
export async function sumarUsosDelDescuentoEnTx(
  tx: TxConReintento,
  v: { venueId: string; orderId: string; discountIds: string[]; enLaCola?: boolean; quien?: string | null; camino: 'mesa' | 'mostrador' },
): Promise<void> {
  const ids = [...new Set(v.discountIds)].sort()
  if (ids.length === 0) return
  const enLaCola = v.enLaCola === true
  // Primero TODOS los candados del descuento (ascendentes) y después las filas: como la tienda (S10), nunca uno después de una fila.
  for (const id of ids) await bloquearDescuentoDelCupon(tx, id)
  // Un descuento que ya no está (el dueño lo borró mientras tanto) no tiene uso que contar: no rechaza la venta (como antes, que sumaba
  // con `updateMany` y no encontraba nada).
  const filas = await tomarFilas(tx, v.venueId, ids)
  for (const d of filas) {
    if (enLaCola || d.maxTotalUses == null) continue
    const apartados = await tx.orderDiscount.count({
      where: { couponCode: { discountId: d.id }, order: { venueId: v.venueId, ...APARTADO_DEL_CUPON } },
    })
    if (d.currentUses + apartados >= d.maxTotalUses) throw descuentoSinUsos(d.name)
  }
  for (const d of filas) {
    await tx.discount.update({ where: { id: d.id }, data: { currentUses: { increment: 1 } } })
    if (d.maxTotalUses == null || d.currentUses + 1 <= d.maxTotalUses) continue
    await writeLegacyActivityAuditTx(tx, {
      staffId: null,
      venueId: v.venueId,
      action: 'DESCUENTO_SOBRE_TOPE',
      entity: 'Order',
      entityId: v.orderId,
      data: {
        orderId: v.orderId,
        discountId: d.id,
        nombre: d.name,
        usos: d.currentUses + 1,
        tope: d.maxTotalUses,
        camino: v.camino,
        sinRed: enLaCola,
        subidaPor: v.quien ?? null,
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

const PAGINA = 200

/**
 * La cuenta se va a BORRAR (el barrido de cuentas vacías abandonadas): TODAS sus filas con `usoContado` devuelven su uso antes, en esta
 * transacción (Codex r1 #4, r2 #6: por páginas, sin tope que deje usos ocupados). Las filas `Discount` se toman en una pasada ascendente
 * y cada una baja lo suyo de una vez, sin bajar de 0. Devuelve cuántos usos regresó.
 */
export async function devolverUsosDeCuentaQueSeBorraEnTx(tx: TxConReintento, venueId: string, orderId: string): Promise<number> {
  const usos = new Map<string, number>()
  for (let despues: string | null = null; ; ) {
    const pagina: Array<{ id: string; discountId: string | null }> = await tx.orderDiscount.findMany({
      where: { orderId, order: { venueId }, usoContado: true, discountId: { not: null }, ...(despues ? { id: { gt: despues } } : {}) },
      select: { id: true, discountId: true },
      orderBy: { id: 'asc' },
      take: PAGINA,
    })
    for (const f of pagina) usos.set(f.discountId!, (usos.get(f.discountId!) ?? 0) + 1)
    if (pagina.length < PAGINA) break
    despues = pagina[pagina.length - 1].id
  }
  if (usos.size === 0) return 0
  for (const d of await tomarFilas(tx, venueId, [...usos.keys()].sort())) {
    await tx.discount.update({ where: { id: d.id }, data: { currentUses: Math.max(0, d.currentUses - (usos.get(d.id) ?? 0)) } })
  }
  return [...usos.values()].reduce((s, n) => s + n, 0)
}
