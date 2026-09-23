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
 *
 * 🔴 PIN de gerente (Ruling 18): el permiso lo decide SÓLO `checkPermission`, que respeta el
 * token de un solo uso `X-Permission-Override` — las dos apps lo piden solas ante un 403
 * `overridable`. Lo que `checkPermission` no mira (acceso vigente, cuenta activa, activación
 * white-label del inventario) va en `requireActivation`, montado ANTES de él, y la validación de
 * la entrada también: esos rechazos de ACCESO y de forma no consumen el PIN. Un rechazo de negocio
 * de `logWaste` (artículo que no existe, unidad que cambió) sí llega con el PIN ya gastado: el PIN
 * autoriza UN intento. Por eso estos manejadores ya no llaman `requireWastePermission` (ése es el
 * camino completo del MCP).
 */
import { NextFunction, Request, Response } from 'express'
import { ForbiddenError, UnauthorizedError } from '../../errors/AppError'
import { IMPERSONATION_ERROR_CODES } from '../../types/impersonation'
import {
  hasWastePermission,
  logWaste,
  prepareWaste,
  recoverByKey,
  requireWasteActivation,
  voidWasteKey,
  WasteInput,
} from '../../services/shared/inventoryWaste.service'
import { isWasteReasonCode, WASTE_REASONS } from '../../services/shared/wasteReasons'
import { listWasteItems, listWasteReports, WasteItem } from '../../services/shared/inventoryWasteRead.service'
import { parseWasteSchema, VoidWasteBodySchema, WasteBodySchema, WasteQuerySchema } from '../../schemas/mobile/inventoryWaste.mobile.schema'

/** Quién actúa. `write`: la suplantación es de sólo lectura (el middleware ya la corta; esto es la segunda capa). */
function actor(req: Request, write = false): string {
  if (!req.authContext?.userId) throw new UnauthorizedError()
  if (write && req.authContext.isImpersonating) {
    throw new ForbiddenError('La sesión de suplantación es de solo lectura.', IMPERSONATION_ERROR_CODES.READ_ONLY)
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
 * Paso previo de las rutas de merma, ANTES de `checkPermission`: acceso vigente, cuenta activa y
 * activación white-label (`403 WASTE_ACCESS_REVOKED | WASTE_ACCOUNT_INACTIVE |
 * WASTE_INVENTORY_DISABLED`). NO evalúa el permiso: si lo hiciera, un KITCHEN autorizado con el
 * PIN de gerente recibiría 403 después de que `checkPermission` ya gastó el token.
 */
export async function requireActivation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // El historial la reusa para decidir el alcance con los permisos PROPIOS (no con el PIN).
    res.locals.wasteAccess = await requireWasteActivation(actor(req), req.params.venueId)
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Paso 2 del POST, tras plan, activación y permiso (este último puede venir del PIN de gerente):
 * registra la merma. El cuerpo ya se validó en `recover`, antes de `checkPermission`.
 */
export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const staffId = actor(req, true)
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

/**
 * Valida la query del catálogo ANTES de `checkPermission` (una query inválida no puede quemar el
 * PIN de gerente) y la deja lista en `res.locals.wasteQuery`.
 */
export function parseItemsQuery(req: Request, res: Response, next: NextFunction): void {
  try {
    res.locals.wasteQuery = parseWasteSchema(WasteQuerySchema, req.query)
    next()
  } catch (error) {
    next(error)
  }
}

/** Catálogo paginado de artículos que se pueden mermar. `pageSize` hostil ⇒ se recorta a 200. */
export async function listItems(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = res.locals.wasteQuery ?? parseWasteSchema(WasteQuerySchema, req.query)
    const result = await listWasteItems(req.params.venueId, { page: query.page, pageSize: query.pageSize, search: query.search })
    res.json({ items: result.items.map(itemDelCatalogo), total: result.total, page: result.page, pageSize: result.pageSize })
  } catch (error) {
    next(error)
  }
}

type WasteReportRow = Awaited<ReturnType<typeof listWasteReports>>['items'][number]

/** Un folio para el POS, campo por campo: aunque el lector cambie, esta ruta nunca entrega pesos
 *  (`costImpact`, `unitCostSnapshot`, `costState`) ni proveedor. Los costos viven en el dashboard. */
function folioDelHistorial(row: WasteReportRow) {
  const item = row.rawMaterial ?? row.product
  const staff = row.reportedByStaff
  return {
    id: row.id,
    itemType: row.itemType,
    name: item?.name ?? '',
    sku: item?.sku ?? '',
    unit: row.unit,
    reasonCode: row.reasonCode,
    // Los motivos del dashboard no son chips del POS: la etiqueta viaja para que el aparato no la adivine.
    reasonLabel: row.reasonCode && isWasteReasonCode(row.reasonCode) ? WASTE_REASONS[row.reasonCode].label : null,
    declaredQuantity: row.declaredQuantity?.toString() ?? null,
    deductedQuantity: row.deductedQuantity.toString(),
    unrecordedQuantity: row.unrecordedQuantity.toString(),
    note: row.note,
    createdAt: row.createdAt,
    reportedByName: staff ? `${staff.firstName} ${staff.lastName}`.trim() : null,
  }
}

/**
 * Historial de mermas del POS (decisión del founder, 23-sep): quien tiene `inventory:adjust`
 * (gerente, dueño) ve las de todos; los demás, SÓLO las suyas. El alcance sale de los permisos
 * PROPIOS de quien llama (`requireActivation` los dejó en `res.locals`), nunca del PIN de gerente:
 * un override abre la ruta pero no la lista del negocio.
 */
export async function listReports(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const staffId = actor(req)
    const query = res.locals.wasteQuery ?? parseWasteSchema(WasteQuerySchema, req.query)
    // Suplantando, el acceso se resolvió con el rol REAL (en `mode=role` es el SUPERADMIN): falla cerrado.
    const access = req.authContext?.isImpersonating ? undefined : res.locals.wasteAccess
    const scope = access && hasWastePermission(access, 'inventory:adjust') ? 'ALL' : 'MINE'
    const result = await listWasteReports(req.params.venueId, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
      cursor: query.cursor,
      ...(scope === 'MINE' && { reportedByStaffId: staffId }),
    })
    res.json({
      scope,
      items: result.items.map(folioDelHistorial),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      // La siguiente página se pide con esto; `null` = ya no hay más.
      nextCursor: result.nextCursor,
    })
  } catch (error) {
    next(error)
  }
}
