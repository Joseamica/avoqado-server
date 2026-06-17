/**
 * Customer-MCP accounting tools — invoca los handlers REALES (capturados del registro)
 * y verifica el wiring: gate de permiso (read vs manage), gate de feature CFDI (PREMIUM)
 * y el formato de respuesta. Mock-first (servicios mockeados) → CI-safe, sin DB ni server MCP.
 */
import { registerAccountingTools } from '../../../src/mcp/tools/accounting'
import type { McpScope } from '../../../src/mcp/scope'

const mockRequirePermission = jest.fn()
const mockPlanGate = jest.fn()
const mockGetCatalog = jest.fn()
const mockSeed = jest.fn()
const mockCreate = jest.fn()
const mockGetMappings = jest.fn()
const mockSetMapping = jest.fn()
const mockListEntries = jest.fn()
const mockCreateManual = jest.fn()
const mockTrialBalance = jest.fn()
const mockReports = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: jest.fn(), requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])) }),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/fiscal/chartOfAccounts.service', () => ({
  getCatalog: (...a: unknown[]) => mockGetCatalog(...(a as [])),
  seedBaseChart: (...a: unknown[]) => mockSeed(...(a as [])),
  createAccount: (...a: unknown[]) => mockCreate(...(a as [])),
}))
jest.mock('@/services/fiscal/accountMapping.service', () => ({
  getMappings: (...a: unknown[]) => mockGetMappings(...(a as [])),
  setMapping: (...a: unknown[]) => mockSetMapping(...(a as [])),
}))
jest.mock('@/services/fiscal/journalEntry.service', () => ({
  listEntries: (...a: unknown[]) => mockListEntries(...(a as [])),
  createManualEntry: (...a: unknown[]) => mockCreateManual(...(a as [])),
}))
jest.mock('@/services/fiscal/trialBalance.service', () => ({
  getTrialBalance: (...a: unknown[]) => mockTrialBalance(...(a as [])),
  currentPeriod: () => '2026-06',
}))
jest.mock('@/services/fiscal/accountingReports.service', () => ({
  getAccountingReports: (...a: unknown[]) => mockReports(...(a as [])),
}))
jest.mock('@/services/dashboard/accounting.dashboard.service', () => ({
  getIncomeStatement: jest.fn(),
  getBusinessSummary: jest.fn(),
  getBankAndCashSummary: jest.fn(),
}))
jest.mock('@/services/dashboard/bankReconciliation.service', () => ({ listStatements: jest.fn() }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerAccountingTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('chart_of_accounts (read) — gated CFDI + accounting:read', () => {
  it('registra el tool', () => {
    expect(handlers.has('chart_of_accounts')).toBe(true)
  })

  it('venue sin CFDI → planRequired, NO consulta el catálogo', async () => {
    mockPlanGate.mockResolvedValue('CFDI no activo')
    const out = parse(await call('chart_of_accounts', { venueId: 'v1' }))
    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.feature).toBe('CFDI')
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:read', 'v1')
    expect(mockGetCatalog).not.toHaveBeenCalled()
  })

  it('con CFDI → devuelve las cuentas formateadas', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockGetCatalog.mockResolvedValue({
      needsFiscalSetup: false,
      rfc: 'TESC900101AAA',
      seeded: true,
      accounts: [
        {
          code: '101',
          name: 'Caja',
          satGroupingCode: '101',
          type: 'ACTIVO',
          nature: 'DEUDORA',
          level: 1,
          isPostable: false,
          isActive: true,
        },
      ],
    })
    const out = parse(await call('chart_of_accounts', { venueId: 'v1' }))
    expect(out.ok).toBe(true)
    expect(out.totalCuentas).toBe(1)
    expect(out.cuentas[0]).toMatchObject({ codigo: '101', codigoAgrupadorSat: '101', tipo: 'ACTIVO', afectable: false })
  })

  it('sin RFC → needsFiscalSetup', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockGetCatalog.mockResolvedValue({ needsFiscalSetup: true, accounts: [] })
    const out = parse(await call('chart_of_accounts', { venueId: 'v1' }))
    expect(out.needsFiscalSetup).toBe(true)
  })
})

describe('seed_chart_of_accounts (write) — gated CFDI + accounting:manage', () => {
  it('exige accounting:manage (no read)', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockSeed.mockResolvedValue({ rfc: 'RFC', accounts: [{}, {}] })
    await call('seed_chart_of_accounts', { venueId: 'v1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:manage', 'v1')
  })

  it('venue sin CFDI → planRequired, NO siembra', async () => {
    mockPlanGate.mockResolvedValue('CFDI no activo')
    const out = parse(await call('seed_chart_of_accounts', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockSeed).not.toHaveBeenCalled()
  })

  it('con CFDI → siembra (auto-audita) y devuelve el total', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockSeed.mockResolvedValue({ rfc: 'RFC', accounts: new Array(86).fill({}) })
    const out = parse(await call('seed_chart_of_accounts', { venueId: 'v1' }))
    expect(mockSeed).toHaveBeenCalledWith('v1', { staffId: 'staff-1' })
    expect(out.ok).toBe(true)
    expect(out.totalCuentas).toBe(86)
  })
})

describe('add_ledger_account (write) — gated CFDI + accounting:manage', () => {
  it('crea una cuenta con el staff del scope como actor', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockCreate.mockResolvedValue({
      code: '999.01',
      name: 'X',
      satGroupingCode: '601',
      type: 'GASTO',
      nature: 'DEUDORA',
      level: 2,
      isPostable: true,
    })
    const out = parse(await call('add_ledger_account', { venueId: 'v1', code: '999.01', name: 'X', satGroupingCode: '601', type: 'GASTO' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:manage', 'v1')
    expect(mockCreate).toHaveBeenCalledWith('v1', expect.objectContaining({ code: '999.01', type: 'GASTO', parentCode: null }), {
      staffId: 'staff-1',
    })
    expect(out.ok).toBe(true)
    expect(out.cuenta).toMatchObject({ codigo: '999.01', tipo: 'GASTO' })
  })

  it('venue sin CFDI → planRequired, NO crea', async () => {
    mockPlanGate.mockResolvedValue('CFDI no activo')
    const out = parse(await call('add_ledger_account', { venueId: 'v1', code: '1', name: 'x', satGroupingCode: '1', type: 'GASTO' }))
    expect(out.planRequired).toBe(true)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('account_mapping (read) — gated CFDI + accounting:read', () => {
  it('venue sin CFDI → planRequired, NO consulta', async () => {
    mockPlanGate.mockResolvedValue('CFDI no activo')
    const out = parse(await call('account_mapping', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:read', 'v1')
    expect(mockGetMappings).not.toHaveBeenCalled()
  })

  it('con CFDI → devuelve los mapeos formateados', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockGetMappings.mockResolvedValue({
      needsFiscalSetup: false,
      rfc: 'TESC900101AAA',
      catalogSeeded: true,
      mappings: [
        {
          movementType: 'SALES_REVENUE',
          label: 'Ingreso por ventas',
          side: 'CREDIT',
          group: 'INGRESOS',
          defaultCode: '401.01',
          account: { id: 'x', code: '401.01', name: 'Ventas', satGroupingCode: '401', isActive: true },
        },
        {
          movementType: 'COST_OF_GOODS_SOLD',
          label: 'Costo de venta',
          side: 'DEBIT',
          group: 'COSTOS_GASTOS',
          defaultCode: '501.01',
          account: null,
        },
      ],
    })
    const out = parse(await call('account_mapping', { venueId: 'v1' }))
    expect(out.ok).toBe(true)
    expect(out.catalogoSembrado).toBe(true)
    expect(out.mapeos.find((m: any) => m.movimiento === 'SALES_REVENUE').cuenta).toBe('401.01 Ventas')
    expect(out.mapeos.find((m: any) => m.movimiento === 'COST_OF_GOODS_SOLD').cuenta).toBeNull()
  })
})

describe('set_account_mapping (write) — gated CFDI + accounting:manage', () => {
  it('exige accounting:manage y reasigna el movimiento', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockSetMapping.mockResolvedValue({
      movementType: 'SALES_REVENUE',
      label: 'Ingreso por ventas',
      side: 'CREDIT',
      group: 'INGRESOS',
      defaultCode: '401.01',
      account: { id: 'a', code: '401.04', name: 'Ventas 0%', satGroupingCode: '401', isActive: true },
    })
    const out = parse(await call('set_account_mapping', { venueId: 'v1', movementType: 'SALES_REVENUE', ledgerAccountId: 'a' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:manage', 'v1')
    expect(mockSetMapping).toHaveBeenCalledWith('v1', 'SALES_REVENUE', 'a', { staffId: 'staff-1' })
    expect(out.ok).toBe(true)
    expect(out.mapeo.cuenta).toBe('401.04 Ventas 0%')
  })

  it('venue sin CFDI → planRequired, NO reasigna', async () => {
    mockPlanGate.mockResolvedValue('CFDI no activo')
    const out = parse(await call('set_account_mapping', { venueId: 'v1', movementType: 'SALES_REVENUE', ledgerAccountId: 'a' }))
    expect(out.planRequired).toBe(true)
    expect(mockSetMapping).not.toHaveBeenCalled()
  })
})

describe('journal_entries (read) — gated CFDI + accounting:read', () => {
  it('con CFDI → devuelve las pólizas con líneas', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockListEntries.mockResolvedValue({
      needsFiscalSetup: false,
      rfc: 'TESC900101AAA',
      entries: [
        {
          id: 'je1',
          date: '2026-06-15',
          period: '2026-06',
          folio: 1,
          type: 'DIARIO',
          source: 'MANUAL',
          status: 'POSTED',
          concept: 'Venta',
          totalDebitCents: 11600,
          totalCreditCents: 11600,
          lines: [
            {
              id: 'l1',
              ledgerAccountId: 'a',
              accountCode: '101.01',
              accountName: 'Caja',
              debitCents: 11600,
              creditCents: 0,
              description: null,
            },
          ],
        },
      ],
    })
    const out = parse(await call('journal_entries', { venueId: 'v1' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:read', 'v1')
    expect(out.ok).toBe(true)
    expect(out.polizas[0].folio).toBe(1)
    expect(out.polizas[0].lineas[0].cuenta).toBe('101.01 Caja')
  })
})

describe('add_journal_entry (write) — gated CFDI + accounting:manage', () => {
  it('crea una póliza manual con el staff del scope', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockCreateManual.mockResolvedValue({
      id: 'je1',
      folio: 5,
      date: '2026-06-15',
      concept: 'Ajuste',
      totalDebitCents: 5000,
      totalCreditCents: 5000,
      lines: [{}, {}],
    })
    const lines = [
      { ledgerAccountId: 'a', debitCents: 5000, creditCents: 0 },
      { ledgerAccountId: 'b', debitCents: 0, creditCents: 5000 },
    ]
    const out = parse(await call('add_journal_entry', { venueId: 'v1', date: '2026-06-15', concept: 'Ajuste', lines }))
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:manage', 'v1')
    expect(mockCreateManual).toHaveBeenCalledWith('v1', { date: '2026-06-15', concept: 'Ajuste', lines }, { staffId: 'staff-1' })
    expect(out.ok).toBe(true)
    expect(out.poliza.folio).toBe(5)
  })

  it('venue sin CFDI → planRequired, NO crea', async () => {
    mockPlanGate.mockResolvedValue('CFDI no activo')
    const out = parse(
      await call('add_journal_entry', {
        venueId: 'v1',
        date: '2026-06-15',
        concept: 'x',
        lines: [
          { ledgerAccountId: 'a', debitCents: 1, creditCents: 0 },
          { ledgerAccountId: 'b', debitCents: 0, creditCents: 1 },
        ],
      }),
    )
    expect(out.planRequired).toBe(true)
    expect(mockCreateManual).not.toHaveBeenCalled()
  })
})

describe('trial_balance (read) — gated CFDI + accounting:read', () => {
  it('con CFDI → devuelve la balanza con el cuadre', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockTrialBalance.mockResolvedValue({
      needsFiscalSetup: false,
      rfc: 'TESC900101AAA',
      period: '2026-06',
      rows: [
        {
          code: '101.01',
          name: 'Caja',
          type: 'ACTIVO',
          nature: 'DEUDORA',
          saldoInicialCents: 1000,
          debeCents: 3000,
          haberCents: 0,
          saldoFinalCents: 4000,
        },
      ],
      totals: {
        debeCents: 3000,
        haberCents: 3000,
        saldoInicialDeudorCents: 1000,
        saldoInicialAcreedorCents: 1000,
        saldoFinalDeudorCents: 4000,
        saldoFinalAcreedorCents: 4000,
      },
      balanced: { movements: true, balances: true },
    })
    const out = parse(await call('trial_balance', { venueId: 'v1', period: '2026-06' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:read', 'v1')
    expect(mockTrialBalance).toHaveBeenCalledWith('v1', '2026-06')
    expect(out.ok).toBe(true)
    expect(out.cuadra).toBe(true)
    expect(out.cuentas[0].cuenta).toBe('101.01 Caja')
  })

  it('sin period usa el mes actual (currentPeriod)', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockTrialBalance.mockResolvedValue({ needsFiscalSetup: true, rows: [], totals: {}, balanced: { movements: true, balances: true } })
    await call('trial_balance', { venueId: 'v1' })
    expect(mockTrialBalance).toHaveBeenCalledWith('v1', '2026-06')
  })

  it('venue sin CFDI → planRequired', async () => {
    mockPlanGate.mockResolvedValue('CFDI no activo')
    const out = parse(await call('trial_balance', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockTrialBalance).not.toHaveBeenCalled()
  })
})

describe('accounting_reports (read) — gated CFDI + accounting:read', () => {
  it('registra el tool', () => {
    expect(handlers.has('accounting_reports')).toBe(true)
  })

  it('con CFDI → devuelve estado de resultados + balance general en pesos', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockReports.mockResolvedValue({
      needsFiscalSetup: false,
      rfc: 'TESC900101AAA',
      period: '2026-06',
      fiscalYearStart: '2026-01',
      incomeStatement: {
        ingresos: { lines: [], totalCents: 10000 },
        costos: { lines: [], totalCents: 4000 },
        utilidadBrutaCents: 6000,
        gastos: { lines: [], totalCents: 2000 },
        resultadoCents: 4000,
      },
      balanceSheet: {
        activo: { lines: [], totalCents: 5600 },
        pasivo: { lines: [], totalCents: 1600 },
        capital: { lines: [], totalCents: 4000 },
        resultadoEjercicioCents: 4000,
        balanced: true,
      },
    })
    const out = parse(await call('accounting_reports', { venueId: 'v1', period: '2026-06' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('accounting:read', 'v1')
    expect(mockReports).toHaveBeenCalledWith('v1', '2026-06')
    expect(out.ok).toBe(true)
    expect(out.estadoDeResultados.resultado).toBeCloseTo(40)
    expect(out.balanceGeneral.activo).toBeCloseTo(56)
    expect(out.balanceGeneral.cuadra).toBe(true)
  })

  it('sin period usa el mes actual (currentPeriod)', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockReports.mockResolvedValue({ needsFiscalSetup: true })
    await call('accounting_reports', { venueId: 'v1' })
    expect(mockReports).toHaveBeenCalledWith('v1', '2026-06')
  })

  it('venue sin CFDI → planRequired, NO consulta', async () => {
    mockPlanGate.mockResolvedValue('CFDI no activo')
    const out = parse(await call('accounting_reports', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(out.feature).toBe('CFDI')
    expect(mockReports).not.toHaveBeenCalled()
  })
})
