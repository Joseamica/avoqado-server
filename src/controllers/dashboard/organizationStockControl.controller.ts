import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { orgStockControlService } from '../../services/organization-dashboard/orgStockControl.service'
import { orgStockControlExportService } from '../../services/organization-dashboard/orgStockControlExport.service'
import logger from '../../config/logger'

async function isWhiteLabelOrg(orgId: string): Promise<boolean> {
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

    if (!(await isWhiteLabelOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene el módulo de Control de Stock activo',
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

    if (!(await isWhiteLabelOrg(orgId))) {
      return res.status(403).json({
        success: false,
        error: 'module_not_enabled',
        message: 'Esta organización no tiene el módulo de Control de Stock activo',
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
