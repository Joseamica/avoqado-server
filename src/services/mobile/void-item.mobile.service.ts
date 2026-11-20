/**
 * «Anular producto» en la cuenta de MESA del POS (ANDROID y WINDOWS; Flautas Coyoacán, 20-nov-2026).
 *
 * Square: lo enviado no se borra, sólo se da de cortesía o se anula. Esto es la anulación de UN renglón, aunque ya esté en cocina.
 * Reusa `voidItems` de la TPV (candados, dinero, bitácora, socket); aquí sólo lo que cambia en la mesa del POS:
 * - el autor es la sesión (hz:87f4b879:D1), no un vendedor del cuerpo;
 * - como la cortesía, nada sobre una cuenta con pagos (`soloSinCobros`);
 * - el último renglón no se anula (`sinCancelarLaCuenta`): eso cancela la cuenta y aquí no se suelta la mesa.
 * Las dos guardas corren bajo el candado de la cuenta, dentro de `voidItems`.
 * Y dos de alcance, que no cambian después (Codex r1 #2 y #4): sólo cuentas de MESA, y nunca una pieza suelta de una promoción
 * (dejaría las demás a precio de combo y la promoción guardada describiendo otra compra).
 */
import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { voidItems } from '../tpv/order.tpv.service'

export const VOID_ITEM_NOT_TABLE = 'ORDER_ITEM_VOID_NOT_TABLE'
export const VOID_ITEM_PROMOTION = 'ORDER_ITEM_VOID_PROMOTION'
/** El mismo texto que pone en gris el POS (`PROMOCION_SIN_ANULAR` de ANDROID). */
export const PROMOCION_NO_SE_ANULA_SUELTA =
  'Es parte de una promoción y no se anula suelto. Puedes darlo de cortesía o anular la cuenta completa.'

export async function voidOrderItem(params: {
  venueId: string
  orderId: string
  itemId: string
  reason: string
  actorId: string
  expectedVersion?: number
}) {
  const reason = params.reason?.trim()
  if (!reason) throw new BadRequestError('Elige el motivo para anular el producto')

  // Lectura previa sólo para hablar en español (lo de `voidItems` sale en inglés para las TPV viejas). Lo que cuenta se vuelve a
  // revisar bajo el candado.
  const order = await prisma.order.findFirst({
    where: { id: params.orderId, venueId: params.venueId },
    select: { version: true, tableId: true, items: { where: { id: params.itemId }, select: { id: true, orderPromotionId: true } } },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')
  if (!order.tableId) throw new BadRequestError('Así sólo se anulan productos de una cuenta de mesa.', VOID_ITEM_NOT_TABLE)
  const [item] = order.items
  if (!item) throw new NotFoundError('Ese producto ya no está en la cuenta. Vuelve a abrirla.')
  if (item.orderPromotionId) throw new BadRequestError(PROMOCION_NO_SE_ANULA_SUELTA, VOID_ITEM_PROMOTION)

  const updated = await voidItems(params.venueId, params.orderId, {
    itemIds: [params.itemId],
    reason,
    staffId: params.actorId,
    actorId: params.actorId,
    // ponytail: sin versión del cliente, la de esta lectura; un cambio en el medio da 409 y se reintenta.
    expectedVersion: params.expectedVersion ?? order.version,
    soloSinCobros: true,
    sinCancelarLaCuenta: true,
  })

  return {
    id: updated.id,
    itemId: params.itemId,
    reason,
    version: updated.version,
    subtotal: Number(updated.subtotal),
    total: Number(updated.total),
    remainingBalance: Number(updated.remainingBalance),
  }
}
