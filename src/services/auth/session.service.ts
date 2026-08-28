import prisma from '@/utils/prismaClient'
import { AuthMethod, Session } from '@prisma/client'

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
      deviceId: input.deviceId ?? null,
      authMethod: input.authMethod,
      parentSessionId: input.parentSessionId ?? null,
    },
  })
}

/**
 * Idempotente: revocar dos veces no es un error. El `where` lleva `revokedAt: null` para que
 * la segunda llamada no toque nada (en vez de leer-y-luego-escribir), así que `count` puede
 * salir en 0 sin que eso sea una falla.
 */
export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await prisma.session.updateMany({
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

/** Una sesión inexistente nunca cuenta como viva — mismo resultado que una ya revocada. */
export async function isSessionAlive(sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { revokedAt: true } })
  return session !== null && session.revokedAt === null
}
