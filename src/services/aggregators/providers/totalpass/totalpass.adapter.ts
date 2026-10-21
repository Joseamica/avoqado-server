import logger from '@/config/logger'
import { ActionResult, ConnectionCtx, PassAdapter, SessionPublication } from '../../core/types'
import { HttpResult, fetchWithTimeout, readBody, totalPassCall } from './totalpass.http'
import {
  isTotalPassValidationUrl,
  mapDenyReason,
  parseBookingWebhook,
  parseCheckinWebhook,
  toTotalPassDate,
  toTotalPassDateTime,
  toTotalPassTime,
  totalPassDedupKey,
} from './totalpass.mapping'

export { __resetTotalPassTokens } from './totalpass.http'

/** Quita del resultado el cuerpo crudo de TotalPass (puede traer `placeApiKey`): el núcleo sólo necesita el veredicto. */
const verdict = (r: HttpResult): ActionResult =>
  r.ok ? { ok: true } : { ok: false, retryable: r.retryable, code: r.code, message: r.message }
const notFound = (r: HttpResult) => !r.ok && r.status === 404

const KNOWN_LABELS = ['check_in_not_available', 'check_in_expired_alert']

/** 422 de la validación: se leen las etiquetas estables (`source.label`), no el texto en portugués. */
function validationLabels(data: unknown, text: string): string[] {
  const errors = data && typeof data === 'object' && Array.isArray((data as any).errors) ? (data as any).errors : []
  const labels = errors.map((e: any) => e?.source?.label).filter((l: unknown): l is string => typeof l === 'string')
  if (labels.length) return labels
  return KNOWN_LABELS.filter(l => text.includes(l))
}

/**
 * La sucursal de la llave: `GET /partner/plans` devuelve el place (identifier, name) con sus planes. Sólo lee; la
 * respuesta repite la placeApiKey, así que nunca se devuelve entera.
 */
async function readPlace(
  ctx: ConnectionCtx,
): Promise<{ ok: false; retryable: boolean; code: string; message: string } | { ok: true; place: any; externalPlaceId: string }> {
  const plans = await totalPassCall(ctx, 'BOOKING', 'GET', '/partner/plans')
  if (!plans.ok) return { ok: false, retryable: plans.retryable, code: plans.code, message: plans.message }
  const place: any = plans.data && typeof plans.data === 'object' ? plans.data : {}
  const externalPlaceId = typeof place.identifier === 'string' && place.identifier ? place.identifier : null
  if (!externalPlaceId)
    return { ok: false, retryable: false, code: 'NO_PLACE_ID', message: 'TotalPass no devolvió el identificador de la sucursal' }
  return { ok: true, place, externalPlaceId }
}

const placeName = (place: any): string | undefined => (typeof place.name === 'string' ? place.name : undefined)

/** Campos de una ocurrencia que TotalPass deja editar sin cancelar reservas (contrato §3.6); el alta los lleva igual. */
function occurrenceDetails(p: SessionPublication, now: Date) {
  // La ventana exige min < max a nivel minuto; con menos de 1 min de margen se omite.
  const window =
    p.bookingClosesAt && p.bookingClosesAt.getTime() - now.getTime() >= 60e3
      ? {
          bookingWindow: {
            minTimeToBook: toTotalPassDateTime(now, p.timezone),
            maxTimeToBook: toTotalPassDateTime(p.bookingClosesAt, p.timezone),
          },
        }
      : {}
  return {
    title: p.title,
    responsible: p.coachName?.trim() || 'Por asignar',
    duration: p.durationMin,
    externalReference: p.classSessionId,
    ...window,
  }
}

export const totalPassAdapter: PassAdapter = {
  provider: 'TOTALPASS',

  parseWebhook: (kind, body) => (kind === 'BOOKING' ? parseBookingWebhook(body) : parseCheckinWebhook(body)),

  dedupKey: (kind, body) => totalPassDedupKey(kind, body),

  async identify(ctx) {
    const p = await readPlace(ctx)
    if (!p.ok) return p
    return { ok: true, externalPlaceId: p.externalPlaceId, externalPlaceName: placeName(p.place) }
  },

  async setup(ctx, urls) {
    const p = await readPlace(ctx)
    if (!p.ok) return p
    const { place, externalPlaceId } = p

    const confirm = await totalPassCall(ctx, 'BOOKING', 'PUT', '/partner/places/update-configs', { hasSlotConfirmation: true })
    if (!confirm.ok) return verdict(confirm)
    const sub = await totalPassCall(ctx, 'BOOKING', 'POST', '/partner/webhook/subscribe', { webhook_url: urls.booking })
    if (!sub.ok) return verdict(sub)

    // Se pregunta antes si la sucursal ya tiene webhook de check-in: existe ⇒ update; no ⇒ create. El error que se
    // devuelve es siempre el de la llamada que falló (nunca uno que tape la causa original).
    const current = await totalPassCall(ctx, 'CHECKIN', 'GET', '/partner/webhook/get')
    if (!current.ok) return verdict(current)
    const hooks: unknown[] = Array.isArray((current.data as any)?.webhooks) ? (current.data as any).webhooks : []
    const exists = hooks.some((w: any) => w?.webhook_type === 'CHECKIN')
    const checkinHook = { webhook_url: urls.checkin, webhook_type: 'CHECKIN' }
    const chk = exists
      ? await totalPassCall(ctx, 'CHECKIN', 'PUT', '/partner/webhook/update', checkinHook)
      : await totalPassCall(ctx, 'CHECKIN', 'POST', '/partner/webhook/create', checkinHook)
    if (!chk.ok) return verdict(chk)

    // Sólo lo necesario: la respuesta de /partner/plans repite la placeApiKey.
    const planList = Array.isArray(place.Plans) ? place.Plans : []
    return {
      ok: true,
      externalPlaceId,
      externalPlaceName: placeName(place),
      data: { plans: planList.map((p: any) => ({ id: p?.id ?? null, name: p?.name ?? null, code: p?.code ?? null })) },
    }
  },

  async publishSession(ctx, p, prev) {
    const planId = Number(p.externalPlanId)
    if (!Number.isInteger(planId)) {
      return { ok: false, retryable: false, code: 'BAD_PLAN_ID', message: `plan de TotalPass inválido: ${String(p.externalPlanId)}` }
    }
    if (prev.externalOccurrenceId) {
      // TotalPass no deja cambiar fecha ni hora: se da de baja la ocurrencia vieja y se crea otra. Si la baja falla,
      // no se crea nada (una alta sin baja dejaría la clase duplicada en la app).
      const occ = encodeURIComponent(prev.externalOccurrenceId)
      const off = await totalPassCall(ctx, 'BOOKING', 'POST', '/partner/event-occurrence/status', {
        occurrencesToUpdate: [{ occurrenceUuid: prev.externalOccurrenceId, status: 'INACTIVE' }],
      })
      if (!off.ok && !notFound(off)) return verdict(off)
      const del = await totalPassCall(ctx, 'BOOKING', 'DELETE', `/partner/event-occurrence/${occ}`)
      if (!del.ok && !notFound(del)) return verdict(del)
    }

    const body = {
      ...occurrenceDetails(p, new Date()),
      slots: p.spots,
      planId,
      timezone: 'es-MX',
      eventDate: toTotalPassDate(p.startsAt, p.timezone),
      startTime: toTotalPassTime(p.startsAt, p.timezone),
    }
    const r = await totalPassCall(ctx, 'BOOKING', 'POST', '/partner/event-occurrence', body)
    if (!r.ok) return verdict(r)
    const d: any = r.data && typeof r.data === 'object' ? r.data : {}
    const id = [d.eventOccurrenceUuid, d.occurrenceUuid, d.startTimeId].find(v => typeof v === 'string' && v)
    return { ok: true, externalOccurrenceId: id }
  },

  async updateSpots(ctx, occ, spots) {
    // 422 (no se puede bajar de las reservas activas) cae en «4xx no reintentable».
    return verdict(
      await totalPassCall(ctx, 'BOOKING', 'PUT', `/partner/event-occurrence/${encodeURIComponent(occ)}/slot`, { slots: spots }),
    )
  },

  async updateSessionDetails(ctx, occ, p) {
    const path = `/partner/event-occurrence/${encodeURIComponent(occ)}`
    return verdict(await totalPassCall(ctx, 'BOOKING', 'PUT', path, occurrenceDetails(p, new Date())))
  },

  async unpublishSession(ctx, occ) {
    // TotalPass cancela las reservas y avisa al socio. Si ya no existe, ya está dada de baja.
    const r = await totalPassCall(ctx, 'BOOKING', 'DELETE', `/partner/event-occurrence/${encodeURIComponent(occ)}`)
    return notFound(r) ? { ok: true } : verdict(r)
  },

  async respondBooking(ctx, slotId, decision) {
    const body = decision.accept ? { state: 'confirmed' } : { state: 'denied', reason: mapDenyReason(decision.reason) }
    return verdict(await totalPassCall(ctx, 'BOOKING', 'PUT', `/partner/slot/confirmSlot/${encodeURIComponent(slotId)}`, body))
  },

  async cancelBooking(ctx, slotId) {
    const r = await totalPassCall(ctx, 'BOOKING', 'DELETE', `/partner/slot/${encodeURIComponent(slotId)}`)
    // 404 slot_not_found y 400 already_canceled / slot_expired: allá ya no hay nada que cancelar (contrato §4.3).
    if (notFound(r) || (!r.ok && r.status === 400 && /already_canceled|slot_expired/.test(r.message))) return { ok: true }
    return verdict(r)
  },

  async validateVisit(ctx, validationRef) {
    if (!isTotalPassValidationUrl(validationRef)) {
      return { ok: false, retryable: false, code: 'BAD_VALIDATION_URL', message: 'la URL de validación no es de totalpass.com' }
    }
    // La URL lleva el token del check-in: nunca se loguea ni se copia a un mensaje.
    logger.info(`[PASES] TotalPass: se intenta validar un check-in (conexión ${ctx.id})`)
    const r = await fetchWithTimeout(validationRef, { method: 'POST', redirect: 'manual' })
    if ('code' in r) return r
    const { text, data } = await readBody(r)
    if (r.ok) return { ok: true }
    if (r.status === 422) {
      // Sólo etiquetas conocidas llegan al mensaje: el resto del cuerpo puede repetir el token.
      const labels = validationLabels(data, text).filter(l => KNOWN_LABELS.includes(l))
      return {
        ok: false,
        retryable: false,
        code: 'HTTP_422',
        message: `TotalPass no validó el check-in (422): ${labels.join(', ') || 'sin etiqueta conocida'}`,
        alreadyValidated: labels.includes('check_in_not_available'),
        expired: labels.includes('check_in_expired_alert'),
      }
    }
    return {
      ok: false,
      retryable: r.status === 429 || r.status >= 500,
      code: `HTTP_${r.status}`,
      // El cuerpo no se copia: podría repetir el token de un solo uso de la URL (también codificado).
      message: `TotalPass respondió HTTP ${r.status} al validar el check-in`,
    }
  },
}
