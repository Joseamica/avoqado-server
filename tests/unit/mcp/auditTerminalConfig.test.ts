import { auditTerminalConfig } from '../../../scripts/mcp/tools/terminals'

describe('auditTerminalConfig', () => {
  it('extracts settings from config.settings merged with configOverrides', () => {
    const r = auditTerminalConfig({
      name: 'T1',
      serialNumber: 'AVQD-1',
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: true, enableShifts: false } },
      configOverrides: { showQuickPayment: false }, // override wins
    })
    expect(r.settings.showCheckout).toBe(true)
    expect(r.settings.showQuickPayment).toBe(false)
    expect(r.settings.enableShifts).toBe(false)
  })

  it('flags checkout-on / quickpay-off (the PlayTelecom gap)', () => {
    const r = auditTerminalConfig({
      name: 'T2',
      serialNumber: null,
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: false } },
      configOverrides: null,
    })
    expect(r.flags).toContain('checkout_on_quickpay_off')
  })

  it('produces no flags for a balanced config', () => {
    const r = auditTerminalConfig({
      name: 'T3',
      serialNumber: 'AVQD-3',
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: true } },
      configOverrides: null,
    })
    expect(r.flags).toEqual([])
  })

  it('handles null/empty config without throwing', () => {
    const r = auditTerminalConfig({ name: 'T4', serialNumber: null, status: 'INACTIVE', config: null, configOverrides: null })
    expect(r.settings).toEqual({ showCheckout: undefined, showQuickPayment: undefined, enableShifts: undefined })
    expect(r.flags).toEqual([])
  })
})
