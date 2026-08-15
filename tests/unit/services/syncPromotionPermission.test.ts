import { requiredPermissionsForIntent } from '@/services/mobile/sync.mobile.service'

// Aplicar una promoción REGALA mercancía: mismo riesgo que aplicar un descuento
// (`discounts:apply`) o una cortesía (`orders:comp`). Sin esto, un ADD_ITEMS
// con promotionRef pasa con `orders:create`, que tiene cualquier mesero — la
// puerta cerrada y la ventana abierta, otra vez.
describe('requiredPermissionsForIntent — promociones dentro de ADD_ITEMS', () => {
  const intent = (items: any[]) => ({ id: 'i1', type: 'ADD_ITEMS', payload: { orderId: 'o1', items } }) as any

  it('exige discounts:apply cuando un item trae promotionRef', () => {
    const permisos = requiredPermissionsForIntent(
      intent([{ promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } }]),
    )
    expect(permisos).toContain('orders:create')
    expect(permisos).toContain('discounts:apply')
  })

  it('NO lo exige en una ronda normal', () => {
    const permisos = requiredPermissionsForIntent(intent([{ productId: 'p1', quantity: 1 }]))
    expect(permisos).toEqual(['orders:create'])
  })

  it('lo exige una sola vez aunque la ronda traiga varias promociones', () => {
    const permisos = requiredPermissionsForIntent(
      intent([
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
        { promotionRef: { promotionId: 'promo-2', promotionInstanceId: 'uuid-2', selections: [] } },
      ]),
    )
    expect(permisos.filter(p => p === 'discounts:apply')).toHaveLength(1)
  })

  it('acumula con la cortesía cuando la ronda trae las dos cosas', () => {
    const permisos = requiredPermissionsForIntent(
      intent([
        { productId: 'p1', quantity: 1, isCortesia: true },
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
      ]),
    )
    expect(permisos).toEqual(expect.arrayContaining(['orders:create', 'orders:comp', 'discounts:apply']))
  })
})
