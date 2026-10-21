import { Prisma } from '@prisma/client'

/**
 * Lo único de un `Staff` que puede salir en una respuesta HTTP cuando viaja como relación
 * (`processedBy`, `createdBy`, `servedBy`, `staff`…).
 *
 * 🔴 Por qué existe (30-sep-2026): `include: { processedBy: true }` trae la fila ENTERA, y el
 * cobro rápido la devolvía tal cual a cada POS y TPV: hash de la contraseña, token de
 * restablecimiento y código de verificación del correo del empleado que cobró. El omit global
 * de `prismaClient.ts` no sirve aquí: el login y la verificación de correo leen esos campos
 * sin `select`, y romperlos es peor que la fuga.
 *
 * Se conservan todos los campos no secretos para no quitarle a una app vieja un campo que ya
 * leía (regla: nunca se quita un campo de una respuesta). Un campo nuevo de `Staff` tiene que
 * caer en esta lista o en `STAFF_SECRET_FIELDS`: la prueba `staffPublicSelect.test.ts` falla
 * si no está en ninguna.
 */
export const STAFF_PUBLIC_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  employeeCode: true,
  photoUrl: true,
  active: true,
  emailVerified: true,
  originSystem: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
} as const satisfies Prisma.StaffSelect

/** El empleado tal como sale en una respuesta. */
export type StaffPublico = Prisma.StaffGetPayload<{ select: typeof STAFF_PUBLIC_SELECT }>

/** Campos de `Staff` que nunca salen como relación en una respuesta. */
export const STAFF_SECRET_FIELDS = [
  'password',
  'googleId',
  'emailVerificationCode',
  'emailVerificationExpires',
  'posRawData',
  'failedLoginAttempts',
  'lockedUntil',
  'resetToken',
  'resetTokenExpiry',
  'resetTokenUsedAt',
  'lastPasswordReset',
  'sessionsRevokedAt',
] as const
