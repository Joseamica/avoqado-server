import { DeviceFormFactor } from '@prisma/client'

import { deriveFromHealth } from '../../../scripts/backfill-terminal-device-attrs'

describe('backfill-terminal-device-attrs — deriveFromHealth', () => {
  // ── FEATURE: derivar de lo que la TPV ya reporta ──────────────────────────────
  it('una PAX que reporta salud queda como POS de mano', () => {
    // Este es el caso principal: toda la flota PAX en producción ya manda esto en
    // cada heartbeat, así que avoqado-tpv no necesita ningún release.
    expect(deriveFromHealth({ manufacturer: 'PAX', model: 'A910S', osVersion: 'Android 8.1' })).toEqual({
      formFactor: DeviceFormFactor.HANDHELD_POS,
      modelIdentifier: 'A910S',
      osVersion: 'Android 8.1',
    })
  })

  it('una NexGo también cae en POS de mano', () => {
    expect(deriveFromHealth({ manufacturer: 'NEXGO', model: 'N86', osVersion: 'Android 10' }).formFactor).toBe(
      DeviceFormFactor.HANDHELD_POS,
    )
  })

  it('un Sunmi cae en POS de mostrador', () => {
    expect(deriveFromHealth({ manufacturer: 'SUNMI', model: 'D3_MINI', osVersion: 'Android 11' }).formFactor).toBe(
      DeviceFormFactor.COUNTERTOP_POS,
    )
  })

  it('un modelo POS que no está en el catálogo igual se clasifica por su marca', () => {
    // Hardware nuevo que aún no catalogamos no debe caer en UNKNOWN si sabemos la marca.
    expect(deriveFromHealth({ manufacturer: 'PAX', model: 'MODELO-FUTURO', osVersion: 'Android 13' }).formFactor).toBe(
      DeviceFormFactor.HANDHELD_POS,
    )
  })

  // ── FEATURE: honestidad cuando no hay datos ──────────────────────────────────
  it('sin heartbeat queda UNKNOWN — no se adivina', () => {
    expect(deriveFromHealth(null)).toEqual({
      formFactor: DeviceFormFactor.UNKNOWN,
      modelIdentifier: null,
      osVersion: null,
    })
  })

  it('un heartbeat con campos vacíos produce nulls, nunca cadenas vacías', () => {
    const result = deriveFromHealth({ manufacturer: '', model: '', osVersion: '' })
    expect(result.modelIdentifier).toBeNull()
    expect(result.osVersion).toBeNull()
    expect(result.formFactor).toBe(DeviceFormFactor.UNKNOWN)
  })

  // ── REGRESIÓN: el resultado siempre es usable ────────────────────────────────
  it('siempre devuelve un form factor válido del enum', () => {
    const valid = Object.values(DeviceFormFactor)
    const cases = [
      null,
      { manufacturer: 'PAX', model: 'A910S', osVersion: 'Android 8.1' },
      { manufacturer: 'marca rara', model: 'xyz', osVersion: '' },
      { manufacturer: '', model: 'SM-X710', osVersion: 'Android 14' },
    ]
    for (const health of cases) {
      expect(valid).toContain(deriveFromHealth(health).formFactor)
    }
  })
})
