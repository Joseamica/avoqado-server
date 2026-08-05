/**
 * Upsell "¿Algo más?" — endpoints que consume el POS (avoqado-android / avoqado-ios).
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md
 *
 * 🔴 El 403 del candado de plan lo emite `checkFeatureAccess` en la ruta, NO este
 * controlador. Eso importa: su cuerpo lleva `featureCode`, y el POS borra su caché
 * de reglas SÓLO cuando ve ese campo. Un 403 de permisos o de un proxy no lo trae
 * y por eso NO apaga la función en un local que sí la paga (spec R3).
 *
 * @route /api/v1/mobile/venues/:venueId/upsell-rules
 * @route /api/v1/mobile/venues/:venueId/upsell-impressions
 */

import { Request, Response } from 'express'
import logger from '../../config/logger'
import { listActiveRulesForPos, getUpsellSurfaces } from '../../services/upsell/upsell.service'
import { recordImpression, convertImpression, UpsellConversionError, HOLDOUT_PERCENT } from '../../services/upsell/upsellImpression.service'
import { UpsellSurface } from '@prisma/client'

/**
 * GET /api/v1/mobile/venues/:venueId/upsell-rules
 *
 * La tabla precalculada que el POS cachea y evalúa localmente al dar Cobrar.
 * Devuelve también las tres perillas y el porcentaje del grupo de control, para
 * que el cliente no necesite una segunda llamada.
 */
export async function listUpsellRules(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const [rules, surfaces] = await Promise.all([listActiveRulesForPos(venueId), getUpsellSurfaces(venueId)])

    return res.json({
      success: true,
      data: {
        rules,
        surfaces,
        // El cliente sortea el holdout de forma determinista por impressionId,
        // con este mismo porcentaje. Viaja aquí para poder ajustarlo sin publicar
        // una versión nueva del POS.
        holdoutPercent: HOLDOUT_PERCENT,
      },
    })
  } catch (error) {
    logger.error('Error listing upsell rules (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al cargar las sugerencias' })
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/upsell-impressions
 *
 * Registra un momento de upsell. Fuego-y-olvido: el POS NO espera esta respuesta,
 * porque la analítica jamás puede retrasar un cobro. Idempotente por `impressionId`.
 */
export async function recordUpsellImpression(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { impressionId, shownRuleIds, accepted, reportedAmount, cartSubtotalBefore, surface, context } = req.body

    const impression = await recordImpression({
      impressionId,
      venueId,
      shownRuleIds: shownRuleIds ?? [],
      accepted: accepted ?? [],
      reportedAmount: reportedAmount ?? 0,
      cartSubtotalBefore: cartSubtotalBefore ?? 0,
      surface: surface as UpsellSurface,
      context,
    })

    return res.status(201).json({ success: true, data: { id: impression.id } })
  } catch (error) {
    logger.error('Error recording upsell impression (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al registrar el momento de upsell' })
  }
}

/**
 * PATCH /api/v1/mobile/venues/:venueId/upsell-impressions/:impressionId
 *
 * Marca que el momento terminó en una venta PAGADA. Sin esto, la impresión aporta
 * cero pesos al reporte: el cliente aceptó pero el cobro nunca cerró.
 */
export async function convertUpsellImpression(req: Request, res: Response) {
  try {
    const { venueId, impressionId } = req.params
    const { orderId } = req.body

    await convertImpression(venueId, impressionId, orderId)
    return res.json({ success: true })
  } catch (error) {
    if (error instanceof UpsellConversionError) {
      return res.status(error.httpStatus).json({ success: false, message: error.message, code: error.code })
    }
    logger.error('Error converting upsell impression (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al registrar la conversión' })
  }
}
