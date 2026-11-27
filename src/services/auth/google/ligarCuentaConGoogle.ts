import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * Una sola regla para ligar una cuenta de Avoqado con Google (panel y POS; hz:6bfcd3a1:D1).
 * No revisa `active`: quien llama ya decidió si la cuenta puede entrar.
 */
export interface CuentaParaLigar {
  id: string
  googleId: string | null
  photoUrl: string | null
  emailVerified: boolean
  password: string | null
}

export async function ligarCuentaConGoogle(
  cuenta: CuentaParaLigar,
  google: { sub: string; picture?: string | null },
  organizationId: string | null,
): Promise<{ aplicada: boolean; contrasenaAnulada: boolean }> {
  const data: Prisma.StaffUpdateManyMutationInput = { lastLoginAt: new Date() }
  if (!cuenta.googleId) data.googleId = google.sub
  if (!cuenta.photoUrl && google.picture) data.photoUrl = google.picture
  if (!cuenta.emailVerified) {
    data.emailVerified = true
    // 🔴 Google demuestra que el correo es de ESTA persona; una contraseña puesta en una cuenta que nadie
    // verificó no demuestra nada (si no, quien registró tu correo con SU contraseña seguiría entrando).
    if (cuenta.password) data.password = null
  }

  if (Object.keys(data).length > 1) {
    // Condicionada a lo que leyó quien llama: si la cuenta cambió entre la lectura y la escritura, no pisa nada.
    const { count } = await prisma.staff.updateMany({
      where: { id: cuenta.id, googleId: cuenta.googleId, emailVerified: cuenta.emailVerified, password: cuenta.password },
      data,
    })
    if (count === 0) return { aplicada: false, contrasenaAnulada: false }
  }

  const contrasenaAnulada = data.password === null
  if (contrasenaAnulada) {
    // Cambio de ACCESO: queda en la bitácora, en su COLUMNA de organización (si no, el cliente no la ve).
    void logAction({
      staffId: cuenta.id,
      organizationId,
      action: 'STAFF_PASSWORD_INVALIDATED_BY_GOOGLE',
      entity: 'Staff',
      entityId: cuenta.id,
      data: { reason: 'unverified_account_verified_by_google' },
    })
    logger.warn('Google OAuth: cuenta sin verificar verificada por Google; su contraseña previa deja de servir', {
      staffId: cuenta.id,
    })
  }
  return { aplicada: true, contrasenaAnulada }
}
