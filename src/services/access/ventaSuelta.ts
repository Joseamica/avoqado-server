/**
 * 🔴 La venta de funciones SUELTAS está CERRADA (decisión del founder, 21-sep-2026, opción A: «hasta
 * que quede todo bien hecho»). La ronda 5 de Codex dejó cuatro caminos de cobro doble que sólo cierra
 * rediseñar la compra con una operación de contratación persistida por negocio: checkout de plan
 * abierto + compra suelta en medio, compra suelta durante el onboarding, plan suspendido que sigue
 * cobrando, y Stripe que crea la suscripción y pierde todas las respuestas. Hoy nadie compra sueltas.
 *
 * Se cierra en el SERVIDOR: en la RAÍZ (`createTrialSubscriptions` se niega a crear), en la compra y el
 * cambio suelta→suelta (409 `ALA_CARTE_SALES_CLOSED`), y las dos rutas legacy que vendían sueltas
 * (alta V1 y conversión de demo) las saltan. Los planes se siguen vendiendo. Reabrir
 * es cambiar esto a `true` en el MISMO cambio que traiga el rediseño. Es función, no constante, para
 * que las pruebas de los candados puedan probar la venta abierta.
 */
export function ventaSueltaAbierta(): boolean {
  return false
}
