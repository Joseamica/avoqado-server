import type { NextFunction, Request, Response } from 'express'
import { ServiceUnavailableError } from '@/errors/AppError'
import { getActiveCommercialCatalog } from '@/services/commercial/commercialRead.service'
import { commercialAcquisitionContextService } from '@/services/commercial/commercialAcquisitionContext.service'
import { commercialQuoteAuthorityService } from '@/services/commercial/commercialQuoteAuthority.service'
import { commercialPublicQuotePreviewV2Service } from '@/services/commercial/commercialPublicQuotePreviewV2.service'
import { CommercialCatalogAuthorityError } from '@/services/commercial/commercialCatalogAuthority.service'
import { CommercialArtifactCodecError } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { CommercialCatalogFallbackError } from '@/services/commercial/commercialCatalogFallback.service'

function publicCatalogError(error: unknown): unknown {
  if (error instanceof CommercialCatalogAuthorityError) {
    if (error.code === 'COMMERCIAL_CATALOG_VERSION_UNSUPPORTED') {
      return new ServiceUnavailableError(
        'La versión del catálogo comercial activo todavía no es compatible.',
        'COMMERCIAL_CATALOG_VERSION_UNSUPPORTED',
      )
    }
    if (error.code === 'COMMERCIAL_CATALOG_AUTHORITY_INVALID') {
      return new ServiceUnavailableError('No fue posible verificar el catálogo comercial activo.', 'COMMERCIAL_CATALOG_AUTHORITY_INVALID')
    }
    return error
  }
  if (error instanceof CommercialArtifactCodecError) {
    if (error.code === 'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED' || error.code === 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED') {
      return new ServiceUnavailableError(
        'La versión del catálogo comercial activo todavía no es compatible.',
        'COMMERCIAL_CATALOG_VERSION_UNSUPPORTED',
      )
    }
    return new ServiceUnavailableError('No fue posible verificar el catálogo comercial activo.', 'COMMERCIAL_CATALOG_AUTHORITY_INVALID')
  }
  if (error instanceof CommercialCatalogFallbackError) {
    return new ServiceUnavailableError('No fue posible verificar el catálogo comercial activo.', 'COMMERCIAL_CATALOG_AUTHORITY_INVALID')
  }
  return error
}

export async function getCommercialCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const catalog = await getActiveCommercialCatalog()
    if (!catalog) {
      res.status(404).json({
        success: false,
        code: 'COMMERCIAL_CATALOG_NOT_ACTIVE',
        message: 'El catálogo comercial todavía no está activo.',
      })
      return
    }
    res.setHeader('ETag', catalog.etag)
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
    if (catalog.fallback) {
      res.setHeader('X-Avoqado-Commercial-Fallback', 'verified-compatible')
      res.setHeader('X-Avoqado-Commercial-Active-Publication', catalog.fallback.activePublicationId)
      res.setHeader('X-Avoqado-Commercial-Served-Publication', catalog.fallback.servedPublicationId)
    }
    if (req.get('if-none-match') === catalog.etag) {
      res.status(304).end()
      return
    }
    res.status(200).json({ success: true, data: catalog.snapshot })
  } catch (error) {
    next(publicCatalogError(error))
  }
}

export async function createCommercialAcquisitionContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const issued = await commercialAcquisitionContextService.issue(req.body, new Date())
    res.setHeader('Cache-Control', 'no-store')
    res.status(201).json({ success: true, data: issued })
  } catch (error) {
    next(error)
  }
}

export async function previewCommercialQuote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await commercialQuoteAuthorityService.previewQuote(req.body)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data: result.quote })
  } catch (error) {
    next(error)
  }
}

export async function previewCommercialQuoteV2(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await commercialPublicQuotePreviewV2Service.preview(req.body, req.correlationId ?? 'commercial-correlation-unavailable')
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
