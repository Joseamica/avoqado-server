/**
 * El celular de la persona (App de campo, bloque 1) por la RUTA real y contra Postgres REAL. Esta tarea (3) prueba activar;
 * las Tareas 4–7 le suman casos (entrar, el candado, desvincular, la gracia).
 *
 * Lo que el unit no puede probar: la `Session` que queda en la base, el único de `staffIdVinculado` y el CAS del código con
 * dos activaciones a la vez, y que el token del celular no entra a la API común.
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   AVQ_TREE=<worktree> ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration \
 *     --testPathPattern "tpv/celularDeCampo" --detectOpenHandles=false --ci
 */
import type { Server } from 'http'
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { createSession } from '@/services/auth/session.service'
import { isSessionAliveCached } from '@/services/auth/sessionCache'
import { generateSecureCode } from '@/services/dashboard/terminal-activation.service'
import { autenticarCelular, CABECERA_CREDENCIAL } from '@/services/tpv/campo/celular/credencial'
import { verificarAccesoDeCampo } from '@/services/tpv/campo/celular/tokenDeCampo'

jest.setTimeout(120000)

const sufijo = randomUUID().slice(0, 8)
const PIN = '4321'
let server: Server
let orgId: string
let venueId: string
let promotorId: string

/** Un código vivo para la persona (como lo deja el panel): generar otro reemplaza al anterior. */
async function nuevoCodigo(): Promise<string> {
  const codigo = generateSecureCode(6)
  const datos = {
    codigo,
    expiraAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    intentos: 0,
    generadoPor: promotorId,
    usadoAt: null,
    usadoPorAparatoId: null,
    anuladoAt: null,
  }
  await prisma.codigoDeCelular.upsert({
    where: { organizationId_staffId: { organizationId: orgId, staffId: promotorId } },
    create: { organizationId: orgId, staffId: promotorId, ...datos },
    update: datos,
  })
  return codigo
}

const activar = (codigo: string, aparatoId = `aparato-${randomUUID()}`, pin = PIN) =>
  request(server)
    .post('/api/v1/tpv/campo/activar')
    .send({ codigo, pin, aparato: { aparatoId, marca: 'Samsung', modelo: 'A15' } })

/** ¿La credencial autentica? Por el middleware real del celular (la ruta que lo usa llega en la Tarea 4). */
async function celularDeLaCredencial(credencial: string) {
  const res: any = { locals: {} }
  let error: unknown
  await autenticarCelular({ headers: { [CABECERA_CREDENCIAL]: credencial } } as any, res, (e?: unknown) => (error = e))
  return { celular: res.locals.celular, error }
}

/** Lo que hará el candado de la Tarea 5 con el token del celular: firma + audiencia, y su sesión viva. */
async function tokenDeCampoVivo(token: string): Promise<boolean> {
  return isSessionAliveCached(verificarAccesoDeCampo(token).sid)
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `Celular ${sufijo}`, email: `celular-${sufijo}@example.test`, phone: '5500000000' } })
  ).id
  venueId = (
    await prisma.venue.create({ data: { organizationId: orgId, name: `Celular ${sufijo}`, slug: `celular-${sufijo}`, status: 'ACTIVE' } })
  ).id
  promotorId = (
    await prisma.staff.create({
      data: {
        email: `celular-promotor-${sufijo}@example.test`,
        firstName: 'Ana',
        lastName: 'Campo',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role: 'CASHIER', active: true, pin: PIN } },
      },
    })
  ).id
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})

afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  await prisma.refreshGrant.deleteMany({ where: { session: { staffId: promotorId } } })
  await prisma.session.deleteMany({ where: { staffId: promotorId } })
  await prisma.celularDeCampo.deleteMany({ where: { organizationId: orgId } })
  await prisma.codigoDeCelular.deleteMany({ where: { organizationId: orgId } })
  await prisma.activityLog.deleteMany({ where: { OR: [{ venueId }, { organizationId: orgId }] } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { id: promotorId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('POST /tpv/campo/activar', () => {
  let tokenA: string
  let celularA: string

  it('activa: 201, la credencial autentica, UNA Session `celular:<id>` por PIN y el token trae su sid', async () => {
    const r = await activar(await nuevoCodigo())
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({
      repetida: false,
      persona: { staffId: promotorId, nombre: 'Ana Campo' },
      sesion: { venueId, expiraEn: 86400 },
    })
    expect(r.body.sucursales).toEqual([
      {
        venueId,
        nombre: `Celular ${sufijo}`,
        verificadorPin: expect.objectContaining({ algoritmo: 'PBKDF2-SHA256', iteraciones: 100000 }),
      },
    ])
    celularA = r.body.celularId
    tokenA = r.body.sesion.accessToken

    const { celular, error } = await celularDeLaCredencial(r.body.credencial)
    expect(error).toBeUndefined()
    expect(celular).toMatchObject({ id: celularA, staffIdVinculado: promotorId })

    const sesiones = await prisma.session.findMany({ where: { deviceId: `celular:${celularA}` } })
    expect(sesiones).toHaveLength(1)
    expect(sesiones[0]).toMatchObject({ authMethod: 'PIN', staffId: promotorId, venueId, revokedAt: null })
    expect(celular.sesionId).toBe(sesiones[0].id)
    expect(verificarAccesoDeCampo(tokenA).sid).toBe(sesiones[0].id)
    expect(await prisma.refreshGrant.count({ where: { sessionId: sesiones[0].id } })).toBe(1)
    expect(await tokenDeCampoVivo(tokenA)).toBe(true)
  })

  it('el token del celular no entra a la API común ni fabrica sesiones con switch-venue (401)', async () => {
    const comun = await request(server).get('/api/v1/me/venues').set('Authorization', `Bearer ${tokenA}`)
    expect(comun.status).toBe(401)
    const cambio = await request(server)
      .post('/api/v1/dashboard/auth/switch-venue')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ venueId })
    expect(cambio.status).toBe(401)
  })

  it('activar el celular B desvincula a A (CELULAR_NUEVO), su token muere, el de B vive y la PAX de la persona sigue', async () => {
    const pax = await createSession({ staffId: promotorId, venueId, deviceId: `PAX-${sufijo}`, authMethod: 'PIN' })
    const tokenPax = jwt.sign(
      { sub: promotorId, orgId, venueId, role: 'CASHIER', sid: pax.id },
      process.env.ACCESS_TOKEN_SECRET as string,
      {
        expiresIn: '15m',
      },
    )
    expect((await request(server).get('/api/v1/me/venues').set('Authorization', `Bearer ${tokenPax}`)).status).toBe(200)

    const r = await activar(await nuevoCodigo())
    expect(r.status).toBe(201)
    expect(r.body.celularId).not.toBe(celularA)

    const a = await prisma.celularDeCampo.findUniqueOrThrow({ where: { id: celularA } })
    expect(a).toMatchObject({ staffIdVinculado: null, motivoDesvinculo: 'CELULAR_NUEVO', sesionId: null })
    expect(a.desvinculadoAt).not.toBeNull()
    expect(await tokenDeCampoVivo(tokenA)).toBe(false)
    expect(await tokenDeCampoVivo(r.body.sesion.accessToken)).toBe(true)
    expect((await request(server).get('/api/v1/me/venues').set('Authorization', `Bearer ${tokenPax}`)).status).toBe(200)
    expect(await prisma.celularDeCampo.count({ where: { staffIdVinculado: promotorId } })).toBe(1)
  })

  it('el mismo aparato reintenta (respuesta perdida) → 200 repetida con credencial nueva; la vieja ya no autentica', async () => {
    const codigo = await nuevoCodigo()
    const aparato = `aparato-${randomUUID()}`
    const r1 = await activar(codigo, aparato)
    expect(r1.status).toBe(201)
    const r2 = await activar(codigo, aparato)
    expect(r2.status).toBe(200)
    expect(r2.body).toMatchObject({ repetida: true, celularId: r1.body.celularId })
    expect((await celularDeLaCredencial(r2.body.credencial)).celular?.id).toBe(r1.body.celularId)
    expect((await celularDeLaCredencial(r1.body.credencial)).error).toMatchObject({ code: 'CELULAR_DESCONOCIDO' })
    expect(await tokenDeCampoVivo(r1.body.sesion.accessToken)).toBe(false)
    expect((await activar(codigo)).status).toBe(409) // otro aparato
  })

  it('dos activaciones a la vez con el mismo código y PIN → un solo celular vinculado y la otra 409', async () => {
    const codigo = await nuevoCodigo()
    const [r1, r2] = await Promise.all([activar(codigo), activar(codigo)])
    expect([r1.status, r2.status].sort()).toEqual([201, 409])
    expect([r1, r2].find(r => r.status === 409)!.body.code).toBe('CODIGO_USADO')
    const ganador = [r1, r2].find(r => r.status === 201)!.body.celularId
    const vinculados = await prisma.celularDeCampo.findMany({ where: { staffIdVinculado: promotorId } })
    expect(vinculados.map(c => c.id)).toEqual([ganador])
  })

  it('PIN malo → 401 PIN_INCORRECTO con intentosRestantes al mismo nivel que code', async () => {
    const r = await activar(await nuevoCodigo(), undefined, '0000')
    expect(r.status).toBe(401)
    expect(r.body).toMatchObject({ code: 'PIN_INCORRECTO', intentosRestantes: 4 })
  })

  it('cuerpo mal formado → 400 sin tocar la base', async () => {
    const r = await request(server)
      .post('/api/v1/tpv/campo/activar')
      .send({ codigo: 'abc', pin: '1', aparato: { aparatoId: 'x' } })
    expect(r.status).toBe(400)
  })
})
