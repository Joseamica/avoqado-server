import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import {
  createCustomerReturnPostingInTx,
  applyCustomerReturnPosting,
  applySalePosting,
} from '@/services/inventory/inventoryPosting.service'

describe('customer return posting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(null)
  })

  it('does not create a posting for an empty return', async () => {
    expect(
      await createCustomerReturnPostingInTx(prismaMock, {
        venueId: 'c123456789012345678901234',
        refundPaymentId: 'c223456789012345678901234',
        orderId: 'c323456789012345678901234',
        lines: [],
      }),
    ).toBeNull()
    expect(prismaMock.inventoryPosting.create).not.toHaveBeenCalled()
  })

  it('returns the existing obligation without reclassifying it', async () => {
    prismaMock.inventoryPosting.findUnique.mockResolvedValue({ id: 'c000000000000000000000001' } as any)
    expect(
      await createCustomerReturnPostingInTx(prismaMock, {
        venueId: 'c000000000000000000000002',
        refundPaymentId: 'c000000000000000000000003',
        orderId: 'c000000000000000000000004',
        lines: [{ orderItemId: 'c000000000000000000000005', productId: 'c000000000000000000000006', quantity: 2 }],
      }),
    ).toEqual({ id: 'c000000000000000000000001' })
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.inventoryPosting.create).not.toHaveBeenCalled()
  })

  it('freezes the original method and eligibility with the refund identity', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'c000000000000000000000006',
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
        inventory: { id: 'c000000000000000000000008' },
      },
      { id: 'c000000000000000000000007', trackInventory: true, inventoryMethod: 'RECIPE', inventory: null },
    ] as any)
    prismaMock.inventoryPosting.create.mockResolvedValue({ id: 'c000000000000000000000009' } as any)
    await createCustomerReturnPostingInTx(prismaMock, {
      venueId: 'c000000000000000000000002',
      refundPaymentId: 'c000000000000000000000003',
      orderId: 'c000000000000000000000004',
      lines: [
        { orderItemId: 'c000000000000000000000005', productId: 'c000000000000000000000006', quantity: 2 },
        { orderItemId: 'c000000000000000000000010', productId: 'c000000000000000000000007', quantity: 1 },
      ],
    })
    const data = prismaMock.inventoryPosting.create.mock.calls[0][0]!.data as any
    expect(data).toMatchObject({
      sourceKind: 'REFUND_PAYMENT',
      sourceId: 'c000000000000000000000003',
      effectKind: 'CUSTOMER_RETURN',
      orderId: 'c000000000000000000000004',
    })
    expect(data.payloadSnapshot.lines).toEqual([
      { orderItemId: 'c000000000000000000000005', productId: 'c000000000000000000000006', inventoryMethod: 'QUANTITY', eligible: true },
      { orderItemId: 'c000000000000000000000010', productId: 'c000000000000000000000007', inventoryMethod: 'RECIPE', eligible: false },
    ])
    expect(data.lines.create[0]).toMatchObject({ effectKey: 'c000000000000000000000005', expectedQuantityBase: new Prisma.Decimal(2) })
    expect(prismaMock.product.findMany.mock.calls[0][0]).toMatchObject({ where: { venueId: 'c000000000000000000000002' }, take: 2 })
  })

  it('does not let the sale applicator claim a customer return', async () => {
    prismaMock.inventoryPosting.updateMany.mockImplementation(async (args: any) => ({ count: args.where.effectKind === 'SALE' ? 0 : 1 }))
    prismaMock.inventoryPosting.findUnique.mockResolvedValue({ lines: [] } as any)
    prismaMock.orderItem.findMany.mockResolvedValue([])
    expect(await applySalePosting('c000000000000000000000011')).toBeNull()
  })

  it('does not let the return applicator claim a sale', async () => {
    prismaMock.inventoryPosting.updateMany.mockImplementation(async (args: any) => ({
      count: args.where.effectKind === 'CUSTOMER_RETURN' ? 0 : 1,
    }))
    expect(await applyCustomerReturnPosting('c000000000000000000000012')).toBeNull()
  })
})
