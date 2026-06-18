/**
 * Unit tests (mock-first) para el diagnóstico de PREPARACIÓN FISCAL (onboarding, Capa B).
 *  - assembleReadiness (puro): estatus por ítem (ok/warn/missing) + capacidades desbloqueadas;
 *    CSD por estado (NONE/UPLOADED/ACTIVE/EXPIRED/RESTRICTED) y por vencimiento ≤30 días (now inyectado).
 *  - getFiscalReadiness: sin RFC → needsFiscalSetup; arma desde emisor/catálogo/mapeos/empleados.
 */
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    fiscalEmisor: { findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    employee: { count: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({
  resolveScopeOrNull: jest.fn(),
  getCatalog: jest.fn(),
}))
jest.mock('../../../src/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull, getCatalog } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getMappings } from '../../../src/services/fiscal/accountMapping.service'
import { assembleReadiness, getFiscalReadiness } from '../../../src/services/fiscal/fiscalReadiness.service'

const p = prisma as unknown as {
  fiscalEmisor: { findFirst: jest.Mock }
  venue: { findUnique: jest.Mock }
  employee: { count: jest.Mock }
}
const mScope = resolveScopeOrNull as jest.Mock
const mCatalog = getCatalog as jest.Mock
const mMappings = getMappings as jest.Mock

const NOW = new Date('2026-06-18T12:00:00Z')

const emisor = (over: Record<string, unknown> = {}) => ({
  legalName: 'Tacos SA de CV',
  regimenFiscal: '601',
  lugarExpedicion: '06700',
  providerKeyEnc: 'enc-key',
  csdStatus: 'ACTIVE' as const,
  csdExpiresAt: new Date('2027-01-01T00:00:00Z'),
  ...over,
})

const baseInput = (over: Record<string, unknown> = {}) => ({
  rfc: 'EKU9003173C9',
  emisor: emisor(),
  venueZipCode: '06700',
  catalogSeeded: true,
  mappingsTotal: 28,
  mappingsAssigned: 28,
  empleadosActivos: 2,
  empleadosSinClaveEntFed: 0,
  ...over,
})

const find = (r: ReturnType<typeof assembleReadiness>, key: string) => r.checks.find(c => c.key === key)!

describe('assembleReadiness (puro)', () => {
  it('todo configurado → todos ok y las 3 capacidades en true', () => {
    const r = assembleReadiness(baseInput(), NOW)
    expect(r.resumen).toEqual({ ok: 7, warn: 0, missing: 0 })
    expect(r.capabilities).toEqual({ puedeFacturar: true, puedeTimbrarNomina: true, contabilidadElectronicaLista: true })
    expect(r.legalName).toBe('Tacos SA de CV')
    expect(r.regimenFiscal).toBe('601')
  })

  it('sin emisor → emisor+csd missing; no puede facturar ni timbrar nómina', () => {
    const r = assembleReadiness(baseInput({ emisor: null }), NOW)
    expect(find(r, 'emisor').status).toBe('missing')
    expect(find(r, 'csd').status).toBe('missing')
    expect(r.capabilities.puedeFacturar).toBe(false)
    expect(r.capabilities.puedeTimbrarNomina).toBe(false)
  })

  it('CSD UPLOADED (no activo) → warn y NO puede facturar', () => {
    const r = assembleReadiness(baseInput({ emisor: emisor({ csdStatus: 'UPLOADED' }) }), NOW)
    expect(find(r, 'csd').status).toBe('warn')
    expect(r.capabilities.puedeFacturar).toBe(false)
  })

  it('CSD EXPIRED/RESTRICTED → missing y NO puede facturar', () => {
    for (const csdStatus of ['EXPIRED', 'RESTRICTED'] as const) {
      const r = assembleReadiness(baseInput({ emisor: emisor({ csdStatus }) }), NOW)
      expect(find(r, 'csd').status).toBe('missing')
      expect(r.capabilities.puedeFacturar).toBe(false)
    }
  })

  it('CSD activo por vencer (≤30 días) → warn pero SÍ puede facturar', () => {
    const r = assembleReadiness(baseInput({ emisor: emisor({ csdExpiresAt: new Date('2026-07-05T00:00:00Z') }) }), NOW)
    expect(find(r, 'csd').status).toBe('warn')
    expect(find(r, 'csd').detail).toContain('vence en 16')
    expect(r.capabilities.puedeFacturar).toBe(true)
  })

  it('sin código postal → warn (nómina usa 00000)', () => {
    const r = assembleReadiness(baseInput({ venueZipCode: null }), NOW)
    expect(find(r, 'cp').status).toBe('warn')
  })

  it('catálogo sin sembrar → catalogo+mapeos missing; contabilidad electrónica NO lista', () => {
    const r = assembleReadiness(baseInput({ catalogSeeded: false, mappingsAssigned: 0, mappingsTotal: 28 }), NOW)
    expect(find(r, 'catalogo').status).toBe('missing')
    expect(find(r, 'mapeos').status).toBe('missing')
    expect(r.capabilities.contabilidadElectronicaLista).toBe(false)
  })

  it('mapeos incompletos → warn y contabilidad electrónica NO lista', () => {
    const r = assembleReadiness(baseInput({ mappingsAssigned: 20, mappingsTotal: 28 }), NOW)
    expect(find(r, 'mapeos').status).toBe('warn')
    expect(find(r, 'mapeos').detail).toContain('faltan 8')
    expect(r.capabilities.contabilidadElectronicaLista).toBe(false)
  })

  it('empleados sin clave de entidad federativa → warn y NO puede timbrar nómina', () => {
    const r = assembleReadiness(baseInput({ empleadosActivos: 3, empleadosSinClaveEntFed: 3 }), NOW)
    expect(find(r, 'nomina').status).toBe('warn')
    expect(r.capabilities.puedeTimbrarNomina).toBe(false)
  })

  it('sin empleados → nómina ok (opcional) pero NO puede timbrar nómina', () => {
    const r = assembleReadiness(baseInput({ empleadosActivos: 0, empleadosSinClaveEntFed: 0 }), NOW)
    expect(find(r, 'nomina').status).toBe('ok')
    expect(r.capabilities.puedeTimbrarNomina).toBe(false)
  })
})

describe('getFiscalReadiness (orquestación)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'RESTAURANT' })
    p.fiscalEmisor.findFirst.mockResolvedValue(emisor())
    p.venue.findUnique.mockResolvedValue({ zipCode: '06700' })
    mCatalog.mockResolvedValue({ needsFiscalSetup: false, seeded: true, accounts: [] })
    mMappings.mockResolvedValue({ needsFiscalSetup: false, catalogSeeded: true, mappings: [{ account: { id: 'a' } }, { account: null }] })
    p.employee.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1) // activos=2, sinClave=1
  })

  it('sin RFC → needsFiscalSetup, no consulta nada más', async () => {
    mScope.mockResolvedValue(null)
    const r = await getFiscalReadiness('v1')
    expect(r.needsFiscalSetup).toBe(true)
    expect(p.fiscalEmisor.findFirst).not.toHaveBeenCalled()
  })

  it('arma el resultado y rellena organizationId del scope', async () => {
    const r = await getFiscalReadiness('v1')
    expect(r.needsFiscalSetup).toBe(false)
    expect(r.organizationId).toBe('org1')
    expect(r.rfc).toBe('EKU9003173C9')
    // 1 de 2 mapeos asignados → warn; 1 de 2 empleados sin clave → warn
    expect(find(r, 'mapeos').status).toBe('warn')
    expect(find(r, 'nomina').status).toBe('warn')
  })
})
