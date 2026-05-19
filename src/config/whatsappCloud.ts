// Centralized getters for WhatsApp Cloud API env vars consumed by the venue
// chat webhook + relay. Each throws on first call if missing so a missing var
// surfaces at startup (or first webhook hit) rather than as a confusing 500
// deep inside the handler. Per spec §Env vars and Phase 4 Task 4.1.

export function getWhatsappVerifyToken(): string {
  const v = process.env.WHATSAPP_VERIFY_TOKEN
  if (!v) throw new Error('WHATSAPP_VERIFY_TOKEN env var is required')
  return v
}

export function getWhatsappAppSecret(): string {
  const v = process.env.WHATSAPP_APP_SECRET
  if (!v) throw new Error('WHATSAPP_APP_SECRET env var is required')
  return v
}

export function getWhatsappCentralNumber(): string {
  const v = process.env.WHATSAPP_CENTRAL_NUMBER_E164
  if (!v) throw new Error('WHATSAPP_CENTRAL_NUMBER_E164 env var is required')
  return v
}

export function getWhatsappAdminAlertEmail(): string | null {
  return process.env.WHATSAPP_ADMIN_ALERT_EMAIL || null
}
