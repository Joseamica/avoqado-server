/**
 * La cuenta PROVISIONAL que crea la propia invitación al invitar un correo sin cuenta
 * (`team.dashboard.service`): inactiva, sin verificar, sin contraseña, sin Google y nunca usada.
 * Ésa sí se completa al aceptar — es la persona nueva terminando su alta, con el formulario
 * (`invitation.service`) o con Google (`googleOAuth.service`). Cualquier otra cuenta inactiva es una
 * baja, y cualquier otra sin contraseña es REAL (Google, PIN): ésas no se reactivan por aquí.
 */
export function esCuentaProvisional(staff: {
  active: boolean
  emailVerified: boolean
  password: string | null
  googleId: string | null
  lastLoginAt: Date | null
}): boolean {
  return !staff.active && !staff.emailVerified && !staff.password && !staff.googleId && !staff.lastLoginAt
}
