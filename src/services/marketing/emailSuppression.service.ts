import prisma from '@/utils/prismaClient'
import type { EmailSuppressionReason } from '@prisma/client'

/**
 * Supresión GLOBAL de correo — Fase 1A del carril de campañas.
 *
 * 🔴 Es GLOBAL por email normalizado, no por venue: la reputación del subdominio de marketing
 * (`@promos.avoqado.io`, ver `marketingSender.ts`) es COMPARTIDA entre todos los negocios que
 * mandan campañas desde él. Un rebote duro o una queja de spam vistos al mandarle a un cliente
 * del venue A dañan la entregabilidad de TODOS los demás venues si se le sigue escribiendo — así
 * que la supresión protege al subdominio entero, sin importar desde qué venue se detectó.
 *
 * La baja VOLUNTARIA (el destinatario se da de baja de un venue en particular) NO vive aquí: es
 * `ConsentEvent`, por venue — alguien puede darse de baja de los correos de un negocio sin que
 * eso suprima los de otro. Esta tabla es sólo para señales de ENTREGABILIDAD (rebote duro,
 * queja), que sí son un riesgo compartido.
 */

/**
 * Normaliza un email a su forma canónica: minúsculas + recorte de espacios, y NADA MÁS.
 *
 * 🔴 A propósito NO aplica trucos por proveedor (quitar los puntos de Gmail, recortar la
 * etiqueta `+algo`): esos alias resuelven al MISMO buzón para Gmail, pero normalizarlos aquí
 * suprimiría a una persona DISTINTA de la que en realidad rebotó — `ana+promos@gmail.com` y
 * `ana@gmail.com` pueden ser dos destinatarios reales de campañas distintas. La única
 * normalización segura es la que no cambia a QUIÉN identifica la dirección.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** ¿El email (se normaliza aquí) está suprimido globalmente? */
export async function isSuppressed(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email)
  const suppression = await prisma.emailSuppression.findUnique({ where: { email: normalized } })
  return suppression !== null
}

/**
 * Registra (o refuerza) una supresión. Idempotente: una segunda señal del MISMO email no crea
 * una fila nueva, incrementa `occurrences` y mueve `lastSeenAt` — el historial de cuántas veces
 * y cuándo se ha visto rebotar/quejarse importa para diagnosticar, `firstSeenAt` no se toca.
 */
export async function recordSuppression(email: string, reason: EmailSuppressionReason): Promise<void> {
  const normalized = normalizeEmail(email)
  await prisma.emailSuppression.upsert({
    where: { email: normalized },
    create: { email: normalized, reason },
    update: { occurrences: { increment: 1 }, lastSeenAt: new Date(), reason },
  })
}
