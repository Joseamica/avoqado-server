/**
 * Tarjetas de regalo — lo que el POS y el dashboard comparten: los ajustes (con el estado de VENTA, para que el botón diga
 * por qué está apagado) y cancelar la venta de una tarjeta (B2). Delgado: el esquema ya validó; aquí se llama al servicio
 * y se responde `{ success, data }`. La bitácora de cancelar y liberar la escribe B2 (`GIFT_CARD_SALE_CANCEL_STARTED` /
 * `…_RELEASED`): no se repite aquí.
 */
import type { Request, Response } from 'express'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { getGiftCardSettings, updateGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'
import { iniciarCancelacionDeVenta, liberarCancelacionDeVenta } from '@/services/giftCards/giftCardCancel.service'
import {
  CAPACIDADES_DEL_POS,
  estadoDeVentaDeTarjetas,
  estadoParaPrender,
  negocioHaActivadoTarjetas,
} from '@/services/giftCards/giftCardSurface.service'
import { staffDe } from '@/utils/giftCardRequest'

/** 1b S1: `capacidades` y `tieneTarjetas` son aditivos; lo de la 1a no cambia. */
export async function getSettings(req: Request, res: Response) {
  const { venueId } = req.params
  const [settings, sale, tieneTarjetas] = await Promise.all([
    getGiftCardSettings(venueId),
    estadoDeVentaDeTarjetas(venueId),
    negocioHaActivadoTarjetas(venueId),
  ])
  // Aditivo (3-nov-2026): prendidas, va en null para no consultar plan y módulo en cada apertura de la hoja. `puedeEsteUsuario` lo
  // contesta el servidor porque la lista de permisos del POS se toma una vez al entrar y no se refresca sola.
  const prender = settings.enabled
    ? null
    : { ...(await estadoParaPrender(venueId)), puedeEsteUsuario: await tienePermisoEnVenue(req, 'giftCards:enable') }
  res.json({ success: true, data: { ...settings, sale, capacidades: [...CAPACIDADES_DEL_POS], tieneTarjetas, prender } })
}

/**
 * Prender desde el POS (el esquema ya exigió `aceptaTerminos: true`). El servicio serializa y escribe la bitácora, igual que el
 * panel. Si ya estaba prendida no escribe nada: un doble toque no ensucia la bitácora. Responde como el GET, para que el POS
 * guarde lo mismo que guardaría al consultar.
 */
export async function turnOn(req: Request, res: Response) {
  const { enabled } = await getGiftCardSettings(req.params.venueId)
  if (!enabled) await updateGiftCardSettings(req.params.venueId, { enabled: true, aceptaTerminos: true }, staffDe(req))
  await getSettings(req, res)
}

export async function cancelSale(req: Request, res: Response) {
  const { venueId, orderId } = req.params
  const { operationKey } = req.body as { operationKey: string }
  // Sólo `giftCardIds`: el contrato de la ruta no cambia (`bloqueadas` es para quien escribe su propia bitácora, el MCP).
  const { giftCardIds } = await iniciarCancelacionDeVenta(venueId, orderId, { staffId: staffDe(req), operationKey })
  res.json({ success: true, data: { giftCardIds } })
}

/** F6: el esquema ya exigió `confirmacionNoDevuelto: true` (el gerente comprobó que la devolución NO se hizo). */
export async function releaseCancel(req: Request, res: Response) {
  const { venueId, orderId } = req.params
  const { operationKey } = req.body as { operationKey: string; confirmacionNoDevuelto: true }
  await liberarCancelacionDeVenta(venueId, orderId, { staffId: staffDe(req), operationKey, confirmacionNoDevuelto: true })
  res.json({ success: true, data: { released: true } })
}
