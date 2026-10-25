import { ConflictError } from '../../errors/AppError'

/** Lo que ve quien intenta cobrar por otra puerta un pedido de Rappi que el cliente paga en efectivo al repartidor. */
export const MENSAJE_RAPPI_SOLO_EFECTIVO =
  'Este pedido de Rappi lo paga el cliente en efectivo al repartidor: cóbralo con «Cobrar» en efectivo, que separa la venta, la propina y lo de Rappi.'

/** ¿Es un pedido de Rappi en efectivo (repartidor propio)? La ingesta es la única que escribe `thirdPartyCashDue`. */
export function esRappiEnEfectivo(orden: { thirdPartyCashDue?: unknown }): boolean {
  return orden.thirdPartyCashDue != null
}

/**
 * 🔴 Rappi 2b (diseño 2026-10-23, T7): una ACCIÓN NUEVA de cobro por otra puerta (terminal, cripto, pago manual del panel,
 * liquidar, saldo de regalo) sobre un pedido de Rappi en efectivo ⇒ 409, antes de autorizar o escribir nada: esas puertas no saben
 * repartir venta, propina y lo de Rappi. NUNCA se usa donde el dinero ya se autorizó o se capturó (registradores de la terminal,
 * confirmación de cripto, la cola sin red): ahí se registra y se avisa.
 */
export function rechazarAccionDeCobroSobreRappiEnEfectivo(orden: { thirdPartyCashDue?: unknown }): void {
  if (esRappiEnEfectivo(orden)) throw new ConflictError(MENSAJE_RAPPI_SOLO_EFECTIVO, 'RAPPI_CASH_ORDER_CASH_ONLY')
}
