import { registerShiftTools } from '../../../src/mcp/tools/shifts'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'
import { BadRequestError, ConflictError } from '../../../src/errors/AppError'
import type { McpScope } from '../../../src/mcp/scope'

const mockRequirePermission = jest.fn()
const mockPreview = jest.fn()
const mockCorrect = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venueId: string) => {
      if (venueId === 'venue-foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [venueId] } }
    },
    requirePermission: (...args: unknown[]) => mockRequirePermission(...(args as [])),
  }),
}))
jest.mock('@/mcp/audit', () => ({
  mcpProvenance: jest.fn(async () => ({ source: 'customer-mcp' })),
  auditMcpWrite: jest.fn(),
}))
jest.mock('@/services/dashboard/cashCountCorrection.service', () => ({
  previewCashCountCorrection: (...a: unknown[]) => mockPreview(...(a as [])),
  correctCashCount: (...a: unknown[]) => mockCorrect(...(a as [])),
}))

type ToolResult = { content: Array<{ text: string }> }
type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>
const handlers = new Map<string, ToolHandler>()
const scope = { staffId: 'staff-1', activeOrg: 'org-1', allowedVenueIds: ['venue-1'], perVenueAccess: new Map() } as McpScope
const base = { venueId: 'venue-1', shiftId: 'shift-1', countedCash: 2000, reason: 'error de dedo' }
const call = (args: Record<string, unknown>) => handlers.get('correct_cash_count')!(args, {})
const parse = (r: ToolResult) => JSON.parse(r.content[0].text)
const vista = { shiftId: 'shift-1', countedBefore: 20000, countedAfter: 2000, differenceBefore: 18000, differenceAfter: 0, correctionsBefore: 0 }

beforeAll(() => {
  registerShiftTools(
    { tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as ToolHandler) } as never,
    scope,
  )
})
beforeEach(() => jest.clearAllMocks())

describe('correct_cash_count', () => {
  it('declara su efecto como write', () => {
    expect(TOOL_EFFECTS.correct_cash_count).toBe('write')
  })

  it('sin confirm: pide confirmación con los tres valores y el mensaje exacto', async () => {
    mockPreview.mockResolvedValueOnce(vista)
    const r = parse(await call(base))
    expect(r).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      expectedCurrentCount: 20000,
      expectedResultingDifference: 0,
      expectedCorrectionCount: 0,
      message: 'Contado $20,000.00 → $2,000.00 · Sobrante $18,000.00 → Cuadró. Vuelve a llamar con confirm:true para guardar.',
    })
    expect(mockCorrect).not.toHaveBeenCalled()
  })

  it('venue fuera de alcance lanza y no llama al servicio', async () => {
    await expect(call({ ...base, venueId: 'venue-foreign' })).rejects.toThrow()
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('pide shifts:update antes de tocar el servicio', async () => {
    mockPreview.mockResolvedValueOnce(vista)
    await call(base)
    expect(mockRequirePermission).toHaveBeenCalledWith('shifts:update', 'venue-1')
    expect(mockRequirePermission.mock.invocationCallOrder[0]).toBeLessThan(mockPreview.mock.invocationCallOrder[0])
  })

  it('confirm sin expectedResultingDifference ⇒ needsInput', async () => {
    const r = parse(await call({ ...base, confirm: true, expectedCurrentCount: 20000, expectedCorrectionCount: 0 }))
    expect(r).toMatchObject({ ok: false, needsInput: true, field: 'expectedResultingDifference' })
    expect(mockCorrect).not.toHaveBeenCalled()
  })

  it('confirm con vista previa vieja ⇒ code CASH_COUNT_CHANGED', async () => {
    mockCorrect.mockRejectedValueOnce(new ConflictError('cambió', 'CASH_COUNT_CHANGED'))
    const r = parse(await call({ ...base, confirm: true, expectedCurrentCount: 1, expectedResultingDifference: 0, expectedCorrectionCount: 0 }))
    expect(r).toMatchObject({ ok: false, code: 'CASH_COUNT_CHANGED' })
  })

  it('la vista previa con monto inválido ⇒ code CASH_COUNT_INVALID_AMOUNT', async () => {
    mockPreview.mockRejectedValueOnce(new BadRequestError('monto', 'CASH_COUNT_INVALID_AMOUNT'))
    expect(parse(await call(base))).toMatchObject({ ok: false, code: 'CASH_COUNT_INVALID_AMOUNT' })
  })

  it('un error que no es AppError se relanza', async () => {
    mockPreview.mockRejectedValueOnce(new Error('boom'))
    await expect(call(base)).rejects.toThrow('boom')
  })

  it('confirm feliz: servicio con source MCP y provenance', async () => {
    mockCorrect.mockResolvedValueOnce(vista)
    const r = parse(await call({ ...base, confirm: true, expectedCurrentCount: 20000, expectedResultingDifference: 0, expectedCorrectionCount: 0 }))
    expect(r).toMatchObject({ ok: true, countedAfter: 2000 })
    expect(mockCorrect).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'MCP', staffId: 'staff-1', provenance: { source: 'customer-mcp' }, expectedCurrentCount: 20000 }),
    )
  })
})
