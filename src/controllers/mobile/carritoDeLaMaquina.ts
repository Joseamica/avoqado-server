import type { Request } from 'express'

import { BadRequestError, ForbiddenError } from '../../errors/AppError'
import { motivoSinVentaDelPedido } from '../../services/cashMachine/ventaDeLaMaquina'
import type { CreateOrderInput } from '../../services/mobile/order.mobile.service'
import { autoridadDeLaVenta, leerVentaDeMostrador } from './order.mobile.controller'

/**
 * Máquina de efectivo · Codex servidor r2 #11 (familia C): EL lector del carrito de la máquina. Lo usan la cotización y quien TERMINA
 * un folio (la venta de la PC, su duda o la resolución del gerente, siempre con el carrito congelado), así que un carrito que la
 * cotización excluye también queda excluido al registrarlo:
 *
 *  · Se lee como `POST /orders` (`leerVentaDeMostrador`), con `conPropinaDeOrden` sólo en la cotización (la venta lleva su propina en el
 *    cierre, R3#6).
 *  · 🔴 Conserva la señal del premio de sellos PENDIENTE: la venta de mostrador lo vuelve `null` si la caja no declara
 *    `stampRewardAware`, y así un carrito excluido al cotizar se volvía venta a precio completo al subir (R5#4). Aquí `stampRewardId`
 *    queda con el premio, y `motivoSinVentaDelPedido` lo convierte en 202 `PREMIO_PENDIENTE`.
 *  · `conAutoridad`: lo que la venta toma de la SESIÓN (`autoridadDeLaVenta`). Con premio o descuento no hace falta (la máquina no lo
 *    cobra) y no se gasta un PIN; sin permiso de cortesía la venta no se arma dentro del servicio (el dinero queda como incidencia).
 */
export async function leerCarritoDeLaMaquina(
  req: Request,
  carrito: unknown,
  opciones: { venueId: string; usuario: string; conPropinaDeOrden: boolean; conAutoridad: boolean },
): Promise<{ input: CreateOrderInput }> {
  const leida = leerVentaDeMostrador(carrito, {
    conPropinaDeOrden: opciones.conPropinaDeOrden,
    venueId: opciones.venueId,
    usuario: opciones.usuario,
  })
  if ('error' in leida) throw new BadRequestError(leida.error)
  const premio = (carrito as { stampRewardId?: unknown } | null)?.stampRewardId
  const input: CreateOrderInput = {
    ...leida.input,
    stampRewardId: typeof premio === 'string' && premio.length > 0 ? premio : (leida.input.stampRewardId ?? null),
  }
  if (!opciones.conAutoridad || motivoSinVentaDelPedido(input)) return { input }
  const autoridad = await autoridadDeLaVenta(req, input).catch(error => {
    if (error instanceof ForbiddenError) return {}
    throw error
  })
  return { input: { ...input, ...autoridad } }
}
