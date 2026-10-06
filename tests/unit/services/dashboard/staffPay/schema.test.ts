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
    expect(e('ServiceEarningSource')).toEqual(['CLASS_SESSION', 'COMMISSION', 'TIP'])
  })
})

describe('schema fase 3 — el sobre (spec fase 3 §7.1, §7.4)', () => {
  const modelo = (n: string) => Prisma.dmmf.datamodel.models.find(m => m.name === n)

  it('Organization.staffPayStartDate es una fecha civil opcional: null = pago al personal sin activar', () => {
    // Que sea DATE (sin hora) lo prueba `schemaChecks.test.ts` contra la base.
    expect(modelo('Organization')!.fields.find(x => x.name === 'staffPayStartDate')).toMatchObject({ type: 'DateTime', isRequired: false })
  })

  it('StaffPayTipWindow guarda cada ventana del interruptor de propinas como [startsAt, endsAt)', () => {
    const m = modelo('StaffPayTipWindow')
    expect(m).toBeDefined()
    const campo = (n: string) => m!.fields.find(x => x.name === n)!
    expect(campo('startsAt')).toMatchObject({ type: 'DateTime', isRequired: true })
    expect(campo('endsAt')).toMatchObject({ type: 'DateTime', isRequired: false })
    expect(campo('startedById').isRequired).toBe(true)
    expect(campo('endedById').isRequired).toBe(false)
  })
})
