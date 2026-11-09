/**
 * El celular de la persona (App de campo, bloque 1) por la RUTA real y contra Postgres REAL. La Tarea 3 prueba activar y la
 * 4 entrar con PIN y renovar; las Tareas 5–7 le suman casos (el candado, desvincular, la gracia).
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
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { hashToken } from '@/services/auth/refreshGrant.service'
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
/** Otra persona en la MISMA sucursal (Tarea 4: los PINes malos de uno no tocan al otro). */
let promotorBId: string
const PIN_B = '9999'
/** Segunda sucursal de la organización (sólo la usa la prueba de ELIGE_SUCURSAL). */
let venue2Id: string

/** Un código vivo para la persona (como lo deja el panel): generar otro reemplaza al anterior. */
async function nuevoCodigo(staffId = promotorId): Promise<string> {
  const codigo = generateSecureCode(6)
  const datos = {
    codigo,
    expiraAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    intentos: 0,
    generadoPor: staffId,
    usadoAt: null,
    usadoPorAparatoId: null,
    anuladoAt: null,
  }
  await prisma.codigoDeCelular.upsert({
    where: { organizationId_staffId: { organizationId: orgId, staffId } },
    create: { organizationId: orgId, staffId, ...datos },
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
  venue2Id = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `Celular Dos ${sufijo}`, slug: `celular-dos-${sufijo}`, status: 'ACTIVE' },
    })
  ).id
  promotorBId = (
    await prisma.staff.create({
      data: {
        email: `celular-promotor-b-${sufijo}@example.test`,
        firstName: 'Beto',
        lastName: 'Campo',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role: 'WAITER', active: true, pin: PIN_B } },
      },
    })
  ).id
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})

afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  const personas = [promotorId, promotorBId]
  await prisma.refreshGrant.deleteMany({ where: { session: { staffId: { in: personas } } } })
  await prisma.session.deleteMany({ where: { staffId: { in: personas } } })
  await prisma.celularDeCampo.deleteMany({ where: { organizationId: orgId } })
  await prisma.codigoDeCelular.deleteMany({ where: { organizationId: orgId } })
  await prisma.activityLog.deleteMany({ where: { OR: [{ venueId: { in: [venueId, venue2Id] } }, { organizationId: orgId }] } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: [venueId, venue2Id] } } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { id: { in: personas } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, venue2Id] } } })
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

describe('POST /tpv/campo/entrar y /renovar', () => {
  const entrar = (credencial: string, body: Record<string, unknown>) =>
    request(server).post('/api/v1/tpv/campo/entrar').set(CABECERA_CREDENCIAL, credencial).send(body)
  const renovar = (credencial: string, refreshToken: string) =>
    request(server).post('/api/v1/tpv/campo/renovar').set(CABECERA_CREDENCIAL, credencial).send({ refreshToken })
  /** Un celular recién activado (cada uno es una fila nueva: su tope de 30 por minuto empieza en cero). */
  const celularNuevo = async (staffId = promotorId, pin = PIN) => {
    const r = await activar(await nuevoCodigo(staffId), undefined, pin)
    expect(r.status).toBe(201)
    return r.body as { celularId: string; credencial: string; sesion: { accessToken: string; refreshToken: string } }
  }

  it('entrar: 200 con sesión nueva en la sucursal; la anterior del mismo celular muere y su refresh da 401', async () => {
    const c = await celularNuevo()
    const r = await entrar(c.credencial, { pin: PIN })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ sesion: { venueId, expiraEn: 86400 }, horaDelServidor: expect.any(String) })
    expect(r.body.sucursales).toEqual([
      expect.objectContaining({ venueId, verificadorPin: expect.objectContaining({ iteraciones: 100000 }) }),
    ])

    const fila = await prisma.celularDeCampo.findUniqueOrThrow({ where: { id: c.celularId } })
    expect(fila.sesionId).toBe(verificarAccesoDeCampo(r.body.sesion.accessToken).sid)
    expect(await tokenDeCampoVivo(r.body.sesion.accessToken)).toBe(true)
    expect(await tokenDeCampoVivo(c.sesion.accessToken)).toBe(false)
    const vieja = await renovar(c.credencial, c.sesion.refreshToken)
    expect(vieja.status).toBe(401)
    expect(vieja.body.code).toBe('SESION_INVALIDA')

    // `logAction` va mockeado en la integración (tests/__helpers__/integration-setup.ts): se revisa la llamada.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STAFF_LOGIN',
        staffId: promotorId,
        venueId,
        data: { source: 'campo', method: 'pin', celularId: c.celularId },
      }),
    )
  })

  it('renovar rota (rol de hoy, mismo sid); el refresh viejo fuera de la ventana → 401 y la sesión se corta', async () => {
    const c = await celularNuevo()
    const r1 = await renovar(c.credencial, c.sesion.refreshToken)
    expect(r1.status).toBe(200)
    expect(r1.body).toEqual({ accessToken: expect.any(String), refreshToken: expect.stringMatching(/^[a-f0-9]{64}$/), venueId })
    expect(r1.body.refreshToken).not.toBe(c.sesion.refreshToken)
    const sid = verificarAccesoDeCampo(c.sesion.accessToken).sid
    expect(verificarAccesoDeCampo(r1.body.accessToken)).toMatchObject({ sid, venueId, role: 'CASHIER', sub: promotorId })

    const r2 = await renovar(c.credencial, r1.body.refreshToken)
    expect(r2.status).toBe(200)
    // Fuera de la ventana de retransmisión (60 s) del refresh original.
    await prisma.refreshGrant.update({
      where: { tokenHash: hashToken(c.sesion.refreshToken) },
      data: { successorEnc: null, successorEncExpiresAt: null },
    })
    const viejo = await renovar(c.credencial, c.sesion.refreshToken)
    expect(viejo.status).toBe(401)
    expect(viejo.body.code).toBe('SESION_INVALIDA')
    expect(await tokenDeCampoVivo(r2.body.accessToken)).toBe(false)
  })

  it('renovar con el refresh de OTRO celular → 401 SESION_INVALIDA, y ese refresh sigue sirviendo a su celular', async () => {
    const a = await celularNuevo()
    const b = await celularNuevo(promotorBId, PIN_B)
    const r = await renovar(a.credencial, b.sesion.refreshToken)
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('SESION_INVALIDA')
    expect((await renovar(b.credencial, b.sesion.refreshToken)).status).toBe(200)
  })

  it('renovar con el StaffVenue desactivado → 401 SIN_ACCESO_A_LA_SUCURSAL', async () => {
    const c = await celularNuevo()
    await prisma.staffVenue.updateMany({ where: { staffId: promotorId, venueId }, data: { active: false } })
    try {
      const r = await renovar(c.credencial, c.sesion.refreshToken)
      expect(r.status).toBe(401)
      expect(r.body.code).toBe('SIN_ACCESO_A_LA_SUCURSAL')
    } finally {
      await prisma.staffVenue.updateMany({ where: { staffId: promotorId, venueId }, data: { active: true } })
    }
  })

  it('20 PINes malos a la vez en A: 5 se comparan y 15 → 429 PIN_BLOQUEADO; B (misma sucursal) entra a la primera', async () => {
    const a = await celularNuevo()
    const b = await celularNuevo(promotorBId, PIN_B)
    const rs = await Promise.all(Array.from({ length: 20 }, () => entrar(a.credencial, { pin: '0000' })))
    const malos = rs.filter(r => r.body.code === 'PIN_INCORRECTO')
    const bloqueados = rs.filter(r => r.body.code === 'PIN_BLOQUEADO')
    expect(malos.map(r => r.body.intentosAntesDeEsperar).sort()).toEqual([0, 1, 2, 3, 4])
    expect(bloqueados).toHaveLength(15)
    for (const r of bloqueados) {
      expect(r.status).toBe(429)
      expect(r.body.reintentaEn).toBeGreaterThanOrEqual(50)
      expect(r.body.reintentaEn).toBeLessThanOrEqual(60)
      expect(r.headers['retry-after']).toBe(String(r.body.reintentaEn))
    }
    expect(await prisma.celularDeCampo.findUniqueOrThrow({ where: { id: a.celularId } })).toMatchObject({ pinFallos: 5 })

    const deB = await entrar(b.credencial, { pin: PIN_B })
    expect(deB.status).toBe(200)

    // Tras la espera, el PIN bueno entra y reinicia el contador.
    await prisma.celularDeCampo.update({ where: { id: a.celularId }, data: { pinBloqueadoHasta: new Date(Date.now() - 1000) } })
    expect((await entrar(a.credencial, { pin: PIN })).status).toBe(200)
    expect(await prisma.celularDeCampo.findUniqueOrThrow({ where: { id: a.celularId } })).toMatchObject({
      pinFallos: 0,
      pinBloqueadoHasta: null,
    })
  })

  it('dos sucursales: sin venueId → 409 ELIGE_SUCURSAL (sucursales al nivel de code); ajena → 403; con venueId → 200', async () => {
    const c = await celularNuevo()
    await prisma.staffVenue.create({ data: { staffId: promotorId, venueId: venue2Id, role: 'WAITER', active: true, pin: PIN } })
    try {
      const elige = await entrar(c.credencial, { pin: PIN })
      expect(elige.status).toBe(409)
      expect(elige.body).toMatchObject({ code: 'ELIGE_SUCURSAL' })
      expect(elige.body.sucursales.map((s: any) => s.venueId).sort()).toEqual([venueId, venue2Id].sort())
      expect(JSON.stringify(elige.body)).not.toContain(PIN)

      const ajena = await entrar(c.credencial, { pin: PIN, venueId: 'cmvenueajeno000000000000' })
      expect(ajena.status).toBe(403)
      expect(ajena.body.code).toBe('SIN_ACCESO_A_LA_SUCURSAL')

      const r = await entrar(c.credencial, { pin: PIN, venueId: venue2Id })
      expect(r.status).toBe(200)
      expect(verificarAccesoDeCampo(r.body.sesion.accessToken)).toMatchObject({ venueId: venue2Id, role: 'WAITER' })
    } finally {
      await prisma.staffVenue.deleteMany({ where: { staffId: promotorId, venueId: venue2Id } })
    }
  })

  it('celular desvinculado → 401 CELULAR_DESVINCULADO en entrar y en renovar; sin credencial → 401 CELULAR_DESCONOCIDO', async () => {
    const viejo = await celularNuevo()
    await celularNuevo() // activar otro desvincula al anterior (CELULAR_NUEVO)
    const e = await entrar(viejo.credencial, { pin: PIN })
    expect(e.status).toBe(401)
    expect(e.body.code).toBe('CELULAR_DESVINCULADO')
    const r = await renovar(viejo.credencial, viejo.sesion.refreshToken)
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('CELULAR_DESVINCULADO')
    const sin = await request(server).post('/api/v1/tpv/campo/entrar').send({ pin: PIN })
    expect(sin.status).toBe(401)
    expect(sin.body.code).toBe('CELULAR_DESCONOCIDO')
  })

  it('cuerpo mal formado → 400', async () => {
    const c = await celularNuevo()
    expect((await entrar(c.credencial, { pin: '12' })).status).toBe(400)
    expect((await renovar(c.credencial, 'no-es-hex')).status).toBe(400)
  })
})
