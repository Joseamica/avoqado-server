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
 * queda atrás y la venta desaparecería). Mismo criterio que «pagada pero abierta»: un cobro REGULAR/FAST positivo y lo pagado ≥ lo
 * que cobra la cuenta. El CASE corta antes de las subconsultas en la cuenta `PAID` (casi todas).
 */
export function sqlCuentaCobrada(o: AliasDeOrden): string {
  return `(CASE WHEN ${o}."paymentStatus" = 'PAID' THEN TRUE WHEN ${o}."paymentStatus" IN ('PENDING', 'PARTIAL') THEN (EXISTS (SELECT 1 FROM "Payment" pc WHERE pc."orderId" = ${o}.id AND pc.status = 'COMPLETED' AND pc.type IN ('REGULAR', 'FAST') AND pc.amount > 0) AND ${pagadoQueCubreSql(o)} >= ${sqlLoQueCobraLaCuenta(o)} - 0.01) ELSE FALSE END)`
}

/**
 * Las cuentas que son venta en la cabecera: no borrador/cancelada/borrada, cobradas y que no son venta de tarjetas de regalo.
 * Exportada para el correo nocturno (desglose por categoría y por origen), que tiene que sumar las mismas ventas netas.
 */
export function sqlCuentaQueEsVenta(o: AliasDeOrden): string {
  const columna = `${o}.id` as const
  return `${o}.status NOT IN ('PENDING', 'CANCELLED', 'DELETED') AND ${sqlCuentaCobrada(o)} AND ${sqlOrdenSinTarjetasTexto(columna)}`
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
 * D6 (Codex r4 #1): ¿este cobro es de una cuenta ABIERTA que todavía no es venta (un abono)? En la vista de ventas no cuenta en nada
 * de la cabecera —ni su propina, ni la comisión de Avoqado, ni como transacción— hasta que la cuenta se cobre completa: si no, un
 * abono de $40 con $2 de comisión dejaba «Neto cobrado» en −$2. Una cuenta en borrador (`PENDING`), cancelada o borrada sigue como
 * antes. `p` es el alias del cobro (vacío = `"Payment"` sin alias).
 */
export function sqlCobroDeCuentaSinCobrar(p: string): string {
  const a = p ? `${p}.` : `"Payment".`
  return `EXISTS (SELECT 1 FROM "Order" o WHERE o.id = ${a}"orderId" AND o."paymentStatus" IN ('PENDING', 'PARTIAL') AND o.status NOT IN ('PENDING', 'CANCELLED', 'DELETED') AND NOT ${sqlCuentaCobrada('o')})`
}
