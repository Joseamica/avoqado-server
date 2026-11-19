/**
 * D11 r5 #1 (Codex): en una venta con vales, el aviso del descuento con tope no lo tapa OTRO error del mismo carrito (un producto,
 * un extra o un descuento que el dueño acaba de borrar). Antes de r4 el filtro corría aparte y siempre salía primero; al moverlo a la
 * misma lectura que calcula la rebaja (r4 #1) quedó detrás de esas validaciones. `buildOrderItemsData` lee los descuentos y revisa el
 * tope ANTES de validar productos, extras y descuentos que no están. Sin la opción (mostrador, TPV), el orden de siempre.
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

describe('buildOrderItemsData · D11: el aviso del tope sale antes que los demás errores del carrito', () => {
  it('🔴 un descuento con tope y otro descuento ya borrado ⇒ el aviso de D11, no «Descuento no encontrado»', async () => {
    const items = [
      { productId: jamon.id, quantity: 1, discountId: conTope.id },
      { productId: jamon.id, quantity: 1, discountId: 'desc-borrado' },
    ]
    await expect(construir(items, cliente(), { sinDescuentosConTope: 'VALE' })).rejects.toMatchObject({
      statusCode: 400,
      code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
    })
  })

  it('🔴 un descuento con tope y un extra que ya no existe ⇒ el aviso de D11, no MODIFIER_NOT_FOUND', async () => {
    const items = [
      { productId: jamon.id, quantity: 1, discountId: conTope.id },
      { productId: jamon.id, quantity: 1, modifierIds: ['extra-borrado'] },
    ]
    await expect(construir(items, cliente(), { sinDescuentosConTope: 'CAJA' })).rejects.toMatchObject({
      statusCode: 400,
      code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
    })
  })

  it('🔴 un descuento con tope y un producto que ya no existe ⇒ el aviso de D11, no «Products not found»', async () => {
    const items = [
      { productId: jamon.id, quantity: 1, discountId: conTope.id },
      { productId: 'prod-borrado', quantity: 1 },
    ]
    await expect(construir(items, cliente(), { sinDescuentosConTope: 'VALE' })).rejects.toMatchObject({
      statusCode: 400,
      code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
    })
  })

  it('sin la opción (mostrador, TPV) nada cambia: el extra que no está sigue dando MODIFIER_NOT_FOUND', async () => {
    const items = [
      { productId: jamon.id, quantity: 1, discountId: conTope.id },
      { productId: jamon.id, quantity: 1, modifierIds: ['extra-borrado'] },
    ]
    await expect(construir(items, cliente())).rejects.toMatchObject({ code: 'MODIFIER_NOT_FOUND' })
  })
})
