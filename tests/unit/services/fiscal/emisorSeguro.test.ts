import { Prisma } from '@prisma/client'
import { EMISOR_CAMPOS_PRIVADOS, EMISOR_SEGURO_SELECT, emisorSeguro } from '@/services/fiscal/emisorSeguro'

/**
 * El emisor que sale en una respuesta nunca lleva la llave del PAC ni el secreto del webhook.
 *
 * 🔴 I1 de la revisión final de C1 (8-oct-2026): `upsertEmisor`, `provisionEmisor` y `uploadEmisorCsd` respondían la fila
 * entera de `FiscalEmisor`, con `providerKeyEnc` y `webhookSecretEnc` (cifrados) dentro.
 */
describe('EMISOR_SEGURO_SELECT', () => {
  const seguros = Object.keys(EMISOR_SEGURO_SELECT)
  const escalares = Object.values(Prisma.FiscalEmisorScalarFieldEnum) as string[]

  it('control — no deja salir ningún campo privado', () => {
    for (const privado of EMISOR_CAMPOS_PRIVADOS) expect(seguros).not.toContain(privado)
    expect(seguros).not.toContain('providerKeyEnc')
    expect(seguros).not.toContain('webhookSecretEnc')
  })

  it('control — cada campo de FiscalEmisor está decidido: seguro o privado (un campo nuevo obliga a elegir)', () => {
    const decididos = new Set<string>([...seguros, ...EMISOR_CAMPOS_PRIVADOS])
    expect(escalares.filter(campo => !decididos.has(campo))).toEqual([])
    for (const campo of decididos) expect(escalares).toContain(campo)
  })

  it('control — conserva lo que el dashboard lee del emisor (tipo `Emisor` de CfdiConfiguracion / EmisorFormModal)', () => {
    expect(EMISOR_SEGURO_SELECT).toMatchObject({
      id: true,
      venueId: true,
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
      globalPeriodicity: true,
      invoiceCashSales: true,
      includeOffTerminalSalesInGlobal: true,
      includeCashInAccounting: true,
      isnRate: true,
      createdAt: true,
      updatedAt: true,
    })
  })
})

describe('emisorSeguro', () => {
  const fila = {
    id: 'e1',
    venueId: 'v1',
    rfc: 'EKU9003173C9',
    legalName: 'Empresa Ejemplo SA de CV',
    regimenFiscal: '601',
    lugarExpedicion: '64000',
    provider: 'FACTURAPI',
    providerOrgId: 'org1',
    providerKeyEnc: 'CIFRADO-LLAVE-DEL-PAC',
    webhookId: 'wh1',
    webhookSecretEnc: 'CIFRADO-SECRETO-WEBHOOK',
    webhookUrl: 'https://api.avoqado.io/webhooks/facturapi/e1',
    webhookConfiguredAt: new Date('2026-09-24T00:00:00Z'),
    csdStatus: 'ACTIVE',
    csdExpiresAt: new Date('2030-01-01T00:00:00Z'),
    csdLastCheckedAt: new Date('2026-10-01T00:00:00Z'),
    serie: 'A',
    defaultUsoCfdi: 'G03',
    globalPeriodicity: 'MENSUAL',
    invoiceCashSales: true,
    includeOffTerminalSalesInGlobal: false,
    includeCashInAccounting: false,
    isnRate: '0.03',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-10-08T00:00:00Z'),
  }

  it('quita la llave del PAC, el secreto del webhook y los datos internos del webhook', () => {
    const seguro = emisorSeguro(fila) as Record<string, unknown>
    for (const privado of EMISOR_CAMPOS_PRIVADOS) expect(seguro).not.toHaveProperty(privado)
    expect(JSON.stringify(seguro)).not.toContain('CIFRADO')
  })

  it('conserva todos los campos seguros con su valor', () => {
    const seguro = emisorSeguro(fila) as Record<string, unknown>
    for (const campo of Object.keys(EMISOR_SEGURO_SELECT)) expect(seguro[campo]).toEqual((fila as Record<string, unknown>)[campo])
    expect(Object.keys(seguro).sort()).toEqual(Object.keys(EMISOR_SEGURO_SELECT).sort())
  })

  it('control — una fila parcial sale parcial: nunca inventa un campo', () => {
    expect(emisorSeguro({ id: 'e1', csdStatus: 'NONE' })).toEqual({ id: 'e1', csdStatus: 'NONE' })
  })
})
