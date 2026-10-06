import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { borrarMundo, crearMundo, Mundo, periodoCerrado } from './_mundo'

let m: Mundo
let periodId: string
beforeAll(async () => {
  m = await crearMundo('checks')
  periodId = (await periodoCerrado(m, '2026-08-01', '2026-08-31')).id
})
afterAll(() => borrarMundo(m))

const linea = (extra: Record<string, unknown>) =>
  prisma.serviceEarning.create({
    data: {
      organizationId: m.orgId,
      venueId: m.venueId,
      periodId,
      staffId: m.ana,
      amount: new Prisma.Decimal(10),
      descriptor: {},
      ...extra,
    } as any,
  })

describe('CHECK de ServiceEarning (spec §5.6)', () => {
  it.each([
    ['SERVICE sin sourceId', { concept: 'SERVICE', sourceType: 'CLASS_SESSION' }],
    ['SERVICE sin sourceType', { concept: 'SERVICE', sourceId: 'x' }],
    ['RECONCILE sin fuente', { concept: 'RECONCILE' }],
    ['MANUAL con fuente', { concept: 'MANUAL', sourceType: 'CLASS_SESSION', sourceId: 'x' }],
    ['SERVICE negativo', { concept: 'SERVICE', sourceType: 'CLASS_SESSION', sourceId: 'x', amount: new Prisma.Decimal(-1) }],
  ])('rechaza %s', async (_n, extra) => {
    await expect(linea(extra)).rejects.toThrow()
  })
  it('acepta un MANUAL sin fuente y un RECONCILE negativo con fuente', async () => {
    await expect(linea({ concept: 'MANUAL' })).resolves.toBeDefined()
    await expect(
      linea({ concept: 'RECONCILE', sourceType: 'CLASS_SESSION', sourceId: 'x', amount: new Prisma.Decimal(-40) }),
    ).resolves.toBeDefined()
  })
})

describe('CHECK e índices de la fase 3 (spec fase 3 §6.1, §6.4, §7.1)', () => {
  it('el inicio de pago al personal es una fecha civil (DATE, sin hora ni zona)', async () => {
    const [c] = await prisma.$queryRaw<Array<{ data_type: string }>>`
      SELECT data_type FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'staffPayStartDate'`
    expect(c.data_type).toBe('date')
  })

  it('un SERVICE de comisión o de propina puede ser negativo (reverso, propina devuelta); uno de clase, no', async () => {
    const neg = (sourceType: string, sourceId: string, amount: number) =>
      linea({ concept: 'SERVICE', sourceType, sourceId: `${m.key}-${sourceId}`, amount: new Prisma.Decimal(amount) })
    await expect(neg('COMMISSION', 'c-neg', -36)).resolves.toBeDefined()
    await expect(neg('TIP', 'p-neg', -50)).resolves.toBeDefined()
    await expect(neg('CLASS_SESSION', 'k-neg', -1)).rejects.toThrow()
  })

  it('el reverso por anulación de una comisión es único por comisión y persona; los RECONCILE de clase no', async () => {
    const x = { concept: 'RECONCILE', sourceType: 'COMMISSION', sourceId: `${m.key}-c-anulada`, amount: new Prisma.Decimal(-90) }
    await linea(x)
    await expect(linea(x)).rejects.toThrow()
    const k = { concept: 'RECONCILE', sourceType: 'CLASS_SESSION', sourceId: `${m.key}-k-liq`, amount: new Prisma.Decimal(40) }
    await linea(k)
    await expect(linea(k)).resolves.toBeDefined()
  })

  it('a lo más UNA ventana de propinas abierta por organización; nunca termina antes de empezar ni sin quién la cerró', async () => {
    const ventana = (extra: Record<string, unknown> = {}) =>
      prisma.staffPayTipWindow.create({
        data: { organizationId: m.orgId, startsAt: new Date('2026-08-02T06:00:00Z'), startedById: m.owner, ...extra } as any,
      })
    await ventana()
    await expect(ventana()).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-01T06:00:00Z'), endedById: m.owner })).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-03T06:00:00Z') })).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-03T06:00:00Z'), endedById: m.owner })).resolves.toBeDefined()
  })
})
