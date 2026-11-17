/**
 * Plan Renewal Reminder Job (Subscription Lifecycle Emails — Phase 1.5)
 *
 * Runs daily at 09:00 America/Mexico_City.
 *
 * Finds active PLAN_PRO / PLAN_PREMIUM VenueFeatures that have a Stripe subscription and emails
 * the venue's notification target a heads-up before the next charge (`diasParaAvisar`: 0 < days < 9).
 * With the per-period dedup the first send normally lands 8-9 days out (Visa: ≥7 days before the first
 * charge after a trial; LFPC 76 Bis VIII: ≥5); a failed run is retried by the next daily runs until the charge.
 * The amount is what Stripe will really charge (invoice preview), never the list price; without it nothing is
 * sent or stamped. A trialing subscription gets the "your trial ends" variant.
 *
 * 🔴 Second pass (D2, 5-nov-2026): plans the SUPERADMIN gave as a free trial («Dar días de prueba»: no Stripe, an
 * `endDate`) used to end without a word before it. They get `sendPlanFreeTrialEndingEmail` in the same window — no
 * charge to announce; it says the business goes to Gratis and to write to us, because Facturación shows the trial as
 * «de cortesía» and does not let them subscribe until it ends. Only when Facturación shows exactly that courtesy
 * (`getPlanState`), and only to an ACTIVE venue, so a paid plan, a contract, a grandfathered, closed or demo venue never
 * reads «pasas a Gratis». Dedup: `freeTrialNoticeFor` keeps the announced end DATE, so extending or shortening the trial
 * warns again with the new one; it never touches `renewalReminderSentAt`, the Stripe reminder's stamp.
 *
 * Dedup: `VenueFeature.renewalReminderSentAt` is stamped once per billing period.
 * A reminder is (re-)sent only if it was never sent OR the last send predates the
 * current Stripe billing period (`current_period_start`).
 *
 * Per `.claude/rules/cron-jobs.md`: the entry DB read is wrapped in
 * `retry(..., shouldRetryDbConnectionError)` to survive the top-of-hour P1001
 * connection stampede. Stripe calls, email sends and the per-row `update` stay
 * OUTSIDE the retry (they must never double-execute). Each venue is processed in
 * its own try/catch so one failure never aborts the batch; email failures are
 * non-blocking.
 */

import { CronJob } from 'cron'
import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { subscriptionPeriod } from '@/utils/stripeSubscriptionPeriod'
import emailService from '@/services/email.service'
import { resolvePlanNotificationTarget } from '@/services/access/planNotification.service'
import { montoDelSiguienteCobro, noHabraCobro } from '@/services/billing/siguienteCobro'
import { billingPageUrl } from '@/utils/dashboardLinks'
import { zonaValida } from '@/utils/datetime'
import { scheduleJob } from '../observability/jobContext'
import { getPlanState } from '@/services/dashboard/planState.service'
import { MARGEN_OFERTA_MS } from '@/services/billing/cobroDiferido'
import { modalidadDePrueba } from '@/services/billing/modalidadDePrueba'
import {
  avisarPlanTerminado,
  avisoDelPlanApagado,
  bajaDelAviso,
  basicoPublicado,
  comoTermino,
  ofertaDelBasico,
  precioSinIvaCents,
} from '@/services/billing/avisosDelBasico'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
const DIA_MS = 86400000
const PLAN_CODES = ['PLAN_PRO', 'PLAN_PREMIUM']
/** Página de la lectura de pruebas regaladas; se recorren TODAS las páginas de la ventana (hoy hay 1 prueba). */
export const TOPE_PRUEBAS = 200

/** Plan Básico: días hacia atrás en que el job todavía avisa «Tu prueba terminó» si el webhook no lo hizo. */
export const DIAS_RESPALDO_TERMINADO = 7

/** ¿Terminó SIN cobro (prueba o Pro pagado) en los últimos `DIAS_RESPALDO_TERMINADO` días? Lo de antes ya no se avisa. */
const terminoHacePoco = (sub: Stripe.Subscription, now: number) => {
  const endedAt = (sub as unknown as { ended_at?: number | null }).ended_at
  return comoTermino(sub) !== null && typeof endedAt === 'number' && endedAt * 1000 >= now - DIAS_RESPALDO_TERMINADO * DIA_MS
}

/** La fecha de calendario (YYYY-MM-DD) de un instante en la zona del negocio. */
function diaLocal(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone })
}

/**
 * Plan Básico: ¿toca hoy «Tu prueba termina» (prueba que termina SIN cobrar)? Dos avisos por prueba: el primero en la
 * ventana de siempre (normalmente 8–9 días antes) y otro el día anterior al fin, en el calendario del negocio. `sello` =
 * `VenueFeature.freeTrialNoticeFor`, cuándo salió el último (en una fila con Stripe esa columna no la usa nadie más: la
 * prueba regalada sólo lee filas sin suscripción). Nunca `renewalReminderSentAt`: si el dueño elige «Quedarme en Pro», el
 * aviso del cobro de Pro tiene que salir.
 */
export function tocaAvisoDePruebaSinCobro(
  sello: Date | null | undefined,
  periodStartMs: number,
  periodEndMs: number,
  nowMs: number,
  timeZone: string,
): 'PRIMERO' | 'ULTIMO' | null {
  // T6: una fila reutilizada de una cortesía trae SU sello (la fecha que se le anunció, a veces en el futuro). Sólo cuenta
  // un envío de ESTE periodo: este aviso sale con menos de 9 días por delante, así que su sello nunca es anterior a eso
  // (ni al inicio del periodo) ni posterior a ahora.
  const desde = Math.max(periodStartMs, periodEndMs - 9 * DIA_MS)
  if (!sello || sello.getTime() < desde || sello.getTime() > nowMs) return 'PRIMERO'
  const diaAntes = diaLocal(periodEndMs - DIA_MS, timeZone)
  return diaLocal(nowMs, timeZone) >= diaAntes && diaLocal(sello.getTime(), timeZone) < diaAntes ? 'ULTIMO' : null
}

/** `true` while the charge at `periodEndMs` is less than 9 days (and still in the future) away. */
export function diasParaAvisar(periodEndMs: number, nowMs: number): boolean {
  const dias = (periodEndMs - nowMs) / 86400000
  return dias > 0 && dias < 9
}

export class PlanRenewalReminderJob {
  private job: CronJob | null = null

  /**
   * Start the daily renewal-reminder cron (09:00 America/Mexico_City).
   */
  start(): void {
    this.job = scheduleJob('plan-renewal-reminder', '0 9 * * *', () => this.runNow(), null, true, 'America/Mexico_City')
    logger.info('🗓️ Plan Renewal Reminder Job started - runs daily at 9:00 AM')
  }

  /**
   * Stop the job.
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Plan Renewal Reminder Job stopped')
    }
  }

  /**
   * Manually trigger the job (for tests / ops).
   */
  async runNow(): Promise<void> {
    try {
      await this.run()
    } catch (e) {
      logger.error('❌ plan-renewal-reminder failed', e)
    }
    // Its own try: a Stripe-side failure above must not leave the free trials without their warning.
    try {
      await this.avisarPruebasSinTarjeta()
    } catch (e) {
      logger.error('❌ plan-renewal-reminder (pruebas sin tarjeta) failed', e)
    }
    try {
      await this.avisarPlanesTerminados()
    } catch (e) {
      logger.error('❌ plan-renewal-reminder (planes terminados) failed', e)
    }
  }

  /**
   * Plan Básico: respaldo de «Tu prueba terminó» / «Tu Pro terminó» cuando el webhook `customer.subscription.deleted` no
   * lo entregó (revisión final #3). Aquí, las filas de `PLAN_PRO` que el webhook ya apagó: la prueba terminó en los últimos
   * `DIAS_RESPALDO_TERMINADO` días sin el sello, o la fila se apagó en esos días (el Pro pagado no tiene otra fecha de
   * fin en la fila). Las que el webhook nunca apagó (siguen `active`) las toma `run()` con el estado real de Stripe. La
   * suscripción REAL decide si terminó sin cobro; `avisarPlanTerminado` sella una sola vez.
   */
  private async avisarPlanesTerminados(): Promise<void> {
    const now = Date.now()
    const desde = new Date(now - DIAS_RESPALDO_TERMINADO * DIA_MS)
    const pagina = (despues: string | null) =>
      retry(
        () =>
          prisma.venueFeature.findMany({
            take: TOPE_PRUEBAS,
            orderBy: { id: 'asc' },
            where: {
              active: false,
              stripeSubscriptionId: { not: null },
              feature: { code: 'PLAN_PRO' },
              OR: [
                {
                  trialEndDate: { gte: desde, lte: new Date(now) },
                  OR: [{ renewalReminderSentAt: null }, { renewalReminderSentAt: { lt: prisma.venueFeature.fields.trialEndDate } }],
                },
                { updatedAt: { gte: desde } },
              ],
              ...(despues ? { id: { gt: despues } } : {}),
            },
            select: { id: true, venueId: true, stripeSubscriptionId: true },
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'plan-renewal-reminder.planesTerminados.findMany',
        },
      )

    let enviados = 0
    let despues: string | null = null
    for (;;) {
      const filas = await pagina(despues)
      for (const vf of filas) {
        try {
          if (!vf.stripeSubscriptionId) continue
          const sub = await stripe.subscriptions.retrieve(vf.stripeSubscriptionId)
          if (!terminoHacePoco(sub, now)) continue
          const plan = await getPlanState(vf.venueId)
          if (plan.basicPlan?.active || (plan.origin && plan.origin.kind !== 'NONE')) continue
          if (await avisarPlanTerminado(sub)) enviados++
        } catch (err) {
          logger.error(`❌ ended-plan notice failed for venueFeature ${vf.id}`, {
            error: err instanceof Error ? err.message : 'Unknown error',
            venueFeatureId: vf.id,
          })
        }
      }
      const ultima = filas[filas.length - 1]
      if (filas.length < TOPE_PRUEBAS || !ultima) break
      despues = ultima.id
    }
    logger.info('✅ Ended-plan notice backup complete', { sent: enviados })
  }

  /**
   * Plan Básico: «Tu prueba termina» de una prueba de Pro que termina SIN cobrar. `true` si salió (o el dueño lo apagó y
   * quedó sellado). Nunca anuncia un cobro ni lee la vista previa.
   */
  private async avisarPruebaSinCobro(
    vf: {
      id: string
      venueId: string
      stripeSubscriptionId: string | null
      freeTrialNoticeFor?: Date | null
      venue?: { slug: string; timezone: string } | null
    },
    subId: string,
    periodStartMs: number,
    periodEndMs: number,
    now: number,
  ): Promise<boolean> {
    const timeZone = zonaValida(vf.venue?.timezone)
    const cual = tocaAvisoDePruebaSinCobro(vf.freeTrialNoticeFor, periodStartMs, periodEndMs, now, timeZone)
    if (!cual) return false
    const target = await resolvePlanNotificationTarget(vf.venueId)
    if (!target.email) {
      logger.warn(`trial-ends-free notice: no recipient for venue ${vf.venueId}; skipping`)
      return false
    }
    if (!(await avisoDelPlanApagado(target.staffId, vf.venueId))) {
      const basico = await basicoPublicado()
      const sent = await emailService.sendPlanTrialEndsFreeEmail(target.email, {
        locale: target.locale,
        venueName: target.venueName,
        trialEndsAt: new Date(periodEndMs),
        timeZone,
        billingUrl: billingPageUrl(vf.venue?.slug),
        ...(basico ? { basicPlanPriceWithoutTaxCents: precioSinIvaCents(basico) } : {}),
        unsubscribe: bajaDelAviso(target.staffId, vf.venueId, vf.venue?.slug),
        idempotencyKey: `prueba-termina:${subId}:${cual}`,
      })
      if (!sent) return false
    }
    await retry(
      () =>
        prisma.venueFeature.updateMany({
          where: { id: vf.id, stripeSubscriptionId: vf.stripeSubscriptionId },
          data: { freeTrialNoticeFor: new Date(now) },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'plan-renewal-reminder.pruebaSinCobro.stamp' },
    )
    return true
  }

  private async avisarPruebasSinTarjeta(): Promise<void> {
    const now = Date.now()
    // Sólo las que faltan por avisar para SU fecha (columna contra columna), y TODAS las páginas: las que se descartan
    // (fundador, contrato) no pueden tapar a las demás quedándose en la primera página (Codex r2). Por llave (endDate, id)
    // y no por `skip`: una fila sellada a media corrida sale del filtro y un `skip` se saltaría a la siguiente.
    const pagina = (despues: { endDate: Date; id: string } | null) =>
      retry(
        () =>
          prisma.venueFeature.findMany({
            take: TOPE_PRUEBAS,
            orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
            where: {
              active: true,
              stripeSubscriptionId: null,
              suspendedAt: null,
              endDate: { gt: new Date(now), lt: new Date(now + 9 * DIA_MS) },
              feature: { code: { in: PLAN_CODES } },
              // «Sigue funcionando con el plan Gratis» sólo es verdad en un negocio que opera: ni cerrado ni demo.
              venue: { status: 'ACTIVE' },
              AND: [
                // «Distinto de endDate» como menor O mayor: `not` no acepta una columna (lo rechaza Prisma al correr).
                {
                  OR: [
                    { freeTrialNoticeFor: null },
                    { freeTrialNoticeFor: { lt: prisma.venueFeature.fields.endDate } },
                    { freeTrialNoticeFor: { gt: prisma.venueFeature.fields.endDate } },
                  ],
                },
                ...(despues ? [{ OR: [{ endDate: { gt: despues.endDate } }, { endDate: despues.endDate, id: { gt: despues.id } }] }] : []),
              ],
            },
            select: {
              id: true,
              venueId: true,
              endDate: true,
              freeTrialNoticeFor: true,
              feature: { select: { code: true } },
              venue: { select: { slug: true, timezone: true, status: true } },
            },
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'plan-renewal-reminder.pruebasSinTarjeta.findMany',
        },
      )

    let total = 0
    let enviados = 0
    let errores = 0
    let despues: { endDate: Date; id: string } | null = null
    for (;;) {
      const pruebas = await pagina(despues)
      total += pruebas.length
      for (const vf of pruebas) {
        try {
          const fin = vf.endDate
          if (!fin || vf.venue?.status !== 'ACTIVE') continue
          if (!diasParaAvisar(fin.getTime(), now) || vf.freeTrialNoticeFor?.getTime() === fin.getTime()) continue

          // Say «pasas a Gratis» only when Facturación shows THIS trial as the venue's plan (courtesy, same end date).
          const plan = await getPlanState(vf.venueId)
          if (plan.grandfathered || plan.origin?.kind !== 'COMP' || plan.origin.currentPeriodEnd !== fin.toISOString()) continue

          const target = await resolvePlanNotificationTarget(vf.venueId)
          if (!target.email) {
            logger.warn(`free-trial reminder: no recipient for venue ${vf.venueId}; skipping`)
            continue
          }

          const sent = await emailService.sendPlanFreeTrialEndingEmail(target.email, {
            locale: target.locale,
            venueName: target.venueName,
            endDate: fin,
            planName: vf.feature?.code === 'PLAN_PREMIUM' ? 'Premium' : 'Pro',
            timeZone: zonaValida(vf.venue?.timezone),
            // Same row and date → one email at the provider even if the stamp below is lost (its window is 24 h).
            idempotencyKey: `prueba-regalada:${vf.id}:${fin.toISOString()}`,
            // D3: mientras Facturación ofrezca «Quedarme con mi plan» (≥ 72 h; la consulta ya garantiza prueba regalada
            // activa, sin Stripe ni suspender), el botón lleva ahí; si no, a hola@avoqado.io.
            ...(fin.getTime() - now >= MARGEN_OFERTA_MS ? { billingUrl: billingPageUrl(vf.venue?.slug) } : {}),
          })
          // Not delivered → no stamp, so the next daily run retries.
          if (!sent) continue

          // The stamp is the announced DATE, written only while the row is still this free trial. Never
          // `renewalReminderSentAt`: that one belongs to the Stripe reminder, which would read it as «already warned».
          await retry(
            () =>
              prisma.venueFeature.updateMany({
                where: { id: vf.id, stripeSubscriptionId: null, endDate: fin },
                data: { freeTrialNoticeFor: fin },
              }),
            {
              retries: 2,
              initialDelay: 1500,
              shouldRetry: shouldRetryDbConnectionError,
              context: 'plan-renewal-reminder.pruebasSinTarjeta.stamp',
            },
          )
          enviados++
        } catch (err) {
          errores++
          logger.error(`❌ free-trial reminder failed for venueFeature ${vf.id}`, {
            error: err instanceof Error ? err.message : 'Unknown error',
            venueFeatureId: vf.id,
          })
        }
      }
      const ultima = pruebas[pruebas.length - 1]
      if (pruebas.length < TOPE_PRUEBAS || !ultima?.endDate) break
      despues = { endDate: ultima.endDate, id: ultima.id }
    }

    logger.info('✅ Free-trial ending reminder check complete', { total, sent: enviados, errors: errores })
  }

  private async run(): Promise<void> {
    logger.info('🔍 Starting plan renewal reminder check...')

    // Entry read — wrapped in retry per cron-jobs.md (pure read, safe to re-run).
    const features = await retry(
      () =>
        prisma.venueFeature.findMany({
          where: {
            active: true,
            stripeSubscriptionId: { not: null },
            feature: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
          },
          select: {
            id: true,
            venueId: true,
            stripeSubscriptionId: true,
            renewalReminderSentAt: true,
            freeTrialNoticeFor: true,
            feature: { select: { code: true } },
            venue: { select: { slug: true, timezone: true } },
          },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'plan-renewal-reminder.findMany' },
    )

    if (features.length === 0) {
      logger.info('✅ No active plan subscriptions to evaluate for renewal reminders')
      return
    }

    const now = Date.now()
    let sentCount = 0
    let errorCount = 0
    let sinMonto = 0
    // One email per subscription per run, even if a residue left two active plan rows on it (PRO + PREMIUM).
    const avisadas = new Set<string>()

    for (const vf of features) {
      try {
        if (avisadas.has(vf.stripeSubscriptionId!)) continue
        const sub = await stripe.subscriptions.retrieve(vf.stripeSubscriptionId!)

        // Plan Básico (revisión final #3): la fila sigue activa pero Stripe ya la borró — el webhook de la baja no llegó.
        // «Tu prueba terminó» / «Tu Pro terminó» con el estado real; el sello de `avisarPlanTerminado` lo deja en una vez.
        if (sub.status === 'canceled' && terminoHacePoco(sub, now)) {
          if (await avisarPlanTerminado(sub)) sentCount++
          continue
        }

        if (sub.status !== 'active' && sub.status !== 'trialing') continue

        // The pinned API carries the period on the item, not the subscription. Without a real date we skip:
        // NaN would slip past both checks below and email "Invalid Date" every day.
        const period = subscriptionPeriod(sub)
        if (!period.start || !period.end) {
          logger.warn(`renewal reminder: subscription ${vf.stripeSubscriptionId} has no billing period; skipping`)
          continue
        }
        const periodEndMs = period.end.getTime()
        const periodStartMs = period.start.getTime()

        if (!diasParaAvisar(periodEndMs, now)) continue

        // Plan Básico: la prueba de Pro que termina SIN cobrar (la modalidad la dice la suscripción real, no la metadata)
        // tiene su propio aviso y su propio sello; nunca el del cobro.
        if (vf.feature?.code === 'PLAN_PRO' && modalidadDePrueba(sub).trialModality === 'ENDS_FREE') {
          if (await this.avisarPruebaSinCobro(vf, sub.id ?? vf.stripeSubscriptionId!, periodStartMs, periodEndMs, now)) {
            avisadas.add(vf.stripeSubscriptionId!)
            sentCount++
          }
          continue
        }

        // Dedup: already reminded this billing period?
        if (vf.renewalReminderSentAt && vf.renewalReminderSentAt.getTime() > periodStartMs) continue

        // No charge at period end (canceled, cancel_at before it, or collection paused through it): never announce one.
        if (noHabraCobro(sub, periodEndMs)) continue

        const target = await resolvePlanNotificationTarget(vf.venueId)
        if (!target.email) {
          logger.warn(`renewal reminder: no recipient for venue ${vf.venueId}; skipping`)
          continue
        }

        // 🔴 No list-price fallback: unknown amount → no email, no stamp; tomorrow's run (still in the window) retries.
        const amountCents = await montoDelSiguienteCobro(stripe, vf.stripeSubscriptionId!)
        if (amountCents === null) {
          sinMonto++
          continue
        }

        const interval = sub.items.data[0]?.price.recurring?.interval === 'year' ? 'annual' : 'monthly'
        // Plan Básico «Tu Pro sube»: sólo en el último periodo con descuento (misma regla que `canEndProNow`).
        const basicOffer = await ofertaDelBasico(stripe, sub, vf.feature?.code, 'DISCOUNT_ENDS', new Date(now))

        const sent = await emailService.sendPlanRenewalReminderEmail(target.email, {
          locale: target.locale,
          venueName: target.venueName,
          interval,
          renewalDate: new Date(periodEndMs),
          amountCents,
          billingPortalUrl: billingPageUrl(vf.venue?.slug),
          planName: vf.feature?.code === 'PLAN_PREMIUM' ? 'Premium' : 'Pro',
          isTrialEnd: sub.status === 'trialing',
          // An empty or non-IANA zone ("GMT-6") makes toLocaleDateString throw: fall back to CDMX instead of never sending.
          timeZone: zonaValida(vf.venue?.timezone),
          ...(basicOffer ? { basicOffer } : {}),
        })
        // Not delivered → no stamp, so the next daily run retries.
        if (!sent) {
          logger.warn(`renewal reminder: email not sent for venueFeature ${vf.id}; will retry on the next run`)
          continue
        }

        avisadas.add(vf.stripeSubscriptionId!)

        // Idempotent stamp, retried on a connection error so a P1001 at 09:00 doesn't re-send tomorrow. The email above
        // is NOT inside any retry.
        await retry(
          () =>
            prisma.venueFeature.update({
              where: { id: vf.id },
              data: { renewalReminderSentAt: new Date() },
            }),
          { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'plan-renewal-reminder.stamp' },
        )

        sentCount++
      } catch (err) {
        errorCount++
        logger.error(`❌ renewal reminder failed for venueFeature ${vf.id}`, {
          error: err instanceof Error ? err.message : 'Unknown error',
          venueFeatureId: vf.id,
        })
      }
    }

    logger.info('✅ Plan renewal reminder check complete', {
      total: features.length,
      sent: sentCount,
      sinMonto,
      errors: errorCount,
    })
  }
}

// Export singleton instance
export const planRenewalReminderJob = new PlanRenewalReminderJob()
