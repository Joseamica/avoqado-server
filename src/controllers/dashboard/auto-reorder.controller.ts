import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import {
  getAutoReorderConfig,
  setAutoReorderConfig,
  getReorderSuggestions,
  runAutoReorderForVenue,
  venueHasDeliveryAddress,
  type AutoReorderConfig,
} from '../../services/dashboard/autoReorder.service'
import { logAction } from '../../services/dashboard/activity-log.service'

const configSchema = z.object({
  enabled: z.boolean({ required_error: 'El estado de activación es requerido' }),
  dailyCapMxn: z.number().positive('El tope diario debe ser mayor a 0').nullable(),
  minUrgency: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], { required_error: 'La urgencia mínima es requerida' }),
})

/** Route-level body validation schema — use with validateRequest so bad input returns 400 (not 500). */
export const updateAutoReorderSchema = z.object({ body: configSchema })

/** GET settings + a live preview of what would be re-ordered. */
export async function getSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const config = await getAutoReorderConfig(venueId)
    const hasDeliveryAddress = await venueHasDeliveryAddress(venueId)
    const { suggestions, totalSuggestions, criticalCount } = await getReorderSuggestions(venueId)
    res.json({
      config,
      hasDeliveryAddress,
      preview: {
        totalSuggestions,
        criticalCount,
        items: suggestions.slice(0, 50).map(s => ({
          name: s.rawMaterial.name,
          currentStock: s.rawMaterial.currentStock,
          reorderPoint: s.rawMaterial.reorderPoint,
          urgency: s.suggestion.urgency,
          suggestedQuantity: s.suggestion.suggestedQuantity,
          estimatedCost: s.suggestion.estimatedCost,
          supplier: s.suggestion.recommendedSupplier?.name ?? null,
        })),
      },
    })
  } catch (error) {
    next(error)
  }
}

/** PUT settings (gated by AUTO_REORDER feature at the route). */
export async function updateSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    // Body already validated by validateRequest(updateAutoReorderSchema) at the route → 400 on bad input.
    const saved = await setAutoReorderConfig(venueId, req.body as AutoReorderConfig)
    await logAction({
      staffId: userId,
      venueId,
      action: 'AUTO_REORDER_CONFIG_UPDATED',
      entity: 'Venue',
      entityId: venueId,
      data: { enabled: saved.enabled, dailyCapMxn: saved.dailyCapMxn, minUrgency: saved.minUrgency },
    })
    res.json({ config: saved })
  } catch (error) {
    next(error)
  }
}

/** POST run-now — execute the auto-reorder immediately (testing / manual trigger). */
export async function runNow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const result = await runAutoReorderForVenue(venueId)
    res.json({ result })
  } catch (error) {
    next(error)
  }
}
