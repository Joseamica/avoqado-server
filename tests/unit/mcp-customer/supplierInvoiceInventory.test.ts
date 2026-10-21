import { registerProcurementTools } from '@/mcp/tools/procurement'

const preview = jest.fn(),
  confirm = jest.fn(),
  gate = jest.fn(),
  audit = jest.fn(),
  permission = jest.fn()
jest.mock('@/services/dashboard/supplierInvoiceInventory.service', () => ({
  previewSupplierInvoiceInventory: (...a: unknown[]) => preview(...a),
  confirmSupplierInvoiceInventory: (...a: unknown[]) => confirm(...a),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => gate(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => audit(...a) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (id: string) => {
      if (id !== 'venue') throw new Error('fuera del negocio')
    },
    requirePermission: (...a: unknown[]) => permission(...a),
  }),
}))
const handlers = new Map<string, (a: any) => Promise<any>>()
beforeAll(() =>
  registerProcurementTools({ tool: (...a: any[]) => handlers.set(a[0], a[a.length - 1]) } as any, { staffId: 'staff' } as any),
)
beforeEach(() => {
  jest.clearAllMocks()
  gate.mockResolvedValue(null)
  preview.mockResolvedValue({
    action: 'RECEIVE',
    confirmationToken: 'a'.repeat(64),
    lines: [{ quantity: '3', baseQuantity: '3000', baseUnitCost: '0.3' }],
    subtotal: '900',
    total: '1044',
  })
  confirm.mockResolvedValue({ purchaseOrderId: 'po', status: 'RECEIVED' })
})
const call = async (a: any) => JSON.parse((await handlers.get('supplier_invoice_inventory')!(a)).content[0].text)

describe('recepción por MCP', () => {
  it('avisa que el proveedor nuevo se registrará al confirmar, junto con cantidades base', async () => {
    preview.mockResolvedValue({
      action: 'PREPARE',
      supplier: 'Distribuidora',
      supplierRfc: 'AAA010101AAA',
      supplierWillBeCreated: true,
      confirmationToken: 'a'.repeat(64),
      lines: [{ quantity: '3', baseQuantity: '3000', baseUnit: 'GRAM' }],
    })
    const out = await call({ venueId: 'venue', invoiceId: 'invoice' })
    expect(out.message).toMatch(/proveedor.*automáticamente/i)
    expect(out.message).toContain('AAA010101AAA')
    expect(out.review.lines[0].baseQuantity).toBe('3000')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('previsualiza en pesos y unidades reales sin ejecutar una recepción', async () => {
    const out = await call({ venueId: 'venue', invoiceId: 'invoice' })
    expect(out.requiresConfirmation).toBe(true)
    expect(out.review.total).toBe('1044')
    expect(out.review.lines[0].baseQuantity).toBe('3000')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('aplica sólo con token de revisión y confirma al usuario conectado como actor', async () => {
    await call({ venueId: 'venue', invoiceId: 'invoice', confirm: true, confirmationToken: 'a'.repeat(64), includeIeps: false })
    expect(confirm).toHaveBeenCalledWith('venue', 'invoice', 'a'.repeat(64), 'staff', false)
    expect(permission).toHaveBeenCalledWith('inventory:update', 'venue')
    expect(audit).toHaveBeenCalled()
  })
  it('sin token, confirm:true sigue siendo una revisión', async () => {
    expect((await call({ venueId: 'venue', invoiceId: 'invoice', confirm: true })).requiresConfirmation).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('exige ambas capacidades PREMIUM y aislamiento del negocio', async () => {
    gate.mockResolvedValueOnce(null).mockResolvedValueOnce('Falta CFDI')
    expect((await call({ venueId: 'venue', invoiceId: 'invoice' })).planRequired).toBe(true)
    expect(preview).not.toHaveBeenCalled()
    await expect(call({ venueId: 'ajeno', invoiceId: 'invoice' })).rejects.toThrow(/fuera/)
  })
})
