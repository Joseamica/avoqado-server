// Actualizador del POS (r7, spec §4.7): el aviso de actualizar viaja por los anuncios de plataforma que ya existen, porque
// el banner y la ventana de anuncios ya están en las apps instaladas hoy. Este módulo crea y archiva esos anuncios DENTRO
// de la transacción de la política: o quedan la política y sus avisos, o ninguno.
//
// Un aviso de actualizar es un `PlatformAnnouncement` con `posAppPlatform` no nulo. Nace PUBLISHED y ya «repartido»
// (`deliveredAt: now`, `deliveredCount: 0`): el reparto nunca lo toma, así que NO crea acuses, ni buzón, ni push. El inicio
// de las apps lo elige por la versión que trae cada app (tarea 8), no por persona.
import { NotificationPriority, PlatformAnnouncementStatus, Prisma } from '@prisma/client'

export type PosAppPlatformParam = 'ANDROID' | 'IOS'
export type PosAppNoticeStyleValue = 'BANNER' | 'MODAL'

/** Los campos de la política que importan para el aviso (y para saber si un nivel cambió). */
export interface PolicySnapshot {
  requiredMinVersionCode: number | null
  requiredMinVersionName: string | null
  recommendedMinVersionCode: number | null
  recommendedMinVersionName: string | null
  recommendedNoticeStyle: PosAppNoticeStyleValue | null
  message: string | null
  recommendedAnnouncementId: string | null
  requiredAnnouncementId: string | null
  version: number
}

// Texto fijo (spec §4.7). El `message` de la política, si viene, reemplaza el cuerpo de los dos.
const TEXTO = {
  RECOMMENDED: { title: 'Hay una versión nueva de Avoqado', body: 'Actualiza la app para tener lo más reciente.' },
  REQUIRED: { title: 'Actualiza Avoqado cuanto antes', body: 'Esta versión ya no debe usarse. Actualizar toma un minuto.' },
} as const

// La liga https de la tienda: es la que una app vieja sabe abrir desde el botón del anuncio.
const LIGA_DE_LA_TIENDA: Record<PosAppPlatformParam, string> = {
  ANDROID: 'https://play.google.com/store/apps/details?id=com.avoqado.pos',
  IOS: 'https://apps.apple.com/app/id6758351745',
}

type Nivel = 'RECOMMENDED' | 'REQUIRED'

function umbral(s: PolicySnapshot, nivel: Nivel): { code: number | null; name: string | null } {
  return nivel === 'REQUIRED'
    ? { code: s.requiredMinVersionCode, name: s.requiredMinVersionName }
    : { code: s.recommendedMinVersionCode, name: s.recommendedMinVersionName }
}

function hayNivel(s: PolicySnapshot | null, nivel: Nivel): boolean {
  if (!s) return false
  const u = umbral(s, nivel)
  return u.code !== null || u.name !== null
}

/**
 * ¿Cambió el nivel? (spec §4.3, «cuándo cambió un nivel»). «Avisar» cambia con su número, su nombre, su forma o el
 * mensaje; «Bloquear», con su número, su nombre o el mensaje (su forma es fija).
 */
function cambioElNivel(antes: PolicySnapshot, despues: PolicySnapshot, nivel: Nivel): boolean {
  const a = umbral(antes, nivel)
  const d = umbral(despues, nivel)
  if (a.code !== d.code || a.name !== d.name || antes.message !== despues.message) return true
  return nivel === 'RECOMMENDED' && antes.recommendedNoticeStyle !== despues.recommendedNoticeStyle
}

function datosDelAnuncio(
  platform: PosAppPlatformParam,
  nivel: Nivel,
  s: PolicySnapshot,
  actorId: string,
  actorName: string,
  now: Date,
): Prisma.PlatformAnnouncementCreateInput {
  const u = umbral(s, nivel)
  // «Bloquear» siempre es ventana y banner; «Avisar», ventana sólo si se eligió MODAL.
  const ventana = nivel === 'REQUIRED' || s.recommendedNoticeStyle === 'MODAL'
  return {
    title: TEXTO[nivel].title,
    body: s.message ?? TEXTO[nivel].body,
    priority: nivel === 'REQUIRED' ? NotificationPriority.URGENT : NotificationPriority.HIGH,
    actionLabel: 'Actualizar',
    actionUrl: LIGA_DE_LA_TIENDA[platform],
    // Sin audiencia por rol: el inicio lo elige por la versión de la app, no por persona.
    audienceRoles: [],
    showAsBanner: true,
    showAsModal: ventana,
    status: PlatformAnnouncementStatus.PUBLISHED,
    publishedAt: now,
    // Ya «repartido»: el reparto (y el job de lo programado) nunca lo toman, así que nunca nacen acuses ni buzón.
    deliveredAt: now,
    deliveredCount: 0,
    createdBy: actorId,
    createdByName: `${actorName} · Versiones del POS`,
    posAppPlatform: platform,
    posAppNoticeKind: nivel,
    // Sólo el campo que decide en cada plataforma: el número en ANDROID y el nombre en iOS.
    posAppBelowVersionCode: platform === 'ANDROID' ? u.code : null,
    posAppBelowVersionName: platform === 'IOS' ? u.name : null,
  }
}

/**
 * Deja los avisos de actualizar al día con la política recién escrita. Por cada nivel:
 * - quedó en `null` → archiva su anuncio, si había;
 * - no cambió → conserva su anuncio;
 * - es nuevo o cambió → archiva el anterior y crea otro (el cierre es por anuncio: quien cerró el viejo ve el nuevo).
 *
 * Devuelve los ids que la política debe guardar y lo que se archivó y creó (para la bitácora). No escribe la política.
 */
export async function syncNoticeAnnouncements(
  tx: Prisma.TransactionClient,
  input: { platform: PosAppPlatformParam; before: PolicySnapshot | null; after: PolicySnapshot; actorId: string; actorName: string },
): Promise<{ recommendedAnnouncementId: string | null; requiredAnnouncementId: string | null; archived: string[]; created: string[] }> {
  const { platform, before, after, actorId, actorName } = input
  const now = new Date()
  const archived: string[] = []
  const created: string[] = []

  const sincronizar = async (nivel: Nivel): Promise<string | null> => {
    const anterior = (nivel === 'REQUIRED' ? before?.requiredAnnouncementId : before?.recommendedAnnouncementId) ?? null
    const vivo = hayNivel(after, nivel)

    // Sigue igual y tiene su anuncio: se queda. (Sin anuncio, se crea: un nivel vivo siempre lleva su aviso.)
    if (vivo && before && hayNivel(before, nivel) && !cambioElNivel(before, after, nivel) && anterior) return anterior

    if (anterior) {
      await tx.platformAnnouncement.update({ where: { id: anterior }, data: { status: PlatformAnnouncementStatus.ARCHIVED } })
      archived.push(anterior)
    }
    if (!vivo) return null

    const nuevo = await tx.platformAnnouncement.create({
      data: datosDelAnuncio(platform, nivel, after, actorId, actorName, now),
      select: { id: true },
    })
    created.push(nuevo.id)
    return nuevo.id
  }

  const recommendedAnnouncementId = await sincronizar('RECOMMENDED')
  const requiredAnnouncementId = await sincronizar('REQUIRED')
  return { recommendedAnnouncementId, requiredAnnouncementId, archived, created }
}
