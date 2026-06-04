// tests/unit/services/fiscal/assembleSaleInput.test.ts
import { Prisma } from '@prisma/client'
import { assembleSaleInput, LoadedOrderForCfdi } from '../../../../src/services/fiscal/assembleSaleInput'

const D = (n: number) => new Prisma.Decimal(n)

const order: LoadedOrderForCfdi = {
  venueType: 'RESTAURANT',
  tipAmount: D(15),
  items: [
    {
      productName: 'Tacos',
      quantity: 2,
      unitPrice: D(50), // NET pesos
      discountAmount: D(0),
      product: {
        satProductKey: null,
        satUnitKey: null,
        objetoImp: '02',
        taxRate: D(0.16),
        category: { defaultSatProductKey: '90101500', defaultSatUnitKey: 'E48' },
      },
    },
  ],
}

describe('assembleSaleInput', () => {
  it('converts Decimal pesos → integer cents and carries SAT keys + tip', () => {
    const input = assembleSaleInput(order, {
      receptor: { rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' },
      paymentMethod: 'CASH',
      metodoPago: 'PUE',
      idempotencyKey: 'cfdi-order-1',
    })
    expect(input.venueType).toBe('RESTAURANT')
    expect(input.tipCents).toBe(1500)
    expect(input.items[0].unitPriceCents).toBe(5000)
    expect(input.items[0].taxRate).toBe(0.16)
    expect(input.items[0].taxExempt).toBe(false)
    expect(input.items[0].categoryDefaultProductKey).toBe('90101500')
    expect(input.items[0].description).toBe('Tacos')
  })

  it('marks 0%/exempt items and tolerates a deleted product (null → sector default later)', () => {
    const exempt: LoadedOrderForCfdi = {
      ...order,
      items: [
        {
          productName: 'Libro',
          quantity: 1,
          unitPrice: D(100),
          discountAmount: D(0),
          product: { satProductKey: null, satUnitKey: null, objetoImp: '01', taxRate: D(0), category: null },
        },
      ],
    }
    const input = assembleSaleInput(exempt, {
      receptor: (order as any) && { rfc: 'XAXX010101000', razonSocial: 'P', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' },
      paymentMethod: 'CASH',
      metodoPago: 'PUE',
      idempotencyKey: 'k',
    })
    expect(input.items[0].taxExempt).toBe(true)
    expect(input.items[0].taxRate).toBe(0)
    expect(input.items[0].categoryDefaultProductKey).toBeNull()
  })

  it('handles a fully null product (deleted) without throwing', () => {
    const noProduct: LoadedOrderForCfdi = {
      ...order,
      items: [{ productName: 'X', quantity: 1, unitPrice: D(10), discountAmount: D(0), product: null }],
    }
    const input = assembleSaleInput(noProduct, {
      receptor: { rfc: 'XAXX010101000', razonSocial: 'P', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' },
      paymentMethod: 'CASH',
      metodoPago: 'PUE',
      idempotencyKey: 'k',
    })
    expect(input.items[0].taxRate).toBe(0.16) // default IVA when no product
    expect(input.items[0].satProductKey).toBeNull()
  })
})
