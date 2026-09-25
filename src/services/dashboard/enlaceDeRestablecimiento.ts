/**
 * El enlace para elegir una contraseña nueva: token aleatorio de un solo uso, guardado como SHA-256, que
 * vence en 1 hora, y el correo que lo lleva. Lo usan el «olvidé mi contraseña» y el restablecimiento que pide
 * el DUEÑO (decisión del founder, 24-sep: el dueño ya no ve una contraseña temporal; al empleado le llega
 * este enlace a SU correo).
 *
 * Generar uno nuevo invalida el anterior (se sobrescribe el token).
 */
import crypto from 'crypto'
import prisma from '../../utils/prismaClient'
import emailService from '../email.service'

export const MINUTOS_DE_VIGENCIA = 60

/** Devuelve si el correo salió. El token queda guardado aunque el correo falle. */
export async function enviarEnlaceDeRestablecimiento(staff: { id: string; email: string; firstName: string | null }): Promise<boolean> {
  // SHA-256 basta: el token es aleatorio (256 bits), vence y es de un solo uso; permite buscarlo en O(1).
  const resetToken = crypto.randomBytes(32).toString('hex')
  const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex')
  const vence = new Date(Date.now() + MINUTOS_DE_VIGENCIA * 60 * 1000)

  await prisma.staff.update({
    where: { id: staff.id },
    data: { resetToken: hashedToken, resetTokenExpiry: vence, resetTokenUsedAt: null },
  })

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
  return emailService.sendPasswordResetEmail(staff.email, {
    firstName: staff.firstName ?? '',
    resetLink: `${frontendUrl}/auth/reset-password/${resetToken}`,
    expiresInMinutes: MINUTOS_DE_VIGENCIA,
  })
}

/** `juana.perez@correo.mx` → `j•••@correo.mx`: el dueño sabe a dónde se fue sin exponer el correo completo. */
export function enmascararCorreo(correo: string): string {
  const [local, dominio] = correo.split('@')
  if (!dominio) return '•••'
  return `${local.slice(0, 1)}•••@${dominio}`
}
