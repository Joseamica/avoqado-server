import { generateReceiptHTML } from '@/utils/receiptTemplate'

function receipt(areaDeliveryCode?: string) {
  return {
    payment: {
      id: 'payment-1',
      amount: 1,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      splitType: 'FULLPAYMENT',
      createdAt: '2026-07-29T12:00:00.000Z',
    },
    venue: {
      id: 'venue-1',
      name: 'Abarrotes El Sol',
      address: '',
      city: '',
      state: '',
      phone: '',
      email: '',
    },
    order: {
      id: 'order-1',
      orderNumber: 'AREA-101',
      areaDeliveryCode,
      type: 'TAKEOUT',
      source: 'POS',
      subtotal: 1,
      taxAmount: 0,
      tipAmount: 0,
      total: 1,
    },
    items: areaDeliveryCode
      ? [
          {
            id: 'item-1',
            productName: 'Jamón',
            quantity: 1,
            unitPrice: 1,
            total: 1,
            areaSourceLabel: 'Cremería · Vale 9016719357',
          },
        ]
      : [],
    receiptInfo: {
      accessKey: 'receipt-key',
      generatedAt: '2026-07-29T12:00:00.000Z',
      currency: 'MXN',
      taxRate: 0,
    },
  }
}

describe('digital receipt area delivery proof', () => {
  it('shows the stable delivery code for an area-ticket checkout', () => {
    const html = generateReceiptHTML(receipt('8427993264'))

    expect(html).toContain('ENTREGA POR ÁREA')
    expect(html).toContain('8427993264')
    expect(html).toContain('Presenta este comprobante en el área')
    expect(html).toContain('Cremería · Vale 9016719357')
  })

  it('does not change a normal retail receipt', () => {
    const html = generateReceiptHTML(receipt())

    expect(html).not.toContain('ENTREGA POR ÁREA')
    expect(html).not.toContain('Cremería · Vale')
  })
})
