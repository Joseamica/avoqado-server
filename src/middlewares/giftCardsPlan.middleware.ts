/**
 * Candado de PLAN de las tarjetas de regalo (índice R9: sólo VENDER y PRENDER piden el plan).
 *
 * Cobrar con saldo, consultar, regresar el saldo, cancelar una venta, los reportes y el MCP NUNCA pasan por aquí: el saldo
 * ya vendido es una deuda del negocio con su cliente y se honra aunque el negocio baje de plan (spec §6).
 *
 * `checkFeatureAccess` niega con un 403 en inglés. Esto reescribe SÓLO ese cuerpo (el que trae `featureCode: GIFT_CARDS`) a
 * uno que el POS y el dashboard muestran tal cual: qué falta, cuánto cuesta y a quién pedírselo (molde: los pases,
 * `routes/dashboard/passIntegrations.routes.ts`). No reimplementa el candado: exentos, demos, superadmin y accesos sueltos
 * siguen resolviéndose donde siempre.
 */
import type { NextFunction, Request, Response } from 'express'
import { checkFeatureAccess } from './checkFeatureAccess.middleware'

export const GIFT_CARDS_FEATURE = 'GIFT_CARDS'
const PEDIRLO = 'Pídele al dueño del negocio que las active desde el dashboard (Configuración → Plan).'
export const MENSAJE_PLAN_DE_TARJETAS = `Las tarjetas de regalo vienen en el plan Pro, o como función suelta a $249 al mes con IVA. ${PEDIRLO}`

interface NegativaDelPortero {
  featureCode?: string
  trialExpired?: boolean
  suspended?: boolean
}

function mensajeDe(b: NegativaDelPortero): string {
  if (b.trialExpired) return `La prueba de las tarjetas de regalo ya terminó. ${PEDIRLO}`
  if (b.suspended)
    return 'Las tarjetas de regalo están suspendidas por un pago fallido del plan. Pídele al dueño del negocio que actualice el método de pago desde el dashboard (Configuración → Plan).'
  return MENSAJE_PLAN_DE_TARJETAS
}

function reescribirNegativa(res: Response): void {
  const json = res.json.bind(res)
  res.json = (body: unknown) => {
    const b = body as NegativaDelPortero | null
    if (res.statusCode === 403 && b?.featureCode === GIFT_CARDS_FEATURE) {
      return json({
        error: 'GIFT_CARDS_NOT_IN_PLAN',
        code: 'GIFT_CARDS_NOT_IN_PLAN',
        message: mensajeDe(b),
        howToEnable: 'PLAN',
        featureCode: GIFT_CARDS_FEATURE,
        requiredPlan: 'PRO',
        ...(b.trialExpired ? { trialExpired: true } : {}),
        ...(b.suspended ? { suspended: true } : {}),
      })
    }
    return json(body)
  }
}

const portero = checkFeatureAccess(GIFT_CARDS_FEATURE)

/** Vender una tarjeta (`POST /mobile/venues/:venueId/gift-cards/orders`). */
export function exigirPlanDeTarjetas(req: Request, res: Response, next: NextFunction) {
  reescribirNegativa(res)
  return portero(req, res, next)
}

/**
 * Ajustes del dashboard: sólo PRENDER (`enabled: true` en el cuerpo ya validado) pide el plan. Apagar o guardar montos no:
 * el dashboard manda `enabled` sólo cuando el dueño mueve el interruptor (contrato con D, «Adiciones al contrato»).
 */
export function exigirPlanSiPrende(req: Request, res: Response, next: NextFunction) {
  if (req.body?.enabled !== true) return next()
  return exigirPlanDeTarjetas(req, res, next)
}

// Marca que leen las pruebas de rutas (introspección estática, como `requiredPermission` de checkPermission).
;(exigirPlanDeTarjetas as unknown as { featureCode: string }).featureCode = GIFT_CARDS_FEATURE
;(exigirPlanSiPrende as unknown as { featureCode: string }).featureCode = GIFT_CARDS_FEATURE
