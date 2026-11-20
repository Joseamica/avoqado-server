import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { isRelayOperatorPhone, resolveRegisteredSupportPhone } from '@/services/support/registeredPhone.service'

const run = `registered-${Date.now()}`
const inbound = '+525512956265'
let orgId: string, venueId: string, closedVenueId: string, demoVenueId: string
/** Una organización cuya única sucursal está suspendida (T-B40). */
let suspendedOrgId: string
let phoneSeq = 0
const staffIds: string[] = []
const relayVenueIds: string[] = []

const freshPhone = () => `+5255${String((Date.now() + phoneSeq++) % 100_000_000).padStart(8, '0')}`
const resolve = (phone: string) => prisma.$transaction(tx => resolveRegisteredSupportPhone(phone, tx))
const isRelay = (phone: string) => prisma.$transaction(tx => isRelayOperatorPhone(phone, tx))

// Sees the rows the candidate query really returned, which the public result cannot show.
async function resolveCapturingRows(phone: string) {
  const batches: unknown[][] = []
  const result = await prisma.$transaction(tx => {
    const spied = new Proxy(tx, {
      get(target, prop) {
        if (prop !== '$queryRaw') return (target as any)[prop]
        return async (...args: unknown[]) => {
          const rows = await (target as any).$queryRaw(...args)
          batches.push(rows)
          return rows
        }
      },
    }) as Prisma.TransactionClient
    return resolveRegisteredSupportPhone(phone, spied)
  })
  return { result, batches }
}

async function addStaff(phone: string | null, active = true) {
  const staff = await prisma.staff.create({
    data: { email: `${cuid()}@${run}.test`, firstName: 'Tel', lastName: 'Prueba', phone, active },
  })
  staffIds.push(staff.id)
  return staff.id
}

const grantVenue = (staffId: string, venue = venueId, active = true, role: 'VIEWER' | 'SUPERADMIN' = 'VIEWER') =>
  prisma.staffVenue.create({ data: { staffId, venueId: venue, role, active } })

// Explicit, increasing cuids: `ORDER BY id` then reaches these before any account created afterwards.
async function addStaffBatch(phone: string, count: number) {
  const ids = Array.from({ length: count }, () => cuid())
  await prisma.staff.createMany({
    data: ids.map(id => ({ id, email: `${id}@${run}.test`, firstName: 'Tel', lastName: 'Prueba', phone })),
  })
  staffIds.push(...ids)
  return ids
}

async function addRelayVenue(whatsappOptInPhone: string, whatsappContactMode: 'RELAY' | 'WA_ME_FALLBACK') {
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: 'Relay', slug: `${run}-${cuid()}`, status: 'ACTIVE', whatsappContactMode, whatsappOptInPhone },
  })
  relayVenueIds.push(venue.id)
  return venue.id
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: run, email: `${run}@test.local`, phone: '0000000000' } })
  orgId = org.id
  const create = (suffix: string, status: 'ACTIVE' | 'CLOSED' | 'LIVE_DEMO') =>
    prisma.venue.create({ data: { organizationId: orgId, name: suffix, slug: `${run}-${suffix}`, status } })
  venueId = (await create('open', 'ACTIVE')).id
  closedVenueId = (await create('closed', 'CLOSED')).id
  demoVenueId = (await create('demo', 'LIVE_DEMO')).id
  suspendedOrgId = (
    await prisma.organization.create({ data: { name: `${run}-suspendida`, email: `suspendida-${run}@test.local`, phone: '0000000000' } })
  ).id
  // Como la deja suspenderla (venue.dashboard.service.ts): estado SUSPENDED y active en false.
  await prisma.venue.create({
    data: { organizationId: suspendedOrgId, name: 'suspendida', slug: `${run}-suspendida`, status: 'SUSPENDED', active: false },
  })
})

afterEach(async () => {
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId: { in: staffIds } } })
  await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  staffIds.length = 0
  await prisma.venueChatSession.deleteMany({ where: { venueId: { in: relayVenueIds } } })
  await prisma.venue.deleteMany({ where: { id: { in: relayVenueIds } } })
  relayVenueIds.length = 0
})

afterAll(async () => {
  if (!orgId) return
  await prisma.venue.deleteMany({ where: { organizationId: { in: [orgId, suspendedOrgId] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, suspendedOrgId] } } })
})

describe('resolveRegisteredSupportPhone', () => {
  it.each(['55 1295 6265', '+52 1 55 1295 6265', '5512956265'])('finds an employee saved as %s', async saved => {
    const staffId = await addStaff(saved)
    await grantVenue(staffId)
    await expect(resolve(inbound)).resolves.toEqual({ registered: true, soleStaffId: staffId })
  })

  it('rejects a number from another country that shares the last 10 digits', async () => {
    const staffId = await addStaff(inbound)
    await grantVenue(staffId)
    await expect(resolve('+15512956265')).resolves.toEqual({ registered: false, soleStaffId: null })
  })

  it('rejects an employee account that is switched off', async () => {
    const phone = freshPhone()
    await grantVenue(await addStaff(phone, false))
    await expect(resolve(phone)).resolves.toEqual({ registered: false, soleStaffId: null })
  })

  it('rejects an account with no membership at all', async () => {
    const phone = freshPhone()
    await addStaff(phone)
    await expect(resolve(phone)).resolves.toEqual({ registered: false, soleStaffId: null })
  })

  it.each([
    ['a deactivated venue assignment', () => ({ active: false, venue: venueId })],
    ['a closed venue', () => ({ active: true, venue: closedVenueId })],
    ['a live-demo venue', () => ({ active: true, venue: demoVenueId })],
  ])('rejects access that only comes from %s', async (_label, access) => {
    const phone = freshPhone()
    const { active, venue } = access()
    await grantVenue(await addStaff(phone), venue, active)
    await expect(resolve(phone)).resolves.toEqual({ registered: false, soleStaffId: null })
  })

  it('rejects a venue assignment in an organization the employee left', async () => {
    const phone = freshPhone()
    const staffId = await addStaff(phone)
    await grantVenue(staffId)
    await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER', isActive: false, leftAt: new Date() } })
    await expect(resolve(phone)).resolves.toEqual({ registered: false, soleStaffId: null })
  })

  it('accepts an active organization owner without a venue assignment', async () => {
    const phone = freshPhone()
    const staffId = await addStaff(phone)
    await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'OWNER' } })
    await expect(resolve(phone)).resolves.toEqual({ registered: true, soleStaffId: staffId })
  })

  // T-B40: el panel sólo muestra las sucursales heredadas por la organización mientras están activas. La copia en SQL de la regla
  // (la consulta de candidatos) ya la deja fuera, sin esperar a que listSupportVenues la confirme: si las dos se separan, esto falla.
  it('rejects an organization owner without a venue assignment whose venues are all suspended, already in the candidate query', async () => {
    const phone = freshPhone()
    const staffId = await addStaff(phone)
    await prisma.staffOrganization.create({ data: { staffId, organizationId: suspendedOrgId, role: 'OWNER' } })
    const { result, batches } = await resolveCapturingRows(phone)
    expect(result).toEqual({ registered: false, soleStaffId: null })
    expect(batches[0]).toEqual([])
  })

  it('accepts an active superadmin, even when the assignment lives in a closed venue', async () => {
    const phone = freshPhone()
    const staffId = await addStaff(phone)
    await grantVenue(staffId, closedVenueId, true, 'SUPERADMIN')
    await expect(resolve(phone)).resolves.toEqual({ registered: true, soleStaffId: staffId })
  })

  it('does not name a sole employee when two current accounts share the phone', async () => {
    const phone = freshPhone()
    await grantVenue(await addStaff(phone))
    await grantVenue(await addStaff(phone))
    await expect(resolve(phone)).resolves.toEqual({ registered: true, soleStaffId: null })
  })

  it('finds the one current account among five without access', async () => {
    const phone = freshPhone()
    await addStaffBatch(phone, 5)
    const current = await addStaff(phone)
    await grantVenue(current)
    await expect(resolve(phone)).resolves.toEqual({ registered: true, soleStaffId: current })
  })

  it('does not let thirty accounts without access hide the current one behind the row limit', async () => {
    const phone = freshPhone()
    await addStaffBatch(phone, 30)
    const current = await addStaff(phone)
    await grantVenue(current)
    const { result, batches } = await resolveCapturingRows(phone)
    expect(result).toEqual({ registered: true, soleStaffId: current })
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(1)
  })

  it('caps the candidate query at 20 rows when more current accounts share the phone', async () => {
    const phone = freshPhone()
    const ids = await addStaffBatch(phone, 25)
    await prisma.staffVenue.createMany({ data: ids.map(staffId => ({ staffId, venueId, role: 'VIEWER' as const })) })
    const { result, batches } = await resolveCapturingRows(phone)
    expect(result).toEqual({ registered: true, soleStaffId: null })
    expect(batches[0]).toHaveLength(20)
  })

  describe('without a matching employee phone', () => {
    const addLink = (staffId: string, phone: string, expiresAt: Date) =>
      prisma.supportWhatsappLink.create({ data: { staffId, phone, expiresAt } })
    const inAMonth = () => new Date(Date.now() + 30 * 86_400_000)

    it('accepts a current personal link', async () => {
      const phone = freshPhone()
      const staffId = await addStaff(null)
      await grantVenue(staffId)
      await addLink(staffId, phone, inAMonth())
      await expect(resolve(phone)).resolves.toEqual({ registered: true, soleStaffId: staffId })
    })

    it('rejects the link of an active account that was removed from every venue', async () => {
      const phone = freshPhone()
      const staffId = await addStaff(null)
      await grantVenue(staffId)
      await addLink(staffId, phone, inAMonth())
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await expect(resolve(phone)).resolves.toEqual({ registered: false, soleStaffId: null })
    })

    it('rejects an expired personal link', async () => {
      const phone = freshPhone()
      await addLink(await addStaff(null), phone, new Date(Date.now() - 1000))
      await expect(resolve(phone)).resolves.toEqual({ registered: false, soleStaffId: null })
    })

    it('rejects a personal link whose account was switched off', async () => {
      const phone = freshPhone()
      await addLink(await addStaff(null, false), phone, inAMonth())
      await expect(resolve(phone)).resolves.toEqual({ registered: false, soleStaffId: null })
    })
  })
})

it('the migrations leave both partial lookup indexes valid', async () => {
  const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string; valid: boolean }[]>`
    SELECT i.indexname, i.indexdef, x.indisvalid AS valid
    FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname JOIN pg_index x ON x.indexrelid = c.oid
    WHERE i.indexname IN ('Staff_phone_last10_idx', 'Venue_whatsappOptInPhone_idx')
    ORDER BY i.indexname`
  expect(rows.map(r => [r.indexname, r.valid])).toEqual([
    ['Staff_phone_last10_idx', true],
    ['Venue_whatsappOptInPhone_idx', true],
  ])
  expect(rows[0].indexdef).toContain(`"right"(regexp_replace(phone, '\\D'::text, ''::text, 'g'::text), 10)`)
  expect(rows[0].indexdef).toContain('WHERE (phone IS NOT NULL)')
})

describe('isRelayOperatorPhone', () => {
  it.each(['+52', '+521'])('recognizes a RELAY venue opted in as %s…', async prefix => {
    const phone = freshPhone()
    await addRelayVenue(`${prefix}${phone.slice(3)}`, 'RELAY')
    await expect(isRelay(phone)).resolves.toBe(true)
  })

  it('stays true when the venue has only closed chat sessions', async () => {
    const phone = freshPhone()
    const relayVenue = await addRelayVenue(phone, 'RELAY')
    await prisma.venueChatSession.create({
      data: {
        shortCode: cuid(),
        venueId: relayVenue,
        customerName: 'Cliente',
        requestFingerprintHash: 'hash',
        accessTokenHash: 'hash',
        status: 'CLOSED_BY_INACTIVITY',
        closedAt: new Date(),
      },
    })
    await expect(isRelay(phone)).resolves.toBe(true)
  })

  it('is false for a venue on the wa.me fallback', async () => {
    const phone = freshPhone()
    await addRelayVenue(phone, 'WA_ME_FALLBACK')
    await expect(isRelay(phone)).resolves.toBe(false)
  })

  it('is false for a phone no venue opted in with', async () => {
    await expect(isRelay(freshPhone())).resolves.toBe(false)
  })
})
