/**
 * Aceptar o rechazar un pedido de marketplace desde el punto de venta.
 *
 * Vive en el namespace `/mobile` porque quien decide es la COCINA, y la cocina está en la
 * tablet o en la terminal, no en la computadora de la oficina.
 */
import type { NextFunction, Request, Response } from 'express'
import { DeliveryWriteNotSentError } from '../../services/delivery-channels/core/types'

import logger from '@/config/logger'
import {
  acceptDeliveryOrder,
  denyDeliveryOrder,
  proveedorDeLaOrden,
  type MotivoRechazo,
  type RespuestaPedido,
} from '@/services/delivery-channels/core/respondToDeliveryOrder.service'

const MOTIVOS: MotivoRechazo[] = ['OUT_OF_ITEMS', 'STORE_CLOSED', 'TOO_BUSY', 'OTHER']

export const OPERACION_EN_CURSO: Record<string, string> = {
  REMOVE_ITEM: 'se está retirando un artículo',
  READY: 'se está marcando listo',
  DENY: 'se está rechazando el pedido',
  ACCEPT: 'se está aceptando el pedido',
}

/**
 * 🔴 D1: las apps de la cocina muestran `message` cuando una llamada falla; con sólo `error` el mesero veía un texto
 * genérico en vez de la razón. TODA respuesta de error de este archivo sale por aquí: `message` es igual a `error`.
 * Aditivo — `error` se queda porque las apps viejas lo leen.
 */
function responderError(res: Response, status: number, cuerpo: { code?: string; error: string }) {
  return res.status(status).json({ ok: false, ...cuerpo, message: cuerpo.error })
}

/**
 * Nombre visible de la app de delivery en los textos al personal. Vive aquí y no en `core/` a propósito: el núcleo no
 * ramifica por proveedor (lo vigila `adapterRegistry.test.ts`). Un proveedor sin nombre aquí, o un pedido del que no se
 * pudo leer el proveedor, usa una palabra neutra — nunca el nombre de otra app.
 */
const NOMBRE_DE_LA_APP: Readonly<Record<string, string>> = { UBER_EATS: 'Uber Eats', RAPPI: 'Rappi' }
const NOMBRE_NEUTRO_DE_LA_APP = 'La app de delivery'

/**
 * Spec §3.2: otra salida a Uber tiene tomado el pedido. 409 con código propio — una app vieja
 * lo ve como error genérico y reintenta después, que es exactamente lo correcto.
 */
function respuestaDeReserva(res: Response, r: RespuestaPedido) {
  if (r.outcome === 'OP_IN_PROGRESS') {
    const que = (r.ocupadaPor && OPERACION_EN_CURSO[r.ocupadaPor]) || 'hay otra operación en curso sobre este pedido'
    return responderError(res, 409, { code: 'DELIVERY_OP_IN_PROGRESS', error: `Espera: ${que}. Intenta en un momento.` })
  }
  if (r.outcome === 'LINE_ACTION_IN_PROGRESS') {
    return responderError(res, 409, {
      code: 'LINE_ACTION_IN_PROGRESS',
      error: 'Espera: se está retirando un artículo de este pedido. Intenta cuando termine.',
    })
  }
  return null
}

/**
 * La app de delivery DEL PEDIDO, para nombrarla en el texto. Si no se puede leer (la base falla, el pedido ya no está) se
 * contesta igual con la palabra neutra: un fallo al buscar el nombre nunca debe convertir este 409 en un 500.
 */
async function nombreDeLaApp(venueId: string, orderId: string): Promise<string> {
  try {
    const proveedor = await proveedorDeLaOrden(venueId, orderId)
    return (proveedor && NOMBRE_DE_LA_APP[proveedor]) || NOMBRE_NEUTRO_DE_LA_APP
  } catch (e) {
    logger.warn('[Delivery] no se pudo leer el proveedor del pedido para nombrarlo en el aviso de tienda desconectada', {
      orderId,
      error: String(e),
    })
    return NOMBRE_NEUTRO_DE_LA_APP
  }
}

/**
 * Nada llegó a la app de delivery (candado, token o tienda sin consentimiento): se dice con esas
 * palabras en vez de un 500 genérico — la tienda desconectada no se arregla picándole otra vez.
 */
async function respuestaNoEnviado(res: Response, e: unknown, venueId: string, orderId: string) {
  if (!(e instanceof DeliveryWriteNotSentError)) return null
  // Si el proveedor ya trae el texto preciso (`paraLaCocina`) se usa tal cual y no se busca su nombre; si no, el genérico de siempre.
  return e.reason === 'STORE_NOT_AUTHORIZED'
    ? responderError(res, 409, {
        code: 'STORE_NOT_CONNECTED',
        error: e.paraLaCocina || `${await nombreDeLaApp(venueId, orderId)} está desconectada para esta tienda; reconéctala desde el panel.`,
      })
    : responderError(res, 503, {
        code: 'PROVIDER_NOT_CONTACTED',
        error: 'No se pudo contactar a la app de delivery; no se envió nada, intenta de nuevo.',
      })
}

export const acceptOrder = async (req: Request, res: Response, next: NextFunction) => {
  const { venueId, orderId } = req.params
  try {
    const { userId } = (req as any).authContext
    const r = await acceptDeliveryOrder(venueId, orderId, userId)

    if (r.outcome === 'NOT_A_DELIVERY_ORDER') {
      return responderError(res, 404, { error: 'Este pedido no viene de una app de delivery.' })
    }
    const ocupado = respuestaDeReserva(res, r)
    if (ocupado) return ocupado
    if (r.outcome === 'FAILED') {
      // El plazo vencido NO es un error del staff ni algo que reintentar: el proveedor ya
      // canceló. Se distingue para que la app pueda decirlo con esas palabras en vez de
      // mostrar un error genérico que invita a picarle otra vez.
      const vencido = r.error === 'PEDIDO_YA_NO_ACTIVO'
      return responderError(res, vencido ? 409 : 502, {
        code: r.error,
        error: vencido
          ? 'El pedido ya no está activo: la app de delivery lo canceló por tiempo. No hace falta reintentar.'
          : 'No se pudo confirmar el pedido con la app de delivery. Intenta de nuevo.',
      })
    }
    return res.json({ ok: true, outcome: r.outcome })
  } catch (e) {
    return (await respuestaNoEnviado(res, e, venueId, orderId)) ?? next(e)
  }
}

export const denyOrder = async (req: Request, res: Response, next: NextFunction) => {
  const { venueId, orderId } = req.params
  try {
    const { userId } = (req as any).authContext
    const motivo = MOTIVOS.includes(req.body?.reason) ? (req.body.reason as MotivoRechazo) : 'OUT_OF_ITEMS'

    const r = await denyDeliveryOrder(venueId, orderId, motivo, userId)

    if (r.outcome === 'NOT_A_DELIVERY_ORDER') {
      return responderError(res, 404, { error: 'Este pedido no viene de una app de delivery.' })
    }
    const ocupado = respuestaDeReserva(res, r)
    if (ocupado) return ocupado
    if (r.outcome === 'FAILED') {
      return responderError(res, 502, { code: r.error, error: 'No se pudo avisarle a la app de delivery. Intenta de nuevo.' })
    }
    // `CANCELLED` y `DENIED` son resultados distintos a propósito: el primero significa que
    // el pedido ya estaba aceptado y el cliente ya estaba esperando. La app puede usarlo para
    // decir algo distinto en pantalla.
    return res.json({ ok: true, outcome: r.outcome })
  } catch (e) {
    return (await respuestaNoEnviado(res, e, venueId, orderId)) ?? next(e)
  }
}
