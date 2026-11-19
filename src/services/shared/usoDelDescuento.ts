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
import logger from '@/config/logger'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import prisma from '@/utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import { descuentoSinUsos } from './discount.service'
import { lockExistingOrderForPayment, ORDER_LOCK_WAIT_BUDGET } from './paymentShiftClaim'

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

/** Las filas de la cuenta que sumaron su uso y todavía lo ocupan (o esperan devolverlo tras una anulación). */
const filasConUso = (venueId: string, orderId: string) =>
  ({ orderId, order: { venueId }, usoContado: true, discountId: { not: null } }) satisfies Prisma.OrderDiscountWhereInput

/** Cuántas filas de cada descuento, por páginas (sin tope que deje usos ocupados). */
async function contarPorDescuento(tx: TxConReintento, where: Prisma.OrderDiscountWhereInput): Promise<Map<string, number>> {
  const usos = new Map<string, number>()
  for (let despues: string | null = null; ; ) {
    const pagina: Array<{ id: string; discountId: string | null }> = await tx.orderDiscount.findMany({
      where: { ...where, ...(despues ? { id: { gt: despues } } : {}) },
      select: { id: true, discountId: true },
      orderBy: { id: 'asc' },
      take: PAGINA,
    })
    for (const f of pagina) usos.set(f.discountId!, (usos.get(f.discountId!) ?? 0) + 1)
    if (pagina.length < PAGINA) break
    despues = pagina[pagina.length - 1].id
  }
  return usos
}

/**
 * Baja los contadores: las filas `Discount` en una pasada ascendente, cada una de una vez y con el piso de siempre (0; un contador que
 * otro camino dejó abajo de 0 queda en 0, Codex D24 r2 #4). Devuelve lo que de verdad bajó cada uno (r1 #3). Un descuento que ya no
 * está en el catálogo (o es de otro negocio) no tiene contador que bajar.
 */
async function bajarContadores(tx: TxConReintento, venueId: string, usos: Map<string, number>): Promise<Map<string, number>> {
  const devueltos = new Map<string, number>()
  for (const d of await tomarFilas(tx, venueId, [...usos.keys()].sort())) {
    const nuevo = Math.max(0, d.currentUses - (usos.get(d.id) ?? 0))
    if (nuevo !== d.currentUses) await tx.discount.update({ where: { id: d.id }, data: { currentUses: nuevo } })
    if (d.currentUses > nuevo) devueltos.set(d.id, d.currentUses - nuevo)
  }
  return devueltos
}

const sumar = (usos: Map<string, number>) => [...usos.values()].reduce((s, n) => s + n, 0)

/**
 * La cuenta se va a BORRAR (el barrido de cuentas vacías abandonadas): TODAS sus filas con `usoContado` devuelven su uso antes, en esta
 * transacción (Codex r1 #4, r2 #6: por páginas, sin tope que deje usos ocupados). Devuelve cuántos usos regresó.
 */
export async function devolverUsosDeCuentaQueSeBorraEnTx(tx: TxConReintento, venueId: string, orderId: string): Promise<number> {
  return sumar(await bajarContadores(tx, venueId, await contarPorDescuento(tx, filasConUso(venueId, orderId))))
}

/**
 * 🔴 hz:e82938e1:D24, paso 1 de 2 — DENTRO de la transacción que anula la cuenta sin cobrar (POS, la cola sin red `CANCEL_ORDER`, la TPV
 * al anular todo, el panel, el MCP, los vales, «Regresar saldo y cancelar», el barrido): las filas que sumaron su uso quedan «por
 * devolver» (`usoDevueltoAlAnular`, con `usoContado` todavía en true). NO toma la fila `Discount`: Codex D24 r1–r3 mostró que tomarla
 * aquí, con la cuenta, el turno, la clienta o la tarjeta de regalo ya tomados según el camino, abría ciclos de candados. Sólo escribe
 * filas de la cuenta (que ya está tomada) y nunca espera un `Discount`, así que tampoco se cruza con borrar el descuento del catálogo.
 * Devuelve cuántas quedaron por devolver.
 */
export async function marcarUsosPorDevolverEnTx(tx: TxConReintento, venueId: string, orderId: string): Promise<number> {
  const marcadas = await tx.orderDiscount.updateMany({
    where: { ...filasConUso(venueId, orderId), usoDevueltoAlAnular: false },
    data: { usoDevueltoAlAnular: true },
  })
  return marcadas?.count ?? 0
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

/**
 * 🔴 hz:e82938e1:D24, paso 2 de 2 — DESPUÉS del commit de la anulación, en su PROPIA transacción corta (como la suma del Mostrador,
 * `sumarUsosDeVentaEnTx`): cuenta (`Order` FOR UPDATE) → filas `Discount` (ascendente) → filas de la cuenta, el mismo orden que
 * `removeOrderDiscountInTransaction`. No toma turno, clienta, premio ni tarjeta de regalo.
 *
 * - Cuenta todavía anulada (`CANCELLED`/`DELETED`): las filas por devolver bajan su contador (piso 0) y quedan `usoContado = false`
 *   (devueltas: nadie lo vuelve a restar, ni la TPV al quitar el descuento). Deja `ORDER_CANCEL_DISCOUNT_USES_RETURNED` si bajó algo.
 * - La cuenta revivió antes (dinero tardío, `reabrirSiRecibeDinero`): se queda con su descuento, así que el uso sigue ocupado; la fila
 *   vuelve a `usoDevueltoAlAnular = false`.
 *
 * Idempotente (la cuenta tomada serializa dos llamadas; la segunda ya no encuentra filas por devolver) y NUNCA lanza: la anulación ya
 * quedó firme. Si el proceso muere entre el commit y este paso, ese uso se queda gastado como antes de D24 (el mismo riesgo que acepta
 * el Mostrador) y las filas siguen «por devolver»: quitarlas desde el POS o la TPV en una cuenta revivida lo devuelve una sola vez.
 * Devuelve cuántos usos bajaron.
 */
export async function devolverUsosTrasAnular(input: {
  venueId: string
  orderId: string
  staffId?: string | null
  camino: string
}): Promise<number> {
  const porDevolver = { ...filasConUso(input.venueId, input.orderId), usoDevueltoAlAnular: true } satisfies Prisma.OrderDiscountWhereInput
  try {
    // Lo normal: nada por devolver. Sin abrir transacción ni tomar la cuenta.
    if (!(await prisma.orderDiscount.findFirst({ where: porDevolver, select: { id: true } }))) return 0
    return await withDeadlockRetry(
      async tx => {
        if (!(await lockExistingOrderForPayment(tx, input))) return 0
        const orden = await tx.order.findFirst({ where: { id: input.orderId, venueId: input.venueId }, select: { status: true } })
        if (!orden) return 0
        if (orden.status !== 'CANCELLED' && orden.status !== 'DELETED') {
          await tx.orderDiscount.updateMany({ where: porDevolver, data: { usoDevueltoAlAnular: false } })
          return 0
        }
        const usos = await contarPorDescuento(tx, porDevolver)
        if (usos.size === 0) return 0
        const devueltos = await bajarContadores(tx, input.venueId, usos)
        await tx.orderDiscount.updateMany({ where: porDevolver, data: { usoContado: false } })
        const total = sumar(devueltos)
        if (total > 0) {
          await tx.activityLog.create({
            data: {
              action: 'ORDER_CANCEL_DISCOUNT_USES_RETURNED',
              entity: 'Order',
              entityId: input.orderId,
              venueId: input.venueId,
              staffId: input.staffId ?? null,
              data: { camino: input.camino, usosDevueltos: total, porDescuento: Object.fromEntries(devueltos) },
            },
          })
        }
        return total
      },
      { etiqueta: 'devolverUsosTrasAnular', ...ORDER_LOCK_WAIT_BUDGET },
    )
  } catch (error) {
    logger.warn('🏷️ [Anular] no se pudo devolver el uso del descuento de cuenta tras anular (queda por devolver)', {
      venueId: input.venueId,
      orderId: input.orderId,
      camino: input.camino,
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}
