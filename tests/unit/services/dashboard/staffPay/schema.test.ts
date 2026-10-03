import { publicarVersionSchema } from '@/schemas/dashboard/staffPay.schema'

describe('staffPay schema — regresión', () => {
  it('rechaza maxCount 10,000 y montos negativos con mensajes en español', () => {
    const r = publicarVersionSchema.safeParse({
      effectiveFrom: '2026-10-01',
      countMode: 'BOOKED',
      maxCount: 10000,
      cells: [{ payLevelId: 'cxxxxxxxxxxxxxxxxxxxxxxxx', count: 1, amount: -5 }],
    })
    expect(r.success).toBe(false)
    const msgs = r.success ? [] : r.error.issues.map(i => i.message)
    expect(msgs).toEqual(expect.arrayContaining(['Máximo 500 lugares', 'El monto no puede ser negativo']))
  })
})
