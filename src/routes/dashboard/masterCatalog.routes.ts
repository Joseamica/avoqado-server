import { Router, type NextFunction, type Request, type Response } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import * as controller from '../../controllers/dashboard/masterCatalog.dashboard.controller'
import * as exportController from '../../controllers/dashboard/masterCatalogExport.dashboard.controller'
import multer from 'multer'
import AppError from '../../errors/AppError'
import { preserveContext } from '@/observability/preserveContext'

const router = Router({ mergeParams: true })
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
const multipartParserCodes = new Map([
  ['Malformed part header', 'MALFORMED_PART_HEADER'],
  ['Unexpected end of form', 'UNEXPECTED_END_OF_FORM'],
])
const catalogImportUpload = (req: Request, res: Response, next: NextFunction) => {
  preserveContext(upload.single('file'))(req, res, error => {
    if (error instanceof multer.MulterError) {
      return next(
        new AppError('Solicitud multipart de catálogo no válida', 422, true, 'CATALOG_IMPORT_REQUEST_INVALID', {
          multerCode: error.code,
          field: error.field ?? null,
        }),
      )
    }
    const parserCode = error instanceof Error ? multipartParserCodes.get(error.message) : undefined
    if (parserCode) {
      return next(new AppError('Solicitud multipart de catálogo no válida', 422, true, 'CATALOG_IMPORT_REQUEST_INVALID', { parserCode }))
    }
    return next(error)
  })
}

router.use(authenticateTokenMiddleware)
router.get('/access', controller.getAccess)
router.get('/items', controller.listItems)
router.post('/items', controller.createItem)
router.get('/items/:catalogItemId', controller.getItem)
router.patch('/items/:catalogItemId', controller.updateItem)
router.post('/items/:catalogItemId/retire', controller.retireItem)
router.get('/validation-profiles', controller.listValidationProfiles)
router.post('/validation-profiles/preview', controller.previewValidationProfile)
router.post('/validation-profiles/:profileBatchId/confirm', controller.confirmValidationProfile)
router.get('/catalogs/brands', controller.listBrands)
router.post('/catalogs/brands', controller.createBrand)
router.patch('/catalogs/brands/:brandId', controller.updateBrand)
router.post('/catalogs/brands/:brandId/retire', controller.retireBrand)
router.get('/catalogs/manufacturers', controller.listManufacturers)
router.post('/catalogs/manufacturers', controller.createManufacturer)
router.patch('/catalogs/manufacturers/:manufacturerId', controller.updateManufacturer)
router.post('/catalogs/manufacturers/:manufacturerId/retire', controller.retireManufacturer)
router.get('/catalogs/families', controller.listFamilies)
router.post('/catalogs/families', controller.createFamily)
router.patch('/catalogs/families/:familyId', controller.updateFamily)
router.post('/catalogs/families/:familyId/retire', controller.retireFamily)
router.get('/exports/catalog-master.xlsx', exportController.getCatalogMasterExport)
router.get('/exports/catalog-by-business-type.xlsx', exportController.getCatalogBusinessTypeExport)
router.get('/templates/catalog-master-import-v1.xlsx', exportController.getCatalogImportTemplate)
router.post('/imports/preview', catalogImportUpload, controller.previewImport)
router.get('/imports/:importBatchId/errors.xlsx', exportController.getCatalogImportErrors)
router.get('/imports/:importBatchId', controller.getImport)
router.post('/imports/:importBatchId/confirm', controller.confirmImport)
router.post('/bindings/preview', controller.previewBindings)
router.post('/bindings/confirm', controller.confirmBindings)
router.post('/publications/preview', controller.previewPublication)
router.post('/publications/:publicationBatchId/confirm', controller.confirmPublication)
router.get('/publications/by-idempotency-key/:operation/:idempotencyKey', controller.getPublicationByIdempotencyKey)
router.post('/publications/:publicationBatchId/reversal/preview', controller.previewPublicationReversal)
router.get('/publications/:publicationBatchId', controller.getPublication)
router.get('/publications', controller.listPublications)
router.get('/audit/actions', controller.listAuditActions)
router.get('/audit', controller.listAudit)

export default router
