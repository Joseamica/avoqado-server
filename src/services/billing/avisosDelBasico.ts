/**
 * Plan Básico (17-nov): las piezas que comparten los avisos al cliente — el job `plan-renewal-reminder` y el webhook de
 * Stripe. Ninguna anuncia un cobro: el de un cobro sigue siendo `sendPlanRenewalReminderEmail` con el monto de la vista
 * previa (`montoDelSiguienteCobro`); aquí sólo se decide la ALTERNATIVA del Básico y los avisos SIN cobro.
 *
 * - «Tu prueba terminó» / «Tu Pro terminó» (`avisarPlanTerminado`): una sola vez por suscripción. Lo que dice «ya salió»
 *   es el `ActivityLog` `PLAN_ENDED_NOTICE_SENT` (R19); `VenueFeature.renewalReminderSentAt` ≥ el fin real (`ended_at`)
 *   es sólo el apartado entre dos que corren a la vez (el recordatorio de cobro sella ANTES del fin). Sin migración.
 * - Los avisos SIN cobro se pueden apagar (categoría `PLAN` → `TIPO_AVISOS_SIN_COBRO`, preferencia del dueño) y llevan
 *   baja en un clic. El aviso de un cobro no se apaga.
 */
import type Stripe from 'stripe'
import { NotificationChannel } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import emailService, { type PlanNoticeUnsubscribe, type PlanRenewalReminderEmailData } from '@/services/email.service'
import { resolvePlanNotificationTarget } from '@/services/access/planNotification.service'
import { signUnsubscribeToken } from '@/utils/unsubscribeToken'
import { billingPageUrl } from '@/utils/dashboardLinks'
import { subscriptionPeriod } from '@/utils/stripeSubscriptionPeriod'
import { BASE_URL, FRONTEND_URL } from '@/config/env'
import { OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import { BASIC_PLAN_DEFINITION_WHERE } from '@/services/launchCampaigns/basicPlanAccess'
import { TIPO_AVISOS_SIN_COBRO } from '@/services/notifications/avisosSinCobro'
import { descuentoDelPlan } from './descuentoDelPlan'
import { versionQueCobra } from './planOffer'
import { isLastDiscountedPeriod, type SuscripcionConDescuento } from './ultimoPeriodoConDescuento'

/** Holgura entre `ended_at` y el fin que se esperaba (Stripe borra en el segundo del fin; un reloj de prueba, igual). */
const HOLGURA_S = 3600

/**
 * El Básico publicado hoy, o `null` (sin publicar, o no se pudo leer: entonces no se ofrece, nunca se inventa un precio).
 *
 * Planes editables (B2, Task 9, b2-r2 #10): con una versión del editor (`versionQueCobra()`) el Básico ya no está a la venta, así
 * que es `null` y los avisos («Tu prueba termina», «Tu Pro terminó», el fin de prueba de Stripe) salen con su texto de hoy sin él.
 * Sin versión del editor, lo de hoy. Si leer la oferta falla (b2-r9 #8: p. ej. una v1 que no pasa el esquema), también lo de hoy:
 * leer la oferta nunca tumba un aviso. `getPublicBasicPlan` no cambia.
 */
export async function basicoPublicado() {
  try {
    if ((await versionQueCobra()) !== null) return null
  } catch (error) {
    logger.warn('avisosDelBasico: no se pudo leer la oferta de los planes; el aviso sigue como hoy', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  try {
    // Import diferido: el catálogo híbrido no tiene por qué cargarse con el job ni con el webhook.
    const { getPublicBasicPlan } = await import('@/services/launchCampaigns/hybridCampaign.service')
    return await getPublicBasicPlan()
  } catch (error) {
    logger.warn('avisosDelBasico: no se pudo leer el Plan Básico publicado; el aviso va sin el Básico', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** Precio del Básico sin IVA en centavos, SÓLO para escribirlo («$499 + IVA»). */
export function precioSinIvaCents(basico: { priceWithoutTax: string }): number {
  return Math.round(Number(basico.priceWithoutTax) * 100)
}

/** La preferencia que apaga estos avisos: ver `notifications/avisosSinCobro.ts` (nunca `SUBSCRIPTION_TRIAL_ENDING`). */
export { TIPO_AVISOS_SIN_COBRO }

/** `true` si el dueño apagó estos avisos por correo (fila apagada o sin EMAIL de `TIPO_AVISOS_SIN_COBRO`; sin fila = prendido). */
export async function avisoDelPlanApagado(staffId: string | null | undefined, venueId: string): Promise<boolean> {
  if (!staffId) return false
  const pref = await prisma.notificationPreference.findUnique({
    where: { staffId_venueId_type: { staffId, venueId, type: TIPO_AVISOS_SIN_COBRO } },
    select: { enabled: true, channels: true },
  })
  return !!pref && (pref.enabled === false || !pref.channels.includes(NotificationChannel.EMAIL))
}

/** Liga de baja en un clic firmada para el dueño; sin dueño, sin liga. */
export function bajaDelAviso(
  staffId: string | null | undefined,
  venueId: string,
  venueSlug?: string | null,
): PlanNoticeUnsubscribe | undefined {
  if (!staffId) return undefined
  const token = signUnsubscribeToken({ staffId, venueId, category: 'PLAN' })
  return {
    url: `${BASE_URL || 'http://localhost:3000'}/api/v1/public/unsubscribe?token=${token}`,
    preferencesUrl: venueSlug ? `${FRONTEND_URL}/venues/${encodeURIComponent(venueSlug)}/notifications/preferences` : FRONTEND_URL,
  }
}

/**
 * El descuento vigente de una suscripción en bruto, en la forma de `isLastDiscountedPeriod`. Sin descuento no hay otra
 * llamada; con uno, se relee con el cupón expandido (sin él `discounts` sólo trae ids). `null` = no se supo: quien llama
 * NO ofrece el Básico (nunca lo ofrece a quien todavía tiene meses con descuento).
 */
export async function leerDescuento(stripe: Stripe, sub: Stripe.Subscription): Promise<SuscripcionConDescuento | null> {
  const raw = sub as unknown as { discounts?: unknown[]; discount?: unknown }
  const currentPeriodEnd = subscriptionPeriod(sub).end
  if (!(Array.isArray(raw.discounts) && raw.discounts.length > 0) && !raw.discount) return { descuento: null, currentPeriodEnd }
  try {
    const expandida = await stripe.subscriptions.retrieve(sub.id, { expand: ['discounts.source.coupon.applies_to'] })
    const product = expandida.items?.data?.[0]?.price?.product as string | { id?: string } | null | undefined
    const productId = typeof product === 'string' ? product : (product?.id ?? null)
    const currentPeriodEndExpandida = subscriptionPeriod(expandida).end
    const leida = expandida as unknown as { discounts?: unknown[]; discount?: unknown }
    if (!(Array.isArray(leida.discounts) && leida.discounts.length > 0) && !leida.discount) {
      return { descuento: null, currentPeriodEnd: currentPeriodEndExpandida } // se quitó entre las dos lecturas
    }
    // 🔴 Hay descuento pero no se entiende (dos apilados, `amount_off` en otra moneda, otra forma): DESCONOCIDO, nunca «sin
    // descuento» (revisión de Task 6, hallazgo 2) — si no, se ofrecería terminar Pro con meses baratos por delante.
    const descuento = descuentoDelPlan(expandida as never, productId)
    if (!descuento) {
      logger.warn('avisosDelBasico: descuento que no se entiende; sin el bloque del Básico', { subscriptionId: sub.id })
      return null
    }
    return { descuento, currentPeriodEnd: currentPeriodEndExpandida }
  } catch (error) {
    logger.warn('avisosDelBasico: no se pudo leer el descuento; sin el bloque del Básico', {
      subscriptionId: sub.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * El bloque «¿Prefieres el Básico?» del aviso de un cobro de `PLAN_PRO` mensual, o `undefined`:
 * - `DISCOUNT_ENDS` («Tu Pro sube»): suscripción activa con descuento y el próximo cobro es el primero sin él.
 * - `TRIAL_ENDS` (`trial_will_end` de un Pro normal): en prueba, y sin meses con descuento por delante.
 * Premium, anual, sin Básico publicado o descuento desconocido → sin bloque. Quien llama ya descartó «no habrá cobro».
 */
export async function ofertaDelBasico(
  stripe: Stripe,
  sub: Stripe.Subscription,
  featureCode: string | null | undefined,
  reason: 'DISCOUNT_ENDS' | 'TRIAL_ENDS',
  now: Date,
): Promise<PlanRenewalReminderEmailData['basicOffer']> {
  if (featureCode !== 'PLAN_PRO' || sub.items?.data?.[0]?.price?.recurring?.interval !== 'month') return undefined
  if (sub.status !== (reason === 'TRIAL_ENDS' ? 'trialing' : 'active')) return undefined
  const proy = await leerDescuento(stripe, sub)
  if (!proy || !isLastDiscountedPeriod(proy, now)) return undefined
  if (reason === 'DISCOUNT_ENDS' && !proy.descuento) return undefined
  const basico = await basicoPublicado()
  return basico ? { priceWithoutTaxCents: precioSinIvaCents(basico), reason } : undefined
}

/**
 * Cómo terminó una suscripción BORRADA, si terminó SIN cobro: `TRIAL` = borrada al fin de la prueba con la cancelación
 * programada (venga del alta con Básico o de «Prefiero el Básico»; nunca de la metadata), `PRO` = un Pro pagado que se
 * acabó al fin de su periodo con la cancelación programada. Cualquier otra cosa (cancelada de golpe, por falta de pago) →
 * `null`: no es «terminó sin cobro».
 */
export function comoTermino(sub: Stripe.Subscription): 'TRIAL' | 'PRO' | null {
  const s = sub as unknown as {
    status?: string
    ended_at?: number | null
    trial_end?: number | null
    cancel_at?: number | null
    cancel_at_period_end?: boolean | null
    cancellation_details?: { reason?: string | null } | null
  }
  if (s.status !== 'canceled' || typeof s.ended_at !== 'number') return null
  if (s.cancellation_details?.reason === 'payment_failed' || s.cancellation_details?.reason === 'payment_disputed') return null
  const cerca = (t: number | null | undefined) => typeof t === 'number' && Math.abs(s.ended_at! - t) <= HOLGURA_S
  const programada = s.cancel_at_period_end === true || cerca(s.cancel_at)
  if (!programada) return null
  if (cerca(s.trial_end)) return 'TRIAL'
  const fin = subscriptionPeriod(sub).end
  return fin && cerca(fin.getTime() / 1000) ? 'PRO' : null
}

/** El registro durable de «el aviso final ya salió» (R19): uno por suscripción y fin. */
export const AVISO_ENVIADO = 'PLAN_ENDED_NOTICE_SENT'
/** Un apartado sin registro de envío más viejo que esto es de un proceso que murió entre apartar y mandar. */
const APARTADO_ABANDONADO_MS = 3600_000

/** ¿Ya hay registro del aviso final de esta suscripción y este fin? Una lectura acotada (findFirst por la fila). */
async function yaSeAviso(venueId: string, venueFeatureId: string, subscriptionId: string, endedAt: Date): Promise<boolean> {
  const hit = await prisma.activityLog.findFirst({
    where: {
      venueId,
      action: AVISO_ENVIADO,
      entity: 'VenueFeature',
      entityId: venueFeatureId,
      AND: [{ data: { path: ['subscriptionId'], equals: subscriptionId } }, { data: { path: ['endedAt'], equals: endedAt.toISOString() } }],
    },
    select: { id: true },
  })
  return !!hit
}

/**
 * «Tu prueba terminó» / «Tu Pro terminó», UNA vez por suscripción, aunque lleguen el webhook, sus repeticiones y el job.
 * R19: «ya salió» = el `ActivityLog` `PLAN_ENDED_NOTICE_SENT` de esta suscripción y fin, escrito tras entregar. El
 * sello `renewalReminderSentAt` sólo aparta entre dos que corren a la vez; cualquier falla antes de entregar lo suelta,
 * y uno abandonado (> 1 h, sin registro) se reintenta, siempre con la misma llave de Resend. Nunca lanza.
 */
export async function avisarPlanTerminado(sub: Stripe.Subscription): Promise<boolean> {
  const kind = comoTermino(sub)
  if (!kind) return false
  try {
    const endedAt = new Date((sub as unknown as { ended_at: number }).ended_at * 1000)
    const vf = await prisma.venueFeature.findFirst({
      where: { stripeSubscriptionId: sub.id, feature: { code: 'PLAN_PRO' } },
      select: { id: true, venueId: true, renewalReminderSentAt: true, venue: { select: { slug: true, status: true } } },
    })
    if (!vf || !OPERATIONAL_VENUE_STATUSES.includes(vf.venue.status)) return false
    // R19: «¿ya salió?» lo dice SÓLO el registro durable del envío, nunca el sello (que es apenas el apartado).
    if (await yaSeAviso(vf.venueId, vf.id, sub.id, endedAt)) return false
    // «Quedaste en Gratis» sólo si es verdad: si otro plan (fila de plan vigente, contrato de campaña con plan o el Básico)
    // ya cubre al negocio —p. ej. una compra que reemplazó a esta suscripción al fin de su periodo—, no se dice nada.
    const [otraFila, otroContrato] = await Promise.all([
      prisma.venueFeature.count({
        where: {
          venueId: vf.venueId,
          active: true,
          feature: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
          NOT: { stripeSubscriptionId: sub.id },
        },
      }),
      prisma.hybridContract.count({
        where: {
          venueId: vf.venueId,
          endedAt: null,
          OR: [{ planTier: { not: null } }, { publication: { definition: BASIC_PLAN_DEFINITION_WHERE } }],
        },
      }),
    ])
    if (otraFila > 0 || otroContrato > 0) return false

    const target = await resolvePlanNotificationTarget(vf.venueId)
    if (!target.email) {
      logger.warn('avisosDelBasico: plan terminado sin destinatario; sin aviso', { venueId: vf.venueId, subscriptionId: sub.id })
      return false
    }
    // Antes del apartado: si esta lectura falla, no queda nada apartado.
    const apagado = await avisoDelPlanApagado(target.staffId, vf.venueId)

    // El sello es sólo el APARTADO entre dos que corren a la vez (webhook y respaldo). Se aparta si está libre, si es
    // de antes del fin (el recordatorio de cobro), o si quedó abandonado (más de 1 h sin registro de envío: el proceso
    // murió entre apartar y mandar). Nunca antes del fin: un reloj atrasado lo dejaría como «de antes del fin».
    const ahora = Date.now()
    const sello = new Date(Math.max(ahora, endedAt.getTime()))
    const apartado = await prisma.venueFeature.updateMany({
      where: {
        id: vf.id,
        OR: [
          { renewalReminderSentAt: null },
          { renewalReminderSentAt: { lt: endedAt } },
          { renewalReminderSentAt: { lt: new Date(ahora - APARTADO_ABANDONADO_MS) } },
        ],
      },
      data: { renewalReminderSentAt: sello },
    })
    if (apartado.count !== 1) return false // otro lo apartó hace menos de 1 h
    let listo = false
    try {
      // Apagado por el dueño: no se manda, pero queda registrado como resuelto (no hay nada que reintentar).
      if (!apagado) {
        const basico = await basicoPublicado()
        // R20: justo antes de mandar se vuelve a comprobar. Si este proceso se atoró más de 1 h, otro pudo tomar el
        // apartado, mandar y registrarlo: entonces éste ya no manda (y no suelta lo que ya no es suyo).
        if (await yaSeAviso(vf.venueId, vf.id, sub.id, endedAt)) return false
        const sigueSiendoMio = await prisma.venueFeature.updateMany({
          where: { id: vf.id, renewalReminderSentAt: sello },
          data: { renewalReminderSentAt: sello },
        })
        if (sigueSiendoMio.count !== 1) return false
        // Siempre la misma llave: Resend junta los reintentos de 24 h en una sola entrega.
        listo = await emailService.sendPlanEndedEmail(target.email, {
          locale: target.locale,
          venueName: target.venueName,
          kind,
          billingUrl: billingPageUrl(vf.venue.slug),
          ...(basico ? { basicPlanPriceWithoutTaxCents: precioSinIvaCents(basico) } : {}),
          unsubscribe: bajaDelAviso(target.staffId, vf.venueId, vf.venue.slug),
          idempotencyKey: `plan-termino:${sub.id}`,
        })
      } else listo = true
    } finally {
      // Cualquier falla antes o durante el envío suelta el apartado (CAS sobre el sello propio): el respaldo reintenta.
      if (!listo)
        await prisma.venueFeature.updateMany({
          where: { id: vf.id, renewalReminderSentAt: sello },
          data: { renewalReminderSentAt: vf.renewalReminderSentAt },
        })
    }
    if (!listo) return false
    // ponytail: si el correo salió y ESTE registro falla, el apartado queda y a la hora se toma por abandonado; un
    // reintento dentro de 24 h lo junta la llave de Resend, uno después de 24 h manda UN duplicado. Aceptado (R19).
    try {
      await prisma.activityLog.create({
        data: {
          venueId: vf.venueId,
          action: AVISO_ENVIADO,
          entity: 'VenueFeature',
          entityId: vf.id,
          data: { subscriptionId: sub.id, kind, endedAt: endedAt.toISOString(), ...(apagado ? { muted: true } : {}) },
        },
      })
    } catch (error) {
      logger.error('avisosDelBasico: el aviso salió pero no se registró; un reintento tardío podría repetirlo', {
        subscriptionId: sub.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return true
  } catch (error) {
    logger.error('avisosDelBasico: falló el aviso de plan terminado', {
      subscriptionId: sub.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
