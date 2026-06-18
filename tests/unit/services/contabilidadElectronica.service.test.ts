/**
 * Unit tests (mock-first) para Contabilidad electrónica (SAT, Anexo 24, esquema 1.3).
 *  - Catálogo: namespace + Version + RFC/Mes/Anio; toda SubCtaDe resuelve a un NumCta presente
 *    (integridad jerárquica); Natur D/A; nombre de archivo <RFC><Año><Mes>CT.xml.
 *  - Balanza: importes en pesos con 2 decimales (valor absoluto en saldos); TipoEnvio; nombre BN/BC.
 */
import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({
  resolveScopeOrNull: jest.fn(),
  getCatalog: jest.fn(),
}))
jest.mock('../../../src/services/fiscal/trialBalance.service', () => ({
  getTrialBalance: jest.fn(),
}))

import { resolveScopeOrNull, getCatalog } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getTrialBalance } from '../../../src/services/fiscal/trialBalance.service'
import { getCatalogoXml, getBalanzaXml } from '../../../src/services/fiscal/contabilidadElectronica.service'

const mScope = resolveScopeOrNull as jest.Mock
const mCatalog = getCatalog as jest.Mock
const mTb = getTrialBalance as jest.Mock

const acc = (
  id: string,
  code: string,
  name: string,
  level: number,
  parentId: string | null,
  nature: 'DEUDORA' | 'ACREEDORA',
  isActive = true,
) => ({
  id,
  code,
  satGroupingCode: code.split('.')[0],
  name,
  type: 'ACTIVO',
  nature,
  level,
  parentId,
  isPostable: level > 1,
  isActive,
})

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
})

describe('getCatalogoXml', () => {
  it('sin RFC → needsFiscalSetup', async () => {
    mScope.mockResolvedValue(null)
    const r = await getCatalogoXml('v1', '2026-06')
    expect(r.needsFiscalSetup).toBe(true)
    expect(r.xml).toBeNull()
  })

  it('periodo inválido → BadRequestError', async () => {
    await expect(getCatalogoXml('v1', '2026-13')).rejects.toThrow(BadRequestError)
  })

  it('genera XML 1.3 válido: namespace, Version, RFC/Mes/Anio, Natur D/A, nombre CT', async () => {
    mCatalog.mockResolvedValue({
      needsFiscalSetup: false,
      accounts: [
        acc('i101', '101', 'Caja', 1, null, 'DEUDORA'),
        acc('i10101', '101.01', 'Caja general', 2, 'i101', 'DEUDORA'),
        acc('i208', '208', 'IVA', 1, null, 'ACREEDORA'),
      ],
    })
    const r = await getCatalogoXml('v1', '2026-06')
    expect(r.filename).toBe('EKU9003173C9202606CT.xml')
    expect(r.xml).toContain('Version="1.3"')
    expect(r.xml).toContain('RFC="EKU9003173C9"')
    expect(r.xml).toContain('Mes="06"')
    expect(r.xml).toContain('Anio="2026"')
    expect(r.xml).toContain('http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas')
    expect(r.xml).toContain('NumCta="101.01" Desc="Caja general" SubCtaDe="101" Nivel="2" Natur="D"')
    expect(r.xml).toContain('NumCta="208" Desc="IVA" Nivel="1" Natur="A"') // acreedora sin SubCtaDe
  })

  it('integridad jerárquica: NO emite SubCtaDe si el padre no está presente', async () => {
    // 101.01 (activa) cuelga de un padre 101 que está INACTIVO pero igual presente (incluimos todas) →
    // SubCtaDe SÍ resuelve. Un huérfano real (parentId inexistente) NO debe emitir SubCtaDe.
    mCatalog.mockResolvedValue({
      needsFiscalSetup: false,
      accounts: [
        acc('i101', '101', 'Caja', 1, null, 'DEUDORA', false),
        acc('i10101', '101.01', 'Caja general', 2, 'i101', 'DEUDORA'),
        acc('iorph', '999.99', 'Huérfana', 2, 'iGONE', 'DEUDORA'),
      ],
    })
    const r = await getCatalogoXml('v1', '2026-06')
    // el padre inactivo SÍ se incluye → la subcuenta resuelve
    expect(r.xml).toContain('NumCta="101" Desc="Caja"') // inactivo incluido
    expect(r.xml).toContain('NumCta="101.01" Desc="Caja general" SubCtaDe="101"')
    // la huérfana (parentId apunta a id inexistente) NO debe llevar SubCtaDe colgante
    expect(r.xml).toContain('NumCta="999.99" Desc="Huérfana" Nivel="2"')
    expect(r.xml).not.toContain('SubCtaDe="iGONE"')
    // verificación general: todo SubCtaDe="X" tiene una fila NumCta="X"
    const subRefs = [...r.xml!.matchAll(/SubCtaDe="([^"]+)"/g)].map(m => m[1])
    const numCtas = new Set([...r.xml!.matchAll(/NumCta="([^"]+)"/g)].map(m => m[1]))
    for (const ref of subRefs) expect(numCtas.has(ref)).toBe(true)
  })

  it('escapa caracteres XML en Desc (& < > " \')', async () => {
    mCatalog.mockResolvedValue({ needsFiscalSetup: false, accounts: [acc('i1', '601', 'Gastos & "varios" <x>', 1, null, 'DEUDORA')] })
    const r = await getCatalogoXml('v1', '2026-06')
    expect(r.xml).toContain('Desc="Gastos &amp; &quot;varios&quot; &lt;x&gt;"')
  })
})

describe('getBalanzaXml', () => {
  it('genera XML 1.3: importes en pesos 2 decimales, valor absoluto, TipoEnvio, nombre BN', async () => {
    mTb.mockResolvedValue({
      needsFiscalSetup: false,
      rfc: 'EKU9003173C9',
      period: '2026-06',
      rows: [
        {
          code: '102.01',
          name: 'Bancos',
          nature: 'DEUDORA',
          saldoInicialCents: 0,
          debeCents: 116000,
          haberCents: 0,
          saldoFinalCents: 116000,
        },
        {
          code: '208.01',
          name: 'IVA',
          nature: 'ACREEDORA',
          saldoInicialCents: 0,
          debeCents: 0,
          haberCents: 16000,
          saldoFinalCents: -16000,
        },
      ],
    })
    const r = await getBalanzaXml('v1', '2026-06', 'N')
    expect(r.filename).toBe('EKU9003173C9202606BN.xml')
    expect(r.xml).toContain('TipoEnvio="N"')
    expect(r.xml).toContain('NumCta="102.01" SaldoIni="0.00" Debe="1160.00" Haber="0.00" SaldoFin="1160.00"')
    // saldo final acreedor (−16000 centavos) → valor ABSOLUTO 160.00
    expect(r.xml).toContain('NumCta="208.01" SaldoIni="0.00" Debe="0.00" Haber="160.00" SaldoFin="160.00"')
  })

  it('tipoEnvio C → nombre BC', async () => {
    mTb.mockResolvedValue({
      needsFiscalSetup: false,
      rfc: 'EKU9003173C9',
      period: '2026-06',
      rows: [{ code: '101', name: 'Caja', nature: 'DEUDORA', saldoInicialCents: 0, debeCents: 100, haberCents: 0, saldoFinalCents: 100 }],
    })
    const r = await getBalanzaXml('v1', '2026-06', 'C')
    expect(r.filename).toBe('EKU9003173C9202606BC.xml')
    expect(r.xml).toContain('TipoEnvio="C"')
  })

  it('sin pólizas → empty', async () => {
    mTb.mockResolvedValue({ needsFiscalSetup: false, rfc: 'EKU9003173C9', period: '2026-06', rows: [] })
    const r = await getBalanzaXml('v1', '2026-06')
    expect(r.empty).toBe(true)
    expect(r.xml).toBeNull()
  })

  it('sin RFC → needsFiscalSetup', async () => {
    mTb.mockResolvedValue({ needsFiscalSetup: true, rfc: null, period: '2026-06', rows: [] })
    const r = await getBalanzaXml('v1', '2026-06')
    expect(r.needsFiscalSetup).toBe(true)
  })
})
