import type { NextFunction, Request, Response } from 'express'
import AppError from '@/errors/AppError'
import { commercialDirectVenueQuoteService } from '@/services/commercial/commercialDirectVenueQuote.service'
import { commercialQuotePreviewBridgeService } from '@/services/commercial/commercialQuotePreviewBridge.service'
import { commercialQuoteAcceptanceService } from '@/services/commercial/commercialQuoteAcceptance.service'
import { commercialStripeCheckoutService } from '@/services/commercial/commercialStripeCheckoutFacade.service'
import {
  getCommercialBillingDashboardOverview,
  listCommercialBillingDashboardReceipts,
} from '@/services/commercial/billing/commercialBillingDashboardRead.service'
import { commercialConfiguratorDashboardService } from '@/services/commercial/configurator/commercialConfiguratorDashboard.service'

function auth(req: Request) {
  if (!req.authContext) throw new AppError('Authentication required', 401, true, 'AUTH_REQUIRED')
  return req.authContext
}

export async function getCommercialBillingOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = auth(req)
    const overview = await getCommercialBillingDashboardOverview({
      organizationId: context.orgId,
      venueId: req.params.venueId,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data: overview })
  } catch (error) {
    next(error)
  }
}

export async function listCommercialBillingReceipts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = auth(req)
    const receipts = await listCommercialBillingDashboardReceipts({
      organizationId: context.orgId,
      venueId: req.params.venueId,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit as unknown as number | undefined,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data: receipts })
  } catch (error) {
    next(error)
  }
}

export async function previewCommercialBillingConfigurator(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = auth(req)
    const result = await commercialConfiguratorDashboardService.preview({
      organizationId: context.orgId,
      venueId: req.params.venueId,
      selection: req.body.selection,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

export async function createAuthenticatedCommercialQuote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = auth(req)
    const result = await commercialDirectVenueQuoteService.create({
      organizationId: context.orgId,
      venueId: req.params.venueId,
      actorId: context.userId,
      lines: req.body.lines,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(201).json({ success: true, data: result.snapshot })
  } catch (error) {
    next(error)
  }
}

export async function bridgeAuthenticatedCommercialQuote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = auth(req)
    const result = await commercialQuotePreviewBridgeService.bridge({
      organizationId: context.orgId,
      venueId: req.params.venueId,
      actorId: context.userId,
      acquisitionBearer: req.body.acquisitionBearer,
      previewToken: req.body.previewToken,
      normalizedLines: req.body.normalizedLines,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(result.outcome === 'CREATED' ? 201 : 200).json({
      success: true,
      outcome: result.outcome,
      data: result.quote.snapshot,
    })
  } catch (error) {
    next(error)
  }
}

export async function acceptCommercialQuote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = auth(req)
    const acceptance = await commercialQuoteAcceptanceService.accept({
      quoteId: req.params.quoteId,
      organizationId: context.orgId,
      venueId: req.params.venueId,
      acceptedById: context.userId,
      idempotencyKey: req.get('idempotency-key') ?? '',
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data: acceptance })
  } catch (error) {
    next(error)
  }
}

export async function createCommercialCheckout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = auth(req)
    const checkout = await commercialStripeCheckoutService.createCheckout({
      acceptanceId: req.params.acceptanceId,
      organizationId: context.orgId,
      venueId: req.params.venueId,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(201).json({ success: true, data: checkout })
  } catch (error) {
    next(error)
  }
}
