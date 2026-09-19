/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #7): el carril de cobro VIEJO sigue vivo y puede
 * cobrar OTRO precio, sin llave de idempotencia.
 *
 * `completeV2Onboarding` conserva su propia llamada a `createPlanSubscription` con la promoción
 * legacy de $694.84. Dos problemas medidos:
 *
 *  1. **Sin `idempotencyKey`.** Es el único parámetro que hace segura la política de reintentos de
 *     Stripe: sin él, una petición perdida en la red y reintentada crea DOS suscripciones y DOS
 *     cobros. El carril nuevo (`activate-plan`) sí la manda; éste no.
 *  2. **No mira la campaña.** Un negocio que llegó por POS22 tiene su oferta reclamada en
 *     `progress.launchCampaignId`; si termina el alta por este camino, se le cobra el precio
 *     legacy en vez del suyo — y la redención de su campaña queda sin aplicar.
 *
 * El guard de `IN_PROGRESS` no cubre esto: protege del cobro SIMULTÁNEO, no del cobro por el
 * carril equivocado ni del reintento sin llave.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fuente = readFileSync(join(__dirname, '../../../../src/controllers/onboarding.controller.ts'), 'utf8')

/** El bloque del carril legacy: desde su guard hasta el cierre de `createPlanSubscription`. */
function bloqueDelCobroLegacy(): string {
  const i = fuente.indexOf('if (planEnabled && !planYaCobrado')
  expect(i).toBeGreaterThan(-1)
  return fuente.slice(i, i + 3500)
}

describe('el carril de cobro legacy no compite con la oferta de campaña', () => {
  it('🔴 manda llave de idempotencia: sin ella un reintento cobra DOS veces', () => {
    expect(bloqueDelCobroLegacy()).toMatch(/idempotencyKey/)
  })

  it('🔴 NO cobra si el negocio tiene una campaña reclamada: ese cobro es de `activate-plan`', () => {
    // La condición de entrada tiene que excluir explícitamente a quien trae oferta, o le cobraría
    // el precio legacy y dejaría su redención sin aplicar.
    // Se mira la condición Y lo que la precede: la señal puede declararse en una constante justo
    // antes del `if`, que es igual de válido y más legible.
    const i = fuente.indexOf('if (planEnabled && !planYaCobrado')
    const condicion = fuente.slice(Math.max(0, i - 600), i + 400)
    expect(condicion).toMatch(/launchCampaignId/)
    // Y la señal tiene que entrar de verdad en la condición, no quedarse declarada sin usar.
    const soloElIf = fuente.slice(i, fuente.indexOf('{', i))
    expect(soloElIf).toMatch(/traeCampanaReclamada|launchCampaignId/)
  })
})
