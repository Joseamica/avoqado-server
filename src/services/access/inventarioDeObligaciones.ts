/**
 * Inventario de lo que un NEGOCIO tiene vivo en Stripe (diseño v5 de la compra, V5-A paso 3, 22-sep-2026).
 *
 * Es la fuente de la regla común de compra: no el acceso local (un plan suspendido que sigue cobrando es una
 * obligación), sino lo que Stripe puede seguir cobrando. Recorre el cliente actual y los clientes de TODOS los
 * vínculos locales (una suscripción pudo quedar bajo otro cliente). Una lectura incompleta o un error es 503:
 * «no pude ver» nunca equivale a «no hay nada».
 *
 * Por qué no hace falta un historial de clientes: `stripeCustomerId` sólo pasa de nulo a valor por CAS
 * (`getOrCreateStripeCustomer`) y de valor a nulo con `customer.deleted`, y borrar un cliente en Stripe cancela sus
 * suscripciones. Lo que un cliente anterior pudiera tener vivo se alcanza por los vínculos locales.
 */
import type Stripe from 'stripe'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { stripe, stripeAfirmaQueNoExiste } from '@/services/stripe.service'
import { clasificarEstado, clasificarSuscripcion, type CatalogoDeCobro, type ObligacionViva } from './obligacionesDeCobro'

/** Topes de lectura. Topar NO es «no hay más»: es «no se pudo verificar», y responde 503. */
const TOPE_VINCULOS = 200
const TOPE_CLIENTES = 5
const TOPE_SUSCRIPCIONES_POR_CLIENTE = 1_000
const TOPE_CATALOGO = 1_000
// Corre bajo el candado de compra (Codex C3): tiempo propio y sin los reintentos del SDK (80 s × 2 por defecto).
const LECTURA = { timeout: 15_000, maxNetworkRetries: 0 } as const

export interface InventarioDeObligaciones {
  vivas: ObligacionViva[]
  detalle: Record<
    string,
    { status: string; customerId: string | null; variosItems: boolean; pausaDeCobranza: boolean; metodoDeCobro: string | null }
  >
  /**
   * Suscripciones con cambios PROGRAMADOS (`schedule`, `pending_update`): lo que venden mañana puede no ser lo de hoy, y
   * no se verifica aquí. La regla común bloquea mientras existan.
   */
  conCambiosProgramados: string[]
}

const incompleto = (motivo: string, cause?: unknown) =>
  Object.assign(
    new AppError(
      `No pudimos revisar todos los cobros de este negocio en Stripe (${motivo}). Inténtalo de nuevo en unos minutos.`,
      503,
      true,
      'OBLIGATIONS_UNVERIFIED',
    ),
    { cause },
  )

const idDe = (x: string | { id: string } | null | undefined): string | null => (typeof x === 'string' ? x : (x?.id ?? null))

export async function inventarioDeObligaciones(
  venueId: string,
  /** `limite` (ms desde epoch): pasado, no se hace ninguna llamada más a Stripe — la regla que lo llama tiene presupuesto. */
  opciones: { limite?: number } = {},
): Promise<InventarioDeObligaciones> {
  const sinTiempo = () => opciones.limite !== undefined && Date.now() > opciones.limite
  const aTiempo = () => {
    if (sinTiempo()) throw incompleto('se agotó el tiempo para revisar los cobros')
  }
  const [venue, vinculos, pendientes, funciones] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId }, select: { stripeCustomerId: true } }),
    prisma.venueFeature.findMany({
      where: { venueId, stripeSubscriptionId: { not: null } },
      select: { stripeSubscriptionId: true },
      orderBy: { id: 'asc' },
      take: TOPE_VINCULOS + 1,
    }),
    // 🔴 Codex C13: una obligación que quedó en CONFLICTO puede no tener fila (p. ej. se sustituyó su último vínculo) y vivir
    // bajo un cliente histórico: sin esto desaparecía de la autorización de compras aunque siguiera cobrando.
    prisma.billingObligationConflict.findMany({
      where: { venueId, status: 'PENDING' },
      select: { subscriptionId: true },
      orderBy: { createdAt: 'asc' },
      take: TOPE_VINCULOS + 1,
    }),
    prisma.feature.findMany({
      where: { stripeProductId: { not: null } },
      select: { code: true, stripeProductId: true },
      orderBy: { id: 'asc' },
      take: TOPE_CATALOGO + 1,
    }),
  ])
  if (vinculos.length > TOPE_VINCULOS) throw incompleto('demasiados vínculos locales')
  if (pendientes.length > TOPE_VINCULOS) throw incompleto('demasiados conflictos pendientes')
  const porConsultar = [...new Set([...vinculos.map(v => v.stripeSubscriptionId as string), ...pendientes.map(p => p.subscriptionId)])]
  if (funciones.length > TOPE_CATALOGO) throw incompleto('catálogo más grande de lo que se lee')

  const catalogo: CatalogoDeCobro = {
    productoAFuncion: Object.fromEntries(funciones.map(f => [f.stripeProductId as string, f.code])),
    productosAjenos: new Set(),
  }

  const vistas = new Map<string, Stripe.Subscription>()
  const clientes = new Set<string>()
  if (venue?.stripeCustomerId) clientes.add(venue.stripeCustomerId)

  // 1. Los vínculos locales y los conflictos pendientes, uno por uno: una suscripción pudo quedar bajo otro cliente.
  for (const id of porConsultar) {
    aTiempo()
    try {
      const s = await stripe.subscriptions.retrieve(id, {}, LECTURA)
      vistas.set(s.id, s)
      const cliente = idDe(s.customer as never)
      if (cliente) clientes.add(cliente)
    } catch (error) {
      if (stripeAfirmaQueNoExiste(error)) continue // Stripe AFIRMA que no existe: no es obligación
      throw incompleto('no se pudo consultar una suscripción ligada', error)
    }
  }
  if (clientes.size > TOPE_CLIENTES) throw incompleto('demasiados clientes de Stripe')

  // 2. Cada cliente, recorrido completo (también lo que nunca se ligó: un cobro completado aún sin entregar).
  for (const cliente of clientes) {
    aTiempo()
    let vistasDelCliente = 0
    let topado = false
    let fueraDeTiempo = false
    try {
      await stripe.subscriptions.list({ customer: cliente, status: 'all', limit: 100 }, LECTURA).autoPagingEach(s => {
        // 🔴 Codex R8: el presupuesto se revisa en CADA página, no sólo antes de empezar. `autoPagingEach` hace una
        // llamada de red por página, así que un cliente con muchas suscripciones se comía el presupuesto entero de la
        // regla mientras ésta ya tenía su candado tomado.
        if (sinTiempo()) {
          fueraDeTiempo = true
          return false
        }
        vistas.set(s.id, s)
        vistasDelCliente += 1
        if (vistasDelCliente > TOPE_SUSCRIPCIONES_POR_CLIENTE) {
          topado = true
          return false
        }
        return true
      })
    } catch (error) {
      throw incompleto('no se pudo listar las suscripciones del cliente', error)
    }
    if (fueraDeTiempo) throw incompleto('se agotó el tiempo para revisar los cobros')
    if (topado) throw incompleto('demasiadas suscripciones')
  }

  // 3. Lo no terminal se clasifica: qué vende cada ítem (lo desconocido se conserva como tal, y bloquea después).
  const vivas: ObligacionViva[] = []
  const detalle: InventarioDeObligaciones['detalle'] = {}
  const conCambiosProgramados: string[] = []
  for (const s of vistas.values()) {
    if (clasificarEstado(s.status) === 'TERMINAL') continue
    // `items` es una lista paginada: si no vinieron todos, no se puede afirmar qué vende.
    if (s.items?.has_more) throw incompleto('una suscripción con más renglones de los que se leyeron')
    if (s.schedule || s.pending_update) conCambiosProgramados.push(s.id)
    const items = (s.items?.data ?? []).map(it => ({
      priceId: it.price?.id ?? '',
      productId: idDe(it.price?.product as never) ?? '',
      lookupKey: it.price?.lookup_key ?? null,
    }))
    const { proyecciones, variosItems } = clasificarSuscripcion(items, catalogo)
    vivas.push({ subscriptionId: s.id, proyecciones })
    detalle[s.id] = {
      status: s.status,
      customerId: idDe(s.customer as never),
      variosItems,
      pausaDeCobranza: Boolean(s.pause_collection),
      metodoDeCobro: s.collection_method ?? null,
    }
  }
  return { vivas, detalle, conCambiosProgramados }
}
