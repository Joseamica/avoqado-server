/**
 * record_manual_payment MCP tool (2026-06-18): record a payment by hand (cash,
 * transfer, external channel) — attach to an order or as a standalone bookkeeping
 * entry. Mirrors the dashboard gating: core, permission-only (payment:create-manual),
 * NO plan gate. Money is pesos 1:1 — the tool takes numbers and hands the service
 * Decimal-as-STRINGS (money2 → toFixed(2)), so the cents are exact.
 *
 * Tests: confirm-gating (preview never writes), the friendly method/source enums +
 * amounts map correctly to the service call, source=other requires externalSource,
 * the write is audited, and the permission/scope gates fire before anything.
 */
import { registerPaymentTools } from '../../../src/mcp/tools/payments'
import type { McpScope } from '../../../src/mcp/scope'

const mockCreate = jest.fn()
const mockAudit = jest.fn()
const permisos = new Set<string>()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing payment:create-manual')
    },
    tienePermiso: (perm: string) => permisos.has(perm),
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/manualPayment.service', () => ({ createManualPayment: (...a: unknown[]) => mockCreate(...(a as [])) }))
jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ issueRefund: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { payment: { findFirst: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() }, venue: { findUnique: jest.fn() } },
}))

const schemas = new Map<string, Record<string, import('zod').ZodTypeAny>>()
const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) =>
  handlers.get('record_manual_payment')!({ idempotencyKey: 'mcp-test-payment-001', ...args }, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerPaymentTools(
    {
      tool: (...a: unknown[]) => {
        schemas.set(a[0] as string, a[2] as never)
        handlers.set(a[0] as string, a[a.length - 1] as never)
      },
    } as never,
    scope,
  )
})
beforeEach(() => {
  jest.clearAllMocks()
  permisos.clear()
  mockCreate.mockResolvedValue({
    id: 'pay-9',
    amount: '123.45',
    tipAmount: '7.50',
    method: 'CASH',
    status: 'COMPLETED',
    orderId: 'ord-shadow',
  })
})

describe('record_manual_payment — confirm gating', () => {
  it('without confirm → preview only, the service is NOT called', async () => {
    const out = parse(await call({ venueId: 'v1', amount: 123.45, method: 'cash' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.amount).toBe(123.45)
    expect(out.preview.mode).toBe('standalone-bookkeeping-entry')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('record_manual_payment — write maps + audits', () => {
  it('confirm:true hands the service Decimal-STRING amounts + mapped enums, then audits', async () => {
    const out = parse(await call({ venueId: 'v1', amount: 123.45, tipAmount: 7.5, method: 'cash', source: 'phone', confirm: true }))
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const [venueId, staffId, input] = mockCreate.mock.calls[0]
    expect(venueId).toBe('v1')
    expect(staffId).toBe('s1')
    expect(input.idempotencyKey).toBe('mcp-test-payment-001')
    expect(input.amount).toBe('123.45') // STRING, exact cents — pesos 1:1, not ×100
    expect(input.tipAmount).toBe('7.50')
    expect(input.method).toBe('CASH') // friendly 'cash' → Prisma enum
    expect(input.source).toBe('PHONE') // friendly 'phone' → Prisma enum
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(), // scope (first arg)
      expect.objectContaining({ action: 'MANUAL_PAYMENT_RECORDED', entity: 'Payment', entityId: 'pay-9' }),
    )
    expect(out.ok).toBe(true)
    expect(out.payment.id).toBe('pay-9')
  })

  it("defaults source to 'pos' and passes orderId through (attach mode)", async () => {
    await call({ venueId: 'v1', amount: 50, method: 'bank_transfer', orderId: 'ord-1', confirm: true })
    const input = mockCreate.mock.calls[0][2]
    expect(input.source).toBe('POS')
    expect(input.method).toBe('BANK_TRANSFER')
    expect(input.orderId).toBe('ord-1')
  })
})

describe('record_manual_payment — validation + gates', () => {
  it("source='other' without externalSource → clean error, no write", async () => {
    const out = parse(await call({ venueId: 'v1', amount: 10, method: 'cash', source: 'other', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/externalSource/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("externalSource set but source != 'other' → clean error", async () => {
    const out = parse(await call({ venueId: 'v1', amount: 10, method: 'cash', source: 'pos', externalSource: 'Rappi', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/externalSource/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('out-of-scope / missing permission → throws, never reaches the service', async () => {
    await expect(call({ venueId: 'foreign', amount: 10, method: 'cash', confirm: true })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', amount: 10, method: 'cash', confirm: true })).rejects.toThrow('Forbidden')
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

it('no ejecuta dinero sin una llave estable de reintento', async () => {
  const out = parse(
    await call({
      venueId: 'v1',
      paymentId: 'pay-1',
      amount: 10,
      method: 'cash',
      reason: 'other',
      confirm: true,
      idempotencyKey: undefined,
    }),
  )
  expect(out).toMatchObject({ needsInput: true, field: 'idempotencyKey' })
  expect(mockCreate).not.toHaveBeenCalled()
})

it.each(['record_manual_payment', 'issue_refund'])(
  '%s rechaza fracciones de centavo y valores no representables antes de ejecutar',
  name => {
    const amount = schemas.get(name)!.amount
    for (const invalid of [0.004, 12.345, Infinity, Number.MAX_SAFE_INTEGER]) expect(amount.safeParse(invalid).success).toBe(false)
    for (const valid of [0.01, 45.5, 123.45]) expect(amount.safeParse(valid).success).toBe(true)
  },
)

describe('🔴 R5-1: record_manual_payment le dice al servicio si quien está conectado puede cobrar (Codex recheck-9 P2)', () => {
  const ligar = { venueId: 'v1', amount: 20, method: 'cash', orderId: 'ord-1', customerId: 'cust-K', confirm: true }

  it('🔴 con payment:create-manual y SIN payments:create ⇒ puedeCambiarClienteEnVentaCobrada: false', async () => {
    permisos.add('payment:create-manual')
    await call(ligar)
    expect(mockCreate).toHaveBeenCalledWith('v1', 's1', expect.objectContaining({ orderId: 'ord-1', customerId: 'cust-K' }), {
      puedeCambiarClienteEnVentaCobrada: false,
    })
  })

  it('con payments:create ⇒ true', async () => {
    permisos.add('payment:create-manual').add('payments:create')
    await call(ligar)
    expect(mockCreate).toHaveBeenCalledWith('v1', 's1', expect.any(Object), { puedeCambiarClienteEnVentaCobrada: true })
  })

  it('sin cliente o sin venta existente no se pregunta (como hoy)', async () => {
    await call({ ...ligar, customerId: undefined })
    await call({ ...ligar, orderId: undefined })
    expect(mockCreate.mock.calls.map(c => c[3])).toEqual([{}, {}])
  })

  it('el 403 del servicio sale como `ok: false` con su mensaje en español (sin auditar una escritura que no ocurrió)', async () => {
    mockCreate.mockRejectedValueOnce(
      Object.assign(new Error('Para cambiar el cliente de una venta ya cobrada necesitas el permiso de cobrar.'), { statusCode: 403 }),
    )
    const r = parse(await call(ligar))
    expect(r).toEqual({ ok: false, error: 'Para cambiar el cliente de una venta ya cobrada necesitas el permiso de cobrar.' })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('🔴 R7-1: venta ya cobrada ⇒ el rechazo del servicio llega al LLM tal cual (decisión del founder, 16-oct)', () => {
  it('400 ORDER_ALREADY_PAID ⇒ `ok:false` con el mensaje en español, sin auditar (no hubo escritura)', async () => {
    const { BadRequestError } = jest.requireActual('@/errors/AppError')
    const mensaje = 'Esta venta ya está cobrada. Para cobrar algo extra, registra una venta nueva.'
    mockCreate.mockRejectedValueOnce(new BadRequestError(mensaje, 'ORDER_ALREADY_PAID'))
    const r = parse(await call({ venueId: 'v1', amount: 20, method: 'cash', orderId: 'ord-1', confirm: true }))
    expect(r).toEqual({ ok: false, error: mensaje })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
