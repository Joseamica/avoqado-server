import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { orgStockControlService } from '../../services/organization-dashboard/orgStockControl.service'
import { orgStockControlExportService } from '../../services/organization-dashboard/orgStockControlExport.service'
import { orgInventoryByResponsibleService } from '../../services/organization-dashboard/orgInventoryByResponsible.service'
import logger from '../../config/logger'
import type { SerializedItemCustodyState, SerializedItemStatus } from '@prisma/client'

export async function isWhiteLabelOrg(orgId: string): Promise<boolean> {
  // White label can be enabled at two levels:
  // 1. OrganizationModule (org-level — applies to all venues by inheritance)
  // 2. VenueModule (per-venue override)
  // Either one being enabled in this org means the feature is available.

  const orgModule = await prisma.organizationModule.findFirst({
    where: {
      organizationId: orgId,
      enabled: true,
      module: { code: 'WHITE_LABEL_DASHBOARD' },
    },
    select: { id: true },
  })
  if (orgModule) return true

  const venueModuleCount = await prisma.venueModule.count({
    where: {
      enabled: true,
      module: { code: 'WHITE_LABEL_DASHBOARD' },
      venue: { organizationId: orgId },
    },
  })
  return venueModuleCount > 0
}

function parseDateRange(req: Request): { dateFrom?: Date; dateTo?: Date } | { error: string } {
  const { dateFrom, dateTo } = req.query

  let parsedFrom: Date | undefined
  let parsedTo: Date | undefined

  if (dateFrom) {
    parsedFrom = new Date(dateFrom as string)
    if (isNaN(parsedFrom.getTime())) return { error: 'dateFrom inválido' }
  }
  if (dateTo) {
    parsedTo = new Date(dateTo as string)
    if (isNaN(parsedTo.getTime())) return { error: 'dateTo inválido' }
  }
  if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
    return { error: 'dateFrom debe ser menor o igual a dateTo' }
  }

  return { dateFrom: parsedFrom, dateTo: parsedTo }
}

export async function getOrgStockOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params

    const range = parseDateRange(req)
    if ('error' in range) {
      return res.status(400).json({ success: false, error: 'validation_error', message: range.error })
    }

    // Control de Stock sirve inventario serializado, así que se gatea con
    // SERIALIZED_INVENTORY y NO con WHITE_LABEL_DASHBOARD: son módulos
    // independientes (`.claude/rules/feature-gating.md`). Con el candado
    // anterior, un tenant con serializado pero sin marca blanca recibía 403 en
    // su propio inventario, y uno con marca blanca sin serializado pasaba.
    // No se notaba porque el único tenant real tiene ambos a nivel org — es el
    // fallo silencioso que la regla describe.
    if (!(await isSerializedInventoryOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene activo el módulo de inventario serializado. Pídeselo a Avoqado para habilitarlo.',
      })
    }

    const data = await orgStockControlService.getOrgOverview(orgId, range)
    res.json({ success: true, data })
  } catch (error) {
    logger.error('getOrgStockOverview failed', { orgId: req.params.orgId, error })
    next(error)
  }
}

/** Aggregated cards/charts without the legacy unbounded item arrays. */
export async function getOrgStockSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const range = parseDateRange(req)
    if ('error' in range) {
      return res.status(400).json({ success: false, error: 'validation_error', message: range.error })
    }

    if (!(await isSerializedInventoryOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene activo el módulo de inventario serializado. Pídeselo a Avoqado para habilitarlo.',
      })
    }

    const data = await orgStockControlService.getOrgSummary(orgId, range)
    res.json({ success: true, data })
  } catch (error) {
    logger.error('getOrgStockSummary failed', { orgId: req.params.orgId, error })
    next(error)
  }
}

const SERIALIZED_ITEM_STATUSES = new Set(['AVAILABLE', 'SOLD', 'DAMAGED', 'RETURNED'])
const SERIALIZED_ITEM_CUSTODY_STATES = new Set([
  'ADMIN_HELD',
  'SUPERVISOR_HELD',
  'PROMOTER_PENDING',
  'PROMOTER_HELD',
  'PROMOTER_REJECTED',
  'SOLD',
])

/**
 * Bounded SIM-detail endpoint used by the paginated dashboard. The legacy
 * /overview response remains available during the multi-client migration.
 */
export async function getOrgStockItems(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const range = parseDateRange(req)
    if ('error' in range) {
      return res.status(400).json({ success: false, error: 'validation_error', message: range.error })
    }

    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    if (status && !SERIALIZED_ITEM_STATUSES.has(status)) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'status inválido' })
    }
    const custodyState = typeof req.query.custodyState === 'string' ? req.query.custodyState : undefined
    if (custodyState && !SERIALIZED_ITEM_CUSTODY_STATES.has(custodyState)) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'custodyState inválido' })
    }
    const custodyStates =
      typeof req.query.custodyStates === 'string'
        ? req.query.custodyStates
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
        : undefined
    if (custodyStates?.some(value => !SERIALIZED_ITEM_CUSTODY_STATES.has(value))) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'custodyStates inválido' })
    }

    if (!(await isSerializedInventoryOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene activo el módulo de inventario serializado. Pídeselo a Avoqado para habilitarlo.',
      })
    }

    const requestedPage = Number.parseInt(typeof req.query.page === 'string' ? req.query.page : '', 10)
    const requestedPageSize = Number.parseInt(typeof req.query.pageSize === 'string' ? req.query.pageSize : '', 10)
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1
    const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? Math.min(requestedPageSize, 100) : 50
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 128) : undefined
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined
    const registeredFromVenueId = typeof req.query.registeredFromVenueId === 'string' ? req.query.registeredFromVenueId : undefined

    const data = await orgStockControlService.getOrgItemsPage(orgId, {
      ...range,
      page,
      pageSize,
      search: search || undefined,
      status: status as SerializedItemStatus | undefined,
      custodyState: custodyState as SerializedItemCustodyState | undefined,
      custodyStates: custodyStates as SerializedItemCustodyState[] | undefined,
      categoryId,
      registeredFromVenueId,
    })

    res.json({ success: true, data })
  } catch (error) {
    logger.error('getOrgStockItems failed', { orgId: req.params.orgId, error })
    next(error)
  }
}

const CUSTODY_FILTERS = new Set(['todos', 'almacen', 'pendientes', 'aceptados', 'rechazados', 'vendidos', 'estancados'])

/** Exact custody cards/ranking plus one bounded SIM page for the signed-in actor. */
export async function getOrgStockCustody(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const actorStaffId = (req as any).authContext?.userId as string | undefined
    if (!actorStaffId) {
      return res.status(401).json({ success: false, error: 'unauthorized', message: 'Autenticación requerida' })
    }
    const range = parseDateRange(req)
    if ('error' in range) {
      return res.status(400).json({ success: false, error: 'validation_error', message: range.error })
    }
    const filter = typeof req.query.filter === 'string' ? req.query.filter : 'todos'
    if (!CUSTODY_FILTERS.has(filter)) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'filter inválido' })
    }
    if (!(await isSerializedInventoryOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene activo el módulo de inventario serializado. Pídeselo a Avoqado para habilitarlo.',
      })
    }

    const requestedPage = Number.parseInt(typeof req.query.page === 'string' ? req.query.page : '', 10)
    const requestedPageSize = Number.parseInt(typeof req.query.pageSize === 'string' ? req.query.pageSize : '', 10)
    const data = await orgStockControlService.getOrgCustodyPage(orgId, actorStaffId, {
      ...range,
      targetVenueId: typeof req.query.venueId === 'string' ? req.query.venueId : undefined,
      page: Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1,
      pageSize: Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? Math.min(requestedPageSize, 100) : 50,
      search: typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 128) || undefined : undefined,
      filter: filter as any,
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error('getOrgStockCustody failed', { orgId: req.params.orgId, error })
    next(error)
  }
}

/** Bounded upload-history groups; serial search stays server-side. */
export async function getOrgStockBulkGroups(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const range = parseDateRange(req)
    if ('error' in range) {
      return res.status(400).json({ success: false, error: 'validation_error', message: range.error })
    }

    if (!(await isSerializedInventoryOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene activo el módulo de inventario serializado. Pídeselo a Avoqado para habilitarlo.',
      })
    }

    const requestedPage = Number.parseInt(typeof req.query.page === 'string' ? req.query.page : '', 10)
    const requestedPageSize = Number.parseInt(typeof req.query.pageSize === 'string' ? req.query.pageSize : '', 10)
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1
    const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? Math.min(requestedPageSize, 100) : 20
    const search = typeof req.query.search === 'string' ? req.query.search.replace(/[^A-Za-z0-9]/g, '').slice(0, 128) : undefined
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined
    const registeredFromVenueId = typeof req.query.registeredFromVenueId === 'string' ? req.query.registeredFromVenueId : undefined

    const data = await orgStockControlService.getOrgBulkGroupsPage(orgId, {
      ...range,
      page,
      pageSize,
      search: search || undefined,
      categoryId,
      registeredFromVenueId,
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error('getOrgStockBulkGroups failed', { orgId: req.params.orgId, error })
    next(error)
  }
}

export async function exportOrgStockExcel(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params

    const range = parseDateRange(req)
    if ('error' in range) {
      return res.status(400).json({ success: false, error: 'validation_error', message: range.error })
    }

    // Control de Stock sirve inventario serializado, así que se gatea con
    // SERIALIZED_INVENTORY y NO con WHITE_LABEL_DASHBOARD: son módulos
    // independientes (`.claude/rules/feature-gating.md`). Con el candado
    // anterior, un tenant con serializado pero sin marca blanca recibía 403 en
    // su propio inventario, y uno con marca blanca sin serializado pasaba.
    // No se notaba porque el único tenant real tiene ambos a nivel org — es el
    // fallo silencioso que la regla describe.
    if (!(await isSerializedInventoryOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene activo el módulo de inventario serializado. Pídeselo a Avoqado para habilitarlo.',
      })
    }

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, name: true },
    })
    if (!org) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Organización no encontrada' })
    }

    const orgSlug = (org.slug || org.name || 'org').toLowerCase().replace(/[^a-z0-9-]+/g, '-')

    const { buffer, filename } = await orgStockControlExportService.generateExcelBuffer(orgId, range, orgSlug)

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(buffer.length))
    res.send(buffer)
  } catch (error) {
    logger.error('exportOrgStockExcel failed', { orgId: req.params.orgId, error })
    next(error)
  }
}

/**
 * ¿La organización tiene el módulo de inventario serializado?
 *
 * Se gatea con SERIALIZED_INVENTORY y NO con WHITE_LABEL_DASHBOARD: son módulos
 * independientes y exigir white-label rompería a un tenant que sólo tenga
 * serializado (`.claude/rules/feature-gating.md`). Igual que el white-label, el
 * módulo puede venir a nivel organización o por venue.
 */
export async function isSerializedInventoryOrg(orgId: string): Promise<boolean> {
  const orgModule = await prisma.organizationModule.findFirst({
    where: { organizationId: orgId, enabled: true, module: { code: 'SERIALIZED_INVENTORY' } },
    select: { id: true },
  })
  if (orgModule) return true

  const venueModuleCount = await prisma.venueModule.count({
    where: { enabled: true, module: { code: 'SERIALIZED_INVENTORY' }, venue: { organizationId: orgId } },
  })
  return venueModuleCount > 0
}

/**
 * Tabla Ciudad › Supervisor › Promotor con las 7 columnas de custodia y venta.
 *
 * Alimenta la pestaña Resumen del Control de Stock. `receivingVenueId` es el
 * filtro "Sucursal Receptora"; el dashboard lo manda preseleccionado con el
 * almacén de entrada de la organización, pero quitarlo debe mostrar TODO — un
 * supervisor auditando en tienda necesita ver lo que el promotor trae en la
 * mano, venga de donde venga.
 */
export async function getOrgInventoryByResponsible(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params

    const range = parseDateRange(req)
    if ('error' in range) {
      return res.status(400).json({ success: false, error: 'validation_error', message: range.error })
    }

    if (!(await isSerializedInventoryOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene activo el módulo de inventario serializado. Pídeselo a Avoqado para habilitarlo.',
      })
    }

    const receivingVenueId = typeof req.query.receivingVenueId === 'string' ? req.query.receivingVenueId : null
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : null

    const data = await orgInventoryByResponsibleService.getInventoryByResponsible(orgId, {
      ...range,
      categoryId,
      receivingVenueId,
    })

    res.json({ success: true, data })
  } catch (error) {
    logger.error('getOrgInventoryByResponsible failed', { orgId: req.params.orgId, error })
    next(error)
  }
}
