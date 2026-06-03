import { summarizeSales } from '../../../src/mcp/tools/sales'
import { auditTerminalConfig } from '../../../src/mcp/tools/terminals'

// Avoid ts-jest compiling the huge access.service graph (the tool modules import it
// transitively via the guard). The pure functions under test don't use it.
jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))

describe('summarizeSales', () => {
  const rows = [
    { amount: 100, method: 'CASH', type: 'REGULAR', status: 'COMPLETED' },
    { amount: 200, method: 'CREDIT_CARD', type: 'REGULAR', status: 'COMPLETED' },
    { amount: 50, method: 'CASH', type: 'FAST', status: 'COMPLETED' },
    { amount: 999, method: 'CASH', type: 'REGULAR', status: 'FAILED' }, // excluded
  ]
  it('totals only COMPLETED payments', () => {
    const s = summarizeSales(rows)
    expect(s.completedCount).toBe(3)
    expect(s.gross).toBe(350)
  })
  it('breaks down by method and type', () => {
    const s = summarizeSales(rows)
    expect(s.byMethod.CASH).toBe(150)
    expect(s.byMethod.CREDIT_CARD).toBe(200)
    expect(s.byType.REGULAR).toBe(300)
    expect(s.byType.FAST).toBe(50)
  })
  it('handles empty', () => {
    expect(summarizeSales([])).toEqual({ completedCount: 0, gross: 0, byMethod: {}, byType: {} })
  })
})

describe('auditTerminalConfig', () => {
  it('merges config.settings with configOverrides (override wins)', () => {
    const r = auditTerminalConfig({
      name: 'T1',
      serialNumber: 'A1',
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: true } },
      configOverrides: { showQuickPayment: false },
    })
    expect(r.settings.showCheckout).toBe(true)
    expect(r.settings.showQuickPayment).toBe(false)
  })
  it('flags checkout-on / quickpay-off', () => {
    const r = auditTerminalConfig({
      name: 'T2',
      serialNumber: null,
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: false } },
      configOverrides: null,
    })
    expect(r.flags).toContain('checkout_on_quickpay_off')
  })
  it('handles null config without throwing', () => {
    const r = auditTerminalConfig({ name: 'T3', serialNumber: null, status: 'INACTIVE', config: null, configOverrides: null })
    expect(r.flags).toEqual([])
  })
})
