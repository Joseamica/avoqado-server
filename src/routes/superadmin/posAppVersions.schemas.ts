import { z } from 'zod'
import { BadRequestError } from '../../errors/AppError'
import { compareVersionNames, VERSION_NAME_RE } from '../../services/posAppVersion/version'

/**
 * Actualizador del POS — lo que entra (forma). Zod sólo valida FORMA y sus mensajes salen en español (el middleware se los
 * enseña al operador tal cual). Las reglas que cruzan `params.platform` con `body`/`query` viven en `assertPolicyRules` y
 * `assertImpactCandidate`, porque `validateRequest` exige que el esquema exterior sea un `ZodObject` (un `superRefine`
 * exterior lo vuelve `ZodEffects` y el middleware contesta 500).
 */

const CODE_RE = /^[1-9]\d{0,9}$/
const MAX_INT32 = 2147483647
const POLICY_ERROR = 'POS_APP_VERSION_POLICY_INVALID'

const platformParam = z.enum(['ANDROID', 'IOS'], { errorMap: () => ({ message: 'La plataforma debe ser ANDROID o IOS' }) })

/** Texto o número que cumple la regla de `parseVersionCode`; si no, `undefined`. */
const readVersionCode = (v: unknown): number | undefined => {
  const s = typeof v === 'number' ? String(v) : v
  if (typeof s !== 'string' || !CODE_RE.test(s)) return undefined
  const n = Number(s)
  return n <= MAX_INT32 ? n : undefined
}
const readVersionName = (v: unknown): string | undefined => (typeof v === 'string' && VERSION_NAME_RE.test(v) ? v : undefined)

// ---------------------------------------------------------------------------------------------------------------------
// Pública: lo que manda la app al preguntar si debe actualizarse
// ---------------------------------------------------------------------------------------------------------------------

export const publicPosAppVersionQuerySchema = z.object({
  query: z
    .object(
      {
        platform: z.enum(['ANDROID', 'IOS', 'DESKTOP'], { errorMap: () => ({ message: 'La plataforma no es válida' }) }),
        versionCode: z.unknown().optional(),
        versionName: z.unknown().optional(),
        build: z.unknown().optional(),
      },
      { required_error: 'Faltan los datos de la app', invalid_type_error: 'Faltan los datos de la app' },
    )
    .transform((q, ctx) => {
      const out: { platform: 'ANDROID' | 'IOS' | 'DESKTOP'; versionCode?: number; versionName?: string; build?: string } = {
        platform: q.platform,
      }
      const code = readVersionCode(q.versionCode)
      const name = readVersionName(q.versionName)
      // El campo que decide es obligatorio; el informativo mal formado se quita, no falla.
      if (q.platform === 'ANDROID') {
        if (code === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versionCode'], message: 'La versión de la app (versionCode) no es válida' })
          return z.NEVER
        }
        out.versionCode = code
      } else if (q.platform === 'IOS') {
        if (name === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versionName'], message: 'La versión de la app (versionName) no es válida' })
          return z.NEVER
        }
        out.versionName = name
      }
      if (typeof q.build === 'string' && q.build.trim() !== '') out.build = q.build.trim().slice(0, 20)
      return out
    }),
})

// ---------------------------------------------------------------------------------------------------------------------
// Superadmin: poner / quitar la política y ver el impacto
// ---------------------------------------------------------------------------------------------------------------------

const thresholdShape = z.object({
  versionCode: z
    .number({ invalid_type_error: 'El número de versión debe ser un entero' })
    .int('El número de versión debe ser un entero')
    .min(1, 'El número de versión debe ser mayor que 0')
    .max(MAX_INT32, 'El número de versión es demasiado grande')
    .nullish(),
  versionName: z
    .string({ invalid_type_error: 'El nombre de versión no es válido' })
    .regex(VERSION_NAME_RE, 'El nombre de versión no es válido (por ejemplo 1.16.0)')
    .nullish(),
})

const recommendedShape = thresholdShape.extend({
  noticeStyle: z.enum(['BANNER', 'MODAL'], { errorMap: () => ({ message: 'El aviso debe ser banner o ventana' }) }).optional(),
})

const objErr = (campo: string) => ({
  required_error: `Falta ${campo}`,
  invalid_type_error: `${campo[0].toUpperCase()}${campo.slice(1)} no es válido`,
})

export const putPolicySchema = z.object({
  params: z.object({ platform: platformParam }),
  body: z.object({
    required: z.object(thresholdShape.shape, objErr('la versión obligatoria (usa null si no hay)')).nullable(),
    recommended: z.object(recommendedShape.shape, objErr('la versión recomendada (usa null si no hay)')).nullable(),
    message: z
      .string({ invalid_type_error: 'El mensaje debe ser texto' })
      .trim()
      .max(280, 'El mensaje no puede pasar de 280 caracteres')
      .nullish()
      .transform(m => (m ? m : null)),
    expectedVersion: z
      .number({
        required_error: 'Falta la versión esperada (usa null si no hay)',
        invalid_type_error: 'La versión esperada debe ser un entero',
      })
      .int('La versión esperada debe ser un entero')
      .min(1, 'La versión esperada debe ser 1 o más')
      .nullable(),
  }),
})

export const clearPolicySchema = z.object({
  params: z.object({ platform: platformParam }),
  body: z.object({
    expectedVersion: z
      .number({ required_error: 'Falta la versión esperada', invalid_type_error: 'La versión esperada debe ser un entero' })
      .int('La versión esperada debe ser un entero')
      .min(1, 'La versión esperada debe ser 1 o más'),
  }),
})

export const impactQuerySchema = z.object({
  params: z.object({ platform: platformParam }),
  query: z.object({
    versionCode: z
      .unknown()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined) return undefined
        const n = readVersionCode(v)
        if (n === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'El número de versión debe ser un entero válido' })
          return z.NEVER
        }
        return n
      }),
    versionName: z
      .string({ invalid_type_error: 'El nombre de versión no es válido' })
      .regex(VERSION_NAME_RE, 'El nombre de versión no es válido (por ejemplo 1.16.0)')
      .optional(),
    days: z.coerce
      .number({ invalid_type_error: 'Los días deben ser un entero de 1 a 90' })
      .int('Los días deben ser un entero de 1 a 90')
      .min(1, 'Los días deben ser de 1 a 90')
      .max(90, 'Los días deben ser de 1 a 90')
      .default(7),
  }),
})

// ---------------------------------------------------------------------------------------------------------------------
// Reglas que cruzan plataforma con el cuerpo (el controlador las llama después del middleware)
// ---------------------------------------------------------------------------------------------------------------------

export type ThresholdInput = { versionCode: number | null; versionName: string | null }
export type RecommendedInput = ThresholdInput & { noticeStyle: 'BANNER' | 'MODAL' }

type LooseThreshold = { versionCode?: number | null; versionName?: string | null }

const fail = (message: string): never => {
  throw new BadRequestError(message, POLICY_ERROR)
}

function normalizeLevel(platform: 'ANDROID' | 'IOS', level: LooseThreshold, label: string): ThresholdInput {
  const code = level.versionCode ?? null
  const name = level.versionName ?? null
  if (platform === 'IOS') {
    if (code !== null) fail('En iOS la versión se fija por nombre, no por número')
    if (name === null) fail(`En iOS la versión ${label} necesita el nombre de versión (por ejemplo 1.16.0)`)
  } else if (code === null) {
    fail(`En Android la versión ${label} necesita el número de versión (versionCode)`)
  }
  return { versionCode: code, versionName: name }
}

export function assertPolicyRules(
  platform: 'ANDROID' | 'IOS',
  body: { required: LooseThreshold | null; recommended: (LooseThreshold & { noticeStyle?: 'BANNER' | 'MODAL' }) | null },
): { required: ThresholdInput | null; recommended: RecommendedInput | null } {
  const required = body.required ? normalizeLevel(platform, body.required, 'obligatoria') : null
  const recBase = body.recommended ? normalizeLevel(platform, body.recommended, 'recomendada') : null
  if (!required && !recBase) fail('Para quitar las dos mínimas usa Quitar')
  if (required && recBase) {
    const menor =
      platform === 'IOS'
        ? compareVersionNames(recBase.versionName as string, required.versionName as string) < 0
        : (recBase.versionCode as number) < (required.versionCode as number)
    if (menor) fail('La recomendada no puede ser menor que la obligatoria')
  }
  let recommended: RecommendedInput | null = null
  if (recBase) {
    const style = body.recommended?.noticeStyle
    if (style !== 'BANNER' && style !== 'MODAL') fail('Elige cómo se avisa: banner o ventana')
    recommended = { ...recBase, noticeStyle: style as 'BANNER' | 'MODAL' }
  }
  return { required, recommended }
}

export function assertImpactCandidate(
  platform: 'ANDROID' | 'IOS',
  query: { versionCode?: number; versionName?: string },
): { versionCode?: number; versionName?: string } | null {
  if (platform === 'ANDROID') {
    if (query.versionName !== undefined)
      throw new BadRequestError('En Android el impacto se calcula con versionCode, no con versionName', POLICY_ERROR)
    return query.versionCode !== undefined ? { versionCode: query.versionCode } : null
  }
  if (query.versionCode !== undefined) throw new BadRequestError('En iOS la versión se fija por nombre, no por número', POLICY_ERROR)
  return query.versionName !== undefined ? { versionName: query.versionName } : null
}
