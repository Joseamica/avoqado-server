import prisma from '@/utils/prismaClient'
import * as supportAccess from '@/services/support/access.service'
import { getDataAccess, grantDataAccess, readDataValidity } from '@/services/support/data/consent.service'
import { SUPPORT_DATA_NOTICE, supportDataNoticeHash } from '@/services/support/data/texts'
import { getLinkStatus, unlink } from '@/services/support/link.service'
import { venueDayKey } from '@/utils/venueDateKeys'
import { changeSupportDataNotice } from '@tests/__helpers__/supportData'

const tag = `support-data-consent-${Date.now()}`
const phone = `+5255${String(Date.now()).slice(-8)}`
const H = supportDataNoticeHash('es')
const DATA_ON = {
  SUPPORT_WHATSAPP_ENABLED: 'true',
  SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
  SUPPORT_WHATSAPP_PHONE_NUMBER_ID: tag,
  WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales-only',
  SUPPORT_WHATSAPP_FREE_TEXT_ENABLED: 'true',
  SUPPORT_WHATSAPP_HYBRID_ENABLED: 'true',
  SUPPORT_DATA_ENABLED: 'true',
}
const before = Object.fromEntries(Object.keys(DATA_ON).map(key => [key, process.env[key]]))
let staffId: string, orgId: string, otherOrgId: string, northId: string, southId: string, westId: string, foreignId: string
/** De la misma organización, sin asignación directa: se llega sólo como dueño de la organización (T-B40). */
let inheritedId: string, suspendedId: string

const link = () => prisma.supportWhatsappLink.findUnique({ where: { staffId } })
/** Otro vínculo para la misma persona, como al volver a vincular: se borra el anterior y nace uno nuevo, con otro id. */
const relink = async () => {
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
  return prisma.supportWhatsappLink.create({
    data: { staffId, phone, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86_400_000) },
  })
}
/** acceptNotice: true = «Aceptar» en la ventana del aviso; false = el toque de un panel que ya dice «aceptado» (T-B37). */
const tap = (noticeHash?: string, venue = northId, acceptNotice = true) =>
  grantDataAccess(staffId, { venueId: venue, noticeHash, acceptNotice }, { strongAuthAt: new Date() })
/** El toque de todos los días: el panel ya tiene el aviso aceptado y no abre la ventana. */
const oneTap = (noticeHash = H, venue = northId) => tap(noticeHash, venue, false)
const rows = async () => [
  await prisma.supportDataAcceptance.count({ where: { staffId } }),
  await prisma.supportDataUnlock.count({ where: { staffId } }),
]
const logs = (action: string) => prisma.activityLog.count({ where: { staffId, action } })
const valid = async (venueId = northId) => {
  const v = await readDataValidity(prisma, { staffId, venueId, linkId: (await link())?.id ?? null, now: new Date() })
  return [v.accepted, v.unlocked]
}

beforeAll(async () => {
  Object.assign(process.env, DATA_ON)
  orgId = (await prisma.organization.create({ data: { name: tag, email: `${tag}@test.local`, phone: '0000000000' } })).id
  otherOrgId = (await prisma.organization.create({ data: { name: `${tag}-otra`, email: `otra-${tag}@test.local`, phone: '0000000000' } }))
    .id
  const venue = (organizationId: string, name: string, timezone: string) =>
    prisma.venue.create({ data: { organizationId, name, slug: `${tag}-${name.toLowerCase()}`, status: 'ACTIVE', timezone } })
  northId = (await venue(orgId, 'Norte', 'America/Mexico_City')).id
  southId = (await venue(orgId, 'Sur', 'America/Cancun')).id
  westId = (await venue(orgId, 'Oeste', 'America/Tijuana')).id
  foreignId = (await venue(otherOrgId, 'Ajena', 'America/Mexico_City')).id
  inheritedId = (await venue(orgId, 'Heredada', 'America/Mexico_City')).id
  suspendedId = (await venue(orgId, 'Suspendida', 'America/Mexico_City')).id
  // Como la deja suspendSucursal (venue.dashboard.service.ts): estado SUSPENDED y active en false.
  await prisma.venue.update({ where: { id: suspendedId }, data: { status: 'SUSPENDED', active: false } })
  staffId = (await prisma.staff.create({ data: { email: `${tag}@test.local`, firstName: 'Datos', lastName: 'Prueba', phone } })).id
  await prisma.staffVenue.createMany({
    data: [
      { staffId, venueId: northId, role: 'VIEWER' },
      { staffId, venueId: southId, role: 'VIEWER' },
      { staffId, venueId: westId, role: 'VIEWER' },
    ],
  })
  await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER' } })
})

beforeEach(async () => {
  Object.assign(process.env, DATA_ON)
  await prisma.staffVenue.updateMany({ where: { staffId }, data: { role: 'VIEWER', active: true } })
  await prisma.venue.update({ where: { id: northId }, data: { kycStatus: 'NOT_SUBMITTED', status: 'ACTIVE' } })
  await prisma.venue.update({ where: { id: southId }, data: { status: 'ACTIVE', active: true } })
  await prisma.staffOrganization.updateMany({ where: { staffId }, data: { role: 'MEMBER' } })
  await prisma.supportDataAcceptance.deleteMany({ where: { staffId } })
  await prisma.supportDataUnlock.deleteMany({ where: { staffId } })
  await prisma.activityLog.deleteMany({ where: { staffId } })
  await relink()
})

afterEach(() => jest.restoreAllMocks())

afterAll(async () => {
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (!staffId) return
  await prisma.supportDataAcceptance.deleteMany({ where: { staffId } })
  await prisma.supportDataUnlock.deleteMany({ where: { staffId } })
  await prisma.activityLog.deleteMany({ where: { staffId } })
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
  await prisma.staffVenue.deleteMany({ where: { staffId } })
  await prisma.staffOrganization.deleteMany({ where: { staffId } })
  await prisma.staff.delete({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: { in: [northId, southId, westId, foreignId, inheritedId, suspendedId] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } })
})

it('first tap with the current hash: one acceptance and one unlock in one operation, both audited', async () => {
  expect(await tap(H)).toMatchObject({ accepted: true, unlocked: true, venueName: 'Norte' })
  expect(await rows()).toEqual([1, 1])
  expect([await logs('SUPPORT_DATA_NOTICE_ACCEPTED'), await logs('SUPPORT_DATA_UNLOCKED')]).toEqual([1, 1])
  const unlock = await prisma.supportDataUnlock.findFirstOrThrow({ where: { staffId } })
  expect(await prisma.activityLog.findFirstOrThrow({ where: { staffId, action: 'SUPPORT_DATA_UNLOCKED' } })).toMatchObject({
    entity: 'SupportDataUnlock',
    entityId: unlock.id,
    venueId: northId,
    data: { day: unlock.day },
  })
  expect(await prisma.activityLog.findFirstOrThrow({ where: { staffId, action: 'SUPPORT_DATA_NOTICE_ACCEPTED' } })).toMatchObject({
    entity: 'SupportDataAcceptance',
    entityId: staffId,
    venueId: northId,
    data: { noticeHash: H },
  })
  // The instants are real UTC, as Prisma writes them, whatever the session zone of the database.
  expect(Math.abs(unlock.unlockedAt.getTime() - Date.now())).toBeLessThan(60_000)
  expect(Math.abs(unlock.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
})

it('a double click and two tabs leave one row of each and one audit of each (case 1)', async () => {
  await Promise.all([tap(H), tap(H), tap(H)])
  expect(await rows()).toEqual([1, 1])
  expect([await logs('SUPPORT_DATA_NOTICE_ACCEPTED'), await logs('SUPPORT_DATA_UNLOCKED')]).toEqual([1, 1])
})

// T-B30: el panel manda la huella del idioma que muestra; una aceptación vigente no se reescribe por cambiar de idioma.
it.each([
  ['es', 'en'],
  ['en', 'es'],
] as const)(
  'accepted in %s, a tap with the %s hash rewrites nothing: same row, one acceptance in the log (T-B30)',
  async (first, second) => {
    await tap(supportDataNoticeHash(first))
    const accepted = await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })
    expect(await tap(supportDataNoticeHash(second))).toMatchObject({ accepted: true, unlocked: true })
    expect(await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })).toEqual(accepted)
    expect(await logs('SUPPORT_DATA_NOTICE_ACCEPTED')).toBe(1)
  },
)

it('a stored hash that is no longer current is rewritten, with a new acceptance in the log (T-B30)', async () => {
  await tap(H)
  changeSupportDataNotice('Otro texto del aviso.', 'Another notice text.')
  const current = supportDataNoticeHash('en')
  expect(await tap(current)).toMatchObject({ accepted: true, unlocked: true })
  expect(await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })).toMatchObject({ noticeHash: current })
  expect(await logs('SUPPORT_DATA_NOTICE_ACCEPTED')).toBe(2)
})

it('a changed link is rewritten, with a new acceptance in the log (T-B30)', async () => {
  await tap(H)
  const fresh = await relink()
  expect(await tap(supportDataNoticeHash('en'))).toMatchObject({ accepted: true, unlocked: true })
  expect(await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })).toMatchObject({
    linkId: fresh.id,
    noticeHash: supportDataNoticeHash('en'),
  })
  expect([await logs('SUPPORT_DATA_NOTICE_ACCEPTED'), await logs('SUPPORT_DATA_UNLOCKED')]).toEqual([2, 2])
})

// T-B37: sólo «Aceptar» en la ventana del aviso escribe la aceptación. El toque de un panel que ya dice «aceptado» manda
// acceptNotice: false y sólo desbloquea mientras la aceptación vale para el vínculo de AHORA.
describe('acceptNotice (T-B37)', () => {
  const dataLogs = async () => [await logs('SUPPORT_DATA_NOTICE_ACCEPTED'), await logs('SUPPORT_DATA_UNLOCKED')]

  it('a stale tab after unlinking and linking again: the one tap writes nothing and the notice comes back; «Aceptar» then writes both', async () => {
    await tap(H) // aceptó con el vínculo L1
    const before = [
      await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } }),
      await prisma.supportDataUnlock.findFirstOrThrow({ where: { staffId } }),
    ]
    await unlink(staffId, { strongAuthAt: new Date() })
    const fresh = await relink() // L2
    expect(await oneTap()).toEqual({
      accepted: false,
      unlocked: false,
      venueName: 'Norte',
      notice: { text: SUPPORT_DATA_NOTICE.es, hash: H },
    })
    expect([
      await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } }),
      await prisma.supportDataUnlock.findFirstOrThrow({ where: { staffId } }),
    ]).toEqual(before) // nada con L2
    expect(await rows()).toEqual([1, 1])
    expect(await dataLogs()).toEqual([1, 1])
    // la persona vio el aviso otra vez y tocó «Aceptar»
    expect(await tap(H)).toMatchObject({ accepted: true, unlocked: true })
    expect(await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })).toMatchObject({ linkId: fresh.id })
    expect(await prisma.supportDataUnlock.findFirstOrThrow({ where: { staffId } })).toMatchObject({ linkId: fresh.id })
    expect(await dataLogs()).toEqual([2, 2])
  })

  it('an acceptance that counts for the current link: the one tap writes only the unlock (the everyday path)', async () => {
    await tap(H)
    await prisma.supportDataUnlock.updateMany({ where: { staffId }, data: { day: '2000-01-01' } }) // aceptó ayer; hoy no ha tocado
    const acceptance = await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })
    expect(await oneTap()).toMatchObject({ accepted: true, unlocked: true })
    expect(await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })).toEqual(acceptance)
    expect(await dataLogs()).toEqual([1, 2])
    expect(await valid()).toEqual([true, true])
  })

  it('never accepted: the one tap writes nothing at all', async () => {
    expect(await oneTap()).toMatchObject({ accepted: false, unlocked: false, notice: { text: SUPPORT_DATA_NOTICE.es, hash: H } })
    expect(await rows()).toEqual([0, 0])
    expect(await dataLogs()).toEqual([0, 0])
  })

  it.each([
    ['es', 'en'],
    ['en', 'es'],
  ] as const)(
    'accepted in %s, the one tap with the %s hash: the same row, one acceptance in the log, and the unlock written (T-B30)',
    async (first, second) => {
      await tap(supportDataNoticeHash(first))
      await prisma.supportDataUnlock.updateMany({ where: { staffId }, data: { day: '2000-01-01' } })
      const acceptance = await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })
      expect(await oneTap(supportDataNoticeHash(second))).toMatchObject({ accepted: true, unlocked: true })
      expect(await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })).toEqual(acceptance)
      expect(await dataLogs()).toEqual([1, 2])
    },
  )
})

/** Corre `meanwhile` dentro del toque: después de que leyó el vínculo y antes de que escriba (en la revisión de la sucursal). */
const duringTheTap = (meanwhile: () => Promise<unknown>) => {
  const real = supportAccess.listSupportVenues
  jest.spyOn(supportAccess, 'listSupportVenues').mockImplementationOnce(async (...args) => {
    await meanwhile()
    return real(...args)
  })
}

it('an unlink that lands while the tap runs: the answer tells the truth and nothing is written with the dead link', async () => {
  duringTheTap(() => unlink(staffId, { strongAuthAt: new Date() }))
  expect(await tap(H)).toMatchObject({ accepted: false, unlocked: false })
  expect(await rows()).toEqual([0, 0])
  expect([await logs('SUPPORT_DATA_NOTICE_ACCEPTED'), await logs('SUPPORT_DATA_UNLOCKED')]).toEqual([0, 0])
})

it('a tap that read the old link never overwrites what a tap with the new link wrote meanwhile', async () => {
  let fresh = ''
  duringTheTap(async () => {
    fresh = (await relink()).id
    await tap(H)
  })
  expect(await tap(H)).toMatchObject({ accepted: true, unlocked: true }) // lo que vale ahora: lo que escribió el toque con el vínculo nuevo
  expect(await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })).toMatchObject({ linkId: fresh })
  expect(await prisma.supportDataUnlock.findFirstOrThrow({ where: { staffId } })).toMatchObject({ linkId: fresh })
  expect([await logs('SUPPORT_DATA_NOTICE_ACCEPTED'), await logs('SUPPORT_DATA_UNLOCKED')]).toEqual([1, 1])
  expect(await valid()).toEqual([true, true])
})

it('two POSTs with the same body on two venue-days create two unlocks: each is a real tap, and that is why no client may repeat one on its own (T-B29)', async () => {
  const today = venueDayKey(new Date(), 'America/Mexico_City') // Norte: UTC−6 todo el año
  const before = new Date(`${today}T23:59:59.500-06:00`),
    after = new Date(before.getTime() + 1_000) // 00:00:00.5 del día siguiente
  const tapAt = (now: Date) =>
    grantDataAccess(staffId, { venueId: northId, noticeHash: H, acceptNotice: true }, { strongAuthAt: new Date() }, now)
  expect(await tapAt(before)).toMatchObject({ accepted: true, unlocked: true })
  expect(await tapAt(after)).toMatchObject({ accepted: true, unlocked: true })
  const unlocks = await prisma.supportDataUnlock.findMany({
    where: { staffId, venueId: northId },
    orderBy: { day: 'asc' },
    select: { day: true },
    take: 5,
  })
  expect(unlocks.map(u => u.day)).toEqual([today, venueDayKey(after, 'America/Mexico_City')])
  expect(unlocks[0].day).not.toBe(unlocks[1].day)
  expect([await logs('SUPPORT_DATA_NOTICE_ACCEPTED'), await logs('SUPPORT_DATA_UNLOCKED')]).toEqual([1, 2]) // la aceptación es una; el desbloqueo es por día
})

it('the same two POSTs inside one venue-day write once (the idempotency of the double click does not cross midnight)', async () => {
  const today = venueDayKey(new Date(), 'America/Mexico_City')
  const tapAt = (hhmm: string) =>
    grantDataAccess(
      staffId,
      { venueId: northId, noticeHash: H, acceptNotice: true },
      { strongAuthAt: new Date() },
      new Date(`${today}T${hhmm}-06:00`),
    )
  await tapAt('23:59:58.500')
  await tapAt('23:59:59.500')
  expect(await rows()).toEqual([1, 1])
  expect(await logs('SUPPORT_DATA_UNLOCKED')).toBe(1)
})

it('without the hash, or with the hash of another text, nothing is written and the notice comes back (case 2)', async () => {
  for (const acceptNotice of [true, false])
    for (const hash of [undefined, 'f'.repeat(64)])
      expect(await tap(hash, northId, acceptNotice)).toMatchObject({
        accepted: false,
        unlocked: false,
        notice: { text: SUPPORT_DATA_NOTICE.es, hash: H },
      })
  expect(await rows()).toEqual([0, 0])
})

it.each([
  ['a superadmin', 'SUPPORT_DATA_SUPERADMIN'],
  ['a person without a link', 'SUPPORT_DATA_LINK_REQUIRED'],
  ['a venue of another organization', 'SUPPORT_DATA_VENUE_FORBIDDEN'],
  ['data off', 'SUPPORT_DATA_UNAVAILABLE'],
])('rejects %s and writes nothing (cases 1 and 14)', async (_who, code) => {
  const arrange: Record<string, () => Promise<string>> = {
    SUPPORT_DATA_SUPERADMIN: async () => {
      await prisma.staffVenue.updateMany({ where: { staffId, venueId: southId }, data: { role: 'SUPERADMIN' } })
      return northId
    },
    SUPPORT_DATA_LINK_REQUIRED: async () => {
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
      return northId
    },
    SUPPORT_DATA_VENUE_FORBIDDEN: async () => foreignId,
    SUPPORT_DATA_UNAVAILABLE: async () => {
      delete process.env.SUPPORT_DATA_ENABLED
      return northId
    },
  }
  const venueId = await arrange[code]()
  await expect(tap(H, venueId)).rejects.toMatchObject({ code })
  await expect(getDataAccess(staffId, { venueId })).rejects.toMatchObject({ code })
  expect(await rows()).toEqual([0, 0])
})

// T-B40: la sucursal que el panel no muestra tampoco se desbloquea aquí. El panel (getAuthStatus) carga las sucursales heredadas por
// la organización con `active: true`, y suspender una la deja en false.
describe('the venues the panel shows (T-B40)', () => {
  const listed = async (venueId: string) => (await supportAccess.listSupportVenues(staffId, { venueId, limit: 1 })).items.length
  const makeOwner = async () => {
    await prisma.staffOrganization.updateMany({ where: { staffId, organizationId: orgId }, data: { role: 'OWNER' } })
    await prisma.staffVenue.updateMany({ where: { staffId, venueId: northId }, data: { role: 'OWNER' } })
  }

  it('an owner who reaches a suspended venue only through the organization: not listed, and refused like a venue without access', async () => {
    await makeOwner()
    expect([await listed(inheritedId), await listed(suspendedId)]).toEqual([1, 0])
    for (const venueId of [suspendedId, foreignId]) {
      await expect(getDataAccess(staffId, { venueId })).rejects.toMatchObject({ code: 'SUPPORT_DATA_VENUE_FORBIDDEN' })
      await expect(tap(H, venueId)).rejects.toMatchObject({ code: 'SUPPORT_DATA_VENUE_FORBIDDEN' })
    }
    expect(await rows()).toEqual([0, 0])
    expect(await getDataAccess(staffId, { venueId: inheritedId })).toMatchObject({ venueName: 'Heredada' })
  })

  it('a suspended venue with a direct active assignment stays, as in the panel', async () => {
    await prisma.venue.update({ where: { id: southId }, data: { status: 'SUSPENDED', active: false } })
    expect(await listed(southId)).toBe(1)
    expect(await tap(H, southId)).toMatchObject({ accepted: true, unlocked: true, venueName: 'Sur' })
  })
})

it('the reading route only reads: the state, the notice in the chosen language and its hash', async () => {
  expect(await getDataAccess(staffId, { venueId: northId })).toEqual({
    accepted: false,
    unlocked: false,
    venueName: 'Norte',
    notice: { text: SUPPORT_DATA_NOTICE.es, hash: H },
  })
  await tap(H)
  expect(await getDataAccess(staffId, { venueId: northId, language: 'en' })).toEqual({
    accepted: true,
    unlocked: true,
    venueName: 'Norte',
    notice: { text: SUPPORT_DATA_NOTICE.en, hash: supportDataNoticeHash('en') },
  })
  expect(await getDataAccess(staffId, { venueId: southId })).toMatchObject({ accepted: true, unlocked: false, venueName: 'Sur' })
  expect(await rows()).toEqual([1, 1])
})

it('the English hash is an acceptance too', async () => {
  expect(await tap(supportDataNoticeHash('en'))).toMatchObject({ accepted: true, unlocked: true })
  expect(await valid()).toEqual([true, true])
})

it('the link status says whether data is on', async () => {
  expect(await getLinkStatus(staffId)).toMatchObject({ linked: true, dataEnabled: true })
  delete process.env.SUPPORT_DATA_ENABLED
  expect(await getLinkStatus(staffId)).toMatchObject({ linked: true, dataEnabled: false })
})

it('the unlock of another venue does not open this one (case 6)', async () => {
  await tap(H, southId)
  expect(await valid(northId)).toEqual([true, false])
})

it("yesterday's unlock does not open today", async () => {
  await tap(H)
  await prisma.supportDataUnlock.updateMany({ where: { staffId }, data: { day: '2000-01-01' } })
  expect(await valid()).toEqual([true, false])
})

it('the unlock is the calendar day of the venue, not the business day (T-B9)', async () => {
  await tap(H, southId) // Sur está en America/Cancun: UTC−5
  const linkId = (await link())!.id
  const at = (iso: string) => readDataValidity(prisma, { staffId, venueId: southId, linkId, now: new Date(iso) })
  const today = venueDayKey(new Date(), 'America/Cancun')
  expect((await at(`${today}T23:59:58-05:00`)).unlocked).toBe(true)
  expect((await at(new Date(new Date(`${today}T23:59:58-05:00`).getTime() + 5_000).toISOString())).unlocked).toBe(false) // 00:00:03 del día siguiente
})

it.each([
  [
    'the day the clock goes back (25 hours)',
    '2026-11-01',
    '2026-11-01T06:59:59Z',
    '2026-11-01T07:00:01Z',
    '2026-11-02T07:59:58Z',
    '2026-11-02T08:00:03Z',
  ],
  [
    'the day the clock goes forward (23 hours)',
    '2026-03-08',
    '2026-03-08T07:59:59Z',
    '2026-03-08T08:00:01Z',
    '2026-03-09T06:59:58Z',
    '2026-03-09T07:00:03Z',
  ],
])(
  'in America/Tijuana the unlock lasts the calendar day of the venue: %s',
  async (_name, day, beforeStart, afterStart, beforeEnd, afterEnd) => {
    await grantDataAccess(
      staffId,
      { venueId: westId, noticeHash: H, acceptNotice: true },
      { strongAuthAt: new Date() },
      new Date(afterStart),
    )
    expect(await prisma.supportDataUnlock.findFirstOrThrow({ where: { staffId, venueId: westId } })).toMatchObject({ day })
    const linkId = (await link())!.id
    const unlockedAt = async (iso: string) =>
      (await readDataValidity(prisma, { staffId, venueId: westId, linkId, now: new Date(iso) })).unlocked
    // el último segundo del día anterior, el primero del día, el último del día y el primero del siguiente
    expect([await unlockedAt(beforeStart), await unlockedAt(afterStart), await unlockedAt(beforeEnd), await unlockedAt(afterEnd)]).toEqual([
      false,
      true,
      true,
      false,
    ])
  },
)

it('kycVerified copies the panel rule and is part of the fingerprint', async () => {
  const linkId = (await link())!.id
  const read = () => readDataValidity(prisma, { staffId, venueId: northId, linkId, now: new Date() })
  await prisma.venue.update({ where: { id: northId }, data: { kycStatus: 'VERIFIED', status: 'ACTIVE' } })
  const verified = await read()
  await prisma.venue.update({ where: { id: northId }, data: { kycStatus: 'IN_REVIEW' } })
  const inReview = await read()
  await prisma.venue.update({ where: { id: northId }, data: { status: 'TRIAL' } })
  const trial = await read()
  expect([verified.kycVerified, inReview.kycVerified, trial.kycVerified]).toEqual([true, false, true])
  expect(inReview.fingerprint).not.toBe(verified.fingerprint)
})

it('the fingerprint does not move when the same person taps again, and moves when the unlock or the acceptance stops counting', async () => {
  await tap(H)
  const linkId = (await link())!.id
  const read = () => readDataValidity(prisma, { staffId, venueId: northId, linkId, now: new Date() })
  const first = await read()
  await oneTap()
  expect((await read()).fingerprint).toBe(first.fingerprint)
  // el desbloqueo deja de valer (es de otro día): la aceptación sigue igual
  await prisma.supportDataUnlock.updateMany({ where: { staffId }, data: { day: '2000-01-01' } })
  const withoutUnlock = await read()
  expect([withoutUnlock.accepted, withoutUnlock.unlocked]).toEqual([true, false])
  expect(withoutUnlock.fingerprint).not.toBe(first.fingerprint)
  // y luego la aceptación deja de valer (cambió el aviso)
  changeSupportDataNotice('Otro texto del aviso.', 'Another notice text.')
  const withoutAcceptance = await read()
  expect(withoutAcceptance.accepted).toBe(false)
  expect(withoutAcceptance.fingerprint).not.toBe(withoutUnlock.fingerprint)
})

it('unlink and then a new link: both rows stay without value with the new link and nobody rewrites them (case 15)', async () => {
  await tap(H)
  const before = await prisma.supportDataUnlock.findFirstOrThrow({ where: { staffId } })
  await unlink(staffId, { strongAuthAt: new Date() })
  await relink()
  expect(await valid()).toEqual([false, false]) // relink(): crea otro SupportWhatsappLink para la misma persona
  expect(await prisma.supportDataUnlock.findFirstOrThrow({ where: { staffId } })).toEqual(before)
})

it('a changed notice text switches the acceptance off, and a tap with the old hash writes nothing (case 16)', async () => {
  await tap(H)
  changeSupportDataNotice('Otro texto del aviso.', 'Another notice text.')
  expect(await valid()).toEqual([false, true])
  const acceptance = await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })
  expect(await tap(H)).toMatchObject({ accepted: false })
  expect(await prisma.supportDataAcceptance.findUniqueOrThrow({ where: { staffId } })).toEqual(acceptance)
})

it('tap while unlinking, 20 times: both finish, and what the tap wrote never counts with the next link (case 17)', async () => {
  for (let i = 0; i < 20; i++) {
    const results = await Promise.allSettled([tap(H), unlink(staffId, { strongAuthAt: new Date() })])
    expect(results[1].status).toBe('fulfilled')
    // The tap either wrote with the link it read, or found no link at all: never a timeout or a deadlock.
    if (results[0].status === 'rejected') expect(results[0].reason).toMatchObject({ code: 'SUPPORT_DATA_LINK_REQUIRED' })
    await relink() // el vínculo de la vuelta siguiente: lo escrito con el anterior no vale con éste
    expect(await valid()).toEqual([false, false])
  }
}, 60_000)
