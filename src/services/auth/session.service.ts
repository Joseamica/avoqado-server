import prisma from '@/utils/prismaClient'
import { AuthMethod, Prisma, Session } from '@prisma/client'
import { invalidateSession } from './sessionCache'
import socketManager from '@/communication/sockets/managers/socketManager'

/**
 * Crea una Session — el registro cuyo `id` viaja como claim `sid` dentro del JWT (ver
 * `src/jwt.service.ts`). Revocar esta fila es lo que hace que "cerrar sesión" signifique algo:
 * un token firmado y sin expirar deja de ser válido en cuanto su `sid` apunta a una Session
 * revocada (`isSessionAlive` abajo).
 */
export async function createSession(input: {
  staffId: string
  venueId: string
  deviceId?: string | null
  authMethod: AuthMethod
  parentSessionId?: string | null
}): Promise<Session> {
  return prisma.session.create({
    data: {
      staffId: input.staffId,
      venueId: input.venueId,
      // 🔴 `?? null` no basta: una cadena vacía es un valor válido para `??` y se guardaría tal
      // cual. Y `deviceId: ''` es peligroso, no sólo feo — revocar «las sesiones de este
      // aparato» con la cadena vacía alcanzaría a TODAS las sesiones sin aparato del venue, o
      // sea sacaría a gente de tablets que nadie tocó.
      deviceId: input.deviceId?.trim() || null,
      authMethod: input.authMethod,
      parentSessionId: input.parentSessionId ?? null,
    },
  })
}

/**
 * Idempotente: revocar dos veces no es un error. El `where` lleva `revokedAt: null` para que
 * la segunda llamada no toque nada (en vez de leer-y-luego-escribir), así que `count` puede
 * salir en 0 sin que eso sea una falla.
 *
 * 🔴 [Auditoría Task 9, hallazgo importante] Acepta un `Prisma.TransactionClient` opcional
 * para que quien revoca una Session por reutilización de refresh pueda meterla en la MISMA
 * transacción que revoca la familia de grants — ver `revocarFamilia`/`rotateGrant` en
 * `refreshGrant.service.ts`. Sin `client`, usa el `prisma` de siempre: comportamiento
 * idéntico al de antes de esta tarea para cualquier otro llamador.
 */
export async function revokeSession(sessionId: string, reason: string, client: Prisma.TransactionClient = prisma): Promise<void> {
  await client.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
}

/** Revoca todas las sesiones vivas de una persona (ej. tras cambiar su contraseña). Devuelve cuántas cerró. */
export async function revokeAllSessionsForStaff(staffId: string, reason: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { staffId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
  return result.count
}

/**
 * Cierra las sesiones abiertas en UN aparato — «sacar esta tablet» desde el dashboard.
 *
 * Por qué hace falta, y por qué no basta con lo que ya había: hoy se puede cerrar la sesión de una
 * PERSONA (`revokeAllSessionsForStaff`, que dispara «cerrar sesión en todos mis dispositivos» y el
 * cambio de contraseña). Pero lo que se pierde o se roba es el APARATO, y echar a la persona la
 * saca también de su propio teléfono, que no tiene nada que ver con la tablet extraviada.
 *
 * 🔴 Un `deviceId` vacío NO revoca nada. Sin esta guarda, «sacar el aparato sin id» alcanzaría a
 * todas las sesiones del venue que nacieron sin aparato — es decir, sacaría a gente de tablets que
 * nadie tocó. Es el mismo motivo por el que `createSession` normaliza la cadena vacía a null.
 *
 * La caché se invalida DESPUÉS de escribir en la base y sesión por sesión: sin eso el token sigue
 * sirviendo hasta 60 s, que es justo lo que se midió en vivo con el cambio de usuario. Una tablet
 * robada que sigue cobrando un minuto no es una tablet sacada.
 */
export async function revokeSessionsForDevice(input: { venueId: string; deviceId: string; reason: string }): Promise<number> {
  const deviceId = input.deviceId?.trim()
  if (!deviceId) return 0

  const vivas = await prisma.session.findMany({
    where: { venueId: input.venueId, deviceId, revokedAt: null },
    select: { id: true },
  })
  if (vivas.length === 0) return 0

  const result = await prisma.session.updateMany({
    where: { venueId: input.venueId, deviceId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: input.reason },
  })

  // Best-effort y después del commit, como el resto de los revocadores de la casa. El socket
  // también: cortar el acceso HTTP y dejar la conexión abierta significaría que la tablet que
  // acabas de sacar sigue recibiendo los eventos del negocio en tiempo real.
  for (const s of vivas) {
    await invalidateSession(s.id)
    socketManager.disconnectBySession(s.id)
  }

  return result.count
}

/** Una sesión inexistente nunca cuenta como viva — mismo resultado que una ya revocada. */
export async function isSessionAlive(sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { revokedAt: true } })
  return session !== null && session.revokedAt === null
}
