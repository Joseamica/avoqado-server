/**
 * S6 — de dónde vino este cliente (spec 2026-09-17 § 3.5).
 *
 * Los UTMs vivían dentro de `public.routes.ts`; se mueven aquí SIN CAMBIOS para que el alta por
 * el dashboard guarde exactamente la misma lista que el formulario de la landing. Hay una prueba
 * que compara la lista permitida elemento por elemento: si alguien agrega una llave a un lado y
 * no al otro, la atribución de los dos caminos deja de ser comparable y nadie se entera.
 */
import { z } from 'zod'
import { LANDING_SLUG_RE, LAUNCH_CAMPAIGN_CODE_RE } from '../services/launchCampaigns/launchCampaign.schema'

/**
 * Llaves de campaña que la landing propaga.
 *
 * 🔴 Allowlist con tope de largo, no un `record` abierto: esto viene de internet SIN autenticar
 * y se guarda en una columna JSON del progreso y de la bitácora. Lo que no esté aquí se descarta
 * EN SILENCIO — perder un parámetro de marketing nunca puede costar un lead.
 */
export const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
] as const

export const utmSchema = z
  .record(z.string(), z.string())
  .optional()
  .transform(u => {
    if (!u) return undefined
    const limpio: Record<string, string> = {}
    for (const k of UTM_KEYS) {
      const v = u[k]
      if (typeof v === 'string' && v.trim()) limpio[k] = v.trim().slice(0, 200)
    }
    return Object.keys(limpio).length > 0 ? limpio : undefined
  })

/**
 * El código de campaña que viaja con el alta.
 *
 * 🔴 DESCARTE SILENCIOSO, igual que los UTMs: un código mal escrito (o inventado por un bot)
 * NO puede tumbar un alta con un 400. Se pierde la atribución, que vale mucho menos que el lead.
 */
/**
 * 🔴 Acepta el CÓDIGO o el SLUG, porque el anuncio manda el que sea: el CTA de `/oferta/pos-22`
 * lleva el slug, y es lo que el visitante ve en la barra del navegador. Subirlo todo a mayúsculas
 * y exigir forma de código descartaba en SILENCIO cualquier slug de más de 32 caracteres —
 * `landingSlug` admite hasta 60— y con él la oferta y la atribución de un clic ya pagado.
 *
 * Se conserva la forma de cada uno (código en MAYÚSCULAS, slug en minúsculas) y quien resuelve es
 * `findClaimableByCodeOrSlug`, que prueba primero por código.
 */
export const optionalLaunchCampaignCode = z
  .string()
  .optional()
  .transform(v => {
    const s = v?.trim()
    if (!s) return undefined
    const comoCodigo = s.toUpperCase()
    if (LAUNCH_CAMPAIGN_CODE_RE.test(comoCodigo)) return comoCodigo
    const comoSlug = s.toLowerCase()
    const largoDeSlugValido = comoSlug.length >= 3 && comoSlug.length <= 60
    return largoDeSlugValido && LANDING_SLUG_RE.test(comoSlug) ? comoSlug : undefined
  })

/** De qué pantalla salió el alta. Es texto plano: la lista vive en el comentario del schema. */
export type AcquisitionSource =
  | 'landing_oferta'
  | 'landing_contacto'
  | 'landing_restaurantes'
  | 'dashboard_signup'
  | 'dashboard_signup_google'
  | 'dashboard_attach'
