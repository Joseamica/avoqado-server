import { Request, Response, NextFunction } from 'express'
import * as pricingService from '../../../services/dashboard/pricing.service'
import * as marketBenchmarkService from '../../../services/dashboard/inventory/market-benchmark.service'

/**
 * Get pricing policy for a product
 */
export async function getPricingPolicy(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params

    const policy = await pricingService.getPricingPolicy(venueId, productId)

    if (!policy) {
      return res.json({
        success: true,
        data: null,
        message: 'No pricing policy found for this product',
      })
    }

    res.json({
      success: true,
      data: policy,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create a pricing policy for a product
 */
export async function createPricingPolicy(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const data = req.body

    const policy = await pricingService.createPricingPolicy(venueId, productId, data)

    res.status(201).json({
      success: true,
      message: 'Pricing policy created successfully',
      data: policy,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update a pricing policy
 */
export async function updatePricingPolicy(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const data = req.body

    const policy = await pricingService.updatePricingPolicy(venueId, productId, data)

    res.json({
      success: true,
      message: 'Pricing policy updated successfully',
      data: policy,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Calculate suggested price for a product (preview)
 */
export async function calculatePrice(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params

    const calculation = await pricingService.calculatePrice(venueId, productId)

    res.json({
      success: true,
      data: calculation,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Apply suggested price to product
 */
export async function applySuggestedPrice(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const staffId = req.authContext?.userId

    const calculation = await pricingService.applySuggestedPrice(venueId, productId, staffId)

    res.json({
      success: true,
      message: 'Suggested price applied successfully',
      data: calculation,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get pricing analysis for all products
 */
export async function getPricingAnalysis(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { categoryId } = req.query

    const analysis = await pricingService.getPricingAnalysis(venueId, {
      categoryId: categoryId as string | undefined,
    })

    res.json({
      success: true,
      data: analysis,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Market benchmark — AI-assisted price exploration powered by Google Places
 * + OpenAI. Returns an advisory median estimate for a single product based on
 * comparable restaurants/cafés near the venue. Always advisory; the dashboard
 * shows a "verify before applying" disclaimer.
 */
export async function getMarketBenchmarkForProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const userId = (req as any).authContext?.userId
    const data = await marketBenchmarkService.getMarketBenchmark(venueId, productId, { userId })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * Bulk benchmark — analyze up to 50 products in one call. Consumes from the
 * venue's chatbot token budget (same pool as text-to-sql / assistant).
 */
export async function getBulkMarketBenchmark(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const userId = (req as any).authContext?.userId
    const productIds = Array.isArray(req.body?.productIds) ? (req.body.productIds as string[]) : []
    const data = await marketBenchmarkService.getBulkMarketBenchmark(venueId, productIds, { userId })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * Unified profitability view: recipes + quantity-tracked products in one
 * response. Powers the Inventario → Rentabilidad page.
 */
export async function getProfitability(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { categoryId, includeInactive } = req.query

    const data = await pricingService.getProfitability(venueId, {
      categoryId: categoryId as string | undefined,
      includeInactive: includeInactive === 'true',
    })

    res.json({
      success: true,
      data,
    })
  } catch (error) {
    next(error)
  }
}
