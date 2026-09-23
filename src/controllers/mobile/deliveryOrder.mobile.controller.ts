/**
 * Aceptar o rechazar un pedido de marketplace desde el punto de venta.
 *
 * Vive en el namespace `/mobile` porque quien decide es la COCINA, y la cocina está en la
 * tablet o en la terminal, no en la computadora de la oficina.
 */
import type { NextFunction, Request, Response } from 'express'

import {
  acceptDeliveryOrder,
  denyDeliveryOrder,
  type MotivoRechazo,
  type RespuestaPedido,
} from '@/services/delivery-channels/core/respondToDeliveryOrder.service'

const MOTIVOS: MotivoRechazo[] = ['OUT_OF_ITEMS', 'STORE_CLOSED', 'TOO_BUSY', 'OTHER']

const OPERACION_EN_CURSO: Record<string, string> = {
  REMOVE_ITEM: 'se está retirando un artículo',
  READY: 'se está marcando listo',
  DENY: 'se está rechazando el pedido',
  ACCEPT: 'se está aceptando el pedido',
}

/**
 * Spec §3.2: otra salida a Uber tiene tomado el pedido. 409 con código propio — una app vieja
 * lo ve como error genérico y reintenta después, que es exactamente lo correcto.
 */
function respuestaDeReserva(res: Response, r: RespuestaPedido) {
  if (r.outcome === 'OP_IN_PROGRESS') {
    const que = (r.ocupadaPor && OPERACION_EN_CURSO[r.ocupadaPor]) || 'hay otra operación en curso sobre este pedido'
    return res.status(409).json({ ok: false, code: 'DELIVERY_OP_IN_PROGRESS', error: `Espera: ${que}. Intenta en un momento.` })
  }
  if (r.outcome === 'LINE_ACTION_IN_PROGRESS') {
    return res.status(409).json({
      ok: false,
      code: 'LINE_ACTION_IN_PROGRESS',
      error: 'Espera: se está retirando un artículo de este pedido. Intenta cuando termine.',
    })
  }
  return null
}

export const acceptOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { userId } = (req as any).authContext
    const r = await acceptDeliveryOrder(venueId, orderId, userId)

    if (r.outcome === 'NOT_A_DELIVERY_ORDER') {
      return res.status(404).json({ ok: false, error: 'Este pedido no viene de una app de delivery.' })
    }
    const ocupado = respuestaDeReserva(res, r)
    if (ocupado) return ocupado
    if (r.outcome === 'FAILED') {
      // El plazo vencido NO es un error del staff ni algo que reintentar: el proveedor ya
      // canceló. Se distingue para que la app pueda decirlo con esas palabras en vez de
      // mostrar un error genérico que invita a picarle otra vez.
      const vencido = r.error === 'PEDIDO_YA_NO_ACTIVO'
      return res.status(vencido ? 409 : 502).json({
        ok: false,
        code: r.error,
        error: vencido
          ? 'El pedido ya no está activo: la app de delivery lo canceló por tiempo. No hace falta reintentar.'
          : 'No se pudo confirmar el pedido con la app de delivery. Intenta de nuevo.',
      })
    }
    return res.json({ ok: true, outcome: r.outcome })
  } catch (e) {
    return next(e)
  }
}

export const denyOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { userId } = (req as any).authContext
    const motivo = MOTIVOS.includes(req.body?.reason) ? (req.body.reason as MotivoRechazo) : 'OUT_OF_ITEMS'

    const r = await denyDeliveryOrder(venueId, orderId, motivo, userId)

    if (r.outcome === 'NOT_A_DELIVERY_ORDER') {
      return res.status(404).json({ ok: false, error: 'Este pedido no viene de una app de delivery.' })
    }
    const ocupado = respuestaDeReserva(res, r)
    if (ocupado) return ocupado
    if (r.outcome === 'FAILED') {
      return res.status(502).json({ ok: false, code: r.error, error: 'No se pudo avisarle a la app de delivery. Intenta de nuevo.' })
    }
    // `CANCELLED` y `DENIED` son resultados distintos a propósito: el primero significa que
    // el pedido ya estaba aceptado y el cliente ya estaba esperando. La app puede usarlo para
    // decir algo distinto en pantalla.
    return res.json({ ok: true, outcome: r.outcome })
  } catch (e) {
    return next(e)
  }
}
