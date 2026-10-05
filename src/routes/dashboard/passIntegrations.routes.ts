/**
 * Conector de pases (TotalPass/Wellhub) — API del dashboard. Montado en
 * /api/v1/dashboard/venues/:venueId/pass-integrations (dashboard.routes.ts).
 *
 * Orden: auth (en el montaje) → validateRequest → checkPermission → withPassesPlanMessage → checkFeatureAccess
 * (el resumen, desconectar y las visitas: sólo el permiso).
 * Permiso ANTES que el plan, igual que Delivery (§10.4): un no miembro no sondea el estado del plan por los 403.
 */
import { NextFunction, Request, Response, Router } from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/dashboard/passIntegrations.controller'
import * as s from '@/schemas/dashboard/passIntegrations.schema'

const router = Router({ mergeParams: true })
const FEATURE = 'AGGREGATOR_PASSES'
// Quien ve el 403 puede ser un gerente que no cambia el plan: se le dice a quién pedírselo (mismo patrón que Delivery).
const ACTIVAR = 'Pídele al dueño del negocio que los active desde el dashboard (Configuración → Plan).'

interface FeatureAccessDeniedBody {
  featureCode?: string
  trialExpired?: boolean
  suspended?: boolean
}

/**
 * `checkFeatureAccess` niega con un 403 en inglés genérico. Esto sólo reescribe ESE cuerpo (el que trae `featureCode` de
 * los pases) a un mensaje en español que dice qué es, cuánto cuesta y dónde activarlo; no reimplementa el candado.
 */
function withPassesPlanMessage(_req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res)
  res.json = (body: unknown) => {
    const b = body as FeatureAccessDeniedBody
    if (res.statusCode === 403 && b?.featureCode === FEATURE) {
      const base = { featureCode: FEATURE, requiredPlan: 'PRO' }
      if (b.trialExpired) {
        return json({
          error: 'TRIAL_EXPIRED',
          code: 'TRIAL_EXPIRED',
          message: `La prueba de los pases de TotalPass y Wellhub ya terminó. ${ACTIVAR}`,
          ...base,
        })
      }
      if (b.suspended) {
        return json({
          error: 'SUBSCRIPTION_SUSPENDED',
          code: 'SUBSCRIPTION_SUSPENDED',
          message:
            'Los pases están suspendidos por un pago fallido del plan. Pídele al dueño del negocio que actualice el método de pago desde el dashboard (Configuración → Plan).',
          ...base,
        })
      }
      return json({
        error: 'PLAN_REQUIRED',
        code: 'PLAN_REQUIRED',
        message: `Los pases de TotalPass y Wellhub vienen en el plan Pro, o como función suelta a $199 MXN al mes. ${ACTIVAR}`,
        ...base,
      })
    }
    return json(body)
  }
  next()
}

const gate = (perm: string) => [checkPermission(perm), withPassesPlanMessage, checkFeatureAccess(FEATURE)]
const READ = 'reservations:read'
const MANAGE = 'reservations:manage-passes'
const UPDATE = 'reservations:update'

// `/capacity/...` y `/visits/...` son literales; `/:provider/...` sólo acepta totalpass|wellhub (esquema) y nunca choca con
// ellas: distinto método o distinto número de segmentos.
// Sin candado de plan (R62, pausa suave): un negocio que lo perdió sigue conectado y debe VER que sus clases ya no se
// publican (`planActive: false`) y tener a la mano Desconectar. Son datos del propio negocio, sin credencial ni token.
router.get('/', validateRequest(s.overviewSchema), checkPermission(READ), ctrl.getOverview)
router.post('/totalpass/connect', validateRequest(s.connectTotalPassSchema), ...gate(MANAGE), ctrl.connectTotalPass)
router.put('/:provider/confirm-mode', validateRequest(s.confirmModeSchema), ...gate(MANAGE), ctrl.setConfirmMode)
router.put('/:provider/products', validateRequest(s.productLinksSchema), ...gate(MANAGE), ctrl.setProductLinks)
// Sin candado de plan: un negocio que lo perdió siempre puede apagar la integración (si no, TotalPass le seguiría mandando
// socios y sólo podría apagarla desde el portal del proveedor). Al bajar de plan aplica la pausa suave (no se publican
// clases nuevas; lo ya publicado sigue).
router.post('/:provider/disconnect', validateRequest(s.providerOnlySchema), checkPermission(MANAGE), ctrl.disconnect)
router.get('/capacity', validateRequest(s.overviewSchema), ...gate(READ), ctrl.getCapacity)
router.put('/capacity/default', validateRequest(s.defaultCapSchema), ...gate(MANAGE), ctrl.setDefaultCap)
router.post('/capacity/weekly', validateRequest(s.weeklyCapSchema), ...gate(MANAGE), ctrl.upsertWeeklyCap)
router.delete('/capacity/rules/:ruleId', validateRequest(s.deleteRuleSchema), ...gate(MANAGE), ctrl.deleteRule)
router.put('/capacity/sessions/:classSessionId', validateRequest(s.sessionCapSchema), ...gate(MANAGE), ctrl.setSessionCap)
// Sin candado de plan (pausa suave, founder: «lo ya reservado se respeta y se valida»): las visitas que ya existen se ven y
// se resuelven. En ON_VENUE_CHECKIN una visita sin reserva sólo se confirma aquí; con el candado se perdía ese cobro.
router.get('/visits', validateRequest(s.listVisitsSchema), checkPermission(READ), ctrl.listVisits)
router.get('/visits/summary', validateRequest(s.visitsSummarySchema), checkPermission(READ), ctrl.visitsSummary)
router.post('/visits/:visitId/confirm', validateRequest(s.visitActionSchema), checkPermission(UPDATE), ctrl.confirmVisit)
router.post('/visits/:visitId/reject', validateRequest(s.visitActionSchema), checkPermission(UPDATE), ctrl.rejectVisit)

export default router
