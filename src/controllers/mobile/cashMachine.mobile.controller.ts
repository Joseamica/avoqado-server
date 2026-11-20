import { NextFunction, Request, Response } from 'express'

import { BadRequestError, ForbiddenError } from '../../errors/AppError'
import { readDeviceIdentityFromRequest } from '../../middlewares/registerDevice.middleware'
import {
  consultarVentaDeLaMaquina,
  exigirAparatoEmparejado,
  registrarVentaDeLaMaquina,
  type AutorDeLaMaquina,
} from '../../services/cashMachine/ventaDeLaMaquina'
import type { CreateOrderInput } from '../../services/mobile/order.mobile.service'
import { autoridadDeLaVenta, leerVentaDeMostrador } from './order.mobile.controller'

function autorDe(req: Request): AutorDeLaMaquina {
  return { userId: req.authContext!.userId, deviceUid: readDeviceIdentityFromRequest(req)?.deviceUid ?? null }
}

/**
 * `POST /api/v1/mobile/venues/:venueId/cash-machine/sales` — una operación de la máquina de efectivo (R4-1). 200 con la evidencia
 * (también la repetición), 202 `{ incident: 'NO_SE_PUDO_REGISTRAR' }` si la venta ya no se puede armar, 409 y 422 con incidencia.
 */
export async function registrarVenta(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const autor = autorDe(req)
    await exigirAparatoEmparejado(venueId, autor)
    const { referenceCC, cierre, pedido } = req.body
    let venta: CreateOrderInput | undefined
    if (pedido) {
      const leida = leerVentaDeMostrador(pedido, { conPropinaDeOrden: false, venueId, usuario: autor.userId })
      if ('error' in leida) throw new BadRequestError(leida.error)
      // Sin permiso de cortesía la venta no se arma (el servicio lo rechaza dentro): el dinero queda como incidencia, nunca un 403.
      const autoridad = await autoridadDeLaVenta(req, leida.input).catch(error => {
        if (error instanceof ForbiddenError) return {}
        throw error
      })
      venta = { ...leida.input, ...autoridad }
    }
    const resultado = await registrarVentaDeLaMaquina(venueId, autor, { referenceCC, cierre, pedido: venta })
    res.status(resultado.status).json({ success: true, ...resultado.body })
  } catch (error) {
    next(error)
  }
}

/** `GET /api/v1/mobile/venues/:venueId/cash-machine/sales/:referenceCC` — la MISMA evidencia que el POST. */
export async function consultarVenta(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, referenceCC } = req.params
    res.status(200).json({ success: true, ...(await consultarVentaDeLaMaquina(venueId, referenceCC)) })
  } catch (error) {
    next(error)
  }
}
