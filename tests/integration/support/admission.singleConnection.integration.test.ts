jest.mock('@/utils/prismaClient', () => {
  const { PrismaClient } = jest.requireActual('@prisma/client')
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('connection_limit', '1')
  url.searchParams.set('pool_timeout', '1')
  return { __esModule: true, default: new PrismaClient({ datasources: { db: { url: url.toString() } } }) }
})
import prisma from '@/utils/prismaClient'
import { tryRouteSupport } from '@/services/support/router.service'

const receiverId = `support-single-${Date.now()}`,
  phone = '+525500006001'
it('finishes linked app and venue selection using a single connection, without nested global queries', async () => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
  })
  const org = await prisma.organization.create({ data: { name: 'Pool fixture', email: `${receiverId}@test.local`, phone: '0000000000' } })
  const venue = await prisma.venue.create({ data: { organizationId: org.id, name: 'Pool fixture', slug: receiverId, status: 'ACTIVE' } })
  const staff = await prisma.staff.create({ data: { email: `${receiverId}@test.local`, firstName: 'Pool', lastName: 'Prueba' } })
  const input = (body: string, serial: number) => ({
    receiverId,
    phone,
    wamid: `${receiverId}-${serial}`,
    body,
    type: 'text',
    timestamp: String(Date.now() / 1000),
  })
  try {
    await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'VIEWER' } })
    await prisma.supportWhatsappLink.create({ data: { staffId: staff.id, phone, expiresAt: new Date(Date.now() + 86400000) } })
    await tryRouteSupport(input('AYUDA', 1))
    await tryRouteSupport(input('CONTINUAR', 2))
    await expect(tryRouteSupport(input('2', 3))).resolves.toBe('QUEUED')
    await expect(tryRouteSupport(input('1', 4))).resolves.toBe('QUEUED')
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId } })).toMatchObject({
      mode: 'PERSONAL',
      app: 'android',
      venueId: venue.id,
      pendingSelection: null,
    })
  } finally {
    await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
    await prisma.supportConversation.deleteMany({ where: { receiverId } })
    await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
    await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId: staff.id } })
    await prisma.staffVenue.deleteMany({ where: { staffId: staff.id } })
    await prisma.staff.delete({ where: { id: staff.id } })
    await prisma.venue.delete({ where: { id: venue.id } })
    await prisma.organization.delete({ where: { id: org.id } })
    await prisma.$disconnect()
  }
})
