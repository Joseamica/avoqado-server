/**
 * S7 — versiones del texto legal que el alta acepta (spec 2026-09-17 § 4.1).
 *
 * 🔴 Hay DOS constantes con este nombre: ésta y la del dashboard (`src/config/legal.ts` allá).
 * Quien edite el texto legal actualiza LAS DOS en el mismo cambio.
 */

/**
 * 🔴 EL IDENTIFICADOR NO PUEDE TENER FORMA DE FECHA, y no es estilo: es lo único que impide
 * fabricar un consentimiento que nadie dio.
 *
 * El dashboard de producción manda **la fecha del día** (`new Date().toISOString().split('T')[0]`,
 * `SetupWizard.tsx:334`). Si `current` fuera `'2026-09-17'`, ese día —el del deploy— las dos
 * cadenas coincidirían byte a byte: `isAcceptedLegalVersion` diría `true`, se guardaría como
 * aceptación del texto NUEVO, `consentRequired` quedaría en `false` y el dashboard nuevo **jamás**
 * volvería a pedir la casilla. Un registro legal falso, irreversible y silencioso.
 *
 * Con el prefijo `v1-`, `LEGACY_DATE_VERSION_RE` cubre el 100 % de lo que manda el dashboard
 * viejo, hoy y cualquier otro día, y la rama heredada de abajo hace su trabajo de verdad.
 * Prueba que lo fija: `tests/unit/config/legal.test.ts`.
 */

export const LEGAL_VERSIONS = {
  current: 'v1-2026-09-17',
  accepted: ['v1-2026-09-17'] as const,
}

/**
 * 🔴 LA REGLA TRANSITORIA QUE HACE POSIBLE EL DESPLIEGUE ESCALONADO, y no se puede quitar antes
 * de tiempo.
 *
 * El dashboard que está HOY en producción manda como versión **la fecha del día**
 * (`new Date().toISOString().split('T')[0]`, `SetupWizard.tsx:332`). Si `accept-terms` la
 * rechazara con 409, el `catch` del asistente se tragaría el error y la finalización —que ahora
 * exige consentimiento— dejaría **atrapada a toda el alta en vuelo** del día del deploy, sin
 * mensaje que lo explique. No es un caso raro: es todo el tráfico de altas de esa ventana.
 *
 * Por eso una cadena con forma de fecha se ACEPTA, se guarda y deja `consentRequired: true`,
 * de modo que el dashboard nuevo vuelve a pedir la casilla cuando llegue.
 *
 * 🔴 SE RETIRA en el MISMO cambio que enciende `ONBOARDING_SHORT_FLOW` (D14), que es cuando ya
 * no queda ningún dashboard viejo mandando fechas. Es una tarea, no una intención.
 */
export const LEGACY_DATE_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/

export type LegalConsentState = {
  currentVersion: string
  acceptedVersion: string | null
  consentRequired: boolean
}

/** ¿Esta versión es una de las que el texto vigente declara? */
export function isAcceptedLegalVersion(version: string | null | undefined): boolean {
  return typeof version === 'string' && (LEGAL_VERSIONS.accepted as readonly string[]).includes(version)
}

/** ¿Es una versión HEREDADA con forma de fecha (lo que manda el dashboard viejo)? */
export function isLegacyDateVersion(version: string | null | undefined): boolean {
  return typeof version === 'string' && LEGACY_DATE_VERSION_RE.test(version) && !isAcceptedLegalVersion(version)
}

/** El bloque `legal` que viaja en `GET progress`. */
export function legalConsentState(acceptedVersion: string | null | undefined): LegalConsentState {
  return {
    currentVersion: LEGAL_VERSIONS.current,
    acceptedVersion: acceptedVersion ?? null,
    consentRequired: !isAcceptedLegalVersion(acceptedVersion),
  }
}
