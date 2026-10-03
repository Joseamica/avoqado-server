import { Prisma } from '@prisma/client'
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

describe('schema fase 2 — periodo, devengo y recibo', () => {
  it('existen los tres modelos con sus campos de dinero en Decimal', () => {
    const modelo = (n: string) => Prisma.dmmf.datamodel.models.find(m => m.name === n)
    for (const n of ['ServicePayPeriod', 'ServiceEarning', 'StaffPayStatement']) expect(modelo(n)).toBeDefined()
    const campo = (m: string, f: string) => modelo(m)!.fields.find(x => x.name === f)
    expect(campo('ServiceEarning', 'amount')!.type).toBe('Decimal')
    expect(campo('StaffPayStatement', 'total')!.type).toBe('Decimal')
    expect(campo('ServicePayPeriod', 'venueIds')!.isList).toBe(true)
  })

  it('los enums nuevos tienen exactamente sus valores', () => {
    const e = (n: string) => Prisma.dmmf.datamodel.enums.find(x => x.name === n)!.values.map(v => v.name)
    expect(e('ServicePayPeriodStatus')).toEqual(['OPEN', 'CLOSED'])
    expect(e('ServiceEarningConcept')).toEqual(['SERVICE', 'RECONCILE', 'MANUAL'])
    expect(e('ServiceEarningSource')).toEqual(['CLASS_SESSION'])
  })
})
