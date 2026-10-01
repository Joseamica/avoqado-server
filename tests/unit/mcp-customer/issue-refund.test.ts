import { registerPaymentTools } from '../../../src/mcp/tools/payments'
import type { McpScope } from '../../../src/mcp/scope'

const mockPaymentFindFirst = jest.fn()
const mockIssue = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing payments:refund')
      // Reembolsa, pero NO devuelve en efectivo lo que no fue efectivo (rol de piso, 1-oct-2026).
      if (v === 'sin-efectivo' && perm === 'payments:refund-to-cash') throw new Error('Forbidden: missing payments:refund-to-cash')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ issueRefund: (...a: unknown[]) => mockIssue(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findFirst: (...a: unknown[]) => mockPaymentFindFirst(...(a as [])), findMany: jest.fn(), groupBy: jest.fn() },
    venue: { findUnique: jest.fn() },
  },
}))

const schemas = new Map<string, Record<string, { safeParse: (v: unknown) => { success: boolean } }>>()
const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('issue_refund')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const completedPayment = {
  amount: 400,
  tipAmount: 50,
  method: 'CASH', // CASH is refundable here; CARD is blocked (separate test below)
  status: 'COMPLETED',
  type: 'REGULAR',
  createdAt: new Date('2026-06-08T20:00:00Z'),
  order: { orderNumber: 'A-77' },
}
const base = { venueId: 'v1', paymentId: 'pay-1', amount: 100, reason: 'accidental_charge' }

beforeAll(() => {
  registerPaymentTools(
    {
      tool: (...a: unknown[]) => {
        schemas.set(a[0] as string, a[a.length - 2] as never)
        handlers.set(a[0] as string, a[a.length - 1] as never)
      },
    } as never,
    scope,
  )
})
beforeEach(() => jest.clearAllMocks())

describe('issue_refund (critical money write, confirm-gated)', () => {
  it('rejects out-of-scope / no-perm — no reads, no refund', async () => {
    await expect(call({ ...base, venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call({ ...base, venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockPaymentFindFirst).not.toHaveBeenCalled()
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('🔴 refundMethod CASH sin payments:refund-to-cash ⇒ error de permiso, sin leer ni reembolsar', async () => {
    await expect(call({ ...base, venueId: 'sin-efectivo', refundMethod: 'CASH', confirm: true })).rejects.toThrow('payments:refund-to-cash')
    expect(mockPaymentFindFirst).not.toHaveBeenCalled()
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('sin payments:refund-to-cash, transferencia o el mismo medio siguen funcionando', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment).mockResolvedValueOnce(completedPayment)
    expect(parse(await call({ ...base, venueId: 'sin-efectivo', refundMethod: 'BANK_TRANSFER' })).requiresConfirmation).toBe(true)
    expect(parse(await call({ ...base, venueId: 'sin-efectivo' })).requiresConfirmation).toBe(true)
  })

  it('refuses a payment outside scope or not found', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(null)
    const out = parse(await call(base))
    expect(out.ok).toBe(false)
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('refuses non-COMPLETED payments and over-amount refunds (no service call)', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, status: 'REFUNDED' })
    const notCompleted = parse(await call(base))
    expect(notCompleted.ok).toBe(false)

    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    const tooMuch = parse(await call({ ...base, amount: 451 })) // original total = 450
    expect(tooMuch.ok).toBe(false)
    expect(tooMuch.error).toMatch(/excede/)
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('without confirm: PREVIEWS the refund and does NOT move money', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    const out = parse(await call(base))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({
      payment: { id: 'pay-1', orderNumber: 'A-77', method: 'CASH', originalTotal: 450 },
      refundAmount: 100,
      reason: 'ACCIDENTAL_CHARGE',
    })
    expect(mockIssue).not.toHaveBeenCalled()
  })

  /**
   * 🔴 Desde 2026-08-16 un reembolso en efectivo RESTA del cajón del local
   * (`postCashRefundToDrawer`). Quien opera por MCP no está frente a esa caja: la
   * vista previa tiene que decirle que va a mover dinero FÍSICO de un local, o
   * confirma a ciegas algo que alguien tendrá que sacar del cajón.
   */
  it('la vista previa AVISA que el efectivo sale del cajón del local', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    const out = parse(await call(base))
    expect(out.preview.saleDeCajonDeEfectivo).toBe(true)
    expect(out.message).toMatch(/cajón/i)
  })

  it('un cobro que NO estaba en el cajón (transferencia) no promete mover efectivo', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' })
    const out = parse(await call(base))
    expect(out.preview.saleDeCajonDeEfectivo).toBe(false)
    expect(out.message).not.toMatch(/cajón/i)
  })

  it('un vale que cuenta como efectivo físico también avisa (tenderSemantics, no method===CASH)', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({
      ...completedPayment,
      method: 'OTHER',
      tenderTypeId: 'tender-vale',
      tenderCountsAsCash: true,
    })
    const out = parse(await call(base))
    expect(out.preview.saleDeCajonDeEfectivo).toBe(true)
  })

  it('BLOCKS card payments — Blumon card refunds are done on the terminal, not via API', async () => {
    for (const method of ['CREDIT_CARD', 'DEBIT_CARD']) {
      mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, method, source: 'TPV' })
      const out = parse(await call({ ...base, confirm: true })) // even with confirm, must not proceed
      expect(out.ok).toBe(false)
      expect(out.cardRefundNotSupported).toBe(true)
      expect(out.error).toMatch(/terminal/i)
      expect(out.useInstead).toBe('refund_card_on_terminal')
      expect(mockIssue).not.toHaveBeenCalled() // never records a bookkeeping refund for a card
    }
  })

  it('una tarjeta registrada a mano (source APP) NO se manda a la terminal: vista previa por el mismo medio', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, method: 'CREDIT_CARD', source: 'APP' })
    const out = parse(await call(base))
    expect(out.cardRefundNotSupported).toBeUndefined()
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.saleDeCajonDeEfectivo).toBe(false)
  })

  it('una tarjeta registrada a mano no admite escoger otro medio', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, method: 'CREDIT_CARD', source: 'APP' })
    const out = parse(await call({ ...base, refundMethod: 'CASH' }))
    expect(out.ok).toBe(false)
    expect(out.error).toBe('Este cobro sólo se devuelve por el mismo medio con que se pagó.')
  })

  it('refundMethod null: el esquema lo acepta y se comporta como ausente (mismo medio)', async () => {
    expect(schemas.get('issue_refund')!.refundMethod.safeParse(null).success).toBe(true)
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    const out = parse(await call({ ...base, refundMethod: null }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.saleDeCajonDeEfectivo).toBe(true) // efectivo original, mismo medio
  })

  it('with confirm:true: converts pesos->cents, issues, and audits', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    mockIssue.mockResolvedValueOnce({
      refundId: 'ref-1',
      originalPaymentId: 'pay-1',
      amount: 100,
      remainingRefundable: 350,
      status: 'COMPLETED',
    })

    const out = parse(await call({ ...base, note: 'cliente insatisfecho', confirm: true }))

    expect(mockIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        paymentId: 'pay-1',
        amount: 10000,
        reason: 'ACCIDENTAL_CHARGE',
        staffId: 's1',
        note: 'cliente insatisfecho',
      }),
    )
    expect(out).toMatchObject({ ok: true, refund: { refundId: 'ref-1', amount: 100, remainingRefundable: 350 } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'REFUND_ISSUED', entity: 'Payment', entityId: 'ref-1', venueId: 'v1' })
  })

  it('vista previa de una transferencia con refundMethod CASH: sale del cajón', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' })
    const out = parse(await call({ ...base, refundMethod: 'CASH' }))
    expect(out.preview.saleDeCajonDeEfectivo).toBe(true)
    expect(out.preview.refundMethod).toBe('CASH')
  })

  it('vista previa de un efectivo con refundMethod BANK_TRANSFER: no promete cajón', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    const out = parse(await call({ ...base, refundMethod: 'BANK_TRANSFER' }))
    expect(out.preview.saleDeCajonDeEfectivo).toBe(false)
  })

  it('una tarjeta de terminal externa NO se puede devolver en efectivo: rechaza sin ofrecer confirm', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, method: 'OTHER', externalSource: 'Tarjeta (terminal externa)' })
    const out = parse(await call({ ...base, refundMethod: 'CASH' }))
    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBeUndefined()
    expect(out.error).toBe('Este cobro sólo se devuelve por el mismo medio con que se pagó.')
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('confirm:true con refundMethod CASH lo pasa al servicio y a la auditoría', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' })
    mockIssue.mockResolvedValueOnce({
      refundId: 'ref-2',
      originalPaymentId: 'pay-1',
      amount: 100,
      remainingRefundable: 350,
      status: 'COMPLETED',
    })
    await call({ ...base, refundMethod: 'CASH', confirm: true })
    expect(mockIssue).toHaveBeenCalledWith(expect.objectContaining({ refundMethod: 'CASH' }))
    expect(mockAudit.mock.calls[0][1].data).toMatchObject({ refundMethod: 'CASH' })
  })

  it('surfaces a service rejection (e.g. exceeds remaining) as ok:false', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    mockIssue.mockRejectedValueOnce(new Error('Refund amount exceeds remaining refundable'))
    const out = parse(await call({ ...base, confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/remaining/)
  })
})
