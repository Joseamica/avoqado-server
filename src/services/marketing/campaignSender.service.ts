// src/services/marketing/campaignSender.service.ts
import { CustomerCampaignDeliveryStatus, CustomerCampaignStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { env } from '@/config/env'
import emailService from '@/services/email.service'
import { buildMarketingFrom } from '@/services/marketing/marketingSender'
import { isSuppressed } from '@/services/marketing/emailSuppression.service'
import { devolverCuota, periodoDeEnvio } from '@/services/marketing/emailQuota.service'
import { signCustomerUnsubscribeToken } from '@/utils/customerActionToken'

/**
 * Envío de UNA delivery — Fase 1A, Task 7.
 *
 * Es la tarea más delicada del carril: decide, correo por correo, si sale o no. Se llama
 * DESPUÉS de que el scheduler (Task 6) ya reclamó la fila (`SENDING`, lease tomado,
 * `attempts` incrementado, `sendAttemptAt` fijado) — este archivo no reclama nada, sólo
 * decide y ejecuta.
 *
 * Dos peligros que gobiernan todo el diseño:
 *
 * 1. Pueden pasar minutos entre el reclamo y este intento (el worker se atoró en otra
 *    delivery, el proceso se reinició). El consentimiento, la supresión y el estado de la
 *    campaña se vuelven a leer AQUÍ, al borde, nunca se confía en lo que el scheduler vio
 *    hace rato.
 * 2. Un correo, una vez que Resend lo aceptó, NO se puede "deshacer" reintentando. Por eso
 *    cualquier fallo que ocurra DESPUÉS de que Resend contestó éxito nunca reintenta —
 *    resuelve en `UNKNOWN`, que 1B concilia por webhook.
 */

/**
 * 1m · 5m · 30m · 2h · 6h — espera antes de cada reintento tras un fallo TRANSITORIO.
 *
 * 🔴 El spec lista un sexto valor (24h) que este código NO puede alcanzar: con 6 intentos como
 * máximo sólo caben 5 esperas — se espera después de cada fallo MENOS el último, que ya no
 * reintenta. Dejarlo escrito sería una mentira para el siguiente lector, y de las caras: alguien
 * lee «reintenta hasta 24h» y concluye que una campaña fallida se recupera sola al día
 * siguiente. Se retira el valor muerto y se ata la relación entre las dos constantes abajo, para
 * que subir el tope de intentos obligue a añadir su espera y no vuelva a desincronizarse.
 * Ventana total de reintento: ~8h 36m.
 */
export const BACKOFF_MS = [1 * 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000]

/**
 * Con `attempts >= MAX_INTENTOS_ANTES_DE_DEAD` ya no se reintenta — pasa directo a `DEAD`.
 * El spec fija «máx 6 intentos», y aquí se DERIVA de la tabla de esperas en vez de escribirse
 * suelto: N esperas ⇒ N+1 intentos. Así no pueden desincronizarse, que es justo lo que dejó
 * una espera inalcanzable en la primera versión. Hay una prueba que fija esta relación.
 */
export const MAX_INTENTOS_ANTES_DE_DEAD = BACKOFF_MS.length + 1

export type ResultadoEnvio = 'SENT' | 'SKIPPED' | 'RETRYING' | 'DEAD' | 'UNKNOWN'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/**
 * URL pública de baja, con el token firmado (Fase 0) — nunca expira, así que sirve igual
 * de un correo mandado hoy que de uno de hace un año. `BASE_URL` cae al host de producción
 * cuando no está configurado (dev local) — mismo criterio que `cfdi.public.controller.ts` y
 * `angelpayFullSetup.service.ts`: a diferencia del pase de Wallet (que si apunta a
 * `localhost` prefiere NO mandar el botón), aquí el pie es OBLIGATORIO para poder mandar el
 * correo — omitir la liga no es una opción, así que se cae a la URL real en vez de bloquear
 * el envío por una variable de entorno local sin configurar.
 */
function buildUnsubscribeUrl(customerId: string, venueId: string): string {
  const token = signCustomerUnsubscribeToken({ customerId, venueId })
  const base = (env.BASE_URL || 'https://api.avoqado.io').replace(/\/$/, '')
  return `${base}/api/v1/public/customers/unsubscribe?token=${encodeURIComponent(token)}`
}

/**
 * URL pública del aviso de privacidad del NEGOCIO — Task 7. A diferencia de la liga de baja,
 * NO lleva token: un aviso de privacidad es información que cualquiera puede leer (la propia
 * LFPDPPP lo exige accesible), no una acción sobre la cuenta de un cliente concreto.
 *
 * 🔴 Deliberadamente ESTÁTICA — nunca consulta si el venue YA publicó un aviso real. Decisión
 * del founder (2026-09-02): el pie SIEMPRE lleva el enlace; un venue sin aviso no debería
 * tener audiencia consentida (consent.service.ts ya lo impide al capturar el consentimiento),
 * así que ese caso no debería ocurrir — pero si ocurriera, blindar el envío contra una
 * consulta que podría fallar es más seguro que arriesgar el resto del correo por ella. La
 * ruta pública (`privacyNotice.public.controller.ts`) resuelve el contenido en el momento en
 * que alguien de verdad hace clic, con el mismo fallback a la plantilla que usa el dashboard
 * (Task 8) — nunca un 404 para un venueId real.
 */
function buildPrivacyNoticeUrl(venueId: string): string {
  const base = (env.BASE_URL || 'https://api.avoqado.io').replace(/\/$/, '')
  return `${base}/api/v1/public/venues/${venueId}/privacy-notice`
}

/**
 * El pie del correo — R3 del brief: nombre del negocio, su dato de contacto, la liga de baja
 * y (Task 7) el enlace al aviso de privacidad. Se AÑADE al `html`/`text` de la campaña, nunca
 * se inserta a mitad del documento ni se sanitiza — eso es responsabilidad del editor (Fase
 * 1C), no de esta task.
 */
function buildFooter(params: {
  venueName: string
  venueEmail: string | null
  venuePhone: string | null
  unsubscribeUrl: string
  privacyNoticeUrl: string
}): {
  htmlFooter: string
  textFooter: string
} {
  // 🔴 Recortado, igual que el candado LFPC de arriba: `'   '` es verdadero en JS, así que sin
  // el trim un correo en blanco le ganaba al teléfono bueno y el pie identificaba al negocio con
  // una línea VACÍA. Pasar el candado y luego no imprimir nada es igual de incumplido, y encima
  // invisible — el candado dice «sí hay contacto» y el lector del correo no ve ninguno.
  const contacto = params.venueEmail?.trim() || params.venuePhone?.trim() || ''
  const nombreEscapado = escapeHtml(params.venueName)
  const contactoEscapado = escapeHtml(contacto)

  const htmlFooter = `
<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
<div style="font-size: 12px; color: #999; line-height: 1.6;">
  <p style="margin: 0 0 8px 0;">${nombreEscapado}${contactoEscapado ? ` &middot; ${contactoEscapado}` : ''}</p>
  <p style="margin: 0;"><a href="${params.unsubscribeUrl}" style="color: #666; text-decoration: underline;">Dejar de recibir estos correos</a></p>
  <p style="margin: 4px 0 0 0;"><a href="${params.privacyNoticeUrl}" style="color: #666; text-decoration: underline;">Aviso de privacidad</a></p>
</div>`

  const textFooter = `

---
${params.venueName}${contacto ? ` · ${contacto}` : ''}
Dejar de recibir estos correos: ${params.unsubscribeUrl}
Aviso de privacidad: ${params.privacyNoticeUrl}`

  return { htmlFooter, textFooter }
}

export interface EnviarDeliveryOpts {
  /** Reloj inyectable — SÓLO para que las pruebas fijen "ahora" (default: `new Date()`). */
  ahora?: Date
}

/**
 * Envía (o descarta) UNA `CustomerCampaignDelivery` ya reclamada por el scheduler.
 *
 * Nunca lanza por un resultado de negocio esperado (consentimiento revocado, campaña
 * vencida, Resend caído…): todos esos casos resuelven en uno de los cinco valores del
 * union. Sólo se deja propagar una excepción si falla la RELECTURA inicial (`findUnique`)
 * o la búsqueda del venue — ahí todavía no ocurrió ningún efecto externo, así que dejar que
 * el llamador (el job) la vea y la reintente en el siguiente tick es más seguro que
 * inventar un resultado.
 */
export async function enviarDelivery(deliveryId: string, opts?: EnviarDeliveryOpts): Promise<ResultadoEnvio> {
  const ahora = opts?.ahora ?? new Date()

  // R1 — la relectura AL BORDE, con su campaña, su cliente y su venue. Nunca se confía en
  // lo que el scheduler vio al reclamar: pueden haber pasado minutos.
  const delivery = await prisma.customerCampaignDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      campaign: true,
      customer: { select: { id: true, email: true, marketingConsent: true, active: true } },
    },
  })

  if (!delivery) {
    logger.warn('campaignSender.enviarDelivery: la delivery no existe', { deliveryId })
    return 'UNKNOWN'
  }

  // Si la fila ya no es nuestra (otro worker la reclamó de nuevo porque nuestro lease
  // venció, o alguien la movió por fuera) NO TOCAMOS NADA — escribir aquí pisaría el
  // trabajo de quien sí la tiene reclamada ahora mismo.
  if (delivery.status !== CustomerCampaignDeliveryStatus.SENDING || !delivery.leaseUntil || delivery.leaseUntil <= ahora) {
    logger.warn('campaignSender.enviarDelivery: perdió el lease antes de poder actuar; no se toca la fila', {
      deliveryId,
      status: delivery.status,
      leaseUntil: delivery.leaseUntil,
    })
    return 'SKIPPED'
  }

  const venue = await prisma.venue.findUnique({
    where: { id: delivery.venueId },
    select: { id: true, name: true, email: true, phone: true, timezone: true },
  })

  // El CAS de TODA escritura de resultado — los valores de ESTA relectura, no los que el
  // scheduler devolvió al reclamar (pudieron pasar minutos entre uno y otro).
  const casWhere = { id: delivery.id, attempts: delivery.attempts, leaseUntil: delivery.leaseUntil }

  /**
   * Marca la fila `SKIPPED` con su motivo, dentro de una transacción con la devolución de
   * cuota (R2): las dos cosas ocurren juntas o ninguna. Si el CAS no aplica (alguien más la
   * tomó justo mientras evaluábamos) el resultado se descarta — se resuelve `UNKNOWN`, no se
   * inventa un SKIPPED que nunca quedó escrito.
   */
  const marcarSkipped = async (lastError: string): Promise<'SKIPPED' | 'UNKNOWN'> => {
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.customerCampaignDelivery.updateMany({
          where: casWhere,
          data: { status: CustomerCampaignDeliveryStatus.SKIPPED, lastError, leaseUntil: null, nextAttemptAt: null },
        })
        if (updated.count === 0) {
          throw new Error('CAS_PERDIDO_AL_SALTAR')
        }

        // R2 — SÓLO se devuelve cuota si esta delivery NUNCA pasó por el reclamo del
        // scheduler. 🔴 En el camino normal `sendAttemptAt` YA quedó fijado por
        // `reclamarLote` (COALESCE, Task 6) al reclamar ESTA MISMA fila — así que llegar
        // aquí con `sendAttemptAt === null` es, en la práctica de hoy, INALCANZABLE: toda
        // delivery que llega a `enviarDelivery` ya pasó por ese reclamo. Se deja escrito
        // de todos modos porque el reclamo vive en OTRO archivo (Task 6) y nada impide que
        // el día de mañana exista un segundo camino que llame a `enviarDelivery` sobre una
        // fila que nunca se reclamó (p.ej. una prueba, o un futuro envío directo). Si de
        // verdad es inalcanzable, la delivery ya "consumió su intento" (attempts subió al
        // reclamar) y no hay nada que devolver.
        if (delivery.sendAttemptAt === null) {
          const zona = venue?.timezone ?? 'America/Mexico_City'
          const period = periodoDeEnvio(delivery.campaign?.scheduledFor ?? delivery.createdAt, zona)
          await devolverCuota(tx, { venueId: delivery.venueId, period, cantidad: 1 })
        }
      })
      return 'SKIPPED'
    } catch (error) {
      logger.warn('campaignSender.enviarDelivery: no se pudo registrar SKIPPED (CAS perdido o error de base)', {
        deliveryId,
        error,
      })
      return 'UNKNOWN'
    }
  }

  const marcarDead = async (lastError: string): Promise<'DEAD' | 'UNKNOWN'> => {
    try {
      const updated = await prisma.customerCampaignDelivery.updateMany({
        where: casWhere,
        data: { status: CustomerCampaignDeliveryStatus.DEAD, lastError, leaseUntil: null, nextAttemptAt: null },
      })
      if (updated.count === 0) {
        logger.warn('campaignSender.enviarDelivery: CAS perdido al marcar DEAD — el resultado se descarta', { deliveryId })
        return 'UNKNOWN'
      }
      logger.warn('campaignSender.enviarDelivery: delivery marcada DEAD', { deliveryId, lastError })
      return 'DEAD'
    } catch (error) {
      logger.warn('campaignSender.enviarDelivery: error de base al marcar DEAD', { deliveryId, error })
      return 'UNKNOWN'
    }
  }

  const marcarRetrying = async (lastError: string): Promise<'RETRYING' | 'UNKNOWN'> => {
    // `attempts` ya viene incrementado por el reclamo del scheduler (vale 1 en el primer
    // intento — ver R4 y campaignScheduler.service.ts), así que el backoff se indexa con
    // `attempts - 1`. El corte de `MAX_INTENTOS_ANTES_DE_DEAD` arriba garantiza que aquí
    // `attempts` siempre está entre 1 y 5, así que el índice siempre cae dentro del array.
    const delayMs = BACKOFF_MS[Math.max(0, delivery.attempts - 1)] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
    const nextAttemptAt = new Date(ahora.getTime() + delayMs)
    try {
      const updated = await prisma.customerCampaignDelivery.updateMany({
        where: casWhere,
        data: { status: CustomerCampaignDeliveryStatus.RETRYING, lastError, leaseUntil: null, nextAttemptAt },
      })
      if (updated.count === 0) {
        logger.warn('campaignSender.enviarDelivery: CAS perdido al marcar RETRYING — el resultado se descarta', { deliveryId })
        return 'UNKNOWN'
      }
      return 'RETRYING'
    } catch (error) {
      logger.warn('campaignSender.enviarDelivery: error de base al marcar RETRYING', { deliveryId, error })
      return 'UNKNOWN'
    }
  }

  // --- R1: los cinco motivos de SKIP, evaluados al borde -------------------------------

  if (!delivery.campaign) {
    // XOR con automationId — la automatización de cumpleaños (Fase 2) todavía no existe.
    return marcarSkipped('La delivery pertenece a una automatización (Fase 2), que esta task aún no maneja.')
  }
  const { campaign } = delivery

  // c) la campaña ya no es publicable.
  if (
    campaign.status === CustomerCampaignStatus.CANCELLED ||
    campaign.status === CustomerCampaignStatus.BLOCKED ||
    campaign.status === CustomerCampaignStatus.EXPIRED
  ) {
    return marcarSkipped(`La campaña está ${campaign.status}; ya no se manda.`)
  }

  // a) consentimiento revocado o cliente inactivo.
  if (delivery.customer.marketingConsent === false || delivery.customer.active === false) {
    return marcarSkipped('El cliente revocó su consentimiento de marketing o ya no está activo.')
  }

  // Guarda técnica adicional (no es una de las cinco letras de R1, pero es obligatoria para
  // poder mandar el correo): sin dirección no hay a quién escribirle. `campaignEnqueue`
  // sólo encola clientes CON correo, pero el dato pudo borrarse después de encolar.
  if (!delivery.customer.email) {
    return marcarSkipped('El cliente ya no tiene un correo registrado.')
  }
  const destinatario = delivery.customer.email

  // b) supresión global (rebote duro / queja) — protege la reputación del subdominio.
  if (await isSuppressed(destinatario)) {
    return marcarSkipped('El correo está en la lista de supresión global (rebote duro o queja).')
  }

  // d) tope de atraso — una promoción navideña el 3 de enero hace daño, no ventas.
  const limite =
    campaign.sendNoLaterThan ?? (campaign.scheduledFor ? new Date(campaign.scheduledFor.getTime() + 24 * 60 * 60 * 1000) : null)
  if (limite && ahora > limite) {
    return marcarSkipped(`Venció el plazo de envío (${limite.toISOString()}); una promoción tardía hace daño, no ventas.`)
  }

  // e) el negocio no se puede identificar — un correo de marketing sin nombre ni dato de
  // contacto del responsable no cumple la LFPC.
  // 🔴 Los TRES campos se comparan ya recortados, y la simetría es el punto: en JS `'   '` es
  // verdadero, así que un correo o un teléfono de puros espacios pasaría el candado y el correo
  // saldría con la línea de contacto EN BLANCO — el incumplimiento exacto que esto impide.
  // Recortar sólo uno de los campos es peor que no recortar ninguno: parece cubierto y no lo está.
  if (!venue || !venue.name.trim() || !(venue.email?.trim() || venue.phone?.trim())) {
    return marcarSkipped(
      'El negocio no tiene nombre o dato de contacto configurado; un correo de marketing sin identificar al responsable no cumple la LFPC.',
    )
  }

  // --- A partir de aquí se manda de verdad ----------------------------------------------

  const unsubscribeUrl = buildUnsubscribeUrl(delivery.customerId, delivery.venueId)
  const privacyNoticeUrl = buildPrivacyNoticeUrl(delivery.venueId)
  const { htmlFooter, textFooter } = buildFooter({
    venueName: venue.name,
    venueEmail: venue.email,
    venuePhone: venue.phone,
    unsubscribeUrl,
    privacyNoticeUrl,
  })

  const html = `${campaign.htmlBody}${htmlFooter}`
  const text = `${campaign.textBody}${textFooter}`

  const result = await emailService.sendEmailWithResult({
    to: destinatario,
    subject: campaign.subject,
    html,
    text,
    from: buildMarketingFrom(venue.name),
    // 🔴 El MISMO valor en dos lugares, a propósito: `idempotencyKey` es lo que hace seguro
    // reintentar la LLAMADA a Resend si el proceso muere antes de leer la respuesta; el tag
    // `deliveryId` es la correlación universal para conciliar por webhook en 1B, sin
    // depender sólo del `resendId` (que todavía no existe cuando Resend recibe el request).
    idempotencyKey: delivery.id,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: [{ name: 'deliveryId', value: delivery.id }],
  })

  if (result.ok) {
    try {
      const updated = await prisma.customerCampaignDelivery.updateMany({
        where: casWhere,
        data: {
          status: CustomerCampaignDeliveryStatus.SENT,
          resendId: result.resendId ?? null,
          leaseUntil: null,
          nextAttemptAt: null,
          lastError: null,
        },
      })
      if (updated.count === 0) {
        // Resend YA aceptó el correo (result.resendId existe) pero el CAS no aplicó —
        // otro worker tomó la fila mientras esperábamos la respuesta del proveedor. NUNCA
        // se reintenta desde aquí: reintentar mandaría el correo DOS veces. 1B concilia por
        // webhook usando el tag `deliveryId`.
        logger.warn('campaignSender.enviarDelivery: el correo salió pero el CAS de SENT no aplicó (otro worker tomó la fila)', {
          deliveryId,
          resendId: result.resendId,
        })
        return 'UNKNOWN'
      }
      return 'SENT'
    } catch (error) {
      // R4 — fallo TRAS aceptar Resend: hay `resendId` pero la persistencia falló de
      // verdad (no sólo un CAS perdido). El correo YA salió: jamás se reintenta.
      logger.warn('campaignSender.enviarDelivery: el correo salió pero no se pudo persistir SENT', {
        deliveryId,
        resendId: result.resendId,
        error,
      })
      return 'UNKNOWN'
    }
  }

  // result.ok === false
  if (result.transient) {
    if (delivery.attempts >= MAX_INTENTOS_ANTES_DE_DEAD) {
      return marcarDead(`Se agotaron los ${MAX_INTENTOS_ANTES_DE_DEAD} intentos (${result.errorCode ?? 'error transitorio'}).`)
    }
    return marcarRetrying(result.errorCode ?? 'Error transitorio de envío.')
  }

  // Terminal: destinatario inválido o 4xx de validación — reintentar no lo arregla.
  return marcarDead(result.errorCode ?? 'Error terminal de envío (destinatario o validación).')
}
