import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import { persistUberWebhookEvent } from '@/services/delivery-channels/providers/uber-eats/uber.webhookIngress'

// Prueba DURABLE con PostgreSQL real: los proyectos unit/api-tests mockean Prisma
// globalmente, así que el @unique de dedup NO se probaría ahí (auditoría Codex).
// Correr: TEST_DATABASE_URL=... npx jest --selectProjects integration --testPathPattern uberWebhookIngress
describe('uber webhook ingress (durable)', () => {
  const KEY = 'llave-de-prueba-integration'
  const mkBody = (eventId: string, storeId = 'store-uber-1', orderId = 'order-1') =>
    Buffer.from(
      JSON.stringify({
        event_id: eventId,
        event_type: 'orders.notification',
        event_time: 1_700_000_000,
        meta: { resource_id: orderId, user_id: storeId, status: 'pos' },
      }),
    )
  const sign = (b: Buffer) => crypto.createHmac('sha256', KEY).update(b).digest('hex')
  const ids: string[] = []

  afterAll(async () => {
    if (ids.length) await prisma.deliveryOrderEvent.deleteMany({ where: { dedupKey: { in: ids } } })
  })

  it('firma inválida ⇒ rechaza y NO persiste nada', async () => {
    const body = mkBody('evt-firma-mala')
    const r = await persistUberWebhookEvent({ rawBody: body, signatureHeader: 'f'.repeat(64), signingKeys: [KEY] })
    expect(r.outcome).toBe('INVALID_SIGNATURE')
    expect(await prisma.deliveryOrderEvent.count({ where: { dedupKey: 'UBER_EATS:evt-firma-mala' } })).toBe(0)
  })

  it('tienda desconocida ⇒ persiste con venue y link NULOS (nunca se pierde el pedido)', async () => {
    const id = `evt-sin-link-${Date.now()}`
    ids.push(`UBER_EATS:${id}`)
    const body = mkBody(id, 'store-que-no-existe')
    const r = await persistUberWebhookEvent({ rawBody: body, signatureHeader: sign(body), signingKeys: [KEY] })
    expect(r.outcome).toBe('PERSISTED')
    const row = await prisma.deliveryOrderEvent.findUnique({ where: { dedupKey: `UBER_EATS:${id}` } })
    expect(row).not.toBeNull()
    expect(row!.venueId).toBeNull()
    expect(row!.channelLinkId).toBeNull()
    expect(row!.externalOrderId).toBe('order-1')
  })

  it('dos entregas concurrentes del MISMO event_id ⇒ UNA sola fila (el unique manda)', async () => {
    const id = `evt-concurrente-${Date.now()}`
    ids.push(`UBER_EATS:${id}`)
    const body = mkBody(id)
    const sig = sign(body)
    const rs = await Promise.all(
      Array.from({ length: 4 }, () => persistUberWebhookEvent({ rawBody: body, signatureHeader: sig, signingKeys: [KEY] })),
    )
    expect(rs.filter(r => r.outcome === 'PERSISTED')).toHaveLength(1)
    expect(rs.filter(r => r.outcome === 'DUPLICATE')).toHaveLength(3)
    expect(await prisma.deliveryOrderEvent.count({ where: { dedupKey: `UBER_EATS:${id}` } })).toBe(1)
  })

  it('acepta la llave SECUNDARIA (ventana de rotación de Uber)', async () => {
    const id = `evt-rotacion-${Date.now()}`
    ids.push(`UBER_EATS:${id}`)
    const body = mkBody(id)
    const nueva = 'llave-nueva'
    const sig = crypto.createHmac('sha256', nueva).update(body).digest('hex')
    const r = await persistUberWebhookEvent({ rawBody: body, signatureHeader: sig, signingKeys: [KEY, nueva] })
    expect(r.outcome).toBe('PERSISTED')
  })
})
