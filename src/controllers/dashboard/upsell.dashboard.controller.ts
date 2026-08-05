/**
 * Upsell "¿Algo más?" — configuración desde el dashboard.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md
 *
 * Aquí vive TODA la configuración: sin esto la función existe en el POS pero
 * nadie puede prenderla ni decirle qué sugerir.
 *
 * @route /api/v1/dashboard/venues/:venueId/upsell-*
 */

import { Request, Response } from 'express'
import { UpsellRuleStatus } from '@prisma/client'
import logger from '../../config/logger'
import {
  listRules,
  createRule,
  updateRule,
  approveRule,
  dismissRule,
  deleteRule,
  getUpsellSurfaces,
  setUpsellSurfaces,
  setProductUpsellEnabled,
  UpsellValidationError,
} from '../../services/upsell/upsell.service'
import { getPerformance } from '../../services/upsell/upsellImpression.service'
import { generateAiProposals, UpsellAiError } from '../../services/upsell/upsellAi.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import { parseDbDateRange } from '../../utils/datetime'
import prisma from '../../utils/prismaClient'

/** Un error de negocio del servicio se responde 400 con su mensaje en español. */
function handle(error: unknown, res: Response, fallback: string) {
  if (error instanceof UpsellValidationError) {
    return res.status(400).json({ success: false, message: error.message, code: error.code })
  }
  logger.error(fallback, { error })
  return res.status(500).json({ success: false, message: fallback })
}

export async function listUpsellRules(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const status = req.query.status as UpsellRuleStatus | undefined
    const rules = await listRules(venueId, status)

    return res.json({
      success: true,
      data: rules.map(r => ({
        ...r,
        lift: r.lift === null ? null : Number(r.lift),
        suggestedProduct: r.suggestedProduct ? { ...r.suggestedProduct, price: Number(r.suggestedProduct.price) } : null,
      })),
    })
  } catch (error) {
    return handle(error, res, 'Error al cargar las reglas de upsell')
  }
}

export async function createUpsellRule(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext

    const rule = await createRule({ venueId, ...req.body }, userId)
    return res.status(201).json({ success: true, data: rule })
  } catch (error) {
    return handle(error, res, 'Error al crear la regla de upsell')
  }
}

export async function updateUpsellRule(req: Request, res: Response) {
  try {
    const { venueId, ruleId } = req.params
    const { userId } = (req as any).authContext

    const rule = await updateRule(venueId, ruleId, req.body, userId)
    return res.json({ success: true, data: rule })
  } catch (error) {
    return handle(error, res, 'Error al actualizar la regla de upsell')
  }
}

/** `PROPOSED` → `ACTIVE`. Lo que hace el dueño con una propuesta del job o de la IA. */
export async function approveUpsellRule(req: Request, res: Response) {
  try {
    const { venueId, ruleId } = req.params
    const { userId } = (req as any).authContext

    const rule = await approveRule(venueId, ruleId, userId)
    return res.json({ success: true, data: rule })
  } catch (error) {
    return handle(error, res, 'Error al aprobar la regla de upsell')
  }
}

/** Rechazo permanente. Los generadores nunca la resucitan. */
export async function dismissUpsellRule(req: Request, res: Response) {
  try {
    const { venueId, ruleId } = req.params
    const { userId } = (req as any).authContext

    const rule = await dismissRule(venueId, ruleId, userId)
    return res.json({ success: true, data: rule })
  } catch (error) {
    return handle(error, res, 'Error al descartar la regla de upsell')
  }
}

/** "Borrar" escribe tumba, no borra la fila (si no, el job la recrearía). */
export async function deleteUpsellRule(req: Request, res: Response) {
  try {
    const { venueId, ruleId } = req.params
    const { userId } = (req as any).authContext

    await deleteRule(venueId, ruleId, userId)
    return res.json({ success: true })
  } catch (error) {
    return handle(error, res, 'Error al borrar la regla de upsell')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Las tres perillas
// ═══════════════════════════════════════════════════════════════════════════

export async function getSurfaces(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    return res.json({ success: true, data: await getUpsellSurfaces(venueId) })
  } catch (error) {
    return handle(error, res, 'Error al cargar la configuración de upsell')
  }
}

export async function updateSurfaces(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    const { counter, tableOrdering, tablePaying } = req.body

    const saved = await setUpsellSurfaces(venueId, { counter, tableOrdering, tablePaying }, userId)
    return res.json({ success: true, data: saved })
  } catch (error) {
    return handle(error, res, 'Error al guardar la configuración de upsell')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// El veto por producto
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Marca (o desmarca) productos como sugeribles. Acepta varios para la acción
 * masiva desde la lista, sin entrar producto por producto.
 */
export async function updateProductUpsellEnabled(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    const { productIds, enabled } = req.body

    const count = await setProductUpsellEnabled(venueId, productIds, enabled, userId)
    return res.json({ success: true, data: { updated: count } })
  } catch (error) {
    return handle(error, res, 'Error al actualizar los productos sugeribles')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Desempeño
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Devuelve DOS números lado a lado, y la diferencia importa:
 *  - `attributedSales`: el dinero de las líneas que el upsell puso en órdenes pagadas.
 *  - `measuredLift`: cuánto subió el ticket DE VERDAD, comparando contra el grupo
 *    de control. `null` cuando todavía no hay muestra suficiente — mejor null que
 *    un número que el dueño va a leer como si fuera real.
 */
export async function getUpsellPerformance(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { from, to } = req.query as { from?: string; to?: string }

    // 🔴 Fechas VENUE-LOCAL, con la zona del venue. Nunca `new Date('YYYY-MM-DD')`
    // pelado: prod no fija TZ y Node corre en UTC, así que un rango se desfasaría
    // un día entero (incidente real, ver .claude/rules/critical-warnings.md).
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
    const range = parseDbDateRange(from, to, venue?.timezone ?? undefined, 30)

    const performance = await getPerformance(venueId, range.from, range.to)
    return res.json({ success: true, data: performance })
  } catch (error) {
    return handle(error, res, 'Error al cargar el desempeño del upsell')
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/upsell-rules/generate
 *
 * Genera propuestas con IA a partir del menú del negocio. **PREMIUM** (`UPSELL_AI`),
 * candado aplicado en la ruta.
 *
 * 🔴 Esto GASTA tokens de Avoqado, así que los candados del servicio (arrendamiento
 * en transacción + cooldown de 24 h + tope de propuestas) no son adorno: sin ellos
 * un botón en el dashboard es una llave abierta. Cada motivo de rechazo devuelve su
 * propio código para que la pantalla diga algo útil en vez de "error".
 */
export async function generateUpsellRulesWithAi(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext

    const result = await generateAiProposals(venueId)

    // Mutación auditable: creó reglas en el catálogo del negocio.
    void logAction({
      action: 'UPSELL_AI_GENERATED',
      entity: 'UpsellRule',
      entityId: result.runId,
      staffId: userId,
      venueId,
      data: { proposed: result.proposed, discarded: result.discarded },
    })

    return res.json({
      success: true,
      data: result,
      message:
        result.proposed > 0
          ? `Se generaron ${result.proposed} sugerencias para que las revises.`
          : 'No se encontraron sugerencias nuevas con este menú.',
    })
  } catch (error) {
    if (error instanceof UpsellAiError) {
      return res.status(error.httpStatus).json({
        success: false,
        message: error.message,
        code: error.code,
        retryAfterMinutes: error.retryAfterMinutes,
      })
    }
    return handle(error, res, 'Error al generar sugerencias con IA')
  }
}
