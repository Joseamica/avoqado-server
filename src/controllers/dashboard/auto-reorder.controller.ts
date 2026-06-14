import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import {
  getAutoReorderConfig,
  setAutoReorderConfig,
  getReorderSuggestions,
  runAutoReorderForVenue,
  type AutoReorderConfig,
} from '../../services/dashboard/autoReorder.service'
import { logAction } from '../../services/dashboard/activity-log.service'

const configSchema = z.object({
  enabled: z.boolean({ required_error: 'El estado de activación es requerido' }),
  dailyCapMxn: z.number().positive('El tope diario debe ser mayor a 0').nullable(),
  minUrgency: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], { required_error: 'La urgencia mínima es requerida' }),
})

/** GET settings + a live preview of what would be re-ordered. */
export async function getSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = (req as any).authContext
    const config = await getAutoReorderConfig(venueId)
    const { suggestions, totalSuggestions, criticalCount } = await getReorderSuggestions(venueId)
    res.json({
      config,
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
    const { venueId, userId } = (req as any).authContext
    const parsed = configSchema.parse(req.body) as AutoReorderConfig
    const saved = await setAutoReorderConfig(venueId, parsed)
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
    const { venueId } = (req as any).authContext
    const result = await runAutoReorderForVenue(venueId)
    res.json({ result })
  } catch (error) {
    next(error)
  }
}
