import { recordPaymentBodySchema } from '@/schemas/tpv.schema'

// 🔴 S3 «Efectivo sin red en el turno correcto»: el POS (ANDROID/iOS) reintenta su venta rápida por `POST /mobile/venues/:v/fast`,
// que valida con este esquema (el mismo de `/tpv`). `validateRequest` reemplaza el cuerpo con lo que Zod devuelve: sin declarar
// `cashDrawerSessionId` el campo se borraría y la venta tardía caería en silencio en el turno nuevo.
const efectivo = {
  venueId: 'cmn3acoxt000mn227k1vdgj95',
  amount: 10000,
  tip: 0,
  status: 'COMPLETED',
  method: 'CASH',
  source: 'TPV',
  splitType: 'FULLPAYMENT',
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
}

const CAJA = 'cmcajaa00000000000000000'

describe('recordPaymentBodySchema cashDrawerSessionId', () => {
  it('lo conserva cuando viene', () => {
    expect((recordPaymentBodySchema.parse({ body: { ...efectivo, cashDrawerSessionId: CAJA } }).body as any).cashDrawerSessionId).toBe(CAJA)
  })

  it('ausente o null no cambia nada (un cobro en línea no lo manda)', () => {
    expect((recordPaymentBodySchema.parse({ body: efectivo }).body as any).cashDrawerSessionId).toBeUndefined()
    expect((recordPaymentBodySchema.parse({ body: { ...efectivo, cashDrawerSessionId: null } }).body as any).cashDrawerSessionId).toBeNull()
  })

  it('más de 64 caracteres o no texto ⇒ rechazo legible (400 del validador)', () => {
    expect(recordPaymentBodySchema.safeParse({ body: { ...efectivo, cashDrawerSessionId: 'x'.repeat(65) } }).success).toBe(false)
    expect(recordPaymentBodySchema.safeParse({ body: { ...efectivo, cashDrawerSessionId: 42 } }).success).toBe(false)
  })
})
