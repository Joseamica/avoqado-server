/**
 * Traductor de Uber → contrato interno, probado contra un PEDIDO REAL.
 *
 * El fixture `pedido-real-delivery-by-uber.json` salió de un pedido de verdad hecho el
 * 2026-08-20 contra la tienda de prueba "Avoqado Sandbox 1". No está inventado: corrigió
 * tres suposiciones que traía la spec y que habrían roto este mapper en producción.
 */
import fixture from '../../../fixtures/delivery/uber/pedido-real-delivery-by-uber.json'
import { mapUberOrder } from '@/services/delivery-channels/providers/uber-eats/uber.mapper'

describe('uber.mapper — contra el pedido real', () => {
  it('traduce el pedido completo', () => {
    const o = mapUberOrder(fixture)

    expect(o.externalId).toBe('dbe79abc-5a6a-4b3d-85fb-cb7b15e77645')
    expect(o.displayId).toBe('77645')
    expect(o.items).toHaveLength(1)
    expect(o.placedAt.toISOString()).toBe('2026-08-20T20:05:55.000Z') // -06:00 → UTC
  })

  it('🔴 `title` es un STRING plano en el pedido, no `title.translations.en`', () => {
    // La spec decía translations. Eso es del MENÚ; el PEDIDO manda texto plano.
    expect(mapUberOrder(fixture).items[0].name).toBe('Best Burger')
  })

  it('🔴 `quantity` es un entero, no un objeto con `.amount`', () => {
    expect(mapUberOrder(fixture).items[0].quantity).toBe(1)
  })

  it('🔴 convierte centavos a PESOS: 100 → "1.00"', () => {
    const item = mapUberOrder(fixture).items[0]
    expect(item.unitPrice).toBe('1.00')
    expect(item.total).toBe('1.00')
  })

  it('el id del item viaja como externalData: es lo que Avoqado publicó en el menú', () => {
    const item = mapUberOrder(fixture).items[0]
    expect(item.externalId).toBe('external_item_1')
    expect(item.externalData).toBe('external_item_1')
  })

  it('🔴 `selected_modifier_groups: null` no revienta ni inventa modificadores', () => {
    expect(mapUberOrder(fixture).items[0].modifiers).toEqual([])
  })

  it('🔴 cuando reparte Uber NO hay propina: el reparto la deja en cero', () => {
    // Verificado con el pedido real: `payment.charges` sólo trae total y sub_total.
    const p = mapUberOrder(fixture).payment
    expect(p.tipAmount).toBe('0.00')
    expect(p.externallyPaidTip).toBe('0.00')
    expect(p.cashDueTip).toBe('0.00')
  })

  it('🔴 lo paga la plataforma: nada queda por cobrar en efectivo', () => {
    const p = mapUberOrder(fixture).payment
    expect(p.saleAmount).toBe('1.00')
    expect(p.externallyPaidSale).toBe('1.00')
    expect(p.cashDueSale).toBe('0.00')
    expect(p.currency).toBe('MXN')
  })

  it('el reparto cuadra al centavo, que es lo que la ingesta exige', () => {
    const p = mapUberOrder(fixture).payment
    const venta = Number(p.saleAmount) + Number(p.merchantFees)
    expect(venta.toFixed(2)).toBe((Number(p.externallyPaidSale) + Number(p.cashDueSale)).toFixed(2))
  })

  it('conserva el cliente y el JSON crudo para auditoría', () => {
    const o = mapUberOrder(fixture)
    expect(o.customer?.name).toContain('Avoqado')
    expect(o.customer?.phone).toBe('+52 33 1930 9789')
    expect(o.raw).toBe(fixture)
  })

  it('🔴 RECHAZA un pedido sin id: mejor fallar visible que ingerir basura', () => {
    expect(() => mapUberOrder({ ...fixture, id: undefined })).toThrow(/id/i)
  })

  it('🔴 RECHAZA una moneda que no sea MXN', () => {
    const otra = JSON.parse(JSON.stringify(fixture))
    otra.payment.charges.total.currency_code = 'USD'
    expect(() => mapUberOrder(otra)).toThrow(/MXN|moneda/i)
  })

  it('un cargo extra del comercio entra como merchantFees y sigue cuadrando', () => {
    const conCargo = JSON.parse(JSON.stringify(fixture))
    conCargo.payment.charges.total.amount = 150 // total > sub_total ⇒ 0.50 de cargos
    const p = mapUberOrder(conCargo).payment
    expect(p.saleAmount).toBe('1.00')
    expect(p.merchantFees).toBe('0.50')
    expect(p.externallyPaidSale).toBe('1.50')
  })
})
