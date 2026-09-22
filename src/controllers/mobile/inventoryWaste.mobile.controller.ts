/**
 * Merma desde el POS (avoqado-android · avoqado-ios) — spec §4.3 y §4.4.
 *
 *   GET  /api/v1/mobile/venues/:venueId/inventory/waste-items   → catálogo SIN existencias
 *   POST /api/v1/mobile/venues/:venueId/inventory/waste         → 201 WasteSummary
 *   POST /api/v1/mobile/venues/:venueId/inventory/waste/void    → 200 VoidWasteResult
 *
 * El POST se parte en DOS manejadores porque la recuperación por folio va ANTES de los candados
 * de plan y de permiso (orden de middlewares en `mobile.routes.ts`): una respuesta perdida se
 * recupera aunque entre tanto se revocara el permiso o venciera el plan, pero sólo por quien sigue
 * perteneciendo al venue (`requireVenueMembership` corre antes que los dos).
 */
import { NextFunction, Request, Response } from 'express'
import { ForbiddenError, UnauthorizedError } from '../../errors/AppError'
import {
  logWaste,
  prepareWaste,
  recoverByKey,
  requireWastePermission,
  voidWasteKey,
  WasteInput,
} from '../../services/shared/inventoryWaste.service'
import { listWasteItems, WasteItem } from '../../services/shared/inventoryWasteRead.service'
import { parseWasteSchema, VoidWasteBodySchema, WasteBodySchema, WasteQuerySchema } from '../../schemas/mobile/inventoryWaste.mobile.schema'

/** Quién actúa. `write`: la suplantación es de sólo lectura (el middleware ya la corta; esto es la segunda capa). */
function actor(req: Request, write = false): string {
  if (!req.authContext?.userId) throw new UnauthorizedError()
  if (write && req.authContext.isImpersonating) {
    throw new ForbiddenError('La sesión de suplantación es de solo lectura.')
  }
  return req.authContext.userId
}

/**
 * El cuerpo validado → la entrada del servicio. Los opcionales ausentes (o en `null`) se OMITEN,
 * nunca viajan como `null`: así la huella del folio es la misma con el campo vacío que sin él.
 */
function wasteInput(req: Request): WasteInput {
  const body = parseWasteSchema(WasteBodySchema, req.body)
  return {
    itemType: body.itemType,
    itemId: body.itemId,
    quantity: body.quantity,
    unit: body.unit,
    reasonCode: body.reasonCode,
    idempotencyKey: body.idempotencyKey,
    source: 'POS',
    ...(body.note !== undefined && { note: body.note }),
    ...(body.clientOccurredAt !== undefined && { clientOccurredAt: new Date(body.clientOccurredAt) }),
  }
}

/**
 * Paso 1 del POST: si el folio ya se aplicó para este autor y este mismo cuerpo, devuelve su
 * resumen (201) sin pasar por plan ni permiso. Un folio anulado o de otro autor sale como 409
 * desde aquí. Si el folio no existe, sigue la cadena hacia los candados.
 */
export async function recover(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const staffId = actor(req, true)
    const payload = prepareWaste(staffId, wasteInput(req))
    const report = await recoverByKey(req.params.venueId, payload.idempotencyKey, staffId, payload.payloadHash)
    if (report) {
      res.status(201).json(report)
      return
    }
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Paso 2 del POST, tras plan y permiso: registra la merma. `requireWastePermission` añade lo que
 * `checkPermission` no mira — la activación white-label de inventario y la cuenta activa.
 */
export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const staffId = actor(req, true)
    await requireWastePermission(staffId, req.params.venueId, 'inventory:log-waste')
    res.status(201).json(await logWaste(req.params.venueId, staffId, wasteInput(req)))
  } catch (error) {
    next(error)
  }
}

/**
 * Anula un folio (spec §4.3). Sin candado de plan ni `checkPermission` en la ruta, a propósito
 * (Ruling 12): la autorización la hace `voidWasteKey` — membresía vigente y
 * (`inventory:log-waste` O `inventory:adjust`) — para que perder el plan o el permiso de registrar
 * nunca deje en el aparato un folio imposible de cerrar.
 */
export async function voidKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const staffId = actor(req, true)
    const body = parseWasteSchema(VoidWasteBodySchema, req.body)
    res.json(await voidWasteKey(req.params.venueId, staffId, body.idempotencyKey))
  } catch (error) {
    next(error)
  }
}

/** Sólo los cinco campos del contrato: aunque el lector cambiara, esta ruta nunca entrega existencias ni costos. */
function itemDelCatalogo(item: WasteItem): WasteItem {
  return { itemType: item.itemType, itemId: item.itemId, name: item.name, sku: item.sku, unit: item.unit }
}

/** Catálogo paginado de artículos que se pueden mermar. `pageSize` hostil ⇒ se recorta a 200. */
export async function listItems(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = parseWasteSchema(WasteQuerySchema, req.query)
    await requireWastePermission(actor(req), req.params.venueId, 'inventory:log-waste')
    const result = await listWasteItems(req.params.venueId, { page: query.page, pageSize: query.pageSize, search: query.search })
    res.json({ items: result.items.map(itemDelCatalogo), total: result.total, page: result.page, pageSize: result.pageSize })
  } catch (error) {
    next(error)
  }
}
