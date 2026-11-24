/**
 * Quién cuenta en la cabecera del Resumen de ventas (carril B, 21-nov-2026). Vive aparte de `sales-summary.dashboard.service.ts`
 * para que el correo nocturno (`nightly-sales-summary.job.ts`) use la MISMA población sin importar el servicio, que sus pruebas
 * sustituyen entero (Codex r2 #2).
 *
 * D6 · base de caja (founder 15-sep-2026, «como Square»): una cuenta es VENTA cuando ya se cobró. Lo demás abierto es «Sin cobrar».
 * `o` es el alias de la fila de `Order`: `"Order"` (sin alias) u `o`. Texto de confianza (código propio), nunca entrada de usuario.
 */
import { sqlOrdenSinTarjetasTexto } from '@/services/giftCards/giftCardMarks'
import { sqlImpuestoQueSeCobraAparte } from '@/services/shared/orderBalance'
import { pagadoQueCubreSql } from '@/services/shared/pagadaPeroAbierta'

export type AliasDeOrden = '"Order"' | 'o'

/** Lo que la cuenta cobra sin propina, en las unidades de las ventas brutas: mercancía (con tope en 0) + IVA aparte + cargos. */
export function sqlLoQueCobraLaCuenta(o: AliasDeOrden): string {
  return `(GREATEST(0, ${o}.subtotal - ${o}."discountAmount") + ${sqlImpuestoQueSeCobraAparte(o)} + ${o}."serviceChargeAmount")`
}

/** D6 · «Sin cobrar» de UNA cuenta abierta: lo que todavía debe sin propina (lo pagado que cubre: sin propina y con los abonos devueltos que volvieron a deberse). */
export function sqlLoQueFaltaCobrar(o: AliasDeOrden): string {
  return `GREATEST(0, ${sqlLoQueCobraLaCuenta(o)} - ${pagadoQueCubreSql(o)})`
}

/**
 * D6 · ¿la cuenta ya es venta? `PAID`, o abierta (`PENDING`/`PARTIAL`) pero con cobros que ya la cubren (Codex r1 #1: la TPV
 * registra el cobro de una cuenta de SoftRestaurant y el cierre lo hace el otro sistema; si ese aviso se pierde, la bandera se
 * queda atrás y la venta desaparecería). Criterio de «pagada pero abierta»: un cobro positivo y lo pagado ≥ lo que cobra la cuenta.
 * B3 (revisión de apps viejas, hallazgo 4): un cobro viejo con `type` NULL SÍ es cobro, como en el resto del resumen (transacciones:
 * «type distinto de REFUND, con NULL adentro») y en `pagadoQueCubreSql`. Antes la puerta pedía REGULAR/FAST y una cuenta de $100
 * cubierta por un cobro NULL de $100 salía con $0 de venta y $0 «Sin cobrar». El barrido que CIERRA cuentas conserva su puerta
 * conservadora (`criterioPagadaPeroAbiertaSql`): escribe, y esto sólo lee. El CASE corta antes de las subconsultas en la `PAID`.
 */
export function sqlCuentaCobrada(o: AliasDeOrden): string {
  return `(CASE WHEN ${o}."paymentStatus" = 'PAID' THEN TRUE WHEN ${o}."paymentStatus" IN ('PENDING', 'PARTIAL') THEN (EXISTS (SELECT 1 FROM "Payment" pc WHERE pc."orderId" = ${o}.id AND pc.status = 'COMPLETED' AND (pc.type IS NULL OR pc.type IN ('REGULAR', 'FAST')) AND pc.amount > 0) AND ${pagadoQueCubreSql(o)} >= ${sqlLoQueCobraLaCuenta(o)} - 0.01) ELSE FALSE END)`
}

/**
 * B3 (hz:fefa11b6:D19): ¿la fila es una CUENTA? `PENDING` NO es «borrador»: es el estado por default de `Order` y el de toda cuenta
 * viva de la TPV mientras sigue abierta (abrir mesa, Cobrar, «Pagar después», separar, el check-in de una reserva, una cuenta
 * reabierta). Tratarla como borrador sacaba de la cabecera las mesas abiertas («Sin cobrar» en $0) y las ya cubiertas (fuera de las
 * ventas). La referencia son las listas de cuentas abiertas de la TPV y del POS (`getOrders`, `listOrders`) más «lo que nadie aceptó
 * ni se cobró en el negocio no es cuenta». Pasada exhaustiva y sus verificaciones: `docs/audit/2026-11-21-resumen-de-ventas/mesas/`.
 * Una `PENDING` todavía NO es cuenta:
 *  - el reparto en modo manual sin aceptar (aceptarlo a mano no cambia el estado: sólo estampa `providerAcceptedAt`), aunque la
 *    plataforma ya lo haya pagado: ese dinero se revierte si el negocio lo rechaza;
 *  - el kiosco legacy (abandonado, `OrderSource.KIOSK`) y el pedido en línea por aceptar (`PENDING_ACCEPTANCE`: «Mi equipo» sin
 *    aceptar, el apartado con tarjeta y el folio por pagar de la tienda híbrida, «A» del coordinador del 23-nov), salvo que ya se
 *    hayan cobrado en el negocio (entonces son venta, como todo lo cobrado);
 *  - el pedido en línea vencido, rechazado o cancelado que sigue `PENDING` sin dinero neto (R44: el folio vencido con su abono
 *    devuelto). Con dinero —también sólo propina— sí: vuelve a ser cobrable en «Cuentas abiertas» (Codex B3 r2 #3, r3 F4);
 *  - la orden testigo de un cobro con cripto que no se completó (`b4bit`: sin renglones) y no está cobrada. Sin renglones por otra
 *    razón sí es cuenta: la mesa que sólo debe un descorche (Codex B3 r2 #2) y la cabecera de SoftRestaurant (r1 #4).
 * El `CASE` corta antes de las subconsultas en toda cuenta que no es `PENDING` (casi todas).
 */
export function sqlEsCuenta(o: AliasDeOrden): string {
  const cobrada = sqlCuentaCobrada(o)
  // El estado de su pedido en línea, leído UNA vez: 0 = por aceptar, 1 = vencido/rechazado/cancelado, 2 = vivo o sin pedido en línea.
  const pedidoEnLinea = `COALESCE((SELECT CASE WHEN oo.status = 'PENDING_ACCEPTANCE' THEN 0 WHEN oo.status IN ('EXPIRED', 'REJECTED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_STAFF') THEN 1 ELSE 2 END FROM "OnlineOrder" oo WHERE oo."orderId" = ${o}.id), 2)`
  // Dinero neto que entró (importe y propina, sin lo que una devolución de abono volvió a deber).
  const conDinero = `(SELECT COALESCE(SUM(CASE WHEN pn.type = 'REFUND' THEN -(ABS(COALESCE(pn."reopenedAmount", 0)) + ABS(COALESCE(pn."reopenedTipAmount", 0))) ELSE pn.amount + pn."tipAmount" END), 0) FROM "Payment" pn WHERE pn."orderId" = ${o}.id AND pn.status = 'COMPLETED') > 0`
  const testigoDeCripto = `NOT EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."orderId" = ${o}.id) AND EXISTS (SELECT 1 FROM "Payment" px WHERE px."orderId" = ${o}.id AND px.method = 'CRYPTOCURRENCY' AND px.status <> 'COMPLETED')`
  // Lo cobrado en el negocio siempre es cuenta (y venta): una sola vez, después de las razones por las que una PENDING no lo es.
  return `(CASE WHEN ${o}.status IN ('CANCELLED', 'DELETED') THEN FALSE WHEN ${o}.status <> 'PENDING' THEN TRUE WHEN ${o}."originSystem" = 'DELIVERY_PLATFORM' AND ${o}."providerAcceptedAt" IS NULL THEN FALSE ELSE (CASE WHEN ${o}.source = 'KIOSK' THEN FALSE ELSE (CASE ${pedidoEnLinea} WHEN 0 THEN FALSE WHEN 1 THEN ${conDinero} ELSE NOT (${testigoDeCripto}) END) END) OR ${cobrada} END)`
}

/**
 * B3: el `FROM` del enunciado de cuentas (resumen y periodos): dos `CROSS JOIN LATERAL` que dan, por fila, `cuenta.es_venta`,
 * `cuenta.abierta` (todavía debe: «Ventas diferidas» y «Sin cobrar») y `cuenta.falta` (lo que debe sin propina). Una fila que no es
 * cuenta (`sqlEsCuenta`) queda con las tres en falso/0.
 * 🔴 Rendimiento (medido con `EXPLAIN ANALYZE` a 1×, 10× y 100×, `docs/audit/2026-11-21-resumen-de-ventas/mesas/`): cada lateral
 * lleva `OFFSET 0` para que Postgres no lo aplane, y así `sqlEsCuenta` y `sqlCuentaCobrada` se calculan UNA vez por fila. Aplanados,
 * cada bandera se copiaba en cada `FILTER` que la usa; en el WHERE, el planificador cobraba sus subconsultas por cada fila del rango.
 * Las dos formas cruzaban el umbral de JIT: +1.6 s en la cabecera a 10× y hasta +6 s en los periodos desde 1×.
 */
export function sqlLateralDeLaCuenta(o: AliasDeOrden): string {
  const debe = `${o}."paymentStatus" IN ('PENDING', 'PARTIAL')`
  return `CROSS JOIN LATERAL (SELECT ${sqlEsCuenta(o)} AS es OFFSET 0) viva CROSS JOIN LATERAL (SELECT (CASE WHEN viva.es THEN ${sqlCuentaCobrada(o)} ELSE FALSE END) AS es_venta, (viva.es AND ${debe}) AS abierta, (CASE WHEN viva.es AND ${debe} THEN ${sqlLoQueFaltaCobrar(o)} ELSE 0 END) AS falta OFFSET 0) cuenta`
}

/**
 * Las cuentas que son venta en la cabecera: una cuenta (`sqlEsCuenta`), cobrada y que no es venta de tarjetas de regalo.
 * Exportada para el correo nocturno (desglose por categoría y por origen) y los canales, que tienen que sumar las mismas ventas netas.
 */
export function sqlCuentaQueEsVenta(o: AliasDeOrden): string {
  const columna = `${o}.id` as const
  return `${sqlEsCuenta(o)} AND ${sqlCuentaCobrada(o)} AND ${sqlOrdenSinTarjetasTexto(columna)}`
}

/**
 * D1 · la comisión de terceros (Rappi, Uber, DiDi, tipos de pago propios) de UN cobro, congelada al cobrar y con signo. En la vista de
 * ventas sólo si su cuenta es venta (Codex r1 #5: el cobro tardío de una cuenta de Rappi ya cancelada no resta lo que la cabecera no
 * suma); en la vista de movimientos, la de todo cobro del filtro. `p` es el alias del cobro (vacío = sin calificar).
 */
export function sqlComisionDeTerceros(p: string, vistaDeMovimientos: boolean): string {
  const a = p ? `${p}.` : `"Payment".`
  if (vistaDeMovimientos) return `COALESCE(${a}"tenderCommissionAmount", 0)`
  return `(CASE WHEN ${a}"tenderCommissionAmount" IS NULL THEN 0 WHEN EXISTS (SELECT 1 FROM "Order" o WHERE o.id = ${a}"orderId" AND ${sqlCuentaQueEsVenta('o')}) THEN ${a}"tenderCommissionAmount" ELSE 0 END)`
}

/**
 * D6 (Codex r4 #1): ¿este cobro es de una cuenta VIVA que todavía no es venta? En la vista de ventas no cuenta en nada de la cabecera
 * —ni su propina, ni la comisión de Avoqado, ni como transacción— hasta que su cuenta sea venta: si no, un abono de $40 con $2 de
 * comisión dejaba «Neto cobrado» en −$2. B3: también el abono de una mesa abierta de la TPV (`PENDING`), el cobro de un reparto que
 * nadie aceptó y el abono de un folio por pagar (Codex B3 r1 #1). Una cuenta cancelada, borrada o `REFUNDED` sigue como antes.
 * Una `PAID` siempre está cobrada: sólo queda fuera si sigue `PENDING` y no es cuenta (así la `PAID` cerrada, casi todas, no evalúa
 * nada más; medido a 100×). `p` es el alias del cobro (vacío = `"Payment"` sin alias).
 */
export function sqlCobroDeCuentaSinCobrar(p: string): string {
  const a = p ? `${p}.` : `"Payment".`
  return `EXISTS (SELECT 1 FROM "Order" o WHERE o.id = ${a}"orderId" AND o.status NOT IN ('CANCELLED', 'DELETED') AND o."paymentStatus" IN ('PENDING', 'PARTIAL', 'PAID') AND NOT (CASE WHEN o."paymentStatus" = 'PAID' AND o.status <> 'PENDING' THEN TRUE ELSE ${sqlEsCuenta('o')} AND ${sqlCuentaCobrada('o')} END))`
}
