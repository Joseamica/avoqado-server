import { BusinessType } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import AppError from '../../errors/AppError'
import {
  CATALOG_EXPORT_XLSX_MIME,
  exportCatalogByBusinessTypeV1,
  exportCatalogImportErrorsV1,
  exportCatalogImportTemplateV1,
  exportCatalogMasterV1,
  type CatalogExportFileV1,
} from '../../services/master-catalog/catalogExport.service'
import { readMasterCatalogContext, readMasterCatalogIdParam } from './masterCatalog.dashboard.controller'

const EXPORT_FILENAMES = new Set([
  'catalog-master-v1.xlsx',
  'catalog-by-business-type-v1.xlsx',
  'catalog-master-import-v1.xlsx',
  'import-errors-v1.xlsx',
])

function endpoint(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next)
}

function businessType(req: Request): BusinessType {
  const value = req.query.businessType
  if (typeof value !== 'string' || !Object.values(BusinessType).includes(value as BusinessType)) {
    throw new AppError('businessType no válido', 422, true, 'CATALOG_REQUEST_INVALID')
  }
  return value as BusinessType
}

function sendWorkbook(res: Response, file: CatalogExportFileV1): void {
  if (file.contentType !== CATALOG_EXPORT_XLSX_MIME || !EXPORT_FILENAMES.has(file.filename) || !Buffer.isBuffer(file.buffer)) {
    throw new AppError('Resultado de exportación inválido', 500, false, 'CATALOG_EXPORT_RESULT_INVALID')
  }
  res
    .status(200)
    .set('Content-Type', CATALOG_EXPORT_XLSX_MIME)
    .set('Content-Disposition', `attachment; filename="${file.filename}"`)
    .set('Cache-Control', 'no-store')
    .send(file.buffer)
}

export const getCatalogMasterExport = endpoint(async (req, res) => {
  const context = await readMasterCatalogContext(req)
  sendWorkbook(res, await exportCatalogMasterV1(context))
})

export const getCatalogBusinessTypeExport = endpoint(async (req, res) => {
  const context = await readMasterCatalogContext(req, ['businessType'])
  sendWorkbook(res, await exportCatalogByBusinessTypeV1(context, businessType(req)))
})

export const getCatalogImportTemplate = endpoint(async (req, res) => {
  const context = await readMasterCatalogContext(req)
  sendWorkbook(res, await exportCatalogImportTemplateV1(context))
})

export const getCatalogImportErrors = endpoint(async (req, res) => {
  const context = await readMasterCatalogContext(req)
  sendWorkbook(res, await exportCatalogImportErrorsV1(context, readMasterCatalogIdParam(req, 'importBatchId')))
})
