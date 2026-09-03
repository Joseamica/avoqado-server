import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import type { ConsentChannel } from '@prisma/client'
import { plantillaDeAviso } from './privacyNoticeTemplate'

interface ConsentParams {
  venueId: string
  customerId: string
  channel: ConsentChannel
  actorStaffId?: string
  ip?: string
  userAgent?: string
}

/**
 * `content` va en el select a propósito (T10): es contenido del PROPIO negocio (no dato
 * personal de un tercero) y la ruta que lo expone exige `marketing:read` — el editor del
 * dashboard necesita el texto completo para precargarlo, no sólo sus metadatos.
 *
 * 🔴 Task 8: si el venue NO tiene una versión propia, se devuelve la PLANTILLA por defecto
 * como BORRADOR (`esPlantilla: true`) — hoy CERO negocios tienen aviso escrito, y sin uno el
 * candado de `writeConsent` (abajo) rechaza cualquier consentimiento; sin este borrador el
 * dueño se enfrenta a una hoja en blanco en vez de poder revisar y publicar.
 *
 * Es SÓLO un borrador de PRECARGA: `writeConsent` NUNCA llama a esta función — tiene su
 * PROPIA consulta a `privacyNoticeVersion` unas líneas abajo — así que la plantilla jamás
 * cuenta como aviso publicado; el candado de consentimiento sigue exigiendo una fila real.
 *
 * 🔴 Fix ronda final (revisor): cuando `esPlantilla` es `true`, el texto viaja bajo
 * `draftContent` y `content` es SIEMPRE `null` — nunca al revés. Antes los dos casos
 * compartían la llave `content`, así que un consumidor que la pintara sin fijarse en
 * `esPlantilla` (la Fase 1C-B va a construir justo la pantalla del formulario de cliente
 * con este aviso) le enseñaría a un cliente real un documento legal que el negocio nunca
 * aprobó — el mismo riesgo que ya se blindó en la ruta pública (`privacyNotice.public.
 * controller.ts`), aquí cerrado por la FORMA del dato en vez de por la disciplina de cada
 * consumidor: un consumidor despistado recibe vacío, no un aviso falso.
 */
export async function getCurrentPrivacyNotice(venueId: string) {
  const version = await prisma.privacyNoticeVersion.findFirst({
    where: { venueId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true, contentHash: true, language: true, createdAt: true },
  })

  if (version) {
    return { ...version, draftContent: null, esPlantilla: false as const }
  }

  // Sin versión propia: se arma el borrador con lo que el venue YA tiene capturado. Nunca
  // lanza por datos faltantes — `plantillaDeAviso` deja un placeholder explícito en vez de
  // un hueco, para que precargar el editor nunca truene por un venue a medio configurar.
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { name: true, address: true, city: true, state: true, email: true, phone: true },
  })
  const domicilio = venue ? [venue.address, venue.city, venue.state].filter(Boolean).join(', ') || undefined : undefined

  return {
    id: null,
    content: null,
    draftContent: plantillaDeAviso({
      nombreDelNegocio: venue?.name ?? '',
      domicilio,
      contacto: venue?.email?.trim() || venue?.phone?.trim() || '',
      fecha: new Date(),
    }),
    contentHash: null,
    language: 'es',
    createdAt: null,
    esPlantilla: true as const,
  }
}

/**
 * 🔴 El ÚNICO camino que escribe consentimiento. Evento + cache + ActivityLog en UNA
 * transacción — deliberadamente NO usa logAction (fire-and-forget): la revocación es
 * evidencia legal (LFPDPPP) y debe ser atómica con el evento (auditoría Codex #23).
 * El SELECT ... FOR UPDATE de la fila del customer da el orden total de `seq`.
 */
async function writeConsent(p: ConsentParams, action: 'GRANTED' | 'REVOKED') {
  await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; venueId: string }[]>`
      SELECT id, "venueId" FROM "Customer" WHERE id = ${p.customerId} AND "venueId" = ${p.venueId} FOR UPDATE`
    if (rows.length === 0) throw new NotFoundError('Cliente no encontrado en este negocio')

    let noticeVersionId: string | null = null
    if (action === 'GRANTED') {
      // 🔴 Consulta PROPIA, deliberadamente DISTINTA de getCurrentPrivacyNotice (arriba): esa
      // función cae a la PLANTILLA cuando el venue no tiene versión propia (Task 8), y la
      // plantilla NUNCA puede contar como aviso publicado — sólo una fila real guardada
      // autoriza a capturar consentimiento. Confirmado con sabotaje: reusar
      // getCurrentPrivacyNotice aquí hace que este candado deje de rechazar (ver reporte).
      const notice = await tx.privacyNoticeVersion.findFirst({
        where: { venueId: p.venueId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (!notice) throw new BadRequestError('Registra el aviso de privacidad del negocio antes de capturar consentimiento')
      noticeVersionId = notice.id
    }

    const last = await tx.consentEvent.findFirst({
      where: { customerId: p.customerId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    const seq = (last?.seq ?? 0) + 1

    await tx.consentEvent.create({
      data: {
        customerId: p.customerId,
        venueId: p.venueId,
        seq,
        action,
        channel: p.channel,
        actorStaffId: p.actorStaffId ?? null,
        noticeVersionId,
        ip: p.ip ?? null,
        userAgent: p.userAgent ?? null,
      },
    })
    await tx.customer.update({ where: { id: p.customerId }, data: { marketingConsent: action === 'GRANTED' } })
    await tx.activityLog.create({
      data: {
        action: action === 'GRANTED' ? 'MARKETING_CONSENT_GRANTED' : 'MARKETING_CONSENT_REVOKED',
        entity: 'Customer',
        entityId: p.customerId,
        staffId: p.actorStaffId ?? null,
        venueId: p.venueId,
        data: { channel: p.channel, seq },
      },
    })
  })
}

export const grantMarketingConsent = (p: ConsentParams) => writeConsent(p, 'GRANTED')
export const revokeMarketingConsent = (p: ConsentParams) => writeConsent(p, 'REVOKED')
