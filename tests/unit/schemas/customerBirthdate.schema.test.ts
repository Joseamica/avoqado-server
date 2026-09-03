import { CreateCustomerSchema } from '@/schemas/dashboard/customer.schema'

const base = { params: { venueId: 'c'.padEnd(25, '1') } }

describe('CreateCustomerSchema — birthDate fecha civil', () => {
  it("'1990-05-10' se normaliza a medianoche UTC del 10-may (no del 9)", () => {
    const r = CreateCustomerSchema.parse({ ...base, body: { email: 'a@b.mx', birthDate: '1990-05-10' } })
    expect(r.body.birthDate!.toISOString()).toBe('1990-05-10T00:00:00.000Z')
  })

  it('ISO legado con hora también cae al día correcto (parte de fecha UTC)', () => {
    const r = CreateCustomerSchema.parse({ ...base, body: { email: 'a@b.mx', birthDate: '1990-05-10T00:00:00.000Z' } })
    expect(r.body.birthDate!.toISOString()).toBe('1990-05-10T00:00:00.000Z')
  })

  it('basura no pasa, con mensaje en español', () => {
    const r = CreateCustomerSchema.safeParse({ ...base, body: { email: 'a@b.mx', birthDate: '10/05/1990' } })
    expect(r.success).toBe(false)
    if (!r.success) {
      const msg = r.error.issues.map(i => i.message).join(' | ')
      expect(msg).toMatch(/fecha/i)
    }
  })

  it('birthDate es opcional — se puede omitir', () => {
    const r = CreateCustomerSchema.parse({ ...base, body: { email: 'a@b.mx' } })
    expect(r.body.birthDate).toBeUndefined()
  })
})
