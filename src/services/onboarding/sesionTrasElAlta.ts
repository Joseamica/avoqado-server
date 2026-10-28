import type { Response } from 'express'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { ponerCookiesDeSesion } from '../../utils/cookiesDeSesion'
import { esSucursalReal } from '../../utils/sucursalDelToken'
import { motivoDeConcesionInvalidada } from '../../utils/passwordChangeGuard'
import { revokeSession } from '../auth/session.service'
import { invalidateSession } from '../auth/sessionCache'
import * as authService from '../dashboard/auth.service'

/** Lo que la renovación lee de la sesión de la petición (el `authContext` del middleware o el del token en `/auth/status`). */
export interface SesionDelAlta {
  userId?: string
  orgId?: string
  venueId?: string | null
  isImpersonating?: boolean
  emitidoMs?: number
}

/**
 * Terminar el alta reemite la sesión con la sucursal REAL (monitor de producción, 19-oct).
 *
 * El alta emite el token del panel con `venueId = 'pending'` (signup.service.ts) y la cookie dura 24 h: sin esto,
 * todo lo que toma la sucursal sólo del token (`/dashboard/tokens/*`, `/google-calendar/oauth/init`) fallaba un día
 * entero. Se hace EXACTAMENTE como el cambio de sucursal: `switchVenueForStaff` (misma verificación de acceso, misma
 * Session y mismo grant de refresco) y las mismas cookies. La usan «Entrar» (`completeV2Onboarding`) y, desde H0
 * (28-oct), `/auth/status` cuando el alta la terminó el cobro, el aviso de Stripe o el barrido.
 *
 * Nunca bloquea: la sucursal ya existe, y sin tokens nuevos la persona puede cambiar de sucursal o volver a
 * entrar. No se reemite:
 * - suplantando: sería darle al superadmin una sesión normal a nombre de la persona suplantada;
 * - si la sesión YA tenía una sucursal real: un reintento desde otra pestaña no le cambia la sucursal en silencio;
 * - si hubo un corte de sesiones («cerrar todas», cambio de contraseña, cuenta desactivada) después de emitirse el
 *   token del alta (Codex r1/r2). Se revisa DESPUÉS de crear la sesión nueva, nunca antes: el corte escribe su fecha y
 *   luego cierra las Session vivas (`cerrarSesionesDeStaff`), así que la nueva o ya existía y el corte la cierra, o el
 *   corte ya se ve aquí y la cerramos nosotros. Revisar antes dejaba la ventana entre la revisión y `createSession`.
 */
export async function renovarSesionConLaSucursal(sesion: SesionDelAlta | undefined, res: Response, venueId: string): Promise<void> {
  if (!sesion?.userId || sesion.isImpersonating || esSucursalReal(sesion.venueId)) return
  try {
    const { accessToken, refreshToken, sessionId } = await authService.switchVenueForStaff(sesion.userId, sesion.orgId as string, venueId)
    const emitido = typeof sesion.emitidoMs === 'number' ? new Date(sesion.emitidoMs) : undefined
    if (await motivoDeConcesionInvalidada(sesion.userId, emitido)) {
      await revokeSession(sessionId, 'sessions_revoked_during_onboarding')
      await invalidateSession(sessionId)
      return
    }
    ponerCookiesDeSesion(res, accessToken, refreshToken)
  } catch (error) {
    // error, no warn: sin esto la persona se queda 24 h en «sucursal pendiente» y el monitor debe verlo.
    logger.error('No se pudo renovar la sesión con la sucursal al terminar el alta', { userId: sesion.userId, venueId, error })
  }
}

/**
 * H0: la sucursal que le toca a una sesión `pending` cuando el alta YA terminó (las dos marcas: progreso y organización),
 * o `null`. Sólo una sucursal activa de esa persona en esa organización, fuera de ONBOARDING.
 */
export async function sucursalDelAltaTerminada(staffId: string, orgId: string | undefined): Promise<string | null> {
  if (!orgId) return null
  const alta = await prisma.onboardingProgress.findUnique({
    where: { organizationId: orgId },
    select: { completedAt: true, organization: { select: { onboardingCompletedAt: true } } },
  })
  if (!alta?.completedAt || !alta.organization?.onboardingCompletedAt) return null
  const asignacion = await prisma.staffVenue.findFirst({
    where: { staffId, active: true, venue: { organizationId: orgId, status: { not: 'ONBOARDING' } } },
    orderBy: { venue: { createdAt: 'asc' } },
    select: { venueId: true },
  })
  return asignacion?.venueId ?? null
}
