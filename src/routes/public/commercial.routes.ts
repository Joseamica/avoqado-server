import { Router } from 'express'
import {
  createCommercialAcquisitionContext,
  getCommercialCatalog,
  previewCommercialQuote,
  previewCommercialQuoteV2,
} from '@/controllers/public/commercial.public.controller'
import { validateRequest } from '@/middlewares/validation'
import {
  commercialAcquisitionContextRateLimiter,
  commercialQuotePreviewV2RateLimiter,
} from '@/middlewares/commercial-public-rate-limit.middleware'
import { commercialAcquisitionContextRequestSchema, commercialQuotePreviewRequestSchema } from '@/schemas/commercialQuote.schema'
import { commercialPublicQuotePreviewV2HttpRequestSchema } from '@/schemas/commercialQuoteV2.schema'

const router = Router()
router.get('/catalog', getCommercialCatalog)
router.post(
  '/acquisition-context',
  commercialAcquisitionContextRateLimiter,
  validateRequest(commercialAcquisitionContextRequestSchema),
  createCommercialAcquisitionContext,
)
router.post('/quotes/preview', validateRequest(commercialQuotePreviewRequestSchema), previewCommercialQuote)
router.post(
  '/quotes/preview-v2',
  commercialQuotePreviewV2RateLimiter,
  validateRequest(commercialPublicQuotePreviewV2HttpRequestSchema),
  previewCommercialQuoteV2,
)

export default router
