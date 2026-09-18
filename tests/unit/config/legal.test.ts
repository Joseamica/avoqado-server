/**
 * S7 — versiones del texto legal (spec 2026-09-17 § 4.1).
 *
 * 🔴 EL DEFECTO QUE ESTO CIERRA, y es el único de esta tanda donde DESPLEGAR fabrica un registro
 * legal falso sobre un cliente, sin vuelta atrás:
 *
 * El dashboard que está HOY en producción manda como versión **la fecha del día**
 * (`new Date().toISOString().split('T')[0]`, `SetupWizard.tsx:334`). Mientras el identificador
 * declarado por el servidor TENGA FORMA DE FECHA, hay un día del calendario —justo el del deploy—
 * en que las dos cadenas coinciden byte a byte: `isAcceptedLegalVersion` devuelve `true`, se guarda
 * como si esa persona hubiera aceptado el texto NUEVO, `consentRequired` queda en `false` y el
 * dashboard nuevo **ya nunca vuelve a pedir la casilla**. Queda un consentimiento que nadie dio.
 *
 * Por eso la regla no es «el 17 de septiembre es un caso especial» sino la invariante de abajo:
 * NINGUNA versión declarada puede tener forma de fecha. Así `LEGACY_DATE_VERSION_RE` cubre el
 * 100 % de lo que manda el dashboard viejo, hoy y cualquier otro día.
 */
import {
  isAcceptedLegalVersion,
  isLegacyDateVersion,
  legalConsentState,
  LEGACY_DATE_VERSION_RE,
  LEGAL_VERSIONS,
} from '../../../src/config/legal'

/** Exactamente lo que hace `SetupWizard.tsx:334` en el dashboard de producción. */
function versionQueMandaElDashboardViejo(): string {
  return new Date().toISOString().split('T')[0]
}

describe('🔴 ninguna versión declarada puede tener FORMA DE FECHA', () => {
  it('`current` no es una fecha: si lo fuera, el dashboard viejo la acertaría por casualidad ese día', () => {
    expect(LEGACY_DATE_VERSION_RE.test(LEGAL_VERSIONS.current)).toBe(false)
  })

  it('ninguna de las versiones aceptadas tiene forma de fecha', () => {
    for (const v of LEGAL_VERSIONS.accepted) {
      expect(LEGACY_DATE_VERSION_RE.test(v)).toBe(false)
    }
  })

  it('`current` está dentro de `accepted` (si no, nadie podría consentir la vigente)', () => {
    expect(LEGAL_VERSIONS.accepted).toContain(LEGAL_VERSIONS.current)
  })
})

describe('🔴 el día del deploy: la fecha del dashboard viejo NUNCA es un consentimiento', () => {
  const RELOJ_DEL_DEPLOY = new Date('2026-09-17T12:00:00.000Z')

  beforeAll(() => {
    jest.useFakeTimers()
    jest.setSystemTime(RELOJ_DEL_DEPLOY)
  })
  afterAll(() => {
    jest.useRealTimers()
  })

  it('el reloj está congelado en el día que hace peligroso este caso', () => {
    expect(versionQueMandaElDashboardViejo()).toBe('2026-09-17')
  })

  it('🔴 NO se lee como versión aceptada', () => {
    expect(isAcceptedLegalVersion(versionQueMandaElDashboardViejo())).toBe(false)
  })

  it('🔴 se lee como HEREDADA, que es la rama que la guarda sin darla por consentida', () => {
    expect(isLegacyDateVersion(versionQueMandaElDashboardViejo())).toBe(true)
  })

  it('🔴 deja `consentRequired: true`, así que el dashboard nuevo vuelve a pedir la casilla', () => {
    expect(legalConsentState(versionQueMandaElDashboardViejo())).toEqual({
      currentVersion: LEGAL_VERSIONS.current,
      acceptedVersion: '2026-09-17',
      consentRequired: true,
    })
  })
})

describe('cualquier otro día del calendario se comporta igual (no era un caso especial del 17)', () => {
  it.each([['2026-09-16'], ['2026-09-18'], ['2027-01-01'], ['2020-02-29']])('%s → heredada, nunca aceptada', fecha => {
    expect(isAcceptedLegalVersion(fecha)).toBe(false)
    expect(isLegacyDateVersion(fecha)).toBe(true)
    expect(legalConsentState(fecha).consentRequired).toBe(true)
  })
})

// ── REGRESIÓN: lo que ya funcionaba sigue igual ───────────────────────────────
describe('regresión — la versión vigente sí consiente, y la basura sigue siendo 409', () => {
  it('la versión declarada se acepta y cubre el consentimiento', () => {
    expect(isAcceptedLegalVersion(LEGAL_VERSIONS.current)).toBe(true)
    expect(isLegacyDateVersion(LEGAL_VERSIONS.current)).toBe(false)
    expect(legalConsentState(LEGAL_VERSIONS.current)).toEqual({
      currentVersion: LEGAL_VERSIONS.current,
      acceptedVersion: LEGAL_VERSIONS.current,
      consentRequired: false,
    })
  })

  it.each([['v9'], [''], ['2026-9-17'], ['2026-09-17T00:00:00.000Z'], ['hola']])(
    '%s no es aceptada NI heredada ⇒ el controlador responde 409 LEGAL_VERSION_UNKNOWN',
    valor => {
      expect(isAcceptedLegalVersion(valor)).toBe(false)
      expect(isLegacyDateVersion(valor)).toBe(false)
    },
  )

  it('sin versión guardada, el consentimiento sigue haciendo falta', () => {
    expect(legalConsentState(null)).toEqual({
      currentVersion: LEGAL_VERSIONS.current,
      acceptedVersion: null,
      consentRequired: true,
    })
    expect(legalConsentState(undefined).acceptedVersion).toBeNull()
    expect(isAcceptedLegalVersion(null)).toBe(false)
    expect(isLegacyDateVersion(undefined)).toBe(false)
  })
})
