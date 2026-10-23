import { BadRequestError } from '../../errors/AppError'

/** R11 (Codex r5): lo que ve el operador cuando intenta rearmar una cuenta importada. */
export const MENSAJE_ORDEN_IMPORTADA =
  'Esta cuenta viene de SoftRestaurant y su total lo manda ese sistema: quita, anula, agrega, separa, junta, regala o descuenta artículos allá. Aquí sólo se cobra.'

/**
 * R11 (IVA por producto, B2b; Codex r5): una orden importada de SoftRestaurant trae renglones con precio CON IVA y su impuesto
 * POR PIEZA (`avoqado-windows-service/src/components/producer.ts:440-445`), y su cabecera —la que manda— el subtotal SIN IVA.
 * Toda escritura de Avoqado que rearma el dinero desde esos renglones o reparte sobre ellos cobraría el IVA dos veces con P12.
 * Por origen, no por fecha: cubre también las importadas viejas que sigan mutables.
 */
export function esOrdenImportada(orden: { originSystem: string | null }): boolean {
  return orden.originSystem === 'POS_SOFTRESTAURANT'
}

/** Rappi 2b (T10): lo que ve el operador cuando intenta rearmar un pedido de Rappi, Uber o Deliverect. */
export const MENSAJE_ORDEN_DE_PLATAFORMA = 'Este pedido viene de la plataforma de reparto y su total lo manda ella: aquí sólo se cobra.'

/**
 * Rappi 2b (diseño 2026-10-23, T10): ¿el total lo manda OTRO sistema? SoftRestaurant (su cabecera) o la plataforma de reparto
 * (lo que cobró o cobrará el repartidor). Lo usan las exclusiones de lo AUTOMÁTICO (cargos por comensales, descuentos automáticos):
 * no rearman esas cuentas. `esOrdenImportada` no cambia porque también decide el IVA.
 */
export function tieneTotalAjeno(orden: { originSystem: string | null }): boolean {
  return esOrdenImportada(orden) || orden.originSystem === 'DELIVERY_PLATFORM'
}

/**
 * Corta, con la causa, una escritura de Avoqado sobre una importada o un pedido de plataforma: después del candado y antes de
 * escribir nada. Rappi 2b (T10): un pedido de plataforma tampoco se rearma (descuentos, cortesías, cargos, promociones, lealtad,
 * renglones, separar/juntar): lo pagado ya no debía editarse (lo frenaba `PAID` por accidente) y el que se cobra en efectivo
 * descuadraría lo que pide la plataforma. Lo que el proveedor cambia (retiro de renglón, cancelación) va por su camino propio.
 */
export function rechazarSiEsImportada(orden: { originSystem: string | null }): void {
  if (esOrdenImportada(orden))
    throw new BadRequestError(MENSAJE_ORDEN_IMPORTADA, 'ORDEN_IMPORTADA_DEL_POS', { originSystem: orden.originSystem })
  if (orden.originSystem === 'DELIVERY_PLATFORM')
    throw new BadRequestError(MENSAJE_ORDEN_DE_PLATAFORMA, 'ORDEN_DE_PLATAFORMA', { originSystem: orden.originSystem })
}
