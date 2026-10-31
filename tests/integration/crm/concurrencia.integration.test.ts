/**
 * CRM concurrency against a real Postgres (spec 2026-10-30, review focus #3): two sellers on the same account at once.
 *
 * Taking it leaves ONE owner, «Hecha» completes an activity ONCE, and two stage moves leave TWO events that tell the
 * story in order. The unit tests' global Prisma mock cannot prove any of this: the row lock, the compare-and-set and the
 * unique `sourceKey` live in the database.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://postgres:<password>@localhost:5432/avoqado_crm_test_<date>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/concurrencia.integration.test.ts --ci
 */
import type { CrmAccess } from '@/services/crm/access.service'
import { moveStage, takeAccount } from '@/services/crm/accounts.service'
import { completeActivity } from '@/services/crm/activities.service'
import { addEvent } from '@/services/crm/timeline.service'
import prisma from '@/utils/prismaClient'

const suffix = `crmc${Date.now()}`

/** Both sellers see and edit everything, so only the database decides who gets there first. */
const seller = (staffId: string): CrmAccess => ({
  staffId,
  isSuperadmin: false,
  ver: 'todos',
  editar: 'todos',
  contactar: true,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
})

const settle = <T>(results: PromiseSettledResult<T>[]) => ({
  fulfilled: results.filter(r => r.status === 'fulfilled'),
  rejected: results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason),
})

describe('CRM: two sellers on the same account at once', () => {
  let ana: string | undefined
  let beto: string | undefined
  const stageIds: string[] = []
  const accountIds: string[] = []

  beforeAll(async () => {
    ana = (await prisma.staff.create({ data: { email: `ana-${suffix}@test.mx`, firstName: 'Ana', lastName: 'Concurrencia' } })).id
    beto = (await prisma.staff.create({ data: { email: `beto-${suffix}@test.mx`, firstName: 'Beto', lastName: 'Concurrencia' } })).id
    // Stages of this file only (the names are unique), so nothing here depends on — or seeds — the shared catalog.
    for (const [name, order] of [
      [`Prospecto ${suffix}`, 1],
      [`Demo ${suffix}`, 2],
      [`Negociación ${suffix}`, 3],
    ] as const) {
      stageIds.push((await prisma.crmStage.create({ data: { name, order, kind: 'ABIERTA', staleDays: 3 } })).id)
    }
  })

  afterAll(async () => {
    // Every delete is keyed by ids this file created: a `where` with an undefined value would wipe the table.
    // Deleting the accounts cascades to their activities and timeline events.
    if (accountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: accountIds } } })
    if (stageIds.length) await prisma.crmStage.deleteMany({ where: { id: { in: stageIds } } })
    const people = [ana, beto].filter((id): id is string => !!id)
    if (people.length) await prisma.staff.deleteMany({ where: { id: { in: people } } })
  })

  async function newAccount(data: { ownerStaffId?: string } = {}) {
    const { id } = await prisma.crmAccount.create({ data: { name: `Negocio ${suffix}`, source: 'MANUAL', stageId: stageIds[0], ...data } })
    accountIds.push(id)
    return id
  }

  it('dos_toman_a_la_vez_uno_gana', async () => {
    const id = await newAccount()

    const { fulfilled, rejected } = settle(await Promise.allSettled([takeAccount(seller(ana!), id), takeAccount(seller(beto!), id)]))

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ statusCode: 409, code: 'CRM_YA_TIENE_DUENO' })
    const { ownerStaffId } = await prisma.crmAccount.findUniqueOrThrow({ where: { id } })
    expect([ana, beto]).toContain(ownerStaffId)
    const events = await prisma.crmTimelineEvent.findMany({ where: { accountId: id, kind: 'OWNER_CHANGE' }, take: 10 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorStaffId: ownerStaffId, data: { fromStaffId: null, toStaffId: ownerStaffId } })
  })

  it('dos_marcan_hecha_una_vez', async () => {
    const id = await newAccount({ ownerStaffId: ana })
    const dueAt = new Date(Date.now() + 3_600_000)
    const call = await prisma.crmActivity.create({ data: { accountId: id, type: 'LLAMADA', title: 'Llamar', dueAt, assigneeStaffId: ana } })
    await prisma.crmAccount.update({ where: { id }, data: { nextActivityAt: dueAt } })

    const { fulfilled, rejected } = settle(
      await Promise.allSettled([completeActivity(seller(ana!), call.id, {}), completeActivity(seller(beto!), call.id, {})]),
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ statusCode: 409, code: 'CRM_ACTIVIDAD_YA_HECHA' })
    const done = await prisma.crmActivity.findUniqueOrThrow({ where: { id: call.id } })
    expect(done.doneAt).not.toBeNull()
    expect([ana, beto]).toContain(done.doneById)
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: id, kind: 'ACTIVITY_DONE' } })).toBe(1)
    // Nothing else is pending: the account has no next step.
    expect((await prisma.crmAccount.findUniqueOrThrow({ where: { id } })).nextActivityAt).toBeNull()
  })

  it('dos_mueven_etapa_quedan_dos_eventos', async () => {
    const id = await newAccount({ ownerStaffId: ana })
    const [start, demo, negociacion] = stageIds

    const { fulfilled } = settle(await Promise.allSettled([moveStage(seller(ana!), id, demo), moveStage(seller(beto!), id, negociacion)]))

    expect(fulfilled).toHaveLength(2)
    const events = await prisma.crmTimelineEvent.findMany({ where: { accountId: id, kind: 'STAGE_CHANGE' }, take: 10 })
    expect(events).toHaveLength(2)
    // The two moves queued on the account's row: the second starts where the first left it (whichever won the race),
    // and the account ends where the second one put it. Not ordered by `createdAt`: two transactions may stamp the same
    // millisecond.
    const moves = events.map(event => event.data as { fromStageId: string; toStageId: string })
    const first = moves.find(move => move.fromStageId === start)!
    const second = moves.find(move => move !== first)!
    expect(first).toBeDefined()
    expect(second.fromStageId).toBe(first.toStageId)
    expect((await prisma.crmAccount.findUniqueOrThrow({ where: { id } })).stageId).toBe(second.toStageId)
  })

  it('mismo_sourceKey_no_duplica', async () => {
    const id = await newAccount()
    const event = { accountId: id, kind: 'SYSTEM' as const, actorStaffId: null, data: { probe: suffix }, sourceKey: `test:${suffix}` }

    // Two writers with the same key at once, each in its own transaction: one row, and neither transaction aborts.
    const written = await Promise.all([prisma.$transaction(tx => addEvent(tx, event)), prisma.$transaction(tx => addEvent(tx, event))])

    expect(written.filter(Boolean)).toHaveLength(1)
    expect(await prisma.crmTimelineEvent.count({ where: { sourceKey: event.sourceKey } })).toBe(1)
  })
})
