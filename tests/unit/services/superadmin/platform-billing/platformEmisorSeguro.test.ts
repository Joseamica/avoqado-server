import { Prisma } from '@prisma/client'
import type { PlatformEmisor } from '@prisma/client'
import {
  PLATFORM_EMISOR_CAMPOS_PRIVADOS,
  PLATFORM_EMISOR_SEGURO_SELECT,
  platformEmisorSeguro,
} from '@/services/superadmin/platform-billing/platformEmisorSeguro'

/**
 * El emisor de la PLATAFORMA (con el que Avoqado factura a sus clientes) que sale al superadmin nunca lleva la llave de Facturapi.
 *
 * 🔴 Important 1 de la revisión final de C1 (8-oct-2026): `upsertEmisor`, `provisionEmisor` y `uploadCsd` del superadmin respondían la
 * fila entera de `PlatformEmisor`, con `providerKeyEnc` (cifrada) dentro. Hermano de `emisorSeguro.test.ts`.
 */
describe('PLATFORM_EMISOR_SEGURO_SELECT', () => {
  const seguros = Object.keys(PLATFORM_EMISOR_SEGURO_SELECT)
  const escalares = Object.values(Prisma.PlatformEmisorScalarFieldEnum) as string[]

  it('control — no deja salir ningún campo privado', () => {
    for (const privado of PLATFORM_EMISOR_CAMPOS_PRIVADOS) expect(seguros).not.toContain(privado)
    expect(seguros).not.toContain('providerKeyEnc')
    expect(seguros.filter(campo => /Enc$/.test(campo))).toEqual([])
  })

  it('control — cada campo de PlatformEmisor está decidido: seguro o privado (un campo nuevo obliga a elegir)', () => {
    const decididos = new Set<string>([...seguros, ...PLATFORM_EMISOR_CAMPOS_PRIVADOS])
    expect(escalares.filter(campo => !decididos.has(campo))).toEqual([])
    for (const campo of decididos) expect(escalares).toContain(campo)
    // Todo campo cifrado del modelo cae del lado privado.
    for (const campo of escalares.filter(c => /Enc$/.test(c))) expect(PLATFORM_EMISOR_CAMPOS_PRIVADOS).toContain(campo)
  })

  it('control — conserva lo que el superadmin lee del emisor (tipo `PlatformEmisor` de avoqado-superadmin `features/billing/types.ts`)', () => {
    expect(PLATFORM_EMISOR_SEGURO_SELECT).toMatchObject({
      id: true,
      rfc: true,
      legalName: true,
      regimenFiscal: true,
      lugarExpedicion: true,
      provider: true,
      providerOrgId: true,
      csdStatus: true,
      csdExpiresAt: true,
      csdLastCheckedAt: true,
      serie: true,
      defaultUsoCfdi: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    })
  })
})

describe('platformEmisorSeguro', () => {
  const fila: PlatformEmisor = {
    id: 'pe1',
    rfc: 'AVO2101019X1',
    legalName: 'Avoqado SA de CV',
    regimenFiscal: '601',
    lugarExpedicion: '06600',
    provider: 'FACTURAPI',
    providerOrgId: 'org_avoqado',
    providerKeyEnc: 'CIFRADO-LLAVE-VIVA-DE-AVOQADO',
    csdStatus: 'ACTIVE',
    csdExpiresAt: new Date('2030-01-01T00:00:00Z'),
    csdLastCheckedAt: new Date('2026-10-01T00:00:00Z'),
    serie: 'A',
    defaultUsoCfdi: 'G03',
    isActive: true,
    createdById: 'staff-ops-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-10-08T00:00:00Z'),
  }

  it('quita la llave cifrada y todo campo `*Enc`', () => {
    const seguro = platformEmisorSeguro(fila) as unknown as Record<string, unknown>
    expect(seguro).not.toHaveProperty('providerKeyEnc')
    expect(Object.keys(seguro).filter(campo => /Enc$/.test(campo))).toEqual([])
    expect(JSON.stringify(seguro)).not.toContain('CIFRADO-LLAVE-VIVA-DE-AVOQADO')
  })

  it('devuelve exactamente los campos seguros con su valor, más `keyConfigured: true` si hay llave guardada', () => {
    const sinLlave = Object.fromEntries(Object.entries(fila).filter(([campo]) => campo !== 'providerKeyEnc'))
    expect(platformEmisorSeguro(fila)).toEqual({ ...sinLlave, keyConfigured: true })
  })

  it('`keyConfigured: false` cuando el emisor todavía no tiene llave', () => {
    const seguro = platformEmisorSeguro({ ...fila, providerOrgId: null, providerKeyEnc: null })
    expect(seguro.keyConfigured).toBe(false)
    expect(seguro).not.toHaveProperty('providerKeyEnc')
    expect(seguro.providerOrgId).toBeNull()
  })

  it('no copia propiedades ajenas a la lista (una fila con algo de más no lo filtra)', () => {
    const conDeMas = { ...fila, otroSecretoEnc: 'X', venue: { id: 'v1' } } as unknown as PlatformEmisor
    const seguro = platformEmisorSeguro(conDeMas) as unknown as Record<string, unknown>
    expect(Object.keys(seguro).sort()).toEqual([...Object.keys(PLATFORM_EMISOR_SEGURO_SELECT), 'keyConfigured'].sort())
  })
})
