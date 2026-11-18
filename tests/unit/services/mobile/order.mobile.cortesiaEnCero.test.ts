/**
 * D6 (18-nov-2026): el detalle de la cuenta dice cuánto vale la cortesía que Mesas guardó en $0, con la MISMA regla que el recibo
 * digital (`cortesiaEnCeroDe`: `isCortesia`, `total` 0, sin piezas de combo, sólo regalos positivos). ANDROID la suma al papel del
 * cobro para que diga lo mismo que el digital ($75 · −$25.50). Aditivo: sin cortesía en $0 el campo no viene (apps viejas, igual).
 */
import prisma from '@/utils/prismaClient'
import { getOrder } from '@/services/mobile/order.mobile.service'

const prismaMock = prisma as any

const renglon = (o: Record<string, unknown>) => ({
  id: 'i1',
  productId: 'p1',
  productName: 'Coca',
  quantity: 1,
  unitPrice: 25,
  total: 25,
  discountAmount: 0,
  isCortesia: false,
  orderPromotionId: null,
  modifiers: [],
  ...o,
})

const orden = (items: unknown[]) => ({
  id: 'o1',
  orderNumber: '42',
  status: 'PENDING',
  paymentStatus: 'PENDING',
  type: 'DINE_IN',
  source: 'AVOQADO_ANDROID',
  subtotal: 55,
  discountAmount: 5.5,
  tipAmount: 0,
  total: 49.5,
  taxAmount: 0,
  contratoDePrecio: 'IVA_INCLUIDO',
  servedBy: null,
  servedById: null,
  items,
  payments: [],
})

const coca = renglon({ id: 'coca' })
const cafe = renglon({ id: 'cafe', productName: 'Café', unitPrice: 30, total: 30 })
const aguaEnCero = renglon({ id: 'agua', productName: 'Agua', unitPrice: 20, total: 0, discountAmount: 20, isCortesia: true })

describe('getOrder — cortesiaEnCero (D6)', () => {
  // NEW FEATURE TESTS
  it('mesa con la Agua de cortesía guardada en $0: cortesiaEnCero = 20 (lo regalado)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orden([coca, aguaEnCero, cafe]))

    expect((await getOrder('v1', 'o1')).cortesiaEnCero).toBe(20)
  })

  it('dos cortesías en $0 se suman', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      orden([aguaEnCero, renglon({ id: 'pan', unitPrice: 12.5, total: 0, discountAmount: 12.5, isCortesia: true })]),
    )

    expect((await getOrder('v1', 'o1')).cortesiaEnCero).toBe(32.5)
  })

  // REGRESSION TESTS
  it('sin cortesía: el campo no viene (la respuesta de siempre)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orden([coca, cafe]))

    expect(await getOrder('v1', 'o1')).not.toHaveProperty('cortesiaEnCero')
  })

  it('la cortesía de Mostrador (precio lleno con su descuento) ya está en el subtotal: no cuenta', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      orden([coca, renglon({ id: 'agua', unitPrice: 20, total: 20, discountAmount: 20, isCortesia: true })]),
    )

    expect(await getOrder('v1', 'o1')).not.toHaveProperty('cortesiaEnCero')
  })

  it('una pieza de combo de cortesía no cuenta (como el recibo digital)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orden([coca, { ...aguaEnCero, orderPromotionId: 'promo1' }]))

    expect(await getOrder('v1', 'o1')).not.toHaveProperty('cortesiaEnCero')
  })

  it('un regalo negativo (dato raro) no cuenta', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orden([coca, { ...aguaEnCero, discountAmount: -20 }]))

    expect(await getOrder('v1', 'o1')).not.toHaveProperty('cortesiaEnCero')
  })
})
