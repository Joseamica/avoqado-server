/**
 * La variante DECLARADA de `release_terminal_payment` (plan 18-sep, Task 6).
 *
 * 🔴 El MCP tiene su PROPIO filtro de `UNKNOWN` antes de llamar al servicio (lo señaló Codex): sin tocarlo, una
 * fila `TIMED_OUT` —las legacy que hay que limpiar— rebotaría aquí con «sólo se libera un cobro en UNKNOWN»
 * aunque el servicio sí sepa conciliarla. Estas pruebas fijan esa puerta y el permiso que pide cada acción.
 */
import { registerTerminalTools } from '../../../src/mcp/tools/terminals'
import type { McpScope } from '../../../src/mcp/scope'

const mockRelease = jest.fn()
const mockRequirePermission = jest.fn()
const mockRequireWrite = jest.fn()
const mockFindFirst = jest.fn()

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: { releaseUnknownRequest: (...a: unknown[]) => mockRelease(...(a as [])) },
  desenlaceCanonico: () => ({ outcome: 'UNRESOLVED', outcomeEvidence: null }),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({
  requireWriteScopeAlways: (...a: unknown[]) => mockRequireWrite(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminalPaymentRequest: { findFirst: (...a: unknown[]) => mockFindFirst(...(a as [])) },
    terminal: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-cashier', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('release_terminal_payment')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    status: 'UNKNOWN',
    terminalId: 'n860w173397',
    amountCents: 7475,
    tipCents: 0,
    orderId: 'order-1',
    senderDevice: 'tablet-1',
    createdAt: new Date(Date.now() - 26 * 60 * 1000),
    terminalReturnedAt: new Date(),
    failureCode: null,
    cancelDisposition: null,
    paymentId: null,
    resultJson: null,
    ...over,
  }
}

beforeAll(() => {
  registerTerminalTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockFindFirst.mockResolvedValue(fila())
  mockRelease.mockResolvedValue({ requestId: 'req-1', released: true, status: 'FAILED', resolution: { id: 'r1', acceptedAt: 'x' } })
})

describe('release_terminal_payment — variante declarada', () => {
  it('🔴 sin confirm devuelve VISTA PREVIA y no llama al servicio', async () => {
    const out = parse(await call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.amount).toBe(74.75) // PESOS, nunca centavos
    expect(out.message).toMatch(/DECLARAR/)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('con confirm declara: el servicio recibe la declaración bien formada', async () => {
    const out = parse(await call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true, confirm: true }))
    expect(out.ok).toBe(true)
    const arg = mockRelease.mock.calls[0][0] as any
    expect(arg.declaration).toMatchObject({ requestId: 'req-1', statement: 'UNCHARGED_VERIFIED', statementVersion: 1 })
    expect(typeof arg.declaration.resolutionId).toBe('string')
  })

  it('🔴 una fila TIMED_OUT ya NO rebota cuando se declara', async () => {
    mockFindFirst.mockResolvedValue(fila({ status: 'TIMED_OUT' }))
    const out = parse(await call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true, confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockRelease).toHaveBeenCalled()
  })

  it('🔴 sin verifiedUncharged, una fila TIMED_OUT sigue rebotando EXACTAMENTE igual que antes', async () => {
    mockFindFirst.mockResolvedValue(fila({ status: 'TIMED_OUT' }))
    const out = parse(await call({ venueId: 'v1', requestId: 'req-1', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/UNKNOWN/)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('🔴 declarar pide el permiso del CAJERO', async () => {
    await call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true, confirm: true })
    expect(mockRequirePermission).toHaveBeenCalledWith('payments:reconcile-uncharged', 'v1')
  })

  it('🔴 liberar a secas sigue pidiendo el de GERENCIA', async () => {
    await call({ venueId: 'v1', requestId: 'req-1', confirm: true })
    expect(mockRequirePermission).toHaveBeenCalledWith('tpv:update', 'v1')
  })

  it('🔴 un token de sólo lectura no puede declarar', async () => {
    mockRequireWrite.mockImplementationOnce(() => {
      throw new Error('read-only')
    })
    await expect(call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true, confirm: true })).rejects.toThrow()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('sin declaración NO se manda `declaration` al servicio', async () => {
    await call({ venueId: 'v1', requestId: 'req-1', confirm: true })
    expect((mockRelease.mock.calls[0][0] as any).declaration).toBeUndefined()
  })
})
