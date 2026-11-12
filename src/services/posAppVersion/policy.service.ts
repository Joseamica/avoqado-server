// Actualizador del POS — la política de versión mínima por plataforma (spec §4.3).
//
// Leer, poner y quitar. Cada escritura es UNA transacción, sin reintento:
// 1. CAS por `version`: `null` sólo crea (la primera vez de cada plataforma); con número, `updateMany` condicional que sube 1.
// 2. Los avisos de actualizar (anuncios de plataforma, §4.7) se crean y archivan en la misma transacción.
// 3. La bitácora va DENTRO (`tx.activityLog.create`, no `logAction`): o quedan el cambio y su asiento, o ninguno.
// Un choque de concurrencia (P2002/P2034) es 409 y nunca se reintenta solo: reintentar con un token releído convertiría una
// operación vieja en una sobrescritura.
//
// La fila nunca se borra: «quitar» deja los niveles en null y sube `version`, así el contador nunca vuelve a 1.
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'
import { MASTER_ADMIN_PRINCIPAL_ID } from '@/lib/authPrincipals'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import type { RecommendedInput, ThresholdInput } from '@/routes/superadmin/posAppVersions.schemas'
import type { PolicyLevels, VersionThreshold } from './decide'
import { syncNoticeAnnouncements, type PolicySnapshot, type PosAppNoticeStyleValue } from './notice.service'

export const POLICY_CHANGED = 'POS_APP_VERSION_POLICY_CHANGED'
const MENSAJE_DEL_409 = 'Alguien cambió esta versión mínima mientras tanto. Vuelve a cargar'

type Plataforma = 'ANDROID' | 'IOS'

export interface PolicyView {
  exists: boolean
  version: number | null
  required: VersionThreshold | null
  recommended: (VersionThreshold & { noticeStyle: PosAppNoticeStyleValue | null }) | null
  message: string | null
  updatedAt: string | null
  updatedBy: { id: string; name: string } | null
}

type FilaDePolitica = {
  requiredMinVersionCode: number | null
  requiredMinVersionName: string | null
  recommendedMinVersionCode: number | null
  recommendedMinVersionName: string | null
  recommendedNoticeStyle: PosAppNoticeStyleValue | null
  message: string | null
  recommendedAnnouncementId: string | null
  requiredAnnouncementId: string | null
  version: number
  updatedById: string | null
  updatedAt: Date
}

/** Los campos de nivel que escribe una operación (los mismos en crear, cambiar y quitar). */
type NivelesAEscribir = Pick<
  FilaDePolitica,
  | 'requiredMinVersionCode'
  | 'requiredMinVersionName'
  | 'recommendedMinVersionCode'
  | 'recommendedMinVersionName'
  | 'recommendedNoticeStyle'
  | 'message'
>

const VISTA_VACIA: PolicyView = {
  exists: false,
  version: null,
  required: null,
  recommended: null,
  message: null,
  updatedAt: null,
  updatedBy: null,
}

const conflicto = () => new ConflictError(MENSAJE_DEL_409, POLICY_CHANGED)

function nivel(code: number | null, name: string | null): VersionThreshold | null {
  return code === null && name === null ? null : { versionCode: code, versionName: name }
}

function niveles(fila: NivelesAEscribir): PolicyLevels {
  return {
    required: nivel(fila.requiredMinVersionCode ?? null, fila.requiredMinVersionName ?? null),
    recommended: nivel(fila.recommendedMinVersionCode ?? null, fila.recommendedMinVersionName ?? null),
  }
}

/** El nombre de quien escribió: su nombre de Staff; el Master Admin (sin fila de Staff) o alguien que ya no está, genérico. */
function nombreDelActor(id: string, staff: { firstName: string | null; lastName: string | null } | null | undefined): string {
  const completo = staff ? `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim() : ''
  if (completo) return completo
  return id === MASTER_ADMIN_PRINCIPAL_ID ? 'Master Admin' : 'Superadmin'
}

function aVista(fila: FilaDePolitica, updatedBy: PolicyView['updatedBy']): PolicyView {
  const { required, recommended } = niveles(fila)
  return {
    exists: true,
    version: fila.version,
    required,
    recommended: recommended ? { ...recommended, noticeStyle: fila.recommendedNoticeStyle ?? null } : null,
    message: fila.message ?? null,
    updatedAt: fila.updatedAt.toISOString(),
    updatedBy,
  }
}

function aSnapshot(fila: FilaDePolitica): PolicySnapshot {
  return {
    requiredMinVersionCode: fila.requiredMinVersionCode ?? null,
    requiredMinVersionName: fila.requiredMinVersionName ?? null,
    recommendedMinVersionCode: fila.recommendedMinVersionCode ?? null,
    recommendedMinVersionName: fila.recommendedMinVersionName ?? null,
    recommendedNoticeStyle: fila.recommendedNoticeStyle ?? null,
    message: fila.message ?? null,
    recommendedAnnouncementId: fila.recommendedAnnouncementId ?? null,
    requiredAnnouncementId: fila.requiredAnnouncementId ?? null,
    version: fila.version,
  }
}

/** Lo que guarda la bitácora de cada revisión: los cuatro campos de nivel, la forma del aviso, el mensaje y el token. */
function paraBitacora(s: PolicySnapshot | null) {
  if (!s) return null
  return {
    requiredMinVersionCode: s.requiredMinVersionCode,
    requiredMinVersionName: s.requiredMinVersionName,
    recommendedMinVersionCode: s.recommendedMinVersionCode,
    recommendedMinVersionName: s.recommendedMinVersionName,
    recommendedNoticeStyle: s.recommendedNoticeStyle,
    message: s.message,
    version: s.version,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------------------------------

/** Las dos plataformas para el SUPERADMIN. Distingue «nunca hubo» (`exists: false`) de «se quitó» (`exists: true`, niveles null). */
export async function getPolicies(): Promise<{ ANDROID: PolicyView; IOS: PolicyView }> {
  // A lo más dos filas: una por plataforma (`platform` es @unique).
  const filas = (await prisma.posAppVersionPolicy.findMany({ take: 2 })) as Array<FilaDePolitica & { platform: Plataforma }>

  const ids = Array.from(new Set(filas.map(f => f.updatedById).filter((id): id is string => !!id)))
  const personas = ids.length
    ? await prisma.staff.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true }, take: 2 })
    : []
  const porId = new Map(personas.map(p => [p.id, p]))

  const vista = (platform: Plataforma): PolicyView => {
    const fila = filas.find(f => f.platform === platform)
    if (!fila) return { ...VISTA_VACIA }
    const updatedBy = fila.updatedById
      ? { id: fila.updatedById, name: nombreDelActor(fila.updatedById, porId.get(fila.updatedById)) }
      : null
    return aVista(fila, updatedBy)
  }
  return { ANDROID: vista('ANDROID'), IOS: vista('IOS') }
}

/** Lo que necesita la ruta pública: los niveles y el mensaje, en la misma lectura. `null` si nunca hubo política. */
export async function getPublicPolicy(platform: Plataforma): Promise<{ levels: PolicyLevels; message: string | null } | null> {
  const fila = await prisma.posAppVersionPolicy.findUnique({
    where: { platform },
    select: {
      requiredMinVersionCode: true,
      requiredMinVersionName: true,
      recommendedMinVersionCode: true,
      recommendedMinVersionName: true,
      recommendedNoticeStyle: true,
      message: true,
    },
  })
  if (!fila) return null
  return { levels: niveles(fila), message: fila.message ?? null }
}

// ---------------------------------------------------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------------------------------------------------

async function escribir(input: {
  platform: Plataforma
  expectedVersion: number | null
  actorId: string
  datos: NivelesAEscribir
  action: 'POS_APP_VERSION_POLICY_SET' | 'POS_APP_VERSION_POLICY_CLEARED'
}): Promise<PolicyView> {
  const { platform, expectedVersion, actorId, datos, action } = input
  try {
    return await prisma.$transaction(async tx => {
      let before: FilaDePolitica | null
      let escrita: FilaDePolitica | null

      if (expectedVersion === null) {
        // Crear: sólo la primera vez. Si otro la crea al mismo tiempo, el @unique de `platform` da P2002 (abajo, 409).
        if (await tx.posAppVersionPolicy.findUnique({ where: { platform } })) throw conflicto()
        escrita = await tx.posAppVersionPolicy.create({ data: { platform, ...datos, updatedById: actorId, version: 1 } })
        before = null
      } else {
        // El `before` se lee con el MISMO token: así es siempre la revisión que de verdad se sustituye.
        before = await tx.posAppVersionPolicy.findFirst({ where: { platform, version: expectedVersion } })
        if (!before) throw conflicto()
        const { count } = await tx.posAppVersionPolicy.updateMany({
          where: { platform, version: expectedVersion },
          data: { ...datos, updatedById: actorId, version: { increment: 1 } },
        })
        if (count !== 1) throw conflicto()
        escrita = await tx.posAppVersionPolicy.findUnique({ where: { platform } })
        if (!escrita) throw conflicto()
      }

      const staff = await tx.staff.findUnique({ where: { id: actorId }, select: { firstName: true, lastName: true } })
      const actorName = nombreDelActor(actorId, staff)

      const anuncios = await syncNoticeAnnouncements(tx, {
        platform,
        before: before ? aSnapshot(before) : null,
        after: aSnapshot(escrita),
        actorId,
        actorName,
      })

      // Parte de la MISMA escritura: sólo cambia los dos ids, NO sube `version` otra vez.
      const after = await tx.posAppVersionPolicy.update({
        where: { platform },
        data: {
          recommendedAnnouncementId: anuncios.recommendedAnnouncementId,
          requiredAnnouncementId: anuncios.requiredAnnouncementId,
        },
      })

      // Bitácora durable, dentro de la transacción. `writeLegacyActivityAuditTx` es `tx.activityLog.create` y no atrapa:
      // si falla, se cae todo. Además deja al Master Admin (sin fila de Staff) sin la llave foránea, con su id en `data`.
      await writeLegacyActivityAuditTx(tx, {
        staffId: actorId,
        venueId: null,
        action,
        entity: 'PosAppVersionPolicy',
        entityId: platform,
        data: {
          platform,
          before: paraBitacora(before ? aSnapshot(before) : null),
          after: paraBitacora(aSnapshot(after)),
          announcements: { archived: anuncios.archived, created: anuncios.created },
        },
      })

      return aVista(after, { id: actorId, name: actorName })
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2002' || err.code === 'P2034')) throw conflicto()
    throw err
  }
}

/** Pone o cambia las mínimas. Es un reemplazo completo: un nivel en `null` se quita (y su aviso se archiva). */
export async function setPolicy(input: {
  platform: Plataforma
  required: ThresholdInput | null
  recommended: RecommendedInput | null
  message: string | null
  expectedVersion: number | null
  actorId: string
}): Promise<PolicyView> {
  return escribir({
    platform: input.platform,
    expectedVersion: input.expectedVersion,
    actorId: input.actorId,
    action: 'POS_APP_VERSION_POLICY_SET',
    datos: {
      requiredMinVersionCode: input.required?.versionCode ?? null,
      requiredMinVersionName: input.required?.versionName ?? null,
      recommendedMinVersionCode: input.recommended?.versionCode ?? null,
      recommendedMinVersionName: input.recommended?.versionName ?? null,
      // Sin recomendada no hay forma de aviso.
      recommendedNoticeStyle: input.recommended?.noticeStyle ?? null,
      message: input.message ?? null,
    },
  })
}

/** Quita las dos mínimas: niveles, forma y mensaje en null, sube `version` y NO borra la fila. */
export async function clearPolicy(input: { platform: Plataforma; expectedVersion: number; actorId: string }): Promise<PolicyView> {
  return escribir({
    platform: input.platform,
    expectedVersion: input.expectedVersion,
    actorId: input.actorId,
    action: 'POS_APP_VERSION_POLICY_CLEARED',
    datos: {
      requiredMinVersionCode: null,
      requiredMinVersionName: null,
      recommendedMinVersionCode: null,
      recommendedMinVersionName: null,
      recommendedNoticeStyle: null,
      message: null,
    },
  })
}
