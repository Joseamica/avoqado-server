import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { orgStockControlService } from '../../services/organization-dashboard/orgStockControl.service'
import { orgStockControlExportService } from '../../services/organization-dashboard/orgStockControlExport.service'
import { orgInventoryByResponsibleService } from '../../services/organization-dashboard/orgInventoryByResponsible.service'
import logger from '../../config/logger'

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
