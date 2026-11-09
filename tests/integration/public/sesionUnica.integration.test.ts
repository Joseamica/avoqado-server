import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: new Proxy({}, { get: () => jest.fn(async () => true) }) }))
// El dominio se ejecuta completo; no hay banco, correo ni otro servicio de red en este recorrido.
const RUN = Date.now()
const SECRET = process.env.ACCESS_TOKEN_SECRET!
const PHONE = '+525543453965'
let orgId: string | undefined
let venueId: string | undefined
let productId: string
let seq = 0
const slug = `itest-sesion-${RUN}`
const url = (suffix: string) => `/api/v1/public/venues/${slug}/${suffix}`
const claims = (id: string, extra: Record<string, unknown> = {}) =>
  jwt.sign(
    {
      sub: id,
      venueId,
      type: 'customer_session',
      v: 0,
      contactos: [{ tipo: 'PHONE', valor: PHONE, metodo: 'WHATSAPP', probadoEn: Math.floor(Date.now() / 1000) - 200_000 }],
      ...extra,
    },
    SECRET,
    { algorithm: 'HS256', expiresIn: '30d' },
  )
const nueva = (extra = {}) =>
  prisma.customer.create({
    data: {
      venueId: venueId!,
      firstName: `Ana${++seq}`,
      phone: PHONE,
      email: `ana-${RUN}-${seq}@ejemplo.mx`,
      ...extra,
    },
  })
const reserva = () => {
  const startsAt = new Date(Date.now() + 7 * 86_400_000)
  startsAt.setUTCHours(18, 0, 0, 0)
  return {
    guestName: 'Ana',
    guestPhone: PHONE,
    guestEmail: `ana-${RUN}@ejemplo.mx`,
    productId,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    duration: 60,
    partySize: 1,
  }
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'ITEST Sesión', phone: '5550000000', email: `sesion-${RUN}@test.mx` } })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: {
      name: 'ITEST Sesión',
      slug,
      organizationId: org.id,
      timezone: 'America/Mexico_City',
      status: 'ACTIVE',
      seatCapExempt: true,
    },
  })
  venueId = venue.id
  await prisma.reservationSettings.create({
    data: { venueId, publicBookingEnabled: true, requireAccount: true, requireCustomerApproval: true },
  })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Servicios', slug: `servicios-${RUN}` } })
  productId = (
    await prisma.product.create({
      data: { venueId, categoryId: cat.id, name: 'Servicio', sku: `S6-${RUN}`, price: 100, availableOnline: true },
    })
  ).id
})
afterEach(async () => {
  if (!venueId) return
  await prisma.reservation.deleteMany({ where: { venueId } })
  await prisma.slotHold.deleteMany({ where: { venueId } })
  await prisma.customerApprovalOutbox.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
})
afterAll(async () => {
  if (!venueId) return
  await prisma.onlineOrderingSettings.deleteMany({ where: { venueId } })
  await prisma.reservationSettings.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('CORS aplicado por el router público expone renovación incluso en 401', async () => {
  const res = await request(app).get(url('customer/portal')).set('Origin', 'https://book.avoqado.io')
  expect(res.status).toBe(401)
  expect(res.headers['access-control-expose-headers']?.toLowerCase().split(',')).toContain('x-customer-session')
})

it('sesión que entró sólo a pedir: quote real no activa; reservar activa PENDING y rechaza sin reservar', async () => {
  const c = await nueva()
  const token = claims(c.id)
  const quote = await request(app)
    .post(url('ordering/quote'))
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId, quantity: 1 }] })
  expect(quote.status).toBe(200)
  expect(quote.body.success).toBe(true)
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).accountActivatedAt).toBeNull()
  const res = await request(app).post(url('reservations')).set('Authorization', `Bearer ${token}`).send(reserva())
  expect(res.status).toBe(403)
  expect(res.body.code).toBe('CUSTOMER_APPROVAL_PENDING')
  expect(await prisma.customer.findUnique({ where: { id: c.id } })).toMatchObject({
    approvalStatus: 'PENDING',
    accountActivatedAt: expect.any(Date),
  })
  expect(await prisma.customerApprovalOutbox.count({ where: { customerId: c.id } })).toBe(2)
  expect(await prisma.reservation.count({ where: { venueId } })).toBe(0)
})
it('dos portales simultáneos activan una sola vez; leer PENDING sigue permitido', async () => {
  const c = await nueva()
  const results = await Promise.all(
    [1, 2].map(() =>
      request(app)
        .get(url('customer/portal'))
        .set('Authorization', `Bearer ${claims(c.id)}`),
    ),
  )
  for (const res of results) {
    expect(res.status).toBe(200)
    expect(res.body.bookingAccess).toMatchObject({ status: 'PENDING', canCreateReservation: false })
  }
  expect(await prisma.customerApprovalOutbox.count({ where: { customerId: c.id } })).toBe(2)
})
it('una cuenta activada y aprobada no regresa a PENDING al reservar', async () => {
  const activated = new Date(Date.now() - 1_000_000)
  const c = await nueva({ accountActivatedAt: activated, approvalStatus: 'APPROVED' })
  const res = await request(app)
    .post(url('reservations'))
    .set('Authorization', `Bearer ${claims(c.id)}`)
    .send(reserva())
  expect(res.status).toBe(201)
  expect(await prisma.customer.findUnique({ where: { id: c.id } })).toMatchObject({
    approvalStatus: 'APPROVED',
    accountActivatedAt: activated,
  })
  expect(await prisma.reservation.count({ where: { customerId: c.id } })).toBe(1)
  expect(await prisma.customerApprovalOutbox.count({ where: { customerId: c.id } })).toBe(0)
})
it('preaprobada explícita se activa sin volver a pedir aprobación', async () => {
  const c = await nueva({ approvalDecidedAt: new Date(), approvalStatus: 'APPROVED' })
  const res = await request(app)
    .get(url('customer/portal'))
    .set('Authorization', `Bearer ${claims(c.id)}`)
  expect(res.status).toBe(200)
  expect(res.body.bookingAccess).toMatchObject({ status: 'APPROVED' })
  expect(await prisma.customerApprovalOutbox.count({ where: { customerId: c.id } })).toBe(0)
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).accountActivatedAt).not.toBeNull()
})
it('renovación efectiva: router público expone el token al navegador y da otros 30 días', async () => {
  const c = await nueva({ accountActivatedAt: new Date() })
  const iat = Math.floor(Date.now() / 1000) - 86_401
  const res = await request(app)
    .get(url('customer/portal'))
    .set('Origin', 'https://book.avoqado.io')
    .set('Authorization', `Bearer ${claims(c.id, { iat })}`)
  expect(res.status).toBe(200)
  expect(res.headers['access-control-allow-origin']).toBe('*')
  expect(res.headers['access-control-expose-headers']?.toLowerCase().split(',')).toContain('x-customer-session')
  const token = jwt.verify(res.headers['x-customer-session'], SECRET) as jwt.JwtPayload
  expect(token.iat).toBeGreaterThan(iat)
  expect(token.exp! - token.iat!).toBe(2_592_000)
  expect(token.v).toBe(0)
})
it('versionDeSesion en Postgres corta sesión y ambos legacy, incluso con v adicional', async () => {
  const c = await nueva({ versionDeSesion: 1, accountActivatedAt: new Date() })
  for (const type of ['customer_session', 'customer', 'customer_ordering']) {
    const extra = type === 'customer_ordering' ? { verifiedPhone: PHONE } : {}
    const res = await request(app)
      .post(url('ordering/quote'))
      .set('Authorization', `Bearer ${claims(c.id, { type, v: type === 'customer_session' ? 0 : 99, ...extra })}`)
      .send({ items: [{ productId, quantity: 1 }] })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_TOKEN_INVALID')
  }
})
it('contacto cambiado en ficha revoca; formato mexicano equivalente no revoca', async () => {
  const c = await nueva({ phone: '+5215543453965', accountActivatedAt: new Date() })
  const token = claims(c.id)
  const before = await request(app).get(url('credit-packs/balance')).set('Authorization', `Bearer ${token}`)
  expect(before.status).toBe(200)
  await prisma.customer.update({ where: { id: c.id }, data: { phone: '+525511112222' } })
  const after = await request(app).get(url('credit-packs/balance')).set('Authorization', `Bearer ${token}`)
  expect(after.status).toBe(401)
  expect(after.body.code).toBe('CUSTOMER_TOKEN_INVALID')
})

// express-async-errors envuelve cada handle: se comprueba la cadena declarada por AST, y su efecto arriba por HTTP/PG reales.
it.each([
  [
    'post',
    '/venues/:venueSlug/reservations',
    [
      'writeLimit',
      'resolveVenueBySlug',
      'authenticateCustomerOptional',
      'activarReservasSiFalta',
      'requireReservationsPlan',
      'validateRequest',
      'reservationPublicController.createReservation',
    ],
  ],
  [
    'post',
    '/venues/:venueSlug/reservations/hold',
    [
      'writeLimit',
      'resolveVenueBySlug',
      'authenticateCustomerOptional',
      'activarReservasSiFalta',
      'requireReservationsPlan',
      'validateRequest',
      'reservationPublicController.createHold',
    ],
  ],
  [
    'post',
    '/venues/:venueSlug/reservations/:cancelSecret/reschedule',
    [
      'cancelLimit',
      'resolveVenueBySlug',
      'authenticateCustomerOptional',
      'activarReservasSiFalta',
      'validateRequest',
      'reservationPublicController.rescheduleReservation',
    ],
  ],
  [
    'get',
    '/venues/:venueSlug/credit-packs/balance',
    [
      'readLimit',
      'resolveVenueBySlug',
      'authenticateCustomer',
      'activarReservasSiFalta',
      'validateRequest',
      'creditPackPublicController.getCustomerBalance',
    ],
  ],
  [
    'post',
    '/venues/:venueSlug/credit-packs/:packId/checkout',
    [
      'writeLimit',
      'resolveVenueBySlug',
      'authenticateCustomerOptional',
      'activarReservasSiFalta',
      'requireReservationsPlan',
      'validateRequest',
      'creditPackPublicController.createCheckout',
    ],
  ],
  [
    'post',
    '/venues/:venueSlug/customer/checkin/:challengeId',
    [
      'kioskCheckInCors',
      'writeLimit',
      'resolveVenueBySlug',
      'authenticateCustomer',
      'activarReservasSiFalta',
      'kioskCheckInController.consumeChallenge',
    ],
  ],
  [
    'get',
    '/venues/:venueSlug/customer/portal',
    ['readLimit', 'resolveVenueBySlug', 'authenticateCustomer', 'activarReservasSiFalta', 'customerPortalController.getPortal'],
  ],
  [
    'patch',
    '/venues/:venueSlug/customer/profile',
    [
      'writeLimit',
      'resolveVenueBySlug',
      'authenticateCustomer',
      'activarReservasSiFalta',
      'validateRequest',
      'customerPortalController.updateProfile',
    ],
  ],
] as const)('cadena declarada %s %s conserva todos sus pasos', (method, routePath, expected) => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/public.routes.ts'), 'utf8')
  const source = ts.createSourceFile('public.routes.ts', text, ts.ScriptTarget.Latest, true)
  const routes: string[][] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === 'router' &&
      node.expression.name.text === method &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === routePath
    ) {
      routes.push(node.arguments.slice(1).map(arg => (ts.isCallExpression(arg) ? arg.expression.getText(source) : arg.getText(source))))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(routes).toEqual([expected])
})
