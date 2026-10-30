/**
 * Tarjetas de regalo — lo que el POS y el dashboard comparten: los ajustes (con el estado de VENTA, para que el botón diga
 * por qué está apagado) y cancelar la venta de una tarjeta (B2). Delgado: el esquema ya validó; aquí se llama al servicio
 * y se responde `{ success, data }`. La bitácora de cancelar y liberar la escribe B2 (`GIFT_CARD_SALE_CANCEL_STARTED` /
 * `…_RELEASED`): no se repite aquí.
 */
import type { Request, Response } from 'express'
import { getGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'
import { iniciarCancelacionDeVenta, liberarCancelacionDeVenta } from '@/services/giftCards/giftCardCancel.service'
import { CAPACIDADES_DEL_POS, estadoDeVentaDeTarjetas, negocioHaActivadoTarjetas } from '@/services/giftCards/giftCardSurface.service'
import { staffDe } from '@/utils/giftCardRequest'

/** 1b S1: `capacidades` y `tieneTarjetas` son aditivos; lo de la 1a no cambia. */
export async function getSettings(req: Request, res: Response) {
  const { venueId } = req.params
  const [settings, sale, tieneTarjetas] = await Promise.all([
    getGiftCardSettings(venueId),
    estadoDeVentaDeTarjetas(venueId),
    negocioHaActivadoTarjetas(venueId),
  ])
  res.json({ success: true, data: { ...settings, sale, capacidades: [...CAPACIDADES_DEL_POS], tieneTarjetas } })
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
