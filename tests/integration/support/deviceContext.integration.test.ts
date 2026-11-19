import type { SupportConversation } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { resolveSupportDeviceContext } from '@/services/support/deviceContext.service'

// R1-06: the version and the terminal family come from the conversation or from the live devices of ONE venue.
const tag = `support-device-${Date.now()}`
const cashierPhone = '+525500007501',
  ownerPhone = '+525500007502'
let orgId: string
const venues: Record<string, string> = {}
const staff: string[] = []
const now = new Date()
const conversation = (data: Partial<SupportConversation>): SupportConversation =>
  ({
    id: `${tag}-conversation`,
    mode: 'PUBLIC',
    phone: cashierPhone,
    app: 'tpv',
    appVersion: null,
    deviceFamily: null,
    venueId: null,
    ...data,
  }) as SupportConversation
const terminal = (venue: string, brand: string | null, version: string | null, extra = {}) => ({
  venueId: venues[venue],
  name: `${brand} ${version}`,
  type: 'TPV_ANDROID' as const,
  brand,
  version,
  lastHeartbeat: now,
  ...extra,
})

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: 'Device fixture', email: `${tag}@test.local`, phone: '0' } })).id
  for (const name of ['pax1', 'pax2', 'pax3', 'nexgo', 'mixed', 'many', 'old'])
    venues[name] = (
      await prisma.venue.create({ data: { organizationId: orgId, name: `${tag} ${name}`, slug: `${tag}-${name}`, status: 'ACTIVE' } })
    ).id
  // A cashier in four venues (three PAX, one Nexgo) and an owner with only one.
  const cashier = await prisma.staff.create({
    data: { email: `${tag}-cashier@test.local`, firstName: 'Cajera', lastName: 'Cuatro', phone: cashierPhone },
  })
  const owner = await prisma.staff.create({
    data: { email: `${tag}-owner@test.local`, firstName: 'Dueña', lastName: 'Una', phone: ownerPhone },
  })
  staff.push(cashier.id, owner.id)
  await prisma.staffVenue.createMany({
    data: [
      ...['pax1', 'pax2', 'pax3', 'nexgo'].map(v => ({ staffId: cashier.id, venueId: venues[v], role: 'CASHIER' as const })),
      { staffId: owner.id, venueId: venues.pax1, role: 'CASHIER' },
    ],
  })
  await prisma.terminal.createMany({
    data: [
      terminal('pax1', 'PAX', '2.16.0'),
      terminal('pax2', 'PAX', '2.16.0'),
      terminal('pax3', 'PAX', '2.15.1'),
      terminal('nexgo', 'NEXGO', '2.16.0-nexgo-prod'),
      terminal('mixed', 'PAX', '2.16.0'),
      terminal('mixed', 'NEXGO', '2.15.1-nexgo-prod'),
      // 21 distinct groups, all PAX: without the cap the family would look certain.
      ...Array.from({ length: 21 }, (_, i) => terminal('many', 'PAX', `2.${i}.0`)),
      terminal('old', 'NEXGO', '2.13.2-nexgo-prod'),
      // A device not seen in 30 days does not count.
      terminal('old', 'PAX', '2.10.0', { lastHeartbeat: new Date(now.getTime() - 31 * 86400_000) }),
    ],
  })
})
afterAll(async () => {
  if (!orgId) return
  await prisma.terminal.deleteMany({ where: { venueId: { in: Object.values(venues) } } })
  await prisma.staffVenue.deleteMany({ where: { staffId: { in: staff } } })
  await prisma.staff.deleteMany({ where: { id: { in: staff } } })
  await prisma.venue.deleteMany({ where: { organizationId: orgId } })
  await prisma.organization.delete({ where: { id: orgId } })
})

describe('resolveSupportDeviceContext', () => {
  it('a registered cashier with 4 venues (3 PAX, 1 Nexgo) deduces nothing', async () => {
    expect(await resolveSupportDeviceContext(conversation({}), now)).toEqual({})
  })

  it('a registered phone with only one venue deduces from that venue', async () => {
    expect(await resolveSupportDeviceContext(conversation({ phone: ownerPhone }), now)).toEqual({ version: '2.16.0', family: 'PAX' })
  })

  it('personal conversation on the Nexgo venue deduces NEXGO', async () => {
    expect(await resolveSupportDeviceContext(conversation({ mode: 'PERSONAL', venueId: venues.nexgo }), now)).toEqual({
      version: '2.16.0',
      family: 'NEXGO',
    })
  })

  it('one venue with PAX and Nexgo deduces nothing', async () => {
    expect(await resolveSupportDeviceContext(conversation({ mode: 'PERSONAL', venueId: venues.mixed }), now)).toEqual({})
  })

  it('21 device groups count as truncated and deduce nothing', async () => {
    const many = conversation({ mode: 'PERSONAL', venueId: venues.many })
    expect(await resolveSupportDeviceContext(many, now)).toEqual({})
    // With 20 groups the one family they share is deduced.
    const last = await prisma.terminal.findFirstOrThrow({ where: { venueId: venues.many, version: '2.20.0' } })
    await prisma.terminal.update({ where: { id: last.id }, data: { version: '2.19.0' } })
    expect(await resolveSupportDeviceContext(many, now)).toEqual({ family: 'PAX' })
  })

  it('a venue whose only terminal reports 2.13.2-nexgo-prod deduces 2.13.2', async () => {
    expect(await resolveSupportDeviceContext(conversation({ mode: 'PERSONAL', venueId: venues.old }), now)).toEqual({
      version: '2.13.2',
      family: 'NEXGO',
    })
  })

  it("the conversation's own version wins over the devices", async () => {
    const own = conversation({ mode: 'PERSONAL', venueId: venues.old, appVersion: '2.19.0', deviceFamily: 'PAX' })
    expect(await resolveSupportDeviceContext(own, now)).toEqual({ version: '2.19.0', family: 'PAX' })
    expect(await resolveSupportDeviceContext({ ...own, deviceFamily: null }, now)).toEqual({ version: '2.19.0', family: 'NEXGO' })
  })

  it('other apps only read their own devices, and a closed or unchosen conversation deduces nothing', async () => {
    expect(await resolveSupportDeviceContext(conversation({ mode: 'PERSONAL', venueId: venues.old, app: 'android' }), now)).toEqual({})
    expect(await resolveSupportDeviceContext(conversation({ mode: 'PERSONAL', venueId: null }), now)).toEqual({})
    expect(await resolveSupportDeviceContext(conversation({ mode: 'CLOSED', phone: ownerPhone }), now)).toEqual({})
    expect(await resolveSupportDeviceContext(conversation({ phone: '+525500007599' }), now)).toEqual({})
  })
})
