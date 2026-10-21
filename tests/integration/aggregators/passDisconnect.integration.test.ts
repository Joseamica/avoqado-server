/**
 * Integration (REAL DB) — conector de pases: desconectar nunca se queda esperando algo que nadie hará (C5 / P1-5).
 *
 * Lo que los mocks no pueden probar: el SQL que distingue una baja abandonada (DEAD_LETTER sin otra en camino) de una
 * pendiente, y que la bandeja NO junte una fila DEAD_LETTER con trabajo nuevo (nace otra y se reintenta).
 * Datos inventados; sin llaves reales.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { disconnectPassProvider } from '@/services/aggregators/passIntegrations.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const RUN = Date.now()

describe('Conector de pases — desconectar con bajas fallidas (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let connId: string
  let sessionId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Pases Desconectar Org', email: `itest-pases-disc-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Pases Desconectar',
        slug: `itest-pases-disc-${RUN}`,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-disc-${RUN}` } })
    const product = await prisma.product.create({
      data: {
        venueId: venue.id,
        sku: `DISC-${RUN}`,
        name: 'Barre',
        type: 'CLASS',
        categoryId: category.id,
        price: new Prisma.Decimal(180),
      },
    })
    const startsAt = new Date(Date.now() + 48 * 3600_000)
    sessionId = (
      await prisma.classSession.create({
        data: {
          venueId: venue.id,
          productId: product.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600_000),
          duration: 60,
          capacity: 10,
        },
      })
    ).id
    const c = await prisma.aggregatorConnection.create({
      data: {
        venueId: venue.id,
        provider: 'TOTALPASS',
        externalPlaceId: `place-disc-${RUN}`,
        webhookToken: `tok-disc-${RUN}`,
        status: 'ACTIVE',
      },
    })
    connId = c.id
    // Ya desligada (el primer clic de Desconectar), pero su ocurrencia sigue viva allá y su baja murió (DEAD_LETTER).
    await prisma.aggregatorSessionLink.create({
      data: {
        connectionId: c.id,
        venueId: venue.id,
        classSessionId: sessionId,
        externalOccurrenceId: `occ-disc-${RUN}`,
        publishedStartsAt: startsAt,
        live: true,
      },
    })
    await prisma.aggregatorOutbox.create({
      data: {
        venueId: venue.id,
        connectionId: c.id,
        operation: 'SYNC_SESSION',
        classSessionId: sessionId,
        coalesceKey: `SYNC_SESSION:${c.id}:${sessionId}`,
        status: 'DEAD_LETTER',
        attempts: 6,
        lastError: 'HTTP_500: caído',
      },
    })
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueId) {
      await step(() => prisma.aggregatorOutbox.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorSessionLink.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorConnection.deleteMany({ where: { venueId } }))
      await step(() => prisma.classSession.deleteMany({ where: { venueId } }))
      await step(() => prisma.product.deleteMany({ where: { venueId } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  const rows = () =>
    prisma.aggregatorOutbox.findMany({
      where: { coalesceKey: `SYNC_SESSION:${connId}:${sessionId}` },
      select: { status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 10,
    })

  // C5 (P1-5)
  it('baja en DEAD_LETTER ⇒ el clic la re-encola y lo dice; el siguiente espera la nueva; ya dada de baja ⇒ desconecta', async () => {
    await expect(disconnectPassProvider(venueId!, 'TOTALPASS', null, new Date())).rejects.toMatchObject({
      statusCode: 409,
      code: 'PASS_DISCONNECT_BLOCKED',
      message:
        'No pudimos quitar 1 clase de TotalPass; la volvimos a intentar. Si sigue, bórrala desde su portal y vuelve a presionar Desconectar.',
    })
    expect((await rows()).map(r => r.status)).toEqual(['DEAD_LETTER', 'PENDING'])
    expect((await prisma.aggregatorConnection.findUniqueOrThrow({ where: { id: connId } })).status).toBe('ACTIVE')

    // Segundo clic con la baja nueva todavía en camino: espera (sin otra fila: se junta con la PENDING).
    await expect(disconnectPassProvider(venueId!, 'TOTALPASS', null, new Date())).rejects.toMatchObject({
      code: 'PASS_DISCONNECT_BLOCKED',
      message: 'Todavía no se puede desconectar TotalPass: 1 clase todavía publicada (espera unos minutos a que se dé de baja).',
    })
    expect((await rows()).map(r => r.status)).toEqual(['DEAD_LETTER', 'PENDING'])

    // El worker la dio de baja: el siguiente clic desconecta.
    await prisma.aggregatorSessionLink.updateMany({ where: { connectionId: connId }, data: { live: false } })
    await expect(disconnectPassProvider(venueId!, 'TOTALPASS', null, new Date())).resolves.toBeUndefined()
    expect(await prisma.aggregatorConnection.findUniqueOrThrow({ where: { id: connId } })).toMatchObject({
      status: 'REVOKED',
      credentialCiphertext: null,
      externalPlaceId: null,
    })
  })
})
