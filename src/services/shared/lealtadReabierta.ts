/**
 * La MARCA de fila que deja una liga tardía al reabrir la lealtad de una venta ya cobrada (`reabrirLealtadSiAplica`).
 *
 * 🔴 Por qué existe (medido contra Postgres por S3b, 14-oct-2026): la lealtad del cobro que leyó la venta «sin cliente»
 * cierra con `UPDATE "Order" … WHERE loyaltyProcessedAt IS NULL AND NOT EXISTS (OrderCustomer…)`. Si ese cierre llega mientras
 * la transacción de la liga tiene el candado de la fila, espera; al soltarse, Postgres (READ COMMITTED) vuelve a evaluar SÓLO
 * las columnas de la fila nueva, y la subconsulta conserva su foto vieja («sin clientes»). El cierre pasaba y la venta quedaba
 * «procesada» sin sello; si además fallaba el intento de la liga, el reconciliador nunca la volvía a ver.
 *
 * Una columna de la fila sí se relee. La reapertura escribe esta marca en `loyaltyLastError`, y el cierre «sin cliente» de
 * `awardLoyaltyForPaidOrder` exige que no esté. Los cierres buenos (la corrida que vio al cliente, el reconciliador, el
 * envoltorio de reembolsos) ponen `loyaltyLastError = null` como siempre, y con eso la borran. Sin migración: es una columna
 * que ya existe, y sirve igual para el móvil y para la TPV.
 *
 * Vive en su propio módulo, sin dependencias, porque la leen los dos lados: `loyaltyOnPaidOrder` (el cierre) y
 * `loyaltyOnLateCustomer` (la reapertura, que lo re-exporta), y éste importa al primero.
 */
export const MARCA_LEALTAD_REABIERTA = 'REABIERTA: cliente ligado después del cobro'
