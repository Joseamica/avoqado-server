// Mock the Prisma client before importing the service under test.
jest.mock('../../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminalOrder: {
      count: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    terminal: {
      findFirst: jest.fn(),
      createMany: jest.fn(),
    },
    venue: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ slug: 'test-venue' }),
    },
    $transaction: jest.fn(),
  },
}))

const sendShippedMock = jest.fn()
const sendPaymentConfirmedMock = jest.fn()
const sendSerialAssignmentRequestMock = jest.fn()
const sendSpeiInstructionsMock = jest.fn()
const sendSpeiProofForSalesMock = jest.fn()
const sendSpeiRejectedMock = jest.fn()
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendTerminalOrderTerminalsShipped: sendShippedMock,
    sendTerminalOrderPaymentConfirmed: sendPaymentConfirmedMock,
    sendTerminalOrderSerialAssignmentRequest: sendSerialAssignmentRequestMock,
    sendTerminalOrderSpeiInstructions: sendSpeiInstructionsMock,
    sendTerminalOrderSpeiProofForSales: sendSpeiProofForSalesMock,
    sendTerminalOrderSpeiRejected: sendSpeiRejectedMock,
  },
}))

const uploadFileMock = jest.fn()
jest.mock('@/services/storage.service', () => ({
  uploadFileToStorage: (...args: any[]) => uploadFileMock(...args),
  buildStoragePath: (path: string) => `dev/${path}`,
}))

beforeAll(() => {
  process.env.TERMINAL_ORDER_TOKEN_SECRET = 'test-secret-32chars-min-required-x'
})

import prisma from '../../../../../src/utils/prismaClient'
import {
  createOrder,
  calculateTotals,
  assignSerials,
  markShipped,
  markDelivered,
  uploadSpeiProof,
  approveSpei,
  rejectSpei,
} from '../../../../../src/services/dashboard/terminalOrder/terminalOrder.service'

describe('calculateTotals', () => {
  it('computes subtotal + 16% IVA for a single item', () => {
    const totals = calculateTotals([{ catalogKey: 'PAX_A910S', quantity: 1 }])
    expect(totals).toEqual({
      subtotalCents: 400_000,
      taxCents: 64_000,
      totalCents: 464_000,
      currency: 'MXN',
    })
  })

  it('computes totals for multi-model carts', () => {
    const totals = calculateTotals([
      { catalogKey: 'PAX_A910S', quantity: 2 },
      { catalogKey: 'NEXGO_N62', quantity: 1 },
    ])
    expect(totals.subtotalCents).toBe(980_000)
    expect(totals.taxCents).toBe(156_800)
    expect(totals.totalCents).toBe(1_136_800)
  })

  it('throws if an item references an unknown catalogKey', () => {
    expect(() => calculateTotals([{ catalogKey: 'FAKE_MODEL', quantity: 1 }])).toThrow(/Unknown catalog key/)
  })

  it('throws if quantity < 1', () => {
    expect(() => calculateTotals([{ catalogKey: 'PAX_A910S', quantity: 0 }])).toThrow(/quantity/i)
  })

  it('throws if items array is empty', () => {
    expect(() => calculateTotals([])).toThrow(/At least one item/i)
  })
})

describe('createOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.terminalOrder.count as jest.Mock).mockResolvedValue(0)
  })

  it('persists an order with computed totals and snapshot items', async () => {
    ;(prisma.terminalOrder.create as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
    })

    await createOrder({
      venueId: 'venue_1',
      createdById: 'staff_1',
      items: [{ catalogKey: 'PAX_A910S', quantity: 1 }],
      contactName: 'Test',
      contactEmail: 'test@example.com',
      contactPhone: '+52 55 1234 5678',
      shippingAddress: 'Av X 1',
      shippingCity: 'CDMX',
      shippingState: 'CDMX',
      shippingZip: '01000',
      paymentMethod: 'CARD_STRIPE',
    })

    const createCall = (prisma.terminalOrder.create as jest.Mock).mock.calls[0][0]
    expect(createCall.data.orderNumber).toBe('AVO-0001')
    expect(createCall.data.subtotalCents).toBe(400_000)
    expect(createCall.data.totalCents).toBe(464_000)
    expect(createCall.data.paymentStatus).toBe('AWAITING_PAYMENT')
    const itemsCreate = createCall.data.items.create
    expect(itemsCreate[0]).toMatchObject({
      brand: 'PAX',
      model: 'A910S',
      productName: 'PAX A910S',
      quantity: 1,
      unitPriceCents: 400_000,
      namePrefix: 'PAX A910S',
    })
  })

  it('initial paymentStatus is AWAITING_PROOF for SPEI orders', async () => {
    ;(prisma.terminalOrder.create as jest.Mock).mockResolvedValue({ id: 'x', orderNumber: 'AVO-0001' })

    await createOrder({
      venueId: 'v',
      createdById: 's',
      items: [{ catalogKey: 'PAX_A910S', quantity: 1 }],
      contactName: 'a',
      contactEmail: 'a@a.com',
      contactPhone: '1',
      shippingAddress: 'a',
      shippingCity: 'a',
      shippingState: 'a',
      shippingZip: '1',
      paymentMethod: 'SPEI',
    })

    const call = (prisma.terminalOrder.create as jest.Mock).mock.calls[0][0]
    expect(call.data.paymentStatus).toBe('AWAITING_PROOF')
  })
})

const orderWithItemsPaid = {
  id: 'ord_paid',
  orderNumber: 'AVO-0007',
  venueId: 'venue_1',
  paymentStatus: 'PAID',
  fulfillmentStatus: 'AWAITING_SERIALS',
  items: [{ id: 'oi_1', brand: 'PAX', model: 'A910S', productName: 'PAX A910S', quantity: 2, namePrefix: 'PAX A910S' }],
}

describe('assignSerials', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      return fn({
        terminal: {
          findFirst: jest.fn().mockResolvedValue(null),
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        terminalOrder: {
          update: jest.fn().mockResolvedValue({
            ...orderWithItemsPaid,
            fulfillmentStatus: 'SERIALS_ASSIGNED',
            terminals: [],
          }),
        },
      })
    })
  })

  it('rejects if order is not paymentStatus=PAID', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      ...orderWithItemsPaid,
      paymentStatus: 'AWAITING_PAYMENT',
    })
    await expect(
      assignSerials({
        orderId: 'ord_paid',
        assignedBy: 'sales@avoqado.io',
        items: [
          {
            orderItemId: 'oi_1',
            units: [
              { name: 'A1', serial: 'S1' },
              { name: 'A2', serial: 'S2' },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/not paid/i)
  })

  it('rejects if order fulfillmentStatus is already SERIALS_ASSIGNED', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      ...orderWithItemsPaid,
      fulfillmentStatus: 'SERIALS_ASSIGNED',
    })
    await expect(assignSerials({ orderId: 'ord_paid', assignedBy: 's@a.io', items: [] })).rejects.toThrow(/already assigned/i)
  })

  it('rejects if units count per item does not match quantity', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue(orderWithItemsPaid)
    await expect(
      assignSerials({
        orderId: 'ord_paid',
        assignedBy: 's@a.io',
        items: [{ orderItemId: 'oi_1', units: [{ name: 'A1', serial: 'S1' }] }],
      }),
    ).rejects.toThrow(/expected 2 units/i)
  })

  it('rejects if a serial is empty', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue(orderWithItemsPaid)
    await expect(
      assignSerials({
        orderId: 'ord_paid',
        assignedBy: 's@a.io',
        items: [
          {
            orderItemId: 'oi_1',
            units: [
              { name: 'A1', serial: '' },
              { name: 'A2', serial: 'S2' },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/serial is required/i)
  })

  it('fires the shipped email after creating terminals', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue(orderWithItemsPaid)
    // The $transaction mock should return an order with terminals — adjust the existing mock to include terminals
    ;(prisma as any).$transaction = jest.fn(async (_fn: any) => {
      return {
        ...orderWithItemsPaid,
        fulfillmentStatus: 'SERIALS_ASSIGNED',
        items: orderWithItemsPaid.items,
        terminals: [
          { id: 't1', name: 'PAX 1', serialNumber: 'S-1', activationCode: 'AAA111', brand: 'PAX', model: 'A910S' },
          { id: 't2', name: 'PAX 2', serialNumber: 'S-2', activationCode: 'BBB222', brand: 'PAX', model: 'A910S' },
        ],
      }
    })

    await assignSerials({
      orderId: 'ord_paid',
      assignedBy: 'sales@avoqado.io',
      items: [
        {
          orderItemId: 'oi_1',
          units: [
            { name: 'PAX 1', serial: 'S-1' },
            { name: 'PAX 2', serial: 'S-2' },
          ],
        },
      ],
    })

    expect(sendShippedMock).toHaveBeenCalledTimes(1)
    const callArgs = sendShippedMock.mock.calls[0][0]
    expect(callArgs.terminals).toHaveLength(2)
  })
})

describe('markShipped', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects if order is not SERIALS_ASSIGNED', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'o',
      fulfillmentStatus: 'AWAITING_SERIALS',
    })
    await expect(markShipped({ orderId: 'o', trackingNumber: 'T1', carrier: 'DHL' })).rejects.toThrow(/must be SERIALS_ASSIGNED/i)
  })

  it('updates fulfillmentStatus + tracking when valid', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'o',
      fulfillmentStatus: 'SERIALS_ASSIGNED',
    })
    ;(prisma.terminalOrder.update as jest.Mock).mockResolvedValue({ id: 'o' })
    await markShipped({ orderId: 'o', trackingNumber: 'T1', carrier: 'DHL' })
    expect(prisma.terminalOrder.update).toHaveBeenCalledWith({
      where: { id: 'o' },
      data: {
        fulfillmentStatus: 'SHIPPED',
        trackingNumber: 'T1',
        carrier: 'DHL',
        shippedAt: expect.any(Date),
      },
    })
  })
})

describe('markDelivered', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects if not SHIPPED', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      fulfillmentStatus: 'AWAITING_SERIALS',
    })
    await expect(markDelivered({ orderId: 'o' })).rejects.toThrow(/must be SHIPPED/i)
  })

  it('updates fulfillmentStatus + deliveredAt', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'o',
      fulfillmentStatus: 'SHIPPED',
    })
    ;(prisma.terminalOrder.update as jest.Mock).mockResolvedValue({ id: 'o' })
    await markDelivered({ orderId: 'o' })
    const call = (prisma.terminalOrder.update as jest.Mock).mock.calls[0][0]
    expect(call.data.fulfillmentStatus).toBe('DELIVERED')
    expect(call.data.deliveredAt).toBeInstanceOf(Date)
  })
})

describe('uploadSpeiProof', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    uploadFileMock.mockResolvedValue('https://firebase-storage.test/url?token=abc')
  })

  it('rejects non-SPEI orders', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
      venueId: 'v',
      paymentMethod: 'CARD_STRIPE',
      paymentStatus: 'AWAITING_PAYMENT',
    })
    await expect(
      uploadSpeiProof({
        orderId: 'ord_1',
        file: { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'r.pdf', size: 100 },
      }),
    ).rejects.toThrow(/not a SPEI order/i)
  })

  it('rejects already-PAID orders', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
      venueId: 'v',
      paymentMethod: 'SPEI',
      paymentStatus: 'PAID',
    })
    await expect(
      uploadSpeiProof({
        orderId: 'ord_1',
        file: { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'r.pdf', size: 100 },
      }),
    ).rejects.toThrow(/already paid/i)
  })

  it('rejects oversize files (>10MB)', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
      venueId: 'v',
      paymentMethod: 'SPEI',
      paymentStatus: 'AWAITING_PROOF',
    })
    await expect(
      uploadSpeiProof({
        orderId: 'ord_1',
        file: { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'huge.pdf', size: 11 * 1024 * 1024 },
      }),
    ).rejects.toThrow(/too large|10/i)
  })

  it('rejects unsupported mimetypes', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
      venueId: 'v',
      paymentMethod: 'SPEI',
      paymentStatus: 'AWAITING_PROOF',
    })
    await expect(
      uploadSpeiProof({
        orderId: 'ord_1',
        file: { buffer: Buffer.from('x'), mimetype: 'application/zip', originalname: 'r.zip', size: 100 },
      }),
    ).rejects.toThrow(/file type|mimetype/i)
  })

  it('uploads to Firebase + updates order to PROOF_UPLOADED + generates approval token', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
      venueId: 'v',
      paymentMethod: 'SPEI',
      paymentStatus: 'AWAITING_PROOF',
    })
    ;(prisma.terminalOrder.update as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
      paymentStatus: 'PROOF_UPLOADED',
    })

    await uploadSpeiProof({
      orderId: 'ord_1',
      file: { buffer: Buffer.from('hello'), mimetype: 'application/pdf', originalname: 'r.pdf', size: 100 },
    })

    expect(uploadFileMock).toHaveBeenCalledTimes(1)
    const updateCall = (prisma.terminalOrder.update as jest.Mock).mock.calls[0][0]
    expect(updateCall.data.paymentStatus).toBe('PROOF_UPLOADED')
    expect(updateCall.data.speiProofUrl).toBe('https://firebase-storage.test/url?token=abc')
    expect(updateCall.data.speiProofMimeType).toBe('application/pdf')
    expect(updateCall.data.speiProofUploadedAt).toBeInstanceOf(Date)
    expect(updateCall.data.speiApprovalToken).toBeTruthy()
    expect(updateCall.data.speiTokenExpiresAt).toBeInstanceOf(Date)
  })
})

describe('approveSpei', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects if order is not PROOF_UPLOADED', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      paymentStatus: 'AWAITING_PROOF',
      items: [],
    })
    await expect(approveSpei({ orderId: 'ord_1', approvedBy: 'sales@avoqado.io' })).rejects.toThrow(
      /not in PROOF_UPLOADED/i,
    )
  })

  it('marks PAID + AWAITING_SERIALS and clears approval token (single-use)', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
      paymentStatus: 'PROOF_UPLOADED',
      items: [],
    })
    ;(prisma.terminalOrder.update as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'AWAITING_SERIALS',
      items: [],
    })

    await approveSpei({ orderId: 'ord_1', approvedBy: 'sales@avoqado.io' })

    const call = (prisma.terminalOrder.update as jest.Mock).mock.calls[0][0]
    expect(call.data.paymentStatus).toBe('PAID')
    expect(call.data.fulfillmentStatus).toBe('AWAITING_SERIALS')
    expect(call.data.speiApprovedAt).toBeInstanceOf(Date)
    expect(call.data.speiApprovedBy).toBe('sales@avoqado.io')
    expect(call.data.speiApprovalToken).toBeNull()
  })
})

describe('rejectSpei', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects if order is not PROOF_UPLOADED', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({ id: 'ord_1', paymentStatus: 'PAID' })
    await expect(
      rejectSpei({ orderId: 'ord_1', reason: 'falso', rejectedBy: 'sales@avoqado.io' }),
    ).rejects.toThrow(/not in PROOF_UPLOADED/i)
  })

  it('marks REJECTED + persists reason + clears approval token', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      orderNumber: 'AVO-0001',
      paymentStatus: 'PROOF_UPLOADED',
    })
    ;(prisma.terminalOrder.update as jest.Mock).mockResolvedValue({
      id: 'ord_1',
      paymentStatus: 'REJECTED',
    })
    await rejectSpei({
      orderId: 'ord_1',
      reason: 'El monto no coincide',
      rejectedBy: 'sales@avoqado.io',
    })
    const call = (prisma.terminalOrder.update as jest.Mock).mock.calls[0][0]
    expect(call.data.paymentStatus).toBe('REJECTED')
    expect(call.data.speiRejectionReason).toBe('El monto no coincide')
    expect(call.data.speiApprovalToken).toBeNull()
  })
})
