/**
 * The CRM's accounts (spec 2026-10-30 §5.2–5.4, plan task 4): the pipeline, its traffic light, «Estancado», losing and
 * winning, «Mis pendientes», duplicates, the organization search and the stage admin.
 *
 * What these pin, beyond the happy path: a «propios» seller never learns that someone else's account exists (404, not
 * 403); the server — not the client — caps every list and says the real total; «today» is Mexico City's day, never the
 * server's; and an admin who renames «Prospecto» never gets it back on the next deploy.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { updateStageSchema } from '@/schemas/crm.schema'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { CrmAccess } from '@/services/crm/access.service'
import {
  addNote,
  createLostReason,
  createManual,
  createStage,
  ensureCrmDefaults,
  estancadoDias,
  findDuplicates,
  getAccount,
  getPending,
  listAccounts,
  lose,
  moveStage,
  reassign,
  searchOrganizations,
  semaforo,
  updateStage,
  win,
} from '@/services/crm/accounts.service'

const SELLER = 'cstaffsel0000000000000001'
const OTHER = 'cstaffoth0000000000000001'
const ACCOUNT = 'caccounta0000000000000001'
const ACCOUNT_B = 'caccountb0000000000000001'
const ACCOUNT_C = 'caccountc0000000000000001'
const NEW_ACCOUNT = 'caccountn0000000000000001'
const PROSPECTO = 'cstageprs0000000000000001'
const DEMO = 'cstagedem0000000000000001'
const GANADO = 'cstagegan0000000000000001'
const PERDIDO = 'cstageper0000000000000001'
const REASON = 'creasonpr0000000000000001'
const ORG = 'corgclient000000000000001'
const ORG_2 = 'corgclient000000000000002'
const TEAM_ORG = 'corgteam00000000000000001'

// Noon in Mexico City on 31-oct-2026 (UTC-6 all year since 2022). «Today» there runs 06:00Z → 05:59:59.999Z next day.
const NOW = new Date('2026-10-31T18:00:00.000Z')
const START_OF_TODAY = new Date('2026-10-31T06:00:00.000Z')
const END_OF_TODAY = new Date('2026-11-01T05:59:59.999Z')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

/** The caller's EFFECTIVE keys, as `requireCrm` leaves them. Default: a seller who sees and edits their own. */
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

/** What `scopeWhere(access(), …)` filters by: mine plus the unowned. */
const MINE_OR_UNOWNED = { OR: [{ ownerStaffId: SELLER }, { ownerStaffId: null }] }
const LIVE = { archivedAt: null, stage: { kind: 'ABIERTA' } }

const stage = (over: Record<string, unknown> = {}) => ({ id: PROSPECTO, name: 'Prospecto', kind: 'ABIERTA', staleDays: 2, ...over })

/** An account as the services read it. */
const account = (over: Record<string, unknown> = {}) => ({
  id: ACCOUNT,
  name: 'Café Tlalpan',
  giro: 'Cafetería',
  ventasRango: 'Menos de $150 mil',
  source: 'WHATSAPP',
  ownerStaffId: SELLER,
  owner: { id: SELLER, firstName: 'Luis', lastName: 'Ramírez' },
  stageId: PROSPECTO,
  stage: stage(),
  nextActivityAt: null,
  lastTouchAt: daysAgo(1),
  firstMoneyAt: null,
  organizationId: null,
  archivedAt: null,
  createdAt: daysAgo(3),
  ...over,
})

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`organizationId`)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['organizationId'] },
  })

/** Neither catalog table is empty: nothing gets seeded. */
function seeded() {
  prismaMock.crmStage.count.mockResolvedValue(7)
  prismaMock.crmLostReason.count.mockResolvedValue(5)
}

/** The account is in the caller's edit scope: the touch UPDATE (which also locks its row) matches it. */
function editable(state: Record<string, unknown> = account()) {
  prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.crmAccount.findUniqueOrThrow.mockResolvedValue(state)
}

const MODELS = [
  'crmAccount',
  'crmStage',
  'crmLostReason',
  'crmActivity',
  'crmTimelineEvent',
  'crmContact',
  'crmTeam',
  'organization',
  'staff',
  'staffVenue',
  'platformAccess',
  'crmEmailMessage',
  'crmEmailConsent',
] as const

beforeEach(() => {
  // The global mock keeps a `mockResolvedValue` from one test to the next: start every test from scratch.
  for (const model of MODELS) for (const fn of Object.values(prismaMock[model]) as jest.Mock[]) fn.mockReset()
  prismaMock.$queryRaw.mockReset()
  prismaMock.crmTimelineEvent.createMany.mockResolvedValue({ count: 1 })
  prismaMock.crmActivity.findMany.mockResolvedValue([])
  prismaMock.crmActivity.updateMany.mockResolvedValue({ count: 0 })
  prismaMock.crmStage.findMany.mockResolvedValue([])
  prismaMock.crmAccount.update.mockResolvedValue({})
  prismaMock.crmEmailMessage.findMany.mockResolvedValue([])
  prismaMock.crmEmailConsent.findMany.mockResolvedValue([])
})

describe('traffic light and «Estancado»', () => {
  it('semaforo_rojo_verde_gris_amarillo', () => {
    // The last millisecond of yesterday in Mexico City is overdue; the first of today is not.
    expect(semaforo({ nextActivityAt: new Date('2026-10-31T05:59:59.999Z') }, NOW)).toBe('rojo')
    expect(semaforo({ nextActivityAt: START_OF_TODAY }, NOW)).toBe('verde')
    expect(semaforo({ nextActivityAt: END_OF_TODAY }, NOW)).toBe('verde')
    expect(semaforo({ nextActivityAt: new Date('2026-11-01T06:00:00.000Z') }, NOW)).toBe('gris')
    expect(semaforo({ nextActivityAt: null }, NOW)).toBe('amarillo')
    // 21:00 in Mexico City is already tomorrow in UTC: a call due at 14:00 Mexico City is still today, not overdue.
    expect(semaforo({ nextActivityAt: new Date('2026-10-31T20:00:00.000Z') }, new Date('2026-11-01T03:00:00.000Z'))).toBe('verde')
  })

  it('estancado_cuenta_desde_el_ultimo_toque', async () => {
    const contacto = { kind: 'ABIERTA', staleDays: 3 }
    // In the stage for 10 days, but someone wrote a note yesterday: not stale.
    expect(estancadoDias({ lastTouchAt: daysAgo(1) }, contacto, NOW)).toBeNull()
    // 4 days without a touch in a 3-day stage: «Estancado · 4 días». Exactly 3 is not «more than 3» yet.
    expect(estancadoDias({ lastTouchAt: daysAgo(4) }, contacto, NOW)).toBe(4)
    expect(estancadoDias({ lastTouchAt: daysAgo(3) }, contacto, NOW)).toBeNull()
    // Won, lost or archived accounts never go stale, and neither does a stage without a limit.
    expect(estancadoDias({ lastTouchAt: daysAgo(30) }, { kind: 'GANADA', staleDays: 3 }, NOW)).toBeNull()
    expect(estancadoDias({ lastTouchAt: daysAgo(30), archivedAt: daysAgo(1) }, contacto, NOW)).toBeNull()
    expect(estancadoDias({ lastTouchAt: daysAgo(30) }, { kind: 'ABIERTA', staleDays: null }, NOW)).toBeNull()

    // A note is a touch: the UPDATE that locks the row checks the scope, and the next one moves `lastTouchAt` — only
    // forward, never back (ruling 65 e).
    editable()
    await addNote(access(), ACCOUNT, { text: 'Tiene 2 consultorios' })
    expect(prismaMock.crmAccount.updateMany).toHaveBeenNthCalledWith(1, {
      where: { AND: [{ id: ACCOUNT }, MINE_OR_UNOWNED] },
      data: { updatedAt: expect.any(Date) },
    })
    const [[lock], [touch]] = prismaMock.crmAccount.updateMany.mock.calls
    expect(touch).toEqual({ where: { id: ACCOUNT, lastTouchAt: { lt: lock.data.updatedAt } }, data: { lastTouchAt: lock.data.updatedAt } })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [{ accountId: ACCOUNT, kind: 'NOTE', actorStaffId: SELLER, data: { text: 'Tiene 2 consultorios' } }],
      skipDuplicates: true,
    })

    // The «estancados» filter asks the database the same question, stage by stage.
    prismaMock.crmStage.findMany.mockResolvedValue([
      { id: PROSPECTO, staleDays: 2 },
      { id: DEMO, staleDays: 5 },
    ])
    prismaMock.crmAccount.findMany.mockResolvedValue([])
    prismaMock.crmAccount.count.mockResolvedValue(0)
    await listAccounts(access(), { estancados: true }, NOW)
    expect(prismaMock.crmStage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: 'ABIERTA', staleDays: { gt: 0 } } }))
    const { where } = prismaMock.crmAccount.findMany.mock.calls[0][0]
    expect(where.AND).toContainEqual(LIVE)
    expect(where.AND).toContainEqual({
      OR: [
        { stageId: PROSPECTO, lastTouchAt: { lt: daysAgo(2) } },
        { stageId: DEMO, lastTouchAt: { lt: daysAgo(5) } },
      ],
    })
  })
})

describe('losing and winning', () => {
  const perdido = stage({ id: PERDIDO, name: 'Perdido', kind: 'PERDIDA', staleDays: null })
  const ganado = stage({ id: GANADO, name: 'Ganado', kind: 'GANADA', staleDays: null })

  it('perder_sin_motivo_422', async () => {
    await expect(lose(access(), ACCOUNT, {})).rejects.toMatchObject({ statusCode: 422, code: 'CRM_FALTA_MOTIVO' })

    // A reason that was turned off is no reason either.
    seeded()
    prismaMock.crmStage.findFirst.mockResolvedValue(perdido)
    prismaMock.crmLostReason.findUnique.mockResolvedValue({ id: REASON, name: 'Precio', active: false })
    await expect(lose(access(), ACCOUNT, { lostReasonId: REASON })).rejects.toMatchObject({ statusCode: 422, code: 'CRM_MOTIVO_INVALIDO' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()

    // With a reason: «Perdido», why and the note stay, and the timeline says so once.
    prismaMock.crmLostReason.findUnique.mockResolvedValue({ id: REASON, name: 'Precio', active: true })
    editable()
    await lose(access(), ACCOUNT, { lostReasonId: REASON, note: 'Se fue con otra terminal' })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT },
      data: {
        stageId: PERDIDO,
        stageEnteredAt: expect.any(Date),
        lostReasonId: REASON,
        lostNote: 'Se fue con otra terminal',
        lostAt: expect.any(Date),
        wonAt: null,
      },
    })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          accountId: ACCOUNT,
          kind: 'LOST',
          actorStaffId: SELLER,
          data: { fromStageId: PROSPECTO, lostReasonId: REASON, lostReasonName: 'Precio', note: 'Se fue con otra terminal' },
        },
      ],
      skipDuplicates: true,
    })
  })

  it('ganar_dos_veces_la_misma_org_409', async () => {
    seeded()
    prismaMock.crmStage.findFirst.mockResolvedValue(ganado)
    editable(account({ id: ACCOUNT_B }))
    prismaMock.organization.findUnique.mockResolvedValue({ id: ORG, name: 'Café Tlalpan SA de CV' })
    prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })

    // Account A already holds that Organization: one CRM account per Organization.
    prismaMock.crmAccount.findUnique.mockResolvedValue({ id: ACCOUNT })
    await expect(win(access(), ACCOUNT_B, { organizationId: ORG })).rejects.toMatchObject({ statusCode: 409, code: 'CRM_ORG_YA_LIGADA' })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()

    // Two wins at the same time both pass that check: the unique index refuses the second one — the same 409, not a 500.
    prismaMock.crmAccount.findUnique.mockResolvedValue(null)
    prismaMock.crmAccount.update.mockRejectedValueOnce(uniqueViolation())
    await expect(win(access(), ACCOUNT_B, { organizationId: ORG })).rejects.toMatchObject({ statusCode: 409, code: 'CRM_ORG_YA_LIGADA' })

    // Winning links it, closes it as «Ganado» and says both things in the timeline.
    prismaMock.crmTimelineEvent.createMany.mockClear()
    await win(access(), ACCOUNT_B, { organizationId: ORG })
    expect(prismaMock.crmAccount.update).toHaveBeenLastCalledWith({
      where: { id: ACCOUNT_B },
      data: {
        organizationId: ORG,
        stageId: GANADO,
        stageEnteredAt: expect.any(Date),
        wonAt: expect.any(Date),
        lostAt: null,
        lostReasonId: null,
        lostNote: null,
      },
    })
    expect(
      prismaMock.crmTimelineEvent.createMany.mock.calls.map(([args]: [{ data: Array<{ kind: string }> }]) => args.data[0].kind),
    ).toEqual(['LINKED', 'WON'])

    // The sales team's own organization is never anybody's client.
    await expect(win(access(), ACCOUNT_B, { organizationId: TEAM_ORG })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CRM_ORGANIZACION_NO_EXISTE',
    })
    // And without an Organization there is nothing to win.
    await expect(win(access(), ACCOUNT_B, {})).rejects.toMatchObject({ statusCode: 422, code: 'CRM_FALTA_ORGANIZACION' })
  })

  it('ganar_reinicia_el_primer_cobro_de_la_organizacion_anterior (Codex exhaustiva #13, ruling 65 g)', async () => {
    seeded()
    prismaMock.crmStage.findFirst.mockResolvedValue(ganado)
    // Its Organization was deleted (`SetNull`): unlinked, but still with the old one's first money.
    const old = new Date('2026-09-01T18:00:00.000Z')
    editable(account({ id: ACCOUNT_B, organizationId: null, firstMoneyAt: old, firstMoneySource: 'PAGO' }))
    prismaMock.organization.findUnique.mockResolvedValue({ id: ORG, name: 'Café Tlalpan SA de CV' })
    prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })
    prismaMock.crmAccount.findUnique.mockResolvedValue(null)

    await win(access(), ACCOUNT_B, { organizationId: ORG })

    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT_B },
      data: { firstMoneyAt: null, firstMoneySource: null },
    })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          accountId: ACCOUNT_B,
          kind: 'SYSTEM',
          actorStaffId: SELLER,
          data: { event: 'FIRST_MONEY_RESET', previousAt: old.toISOString(), previousSource: 'PAGO', organizationId: ORG },
        },
      ],
      skipDuplicates: true,
    })
  })

  it('ganar_sin_dueno_queda_a_nombre_de_quien_gana (I-3, ruling 52): one owner per sale, like Pipedrive', async () => {
    seeded()
    prismaMock.crmStage.findFirst.mockResolvedValue(ganado)
    // A landing account: nobody owns it yet and it is already linked, so «Ganar» is one click.
    editable(account({ ownerStaffId: null, owner: null, organizationId: ORG }))

    await win(access(), ACCOUNT, {})

    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT },
      data: expect.objectContaining({ ownerStaffId: SELLER, stageId: GANADO, wonAt: expect.any(Date) }),
    })
    // Its pending activities go with it, and the timeline says who took it before saying it was won.
    expect(prismaMock.crmActivity.updateMany).toHaveBeenCalledWith({
      where: { accountId: { in: [ACCOUNT] }, doneAt: null },
      data: { assigneeStaffId: SELLER },
    })
    const events: Array<Record<string, unknown>> = prismaMock.crmTimelineEvent.createMany.mock.calls.map(
      ([args]: [{ data: Array<Record<string, unknown>> }]) => args.data[0],
    )
    expect(events.map(event => event.kind)).toEqual(['OWNER_CHANGE', 'WON'])
    expect(events[0]).toMatchObject({ actorStaffId: SELLER, data: { fromStaffId: null, toStaffId: SELLER, reason: 'TAKEN' } })

    // Someone's account keeps its owner: no owner change.
    prismaMock.crmAccount.update.mockClear()
    prismaMock.crmActivity.updateMany.mockClear()
    prismaMock.crmTimelineEvent.createMany.mockClear()
    editable(account({ organizationId: ORG }))
    await win(access(), ACCOUNT, {})
    expect(prismaMock.crmAccount.update.mock.calls[0][0].data).not.toHaveProperty('ownerStaffId')
    expect(prismaMock.crmActivity.updateMany).not.toHaveBeenCalled()
    expect(
      prismaMock.crmTimelineEvent.createMany.mock.calls.map(([args]: [{ data: Array<{ kind: string }> }]) => args.data[0].kind),
    ).toEqual(['WON'])
  })

  it('etapa_esperada_cambio_409: a move or a loss that expected another stage reopens nothing', async () => {
    seeded()
    const demo = stage({ id: DEMO, name: 'Demo', staleDays: 5 })
    prismaMock.crmStage.findUnique.mockResolvedValue(demo)
    prismaMock.crmStage.findFirst.mockResolvedValue(perdido)
    prismaMock.crmLostReason.findUnique.mockResolvedValue({ id: REASON, name: 'Precio', active: true })

    // Someone won it while the routine was deciding: it expected «Prospecto», it is «Ganado» now.
    editable(account({ stageId: GANADO, stage: ganado }))
    await expect(moveStage(access(), ACCOUNT, DEMO, PROSPECTO)).rejects.toMatchObject({ statusCode: 409, code: 'CRM_ETAPA_CAMBIO' })
    await expect(lose(access(), ACCOUNT, { lostReasonId: REASON, expectedStageId: PROSPECTO })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_ETAPA_CAMBIO',
    })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()

    // REGRESSION — without an expected stage (the screen's route) it behaves as before: moving a won account reopens it.
    await moveStage(access(), ACCOUNT, DEMO)
    expect(prismaMock.crmAccount.update).toHaveBeenLastCalledWith({
      where: { id: ACCOUNT },
      data: { stageId: DEMO, stageEnteredAt: expect.any(Date), wonAt: null, lostAt: null, lostReasonId: null, lostNote: null },
    })

    // And the stage it expected is the stage it has: it moves.
    editable(account())
    await moveStage(access(), ACCOUNT, DEMO, PROSPECTO)
    expect(prismaMock.crmAccount.update).toHaveBeenLastCalledWith({
      where: { id: ACCOUNT },
      data: { stageId: DEMO, stageEnteredAt: expect.any(Date) },
    })
  })
})

describe('who sees and changes what', () => {
  it('propios_no_ve_ajenos_ni_puede_moverlos', async () => {
    // Someone else's account does not exist for a «propios» seller: 404, never 403.
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    await expect(getAccount(access(), ACCOUNT)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_ACCOUNT_NOT_FOUND' })
    expect(prismaMock.crmAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ id: ACCOUNT }, MINE_OR_UNOWNED] } }),
    )

    // Nor can they move it: the touch carries the edit scope and matches nothing — no change, no event.
    prismaMock.crmStage.findUnique.mockResolvedValue(stage({ id: DEMO, name: 'Demo', staleDays: 5 }))
    prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 0 })
    await expect(moveStage(access(), ACCOUNT, DEMO)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_ACCOUNT_NOT_FOUND' })
    expect(prismaMock.crmAccount.updateMany).toHaveBeenCalledWith({
      where: { AND: [{ id: ACCOUNT }, MINE_OR_UNOWNED] },
      data: { updatedAt: expect.any(Date) },
    })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()

    // The list filters by the same scope, in the database, and counts with the very same filter.
    prismaMock.crmAccount.findMany.mockResolvedValue([])
    prismaMock.crmAccount.count.mockResolvedValue(0)
    await listAccounts(access(), {}, NOW)
    const listed = prismaMock.crmAccount.findMany.mock.calls[0][0].where
    expect(listed.AND[0]).toEqual(MINE_OR_UNOWNED)
    expect(prismaMock.crmAccount.count).toHaveBeenCalledWith({ where: listed })

    // Seeing everything but editing only their own: the account IS visible, so the answer is a 403 that says why.
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACCOUNT })
    await expect(moveStage(access({ ver: 'todos' }), ACCOUNT, DEMO)).rejects.toMatchObject({ statusCode: 403, code: 'CRM_NO_ES_TUYO' })

    // Ganado and Perdido are not dragged into: they ask for an Organization or a reason.
    prismaMock.crmStage.findUnique.mockResolvedValue(stage({ id: GANADO, name: 'Ganado', kind: 'GANADA', staleDays: null }))
    await expect(moveStage(access(), ACCOUNT, GANADO)).rejects.toMatchObject({ statusCode: 422, code: 'CRM_USA_GANAR' })
    prismaMock.crmStage.findUnique.mockResolvedValue(stage({ id: PERDIDO, name: 'Perdido', kind: 'PERDIDA', staleDays: null }))
    await expect(moveStage(access(), ACCOUNT, PERDIDO)).rejects.toMatchObject({ statusCode: 422, code: 'CRM_USA_PERDER' })
  })

  it('duplicado_de_otro_dueno_solo_dice_su_nombre', async () => {
    prismaMock.crmAccount.findMany.mockResolvedValue([
      account({ id: ACCOUNT, name: 'Café Tlalpan', ownerStaffId: OTHER, owner: { id: OTHER, firstName: 'Ana', lastName: 'López' } }),
      account({ id: ACCOUNT_B, name: 'Café Tlalpan Sur', ownerStaffId: null, owner: null }),
      account({ id: ACCOUNT_C, name: 'Café de Luis' }),
    ])

    // Someone else's account says only whose it is: not its id, not its name.
    await expect(findDuplicates(access(), { phone: '55 1234 5678', email: ' Dueno@Cafe.MX ' })).resolves.toEqual([
      { ownerName: 'Ana López' },
      { id: ACCOUNT_B, name: 'Café Tlalpan Sur', ownerName: null },
      { id: ACCOUNT_C, name: 'Café de Luis', ownerName: 'Luis Ramírez' },
    ])
    // Looked up by the stored shapes — E.164 phone, email in any case — and capped.
    expect(prismaMock.crmAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contacts: {
            some: { OR: [{ phoneE164: '+525512345678' }, { email: { equals: 'dueno@cafe.mx', mode: 'insensitive' } }] },
          },
        },
        take: 10,
      }),
    )
    // With «todos» nothing is hidden.
    await expect(findDuplicates(access({ ver: 'todos' }), { phone: '5512345678' })).resolves.toContainEqual({
      id: ACCOUNT,
      name: 'Café Tlalpan',
      ownerName: 'Ana López',
    })
    // Nothing to compare with, nothing to look up.
    prismaMock.crmAccount.findMany.mockClear()
    await expect(findDuplicates(access(), {})).resolves.toEqual([])
    expect(prismaMock.crmAccount.findMany).not.toHaveBeenCalled()

    // Creating by hand stops on the same list, until the seller says «es otro negocio».
    const input = { name: 'Café Tlalpan', contact: { name: 'Paola Méndez', phone: '55 1234 5678' } }
    await expect(createManual(access(), input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_POSIBLE_DUPLICADO',
      details: { duplicates: expect.arrayContaining([{ ownerName: 'Ana López' }]) },
    })
    expect(prismaMock.crmAccount.create).not.toHaveBeenCalled()

    seeded()
    prismaMock.crmStage.findFirst.mockResolvedValue(stage())
    prismaMock.crmAccount.create.mockResolvedValue({ id: NEW_ACCOUNT })
    prismaMock.crmAccount.findUniqueOrThrow.mockResolvedValue(account({ id: NEW_ACCOUNT }))
    await createManual(access(), input, { confirmarOtroNegocio: true })
    expect(prismaMock.crmAccount.create).toHaveBeenCalledWith({
      data: {
        name: 'Café Tlalpan',
        giro: null,
        ventasRango: null,
        sucursales: null,
        source: 'MANUAL',
        referidoPor: null,
        ownerStaffId: SELLER,
        stageId: PROSPECTO,
        contacts: { create: [{ name: 'Paola Méndez', phoneE164: '+525512345678', email: null, role: null, isPrimary: true }] },
      },
      select: { id: true },
    })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [{ accountId: NEW_ACCOUNT, kind: 'SYSTEM', actorStaffId: SELLER, data: { event: 'CREATED', source: 'MANUAL' } }],
      skipDuplicates: true,
    })

    // What the seller qualified is newer than any landing form still pending for this person (ruling 65 e).
    prismaMock.crmAccount.create.mockClear()
    await createManual(access(), { ...input, giro: 'Cafetería' }, { confirmarOtroNegocio: true })
    expect(prismaMock.crmAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ giro: 'Cafetería', qualifiedAt: expect.any(Date) }) }),
    )
  })

  it('reasignar_sin_todos_ni_admin_403', async () => {
    await expect(reassign(access(), ACCOUNT, OTHER)).rejects.toMatchObject({ statusCode: 403, code: 'CRM_NO_PUEDE_REASIGNAR' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()

    // Ana is on the team with «Ver negocios», so she can own accounts.
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'ana@avoqado.io', active: true, emailVerified: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000001',
      staffId: OTHER,
      verScope: 'propios',
      editarScope: 'propios',
      contactar: true,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
    })
    editable()
    // They see it (`ver: todos`): the answer is the whole row.
    prismaMock.crmAccount.findFirst.mockResolvedValue(account())

    // «Editar: todos» may: the owner changes, its pending activities go with it (ruling 12), one OWNER_CHANGE.
    await reassign(access({ ver: 'todos', editar: 'todos' }), ACCOUNT, OTHER)
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({ where: { id: ACCOUNT }, data: { ownerStaffId: OTHER } })
    expect(prismaMock.crmActivity.updateMany).toHaveBeenCalledWith({
      where: { accountId: { in: [ACCOUNT] }, doneAt: null },
      data: { assigneeStaffId: OTHER },
    })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          accountId: ACCOUNT,
          kind: 'OWNER_CHANGE',
          actorStaffId: SELLER,
          data: { fromStaffId: SELLER, toStaffId: OTHER, reason: 'REASSIGNED' },
        },
      ],
      skipDuplicates: true,
    })
    // The owner decides which «propios» sellers see it: an access change, so the audit trail has it too.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CRM_ACCOUNT_REASSIGNED',
        entity: 'CrmAccount',
        entityId: ACCOUNT,
        staffId: SELLER,
        data: { fromStaffId: SELLER, toStaffId: OTHER },
      }),
    )

    // Back to nobody: its pending activities are left without anyone in charge too.
    await reassign(access({ ver: 'todos', editar: 'todos' }), ACCOUNT, null)
    expect(prismaMock.crmActivity.updateMany).toHaveBeenLastCalledWith({
      where: { accountId: { in: [ACCOUNT] }, doneAt: null },
      data: { assigneeStaffId: null },
    })

    // An admin may as well, even without «Editar: todos».
    await expect(reassign(access({ admin: true }), ACCOUNT, OTHER)).resolves.toBeDefined()

    // Only to someone on the team.
    prismaMock.platformAccess.findUnique.mockResolvedValue(null)
    await expect(reassign(access({ admin: true }), ACCOUNT, OTHER)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CRM_REASSIGN_TARGET_INVALID',
    })
  })

  it('reasignar_a_quien_solo_ve_422 (m-3, ruling 52): the new owner must be able to edit, or the accounts freeze', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'ana@avoqado.io', active: true, emailVerified: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000001',
      staffId: OTHER,
      verScope: 'todos',
      editarScope: null,
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
    })

    await expect(reassign(access({ admin: true }), ACCOUNT, OTHER)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CRM_REASSIGN_TARGET_INVALID',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('reasignar_sin_ver_solo_dice_el_nuevo_dueno', async () => {
    // M-1: an admin of the team without «Ver negocios» reassigns (from «Equipo de ventas»), but never sees the account:
    // the answer says who owns it now, and nothing about the account itself.
    prismaMock.staff.findUnique.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) =>
      select?.firstName
        ? { id: OTHER, firstName: 'Ana', lastName: 'López' }
        : { email: 'ana@avoqado.io', active: true, emailVerified: true },
    )
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000001',
      staffId: OTHER,
      verScope: 'propios',
      editarScope: 'propios',
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
    })
    editable()
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    const adminWithoutVer = access({ ver: null, editar: null, admin: true })

    await expect(reassign(adminWithoutVer, ACCOUNT, OTHER)).resolves.toEqual({ id: ACCOUNT, owner: { id: OTHER, name: 'Ana López' } })
    // The account is read back with THEIR «ver» scope, which for them matches nothing.
    expect(prismaMock.crmAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ id: ACCOUNT }, { id: { in: [] } }] } }),
    )
    await expect(reassign(adminWithoutVer, ACCOUNT, null)).resolves.toEqual({ id: ACCOUNT, owner: null })

    // Whoever sees it gets the whole row, as always.
    prismaMock.crmAccount.findFirst.mockResolvedValue(
      account({ ownerStaffId: OTHER, owner: { id: OTHER, firstName: 'Ana', lastName: 'López' } }),
    )
    await expect(reassign(access({ ver: 'todos', editar: 'todos' }), ACCOUNT, OTHER)).resolves.toMatchObject({
      id: ACCOUNT,
      name: 'Café Tlalpan',
      owner: { id: OTHER, name: 'Ana López' },
      stage: { id: PROSPECTO, kind: 'ABIERTA' },
    })
  })
})

describe('lists', () => {
  it('sin_dueno_solo_etapas_abiertas (m-6, ruling 52): won and lost accounts without an owner are history, not work', async () => {
    prismaMock.crmAccount.findMany.mockResolvedValue([])
    prismaMock.crmAccount.count.mockResolvedValue(0)

    await listAccounts(access(), { sinDueno: true }, NOW)

    const { where } = prismaMock.crmAccount.findMany.mock.calls[0][0]
    expect(where.AND).toContainEqual({ ownerStaffId: null, stage: { kind: 'ABIERTA' } })
    expect(prismaMock.crmAccount.count).toHaveBeenCalledWith({ where })
  })

  it('lista_tope_100_y_total', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `caccount${String(i).padStart(16, '0')}`)
    prismaMock.crmAccount.findMany.mockResolvedValue(ids.map(id => account({ id })))
    prismaMock.crmAccount.count.mockResolvedValue(935)

    // A hostile limit is clamped by the server; one row more tells whether there is a next page.
    const page = await listAccounts(access({ ver: 'todos' }), { limit: 500 }, NOW)
    expect(prismaMock.crmAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    )
    expect(page.rows).toHaveLength(100)
    expect(page.total).toBe(935)
    expect(page.nextCursor).toBe(ids[99])
    expect(page.rows[0]).toMatchObject({
      id: ids[0],
      owner: { id: SELLER, name: 'Luis Ramírez' },
      stage: { id: PROSPECTO, name: 'Prospecto', kind: 'ABIERTA' },
      semaforo: 'amarillo',
      estancadoDias: null,
      nextActivity: null,
    })

    // The next page starts after the cursor.
    prismaMock.crmAccount.findMany.mockResolvedValue(ids.slice(0, 20).map(id => account({ id })))
    const last = await listAccounts(access({ ver: 'todos' }), { cursor: ids[99], limit: 20 }, NOW)
    expect(prismaMock.crmAccount.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { id: ids[99] }, skip: 1, take: 21 }))
    expect(last.nextCursor).toBeNull()

    // Archived accounts leave the pipeline, but a search still finds them.
    expect(prismaMock.crmAccount.findMany.mock.calls[0][0].where.AND).toContainEqual({ archivedAt: null })
    await listAccounts(access({ ver: 'todos' }), { q: 'tlalpan' }, NOW)
    expect(prismaMock.crmAccount.findMany.mock.lastCall![0].where.AND).not.toContainEqual({ archivedAt: null })

    // The next step of every row, in ONE query for the whole page.
    const due = new Date('2026-11-02T16:00:00.000Z')
    prismaMock.crmAccount.findMany.mockResolvedValue([account({ nextActivityAt: due })])
    prismaMock.crmActivity.findMany.mockResolvedValue([
      { id: 'cactivity0000000000000001', accountId: ACCOUNT, type: 'LLAMADA', title: 'Llamar', dueAt: due, assigneeStaffId: SELLER },
    ])
    const [row] = (await listAccounts(access({ ver: 'todos' }), {}, NOW)).rows
    expect(row).toMatchObject({ semaforo: 'gris', nextActivity: { id: 'cactivity0000000000000001', type: 'LLAMADA', title: 'Llamar' } })
    expect(prismaMock.crmActivity.findMany).toHaveBeenCalledTimes(1)
  })

  it('correo_exacto: by email it is the person with that exact email, archived too — never the fuzzy search', async () => {
    prismaMock.crmAccount.findMany.mockResolvedValue([])
    prismaMock.crmAccount.count.mockResolvedValue(0)
    await listAccounts(access({ ver: 'todos' }), { email: ' Juan1985@Cafe.mx ' }, NOW)
    const where = prismaMock.crmAccount.findMany.mock.calls[0][0].where
    expect(where.AND).toContainEqual({ contacts: { some: { email: { equals: 'juan1985@cafe.mx', mode: 'insensitive' } } } })
    expect(where.AND).not.toContainEqual({ archivedAt: null })
    // No «contains», no phone digits: «1985» does not find a phone that has it.
    expect(JSON.stringify(where)).not.toMatch(/contains|phoneE164/)
  })

  it('pendientes_ordena_vencidas_hoy_sin_paso_estancados_sin_dueno', async () => {
    seeded()
    prismaMock.crmStage.findMany.mockResolvedValue([{ id: PROSPECTO, staleDays: 2 }])
    prismaMock.crmAccount.findMany.mockResolvedValue([account()])
    prismaMock.crmAccount.count.mockResolvedValue(3)
    prismaMock.$queryRaw.mockResolvedValue([])

    const pending = await getPending(access(), NOW)

    expect(Object.keys(pending)).toEqual(['vencidas', 'hoy', 'sinSiguientePaso', 'estancados', 'nuevosSinDueno'])
    for (const section of Object.values(pending))
      expect(section).toMatchObject({ total: 3, rows: [expect.objectContaining({ id: ACCOUNT })] })

    const mine = { assigneeStaffId: SELLER, doneAt: null }
    // `prismaMock` is `any`, so `.map` over its calls is `any` whatever the callback says: the variable carries the type.
    const calls: Prisma.CrmAccountFindManyArgs[] = prismaMock.crmAccount.findMany.mock.calls.map(
      ([args]: [Prisma.CrmAccountFindManyArgs]) => args,
    )
    expect(calls).toEqual([
      {
        // What I owe from before today (Mexico City), the oldest first.
        where: { AND: [MINE_OR_UNOWNED, LIVE, { activities: { some: { ...mine, dueAt: { lt: START_OF_TODAY } } } }] },
        select: expect.any(Object),
        orderBy: [{ nextActivityAt: 'asc' }, { id: 'asc' }],
        take: 50,
      },
      {
        // What I owe today, and only once: an account already overdue stays in «Vencidas».
        where: {
          AND: [
            MINE_OR_UNOWNED,
            LIVE,
            { activities: { some: { ...mine, dueAt: { gte: START_OF_TODAY, lte: END_OF_TODAY } } } },
            { activities: { none: { ...mine, dueAt: { lt: START_OF_TODAY } } } },
          ],
        },
        select: expect.any(Object),
        orderBy: [{ nextActivityAt: 'asc' }, { id: 'asc' }],
        take: 50,
      },
      {
        // Mine with nothing scheduled.
        where: { AND: [MINE_OR_UNOWNED, LIVE, { ownerStaffId: SELLER, nextActivityAt: null }] },
        select: expect.any(Object),
        orderBy: [{ lastTouchAt: 'asc' }, { id: 'asc' }],
        take: 50,
      },
      {
        // Mine gone stale, the longest-forgotten first.
        where: {
          AND: [MINE_OR_UNOWNED, LIVE, { ownerStaffId: SELLER }, { OR: [{ stageId: PROSPECTO, lastTouchAt: { lt: daysAgo(2) } }] }],
        },
        select: expect.any(Object),
        orderBy: [{ lastTouchAt: 'asc' }, { id: 'asc' }],
        take: 50,
      },
      {
        // Nobody's, the newest first: whoever gets there first takes it.
        where: { AND: [MINE_OR_UNOWNED, LIVE, { ownerStaffId: null }] },
        select: expect.any(Object),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      },
    ])
    // Every total counts with its own section's filter, not with the 50 rows.
    expect(prismaMock.crmAccount.count.mock.calls.map(([args]: [Prisma.CrmAccountCountArgs]) => args.where)).toEqual(
      calls.map(call => call.where),
    )
  })

  it('vencidas_y_hoy_dicen_cual_de_mis_actividades_las_puso_ahi (ruling 61)', async () => {
    seeded()
    prismaMock.crmStage.findMany.mockResolvedValue([{ id: PROSPECTO, staleDays: 2 }])
    // Nobody owns it yet: Beto scheduled the earliest call (that is `nextActivity`), mine comes after his.
    const shared = account({ id: ACCOUNT, ownerStaffId: null, owner: null, nextActivityAt: daysAgo(3) })
    const today = account({ id: ACCOUNT_B, nextActivityAt: NOW })
    const lost = account({ id: NEW_ACCOUNT, nextActivityAt: NOW })
    prismaMock.crmAccount.findMany
      .mockResolvedValueOnce([shared]) // vencidas
      .mockResolvedValueOnce([today, lost]) // hoy
      .mockResolvedValueOnce([]) // sinSiguientePaso
      .mockResolvedValueOnce([today]) // estancados: the same row object, in a section that does not owe anything
      .mockResolvedValueOnce([]) // nuevosSinDueno
    prismaMock.crmAccount.count.mockResolvedValue(1)
    prismaMock.crmActivity.findMany.mockResolvedValue([
      {
        id: 'cactbeto00000000000000001',
        accountId: ACCOUNT,
        type: 'LLAMADA',
        title: 'Llamada de Beto',
        dueAt: daysAgo(3),
        assigneeStaffId: OTHER,
      },
    ])
    const mineOverdue = { id: 'cactmine00000000000000001', type: 'WHATSAPP', title: 'Mandar precios', dueAt: daysAgo(1) }
    const mineToday = { id: 'cactmine00000000000000002', type: 'LLAMADA', title: 'Llamar hoy', dueAt: NOW }
    // `lost` has none: its activity was completed between the two reads.
    prismaMock.$queryRaw.mockResolvedValue([
      { ...mineOverdue, accountId: ACCOUNT },
      { ...mineToday, accountId: ACCOUNT_B },
    ])

    const pending = await getPending(access(), NOW)

    expect(pending.vencidas.rows[0]).toMatchObject({
      id: ACCOUNT,
      miActividad: mineOverdue,
      nextActivity: { id: 'cactbeto00000000000000001' },
    })
    expect(pending.hoy.rows).toEqual([
      expect.objectContaining({ id: ACCOUNT_B, miActividad: mineToday }),
      expect.objectContaining({ id: NEW_ACCOUNT, miActividad: null }),
    ])
    expect(pending.estancados.rows[0]).not.toHaveProperty('miActividad')

    // ONE query for both sections: the first pending activity of mine per account, by due date then id.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0]
    const sql = (strings as string[]).join('?').replace(/\s+/g, ' ')
    expect(sql).toContain('SELECT DISTINCT ON ("accountId")')
    expect(sql).toContain('"assigneeStaffId" = ? AND "doneAt" IS NULL')
    expect(sql).toContain('ORDER BY "accountId", "dueAt", "id"')
    expect(values).toEqual([[ACCOUNT, ACCOUNT_B, NEW_ACCOUNT], SELLER])
  })

  it('buscar_org_maximo_10_solo_nombre_y_ciudad', async () => {
    prismaMock.crmTeam.findUnique.mockResolvedValue(null)
    prismaMock.organization.findMany.mockResolvedValue([
      { id: ORG, name: 'Café Tlalpan SA de CV', venues: [{ city: 'Ciudad de México' }] },
      { id: ORG_2, name: 'Cafetería Sur', venues: [] },
    ])

    await expect(searchOrganizations(access(), '  café ')).resolves.toEqual([
      { id: ORG, name: 'Café Tlalpan SA de CV', city: 'Ciudad de México' },
      { id: ORG_2, name: 'Cafetería Sur', city: null },
    ])
    const args = prismaMock.organization.findMany.mock.calls[0][0]
    expect(args.take).toBe(10)
    // Never the email, phone or tax id of a business: name and city are enough to pick one.
    expect(Object.keys(args.select)).toEqual(['id', 'name', 'venues'])
    // It searches the organization and its owner, by name and email.
    const text = { contains: 'café', mode: 'insensitive' }
    expect(args.where).toEqual({
      AND: [
        {
          OR: [
            { name: text },
            { email: text },
            {
              staffOrganizations: {
                some: { role: 'OWNER', isActive: true, staff: { OR: [{ firstName: text }, { lastName: text }, { email: text }] } },
              },
            },
          ],
        },
      ],
    })

    // With digits, also by phone.
    await searchOrganizations(access(), '55 1234')
    const byPhone = prismaMock.organization.findMany.mock.lastCall![0].where.AND[0].OR
    expect(byPhone).toContainEqual({ phone: { contains: '551234' } })
    expect(byPhone).toContainEqual({
      staffOrganizations: { some: { role: 'OWNER', isActive: true, staff: { phone: { contains: '551234' } } } },
    })

    // Fewer than 3 letters asks nothing of the database.
    prismaMock.organization.findMany.mockClear()
    await expect(searchOrganizations(access(), 'ca')).resolves.toEqual([])
    expect(prismaMock.organization.findMany).not.toHaveBeenCalled()
  })

  it('buscar_org_no_devuelve_el_equipo_interno', async () => {
    prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })
    prismaMock.organization.findMany.mockResolvedValue([])

    await searchOrganizations(access(), 'avoqado')

    expect(prismaMock.crmTeam.findUnique).toHaveBeenCalledWith({ where: { key: 'default' }, select: { organizationId: true } })
    const { where } = prismaMock.organization.findMany.mock.calls[0][0]
    expect(where.AND).toContainEqual({ id: { not: TEAM_ORG } })
    // By its id, never by its name or slug (ruling 14).
    expect(JSON.stringify(where)).not.toMatch(/Equipo de ventas|avoqado-equipo-ventas/)
  })
})

describe('stages and lost reasons', () => {
  it('sembrar_no_recrea_una_etapa_renombrada', async () => {
    // Empty tables: the 7 stages and the 5 reasons, created under the advisory lock.
    prismaMock.crmStage.count.mockResolvedValue(0)
    prismaMock.crmLostReason.count.mockResolvedValue(0)
    await ensureCrmDefaults()
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmStage.createMany).toHaveBeenCalledWith({
      data: [
        { name: 'Prospecto', order: 1, kind: 'ABIERTA', staleDays: 2 },
        { name: 'Contacto inicial', order: 2, kind: 'ABIERTA', staleDays: 3 },
        { name: 'Calificado', order: 3, kind: 'ABIERTA', staleDays: 5 },
        { name: 'Demo', order: 4, kind: 'ABIERTA', staleDays: 5 },
        { name: 'Negociación', order: 5, kind: 'ABIERTA', staleDays: 7 },
        { name: 'Ganado', order: 6, kind: 'GANADA', staleDays: null },
        { name: 'Perdido', order: 7, kind: 'PERDIDA', staleDays: null },
      ],
    })
    expect(prismaMock.crmLostReason.createMany).toHaveBeenCalledWith({
      data: ['Dijo que no', 'Eligió a otro', 'No es para nosotros', '14 días sin contestar', 'Precio'].map(name => ({ name })),
    })

    // An admin renamed «Prospecto» to «Nuevo»: the table is not empty, so «Prospecto» never comes back.
    jest.clearAllMocks()
    seeded()
    await ensureCrmDefaults()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.crmStage.createMany).not.toHaveBeenCalled()

    // Two first calls at once: the second one, once it holds the lock, finds the tables filled and creates nothing.
    jest.clearAllMocks()
    prismaMock.crmStage.count.mockResolvedValueOnce(0).mockResolvedValue(7)
    prismaMock.crmLostReason.count.mockResolvedValueOnce(0).mockResolvedValue(5)
    await ensureCrmDefaults()
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmStage.createMany).not.toHaveBeenCalled()
    expect(prismaMock.crmLostReason.createMany).not.toHaveBeenCalled()
  })

  it('primera_escritura_siembra_ganado_y_perdido', async () => {
    // M-3: on a brand-new database the first CRM write is an admin creating a stage. Without seeding first, the table
    // would stop being empty, «Ganado» and «Perdido» would never be created, and winning or losing would fail for good.
    const admin = access({ admin: true })
    prismaMock.crmStage.count.mockResolvedValue(0)
    prismaMock.crmLostReason.count.mockResolvedValue(0)
    prismaMock.crmStage.create.mockResolvedValue(stage({ id: DEMO, name: 'Seguimiento' }))

    await createStage(admin, { name: 'Seguimiento', order: 8 })

    expect(prismaMock.crmStage.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ name: 'Ganado', kind: 'GANADA' }),
        expect.objectContaining({ name: 'Perdido', kind: 'PERDIDA' }),
      ]),
    })
    expect(prismaMock.crmStage.createMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.crmStage.create.mock.invocationCallOrder[0])

    // The same for the first lost reason someone adds.
    jest.clearAllMocks()
    prismaMock.crmLostReason.create.mockResolvedValue({ id: REASON, name: 'Sin presupuesto', active: true })

    await createLostReason(admin, { name: 'Sin presupuesto' })

    expect(prismaMock.crmLostReason.createMany).toHaveBeenCalledWith({ data: expect.arrayContaining([{ name: 'Precio' }]) })
    expect(prismaMock.crmLostReason.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.crmLostReason.create.mock.invocationCallOrder[0],
    )
  })

  it('etapa_ganada_no_cambia_de_tipo_ni_se_desactiva', async () => {
    // The PATCH takes the name, the order and the days for «Estancado» — and nothing else.
    const patch = (body: unknown) => updateStageSchema.safeParse({ params: { id: GANADO }, body }).success
    expect(patch({ kind: 'ABIERTA' })).toBe(false)
    expect(patch({ active: false })).toBe(false)
    expect(patch({ name: 'Cerrado', kind: 'ABIERTA' })).toBe(false)
    expect(patch({})).toBe(false)
    expect(patch({ name: 'Cerrado' })).toBe(true)

    // Renaming «Ganado» keeps it a won stage: the service writes only what it knows, whatever slips in.
    const admin = access({ admin: true })
    prismaMock.crmStage.findUnique.mockResolvedValue(stage({ id: GANADO, name: 'Ganado', kind: 'GANADA', staleDays: null }))
    prismaMock.crmStage.update.mockResolvedValue(stage({ id: GANADO, name: 'Cerrado', kind: 'GANADA', staleDays: null }))
    await updateStage(admin, GANADO, { name: 'Cerrado', kind: 'ABIERTA', active: false } as never)
    expect(prismaMock.crmStage.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: GANADO }, data: { name: 'Cerrado' } }))

    // A new stage is always an open one: there is one Ganado and one Perdido.
    seeded()
    prismaMock.crmStage.create.mockResolvedValue(stage({ id: DEMO, name: 'Seguimiento' }))
    await createStage(admin, { name: 'Seguimiento', order: 4, staleDays: 3, kind: 'GANADA' } as never)
    expect(prismaMock.crmStage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Seguimiento', order: 4, staleDays: 3, kind: 'ABIERTA' } }),
    )

    // A name that already exists is a 409, not a 500.
    prismaMock.crmStage.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique', { code: 'P2002', clientVersion: 'test', meta: { target: ['name'] } }),
    )
    await expect(updateStage(admin, GANADO, { name: 'Perdido' })).rejects.toMatchObject({ statusCode: 409, code: 'CRM_NOMBRE_REPETIDO' })
  })
})

describe("the ficha: email events and each contact's consent (phase 2, plan task 7)", () => {
  const BRENDA = 'ccontactbr0000000000000001'
  const ANA = 'ccontactan0000000000000001'
  const MSG_SENT = 'cmessagesent0000000000001'
  const MSG_IN = 'cmessagein00000000000001'

  function fichaConCorreos(events: Array<Record<string, unknown>>) {
    prismaMock.crmAccount.findFirst.mockResolvedValue({
      ...account(),
      sucursales: null,
      modulos: null,
      sourceDetail: null,
      referidoPor: null,
      stageEnteredAt: daysAgo(1),
      lostReason: null,
      lostNote: null,
      wonAt: null,
      lostAt: null,
      firstMoneySource: null,
      consentMarketing: false,
      consentAt: null,
      consentSource: null,
      qualificationAvailable: false,
      contacts: [
        { id: BRENDA, name: 'Brenda', phoneE164: null, email: 'Brenda@Cafe.mx ', role: null, isPrimary: true },
        { id: ANA, name: 'Ana', phoneE164: null, email: 'ana@cafe.mx', role: null, isPrimary: false },
        { id: 'ccontactsin0000000000001', name: 'Sin correo', phoneE164: '+525555555555', email: null, role: null, isPrimary: false },
      ],
    })
    prismaMock.crmActivity.count.mockResolvedValue(0)
    prismaMock.crmTimelineEvent.findMany.mockResolvedValue(events)
    prismaMock.crmTimelineEvent.count.mockResolvedValue(events.length)
    prismaMock.staff.findMany.mockResolvedValue([])
  }

  it('la ficha de la cuenta de Brenda muestra «Aceptó novedades · fecha» en el contacto de Brenda y no en el de Ana', async () => {
    const aceptó = new Date('2026-10-30T15:00:00.000Z')
    fichaConCorreos([])
    prismaMock.crmEmailConsent.findMany.mockResolvedValue([{ email: 'brenda@cafe.mx', consentAt: aceptó, noticeVersion: '2026-10' }])

    const ficha = await getAccount(access(), ACCOUNT, NOW)

    // ONE query, by the normalized emails of THIS account's contacts.
    expect(prismaMock.crmEmailConsent.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmEmailConsent.findMany).toHaveBeenCalledWith({
      where: { email: { in: ['brenda@cafe.mx', 'ana@cafe.mx'] } },
      select: { email: true, consentAt: true, noticeVersion: true },
      take: 2,
    })
    const [brenda, ana, sinCorreo] = ficha.contacts
    expect(brenda).toMatchObject({ id: BRENDA, consentAt: aceptó, noticeVersion: '2026-10' })
    expect(ana).toMatchObject({ id: ANA, consentAt: null, noticeVersion: null })
    expect(sinCorreo).toMatchObject({ consentAt: null, noticeVersion: null })
    // The old account-level fields are still returned as they were (no field leaves an API response).
    expect(ficha.consent).toEqual({ marketing: false, at: null, source: null })
  })

  it('un envío con timeout de Google se ve con «no sabemos si salió»: el evento trae su correo, leído en UNA consulta', async () => {
    fichaConCorreos([
      { id: 'cevent1', kind: 'EMAIL_SENT', actorStaffId: SELLER, data: { messageId: MSG_SENT, contactId: BRENDA }, createdAt: daysAgo(0) },
      { id: 'cevent2', kind: 'EMAIL_RECEIVED', actorStaffId: null, data: { messageId: MSG_IN }, createdAt: daysAgo(0) },
      { id: 'cevent3', kind: 'NOTE', actorStaffId: SELLER, data: { text: 'llamar' }, createdAt: daysAgo(1) },
      // Task 6's consent event carries no `changes`: it must not break the read.
      { id: 'cevent4', kind: 'FIELD_CHANGE', actorStaffId: null, data: { campo: 'consentimiento' }, createdAt: daysAgo(2) },
    ])
    prismaMock.crmEmailMessage.findMany.mockResolvedValue([
      {
        id: MSG_SENT,
        subject: 'Hola Brenda',
        snippet: 'Soy Rafa',
        direction: 'SALIDA',
        status: 'DESCONOCIDO',
        error: 'Gmail no contestó',
        fromEmail: 'rafa@gmail.com',
      },
      {
        id: MSG_IN,
        subject: 'Re: Hola Brenda',
        snippet: 'Sí me interesa',
        direction: 'ENTRADA',
        status: 'RECIBIDO',
        error: null,
        fromEmail: 'brenda@cafe.mx',
      },
    ])

    const ficha = await getAccount(access(), ACCOUNT, NOW)

    expect(prismaMock.crmEmailMessage.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmEmailMessage.findMany).toHaveBeenCalledWith({
      where: { id: { in: [MSG_SENT, MSG_IN] }, accountId: ACCOUNT },
      select: { id: true, subject: true, snippet: true, direction: true, status: true, error: true, fromEmail: true },
      take: 2,
    })
    const [enviado, recibido, nota, consentimiento] = ficha.timeline.events
    expect(enviado.email).toEqual({
      subject: 'Hola Brenda',
      snippet: 'Soy Rafa',
      direction: 'SALIDA',
      status: 'DESCONOCIDO',
      error: 'Gmail no contestó',
      fromEmail: 'rafa@gmail.com',
    })
    expect(recibido.email).toMatchObject({ direction: 'ENTRADA', status: 'RECIBIDO', snippet: 'Sí me interesa' })
    expect(nota).not.toHaveProperty('email')
    expect(consentimiento).toMatchObject({ kind: 'FIELD_CHANGE', data: { campo: 'consentimiento' } })
  })

  it('sin eventos de correo no se consulta la tabla de correos', async () => {
    fichaConCorreos([{ id: 'cevent3', kind: 'NOTE', actorStaffId: SELLER, data: { text: 'x' }, createdAt: daysAgo(1) }])
    await getAccount(access(), ACCOUNT, NOW)
    expect(prismaMock.crmEmailMessage.findMany).not.toHaveBeenCalled()
  })
})
