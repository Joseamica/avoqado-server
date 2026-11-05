/**
 * Activities and the timeline (spec 2026-10-30 §5.2 and §5.4, plan task 4, ruling 12).
 *
 * An activity is someone's next step on an account. The account's `nextActivityAt` is always its earliest pending one —
 * that is what the traffic light and «Mis pendientes» read — so every change recomputes it inside the same transaction.
 * Marking one done is a compare-and-set: two sellers pressing «Hecha» at once complete it ONCE. And pending activities
 * follow their account to its new owner, or to nobody when it is left «Sin dueño».
 */
import { prismaMock } from '@tests/__helpers__/setup'
import type { CrmAccess } from '@/services/crm/access.service'
import { addActivity, completeActivity, recomputeNext, rescheduleActivity } from '@/services/crm/activities.service'
import { movePendingActivitiesTx } from '@/services/crm/ownership'
import { addEvent } from '@/services/crm/timeline.service'

const SELLER = 'cstaffsel0000000000000001'
const OWNER = 'cstaffown0000000000000001'
const ACCOUNT = 'caccounta0000000000000001'
const ACCOUNT_B = 'caccountb0000000000000001'
const ACTIVITY = 'cactivity0000000000000001'
const TOMORROW = new Date('2026-11-01T17:00:00.000Z')
const NEXT_WEEK = new Date('2026-11-07T17:00:00.000Z')

const access = (over: Partial<CrmAccess> = {}): CrmAccess => ({
  staffId: SELLER,
  isSuperadmin: false,
  ver: 'propios',
  editar: 'propios',
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
  ...over,
})
const MINE_OR_UNOWNED = { OR: [{ ownerStaffId: SELLER }, { ownerStaffId: null }] }

/** The account, locked and touched by the caller's edit scope. */
function editable(over: Record<string, unknown> = {}) {
  prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.crmAccount.findUniqueOrThrow.mockResolvedValue({
    id: ACCOUNT,
    ownerStaffId: SELLER,
    stageId: 'cstageprs0000000000000001',
    stage: { id: 'cstageprs0000000000000001', name: 'Prospecto', kind: 'ABIERTA', staleDays: 2 },
    organizationId: null,
    ...over,
  })
}

/** `findFirst` answers two questions: which account the activity is on (in the caller's scope), and what is still pending. */
function activityLookup({ found, next }: { found: { accountId: string } | null; next: { dueAt: Date } | null }) {
  prismaMock.crmActivity.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? found : next))
}

const activity = (over: Record<string, unknown> = {}) => ({
  id: ACTIVITY,
  accountId: ACCOUNT,
  type: 'LLAMADA',
  title: 'Llamar para la demo',
  dueAt: TOMORROW,
  assigneeStaffId: SELLER,
  doneAt: null,
  doneById: null,
  result: null,
  ...over,
})

beforeEach(() => {
  for (const model of ['crmAccount', 'crmActivity', 'crmTimelineEvent'] as const) {
    for (const fn of Object.values(prismaMock[model]) as jest.Mock[]) fn.mockReset()
  }
  prismaMock.crmTimelineEvent.createMany.mockResolvedValue({ count: 1 })
  prismaMock.crmAccount.update.mockResolvedValue({})
})

describe('activities', () => {
  it('agendar_es_del_dueno_y_pone_la_proxima', async () => {
    // An admin schedules a call on Ana's account: the call is Ana's to make.
    editable({ ownerStaffId: OWNER })
    prismaMock.crmActivity.create.mockResolvedValue(activity({ assigneeStaffId: OWNER }))
    prismaMock.crmActivity.findFirst.mockResolvedValue({ dueAt: TOMORROW })

    await addActivity(access({ ver: 'todos', editar: 'todos', admin: true }), ACCOUNT, {
      type: 'LLAMADA',
      title: 'Llamar para la demo',
      dueAt: TOMORROW,
    })

    expect(prismaMock.crmActivity.create).toHaveBeenCalledWith({
      data: { accountId: ACCOUNT, type: 'LLAMADA', title: 'Llamar para la demo', dueAt: TOMORROW, assigneeStaffId: OWNER },
    })
    // Scheduling is a touch (the UPDATE that locks the row), and the account's next step is its earliest pending one.
    expect(prismaMock.crmAccount.updateMany).toHaveBeenCalledWith({
      where: { AND: [{ id: ACCOUNT }, {}] },
      data: { updatedAt: expect.any(Date) },
    })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({ where: { id: ACCOUNT }, data: { nextActivityAt: TOMORROW } })
    // M-2: scheduling is a change too (spec §5.10). The activity does not keep who created it, so the timeline does.
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          accountId: ACCOUNT,
          kind: 'SYSTEM',
          actorStaffId: SELLER,
          data: {
            event: 'ACTIVITY_SCHEDULED',
            activityId: ACTIVITY,
            type: 'LLAMADA',
            title: 'Llamar para la demo',
            dueAt: TOMORROW.toISOString(),
            assigneeStaffId: OWNER,
          },
        },
      ],
      skipDuplicates: true,
    })

    // On an account nobody owns yet, it belongs to whoever scheduled it.
    editable({ ownerStaffId: null })
    await addActivity(access(), ACCOUNT, { type: 'WHATSAPP', title: 'Mandar precios', dueAt: NEXT_WEEK })
    expect(prismaMock.crmActivity.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ assigneeStaffId: SELLER }) })
  })

  it('hecha_dos_veces_409', async () => {
    activityLookup({ found: { accountId: ACCOUNT }, next: null })
    editable()
    // Someone else marked it a moment ago: the compare-and-set finds it already done.
    prismaMock.crmActivity.updateMany.mockResolvedValue({ count: 0 })

    await expect(completeActivity(access(), ACTIVITY, {})).rejects.toMatchObject({ statusCode: 409, code: 'CRM_ACTIVIDAD_YA_HECHA' })
    expect(prismaMock.crmActivity.updateMany).toHaveBeenCalledWith({
      where: { id: ACTIVITY, doneAt: null },
      data: { doneAt: expect.any(Date), doneById: SELLER, result: null },
    })
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()

    // The first one to press «Hecha»: done once, written once, and the next step moves to what is left.
    prismaMock.crmActivity.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.crmActivity.findUniqueOrThrow.mockResolvedValue(activity({ doneAt: new Date(), doneById: SELLER, result: 'Agendó demo' }))
    activityLookup({ found: { accountId: ACCOUNT }, next: { dueAt: NEXT_WEEK } })

    await completeActivity(access(), ACTIVITY, { result: 'Agendó demo' })

    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          accountId: ACCOUNT,
          kind: 'ACTIVITY_DONE',
          actorStaffId: SELLER,
          data: {
            activityId: ACTIVITY,
            type: 'LLAMADA',
            title: 'Llamar para la demo',
            dueAt: TOMORROW.toISOString(),
            result: 'Agendó demo',
          },
        },
      ],
      skipDuplicates: true,
    })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({ where: { id: ACCOUNT }, data: { nextActivityAt: NEXT_WEEK } })
  })

  it('actividad_de_un_negocio_ajeno_404', async () => {
    // On an account a «propios» seller cannot see, the activity does not exist for them: the same 404 as a wrong id.
    activityLookup({ found: null, next: null })

    await expect(completeActivity(access(), ACTIVITY, {})).rejects.toMatchObject({ statusCode: 404, code: 'CRM_ACTIVITY_NOT_FOUND' })
    expect(prismaMock.crmActivity.findFirst).toHaveBeenCalledWith({
      where: { id: ACTIVITY, account: MINE_OR_UNOWNED },
      select: { accountId: true },
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.crmActivity.updateMany).not.toHaveBeenCalled()

    // Seeing everything but editing only their own: they see it, so a 403 that says why — and nothing is marked.
    activityLookup({ found: { accountId: ACCOUNT }, next: null })
    prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACCOUNT })
    await expect(completeActivity(access({ ver: 'todos' }), ACTIVITY, {})).rejects.toMatchObject({
      statusCode: 403,
      code: 'CRM_NO_ES_TUYO',
    })
    expect(prismaMock.crmActivity.updateMany).not.toHaveBeenCalled()
  })

  it('recalcular_deja_la_menor_pendiente', async () => {
    prismaMock.crmActivity.findFirst.mockResolvedValue({ dueAt: TOMORROW })
    await recomputeNext(prismaMock, ACCOUNT)
    expect(prismaMock.crmActivity.findFirst).toHaveBeenCalledWith({
      where: { accountId: ACCOUNT, doneAt: null },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      select: { dueAt: true },
    })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({ where: { id: ACCOUNT }, data: { nextActivityAt: TOMORROW } })

    // Nothing pending: no next step, so the account turns yellow.
    prismaMock.crmActivity.findFirst.mockResolvedValue(null)
    await recomputeNext(prismaMock, ACCOUNT)
    expect(prismaMock.crmAccount.update).toHaveBeenLastCalledWith({ where: { id: ACCOUNT }, data: { nextActivityAt: null } })
  })

  it('pendientes_se_mueven_con_el_negocio', async () => {
    const tx = { crmActivity: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) } }

    await movePendingActivitiesTx(tx as never, [ACCOUNT, ACCOUNT_B], OWNER)
    // Only the pending ones: a done activity keeps who did it.
    expect(tx.crmActivity.updateMany).toHaveBeenCalledWith({
      where: { accountId: { in: [ACCOUNT, ACCOUNT_B] }, doneAt: null },
      data: { assigneeStaffId: OWNER },
    })

    // To nobody when the account is left «Sin dueño»; and an empty move asks nothing.
    await movePendingActivitiesTx(tx as never, [ACCOUNT], null)
    expect(tx.crmActivity.updateMany).toHaveBeenLastCalledWith({
      where: { accountId: { in: [ACCOUNT] }, doneAt: null },
      data: { assigneeStaffId: null },
    })
    tx.crmActivity.updateMany.mockClear()
    await movePendingActivitiesTx(tx as never, [], OWNER)
    expect(tx.crmActivity.updateMany).not.toHaveBeenCalled()
  })
})

describe('timeline', () => {
  it('evento_con_sourceKey_repetido_no_duplica', async () => {
    // ON CONFLICT DO NOTHING: a repeated key adds nothing and — unlike catching P2002 — never aborts the caller's
    // transaction. The real deduplication is proven against Postgres in the concurrency integration test.
    const tx = { crmTimelineEvent: { createMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }) } }
    const event = {
      accountId: ACCOUNT,
      kind: 'ENTRY_APPLIED' as const,
      actorStaffId: null,
      data: { entryId: 'centry0000000000000000001' },
      sourceKey: 'landing:centry0000000000000000001',
    }

    await expect(addEvent(tx as never, event)).resolves.toBe(true)
    await expect(addEvent(tx as never, event)).resolves.toBe(false)
    expect(tx.crmTimelineEvent.createMany).toHaveBeenCalledWith({ data: [event], skipDuplicates: true })
  })
})

describe('reagendar (ruling 55)', () => {
  it('reagendar_mueve_la_fecha_recalcula_la_siguiente_y_deja_su_evento', async () => {
    activityLookup({ found: { accountId: ACCOUNT }, next: { dueAt: NEXT_WEEK } })
    editable()
    prismaMock.crmActivity.findUnique.mockResolvedValue(activity())
    prismaMock.crmActivity.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.crmActivity.findUniqueOrThrow.mockResolvedValue(activity({ dueAt: NEXT_WEEK }))

    await expect(rescheduleActivity(access(), ACTIVITY, { dueAt: NEXT_WEEK })).resolves.toMatchObject({ id: ACTIVITY, dueAt: NEXT_WEEK })

    // The same scope as «Hecha»: found through the caller's «Ver», then the account is locked and touched with «Editar».
    expect(prismaMock.crmActivity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ACTIVITY, account: MINE_OR_UNOWNED } }),
    )
    expect(prismaMock.crmAccount.updateMany).toHaveBeenCalledWith({
      where: { AND: [{ id: ACCOUNT }, MINE_OR_UNOWNED] },
      data: { updatedAt: expect.any(Date) },
    })
    // Only while still pending: a compare-and-set, like «Hecha».
    expect(prismaMock.crmActivity.updateMany).toHaveBeenCalledWith({ where: { id: ACTIVITY, doneAt: null }, data: { dueAt: NEXT_WEEK } })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          accountId: ACCOUNT,
          kind: 'SYSTEM',
          actorStaffId: SELLER,
          data: {
            event: 'ACTIVITY_RESCHEDULED',
            activityId: ACTIVITY,
            type: 'LLAMADA',
            title: 'Llamar para la demo',
            fromDueAt: TOMORROW.toISOString(),
            toDueAt: NEXT_WEEK.toISOString(),
          },
        },
      ],
      skipDuplicates: true,
    })
    // The account's next step is recomputed in the same transaction.
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({ where: { id: ACCOUNT }, data: { nextActivityAt: NEXT_WEEK } })
  })

  it('reagendar_una_hecha_409_y_una_ajena_404', async () => {
    activityLookup({ found: { accountId: ACCOUNT }, next: null })
    editable()
    prismaMock.crmActivity.findUnique.mockResolvedValue(activity({ doneAt: new Date(), doneById: SELLER }))

    await expect(rescheduleActivity(access(), ACTIVITY, { dueAt: NEXT_WEEK })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_ACTIVIDAD_YA_HECHA',
    })
    expect(prismaMock.crmActivity.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()

    // On an account the caller cannot see, the activity does not exist for them: the same 404 as a wrong id.
    activityLookup({ found: null, next: null })
    await expect(rescheduleActivity(access(), ACTIVITY, { dueAt: NEXT_WEEK })).rejects.toMatchObject({
      statusCode: 404,
      code: 'CRM_ACTIVITY_NOT_FOUND',
    })
  })
})
