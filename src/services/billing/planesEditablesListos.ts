import { standardPlanQuote } from '../access/planPricing.constants'

/**
 * Planes editables (B1): los dos requisitos de código para prender el interruptor `PLANES_EDITABLES`.
 *
 * 🔴 En B1 el interruptor NO se puede prender: `SERVIDOR_LISTO_PARA_PLANES_EDITABLES` es `false` y lo cambia a `true` el último
 * bloque del SERVIDOR (B4). Para probar con Stripe de pruebas, la Mac cambia en su copia local (nunca en un commit) este valor y
 * `cuponDeIntroduccionRetirado = () => true`.
 */
export const SERVIDOR_LISTO_PARA_PLANES_EDITABLES = false

/** ¿Ya no existe la promoción `INTRO_PRO_3M` en la cotización estándar? */
export const cuponDeIntroduccionRetirado = (): boolean => standardPlanQuote().legacyIntro === null
