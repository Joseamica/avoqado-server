/**
 * El enlace de la invitación que se le puede MOSTRAR a quien invita (API y MCP).
 *
 * 🔴 Con el enlace en mano, quien invita podía aceptar POR la persona invitada (Codex gpt-6-astra,
 * 24-sep). Si el correo salió, el enlace ya llegó a quien debía y no se devuelve; sólo si el correo
 * FALLÓ se entrega, para que lo comparta a mano (WhatsApp), que es para lo que existía.
 */
export function enlaceParaQuienInvita(result: { emailSent?: boolean; inviteLink?: string | null }): string | null {
  return result.emailSent ? null : (result.inviteLink ?? null)
}
