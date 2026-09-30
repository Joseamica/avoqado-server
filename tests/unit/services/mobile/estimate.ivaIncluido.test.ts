/**
 * Presupuestos (cotizaciones) con la convención mexicana: el precio YA trae el IVA.
 *
 * 🔴 Antes el presupuesto sumaba el 16 % ENCIMA del precio (`total = subtotal × 1.16`, el «$100 + tax» de EE.UU.), y la
 * orden que nacía al convertirlo copiaba ese total: el cliente de un producto de $100 debía $116. Toda venta nativa guarda
 * el IVA dentro del precio y `taxAmount = 0` (el desglose lo arma el CFDI con el tratamiento de cada producto).
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import { convertToOrder, createEstimate } from '@/services/mobile/estimate.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

const presupuestoGuardado = (data: Record<string, unknown>) => ({
  id: 'est-1',
  venueId: VENUE,
  estimateNumber: 'PRE-001',
  status: 'DRAFT',
  items: [],
  createdAt: new Date('2026-09-28T10:00:00.000Z'),
  updatedAt: new Date('2026-09-28T10:00:00.000Z'),
  ...data,
})

beforeEach(() => {
  jest.clearAllMocks()
  // `estimate` no existe en el prismaMock compartido: se declara aquí, igual que en `mostrador.turnoDeLaOrden.test.ts`.
  ;(prismaMock as any).estimate = { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() }
})

describe('createEstimate — el total es la suma de los precios, con el IVA dentro', () => {
  it('🔴 dos piezas de $100 dan un total de $200, sin sumar el 16 % encima', async () => {
    prismaMock.estimate.findFirst.mockResolvedValue(null)
    // `items` llega como `{ create: [...] }`: lo que devuelve la base es la lista ya creada.
    prismaMock.estimate.create.mockImplementation(async (args: any) => presupuestoGuardado({ ...args.data, items: [] }))

    // Las apps (Android e iOS) mandan el precio en PESOS, tal como se tecleó junto al «$».
    await createEstimate({
      venueId: VENUE,
      staffId: 'staff-1',
      staffName: 'Ana',
      items: [{ productName: 'Café', quantity: 2, unitPrice: 100 } as any],
    })

    const datos = (prismaMock.estimate.create as jest.Mock).mock.calls[0][0].data
    expect(Number(datos.subtotal)).toBe(200)
    expect(Number(datos.taxAmount)).toBe(0)
    expect(Number(datos.total)).toBe(200)
  })
})

/**
 * 🔴 Pesos 1:1 de ida y vuelta, como todo el API. El servidor trataba el precio como centavos (lo dividía entre 100 al
 * guardar y multiplicaba por 100 al responder) mientras las dos apps mandan y leen pesos: la pantalla mostraba $100,
 * la base guardaba $1 y la orden convertida cobraba $1.
 */
describe('createEstimate — guarda y responde pesos, con los nombres que leen las dos apps', () => {
  it('🔴 $12.50 × 3 son $37.50 en la base y en la respuesta; Android lee `number` y el `total` de cada renglón', async () => {
    prismaMock.estimate.findFirst.mockResolvedValue(null)
    prismaMock.estimate.create.mockImplementation(async (args: any) =>
      presupuestoGuardado({ ...args.data, items: args.data.items.create.map((renglon: any, i: number) => ({ id: `l${i}`, ...renglon })) }),
    )

    const respuesta: any = await createEstimate({
      venueId: VENUE,
      staffId: 'staff-1',
      staffName: 'Ana',
      items: [{ productName: 'Pan', quantity: 3, unitPrice: 12.5 } as any],
    })

    const datos = (prismaMock.estimate.create as jest.Mock).mock.calls[0][0].data
    expect(Number(datos.items.create[0].unitPrice)).toBe(12.5)
    expect(Number(datos.items.create[0].totalPrice)).toBe(37.5)
    expect(Number(datos.subtotal)).toBe(37.5)
    expect(respuesta).toMatchObject({
      estimateNumber: datos.estimateNumber,
      number: datos.estimateNumber,
      subtotal: 37.5,
      taxAmount: 0,
      total: 37.5,
    })
    expect(respuesta.items[0]).toMatchObject({ unitPrice: 12.5, totalPrice: 37.5, total: 37.5 })
  })
})

describe('convertToOrder — la orden cobra lo mismo que dicen los precios', () => {
  beforeEach(() => {
    prismaMock.estimate.update.mockResolvedValue({ id: 'est-1' } as any)
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.order.create.mockImplementation(
      async (args: any) =>
        ({
          id: 'order-1',
          orderNumber: args.data.orderNumber,
          status: 'PENDING',
          paymentStatus: 'PENDING',
          subtotal: args.data.subtotal,
          taxAmount: args.data.taxAmount,
          total: args.data.total,
          items: [],
          createdAt: new Date('2026-09-28T10:00:00.000Z'),
        }) as any,
    )
  })

  const conRenglones = (extra: Record<string, unknown>) =>
    presupuestoGuardado({
      status: 'ACCEPTED',
      convertedOrderId: null,
      customerName: 'Ana',
      items: [
        {
          id: 'l1',
          productId: null,
          productName: 'Café',
          quantity: 2,
          unitPrice: new Prisma.Decimal(100),
          totalPrice: new Prisma.Decimal(200),
        },
        {
          id: 'l2',
          productId: null,
          productName: 'Pan',
          quantity: 1,
          unitPrice: new Prisma.Decimal(50),
          totalPrice: new Prisma.Decimal(50),
        },
      ],
      ...extra,
    })

  it('🔴 la orden debe la suma de los renglones ($250) y guarda taxAmount 0, como toda venta nativa', async () => {
    prismaMock.estimate.findFirst.mockResolvedValue(
      conRenglones({ subtotal: new Prisma.Decimal(250), taxAmount: new Prisma.Decimal(0), total: new Prisma.Decimal(250) }) as any,
    )

    const resultado: any = await convertToOrder('est-1', VENUE, 'staff-1')

    const orden = (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
    expect(Number(orden.subtotal)).toBe(250)
    expect(Number(orden.taxAmount)).toBe(0)
    expect(Number(orden.total)).toBe(250)
    expect(Number(orden.remainingBalance)).toBe(250)
    for (const renglon of orden.items.create) expect(Number(renglon.taxAmount)).toBe(0)
    // La respuesta también va en pesos.
    expect(resultado.order).toMatchObject({ subtotal: 250, taxAmount: 0, total: 250 })
    expect(resultado.estimate.items[0]).toMatchObject({ unitPrice: 100, totalPrice: 200, total: 200 })
  })

  it('🔴 un presupuesto guardado con el IVA sumado encima (cálculo viejo) NO pasa ese 16 % a la orden', async () => {
    prismaMock.estimate.findFirst.mockResolvedValue(
      conRenglones({ subtotal: new Prisma.Decimal(250), taxAmount: new Prisma.Decimal(40), total: new Prisma.Decimal(290) }) as any,
    )

    await convertToOrder('est-1', VENUE, 'staff-1')

    const orden = (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
    expect(Number(orden.taxAmount)).toBe(0)
    expect(Number(orden.total)).toBe(250)
  })
})
