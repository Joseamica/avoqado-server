// El concepto de la factura lleva el nombre del producto. Si la venta no guardó el nombre en el
// renglón (`productName` nulo — lo dejan así varios caminos de venta), se usa el del catálogo:
// una factura que dice «Producto» en vez de «Café Americano» no le sirve al cliente.
import { Prisma } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { conceptosDesdeRenglon } from '../../../../src/services/fiscal/cfdi.service'

const renglon = (productName: string | null, product: any) => ({
  productName,
  quantity: 2,
  unitPrice: new Prisma.Decimal(35),
  discountAmount: new Prisma.Decimal(0),
  total: new Prisma.Decimal(70),
  modifiers: [],
  product,
})

const nombres = (r: any) => JSON.stringify(r)

describe('conceptosDesdeRenglon · nombre del concepto', () => {
  it('usa el nombre del catálogo cuando el renglón no guardó el suyo', () => {
    const r = conceptosDesdeRenglon(renglon(null, { name: 'Café Americano', taxRate: 0.16 }), 'o1')
    expect(nombres(r)).toContain('"productName":"Café Americano"')
    expect(nombres(r)).not.toContain('"productName":"Producto"')
  })

  it('prefiere el nombre guardado en la venta sobre el del catálogo (el catálogo pudo cambiar)', () => {
    const r = conceptosDesdeRenglon(renglon('Americano grande', { name: 'Café Americano', taxRate: 0.16 }), 'o1')
    expect(nombres(r)).toContain('"productName":"Americano grande"')
  })
})

import { motivosParaMostrar } from '../../../../src/services/fiscal/cfdi.service'

describe('motivosParaMostrar', () => {
  it('no enseña «sin conceptos» cuando ya hay causas concretas (es su consecuencia)', () => {
    const r = motivosParaMostrar(['El CFDI no tiene conceptos.', 'Falta el Uso del CFDI.'], ['«Latte»: cantidad inválida (0).'])
    expect(r).toEqual(['Falta el Uso del CFDI.', '«Latte»: cantidad inválida (0).'])
  })
  it('sí lo enseña cuando es la única pista', () => {
    expect(motivosParaMostrar(['El CFDI no tiene conceptos.'], [])).toEqual(['El CFDI no tiene conceptos.'])
  })
})
