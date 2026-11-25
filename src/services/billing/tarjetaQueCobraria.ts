/**
 * Planes editables (B2, Task 6, §18): qué tarjeta cobraría Stripe al terminar una prueba, según Stripe en ESTE momento.
 *
 * 🔴 La única fuente de «qué tarjeta» del bloque: la usan la ventana del alta (al abrirse), la pantalla final y `progress`, la
 * bienvenida, «Tu plan» (Task 7) y los recordatorios (Task 9). Sólo informa: nada compara esta tarjeta al cobrar (§18, se avisa
 * en vez de impedir) y nadie la escribe aquí.
 *
 * La jerarquía con que Stripe elige qué cobrar en una suscripción: el método de la suscripción → su `default_source` → la predeterminada del cliente (`invoice_settings.default_payment_method`) → el `default_source` del
 * cliente. El PRIMERO que exista decide, y sólo cuenta si es una tarjeta: la suscripción del alta sólo admite `card`
 * (`payment_method_types: ['card']`), así que cualquier otro tipo es «sin tarjeta» (b2-r7 #3).
 */
import Stripe from 'stripe'
import logger from '@/config/logger'
import { stripeAfirmaQueNoExiste } from '@/services/stripe.service'
import { noHabraCobro } from './siguienteCobro'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/**
 * 🔴 El tope de cada lectura de este ayudante (fix round 1 de Task 6): 5 s y sin reintentos, el mismo de `suscripcionConTopeCorto`
 * (`stripe.service.ts`). Lo esperan respuestas (`GET /progress`, «Terminar», `activate-plan`, la ventana del alta): con el cliente
 * de siempre (80 s y 2 reintentos) un Stripe lento las colgaba minutos. Un tiempo agotado es un error como cualquier otro: quien
 * llama dice «no se sabe qué tarjeta» (`avisoDeLaPruebaSinTarjeta` omite el campo).
 */
export const LECTURA_ACOTADA = { timeout: 5_000, maxNetworkRetries: 0 } as const

export interface TarjetaQueCobraria {
  id: string
  tipo: 'payment_method' | 'source'
  brand: string | null
  last4: string | null
}

/** Lo que la pantalla y los correos dicen de esa tarjeta (sin su id). */
export type TarjetaVisible = { brand: string | null; last4: string | null }

/** Una lectura que Stripe contesta «no existe» es «no hay tarjeta ahí»; cualquier otro error sube («no pude ver» ≠ «no existe»). */
async function leerOMuerto<T>(lectura: () => Promise<T>): Promise<T | null> {
  try {
    return await lectura()
  } catch (error) {
    if (stripeAfirmaQueNoExiste(error)) return null
    throw error
  }
}

async function delMetodo(ref: string | Stripe.PaymentMethod): Promise<TarjetaQueCobraria | null> {
  const metodo = typeof ref === 'string' ? await leerOMuerto(() => stripe.paymentMethods.retrieve(ref, {}, LECTURA_ACOTADA)) : ref
  if (!metodo || metodo.type !== 'card') return null
  return { id: metodo.id, tipo: 'payment_method', brand: metodo.card?.brand ?? null, last4: metodo.card?.last4 ?? null }
}

/** Una fuente (la API vieja): una `card` (`card_…`) o un `source` de tipo `card` (`src_…`). Una cuenta de banco no cuenta. */
async function deLaFuente(ref: string | Stripe.CustomerSource, customerId: string): Promise<TarjetaQueCobraria | null> {
  const fuente =
    typeof ref === 'string' ? await leerOMuerto(() => stripe.customers.retrieveSource(customerId, ref, {}, LECTURA_ACOTADA)) : ref
  if (!fuente) return null
  const f = fuente as {
    id: string
    object?: string
    type?: string
    brand?: string | null
    last4?: string | null
    card?: { brand?: string | null; last4?: string | null } | null
  }
  if (f.object === 'card') return { id: f.id, tipo: 'source', brand: f.brand ?? null, last4: f.last4 ?? null }
  if (f.object === 'source' && f.type === 'card')
    return { id: f.id, tipo: 'source', brand: f.card?.brand ?? null, last4: f.card?.last4 ?? null }
  return null
}

/**
 * La tarjeta que cobraría Stripe: la de la jerarquía, o `null` («sin tarjeta»). Sin `sub` (la ventana del alta, antes de abrir
 * la prueba) decide el cliente. Un cliente borrado es `null`. Un método o una fuente que Stripe ya no tiene, también; cualquier
 * otro error de Stripe sube.
 */
export async function tarjetaQueCobraria(args: {
  sub?: Stripe.Subscription | null
  customer: Stripe.Customer | Stripe.DeletedCustomer
}): Promise<TarjetaQueCobraria | null> {
  const { sub, customer } = args
  if (!customer || (customer as Stripe.DeletedCustomer).deleted === true) return null
  const cliente = customer as Stripe.Customer
  if (sub?.default_payment_method) return delMetodo(sub.default_payment_method)
  if (sub?.default_source) return deLaFuente(sub.default_source, cliente.id)
  const predeterminado = cliente.invoice_settings?.default_payment_method
  if (predeterminado) return delMetodo(predeterminado)
  if (cliente.default_source) return deLaFuente(cliente.default_source, cliente.id)
  return null
}

/**
 * El cliente de Stripe si existe (b2-r9 #4): `null` sin id (sin llamar a Stripe), con `deleted: true` o si Stripe dice que no
 * existe. Cualquier otro error sube. 🔴 Todo el que lee el cliente para `tarjetaQueCobraria` pasa por aquí: un cliente borrado es
 * «sin cliente», nunca «un cliente sin tarjeta» que luego se reusa.
 */
export async function clienteDeStripeVivo(customerId: string | null): Promise<Stripe.Customer | null> {
  if (!customerId) return null
  const cliente = await leerOMuerto(() =>
    stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method', 'default_source'] }, LECTURA_ACOTADA),
  )
  if (cliente === null || (cliente as Stripe.DeletedCustomer | undefined)?.deleted === true) return null
  return cliente as Stripe.Customer
}

const idDe = (valor: string | { id: string } | null | undefined): string | null => (typeof valor === 'string' ? valor : (valor?.id ?? null))

/**
 * Lo que la respuesta, la pantalla final y `progress` dicen de una prueba SIN tarjeta (b2-r8 #9, b2-r9 #7), leído de Stripe ahora:
 * - `noHabraCobro`: al terminar la prueba no se cobrará (cancelación programada o cobranza en pausa), la misma regla de «Tu
 *   plan» y los recordatorios;
 * - `tarjetaQueCobrara`: la tarjeta que Stripe cobraría, o `null`. Si Stripe no deja leerla (error o tiempo agotado,
 *   `LECTURA_ACOTADA`), el campo NO viaja: «no se sabe», porque decir «sin tarjeta» sería falso si la tiene. Lo demás que ya se
 *   leyó (la modalidad, `noHabraCobro`) se queda: nunca lanza.
 */
export async function avisoDeLaPruebaSinTarjeta(
  sub: Stripe.Subscription,
  customerId: string | null = idDe(sub.customer as string | { id: string } | null),
): Promise<{ tarjetaQueCobrara?: TarjetaVisible | null; noHabraCobro: boolean }> {
  const fin = typeof sub.trial_end === 'number' ? sub.trial_end * 1000 : Date.now()
  const aviso = { noHabraCobro: noHabraCobro(sub, fin) }
  try {
    const cliente = await clienteDeStripeVivo(customerId)
    const tarjeta = cliente ? await tarjetaQueCobraria({ sub, customer: cliente }) : null
    return { ...aviso, tarjetaQueCobrara: tarjeta ? { brand: tarjeta.brand, last4: tarjeta.last4 } : null }
  } catch (error) {
    logger.warn('prueba sin tarjeta: no se pudo leer qué tarjeta cobraría Stripe; se omite', {
      subscriptionId: sub.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return aviso
  }
}
