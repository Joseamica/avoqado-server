import { registerCfdiTools } from '../../../src/mcp/tools/cfdi'
import type { McpScope } from '../../../src/mcp/scope'

const mockStatus = jest.fn()
const mockEmit = jest.fn()
const mockVistaPreviaContrato = jest.fn()
const mockConfirmarContratoIvaIncluido = jest.fn()
const mockAudit = jest.fn()
const mockVenueFilter = jest.fn((v?: string) => ({ venueId: { in: [v ?? 'v1'] } }))
const mockRequirePermission = jest.fn()
const mockVenuesWithFeatureAccess = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/services/fiscal/confirmarContratoDePrecio.service', () => ({
  vistaPreviaContrato: (...a: unknown[]) => mockVistaPreviaContrato(...(a as [])),
  confirmarContratoIvaIncluido: (...a: unknown[]) => mockConfirmarContratoIvaIncluido(...(a as [])),
}))
// El tool de nota de crédito vive en el mismo archivo — se mockea para que registrarlo no cargue
// su cadena real (Storage, PAC, etc.), aunque esta suite no llama a ese tool.
jest.mock('@/services/fiscal/cfdiCreditNote.service', () => ({
  emitRefundCreditNote: (...a: unknown[]) => mockEmit(...a),
  getRefundCreditNoteStatus: (...a: unknown[]) => mockStatus(...a),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: jest.fn(() => true) }))
jest.mock('@/services/access/basePlan.service', () => ({
  venuesWithFeatureAccess: (...a: unknown[]) => mockVenuesWithFeatureAccess(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (...a: unknown[]) => mockVenueFilter(...(a as [string | undefined])),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) } },
}))
// F9: el tool loguea con `logger.error` si el servicio de confirmar lanza. `@/config/logger` ya
// está mockeado GLOBALMENTE en tests/__helpers__/setup.ts (default.error = jest.fn()) — aquí sólo
// tomamos una referencia a ESE mismo mock para poder inspeccionarlo por test.
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: (...a: unknown[]) => mockLoggerError(...(a as [])),
    warn: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never
  registerCfdiTools(reg, scope)
})

beforeEach(() => {
  jest.clearAllMocks()
  mockVenuesWithFeatureAccess.mockResolvedValue(new Set(['v1']))
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

const note = { id: 'n1', status: 'STAMP_FAILED', totalCents: 11600, receptorRfc: 'EKU9003173C9', receptorNombre: 'RECEPTOR CONGELADO' }
const recovery = {
  creditNote: note,
  recoveryOnly: true,
  eligibility: { eligible: false, reason: 'NO_ORIGINAL_CFDI', message: 'Original cancelada' },
  preview: null,
}
describe('emit_refund_credit_note', () => {
  it('preview de recuperación usa la nota congelada y nunca emite ni audita', async () => {
    mockStatus.mockResolvedValue(recovery)
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(JSON.stringify(out.preview)).toContain('RECEPTOR CONGELADO')
    expect(JSON.stringify(out.preview)).toContain('116')
    expect(out.message).toMatch(/consult/i)
    expect(mockEmit).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('confirmación recupera aunque original actual ya no sea elegible; lookupOnly impide recaptura', async () => {
    mockStatus.mockResolvedValue(recovery)
    mockEmit.mockResolvedValue({ status: 'STAMPED', cfdi: { ...note, uuid: 'uuid' } })
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', refundPaymentId: 'r1', lookupOnly: true }))
    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:issue', 'v1')
    expect(mockAudit).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, true])('captura nueva mixta bloqueada con confirm=%s', async confirm => {
    mockStatus.mockResolvedValue({
      ...recovery,
      creditNote: null,
      recoveryOnly: false,
      eligibility: {
        eligible: false,
        reason: 'ORIGINAL_IVA_MIXTO',
        message: 'La factura original tiene productos con IVA distinto de 16 %.',
      },
    })
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', confirm }))
    expect(out.reason).toBe('ORIGINAL_IVA_MIXTO')
    expect(out.error).toContain('16 %')
    expect(mockEmit).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('la feature sigue siendo obligatoria incluso para recuperar', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValue(new Set())
    expect(parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', confirm: true })).planRequired).toBe(true)
    expect(mockStatus).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })
})
