import { NextFunction, Request, Response } from 'express'

import { BadRequestError, ForbiddenError } from '../../errors/AppError'
import { readDeviceIdentityFromRequest } from '../../middlewares/registerDevice.middleware'
import { cotizarParaLaMaquina } from '../../services/cashMachine/cotizacionDeLaMaquina'
import { desemparejarAparato, emparejarAparato } from '../../services/cashMachine/emparejamiento'
import {
  consultarDudaDeLaMaquina,
  listarDudasDeLaMaquina,
  resolverDudaDeLaMaquina,
  revisarIncidenciaDeLaMaquina,
  subirDudaDeLaMaquina,
} from '../../services/cashMachine/dudasDeLaMaquina'
import { turnoDelNegocioAhora } from '../../services/shared/turnoDeCaja'
import {
  consultarVentaDeLaMaquina,
  pedidoConDescuento,
  registrarVentaDeLaMaquina,
  type AutorDeLaMaquina,
} from '../../services/cashMachine/ventaDeLaMaquina'
import type { CreateOrderInput } from '../../services/mobile/order.mobile.service'
import { autoridadDeLaVenta, leerVentaDeMostrador } from './order.mobile.controller'

/** La credencial del emparejamiento (R4-3): un encabezado, nunca el cuerpo. Recortada como los demás encabezados del aparato. */
function credencialDe(req: Request): string | null {
  const valor = req.headers['x-cash-machine-credential']
  const texto = (Array.isArray(valor) ? valor[0] : valor)?.trim().slice(0, 128)
  return texto || null
}

function autorDe(req: Request): AutorDeLaMaquina {
  return {
    userId: req.authContext!.userId,
    deviceUid: readDeviceIdentityFromRequest(req)?.deviceUid ?? null,
    credencial: credencialDe(req),
  }
}

/**
 * El carrito de la máquina leído como `POST /orders`, con la autoridad de ESTA sesión. `usuario`: el vendedor si el carrito no trae uno.
 * Sin permiso de cortesía la venta no se arma (el servicio lo rechaza dentro): el dinero queda como incidencia, nunca un 403.
 */
async function armarVentaDeLaMaquina(req: Request, pedido: unknown, venueId: string, usuario: string): Promise<CreateOrderInput> {
  const leida = leerVentaDeMostrador(pedido, { conPropinaDeOrden: false, venueId, usuario })
  if ('error' in leida) throw new BadRequestError(leida.error)
  const autoridad = await autoridadDeLaVenta(req, leida.input).catch(error => {
    if (error instanceof ForbiddenError) return {}
    throw error
  })
  return { ...leida.input, ...autoridad }
}

/**
 * `POST /api/v1/mobile/venues/:venueId/cash-machine/sales` — una operación de la máquina de efectivo (R4-1). 200 con la evidencia
 * (también la repetición), 202 `{ incident: 'NO_SE_PUDO_REGISTRAR' }` si la venta ya no se puede armar, 409 y 422 con incidencia.
 */
export async function registrarVenta(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const autor = autorDe(req)
    const { referenceCC, cierre, pedido } = req.body
    const venta = pedido ? await armarVentaDeLaMaquina(req, pedido, venueId, autor.userId) : undefined
    const resultado = await registrarVentaDeLaMaquina(venueId, autor, { referenceCC, cierre, pedido: venta })
    res.status(resultado.status).json({ success: true, ...resultado.body })
  } catch (error) {
    next(error)
  }
}

/** `GET /api/v1/mobile/venues/:venueId/cash-machine/sales/:referenceCC` — la MISMA respuesta que el POST (200 o el 202 estable). */
export async function consultarVenta(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, referenceCC } = req.params
    const resultado = await consultarVentaDeLaMaquina(venueId, referenceCC)
    res.status(resultado.status).json({ success: true, ...resultado.body })
  } catch (error) {
    next(error)
  }
}

/**
 * `POST /api/v1/mobile/venues/:venueId/cash-machine/binding` (R4-3, R5#3) — `cash-machine:configure`. Esta PC (la del `X-Device-ID`)
 * queda como el único emisor de la máquina `machineIp`. 201 `{ bindingId, credential }`: la credencial sale SÓLO aquí (la PC la guarda
 * con DPAPI y la manda en `X-Cash-Machine-Credential`).
 */
export async function emparejar(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, deviceUid } = autorDe(req)
    const emparejado = await emparejarAparato(req.params.venueId, { userId, deviceUid }, req.body.machineIp)
    res.set('Cache-Control', 'no-store')
    res.status(201).json({ success: true, ...emparejado })
  } catch (error) {
    next(error)
  }
}

/** `DELETE /api/v1/mobile/venues/:venueId/cash-machine/binding` — `cash-machine:configure`. Esta PC deja de ser emisor. */
export async function desemparejar(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, deviceUid } = autorDe(req)
    res.status(200).json({ success: true, ...(await desemparejarAparato(req.params.venueId, { userId, deviceUid })) })
  } catch (error) {
    next(error)
  }
}

/**
 * `POST /api/v1/mobile/venues/:venueId/cash-machine/quote` (R4-2) — `payments:create`. El cuerpo es el de `POST /orders`; se lee igual
 * y se cotiza EN LÍNEA sin escribir nada. Un carrito con descuento ni siquiera pide permisos: la fase 1a no lo cobra en la máquina
 * (decisión a del founder), así que contesta `DESCUENTO` sin gastar un PIN.
 */
export async function cotizar(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const leida = leerVentaDeMostrador(req.body, { conPropinaDeOrden: true, venueId, usuario: req.authContext!.userId })
    if ('error' in leida) throw new BadRequestError(leida.error)
    // La cotización es en línea por definición: una marca de cola en el cuerpo no relaja precios.
    const input: CreateOrderInput = { ...leida.input, isOfflineReplay: false }
    // R5#4: el premio de sellos se aplica DESPUÉS de crear la cuenta; con él pendiente, la máquina no cobra.
    const premioPendiente = typeof req.body?.stampRewardId === 'string' && req.body.stampRewardId.length > 0
    const autoridad = premioPendiente || pedidoConDescuento(input) ? {} : await autoridadDeLaVenta(req, input)
    const cotizacion = await cotizarParaLaMaquina(venueId, { ...input, ...autoridad }, { premioPendiente, carrito: req.body })
    res.status(200).json({ success: true, ...cotizacion })
  } catch (error) {
    next(error)
  }
}

/**
 * `POST /api/v1/mobile/venues/:venueId/cash-machine/doubts` (R4-4, R5#6) — `payments:create` y la PC emparejada. La PC no sabe cómo
 * terminó una operación: sube la duda con su carrito congelado. 200 `{ status: 'ABIERTO' }`, o la evidencia si el folio ya se cerró.
 */
export async function subirDuda(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const autor = autorDe(req)
    // El carrito se valida AHORA, con la misma lectura que la venta: la resolución lo arma después tal cual.
    const leida = leerVentaDeMostrador(req.body.pedido, { conPropinaDeOrden: false, venueId, usuario: autor.userId })
    if ('error' in leida) throw new BadRequestError(leida.error)
    res.status(200).json({ success: true, ...(await subirDudaDeLaMaquina(venueId, autor, req.body)) })
  } catch (error) {
    next(error)
  }
}

/** `GET /api/v1/mobile/venues/:venueId/cash-machine/doubts/:referenceCC` — `payments:read`. Lo que la PC consulta cada 60 s. */
export async function consultarDuda(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, referenceCC } = req.params
    res.status(200).json({ success: true, ...(await consultarDudaDeLaMaquina(venueId, referenceCC)) })
  } catch (error) {
    next(error)
  }
}

/**
 * `GET /api/v1/{mobile|dashboard}/venues/:venueId/cash-machine/doubts` — `cash-machine:resolve`. Todas las incidencias de la máquina
 * (cada una con su `kind`), acotada: `{ data, total, nextCursor }`. ?status&kind&folio&cursor&limit.
 */
export async function listarDudas(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, kind, folio, cursor, limit } = req.query as {
      status?: 'ABIERTO' | 'RESUELTO'
      kind?: string
      folio?: string
      cursor?: string
      limit?: number
    }
    res.status(200).json({ success: true, ...(await listarDudasDeLaMaquina(req.params.venueId, { status, kind, folio, cursor, limit })) })
  } catch (error) {
    next(error)
  }
}

/**
 * `POST /api/v1/{mobile|dashboard}/venues/:venueId/cash-machine/doubts/:referenceCC/resolve` — `cash-machine:resolve`. El gerente es
 * el de la sesión (nunca del cuerpo); con `PAGADO` el carrito congelado se lee como `POST /orders` con su autoridad. Responde como la
 * venta: 200 con la evidencia, 202 si la venta ya no se arma, 409 y 422 con incidencia.
 */
export async function resolverDuda(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, referenceCC } = req.params
    const { outcome, creditCents, changeDispensedCents, occurredAt, evidence } = req.body
    const resultado = await resolverDudaDeLaMaquina(
      venueId,
      req.authContext!.userId,
      referenceCC,
      { outcome, creditCents, changeDispensedCents, occurredAt, evidence },
      (pedido, subidoPor) => armarVentaDeLaMaquina(req, pedido, venueId, subidoPor),
    )
    res.status(resultado.status).json({ success: true, ...resultado.body })
  } catch (error) {
    next(error)
  }
}

/**
 * `POST /api/v1/{mobile|dashboard}/venues/:venueId/cash-machine/incidents/:incidentId/review` — `cash-machine:resolve` (Codex r1 #7).
 * El gerente da por revisada una incidencia que no es duda, con una nota. El gerente es el de la sesión.
 */
export async function revisarIncidencia(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, incidentId } = req.params
    res
      .status(200)
      .json({ success: true, ...(await revisarIncidenciaDeLaMaquina(venueId, req.authContext!.userId, incidentId, req.body.note)) })
  } catch (error) {
    next(error)
  }
}

/**
 * `GET /api/v1/mobile/venues/:venueId/shifts/business-current` — `shifts:read` (R3#8, Codex r1 #13). El turno vivo del NEGOCIO para la
 * PC de la máquina, que no tiene gaveta: el contrato del plan, tal cual — `{ shiftId, startTime }` o `null` —.
 */
export async function turnoDelNegocio(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await turnoDelNegocioAhora(req.params.venueId))
  } catch (error) {
    next(error)
  }
}
