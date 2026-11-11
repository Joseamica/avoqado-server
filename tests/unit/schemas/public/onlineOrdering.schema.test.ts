// Tienda híbrida T7 (R7): en «Nadie» basta el nombre; el teléfono sólo es obligatorio con tarjeta en línea.
import { createOrderSchema } from '@/schemas/public/onlineOrdering.schema'

const pedido = (body: Record<string, unknown> = {}, customer: Record<string, unknown> = { name: 'María', phone: '5543453965' }) => ({
  params: { venueSlug: 'flautas' },
  body: { items: [{ productId: 'p1', quantity: 1 }], paymentMode: 'PAY_AT_PICKUP', expectedTotal: '206.00', customer, ...body },
})

describe('createOrderSchema (público)', () => {
  it('al pagar en caja el teléfono es OPCIONAL: basta el nombre', () => {
    expect(createOrderSchema.safeParse(pedido({}, { name: 'María' })).success).toBe(true)
  })

  it('con tarjeta en línea el teléfono sigue siendo OBLIGATORIO (R7)', () => {
    const r = createOrderSchema.safeParse(pedido({ paymentMode: 'CARD_ONLINE' }, { name: 'María' }))
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]).toMatchObject({ path: ['body', 'customer', 'phone'], message: 'Escribe tu teléfono' })
    expect(createOrderSchema.safeParse(pedido({ paymentMode: 'CARD_ONLINE' })).success).toBe(true)
  })

  it('un teléfono que sí viene se sigue validando', () => {
    expect(createOrderSchema.safeParse(pedido({}, { name: 'María', phone: '123' })).success).toBe(false)
  })

  it('channel es opcional y sólo QR o LINK', () => {
    expect(createOrderSchema.safeParse(pedido({ channel: 'QR' })).success).toBe(true)
    expect(createOrderSchema.safeParse(pedido({ channel: 'LINK' })).success).toBe(true)
    expect(createOrderSchema.safeParse(pedido({ channel: 'WHATSAPP' })).success).toBe(false)
  })

  it('S11: beneficios es opcional, con la MISMA forma que al cotizar (en español), y el cupón sale sin bytes de control', () => {
    expect(createOrderSchema.safeParse(pedido({ beneficios: { premioId: 'r1', puntos: 50, cupon: 'DIEZ' } })).success).toBe(true)
    expect(createOrderSchema.safeParse(pedido({ beneficios: {} })).success).toBe(true)
    const puntos = createOrderSchema.safeParse(pedido({ beneficios: { puntos: 1.5 } }))
    expect(puntos.success).toBe(false)
    if (!puntos.success) expect(puntos.error.issues[0].message).toBe('Los puntos deben ser un número entero')
    const cupon = createOrderSchema.safeParse(pedido({ beneficios: { cupon: 'DI\u001bEZ' } }))
    expect(cupon.success && (cupon.data.body as { beneficios: { cupon: string } }).beneficios.cupon).toBe('DIEZ')
  })
})
