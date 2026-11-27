/**
 * Planes editables (B4, Task 2): el nombre de los planes que dicen los correos, los avisos en la app y la descripción de la
 * suscripción en Stripe.
 *
 * Con una versión del editor (`versionQueCobra()` no nula) el nombre es el de esa versión; sin ella —o con la v1—, el de hoy,
 * byte por byte. 🔴 Un aviso nunca falla ni se detiene por esta lectura: si la oferta no se puede leer, se escribe el nombre de hoy
 * y queda un warn.
 */
import logger from '../../config/logger'
import { versionQueCobra } from './planOffer'

export interface NombresDeLosPlanes {
  FREE: string
  PRO: string
  PREMIUM: string
}

const DE_HOY: NombresDeLosPlanes = { FREE: 'Gratis', PRO: 'Pro', PREMIUM: 'Premium' }

/** Nunca lanza: sin versión del editor, o si leer la oferta falla (logger.warn), 'Gratis' / 'Pro' / 'Premium'. */
export async function nombresDeLosPlanes(): Promise<NombresDeLosPlanes> {
  try {
    const version = await versionQueCobra()
    if (!version) return { ...DE_HOY }
    const { definition } = version
    return { FREE: definition.FREE.displayName, PRO: definition.PRO.displayName, PREMIUM: definition.PREMIUM.displayName }
  } catch (error) {
    logger.warn('nombresDeLosPlanes: no se pudo leer la oferta; los avisos llevan el nombre de hoy', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { ...DE_HOY }
  }
}

/** «Plan Avoqado <nombre>» con una versión del editor; sin ella, o si la lectura falla, `nombreDeHoy` (el `Feature.name` de hoy). */
export async function nombreDelPlanParaAvisos(code: 'PLAN_PRO' | 'PLAN_PREMIUM', nombreDeHoy: string): Promise<string> {
  const version = await versionQueCobra().catch(error => {
    logger.warn('nombreDelPlanParaAvisos: no se pudo leer la oferta; el aviso lleva el nombre de hoy', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  if (!version) return nombreDeHoy
  return `Plan Avoqado ${version.definition[code === 'PLAN_PRO' ? 'PRO' : 'PREMIUM'].displayName}`
}

/**
 * Los días de la prueba de UNA suscripción, tal como los leyó Stripe: `round((trial_end − trial_start) / 86400)`. 🔴 Nunca de
 * «lo vigente»: la suscripción pudo abrirse con otra versión. `undefined` si no tuvo prueba o Stripe no trae las dos fechas
 * (el correo cae a «30», como hoy).
 */
export function diasDeLaPrueba(trialStart: number | null | undefined, trialEnd: number | null | undefined): number | undefined {
  if (typeof trialStart !== 'number' || typeof trialEnd !== 'number') return undefined
  const dias = Math.round((trialEnd - trialStart) / 86400)
  return dias > 0 ? dias : undefined
}

/**
 * El nombre de una `Feature` para un aviso (en la app o por correo): un plan pagado (`PLAN_PRO` / `PLAN_PREMIUM`) lleva el nombre
 * del editor («Plan Avoqado <nombre>», `nombreDelPlanParaAvisos`); cualquier otra función, su `Feature.name` de siempre.
 */
export async function nombreDeLaFeatureParaAvisos(feature: { code: string; name: string }): Promise<string> {
  return feature.code === 'PLAN_PRO' || feature.code === 'PLAN_PREMIUM' ? nombreDelPlanParaAvisos(feature.code, feature.name) : feature.name
}
