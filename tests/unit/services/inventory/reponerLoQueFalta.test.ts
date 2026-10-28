import { anotarRegresoEnTx, faltaPorReponerEnTx } from '@/services/inventory/reponerLoQueFalta'

// Codex c1 #3: la receta y la pieza se clasificaban con dos lecturas distintas del producto; un cambio de método entre las dos
// regresaba la prenda por los dos caminos (2 de 1). Se clasifica UNA vez y los dos caminos quedan excluyentes.
describe('anotarRegresoEnTx', () => {
  it('clasifica cada producto una sola vez: la receta va al camino de recetas y su línea nace no elegible', async () => {
    const tx = {
      product: {
        findMany: jest.fn(async () => [
          { id: 'p-receta', trackInventory: true, inventoryMethod: 'RECIPE', inventory: null },
          { id: 'p-pieza', trackInventory: true, inventoryMethod: 'QUANTITY', inventory: { id: 'inv' } },
        ]),
      },
      inventoryPosting: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({ id: 'posting' })) },
    }
    const regreso = await anotarRegresoEnTx(tx as never, {
      venueId: 'v',
      orderId: 'o',
      refundPaymentId: 'r',
      motivo: 'Devolución: regresa al inventario',
      reponer: [
        { orderItemId: 'i-receta', productId: 'p-receta', cantidad: 1 },
        { orderItemId: 'i-pieza', productId: 'p-pieza', cantidad: 1 },
      ],
      noReponer: [],
    })
    expect(tx.product.findMany).toHaveBeenCalledTimes(1)
    expect(regreso.recetas).toEqual([{ orderItemId: 'i-receta', quantity: 1 }])
    const snapshot = (tx.inventoryPosting.create.mock.calls[0] as any)[0].data.payloadSnapshot
    expect(snapshot.lines).toEqual([
      { orderItemId: 'i-receta', productId: 'p-receta', inventoryMethod: 'RECIPE', eligible: false },
      { orderItemId: 'i-pieza', productId: 'p-pieza', inventoryMethod: 'QUANTITY', eligible: true },
    ])
  })
})

// Codex c2 #2: si los movimientos viejos no caben en la lectura, no se adivina (cortar la lista dejaba pendiente una pieza ya
// regresada y la volvía a reponer): no se repone nada.
describe('faltaPorReponerEnTx', () => {
  it('con más movimientos viejos de los que caben en la lectura no repone nada', async () => {
    const vieja = { id: 'r-vieja', processorData: { refundedItems: [{ orderItemId: 'i1', productId: 'p1', quantity: 1 }] } }
    const db = {
      orderItem: { findMany: jest.fn(async () => [{ id: 'i1', productId: 'p1', quantity: 2, areaTicketLineId: null }]) },
      exchange: { findFirst: jest.fn(async () => null) },
      inventoryPosting: { findUnique: jest.fn(async () => null) },
      inventoryPostingLine: { findMany: jest.fn(async () => []) },
      payment: { findMany: jest.fn(async () => [vieja]) },
      inventoryMovement: {
        findMany: jest.fn(async () =>
          Array.from({ length: 501 }, () => ({ reference: 'r-vieja', quantity: 1, inventory: { productId: 'p1' } })),
        ),
      },
      rawMaterialMovement: { findMany: jest.fn(async () => []) },
    }
    const falta = await faltaPorReponerEnTx(db as never, 'v', 'o')
    expect([...falta.values()]).toEqual([])
  })
})
