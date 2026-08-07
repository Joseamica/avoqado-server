import { Request, Response } from 'express'
import * as orderMobileService from '../../services/mobile/order.mobile.service'
import * as serviceChargeMobileService from '../../services/mobile/service-charge.mobile.service'
import logger from '../../config/logger'

/**
 * Ciclo de orden de mesa bajo `/tpv` (Plan B Task 4, 2026-07-27).
 *
 * Los 4 handlers de este archivo son wrappers delgados sobre los MISMOS servicios
 * puros que usa `/mobile` (`order.mobile.service.ts` / `service-charge.mobile.service.ts`):
 * reciben `(venueId, orderId, …, staffId?)` y no tocan `req`/`authContext`, así que
 * no hay lógica que extraer ni duplicar — solo leer el input y delegar. Reusarlos
 * desde acá deja `/mobile` byte-idéntico (iOS/Android se desarrollan en paralelo
 * contra ese contrato en otras sesiones).
 *
 * `openTable` (POST tables/:tableId/open) NO vive en este archivo: es un
 * re-export del controller de `/mobile` en `table.tpv.controller.ts` (mismo
 * patrón que Task 3 con el reducer de sync) — ver ese archivo.
 *
 * El `staffId` SIEMPRE sale de `authContext.userId` (el token), nunca del body:
 * si saliera del body, cualquiera podría atribuirle a otro mesero una división
 * de cuenta o un cobro aplicado.
 *
 * Los servicios YA escriben su propio `ActivityLog` (`ORDER_SPLIT`,
 * `ORDER_SPLIT_BY_SEAT`, `ORDER_SERVICE_CHARGE_APPLIED`; `mergeOrders` audita vía
 * el mismo mecanismo) — no se agrega una segunda capa de auditoría aquí.
 */

/**
 * POST /tpv/venues/:venueId/orders/:orderId/split
 * "Separar cuenta": mueve los artículos seleccionados a una cuenta NUEVA en la
 * misma mesa. La cuenta origen conserva el resto. Body: { itemIds: string[] }
 *
 * Sin validación de forma acá: `splitOrderItems` ya rechaza `itemIds` ausente o
 * vacío con `BadRequestError('itemIds es requerido')` — duplicar el guard solo
 * arriesga que los dos mensajes diverjan.
 */
export async function splitOrder(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { itemIds } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined

    const result = await orderMobileService.splitOrderItems(venueId, orderId, itemIds, staffId)

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER-TABLE TPV] split: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

/**
 * POST /tpv/venues/:venueId/orders/:orderId/split-by-seat
 * "Dividir por puesto": un cheque por asiento, atómico. Sin body — el servicio
 * agrupa los items existentes por `seat`.
 */
export async function splitOrderBySeat(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const staffId = (req as any).authContext?.userId as string | undefined

    const result = await orderMobileService.splitOrderBySeat(venueId, orderId, staffId)

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER-TABLE TPV] split-by-seat: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

/**
 * POST /tpv/venues/:venueId/orders/:orderId/merge
 * "Fusionar cuentas": vuelca los artículos de `sourceOrderId` en esta cuenta y
 * cancela el origen. Body: { sourceOrderId: string }
 *
 * 🔴 `sourceOrderId` SE VALIDA ACÁ, antes de llamar al servicio: si llegara
 * `undefined`, `prisma.order.findFirst({ where: { id: undefined, venueId } })`
 * DESCARTA la clave `id` (Prisma omite valores `undefined` del `where`) y
 * matchearía la PRIMERA orden que encuentre en el venue — fusionaría cuentas al
 * azar. `/mobile` ya trae este mismo guard (en inglés); acá en español por la
 * regla del repo de mensajes de validación.
 */
export async function mergeOrders(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { sourceOrderId } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined

    if (!sourceOrderId || typeof sourceOrderId !== 'string') {
      res.status(400).json({ success: false, message: 'sourceOrderId es requerido' })
      return
    }

    const result = await orderMobileService.mergeOrders(venueId, orderId, sourceOrderId, staffId)

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER-TABLE TPV] merge: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

/**
 * POST /tpv/venues/:venueId/orders/:orderId/service-charges
 * Aplica un cobro por servicio del catálogo (propina automática por comensales,
 * descorche, etc.) a la cuenta abierta — SUMA al total, es ingreso gravable del
 * negocio (no confundir con propina ni descuento). Body: { serviceChargeId: string }
 *
 * 🔴 Mismo guard que `mergeOrders`: `serviceChargeId` undefined haría que
 * `prisma.serviceCharge.findFirst({ where: { id: undefined, venueId, active: true } })`
 * matcheara el primer cobro activo del venue en vez de rechazar la solicitud.
 */
export async function applyServiceCharge(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { serviceChargeId } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined

    if (!serviceChargeId || typeof serviceChargeId !== 'string') {
      res.status(400).json({ success: false, message: 'serviceChargeId es requerido' })
      return
    }

    const result = await serviceChargeMobileService.applyServiceCharge(venueId, orderId, serviceChargeId, staffId)

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER-TABLE TPV] service-charges: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

/**
 * DELETE /tpv/venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId
 *
 * Quita un cobro por servicio YA aplicado. Cierra el hueco de paridad con Android
 * (`avoqado-tpv/.superpowers/.../paridad-android-tpv.md` hallazgo #4, 2026-08-06):
 * el servicio existía (`service-charge.mobile.service.ts::removeServiceCharge`)
 * pero la ruta DELETE solo estaba montada bajo `/mobile` — la TPV, aislada a
 * `/tpv`, no tenía cómo llamarla y su checkout quedó sin "quitar cargo".
 *
 * DESHACER es online-only A PROPÓSITO (regla offline §5): aplicar un cargo se
 * puede encolar; quitarlo no. Por eso NO hay intent `REMOVE_SERVICE_CHARGE` en
 * el reducer — esta ruta es el único camino, y sin red el cliente lo dice en
 * vez de encolar.
 *
 * El id viene en el PATH (no body), así que no aplica el guard de undefined de
 * `applyServiceCharge`: el servicio hace findFirst por [id, orderId] y rechaza
 * si no existe. El actor sale del token, nunca del body.
 */
export async function removeServiceCharge(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId, orderServiceChargeId } = req.params
    const staffId = (req as any).authContext?.userId as string | undefined

    const result = await serviceChargeMobileService.removeServiceCharge(venueId, orderId, orderServiceChargeId, staffId)

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER-TABLE TPV] remove service-charge: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

/**
 * GET /tpv/venues/:venueId/service-charges
 *
 * 🆕 Companion de lectura de `applyServiceCharge` (arriba, Plan B Task 4) — esa
 * ruta existía sin NINGÚN caller bajo `/tpv` desde antes de "Plan C" (el módulo
 * Mesas de avoqado-tpv), exactamente el patrón de código muerto que motivó
 * `completeness-audit.md`. A diferencia de `discounts/available`
 * (`discount.tpv.controller.ts`), que YA existía como lectura filtrada por
 * elegibilidad de UNA cuenta, nunca hubo un equivalente para cargos por
 * servicio bajo `/tpv` — el único catálogo reachable era
 * `GET /mobile/venues/:venueId/service-charges` (`service-charge.mobile.controller.ts`),
 * fuera de alcance para la TPV (regla dura: "La TPV habla solo con /api/v1/tpv").
 *
 * Catálogo del VENUE (activos), NO filtrado por esta orden — `applyServiceCharge`
 * ya rechaza (400) un cargo duplicado o una orden ya pagada, así que el picker no
 * necesita repetir esa validación aquí, solo mostrar las opciones.
 */
export async function listServiceCharges(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params

    const data = await serviceChargeMobileService.listServiceCharges(venueId)

    res.status(200).json({ success: true, data })
  } catch (error: any) {
    logger.error(`[ORDER-TABLE TPV] service-charges (list): ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}
