/**
 * D19 POR HTTP, como la tableta: `POST /api/v1/mobile/auth/refresh` contra la app real (supertest) y un Postgres real y
 * desechable. Es el recorrido de la Sunmi OrderPAD 3 del 3-nov (sesión cmw10ct72006jwalgs3inxnyv): el aparato renovó con
 * R0, el servidor rotó a S y la respuesta se perdió con el WiFi apagado; al volver la red mandó R0 otra vez.
 *
 * Lo que tiene que pasar (diseño auditado por Codex, `Avoqado/docs/audit/2026-11-03-d19-sesion-respuesta-perdida/`):
 * - R0 tardío → 200 con un refresh NUEVO (ni R0 ni S) y un access que sí entra a una ruta autenticada;
 * - S presentado después (el anulado) → 401, la sesión queda revocada y ese access deja de servir;
 * - si la renovación espera el candado de su familia más que el presupuesto de la transacción → 503
 *   `SESSION_REFRESH_RETRY` (ANDROID e iOS lo tratan como «reintenta»), nada cambia y el reintento entra.
 */
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { hashToken } from '@/services/auth/refreshGrant.service'

jest.setTimeout(60_000)

const SUF = `refhttp_${Date.now()}`
const CORREO = `${SUF}@test.local`
const CONTRASENA = 'Clave-de-prueba-1'

/** UN servidor en 127.0.0.1 (patrón de `tests/integration/mobile/kdsCapacidades.test.ts`): supertest no levanta otro. */
let server: Server
let orgId: string
let venueId: string
let staffId: string

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
  orgId = (await prisma.organization.create({ data: { name: `Org ${SUF}`, email: `org-${SUF}@test.local`, phone: '5555555555' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}`, status: 'ACTIVE' } })).id
  staffId = (
    await prisma.staff.create({
      data: {
        email: CORREO,
        firstName: 'Caja',
        lastName: 'Sunmi',
        password: await bcrypt.hash(CONTRASENA, 4),
        emailVerified: true,
        active: true,
      },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.CASHIER, active: true } })
})

afterAll(async () => {
  // Sin venue no se creó nada de este archivo: ningún deleteMany corre con filtros vacíos.
  if (!venueId) return
  try {
    if (staffId) {
      await prisma.session.deleteMany({ where: { staffId } }) // sus RefreshGrant caen en cascada
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    }
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  } catch {
    /* fixtures */
  }
  await new Promise<void>(listo => server.close(() => listo()))
})

async function entrar(): Promise<{ access: string; refresh: string }> {
  const res = await request(server).post('/api/v1/mobile/auth/login').send({ email: CORREO, password: CONTRASENA })
  expect({ status: res.status, body: res.status === 200 ? null : res.body }).toEqual({ status: 200, body: null })
  return { access: res.body.accessToken, refresh: res.body.refreshToken }
}

const renovar = (refreshToken: string) => request(server).post('/api/v1/mobile/auth/refresh').send({ refreshToken })

/** Una ruta autenticada cualquiera del POS (exige `sid` vivo). */
const rutaAutenticada = (access: string) => request(server).get('/api/v1/mobile/auth/passkeys').set('Authorization', `Bearer ${access}`)

const grantDe = (refresh: string) => prisma.refreshGrant.findUniqueOrThrow({ where: { tokenHash: hashToken(refresh) } })
const sesion = (id: string) => prisma.session.findUniqueOrThrow({ where: { id } })

it('la respuesta se perdió: R0 tardío → 200 con refresh NUEVO que sirve; S presentado después → 401 y la sesión queda revocada', async () => {
  const { refresh: r0 } = await entrar()
  const { sessionId } = await grantDe(r0)

  // 1. Renueva con R0: el servidor rota y contesta S… pero la respuesta nunca llega al aparato.
  const perdida = await renovar(r0)
  expect(perdida.status).toBe(200)
  const s: string = perdida.body.refreshToken

  // 2. El aparato pasa 5 minutos sin red: el consumo de R0 queda fuera de los 60 s.
  await prisma.refreshGrant.update({
    where: { tokenHash: hashToken(r0) },
    data: { consumedAt: new Date(Date.now() - 5 * 60_000), successorEncExpiresAt: new Date(Date.now() - 4 * 60_000) },
  })

  // 3. Vuelve la red y renueva otra vez con R0: 200, misma forma de siempre, con un refresh NUEVO.
  const tardia = await renovar(r0)
  expect({ status: tardia.status, body: tardia.body }).toEqual({
    status: 200,
    body: { success: true, accessToken: expect.any(String), refreshToken: expect.any(String) },
  })
  const n: string = tardia.body.refreshToken
  expect(n).not.toBe(r0)
  expect(n).not.toBe(s)
  expect((await rutaAutenticada(tardia.body.accessToken)).status).toBe(200)
  expect((await sesion(sessionId)).revokedAt).toBeNull()
  // S quedó anulado: consumido y sin sucesor.
  expect(await grantDe(s)).toMatchObject({ rotatedToId: null, revokedAt: null, consumedAt: expect.any(Date) })

  // 4. Alguien presenta S (el anulado): 401, y se revoca la sesión entera…
  expect((await renovar(s)).status).toBe(401)
  expect(await sesion(sessionId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'refresh_reuse_detected' })
  // …así que el access que salió del eco tardío ya no sirve, y N tampoco renueva.
  expect((await rutaAutenticada(tardia.body.accessToken)).status).toBe(401)
  expect((await renovar(n)).status).toBe(401)
})

it('si la renovación espera el candado de su familia más de 5 s: 503 SESSION_REFRESH_RETRY, nada cambia y el reintento entra', async () => {
  const { refresh: r0 } = await entrar()
  const { familyId, sessionId } = await grantDe(r0)

  // Otra operación de la misma familia retiene el candado 6 s (el presupuesto de la transacción es 5 s).
  let soltar: () => void = () => undefined
  const suelto = new Promise<void>(r => (soltar = r))
  let avisar: () => void = () => undefined
  const tomado = new Promise<void>(r => (avisar = r))
  const retenedor = prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('refreshGrant:' || ${familyId}, 0))::text`
      avisar()
      await suelto
    },
    { timeout: 30_000 },
  )
  let respuesta: Awaited<ReturnType<typeof renovar>> | undefined
  try {
    await tomado
    const enCurso = renovar(r0).then(r => r) // `then` la manda ya
    await new Promise(r => setTimeout(r, 6_000))
    soltar()
    respuesta = await enCurso
  } finally {
    soltar()
    await retenedor
  }

  expect({ status: respuesta?.status, code: respuesta?.body.code }).toEqual({ status: 503, code: 'SESSION_REFRESH_RETRY' })
  // Nada cambió: ni se consumió R0 ni se cerró la sesión…
  expect(await grantDe(r0)).toMatchObject({ consumedAt: null, revokedAt: null })
  expect((await sesion(sessionId)).revokedAt).toBeNull()
  // …y el reintento del aparato, con el MISMO R0, entra.
  expect((await renovar(r0)).status).toBe(200)
})
