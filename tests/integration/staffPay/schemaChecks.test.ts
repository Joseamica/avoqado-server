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
