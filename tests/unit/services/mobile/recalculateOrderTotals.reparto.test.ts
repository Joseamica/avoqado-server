/**
 * IVA por producto, B2 (spec §4.1, D7; P1 acotado, Codex r2 N1; Codex r1 #3): el recálculo re-deriva los % de cuenta como hoy,
 * los % dirigidos con ámbito DENTRO de su ámbito, congela los que no tienen ámbito, y deja los repartos canónicos en la misma
 * transacción. Cliente de transacción distinto del global.
 */
import { prismaMock } from '../../../__helpers__/setup'
import { recalculateOrderTotals } from '@/services/mobile/comp-item.mobile.service'
import { nuevoRepartoDeCuenta, nuevoRepartoDirigido } from '@/services/shared/repartoDescuento'

const renglon = (
  id: string,
  total: number,
  discountAmount = 0,
  orderPromotionId: string | null = null,
  categoryId: string | null = 'c1',
) => ({
  id,
  total,
  discountAmount,
  orderPromotionId,
  taxAmount: 0,
  productId: categoryId ? `p-${id}` : null,
  product: categoryId ? { categoryId } : null,
})
const deCategoria = (amount: number, renglones: Record<string, number>) =>
  nuevoRepartoDirigido(amount, renglones, { espejo: false, ambito: { productos: [], categorias: ['c1'] } })
function txDoble(renglones: unknown[], filas: unknown[]) {
  return {
    orderItem: { findMany: jest.fn().mockResolvedValue(renglones) },
    orderDiscount: { findMany: jest.fn().mockResolvedValue(filas), update: jest.fn().mockResolvedValue({}) },
    orderServiceCharge: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    order: { update: jest.fn(async (a: any) => ({ ...a.data, version: 2 })), findUnique: jest.fn().mockResolvedValue(null) },
  } as any
}

it('% de cuenta: importe de hoy y UNA escritura con importe + reparto (sin la línea de promoción)', async () => {
  const tx = txDoble(
    [renglon('n', 100), renglon('p', 99, 1, 'op-1')],
    [{ id: 'd1', type: 'PERCENTAGE', value: 20, amount: 39.8, appliedToItemIds: [], reparto: null }],
  )
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderDiscount.update).toHaveBeenCalledTimes(1)
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({
    where: { id: 'd1' },
    data: { amount: 20, reparto: { v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, renglones: { n: 2000 } } },
  })
  expect(tx.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 199, discountAmount: 20, total: 179 })
  expect(prismaMock.orderDiscount.update).not.toHaveBeenCalled()
})

it('cortesía: la fila FIJA de cuenta conserva su importe y deja de darle al renglón regalado', async () => {
  const antes = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { a: 1000, b: 1000 } }
  const tx = txDoble(
    [renglon('a', 100), renglon('b', 0, 100)],
    [{ id: 'd2', type: 'FIXED_AMOUNT', value: 20, amount: 20, appliedToItemIds: [], reparto: antes }],
  )
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({ where: { id: 'd2' }, data: { reparto: { ...antes, renglones: { a: 2000 } } } })
  expect(tx.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 100, discountAmount: 20, total: 80 })
})

// Control de regresión: pasa contra el código de hoy (ni el espejo, dirigido por `appliedToItemIds`, ni la fija vieja se
// escriben); cae si la sincronización reescribe una fila espejo o le inventa reparto a una vieja (D8).
it('espejo y fila vieja sin reparto: no se escribe nada en ellas', async () => {
  const tx = txDoble(
    [renglon('a', 100, 50), renglon('b', 100)],
    [
      {
        id: 'espejo',
        type: 'PERCENTAGE',
        value: 50,
        amount: 50,
        appliedToItemIds: ['a'],
        reparto: nuevoRepartoDirigido(50, { a: 50 }, { espejo: true }),
      },
      { id: 'vieja', type: 'FIXED_AMOUNT', value: 5, amount: 5, appliedToItemIds: [], reparto: null },
    ],
  )
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderDiscount.update).not.toHaveBeenCalled()
  expect(tx.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 200, discountAmount: 55, total: 145 })
})

it('🔴 P1 antes/después: un 10 % de categoría no crece por un artículo de OTRA categoría ($5; hoy, % de la cuenta: $15)', async () => {
  const motor = { id: 'motor', type: 'PERCENTAGE', value: 10, amount: 5, appliedToItemIds: [], reparto: deCategoria(5, { a: 5 }) }
  const tx = txDoble([renglon('a', 50), renglon('b', 100, 0, null, 'c9')], [motor])
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({ where: { id: 'motor' }, data: { amount: 5 } })
  expect(tx.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 150, discountAmount: 5, total: 145 })
})

it('control — venta sana (Codex r2 N1): subir la cantidad del artículo de la categoría re-deriva igual que hoy ($10 → $20)', async () => {
  const motor = { id: 'motor', type: 'PERCENTAGE', value: 10, amount: 10, appliedToItemIds: [], reparto: deCategoria(10, { a: 10 }) }
  const tx = txDoble([renglon('a', 200)], [motor])
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({
    where: { id: 'motor' },
    data: { amount: 20, reparto: { ...deCategoria(10, { a: 10 }), renglones: { a: 2000 } } },
  })
  expect(tx.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 200, discountAmount: 20, total: 180 })
})

it('🔴 P1 antes/después: un 2×1 al 100 % (dirigido, sin ámbito) se queda en $50; hoy toda la cuenta salía gratis', async () => {
  const bogo = {
    id: 'bogo',
    type: 'PERCENTAGE',
    value: 100,
    amount: 50,
    appliedToItemIds: [],
    reparto: nuevoRepartoDirigido(50, { b: 50 }, { espejo: false }),
  }
  const tx = txDoble([renglon('a', 100), renglon('b', 100)], [bogo])
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderDiscount.update).not.toHaveBeenCalled()
  expect(tx.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 200, discountAmount: 50, total: 150 })
})

it('control de regresión (Codex r1 #3): un 0.0049 % se sigue re-derivando — al duplicar la base pasa de $0.49 a $0.98', async () => {
  const tx = txDoble(
    [renglon('a', 20000)],
    [{ id: 'chico', type: 'PERCENTAGE', value: '0.0049', amount: 0.49, appliedToItemIds: [], reparto: null }],
  )
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({ where: { id: 'chico' }, data: expect.objectContaining({ amount: 0.98 }) })
})

it('lee renglones con su id, su descuento propio, su impuesto y su ámbito (producto y categoría), con el tx recibido', async () => {
  const tx = txDoble([], [])
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderItem.findMany).toHaveBeenCalledWith({
    where: { orderId: 'order-1' },
    select: {
      id: true,
      total: true,
      discountAmount: true,
      orderPromotionId: true,
      isCortesia: true,
      taxAmount: true,
      productId: true,
      product: { select: { categoryId: true } },
    },
  })
})

it('🔴 R6 antes/después: el recálculo respeta el tope del catálogo del % de cuenta ($12; hoy $20) y lo conserva en el reparto', async () => {
  const tx = txDoble(
    [renglon('a', 100), renglon('b', 100)],
    [
      {
        id: 'cta',
        type: 'PERCENTAGE',
        value: 10,
        amount: 10,
        appliedToItemIds: [],
        reparto: nuevoRepartoDeCuenta({ conPromociones: false, tope: 12 }),
      },
    ],
  )
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({
    where: { id: 'cta' },
    data: expect.objectContaining({ amount: 12, reparto: expect.objectContaining({ tope: 12 }) }),
  })
  expect(tx.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 200, discountAmount: 12, total: 188 })
})

it('🔴 P12: el recálculo guarda el total CON el IVA que va aparte ($100 + $16; hoy $100)', async () => {
  const tx = txDoble([renglon('a', 100)], [])
  tx.order.findUnique = jest.fn().mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 16 })
  await recalculateOrderTotals('order-1', 0, 0, tx)
  expect(tx.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 100, discountAmount: 0, total: 116 })
})
