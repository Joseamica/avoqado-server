import { recordPaymentBodySchema } from '@/schemas/tpv.schema'

// Lealtad: la terminal manda la hora en que capturó la venta que sube de su cola (`createdAtLocal`, epoch ms). `validateRequest`
// reemplaza el cuerpo con lo que Zod devuelve: sin declararlo, el campo se borraría y la venta quedaría fechada a la llegada.
// El dinero ya se cobró: un valor ilegible se descarta (como hoy), nunca un 400.
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
  isOfflineReplay: true,
}

const cuerpo = (extra: Record<string, unknown>) => recordPaymentBodySchema.safeParse({ body: { ...efectivo, ...extra } })

describe('recordPaymentBodySchema createdAtLocal', () => {
  it('conserva el epoch ms, como número o como texto de dígitos', () => {
    expect((cuerpo({ createdAtLocal: 1_762_900_000_000 }) as any).data.body.createdAtLocal).toBe(1_762_900_000_000)
    expect((cuerpo({ createdAtLocal: '1762900000000' }) as any).data.body.createdAtLocal).toBe('1762900000000')
  })

  it('ausente o null: como hoy (una terminal vieja no lo manda)', () => {
    expect((cuerpo({}) as any).data.body.createdAtLocal).toBeUndefined()
    expect((cuerpo({ createdAtLocal: null }) as any).data.body.createdAtLocal).toBeNull()
  })

  it('ilegible ⇒ se descarta sin rechazar el cobro', () => {
    for (const basura of [{ a: 1 }, true, 'x'.repeat(100), [1]]) {
      const r = cuerpo({ createdAtLocal: basura })
      expect(r.success).toBe(true)
      expect((r as any).data.body.createdAtLocal).toBeUndefined()
    }
  })
})
