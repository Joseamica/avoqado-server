import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import bcrypt from 'bcryptjs'
import { hashOtpCode } from '@/lib/otp'
import { firmarPruebaPendiente, ligarContacto } from '@/services/public/sesionDeCliente.service'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { updateCustomer } from '@/services/dashboard/customer.dashboard.service'
import logger from '@/config/logger'
import { OAuth2Client } from 'google-auth-library'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: new Proxy({}, { get: () => jest.fn(async () => true) }) }))
// S7: ni WhatsApp ni Google salen a la red (Google, abajo: sólo `verifyIdToken`; la app completa usa el resto de la librería).
jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendOtpWhatsApp: jest.fn(async () => undefined) }))
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
  await prisma.otpChallenge.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.consumer.deleteMany({ where: { OR: [{ phone: { in: telefonosS7 } }, { email: { endsWith: `-${RUN}@s7.mx` } }] } })
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
  ['post', '/venues/:venueSlug/auth/session/nueva-ficha', ['authLimit', 'validateRequest', 'otpAuthController.crearFichaNueva']],
  ['post', '/venues/:venueSlug/auth/google', ['authLimit', 'validateRequest', 'otpAuthController.entrarConGoogle']],
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

// ==================== S7 (P2-1): entrar con WhatsApp, correo o Google; «¿ya eres cliente?»; reservas de invitada ====================

const sufijo = String(RUN).slice(-8)
const telS7 = (n: number) => `+5256${String((Number(sufijo) + n) % 100_000_000).padStart(8, '0')}`
const telefonosS7 = [1, 2, 3, 4, 5, 6, 7].map(telS7)
const correoS7 = (n: string) => `${n}-${RUN}@s7.mx`
const CODIGO = '123456'
// Cada petición de S7 viene de otro visitante: los límites por IP (`authLimit` 10/min, `readLimit` 60/min) no son lo que se prueba.
let visitas = 0
const visitante = () => `10.77.${Math.floor(++visitas / 250)}.${visitas % 250}`
const post = (suffix: string) => request(app).post(url(suffix)).set('cf-connecting-ip', visitante())
const get = (suffix: string) => request(app).get(url(suffix)).set('cf-connecting-ip', visitante())
const patch = (suffix: string) => request(app).patch(url(suffix)).set('cf-connecting-ip', visitante())
const mockGoogle = jest.spyOn(OAuth2Client.prototype, 'verifyIdToken') as unknown as jest.Mock

/** El reto que `auth/otp/request` habría dejado, sin mandar nada. */
const reto = (channel: 'whatsapp' | 'email', destination: string) =>
  prisma.otpChallenge.create({
    data: { venueId: venueId!, channel, destination, codeHash: hashOtpCode(CODIGO), expiresAt: new Date(Date.now() + 600_000) },
  })
const verificar = (body: Record<string, unknown>) => post('auth/otp/verify').send({ code: CODIGO, purpose: 'SESSION', ...body })
/** La autoridad: el middleware REAL de S6 contra la ficha REAL. */
const sirve = (token: string) => get('customer/portal').set('Authorization', `Bearer ${token}`)
const ficha = (data: Record<string, unknown>) =>
  prisma.customer.create({ data: { venueId: venueId!, firstName: `S7-${++seq}`, accountActivatedAt: new Date(), ...data } })
const pruebaDe = (valor: string) =>
  firmarPruebaPendiente(venueId!, { tipo: 'PHONE', valor, metodo: 'WHATSAPP', probadoEn: Math.floor(Date.now() / 1000) - 60 })
const reservaDeInvitada = (extra: { guestEmail?: string; guestPhone?: string; customerId?: string }) => {
  const startsAt = new Date(Date.now() + 10 * 86_400_000)
  return prisma.reservation.create({
    data: {
      venueId: venueId!,
      productId,
      confirmationCode: `S7-${RUN}-${++seq}`,
      status: 'CONFIRMED',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      duration: 60,
      blockedEndsAt: new Date(startsAt.getTime() + 3_600_000),
      partySize: 1,
      guestName: 'Invitada',
      ...extra,
    },
  })
}
/** Espera a que otra conexión de ESTA base quede esperando un candado (la segunda transacción de la carrera). */
async function hastaQueEspere() {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`
    if (n > 0) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('la segunda transacción nunca quedó esperando el candado')
}

describe('S7 · entrar con la sesión única', () => {
  it('una ficha que sólo tenía correo entra por WhatsApp, dice «sí», prueba su correo y ve sus puntos en la MISMA ficha', async () => {
    const correo = correoS7('solo-correo')
    const a = await ficha({ email: correo, loyaltyPoints: 70 })
    await reto('whatsapp', telS7(1))
    const paso1 = await verificar({ phone: telS7(1), alNoEncontrar: 'PREGUNTAR' })
    expect(paso1.status).toBe(200)
    expect(paso1.body).toEqual({ fichaNueva: true, pruebaPendiente: expect.any(String) })
    // «¿ya eres cliente?» no crea nada: ni ficha ni identidad global; el reto sí quedó usado.
    expect(await prisma.customer.count({ where: { venueId } })).toBe(1)
    expect(await prisma.consumer.count({ where: { phone: telS7(1) } })).toBe(0)
    expect(await prisma.otpChallenge.count({ where: { venueId, destination: telS7(1), consumedAt: null } })).toBe(0)

    await reto('email', correo)
    const paso2 = await verificar({ email: correo, vincular: paso1.body.pruebaPendiente })
    expect(paso2.status).toBe(200)
    expect(paso2.body.customer).toMatchObject({ id: a.id, email: correo, phone: telS7(1) })
    expect(paso2.body.contactos.map((c: any) => [c.tipo, c.valor, c.metodo])).toEqual([
      ['EMAIL', correo, 'EMAIL_CODE'],
      ['PHONE', telS7(1), 'WHATSAPP'],
    ])
    expect(paso2.body.otraFicha).toBeNull()
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ phone: telS7(1), email: correo })
    expect(
      await prisma.activityLog.findMany({ where: { venueId, action: 'CUSTOMER_CONTACT_LINKED' }, select: { entityId: true, data: true } }),
    ).toEqual([{ entityId: a.id, data: { contacto: 'PHONE', metodo: 'WHATSAPP', valor: telS7(1) } }])

    const portal = await get('customer/portal').set('Authorization', `Bearer ${paso2.body.token}`)
    expect(portal.status).toBe(200)
    expect(portal.body.customer).toMatchObject({ id: a.id, loyaltyPoints: 70 })
    expect(portal.body.invitadaRequiereEntrar).toBe(false)
    expect(portal.headers['x-customer-session']).toBeUndefined()
  })

  it('SESSION no activa reservas: la ficha sigue sin activar después de entrar', async () => {
    const a = await ficha({ phone: telS7(2), accountActivatedAt: null })
    await reto('whatsapp', telS7(2))
    const res = await verificar({ phone: telS7(2) })
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('bookingAccess')
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      accountActivatedAt: null,
      approvalStatus: 'APPROVED',
    })
    expect(await prisma.customerApprovalOutbox.count({ where: { customerId: a.id } })).toBe(0)
    // Hasta que reserve o abra el portal (S6): ahí sí corre la activación de hoy.
    expect((await sirve(res.body.token)).status).toBe(200)
  })

  it('«no, soy nueva»: la prueba crea la ficha como hoy; repetirla da la misma ficha; un contacto escrito o de otro negocio ⇒ 400', async () => {
    const prueba = pruebaDe(telS7(3))
    const r1 = await post('auth/session/nueva-ficha').send({ pruebaPendiente: prueba, firstName: 'Lucía Pérez' })
    expect(r1.status).toBe(200)
    expect(r1.body.customer).toMatchObject({ firstName: 'Lucía', lastName: 'Pérez', phone: telS7(3) })
    expect(r1.body.contactos).toEqual([expect.objectContaining({ tipo: 'PHONE', valor: telS7(3) })])
    expect((await sirve(r1.body.token)).status).toBe(200)
    expect(await prisma.consumer.count({ where: { phone: telS7(3) } })).toBe(1)

    const r2 = await post('auth/session/nueva-ficha').send({ pruebaPendiente: prueba })
    expect(r2.body.customer.id).toBe(r1.body.customer.id)
    expect(await prisma.customer.count({ where: { venueId, phone: telS7(3) } })).toBe(1)

    const otroContacto = await post('auth/session/nueva-ficha').send({ pruebaPendiente: prueba, phone: telS7(4) })
    expect(otroContacto.status).toBe(400)
    const ajena = firmarPruebaPendiente('cvenueajenoajenoajenoajen', { tipo: 'PHONE', valor: telS7(4), metodo: 'WHATSAPP', probadoEn: 1 })
    const deOtro = await post('auth/session/nueva-ficha').send({ pruebaPendiente: ajena })
    expect(deOtro.status).toBe(400)
    expect(deOtro.body.code).toBe('CUSTOMER_PROOF_INVALID')
    expect(await prisma.customer.count({ where: { venueId, phone: telS7(4) } })).toBe(0)
  })

  it('vincular con la ficha que ya tiene OTRO teléfono: no lo pisa, avisa y la sesión sirve sin el teléfono rechazado', async () => {
    const correo = correoS7('con-otro-tel')
    const a = await ficha({ email: correo, phone: telS7(5) })
    await reto('email', correo)
    const res = await verificar({ email: correo, vincular: pruebaDe(telS7(6)) })
    expect(res.status).toBe(200)
    expect(res.body.avisos).toEqual(['FICHA_CON_OTRO_TELEFONO'])
    expect(res.body.contactos.map((c: any) => c.tipo)).toEqual(['EMAIL'])
    expect((await sirve(res.body.token)).status).toBe(200)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).phone).toBe(telS7(5))
  })

  it('teléfono en la ficha B y correo en la ficha A ⇒ no se unen: otraFicha tapada y las dos fichas intactas', async () => {
    const correo = correoS7('a-sin-tel')
    const a = await ficha({ email: correo, loyaltyPoints: 10 })
    const b = await ficha({ phone: telS7(7), loyaltyPoints: 99 })
    await reto('email', correo)
    const res = await verificar({ email: correo, vincular: pruebaDe(telS7(7)) })
    expect(res.status).toBe(200)
    expect(res.body.otraFicha).toEqual({ contacto: 'PHONE', enmascarado: expect.stringMatching(/^56•+\d{3}$/) })
    expect(res.body.contactos.map((c: any) => c.tipo)).toEqual(['EMAIL'])
    expect((await sirve(res.body.token)).status).toBe(200)
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ phone: null, loyaltyPoints: 10 })
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ phone: telS7(7), loyaltyPoints: 99 })
  })

  it('carrera: dos vinculaciones del mismo teléfono a fichas distintas ⇒ una gana, la otra recibe otraFicha (choque del único repetido)', async () => {
    const a = await ficha({ email: correoS7('carrera-a') })
    const b = await ficha({ email: correoS7('carrera-b') })
    const tel = telS7(1)
    await reto('email', correoS7('carrera-b'))
    const avisos = jest.spyOn(logger, 'warn')
    let perdedora: Promise<request.Response> | undefined
    await withDeadlockRetry(
      async tx => {
        const gana = await ligarContacto(tx, venueId!, await tx.customer.findUniqueOrThrow({ where: { id: a.id } }), {
          tipo: 'PHONE',
          valor: tel,
          metodo: 'WHATSAPP',
          probadoEn: 1,
        })
        expect(gana.ligado).toBe(true)
        // B entra mientras A no ha hecho commit: su escritura espera el índice único de A.
        perdedora = verificar({ email: correoS7('carrera-b'), vincular: pruebaDe(tel) }).then(r => r)
        await hastaQueEspere()
      },
      { etiqueta: 'carreraS7', timeout: 30_000 },
    )
    const res = await perdedora!
    expect(res.status).toBe(200)
    expect(res.body.customer.id).toBe(b.id)
    expect(res.body.otraFicha).toMatchObject({ contacto: 'PHONE' })
    expect(res.body.contactos.map((c: any) => c.tipo)).toEqual(['EMAIL'])
    expect((await sirve(res.body.token)).status).toBe(200)
    expect(avisos.mock.calls.some(([m]) => String(m).includes('choque del único de Customer'))).toBe(true)
    avisos.mockRestore()
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).phone).toBe(tel)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: b.id } })).phone).toBeNull()
    expect(await prisma.otpChallenge.count({ where: { venueId, destination: correoS7('carrera-b'), consumedAt: { not: null } } })).toBe(1)
  })

  it('carrera por HTTP: dos vinculaciones simultáneas del mismo teléfono ⇒ exactamente una ficha lo tiene y las dos sesiones sirven', async () => {
    const [a, b] = await Promise.all([ficha({ email: correoS7('par-a') }), ficha({ email: correoS7('par-b') })])
    const tel = telS7(2)
    await Promise.all([reto('email', correoS7('par-a')), reto('email', correoS7('par-b'))])
    const res = await Promise.all([
      verificar({ email: correoS7('par-a'), vincular: pruebaDe(tel) }),
      verificar({ email: correoS7('par-b'), vincular: pruebaDe(tel) }),
    ])
    for (const r of res) {
      expect(r.status).toBe(200)
      expect((await sirve(r.body.token)).status).toBe(200)
    }
    const conTel = await prisma.customer.findMany({ where: { id: { in: [a.id, b.id] }, phone: tel }, select: { id: true } })
    expect(conTel).toHaveLength(1)
    const perdio = res.find(r => r.body.customer.id !== conTel[0].id)!
    expect(perdio.body.otraFicha).toMatchObject({ contacto: 'PHONE' })
  })

  it('carrera: dos teléfonos al mismo campo vacío de UNA ficha ⇒ el primero queda, el segundo avisa y no lo pisa', async () => {
    const a = await ficha({ email: correoS7('un-campo') })
    const leida = await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })
    let segunda: Promise<Awaited<ReturnType<typeof ligarContacto>>> | undefined
    await withDeadlockRetry(
      async tx => {
        expect(
          (await ligarContacto(tx, venueId!, leida, { tipo: 'PHONE', valor: telS7(3), metodo: 'WHATSAPP', probadoEn: 1 })).ligado,
        ).toBe(true)
        segunda = withDeadlockRetry(
          tx2 => ligarContacto(tx2, venueId!, leida, { tipo: 'PHONE', valor: telS7(4), metodo: 'WHATSAPP', probadoEn: 1 }),
          { etiqueta: 'carreraS7b' },
        )
        await hastaQueEspere()
      },
      { etiqueta: 'carreraS7a', timeout: 30_000 },
    )
    expect(await segunda!).toMatchObject({ ligado: false, aviso: 'FICHA_CON_OTRO_TELEFONO' })
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).phone).toBe(telS7(3))
    expect(await prisma.activityLog.count({ where: { venueId, action: 'CUSTOMER_CONTACT_LINKED', entityId: a.id } })).toBe(1)
  })

  it('codex-s7-r1 #1: el panel cambia el correo MIENTRAS ella entra ⇒ 409, su teléfono no se pega a esa ficha y el código sigue sirviendo', async () => {
    const mio = correoS7('panel-mio')
    const a = await ficha({ email: mio })
    await reto('email', mio)
    let entrada: Promise<request.Response> | undefined
    await prisma.$transaction(
      async tx => {
        // El panel guarda el correo de otra persona; su escritura sigue abierta mientras la clienta entra con el correo viejo.
        await tx.customer.update({ where: { id: a.id }, data: { email: correoS7('panel-otra') } })
        entrada = verificar({ email: mio, vincular: pruebaDe(telS7(6)) }).then(r => r)
        await hastaQueEspere()
      },
      { timeout: 30_000 },
    )
    const res = await entrada!
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CUSTOMER_CONTACT_CHANGED')
    expect(res.body.token).toBeUndefined()
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ phone: null, email: correoS7('panel-otra') })
    expect(await prisma.otpChallenge.count({ where: { venueId, destination: mio, consumedAt: null } })).toBe(1)
  })

  it('codex-s7-r1 #3: dos entradas con el mismo correo NUEVO a la vez ⇒ el choque del único de Consumer se repite y entra', async () => {
    const nuevo = correoS7('consumer-nuevo')
    await reto('email', nuevo)
    let entrada: Promise<request.Response> | undefined
    await prisma.$transaction(
      async tx => {
        // Otra entrada (de este u otro negocio) ya creó la identidad global de ese correo y no ha hecho commit.
        await tx.consumer.create({ data: { email: nuevo } })
        entrada = verificar({ email: nuevo }).then(r => r)
        await hastaQueEspere()
      },
      { timeout: 30_000 },
    )
    const res = await entrada!
    expect(res.status).toBe(200)
    expect((await sirve(res.body.token)).status).toBe(200)
    expect(await prisma.consumer.count({ where: { email: nuevo } })).toBe(1)
    expect(await prisma.customer.count({ where: { venueId, email: nuevo } })).toBe(1)
  })

  it('codex-s7-r2: una ficha DESACTIVADA con el mismo correo no tapa el aviso de otra ACTIVA', async () => {
    const correo = correoS7('combo')
    await ficha({ email: correo.replace('combo', 'COMBO'), active: false }) // la más antigua, desactivada
    const c = await ficha({ email: correo.replace('combo', 'Combo'), loyaltyPoints: 50 }) // activa, con beneficios
    const a = await ficha({ email: correo })
    await reto('email', correo)
    const res = await verificar({ email: correo })
    expect(res.status).toBe(200)
    expect(res.body.customer.id).toBe(a.id)
    expect(res.body.otraFicha).toEqual({ contacto: 'EMAIL', enmascarado: expect.stringMatching(/^c•••@s7\.mx$/) })
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).loyaltyPoints).toBe(50)
  })

  it('codex-plan2-r1 #2: el panel cambia el correo por el de otra persona; quien conserva la contraseña NO ve sus reservas de invitada', async () => {
    const mio = correoS7('mio')
    const ajeno = correoS7('ajeno')
    const a = await ficha({ email: mio, password: await bcrypt.hash('secreto-s7', 4) })
    const suya = await reservaDeInvitada({ guestEmail: ajeno })
    const propia = await reservaDeInvitada({ customerId: a.id })
    await updateCustomer(venueId!, a.id, { email: ajeno } as any)
    const login = await post('customer/login').send({ email: ajeno, password: 'secreto-s7' })
    expect(login.status).toBe(200)
    expect((jwt.verify(login.body.token, SECRET) as jwt.JwtPayload).contactos).toEqual([])
    const portal = await get('customer/portal').set('Authorization', `Bearer ${login.body.token}`)
    expect(portal.status).toBe(200)
    expect(portal.body.reservations.upcoming.map((r: any) => r.confirmationCode)).toEqual([propia.confirmationCode])
    expect(JSON.stringify(portal.body)).not.toContain(suya.cancelSecret)
    expect(portal.body.invitadaRequiereEntrar).toBe(true)
  })

  it('un contacto probado ve SUS reservas de invitada; escribir el número de otra persona no da las suyas ni su cancelSecret', async () => {
    const a = await nueva({ accountActivatedAt: new Date() })
    const mia = await reservaDeInvitada({ guestPhone: PHONE })
    const ajena = await reservaDeInvitada({ guestPhone: telS7(5) })
    await patch('customer/profile')
      .set('Authorization', `Bearer ${claims(a.id)}`)
      .send({ phone: telS7(5) })
    const portal = await get('customer/portal').set('Authorization', `Bearer ${claims(a.id)}`)
    expect(portal.status).toBe(200)
    const codigos = portal.body.reservations.upcoming.map((r: any) => r.confirmationCode)
    expect(codigos).toContain(mia.confirmationCode)
    expect(portal.body.reservations.upcoming.find((r: any) => r.confirmationCode === mia.confirmationCode).cancelSecret).toBe(
      mia.cancelSecret,
    )
    expect(codigos).not.toContain(ajena.confirmationCode)
    expect(JSON.stringify(portal.body)).not.toContain(ajena.cancelSecret)
    expect(portal.body.invitadaRequiereEntrar).toBe(false)
  })

  it('token de reservas de hoy ⇒ sólo las reservas de su ficha e invitadaRequiereEntrar', async () => {
    const a = await nueva({ accountActivatedAt: new Date() })
    const propia = await reservaDeInvitada({ customerId: a.id })
    const invitada = await reservaDeInvitada({ guestPhone: PHONE })
    const viejo = jwt.sign({ sub: a.id, venueId, type: 'customer' }, SECRET, { algorithm: 'HS256', expiresIn: '30d' })
    const portal = await get('customer/portal').set('Authorization', `Bearer ${viejo}`)
    expect(portal.status).toBe(200)
    expect(portal.body.reservations.upcoming.map((r: any) => r.confirmationCode)).toEqual([propia.confirmationCode])
    expect(JSON.stringify(portal.body)).not.toContain(invitada.cancelSecret)
    expect(portal.body.invitadaRequiereEntrar).toBe(true)
  })

  it('Google confiable ⇒ sesión GOOGLE que sirve; no confiable ⇒ 409, código por correo y ninguna ficha', async () => {
    // Workspace (`hd`): Google es autoridad sobre ese dominio, igual que con Gmail.
    const gmail = correoS7('workspace')
    mockGoogle.mockResolvedValueOnce({
      getPayload: () => ({ sub: 'g1', email: gmail, email_verified: true, hd: 's7.mx', given_name: 'Ana' }),
    })
    const ok = await post('auth/google').send({ idToken: 'id-token' })
    expect(ok.status).toBe(200)
    expect(ok.body.contactos).toEqual([expect.objectContaining({ tipo: 'EMAIL', valor: gmail, metodo: 'GOOGLE' })])
    expect((await sirve(ok.body.token)).status).toBe(200)

    const empresa = correoS7('empresa')
    mockGoogle.mockResolvedValueOnce({ getPayload: () => ({ sub: 'g2', email: empresa, email_verified: true }) })
    const no = await post('auth/google').send({ idToken: 'id-token' })
    expect(no.status).toBe(409)
    expect(no.body).toMatchObject({ code: 'GOOGLE_EMAIL_NOT_TRUSTED', message: 'Te mandamos un código a tu correo para confirmarlo' })
    expect(no.body.token).toBeUndefined()
    expect(await prisma.otpChallenge.count({ where: { venueId, destination: empresa, channel: 'email' } })).toBe(1)
    expect(await prisma.customer.count({ where: { venueId, email: empresa } })).toBe(0)
  })
})
