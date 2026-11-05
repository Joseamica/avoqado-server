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
import { addNote, getPending, moveStage, takeAccount } from '@/services/crm/accounts.service'
import { completeActivity } from '@/services/crm/activities.service'
import { updateTeamMember } from '@/services/crm/teamVenue.service'
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
  cerrar: false,
  bajas: false,
  plantillas: false,
  preparar: false,
  mandar: false,
  verCampanas: false,
  equipo: false,
  configurar: false,
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
  const accessIds: string[] = []

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
    if (accessIds.length) await prisma.platformAccess.deleteMany({ where: { id: { in: accessIds } } })
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

  it('un_toque_nunca_retrocede (ruling 65 e, Codex exhaustiva #10): a note that waited for the lock leaves the later touch', async () => {
    const id = await newAccount({ ownerStaffId: ana })
    // Another writer holds the row and touches it later than the note will (a landing form, in the real world).
    const later = new Date(Date.now() + 60_000)
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>(resolve => (locked = resolve))
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "CrmAccount" WHERE "id" = ${id} FOR UPDATE`
      await tx.crmAccount.update({ where: { id }, data: { lastTouchAt: later } })
      locked()
      await released
    })
    await isLocked

    // The note takes its «now» and then waits for that lock.
    const note = addNote(seller(ana!), id, { text: 'Llamé' })
    await new Promise(resolve => setTimeout(resolve, 300))
    release()
    await holder
    await note

    expect((await prisma.crmAccount.findUniqueOrThrow({ where: { id } })).lastTouchAt).toEqual(later)
  })

  it('mismo_sourceKey_no_duplica', async () => {
    const id = await newAccount()
    const event = { accountId: id, kind: 'SYSTEM' as const, actorStaffId: null, data: { probe: suffix }, sourceKey: `test:${suffix}` }

    // Two writers with the same key at once, each in its own transaction: one row, and neither transaction aborts.
    const written = await Promise.all([prisma.$transaction(tx => addEvent(tx, event)), prisma.$transaction(tx => addEvent(tx, event))])

    expect(written.filter(Boolean)).toHaveLength(1)
    expect(await prisma.crmTimelineEvent.count({ where: { sourceKey: event.sourceKey } })).toBe(1)
  })

  it('dos_admins_cambian_llaves_a_la_vez_uno_gana (ruling 60)', async () => {
    // Carla, a default seller. Both admins opened her keys at the same time and saw the same thing.
    const carla = await prisma.platformAccess.create({
      data: { email: `carla-${suffix}@test.mx`, verScope: 'propios', editarScope: 'propios', contactar: true, createdById: ana! },
    })
    accessIds.push(carla.id)
    // Las 13 de la pantalla nueva (plan 2026-11-04, L10), como las vio: Carla aún no cierra (su fila nació sin `cerrar`).
    const seen = {
      ver: 'propios',
      editar: 'propios',
      cerrar: false,
      contactar: true,
      exportar: false,
      ventas: false,
      bajas: false,
      plantillas: false,
      preparar: false,
      mandar: false,
      verCampanas: false,
      equipo: false,
      configurar: false,
    } as const
    const admin = (staffId: string): CrmAccess => ({
      ...seller(staffId),
      campanas: true,
      exportar: true,
      ventas: true,
      admin: true,
      plantillas: true,
      preparar: true,
      mandar: true,
      verCampanas: true,
      equipo: true,
      configurar: true,
      bajas: true,
    })

    const { fulfilled, rejected } = settle(
      await Promise.allSettled([
        updateTeamMember(admin(ana!), carla.id, { ...seen, ventas: true }, seen),
        updateTeamMember(admin(beto!), carla.id, { ...seen, exportar: true }, seen),
      ]),
    )

    // One lands; the other one learns her keys changed, instead of silently undoing the first.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ statusCode: 409, code: 'CRM_LLAVES_CAMBIARON' })
    const stored = await prisma.platformAccess.findUniqueOrThrow({ where: { id: carla.id } })
    expect([stored.ventas, stored.exportar].sort()).toEqual([false, true])
  })

  it('mi_actividad_es_la_mia_aunque_otro_tenga_la_mas_temprana (ruling 61)', async () => {
    // Nobody owns it yet: Beto scheduled the earliest call; Ana owes two (and finished an even older one).
    const id = await newAccount()
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000)
    const activity = (title: string, assigneeStaffId: string, dueAt: Date, doneAt: Date | null = null) =>
      prisma.crmActivity.create({ data: { accountId: id, type: 'LLAMADA', title, dueAt, assigneeStaffId, doneAt } })
    const betos = await activity('De Beto', beto!, ago(3))
    await activity('Ya hecha', ana!, ago(4), ago(4))
    const anas = await activity('Primera de Ana', ana!, ago(2))
    await activity('Segunda de Ana', ana!, ago(1))
    await prisma.crmAccount.update({ where: { id }, data: { nextActivityAt: betos.dueAt } })

    const pending = await getPending(seller(ana!), new Date())

    const row = pending.vencidas.rows.find(r => r.id === id)
    expect(row).toMatchObject({
      nextActivity: { id: betos.id },
      miActividad: { id: anas.id, type: 'LLAMADA', title: 'Primera de Ana', dueAt: anas.dueAt },
    })
  })
})
