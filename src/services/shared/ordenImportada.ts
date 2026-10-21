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

/** Corta, con la causa, una escritura de Avoqado sobre una importada: después del candado y antes de escribir nada. */
export function rechazarSiEsImportada(orden: { originSystem: string | null }): void {
  if (esOrdenImportada(orden))
    throw new BadRequestError(MENSAJE_ORDEN_IMPORTADA, 'ORDEN_IMPORTADA_DEL_POS', { originSystem: orden.originSystem })
}
