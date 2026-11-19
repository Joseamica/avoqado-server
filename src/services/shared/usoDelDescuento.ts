/**
 * 🔴 DINERO (hz:e82938e1:D19, encargos 01765a y 5b78aa): el ÚNICO dueño del uso que gastan las ventas del POS (Mesas y Mostrador de
 * ANDROID/WINDOWS, y la venta de la cola de la TPV que entra por `/mobile/orders`) en el tope de usos del catálogo
 * (`Discount.currentUses` / `maxTotalUses`, «primeros 100»). Antes Mesas revisaba el tope y nunca sumaba, y el Mostrador sumaba
 * DESPUÉS de guardar la venta, fuera de su transacción (una caída perdía el uso) y nunca contaba el descuento de cuenta que ANDROID manda
 * como importe con su etiqueta `descuentoDeCatalogoId`.
 *
 * La regla del founder (19-nov, «A», como Shopify y como el canje del cupón): **lo ya cobrado nunca se rechaza por el tope; se acepta,
 * la promoción queda un uso arriba y el dueño ve `DESCUENTO_SOBRE_TOPE` en la bitácora.** De ahí salen dos funciones:
 *
 * - `apartarUsoDeMesaEnTx` — Mesas pone el descuento en una cuenta abierta, ANTES de cobrar: ahí sí se puede decir «ya no hay» (en
 *   línea), contando los usos que un cupón apartó en una venta sin pagar. De la cola (la mesa ya lo dio sin red) nunca rechaza.
 * - `sumarUsosDeVentaEnTx` — la venta de Mostrador (ya cobrada o por cobrar en la misma petición): suma y avisa, nunca rechaza, en su
 *   PROPIA transacción corta después del commit de la venta (`terminarVentaDeMostrador`). La validación de antes de crear la venta
 *   (`validateDiscountActive`, como siempre) sigue diciendo «ya no hay» cuando el tope YA estaba lleno; lo que esto absorbe es el choque
 *   de dos cajas en el mismo segundo.
 *
 * 🔴 Candados (Codex r3 #3, #4, #5, #8 y r4 #4, #5, #6): ninguna de las dos toma el candado consultivo del cupón. Mesas toma la fila
 * `Discount` con la cuenta ya tomada (Order → Discount). La suma del Mostrador no vive dentro de la venta: su transacción sólo toma filas
 * `Discount`, en una pasada por id ascendente, así que no se cruza con el turno, el premio de sellos, la tarjeta de regalo ni la cuenta.
 *
 * Las filas de Mesas que sumaron quedan con `OrderDiscount.usoContado`; sólo ésas devuelven su uso (al quitarlas, al borrarse su cuenta
 * vacía o al convertirse en cortesía en un folio). El motor de la TPV y el canje del cupón cuentan por su lado.
 */
import { Prisma } from '@prisma/client'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import type { TxConReintento } from '@/utils/serializableRetry'
import { descuentoSinUsos } from './discount.service'

/** Lo que un cupón ya apartó del mismo descuento: una venta con cupón sin pagar (el canje sube el contador al cobrar). */
const APARTADO_DEL_CUPON = { status: { notIn: ['CANCELLED', 'DELETED'] }, couponRedemption: { is: null } } satisfies Prisma.OrderWhereInput

type FilaDelContador = { id: string; name: string; currentUses: number; maxTotalUses: number | null }
type Camino = 'mesa' | 'mostrador'

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
 * El rastro para el dueño cuando un uso dejó el contador ARRIBA de su tope, en la transacción de quien sumó (si la venta se revierte, el
 * rastro también). Sin `staffId` en la fila (va en `data`): una referencia a una persona dada de baja no puede tumbar la venta.
 */
async function avisarSiPasoDelTopeEnTx(
  tx: TxConReintento,
  v: {
    venueId: string
    orderId: string
    discountId: string
    nombre: string
    usos: number
    tope: number | null
    camino: Camino
    sinRed: boolean
    quien?: string | null
  },
): Promise<boolean> {
  if (v.tope == null || v.usos <= v.tope) return false
  await writeLegacyActivityAuditTx(tx, {
    staffId: null,
    venueId: v.venueId,
    action: 'DESCUENTO_SOBRE_TOPE',
    entity: 'Order',
    entityId: v.orderId,
    data: {
      orderId: v.orderId,
      discountId: v.discountId,
      nombre: v.nombre,
      usos: v.usos,
      tope: v.tope,
      camino: v.camino,
      sinRed: v.sinRed,
      subidaPor: v.quien ?? null,
    },
  })
  return true
}

/**
 * Mesas: el descuento de cuenta entra a una cuenta abierta y gasta UN uso, en la transacción que ya tiene la cuenta.
 *
 * - En línea: rechaza con el texto de siempre si `currentUses + apartados del cupón >= tope`, leído con la fila `Discount` tomada (dos
 *   cajas con el último uso: la segunda espera la fila y lee el valor nuevo; el tope es el VIGENTE, no el que se leyó antes).
 * - De la cola sin red (`enLaCola`): la mesa ya lo dio; nunca rechaza, el uso cuenta y, si pasa del tope, deja `DESCUENTO_SOBRE_TOPE`.
 *
 * Los apartados se cuentan sin el candado consultivo del cupón (Codex r3 #4: ese candado contra la cuenta abría un ciclo con el
 * Mostrador con cupón y mesa). Si un cupón aparta el mismo último uso en ese instante, su canje al cobrar no rechaza (queda un uso
 * arriba, como decidió el founder; el canje todavía no deja el aviso: anotado como deuda).
 */
export async function apartarUsoDeMesaEnTx(
  tx: TxConReintento,
  v: { venueId: string; orderId: string; discountId: string; enLaCola?: boolean; quien?: string | null },
): Promise<void> {
  const enLaCola = v.enLaCola === true
  const [d] = await tomarFilas(tx, v.venueId, [v.discountId])
  // El dueño lo borró del catálogo mientras tanto: no hay uso que contar (quien llama ya lo leyó y decide).
  if (!d) return
  if (!enLaCola && d.maxTotalUses != null) {
    const apartados = await tx.orderDiscount.count({
      where: { couponCode: { discountId: d.id }, order: { venueId: v.venueId, ...APARTADO_DEL_CUPON } },
    })
    if (d.currentUses + apartados >= d.maxTotalUses) throw descuentoSinUsos(d.name)
  }
  await tx.discount.update({ where: { id: d.id }, data: { currentUses: { increment: 1 } } })
  await avisarSiPasoDelTopeEnTx(tx, {
    venueId: v.venueId,
    orderId: v.orderId,
    discountId: d.id,
    nombre: d.name,
    usos: d.currentUses + 1,
    tope: d.maxTotalUses,
    camino: 'mesa',
    sinRed: enLaCola,
    quien: v.quien,
  })
}

/**
 * La venta de Mostrador gasta UN uso de cada descuento de catálogo que lleva (uno por venta aunque se repita en varios renglones), y
 * NUNCA la rechaza (decisión «A»): si el contador queda arriba del tope, deja `DESCUENTO_SOBRE_TOPE` en la misma transacción. Corre
 * en su propia transacción después del commit de la venta. Un id que no es del negocio o que ya no existe no cuenta nada.
 */
export async function sumarUsosDeVentaEnTx(
  tx: TxConReintento,
  v: { venueId: string; orderId: string; discountIds: string[]; enLaCola?: boolean; quien?: string | null },
): Promise<void> {
  const ids = [...new Set(v.discountIds.filter(Boolean))].sort()
  for (const d of await tomarFilas(tx, v.venueId, ids)) {
    await tx.discount.update({ where: { id: d.id }, data: { currentUses: { increment: 1 } } })
    await avisarSiPasoDelTopeEnTx(tx, {
      venueId: v.venueId,
      orderId: v.orderId,
      discountId: d.id,
      nombre: d.name,
      usos: d.currentUses + 1,
      tope: d.maxTotalUses,
      camino: 'mostrador',
      sinRed: v.enLaCola === true,
      quien: v.quien,
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
 * Todas las filas de la cuenta con `usoContado` devuelven su uso en esta transacción (por páginas, sin tope que deje usos ocupados).
 * Las filas `Discount` se toman en una pasada ascendente y cada una baja lo suyo de una vez, sin bajar de 0. Con `soltarMarca` (la
 * anulación), las filas se quedan (historia de la cuenta anulada) sin `usoContado` y con `usoDevueltoAlAnular`, en la MISMA
 * transacción: un reintento de la anulación, el barrido de vacías, quitar la fila desde el POS o la TPV después (la cuenta revivió por
 * dinero tardío) ya no devuelven otra vez. La marca se suelta DESPUÉS de tomar las filas `Discount` (como quitar la fila: Discount
 * antes que escribir cualquier fila de la cuenta, Codex r1 #6 de D19). Devuelve lo que de verdad bajó cada contador (Codex D24 r1 #3:
 * un contador que ya estaba en 0 no «devuelve» nada).
 */
async function devolverUsosMarcadosEnTx(
  tx: TxConReintento,
  venueId: string,
  orderId: string,
  opciones: { soltarMarca: boolean },
): Promise<Map<string, number>> {
  const marcadas = { orderId, order: { venueId }, usoContado: true, discountId: { not: null } } satisfies Prisma.OrderDiscountWhereInput
  const usos = new Map<string, number>()
  for (let despues: string | null = null; ; ) {
    const pagina: Array<{ id: string; discountId: string | null }> = await tx.orderDiscount.findMany({
      where: { ...marcadas, ...(despues ? { id: { gt: despues } } : {}) },
      select: { id: true, discountId: true },
      orderBy: { id: 'asc' },
      take: PAGINA,
    })
    for (const f of pagina) usos.set(f.discountId!, (usos.get(f.discountId!) ?? 0) + 1)
    if (pagina.length < PAGINA) break
    despues = pagina[pagina.length - 1].id
  }
  const devueltos = new Map<string, number>()
  // Un descuento que ya no está en el catálogo (o es de otro negocio) no tiene contador que bajar. El piso es 0, como siempre: un
  // contador que otro camino dejó abajo de 0 queda en 0 (Codex D24 r2 #4), y lo devuelto es sólo lo que de verdad bajó (r1 #3).
  for (const d of await tomarFilas(tx, venueId, [...usos.keys()].sort())) {
    const nuevo = Math.max(0, d.currentUses - (usos.get(d.id) ?? 0))
    if (nuevo !== d.currentUses) await tx.discount.update({ where: { id: d.id }, data: { currentUses: nuevo } })
    if (d.currentUses > nuevo) devueltos.set(d.id, d.currentUses - nuevo)
  }
  if (opciones.soltarMarca && usos.size > 0) {
    await tx.orderDiscount.updateMany({ where: marcadas, data: { usoContado: false, usoDevueltoAlAnular: true } })
  }
  return devueltos
}

/**
 * D24 (Codex r1 #4a, r2 #5): en una cuenta que se anula, la fila del POS cuyo descuento se borró del catálogo (`discountId` en null)
 * ya no ocupa un uso (el contador se fue con el descuento): pierde la marca. Sólo escribe filas sin enlace a `Discount`.
 */
export async function soltarMarcaDeFilasSinDescuentoEnTx(tx: TxConReintento, venueId: string, orderId: string): Promise<void> {
  await tx.orderDiscount.updateMany({
    where: { orderId, order: { venueId }, usoContado: true, discountId: null },
    data: { usoContado: false },
  })
}

const sumar = (usos: Map<string, number>) => [...usos.values()].reduce((s, n) => s + n, 0)

/**
 * La cuenta se va a BORRAR (el barrido de cuentas vacías abandonadas): TODAS sus filas con `usoContado` devuelven su uso antes, en esta
 * transacción (Codex r1 #4, r2 #6: por páginas, sin tope que deje usos ocupados). Devuelve cuántos usos regresó.
 */
export async function devolverUsosDeCuentaQueSeBorraEnTx(tx: TxConReintento, venueId: string, orderId: string): Promise<number> {
  return sumar(await devolverUsosMarcadosEnTx(tx, venueId, orderId, { soltarMarca: false }))
}

/**
 * 🔴 hz:e82938e1:D24: la cuenta se ANULA sin cobrar (POS, la cola sin red `CANCEL_ORDER`, la TPV al anular todo, el panel, el MCP, los
 * vales, «Regresar saldo y cancelar»). Antes sólo regresaban los canjes de lealtad y el uso del descuento de cuenta se quedaba gastado: un
 * «primeros 100» se agotaba antes de tiempo en todas las cajas. Las filas se quedan como historia de la anulada, sin la marca.
 * Lo llama `devolverCanjesDeVentaAnuladaEnTx` (un solo lugar para todas las anulaciones), con la cuenta ya tomada (Order → Discount).
 */
export async function devolverUsosDeCuentaAnuladaEnTx(
  tx: TxConReintento,
  venueId: string,
  orderId: string,
): Promise<{ usos: number; porDescuento: Record<string, number> }> {
  const usos = await devolverUsosMarcadosEnTx(tx, venueId, orderId, { soltarMarca: true })
  return { usos: sumar(usos), porDescuento: Object.fromEntries(usos) }
}
