/**
 * Planes editables (B2, Task 7, §17, §18): ¿a la prueba SIN tarjeta le falta la tarjeta, y cuál cobraría Stripe?
 *
 * Una prueba sin tarjeta se reconoce SIEMPRE por su metadata (`sinTarjeta: 'true'`, ruling P6); aquí sólo se decide, de una
 * suscripción, si todavía espera una tarjeta: sigue `trialing` y terminará cancelándose sin método (`missing_payment_method:
 * 'cancel'`). La tarjeta es la de la jerarquía de Stripe (`tarjetaQueCobraria`, Task 6; sólo cuenta una `card`). Sólo informa: nadie
 * escribe la tarjeta aquí ni la compara al cobrar (§18).
 */
import type Stripe from 'stripe'
import logger from '@/config/logger'
import { clienteDeStripeVivo, tarjetaQueCobraria, type TarjetaQueCobraria, type TarjetaVisible } from './tarjetaQueCobraria'

/** Cómo se lee el cliente de Stripe: `clienteDeStripeVivo` (Task 6); `null` = sin cliente (sin id, borrado o «no existe»). */
export type LeerCliente = (customerId: string | null) => Promise<Stripe.Customer | null>

const idDe = (valor: string | { id: string } | null | undefined): string | null => (typeof valor === 'string' ? valor : (valor?.id ?? null))

/** La prueba sigue viva y, si termina sin método, Stripe la cancela: todavía espera una tarjeta. */
function esperaTarjeta(sub: Stripe.Subscription): boolean {
  return sub.status === 'trialing' && sub.trial_settings?.end_behavior?.missing_payment_method === 'cancel'
}

/**
 * La tarjeta que cobraría Stripe. 🔴 Lee el cliente SÓLO si la suscripción no trae método propio: con él decide la suscripción (la
 * jerarquía nunca llega al cliente) y del cliente sólo hace falta su id, para leer una fuente (`default_source`) de la API vieja.
 */
async function tarjetaDe(sub: Stripe.Subscription, leerCliente: LeerCliente): Promise<TarjetaQueCobraria | null> {
  const customerId = idDe(sub.customer as string | { id: string } | null)
  if (sub.default_payment_method || sub.default_source) {
    return tarjetaQueCobraria({ sub, customer: { id: customerId ?? '', object: 'customer' } as Stripe.Customer })
  }
  const cliente = await leerCliente(customerId)
  // Un cliente borrado no tiene tarjeta.
  return cliente ? tarjetaQueCobraria({ sub, customer: cliente }) : null
}

/**
 * `true` sólo si la suscripción está `trialing`, terminará cancelándose sin método y Stripe no tiene una tarjeta con qué cobrarla
 * (también mira los `default_source`, b2-r6 #5). Una suscripción de hoy (con tarjeta, sin `cancel`) da `false` sin leer el cliente.
 * Un error de Stripe sube («no pude ver» no es «le falta»).
 */
export async function faltaTarjeta(sub: Stripe.Subscription, leerCliente: LeerCliente): Promise<boolean> {
  if (!esperaTarjeta(sub)) return false
  return (await tarjetaDe(sub, leerCliente)) === null
}

/** Lo que se leyó de la tarjeta de una prueba sin tarjeta viva. */
export interface TarjetaDeLaPrueba {
  faltaTarjeta: boolean
  tarjetaQueCobrara: TarjetaVisible | null
}

/**
 * Lo que «Tu plan» dice de una prueba sin tarjeta, de UNA lectura (`retrievePlanSubscription` con `conTarjeta`): si le falta la
 * tarjeta y cuál cobraría. Sólo lee mientras la prueba sigue `trialing` (terminada o ya cobrándose, la pantalla no la anuncia); el
 * cliente, con tope (`clienteDeStripeVivo` por default, `LECTURA_ACOTADA`). 🔴 Nunca lanza. `null` = no aplica (la prueba ya no
 * está `trialing`) o no se sabe (Stripe no dejó leer): «Tu plan» no dice ni «sin tarjeta» ni «con tarjeta».
 */
export async function tarjetaDeLaPrueba(
  sub: Stripe.Subscription,
  leerCliente: LeerCliente = clienteDeStripeVivo,
): Promise<TarjetaDeLaPrueba | null> {
  try {
    if (sub.status !== 'trialing') return null
    const tarjeta = await tarjetaDe(sub, leerCliente)
    return {
      faltaTarjeta: esperaTarjeta(sub) && tarjeta === null,
      tarjetaQueCobrara: tarjeta ? { brand: tarjeta.brand, last4: tarjeta.last4 } : null,
    }
  } catch (error) {
    logger.warn('prueba sin tarjeta: no se pudo leer qué tarjeta cobraría Stripe; «Tu plan» no la anuncia', {
      subscriptionId: sub?.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
