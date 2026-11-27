/**
 * D2 (Codex r1 #2 y r2 #1, spec §6.4 b): ¿la PRIMERA factura de la suscripción quedó pagada por el monto que el cliente
 * consintió?
 *
 * El estado de la suscripción no lo prueba: `active` admite una primera factura de $0, y lo que se acepta como cobrado
 * incluye `trialing`, `past_due` y `unpaid`. Se exigen cuatro cosas de la factura `subscription_create` (la PRIMERA, no
 * `latest_invoice`: a los 40 días ésa ya es una renovación):
 *  1. `status === 'paid'`;
 *  2. `total === esperadoCents`: el total DESPUÉS del cupón y ANTES del saldo a favor (sin el cupón serían $1,158.84).
 *     Planes editables B2 (b2-r9 #1): un total MENOR también cuenta, pero sólo si la diferencia es EXACTAMENTE la suma de
 *     `total_discount_amounts[].amount` de esa factura (lo que Stripe declara como descuento: con `discounts` explícitos un
 *     cupón del cliente puede aplicarse igual, y un descuento sólo baja el precio). Un total MAYOR nunca cuenta;
 *  3. cobertura completa con pago + saldo VÁLIDO del `total` cobrado, leída con el MISMO lector con que la regla común valida
 *     el saldo híbrido (`assertHybridBalanceUsable`): un saldo que sale de un pago reembolsado o en disputa no cuenta.
 *     🔴 Nunca `amount_paid`: Stripe aplica primero el saldo a favor ($10 = $4 de saldo + $6 de tarjeta ⇒ `amount_paid: 600`).
 *  4. nada devuelto (Ruling 6a): un primer cobro reembolsado, aunque sea en parte, no prueba el pago (la regla hermana de la
 *     entrega híbrida, `hybridPeriodInvalid`, da por inválido un periodo devuelto).
 *
 * Los errores del lector (`HYBRID_FUNDING_UNVERIFIED`) y de Stripe se propagan: «no pude ver» nunca es «pagado».
 */
import { Decimal } from '@prisma/client/runtime/library'
import { stripe } from '@/services/stripe.service'
import { fromStripeAmount } from '@/services/payments/providers/money'
import { hybridFundingReader } from '@/services/launchCampaigns/hybridFundingGraph'

export async function primerCobroCubierto(venueId: string, subscriptionId: string, esperadoCents: number): Promise<boolean> {
  const { data } = await stripe.invoices.list({ subscription: subscriptionId, limit: 100 })
  // ponytail: sólo las 100 facturas más nuevas; con más, la primera no se ve y se responde «no se pudo verificar» (503).
  const primera = data.find(factura => factura.billing_reason === 'subscription_create')
  if (!primera) throw new Error(`no se pudo verificar la primera factura de la suscripción ${subscriptionId}`)
  if (primera.status !== 'paid' || !totalConsentido(primera, esperadoCents)) return false
  const cobertura = await hybridFundingReader(venueId).invoice(primera)
  return (
    new Decimal(cobertura.funded).eq(fromStripeAmount(primera.total)) &&
    new Decimal(cobertura.refunded).isZero() &&
    !cobertura.disputed &&
    !cobertura.impaired
  )
}

/** El total de la factura es lo consentido: igual, o menor sólo por lo que la propia factura declara como descuento. */
function totalConsentido(
  factura: { total: number; total_discount_amounts?: Array<{ amount: number }> | null },
  esperadoCents: number,
): boolean {
  if (factura.total === esperadoCents) return true
  if (!(factura.total < esperadoCents)) return false
  const declarado = (factura.total_discount_amounts ?? []).reduce((suma, d) => suma + d.amount, 0)
  return esperadoCents - factura.total === declarado
}
