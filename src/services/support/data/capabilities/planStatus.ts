import { getPlanState, nombresDeLosPlanesDeTuPlan } from '@/services/dashboard/planState.service'
import type { DataCapability } from '../catalog'
import { renderPlan, type PlanData } from '../planText'

/**
 * C5 · «Estado del plan»: lo que dice «Tu plan» en Facturación › Suscripciones del panel, leído con el mismo servicio que su ruta
 * (`getPlanState`, `GET /venues/:venueId/plan`) y escrito con el mismo árbol y las mismas frases (`PlanRow.tsx` y `billing.json` del
 * panel): fundador, Gratis, pago pendiente, problema de pago de un contrato, cortesía, deja de renovarse, primer cobro o se renueva.
 * Nunca un precio, un descuento ni una tarjeta: el renglón del descuento del panel (D5) son precios y aquí no sale. T-F16: el Plan Básico
 * como lo decide `basicNotice` del panel (`planActions.ts`): su contrato es el plan (con la etiqueta fija «Básico»: el nombre de su
 * publicación puede traer el precio, T-F19) y una prueba de Pro que termina sin cobrar dice cuándo termina; sus ofertas (contratarlo,
 * terminar Pro) son precios y no salen. Permisos y puesto
 * de la pantalla: `billing:read` y `billing:subscriptions:read`, dentro de `AdminProtectedRoute` (ADMIN y OWNER; la ruta del panel
 * pide `billing:subscriptions:read`). Sin candado de plan.
 */

/**
 * Lo que espera a Stripe: por debajo del tope de la lectura (`SUPPORT_DATA_QUERY_TIMEOUT_SECONDS`, 8 s por omisión y 5 como mínimo,
 * `SUPPORT_DATA_QUERY_TIMEOUT_MIN_SECONDS`). Así un Stripe que no contesta da el plan sin fecha, como el panel, y no «No pude leer ese
 * dato». Se exporta para que la prueba del config amarre los dos números.
 */
export const STRIPE_TIMEOUT_MS = 3_000

export const planStatus: DataCapability<Record<string, never>, PlanData> = {
  key: 'plan_status',
  label: 'el estado de tu plan',
  object: 'el estado del plan',
  aiHint:
    'Cómo está el plan de Avoqado de la sucursal: cuál tiene, si se renueva, si hay un pago pendiente o si está por terminar. Sin precios.',
  permissions: ['billing:read', 'billing:subscriptions:read'],
  roles: ['ADMIN', 'OWNER'],
  params: () => ({ ok: true, value: {} }),
  read: async scope => ({
    ...(await getPlanState(scope.venueId, { skipPauseOffer: true, stripeTimeoutMs: STRIPE_TIMEOUT_MS })),
    // B4: el nombre de cada plan es el de la versión vigente (nunca falla: sin versión, el de hoy)
    nombres: await nombresDeLosPlanesDeTuPlan(),
  }),
  render: (scope, _params, state) => renderPlan(scope, state),
}
