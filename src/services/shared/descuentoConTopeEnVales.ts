import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

/**
 * 🔴 D11 (pizarrón hz:e82938e1:D11, 18-nov; founder: «hagamos lo que tú recomiendes pero no puede haber un hueco o algo mal hecho nunca»).
 *
 * En una venta con vales NO se usa un descuento con tope de usos (total `maxTotalUses` o por clienta `maxUsesPerCustomer`). Contar esos
 * usos en la vida de un vale (emitir → reclamar → juntar → cancelar → rearmar → vencer → cobro tardío) no convergió en cuatro rondas de
 * Codex (r4/r5 de na24531d, r1/r2 de D11: 7, 10, 10, 10 bloqueantes), porque el contador ya es laxo en todo Avoqado (tarjeta D19).
 * Prohibir la entrada es lo que no deja hueco: si ningún descuento con tope entra a un renglón de vale ni a un suelto de la venta de
 * vales, no hay uso que contar por ellos. Medido el 18-nov: un solo negocio usa vales (ruta EXTERNAL) y ningún vale llevó descuento.
 *
 * Se revisa con una lectura PROPIA del catálogo, ANTES de `buildOrderItemsData` (antes de `validateDiscountActive`: un descuento ya
 * agotado recibe este texto y no el viejo en inglés) y antes de escribir nada (vale, orden, folio, inventario). Cuenta cualquier
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

export async function rechazarDescuentosConTopeEnVales(
  venueId: string,
  discountIds: ReadonlyArray<string | null | undefined>,
  donde: 'VALE' | 'CAJA',
): Promise<void> {
  const ids = [...new Set(discountIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return
  const filas = await prisma.discount.findMany({
    where: { venueId, id: { in: ids }, OR: [{ maxTotalUses: { not: null } }, { maxUsesPerCustomer: { not: null } }] },
    select: { name: true, maxTotalUses: true, maxUsesPerCustomer: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: ids.length,
  })
  // La consulta ya filtra; se vuelve a mirar cada fila para que la regla viva en un solo lugar legible (y no dependa del filtro).
  const conTope = filas.find(d => d.maxTotalUses != null || d.maxUsesPerCustomer != null)
  if (conTope) {
    const texto = donde === 'VALE' ? textoDescuentoConTopeEnElVale(conTope.name) : textoDescuentoConTopeEnLaCaja(conTope.name)
    throw new BadRequestError(texto, CODIGO_DESCUENTO_CON_TOPE_EN_VALES)
  }
}
