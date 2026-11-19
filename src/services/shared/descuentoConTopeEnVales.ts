import { BadRequestError } from '../../errors/AppError'

/**
 * 🔴 D11 (pizarrón hz:e82938e1:D11, 18-nov; founder: «hagamos lo que tú recomiendes pero no puede haber un hueco o algo mal hecho nunca»).
 *
 * En una venta con vales NO se usa un descuento con tope de usos (total `maxTotalUses` o por clienta `maxUsesPerCustomer`). Contar esos
 * usos en la vida de un vale (emitir → reclamar → juntar → cancelar → rearmar → vencer → cobro tardío) no convergió en cuatro rondas de
 * Codex (r4/r5 de na24531d, r1/r2 de D11: 7, 10, 10, 10 bloqueantes), porque el contador ya es laxo en todo Avoqado (tarjeta D19).
 * Prohibir la entrada es lo que no deja hueco: si ningún descuento con tope entra a un renglón de vale ni a un suelto de la venta de
 * vales, no hay uso que contar por ellos. Medido el 18-nov: un solo negocio usa vales (ruta EXTERNAL) y ningún vale llevó descuento.
 *
 * Se revisa dentro de `buildOrderItemsData`, con la MISMA lectura del catálogo que calcula la rebaja y antes de `validateDiscountActive`
 * (un descuento ya agotado recibe este texto y no el viejo en inglés), y antes de escribir nada (vale, orden, folio, inventario). Cuenta cualquier
 * renglón que nombre el descuento, aunque su rebaja salga en $0. Un descuento de otro negocio no aparece aquí y lo sigue rechazando
 * `buildOrderItemsData` como siempre. Quien llama decide la ruta: la EXTERNAL no pasa por aquí (ya rechaza toda rebaja > $0).
 *
 * El tope manda desde que el dueño lo guarda: un vale que se imprimía en ese mismo instante, o antes, se respeta como impreso
 * (precedente «Se cobra el precio que vio el cliente», LFPC art. 7). Después de armar, la caja aplica descuentos como en cualquier venta.
 */
export const CODIGO_DESCUENTO_CON_TOPE_EN_VALES = 'AREA_TICKET_DISCOUNT_HAS_LIMIT'

/** El área (el aparato sólo emite): la salida es quitarlo; desde «Vale sin confirmar», «Descartar» y volver a emitir. */
export const textoDescuentoConTopeEnElVale = (nombre: string): string =>
  `El descuento «${nombre}» tiene tope de usos y no se puede poner en un vale: emite el vale sin ese descuento.`

/** La caja que arma la venta de vales: la salida es quitarle el descuento al producto suelto en el carrito. */
export const textoDescuentoConTopeEnLaCaja = (nombre: string): string =>
  `El descuento «${nombre}» tiene tope de usos y no se puede usar en una venta con vales: quítalo de ese producto para cobrar.`

/**
 * Puro: recibe los descuentos que `buildOrderItemsData` acaba de leer (UNA sola lectura: la misma que calcula la rebaja), antes de
 * `validateDiscountActive`. Codex D11 r4 #1: con dos lecturas, un tope guardado entre ellas hacía que el filtro y el cálculo vieran
 * descuentos distintos. Cuenta cualquier renglón que nombre el descuento, aunque su rebaja salga en $0.
 */
export function rechazarSiAlgunoTieneTope(
  descuentos: ReadonlyArray<{ name: string; maxTotalUses?: number | null; maxUsesPerCustomer?: number | null }>,
  donde: 'VALE' | 'CAJA',
): void {
  const conTope = [...descuentos]
    .filter(d => d.maxTotalUses != null || d.maxUsesPerCustomer != null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0]
  if (conTope) {
    const texto = donde === 'VALE' ? textoDescuentoConTopeEnElVale(conTope.name) : textoDescuentoConTopeEnLaCaja(conTope.name)
    throw new BadRequestError(texto, CODIGO_DESCUENTO_CON_TOPE_EN_VALES)
  }
}

/** ¿Es el 400 de D11? (quien llama busca entonces si su propia llave ya ganó: la misma llave no contesta éxito y 400). */
export const esRechazoPorTopeEnVales = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === CODIGO_DESCUENTO_CON_TOPE_EN_VALES
