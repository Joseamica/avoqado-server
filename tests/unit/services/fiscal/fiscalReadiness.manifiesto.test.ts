// tests/unit/services/fiscal/fiscalReadiness.manifiesto.test.ts
//
// La Carta Manifiesto es el paso 5/5 del onboarding en el PAC: sin la firma,
// Facturapi no puede timbrar en Live aunque el CSD esté activo. El checklist
// de preparación fiscal debe reportarla — pero SOLO cuando el emisor ya está
// provisionado (antes de eso no hay organización que firmar y sería ruido).

import { assembleReadiness } from '../../../../src/services/fiscal/fiscalReadiness.service'

const NOW = new Date('2026-09-01T12:00:00Z')

function baseInput(over: Record<string, any> = {}) {
  return {
    rfc: 'TCA2501231A6',
    emisor: {
      legalName: 'Testarudo Cafe',
      regimenFiscal: '601',
      lugarExpedicion: '06010',
      providerKeyEnc: 'ENC',
      csdStatus: 'ACTIVE' as const,
      csdExpiresAt: new Date('2030-01-01'),
      providerOrgId: 'org1' as string | null,
    },
    venueZipCode: '06010',
    catalogSeeded: true,
    mappingsTotal: 10,
    mappingsAssigned: 10,
    empleadosActivos: 0,
    empleadosSinClaveEntFed: 0,
    manifiestoPendingSteps: [] as string[] | null,
    ...over,
  }
}

const manifiestoCheck = (input: any) => assembleReadiness(input, NOW).checks.find(c => c.key === 'manifiesto')

describe('assembleReadiness — Carta Manifiesto', () => {
  it('emisor SIN provisionar: el check de manifiesto NO aparece (sería ruido antes de conectar)', () => {
    const input = baseInput({ emisor: { ...baseInput().emisor, providerOrgId: null }, manifiestoPendingSteps: null })
    expect(manifiestoCheck(input)).toBeUndefined()
  })

  it('provisionado y el PAC reporta manifiesto pendiente → missing', () => {
    const check = manifiestoCheck(baseInput({ manifiestoPendingSteps: ['manifiesto'] }))
    expect(check?.status).toBe('missing')
    expect(check?.detail).toMatch(/manifiesto/i)
  })

  it('provisionado y el manifiesto ya no está pendiente → ok', () => {
    const check = manifiestoCheck(baseInput({ manifiestoPendingSteps: ['logo'] }))
    expect(check?.status).toBe('ok')
  })

  it('provisionado pero la consulta al PAC falló (null) → warn, nunca inventa un estado', () => {
    const check = manifiestoCheck(baseInput({ manifiestoPendingSteps: null }))
    expect(check?.status).toBe('warn')
  })
})
