/**
 * D11 · promesa v3.2 (regla de parada tras Codex r5 = 2 y r6 = 2, misma familia «qué error sale primero»): el aviso del descuento con
 * tope sale ANTES de validar el descuento (vigencia, cupo, aprobación, cortesía), con la misma lectura que calcula la rebaja. NO se
 * promete que salga antes que los demás problemas del carrito (un producto, un extra o un descuento que ya no está, el carrito mixto
 * apagado): esos frenan la venta igual, sin guardar nada, y al corregirlos sale el del tope.
 *
 * 🔴 Codex r6 #1: el orden de las lecturas NO cambia (producto → extras → descuento), con o sin la opción. Adelantar la lectura del
 * descuento (602a3fd91) cambiaba qué descuento se aceptaba en Mostrador y en la caja externa cuando el dueño lo editaba en ese instante.
 */
import { Decimal } from '@prisma/client/runtime/library'
import { buildOrderItemsData } from '@/services/mobile/order.mobile.service'
import { CODIGO_DESCUENTO_CON_TOPE_EN_VALES } from '@/services/shared/descuentoConTopeEnVales'

const jamon = { id: 'prod-jamon', name: 'Jamon', price: new Decimal(100), sku: 'JAM', categoryId: 'cat-1', category: { name: 'Abarrotes' } }
const conTope = {
  id: 'desc-tope',
  venueId: 'venue-1',
  name: 'Primeros 100',
  type: 'PERCENTAGE',
  value: new Decimal(10),
  maxTotalUses: 100,
  maxUsesPerCustomer: null,
}

/** Un cliente de transacción de mentira: sólo lo que el constructor lee antes de calcular. */
function cliente({ productos = [jamon], extras = [] as unknown[], descuentos = [conTope] as unknown[] } = {}) {
  return {
    product: { findMany: jest.fn().mockResolvedValue(productos) },
    modifier: { findMany: jest.fn().mockResolvedValue(extras) },
    discount: { findMany: jest.fn().mockResolvedValue(descuentos) },
  } as any
}

const construir = (items: any[], db: any, opciones?: { sinDescuentosConTope?: 'VALE' | 'CAJA' }) =>
  buildOrderItemsData('venue-1', items, null, undefined, db, undefined, opciones)

describe('buildOrderItemsData · D11 v3.2: el aviso del tope y el orden de las lecturas', () => {
  it('🔴 un descuento con tope que además pide aprobación ⇒ el aviso de D11, antes del 403 de aprobación', async () => {
    const db = cliente({ descuentos: [{ ...conTope, requiresApproval: true }] })
    await expect(
      construir([{ productId: jamon.id, quantity: 1, discountId: conTope.id }], db, { sinDescuentosConTope: 'VALE' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
    })
  })

  it('🔴 un descuento con tope ya inactivo ⇒ el aviso de D11, antes de la validación de vigencia', async () => {
    const db = cliente({ descuentos: [{ ...conTope, active: false }] })
    await expect(
      construir([{ productId: jamon.id, quantity: 1, discountId: conTope.id }], db, { sinDescuentosConTope: 'CAJA' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
    })
  })

  it.each([
    ['sin la opción (mostrador, caja externa)', undefined],
    ['con la opción (vales)', { sinDescuentosConTope: 'VALE' as const }],
  ])('🔴 Codex r6 #1 · %s: el descuento se lee después del producto, como siempre', async (_caso, opciones) => {
    const db = cliente()
    // Sin la opción puede seguir hasta el cálculo (o tropezar con lo que este cliente de mentira no trae): aquí sólo importa el orden.
    await construir([{ productId: jamon.id, quantity: 1, discountId: conTope.id }], db, opciones).catch(() => undefined)
    expect(db.product.findMany).toHaveBeenCalled()
    expect(db.discount.findMany).toHaveBeenCalled()
    expect(db.product.findMany.mock.invocationCallOrder[0]).toBeLessThan(db.discount.findMany.mock.invocationCallOrder[0])
  })

  it('un producto que ya no existe frena la venta antes de leer el descuento, con o sin la opción (v3.2: no es hueco, no se guarda nada)', async () => {
    const db = cliente({ productos: [] })
    await expect(
      construir([{ productId: 'prod-borrado', quantity: 1, discountId: conTope.id }], db, { sinDescuentosConTope: 'VALE' }),
    ).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(db.discount.findMany).not.toHaveBeenCalled()
  })

  it('sin la opción nada cambia: el extra que no está sigue dando MODIFIER_NOT_FOUND', async () => {
    const items = [
      { productId: jamon.id, quantity: 1, discountId: conTope.id },
      { productId: jamon.id, quantity: 1, modifierIds: ['extra-borrado'] },
    ]
    await expect(construir(items, cliente())).rejects.toMatchObject({ code: 'MODIFIER_NOT_FOUND' })
  })
})
