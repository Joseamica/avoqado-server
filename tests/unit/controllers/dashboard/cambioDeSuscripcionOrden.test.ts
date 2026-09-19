/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #8): `PUT /venues/:venueId/features/:featureId/
 * subscription` modifica **Stripe primero** y la base después.
 *
 * Tres consecuencias medidas en el código:
 *
 *  1. **La colisión se descubre tarde.** `VenueFeature` tiene única `(venueId, featureId)`: si el
 *     negocio YA tiene una fila de la feature destino, el `update` revienta con P2002 — pero para
 *     entonces Stripe **ya cambió el precio de la suscripción**. El cliente queda pagando el plan
 *     nuevo con la base diciendo el viejo, y el error que ve no menciona ninguna de las dos cosas.
 *  2. **El `stripePriceId` local se queda viejo.** Se escribe `featureId` y `monthlyPrice`, no el
 *     precio: cualquier lectura posterior que se fíe de esa columna miente.
 *  3. **Si la escritura local falla, nadie se entera.** Sin una alerta explícita, la divergencia
 *     entre lo que Stripe cobra y lo que la base cree queda enterrada en un log de error genérico.
 *
 * Hoy sólo `PLAN_PRO` es vendible, así que los destinos posibles son pocos. Añadir catálogo —que es
 * justo el plan del modo modular— vuelve esta ruta inmediatamente más peligrosa.
 *
 * ⚠️ Declarado fuera de este arreglo (es diseño, no un parche): exigir una cotización aceptada y
 * comprobar que el cobro del cambio quedó pagado.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fuente = readFileSync(join(__dirname, '../../../../src/controllers/dashboard/venueFeature.dashboard.controller.ts'), 'utf8')

/** El cuerpo de `updateSubscription`, desde su firma hasta el siguiente `export`. */
function cuerpoDeUpdateSubscription(): string {
  const i = fuente.indexOf('updateSubscriptionPrice')
  expect(i).toBeGreaterThan(-1)
  // Las funciones de este controlador se declaran `export async function`, no `export const`.
  const desde = fuente.lastIndexOf('export async function', i)
  const hasta = fuente.indexOf('export async function', i)
  return fuente.slice(desde, hasta > 0 ? hasta : i + 2500)
}

describe('cambiar de suscripción no deja Stripe y la base en desacuerdo', () => {
  it('🔴 comprueba la colisión de la fila destino ANTES de tocar Stripe', () => {
    const cuerpo = cuerpoDeUpdateSubscription()
    const posComprobacion = cuerpo.search(/venueId_featureId|filaDestino|yaTieneDestino/)
    const posStripe = cuerpo.indexOf('updateSubscriptionPrice')
    expect(posComprobacion).toBeGreaterThan(-1)
    expect(posComprobacion).toBeLessThan(posStripe)
  })

  it('🔴 escribe también el `stripePriceId` nuevo: dejarlo viejo hace mentir a la fila', () => {
    expect(cuerpoDeUpdateSubscription()).toMatch(/stripePriceId:/)
  })

  it('🔴 si la escritura local falla DESPUÉS de cambiar Stripe, lo deja alertado, no enterrado', () => {
    // El símbolo 🚨 es la convención del repo para «esto necesita que alguien mire».
    expect(cuerpoDeUpdateSubscription()).toMatch(/🚨/)
  })
})
