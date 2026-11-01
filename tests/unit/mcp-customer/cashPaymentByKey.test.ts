import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { registerPaymentTools } from '@/mcp/tools/payments'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TIERS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'

const venueId = 'c0000000000000000000000001'
const orderId = 'c0000000000000000000000002'
const key = 'original-key'
const scope: McpScope = {
  staffId: 'c0000000000000000000000003',
  activeOrg: 'c0000000000000000000000004',
  scopes: ['mcp:read'],
  allowedVenueIds: [venueId],
  perVenueAccess: new Map([[venueId, { corePermissions: ['payments:read'] } as never]]),
}
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const call = async (args: Record<string, unknown>) => {
  const handler = handlers.get('get_cash_payment_by_key')
  expect(handler).toEqual(expect.any(Function))
  return JSON.parse((await handler!(args, {})).content[0].text)
}
const row = (amount: string, tip = '0') => ({
  id: 'c0000000000000000000000005',
  venueId,
  idempotencyKey: key,
  orderId,
  type: 'FAST',
  status: 'COMPLETED',
  method: 'CASH',
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderRevision: null,
  splitType: 'FULLPAYMENT',
  amount: new Prisma.Decimal(amount),
  tipAmount: new Prisma.Decimal(tip),
  thirdPartyCashAmount: null,
  order: { id: orderId, venueId, externalId: null, thirdPartyCashDue: null },
})

describe('get_cash_payment_by_key — free MCP, read only, pesos', () => {
  beforeAll(() => registerPaymentTools({ tool: (...args: any[]) => handlers.set(args[0], args[args.length - 1]) } as never, scope))
  beforeEach(() => {
    jest.clearAllMocks()
    scope.perVenueAccess.set(venueId, { corePermissions: ['payments:read'] } as never)
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(row('19.99', '0.01') as never)
    jest
      .mocked(prisma.order.findUnique)
      .mockResolvedValue({ paymentStatus: 'PARTIAL', total: 40, paidAmount: 20, remainingBalance: 20 } as never)
  })

  it('is registered as read and remains outside every certified tier', () => {
    expect(handlers.has('get_cash_payment_by_key')).toBe(true)
    expect(TOOL_EFFECTS.get_cash_payment_by_key).toBe('read')
    expect(DIRECTORY_TIERS.flatMap(tier => [...tier.tools])).not.toContain('get_cash_payment_by_key')
    expect(handlers.has('list_payments')).toBe(true)
    expect(TOOL_EFFECTS.list_payments).toBe('read')
  })

  it.each([
    ['0.00', 0],
    ['0.01', 0.01],
    ['19.99', 19.99],
  ] as const)('returns %s in pesos, never cents', async (stored, expected) => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(row(stored) as never)
    const result = await call({ venueId, idempotencyKey: key })
    expect(result).toMatchObject({ ok: true, payment: { amount: expected, tipAmount: 0, cashRetained: expected } })
    expect(result.payment).toMatchObject({ remainingBalance: 20, orderPaymentStatus: 'PARTIAL' })
    expect(JSON.stringify(result)).not.toMatch(/Cents|processorData|receiptAccessKey|authorizationNumber/)
  })

  it('returns the complete stored Rappi split in pesos', async () => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue({
      ...row('175', '20'),
      type: 'REGULAR',
      tenderTypeId: 'c0000000000000000000000008',
      tenderRevision: 1,
      thirdPartyCashAmount: new Prisma.Decimal('10'),
      order: { id: orderId, venueId, externalId: 'RAPPI:original', thirdPartyCashDue: new Prisma.Decimal('10') },
    } as never)
    const result = await call({ venueId, idempotencyKey: key })
    expect(result).toMatchObject({
      ok: true,
      payment: {
        amount: 175,
        tipAmount: 20,
        cashRetained: 205,
        deliveryCashAllocation: { sale: 175, tip: 20, thirdParty: 10 },
      },
    })
  })

  it('returns an honest null and does not create a payment, receipt or table update', async () => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(null)
    expect(await call({ venueId, idempotencyKey: key })).toEqual({ ok: true, payment: null })
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(prisma.digitalReceipt.create).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('denies a foreign venue before reading the key', async () => {
    await expect(call({ venueId: 'foreign', idempotencyKey: key })).rejects.toThrow(/scope|alcance/i)
    expect(prisma.payment.findUnique).not.toHaveBeenCalled()
  })

  it('honors effective revoked read permission even on an OAuth read connection', async () => {
    scope.perVenueAccess.set(venueId, { corePermissions: [] } as never)
    await expect(call({ venueId, idempotencyKey: key })).rejects.toThrow(/payments:read/)
    expect(prisma.payment.findUnique).not.toHaveBeenCalled()
  })
})
