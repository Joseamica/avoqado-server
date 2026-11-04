/**
 * Actualizador del POS — Fase 1 (SERVIDOR) contra Postgres REAL: la app entera por HTTP, el JWT real y la base real.
 *
 * Cubre lo que las pruebas unitarias (con dobles en memoria) no pueden demostrar:
 * - el guardia de SUPERADMIN de verdad (403 al DUEÑO en las cuatro rutas);
 * - el CAS por `version` con dos escrituras que llegan a la vez (una gana, la otra 409) y la bitácora DENTRO de la misma
 *   transacción (cada 200 deja su asiento, ningún 409 lo deja);
 * - la consulta de impacto en SQL real: registros duplicados a propósito, filas hostiles que no la tumban, el negocio demo
 *   fuera, la ventana de días medida en UTC con la sesión de Postgres en UTC y en America/Mexico_City, y el primer `::int[]`
 *   con un arreglo de JS (el caso de iOS);
 * - el aviso de actualizar en el inicio de las apps con cabeceras reales (r7): sólo a la app de abajo, nunca al WINDOWS ni al
 *   DASHBOARD, ocupando sólo su lugar (fallo 8), «Bloquear» aunque lo hayan cerrado (fallo 9) y nunca con acuses ni buzón.
 *
 * 🔴 La fila de `PosAppVersionPolicy` es GLOBAL (una por plataforma): los casos corren en serie, en el orden del archivo, y la
 * fila se borra al empezar y al terminar (sólo en pruebas). Los conteos del impacto también son globales (la consulta no filtra
 * por negocio), así que se miden como DIFERENCIA contra una foto tomada justo antes de sembrar; lo que es de un negocio de este
 * archivo se mide exacto en su renglón de `venuesBelowList`.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://postgres:<password>@localhost:5432/avoqado_actualizador_test_<fecha>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/superadmin/pos-app-versions.integration.test.ts --ci
 */
import { PlatformAnnouncementStatus, Prisma, StaffRole, VenueStatus } from '@prisma/client'
import jwt from 'jsonwebtoken'
import app from '@/app'
import { startApiServer, api } from '@tests/__helpers__/apiServer'
import type { ImpactView } from '@/services/posAppVersion/impact.service'
import prisma from '@/utils/prismaClient'

jest.setTimeout(180_000)

const suffix = `pav${Date.now()}`
const BASE = '/api/v1/superadmin/pos-app-versions'
const PUBLICA = '/api/v1/public/pos-app-version'
const CONFLICTO = 'POS_APP_VERSION_POLICY_CHANGED'

const MINUTO = 60_000
const HORA = 60 * MINUTO
const DIA = 24 * HORA

type Plataforma = 'ANDROID' | 'IOS'

// ── Lo que este archivo crea (y SÓLO eso se borra; la política es la excepción, ver arriba) ─────────────────────────────────

const creado = {
  staff: [] as string[],
  venues: [] as string[],
  orgs: [] as string[],
  terminals: [] as string[],
  /** Anuncios NORMALES (sin `posAppPlatform`) que siembra este archivo. Los avisos de actualizar se encuentran por su autor. */
  anuncios: [] as string[],
}

let superToken = ''
let ownerToken = ''
let superId = ''
let ownerId = ''
let orgId = ''
/** El negocio de los tokens (y del primer registro del impacto). */
let venueId = ''

const firmar = (staffId: string, org: string, venue: string, role: StaffRole) =>
  jwt.sign({ sub: staffId, orgId: org, venueId: venue, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '30m' })

// ── La zona de la sesión de Postgres (mismo mecanismo que platform-charges.integration) ────────────────────────────────────

/** El ajuste de zona que la BASE traía antes de que este archivo la moviera (`null` = ninguno). Se restaura tal cual. */
let ajusteOriginal: { valor: string | null } | null = null

async function ajusteDeZonaDeLaBase(): Promise<string | null> {
  const filas = await prisma.$queryRaw<{ valor: string }[]>`
    SELECT regexp_replace(c, '^[Tt]ime[Zz]one=', '') AS valor
    FROM pg_db_role_setting s, unnest(s.setconfig) c
    WHERE s.setrole = 0
      AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND c ~* '^timezone='`
  return filas[0]?.valor ?? null
}

async function nombreDeLaBase(): Promise<string> {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  // Se cambia el valor por omisión DE LA BASE: sólo una base desechable de pruebas, y con un nombre que se pueda citar sin riesgo.
  if (!/^[A-Za-z0-9_]+$/.test(db) || !/test/i.test(db)) throw new Error(`«${db}» no parece una base desechable de pruebas`)
  return db
}

/** ¿Este archivo ya movió la zona de la base? Sólo entonces hay algo que restaurar. */
let zonaMovida = false

/** Pone la zona de las sesiones NUEVAS de la base y recicla el pool para que las conexiones de Prisma la lean. */
async function fijarZonaDeSesion(zona: string): Promise<void> {
  const db = await nombreDeLaBase()
  zonaMovida = true
  await prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO '${zona}'`)
  await prisma.$disconnect()
  const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
  expect(tz).toBe(zona)
}

async function restaurarZona(): Promise<void> {
  if (!ajusteOriginal || !zonaMovida) return
  const db = await nombreDeLaBase()
  await prisma.$executeRawUnsafe(
    ajusteOriginal.valor === null
      ? `ALTER DATABASE "${db}" RESET timezone`
      : `ALTER DATABASE "${db}" SET timezone TO '${ajusteOriginal.valor.replace(/'/g, "''")}'`,
  )
  await prisma.$disconnect()
}

// ── La política global: se vacía al empezar y al terminar ─────────────────────────────────────────────────────────────────

/**
 * Borra las filas de la política (sólo en pruebas). Si alguna traía avisos vivos (de una corrida anterior que no limpió), se
 * archivan: un aviso PUBLICADO sin su política haría que el inicio enseñara algo que este archivo no puso.
 */
async function vaciarLaPolitica(): Promise<void> {
  const filas = await prisma.posAppVersionPolicy.findMany({
    select: { recommendedAnnouncementId: true, requiredAnnouncementId: true },
    take: 2,
  })
  const vivos = filas.flatMap(f => [f.recommendedAnnouncementId, f.requiredAnnouncementId]).filter((id): id is string => !!id)
  if (vivos.length) {
    await prisma.platformAnnouncement.updateMany({
      where: { id: { in: vivos }, posAppPlatform: { not: null }, status: PlatformAnnouncementStatus.PUBLISHED },
      data: { status: PlatformAnnouncementStatus.ARCHIVED },
    })
  }
  await prisma.posAppVersionPolicy.deleteMany({ where: { platform: { in: ['ANDROID', 'IOS'] } } })
}

beforeAll(async () => {
  ajusteOriginal = { valor: await ajusteDeZonaDeLaBase() }
  await vaciarLaPolitica()

  const org = await prisma.organization.create({ data: { name: `Org ${suffix}`, email: `org-${suffix}@test.mx`, phone: '5555555555' } })
  creado.orgs.push(org.id)
  orgId = org.id
  const venue = await prisma.venue.create({ data: { organizationId: org.id, name: `Venue ${suffix}`, slug: `venue-${suffix}` } })
  creado.venues.push(venue.id)
  venueId = venue.id

  const superadmin = await prisma.staff.create({
    data: { email: `super-${suffix}@test.mx`, firstName: 'Súper', lastName: 'Versiones', emailVerified: true },
  })
  const owner = await prisma.staff.create({
    data: { email: `owner-${suffix}@test.mx`, firstName: 'Dueño', lastName: 'Versiones', emailVerified: true },
  })
  creado.staff.push(superadmin.id, owner.id)
  superId = superadmin.id
  ownerId = owner.id
  await prisma.staffVenue.create({ data: { staffId: superadmin.id, venueId: venue.id, role: StaffRole.SUPERADMIN, active: true } })
  await prisma.staffVenue.create({ data: { staffId: owner.id, venueId: venue.id, role: StaffRole.OWNER, active: true } })
  superToken = firmar(superadmin.id, org.id, venue.id, StaffRole.SUPERADMIN)
  ownerToken = firmar(owner.id, org.id, venue.id, StaffRole.OWNER)
})

afterAll(async () => {
  try {
    // Toda limpieza va con ids que ESTE archivo creó: un `where` con un valor undefined vaciaría la tabla.
    await restaurarZona()
    await prisma.posAppVersionPolicy.deleteMany({ where: { platform: { in: ['ANDROID', 'IOS'] } } })
    if (creado.staff.length) {
      // Los avisos de actualizar los creó el SUPERADMIN de este archivo (`createdBy` es quien escribió la política).
      const avisos = (
        await prisma.platformAnnouncement.findMany({
          where: { posAppPlatform: { not: null }, createdBy: { in: creado.staff } },
          select: { id: true },
          take: 500,
        })
      ).map(a => a.id)
      const anuncios = [...avisos, ...creado.anuncios]
      if (anuncios.length) {
        await prisma.platformAnnouncementClick.deleteMany({ where: { announcementId: { in: anuncios } } })
        await prisma.platformAnnouncementDelivery.deleteMany({ where: { announcementId: { in: anuncios } } })
        await prisma.platformAnnouncement.deleteMany({ where: { id: { in: anuncios } } })
      }
      await prisma.platformAnnouncementClick.deleteMany({ where: { staffId: { in: creado.staff } } })
      await prisma.activityLog.deleteMany({ where: { entity: 'PosAppVersionPolicy', staffId: { in: creado.staff } } })
      await prisma.activityLog.deleteMany({ where: { staffId: { in: creado.staff } } })
    }
    if (creado.terminals.length) await prisma.terminal.deleteMany({ where: { id: { in: creado.terminals } } })
    if (creado.staff.length) {
      await prisma.staffVenue.deleteMany({ where: { staffId: { in: creado.staff } } })
      await prisma.staff.deleteMany({ where: { id: { in: creado.staff } } })
    }
    if (creado.venues.length) await prisma.venue.deleteMany({ where: { id: { in: creado.venues } } })
    if (creado.orgs.length) await prisma.organization.deleteMany({ where: { id: { in: creado.orgs } } })
  } catch (error) {
    console.error('La limpieza de pos-app-versions.integration falló:', error)
  }
})

startApiServer(() => app)

// ── Utilerías ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cada escritura del SUPERADMIN, con lo que contestó: la bitácora se compara contra esto al final. */
const escrituras: Array<{ platform: Plataforma; tipo: 'SET' | 'CLEARED'; status: number; version: number | null }> = []

const anotar = (platform: Plataforma, tipo: 'SET' | 'CLEARED', res: { status: number; body: any }) => {
  escrituras.push({ platform, tipo, status: res.status, version: res.status === 200 ? res.body.data.version : null })
  return res
}

const listar = (token = superToken) => api().get(BASE).set('Authorization', `Bearer ${token}`)

const poner = async (platform: Plataforma, body: object, token = superToken) => {
  const res = await api().put(`${BASE}/${platform}`).set('Authorization', `Bearer ${token}`).send(body)
  return token === superToken ? anotar(platform, 'SET', res) : res
}

const quitar = async (platform: Plataforma, expectedVersion: number, token = superToken) => {
  const res = await api().post(`${BASE}/${platform}/clear`).set('Authorization', `Bearer ${token}`).send({ expectedVersion })
  return token === superToken ? anotar(platform, 'CLEARED', res) : res
}

const preguntaPublica = (query: string) => api().get(`${PUBLICA}?${query}`)

async function impacto(platform: Plataforma, query: string): Promise<ImpactView> {
  const res = await api().get(`${BASE}/${platform}/impact?${query}`).set('Authorization', `Bearer ${superToken}`)
  expect([res.status, res.body?.message]).toEqual([200, undefined])
  return res.body.data as ImpactView
}

/** Lo que cambió entre dos fotos del impacto (los conteos son de toda la base). */
const diferencia = (antes: ImpactView, despues: ImpactView) => ({
  totalSeen: despues.totalSeen - antes.totalSeen,
  unknownVersion: despues.unknownVersion - antes.unknownVersion,
  below: (despues.below ?? 0) - (antes.below ?? 0),
  venuesBelow: (despues.venuesBelow ?? 0) - (antes.venuesBelow ?? 0),
})

/** El renglón de un negocio en la lista de los de abajo, o `undefined`. */
const renglon = (vista: ImpactView, id: string) => vista.venuesBelowList.find(v => v.venueId === id)

/** El token vigente de la plataforma, leído como lo lee la pantalla. */
async function versionActual(platform: Plataforma): Promise<number> {
  const res = await listar()
  expect(res.status).toBe(200)
  return res.body.data[platform].version
}

let nVenue = 0
async function nuevoNegocio(nombre: string, status?: VenueStatus) {
  nVenue += 1
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `${nombre} ${suffix}`, slug: `venue-${suffix}-${nVenue}`, ...(status && { status }) },
  })
  creado.venues.push(venue.id)
  return venue
}

let nTerminal = 0
/** Una terminal como la deja el registro pasivo de aparatos. Los campos obligatorios, como en `seedExchange.ts`. */
async function nuevaTerminal(o: {
  venueId: string
  type: 'POS_ANDROID' | 'POS_IOS' | 'TPV_ANDROID'
  systemInfo?: Prisma.InputJsonValue
  version?: string
  /** Hace cuánto fue su último latido (por omisión, hace un minuto). */
  haceMs?: number
  deviceUid?: string
}) {
  nTerminal += 1
  const lastHeartbeat = new Date(Date.now() - (o.haceMs ?? MINUTO))
  const terminal = await prisma.terminal.create({
    data: {
      venueId: o.venueId,
      name: `Terminal ${suffix} ${nTerminal}`,
      type: o.type,
      deviceUid: o.deviceUid ?? `uid-${suffix}-${nTerminal}`,
      selfRegistered: true,
      lastHeartbeat,
      ...(o.systemInfo !== undefined && { systemInfo: o.systemInfo }),
      ...(o.version !== undefined && { version: o.version }),
    },
  })
  creado.terminals.push(terminal.id)
  return { ...terminal, lastHeartbeat }
}

/** El inicio de la app (o del DASHBOARD), como lo pide el DUEÑO, con las cabeceras dadas. */
function inicio(ruta: 'mobile' | 'dashboard', cabeceras: Record<string, string> = {}) {
  let req = api().get(`/api/v1/${ruta}/announcements/home`).set('Authorization', `Bearer ${ownerToken}`)
  for (const [nombre, valor] of Object.entries(cabeceras)) req = req.set(nombre, valor)
  return req
}

/** Lo que el inicio puso en cada lugar: el id del anuncio, o `null`. */
async function lugares(res: Promise<{ status: number; body: any }>) {
  const r = await res
  expect(r.status).toBe(200)
  return { banner: r.body.data.banner?.id ?? null, modal: r.body.data.modal?.id ?? null }
}

/** ¿Algún lugar del inicio trae un aviso de actualizar? */
async function traeAvisoDeActualizar(res: Promise<{ status: number; body: any }>) {
  const r = await res
  expect(r.status).toBe(200)
  return Boolean(r.body.data.banner?.posAppPlatform) || Boolean(r.body.data.modal?.posAppPlatform)
}

const ANDROID_95 = { 'x-device-platform': 'ANDROID', 'x-app-version-code': '95' }
const ANDROID_100 = { 'x-device-platform': 'ANDROID', 'x-app-version-code': '100' }

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('permisos: sólo el SUPERADMIN entra (el guardia real)', () => {
  const RUTAS: Array<[string, () => any]> = [
    ['GET /', () => api().get(BASE)],
    [
      'PUT /ANDROID',
      () =>
        api()
          .put(`${BASE}/ANDROID`)
          .send({ required: { versionCode: 100 }, recommended: null, expectedVersion: null }),
    ],
    ['POST /ANDROID/clear', () => api().post(`${BASE}/ANDROID/clear`).send({ expectedVersion: 1 })],
    ['GET /ANDROID/impact', () => api().get(`${BASE}/ANDROID/impact?versionCode=100&days=7`)],
  ]

  it('el DUEÑO recibe 403 en las cuatro rutas, y sin token es 401', async () => {
    for (const [ruta, pedir] of RUTAS) {
      const sinToken = await pedir()
      expect([ruta, sinToken.status]).toEqual([ruta, 401])
      const comoDueno = await pedir().set('Authorization', `Bearer ${ownerToken}`)
      expect([ruta, comoDueno.status]).toEqual([ruta, 403])
    }
  })

  it('el intento del DUEÑO no deja política ni bitácora', async () => {
    expect(await prisma.posAppVersionPolicy.findUnique({ where: { platform: 'ANDROID' } })).toBeNull()
    expect(await prisma.activityLog.count({ where: { entity: 'PosAppVersionPolicy', staffId: ownerId } })).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('crear y leer: ANDROID decide por versionCode', () => {
  it('PUT ANDROID con expectedVersion null crea la versión 1', async () => {
    const res = await poner('ANDROID', { required: { versionCode: 100 }, recommended: null, expectedVersion: null })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      exists: true,
      version: 1,
      required: { versionCode: 100, versionName: null },
      recommended: null,
      message: null,
      updatedBy: { id: superId, name: 'Súper Versiones' },
    })
  })

  it('crear otra vez con expectedVersion null es 409: ya existe', async () => {
    const res = await poner('ANDROID', { required: { versionCode: 120 }, recommended: null, expectedVersion: null })
    expect([res.status, res.body.code]).toEqual([409, CONFLICTO])
    expect((await prisma.posAppVersionPolicy.findUniqueOrThrow({ where: { platform: 'ANDROID' } })).requiredMinVersionCode).toBe(100)
  })

  it('la pregunta pública: 95 es REQUIRED, 100 (igual a la mínima) es OK, y nunca se cachea', async () => {
    const abajo = await preguntaPublica('platform=ANDROID&versionCode=95')
    expect(abajo.status).toBe(200)
    expect(abajo.headers['cache-control']).toBe('no-store')
    expect(abajo.body.data).toMatchObject({
      status: 'REQUIRED',
      required: { versionCode: 100, versionName: null },
      recommended: null,
      message: null,
    })
    expect(typeof abajo.body.data.checkedAt).toBe('string')

    const igual = await preguntaPublica('platform=ANDROID&versionCode=100')
    expect(igual.status).toBe(200)
    expect(igual.headers['cache-control']).toBe('no-store')
    expect(igual.body.data.status).toBe('OK')
  })

  it('el POS de escritorio siempre es OK, aunque ANDROID tenga mínima', async () => {
    const res = await preguntaPublica('platform=DESKTOP')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'OK', required: null, recommended: null })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('carrera: dos escrituras con el mismo token', () => {
  it('una gana (200) y la otra es 409 POS_APP_VERSION_POLICY_CHANGED, con UN solo asiento de esa transición', async () => {
    const [a, b] = await Promise.all([
      poner('ANDROID', { required: { versionCode: 101 }, recommended: null, message: 'Carrera A', expectedVersion: 1 }),
      poner('ANDROID', { required: { versionCode: 102 }, recommended: null, message: 'Carrera B', expectedVersion: 1 }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const ganadora = a.status === 200 ? a : b
    const perdedora = a.status === 200 ? b : a
    expect(perdedora.body.code).toBe(CONFLICTO)
    expect(ganadora.body.data.version).toBe(2)

    // Lo que quedó es exactamente lo de la ganadora.
    const lista = await listar()
    expect(lista.body.data.ANDROID).toMatchObject({
      version: 2,
      required: { versionCode: ganadora.body.data.required.versionCode },
      message: ganadora.body.data.message,
    })

    const filas = await prisma.activityLog.findMany({
      where: { entity: 'PosAppVersionPolicy', entityId: 'ANDROID', staffId: superId },
      take: 100,
    })
    const deLaTransicion = filas.filter(f => (f.data as any)?.before?.version === 1)
    expect(deLaTransicion).toHaveLength(1)
    expect((deLaTransicion[0].data as any).after).toMatchObject({
      version: 2,
      requiredMinVersionCode: ganadora.body.data.required.versionCode,
      message: ganadora.body.data.message,
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('quitar, y la pantalla que se quedó con el token viejo', () => {
  it('clear con el token vigente: 200, la fila sigue con version +1 y su aviso queda archivado', async () => {
    const antes = await prisma.posAppVersionPolicy.findUniqueOrThrow({ where: { platform: 'ANDROID' } })
    expect(antes.version).toBe(2)
    expect(antes.requiredAnnouncementId).not.toBeNull()

    const res = await quitar('ANDROID', 2)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ exists: true, version: 3, required: null, recommended: null, message: null })

    const fila = await prisma.posAppVersionPolicy.findUnique({ where: { platform: 'ANDROID' } })
    expect(fila).toMatchObject({
      version: 3,
      requiredMinVersionCode: null,
      requiredMinVersionName: null,
      recommendedMinVersionCode: null,
      recommendedMinVersionName: null,
      recommendedNoticeStyle: null,
      message: null,
      recommendedAnnouncementId: null,
      requiredAnnouncementId: null,
    })
    const aviso = await prisma.platformAnnouncement.findUniqueOrThrow({ where: { id: antes.requiredAnnouncementId as string } })
    expect(aviso.status).toBe(PlatformAnnouncementStatus.ARCHIVED)
  })

  it('el GET de superadmin dice exists: true con los niveles en null (se quitó, no «nunca hubo»)', async () => {
    const res = await listar()
    expect(res.status).toBe(200)
    expect(res.body.data.ANDROID).toMatchObject({ exists: true, version: 3, required: null, recommended: null, message: null })
  })

  it('un PUT o un clear con el token anterior es 409 y no cambia nada', async () => {
    const put = await poner('ANDROID', { required: { versionCode: 130 }, recommended: null, expectedVersion: 2 })
    expect([put.status, put.body.code]).toEqual([409, CONFLICTO])
    const clear = await quitar('ANDROID', 2)
    expect([clear.status, clear.body.code]).toEqual([409, CONFLICTO])
    expect((await prisma.posAppVersionPolicy.findUniqueOrThrow({ where: { platform: 'ANDROID' } })).version).toBe(3)
  })

  it('sin mínimas, la pregunta pública contesta OK a cualquier versión', async () => {
    const res = await preguntaPublica('platform=ANDROID&versionCode=1')
    expect(res.body.data).toMatchObject({ status: 'OK', required: null, recommended: null })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('iOS decide por nombre', () => {
  it('PUT IOS { required: 1.16.0 }: 1.15.11 es REQUIRED y 1.16 (= 1.16.0) es OK', async () => {
    const res = await poner('IOS', { required: { versionName: '1.16.0' }, recommended: null, expectedVersion: null })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ exists: true, version: 1, required: { versionCode: null, versionName: '1.16.0' } })

    const abajo = await preguntaPublica('platform=IOS&versionName=1.15.11')
    expect(abajo.status).toBe(200)
    expect(abajo.body.data).toMatchObject({ status: 'REQUIRED', required: { versionCode: null, versionName: '1.16.0' } })

    const igual = await preguntaPublica('platform=IOS&versionName=1.16')
    expect(igual.body.data.status).toBe('OK')
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('impacto en ANDROID (SQL real, una sola consulta)', () => {
  const CON_100 = 'versionCode=100&days=7'

  it('el mismo deviceUid en dos negocios cuenta dos veces, a propósito: con candidato 100, below 1 y totalSeen 2', async () => {
    const otroNegocio = await nuevoNegocio('Sucursal B')
    const antes = await impacto('ANDROID', CON_100)

    const uid = `uid-${suffix}-el-mismo`
    await nuevaTerminal({ venueId, type: 'POS_ANDROID', deviceUid: uid, systemInfo: { versionCode: 95 }, version: '2.25.10' })
    await nuevaTerminal({ venueId: otroNegocio.id, type: 'POS_ANDROID', deviceUid: uid, systemInfo: { versionCode: 100 } })
    // Una terminal de COBRO (PAX) con el mismo número no es el POS: no cuenta.
    await nuevaTerminal({ venueId, type: 'TPV_ANDROID', systemInfo: { versionCode: 95 } })

    const despues = await impacto('ANDROID', CON_100)
    expect(diferencia(antes, despues)).toEqual({ totalSeen: 2, unknownVersion: 0, below: 1, venuesBelow: 1 })
    expect(despues).toMatchObject({ platform: 'ANDROID', days: 7, candidate: { versionCode: 100, versionName: null } })
    expect(renglon(despues, venueId)).toMatchObject({ venueName: `Venue ${suffix}`, records: 1 })
    expect(renglon(despues, otroNegocio.id)).toBeUndefined()
    expect(despues.byVersion.find(g => g.versionCode === 95 && g.versionName === '2.25.10')).toBeDefined()
    expect(despues.byVersion.find(g => g.versionCode === 100)).toBeDefined()
  })

  it('sin versionCode, o con uno hostil, va a unknownVersion y la consulta no se cae', async () => {
    const negocio = await nuevoNegocio('Hostiles')
    const antes = await impacto('ANDROID', CON_100)

    await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID' }) // sin systemInfo
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: {} }) // sin la llave
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: [95, 100] }) // un arreglo, no un objeto
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: { versionCode: '12345678901' } }) // 11 dígitos
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: { versionCode: '0095' } }) // cero a la izquierda
    // 10 dígitos sí es un número válido (cabe en bigint): se conoce y no queda debajo de 100.
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: { versionCode: '9999999999' } })

    const despues = await impacto('ANDROID', CON_100)
    expect(diferencia(antes, despues)).toEqual({ totalSeen: 6, unknownVersion: 5, below: 0, venuesBelow: 0 })
    expect(renglon(despues, negocio.id)).toBeUndefined()
    expect(despues.byVersion.find(g => g.versionCode === 9999999999)).toBeDefined()
  })

  it('un negocio demo (LIVE_DEMO) no cuenta', async () => {
    const demo = await nuevoNegocio('Demo', VenueStatus.LIVE_DEMO)
    const antes = await impacto('ANDROID', CON_100)
    await nuevaTerminal({ venueId: demo.id, type: 'POS_ANDROID', systemInfo: { versionCode: 95 } })
    const despues = await impacto('ANDROID', CON_100)
    expect(diferencia(antes, despues)).toEqual({ totalSeen: 0, unknownVersion: 0, below: 0, venuesBelow: 0 })
    expect(renglon(despues, demo.id)).toBeUndefined()
  })

  describe.each(['UTC', 'America/Mexico_City'])('la ventana de días, con la sesión de Postgres en %s', zona => {
    beforeAll(() => fijarZonaDeSesion(zona))
    afterAll(() => restaurarZona())

    it('con days=7: cuentan 6.5 días y 7 días menos 2 horas; no cuentan 7 días más 2 horas, 7.5 ni 8 días', async () => {
      const negocio = await nuevoNegocio(`Ventana ${zona}`)
      const antes7 = await impacto('ANDROID', CON_100)
      const antes9 = await impacto('ANDROID', 'versionCode=100&days=9')

      // Todas debajo de 100, para que cada una que cuente se vea también en `below` y en el renglón del negocio.
      const dentro = await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: { versionCode: 95 }, haceMs: 6.5 * DIA })
      // El par apretado: un corrimiento de 6 horas (comparar el reloj UTC en la zona de la sesión) lo voltearía.
      const casiSiete = await nuevaTerminal({
        venueId: negocio.id,
        type: 'POS_ANDROID',
        systemInfo: { versionCode: 95 },
        haceMs: 7 * DIA - 2 * HORA,
      })
      await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: { versionCode: 95 }, haceMs: 7 * DIA + 2 * HORA })
      await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: { versionCode: 95 }, haceMs: 7.5 * DIA })
      await nuevaTerminal({ venueId: negocio.id, type: 'POS_ANDROID', systemInfo: { versionCode: 95 }, haceMs: 8 * DIA })

      const despues7 = await impacto('ANDROID', CON_100)
      expect(diferencia(antes7, despues7)).toEqual({ totalSeen: 2, unknownVersion: 0, below: 2, venuesBelow: 1 })
      // La última vez que se vio sale en ISO UTC, igual que `Date.toISOString()`, en cualquier zona de la sesión.
      const masReciente = [dentro, casiSiete].sort((x, y) => y.lastHeartbeat.getTime() - x.lastHeartbeat.getTime())[0]
      expect(renglon(despues7, negocio.id)).toEqual({
        venueId: negocio.id,
        venueName: `Ventana ${zona} ${suffix}`,
        records: 2,
        lastSeenAt: masReciente.lastHeartbeat.toISOString(),
      })

      // Con 9 días entran las cinco.
      const despues9 = await impacto('ANDROID', 'versionCode=100&days=9')
      expect(diferencia(antes9, despues9)).toEqual({ totalSeen: 5, unknownVersion: 0, below: 5, venuesBelow: 1 })
      expect(renglon(despues9, negocio.id)?.records).toBe(5)
    })
  })

  it('con candidato 1 nada queda debajo: below 0 y la lista vacía (Review Focus 5)', async () => {
    const vista = await impacto('ANDROID', 'versionCode=1&days=7')
    expect(vista).toMatchObject({ below: 0, venuesBelow: 0, venuesBelowList: [], venuesBelowListTruncated: false })
    expect(vista.totalSeen).toBeGreaterThanOrEqual(4)
  })

  it('sin candidata: below y venuesBelow en null, y sin lista', async () => {
    const vista = await impacto('ANDROID', 'days=7')
    expect(vista).toMatchObject({ candidate: null, below: null, venuesBelow: null, venuesBelowList: [] })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('impacto en iOS (por nombre: el primer ::int[] con un arreglo de JS)', () => {
  const CON_116 = 'versionName=1.16&days=7'

  it('1.15.11 queda debajo de 1.16 y 1.16.0 no; «1x16», «1.x» y «9999999.1» van a unknownVersion sin tumbar la consulta', async () => {
    const negocio = await nuevoNegocio('iPads')
    const antes = await impacto('IOS', CON_116)

    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1.15.11' })
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1.16.0' })
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1x16' })
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1.x' })
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '9999999.1' })

    const despues = await impacto('IOS', CON_116)
    expect(diferencia(antes, despues)).toEqual({ totalSeen: 5, unknownVersion: 3, below: 1, venuesBelow: 1 })
    expect(despues).toMatchObject({ platform: 'IOS', candidate: { versionCode: null, versionName: '1.16' } })
    expect(renglon(despues, negocio.id)).toMatchObject({ records: 1 })
    expect(despues.byVersion.find(g => g.versionName === '1.15.11')).toBeDefined()
    expect(despues.byVersion.find(g => g.versionName === '9999999.1')).toBeDefined()
  })

  // Las apps de iOS SÍ guardan su número de compilación (`systemInfo.versionCode`), pero en iOS sólo se muestra (§4.1): una
  // versión publicada en dos compilaciones es UN renglón de `byVersion`, sin número.
  it('1.15.11 en las compilaciones 40 y 41 es UN renglón sin número, y las versiones salen de la más nueva a la más vieja', async () => {
    const negocio = await nuevoNegocio('iPads compilaciones')
    const antes = await impacto('IOS', CON_116)
    const de1511Antes = antes.byVersion.filter(g => g.versionName === '1.15.11')
    expect(de1511Antes.length).toBeLessThanOrEqual(1)

    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1.15.11', systemInfo: { versionCode: 40 } })
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1.15.11', systemInfo: { versionCode: 41 } })
    // 1.15.2 es más vieja que 1.15.11 aunque como texto vaya después: el orden es por número, parte por parte.
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1.15.2', systemInfo: { versionCode: 39 } })
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1.16.0', systemInfo: { versionCode: 42 } })
    // Un nombre que no se puede leer va a unknownVersion aunque traiga número: en iOS el número no decide.
    await nuevaTerminal({ venueId: negocio.id, type: 'POS_IOS', version: '1.y', systemInfo: { versionCode: 43 } })

    const despues = await impacto('IOS', CON_116)
    expect(diferencia(antes, despues)).toEqual({ totalSeen: 5, unknownVersion: 1, below: 3, venuesBelow: 1 })
    expect(renglon(despues, negocio.id)).toMatchObject({ records: 3 })
    expect(despues.byVersionTruncated).toBe(false)

    const de1511 = despues.byVersion.filter(g => g.versionName === '1.15.11')
    expect(de1511).toHaveLength(1)
    expect(de1511[0].versionCode).toBeNull()
    expect(de1511[0].records - (de1511Antes[0]?.records ?? 0)).toBe(2)
    expect(de1511[0].venues - (de1511Antes[0]?.venues ?? 0)).toBe(1)
    // Ningún renglón de iOS trae número de compilación.
    expect(despues.byVersion.every(g => g.versionCode === null)).toBe(true)

    // La más nueva primero, por el nombre leído número por número; las que no se pueden leer, al final.
    const nombres = despues.byVersion.map(g => g.versionName)
    const lugar = (nombre: string) => {
      const i = nombres.indexOf(nombre)
      expect([nombre, i >= 0]).toEqual([nombre, true])
      return i
    }
    expect(lugar('1.16.0')).toBeLessThan(lugar('1.15.11'))
    expect(lugar('1.15.11')).toBeLessThan(lugar('1.15.2'))
    expect(lugar('1.15.2')).toBeLessThan(lugar('1.y'))
  })

  it('en iOS el impacto no se calcula con versionCode: 400', async () => {
    const res = await api().get(`${BASE}/IOS/impact?versionCode=100&days=7`).set('Authorization', `Bearer ${superToken}`)
    expect([res.status, res.body.code]).toEqual([400, 'POS_APP_VERSION_POLICY_INVALID'])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('(r7) el aviso de actualizar en el inicio de las apps, con cabeceras reales', () => {
  /** Un anuncio NORMAL de ventana, con su acuse para el DUEÑO: el camino de hoy. Prueba que el aviso sólo ocupa su lugar. */
  let normal = ''
  let avisarVentana = ''
  let avisarBanner = ''
  let bloquear = ''

  beforeAll(async () => {
    const ahora = new Date()
    const anuncio = await prisma.platformAnnouncement.create({
      data: {
        title: `Anuncio normal ${suffix}`,
        body: 'Un anuncio de los de siempre.',
        priority: 'URGENT',
        audienceRoles: [],
        showAsBanner: false,
        showAsModal: true,
        status: PlatformAnnouncementStatus.PUBLISHED,
        publishedAt: ahora,
        deliveredAt: ahora,
        createdBy: superId,
        createdByName: 'Prueba de integración',
      },
    })
    creado.anuncios.push(anuncio.id)
    normal = anuncio.id
    await prisma.platformAnnouncementDelivery.create({
      data: { announcementId: anuncio.id, staffId: ownerId, venueId, status: 'SENT', deliveredAt: ahora },
    })
  })

  it('«Avisar» MODAL en ANDROID 100 nace PUBLICADO, ya repartido y sin acuses', async () => {
    const res = await poner('ANDROID', {
      required: null,
      recommended: { versionCode: 100, noticeStyle: 'MODAL' },
      expectedVersion: await versionActual('ANDROID'),
    })
    expect(res.status).toBe(200)
    const fila = await prisma.posAppVersionPolicy.findUniqueOrThrow({ where: { platform: 'ANDROID' } })
    expect(fila.requiredAnnouncementId).toBeNull()
    avisarVentana = fila.recommendedAnnouncementId as string
    expect(avisarVentana).toBeTruthy()

    const aviso = await prisma.platformAnnouncement.findUniqueOrThrow({ where: { id: avisarVentana } })
    expect(aviso).toMatchObject({
      status: PlatformAnnouncementStatus.PUBLISHED,
      posAppPlatform: 'ANDROID',
      posAppNoticeKind: 'RECOMMENDED',
      posAppBelowVersionCode: 100,
      posAppBelowVersionName: null,
      showAsBanner: true,
      showAsModal: true,
      deliveredCount: 0,
      createdBy: superId,
      actionUrl: 'https://play.google.com/store/apps/details?id=com.avoqado.pos',
    })
    expect(aviso.deliveredAt).not.toBeNull()
  })

  it('ANDROID 95 lo recibe en banner Y en ventana; el anuncio normal no se cuela', async () => {
    expect(await lugares(inicio('mobile', ANDROID_95))).toEqual({ banner: avisarVentana, modal: avisarVentana })
  })

  it('ANDROID 100 no lo recibe: sigue el inicio de hoy (la ventana normal)', async () => {
    const r = await lugares(inicio('mobile', ANDROID_100))
    expect(r.modal).toBe(normal)
    expect(r.banner).not.toBe(avisarVentana)
    expect(await traeAvisoDeActualizar(inicio('mobile', ANDROID_100))).toBe(false)
  })

  it('el DASHBOARD (sin cabeceras de app) nunca lo recibe, ni por su ruta ni por la de las apps', async () => {
    const dashboard = await lugares(inicio('dashboard'))
    expect(dashboard.modal).toBe(normal)
    expect(await traeAvisoDeActualizar(inicio('dashboard'))).toBe(false)
    expect(await traeAvisoDeActualizar(inicio('mobile'))).toBe(false)
    // Aunque el DASHBOARD mandara una plataforma, sin versión no se compara: nunca se adivina.
    expect(await traeAvisoDeActualizar(inicio('dashboard', { 'x-device-platform': 'ANDROID' }))).toBe(false)
  })

  it.each([
    ['fabricante Avoqado', { ...ANDROID_95, 'x-device-manufacturer': 'Avoqado' }],
    ['modelo «Windows 11»', { ...ANDROID_95, 'x-device-model': 'Windows 11' }],
    ['forma DESKTOP', { ...ANDROID_95, 'x-device-form-factor': 'DESKTOP' }],
    ['plataforma DESKTOP', { 'x-device-platform': 'DESKTOP', 'x-app-version-code': '95' }],
  ])('el WINDOWS (o una PC) no lo recibe aunque diga ANDROID 95: %s', async (_caso, cabeceras) => {
    const r = await lugares(inicio('mobile', cabeceras))
    expect(r.modal).toBe(normal)
    expect(await traeAvisoDeActualizar(inicio('mobile', cabeceras))).toBe(false)
  })

  it('«Avisar» BANNER ocupa sólo el banner: la ventana la llena el anuncio normal (fallo 8)', async () => {
    const res = await poner('ANDROID', {
      required: null,
      recommended: { versionCode: 100, noticeStyle: 'BANNER' },
      expectedVersion: await versionActual('ANDROID'),
    })
    expect(res.status).toBe(200)
    // Cambió la forma: el aviso anterior se archiva y nace otro.
    avisarBanner = (await prisma.posAppVersionPolicy.findUniqueOrThrow({ where: { platform: 'ANDROID' } }))
      .recommendedAnnouncementId as string
    expect(avisarBanner).toBeTruthy()
    expect(avisarBanner).not.toBe(avisarVentana)
    expect((await prisma.platformAnnouncement.findUniqueOrThrow({ where: { id: avisarVentana } })).status).toBe(
      PlatformAnnouncementStatus.ARCHIVED,
    )

    expect(await lugares(inicio('mobile', ANDROID_95))).toEqual({ banner: avisarBanner, modal: normal })
  })

  it('«Avisar» cerrado ya no sale', async () => {
    const cerrar = await api()
      .post(`/api/v1/mobile/announcements/${avisarBanner}/dismiss`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
    expect(cerrar.status).toBe(200)
    const r = await lugares(inicio('mobile', ANDROID_95))
    expect(r.banner).not.toBe(avisarBanner)
    expect(r.modal).toBe(normal)
    expect(await traeAvisoDeActualizar(inicio('mobile', ANDROID_95))).toBe(false)
  })

  it('«Bloquear» da banner Y ventana aunque la persona lo haya cerrado (fallo 9)', async () => {
    const res = await poner('ANDROID', {
      required: { versionCode: 100 },
      recommended: null,
      expectedVersion: await versionActual('ANDROID'),
    })
    expect(res.status).toBe(200)
    const fila = await prisma.posAppVersionPolicy.findUniqueOrThrow({ where: { platform: 'ANDROID' } })
    expect(fila.recommendedAnnouncementId).toBeNull()
    bloquear = fila.requiredAnnouncementId as string
    expect(bloquear).toBeTruthy()
    expect(await prisma.platformAnnouncement.findUniqueOrThrow({ where: { id: bloquear } })).toMatchObject({
      posAppNoticeKind: 'REQUIRED',
      priority: 'URGENT',
      showAsBanner: true,
      showAsModal: true,
    })

    const cerrar = await api()
      .post(`/api/v1/mobile/announcements/${bloquear}/dismiss`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
    expect(cerrar.status).toBe(200)

    expect(await lugares(inicio('mobile', ANDROID_95))).toEqual({ banner: bloquear, modal: bloquear })
    expect(await traeAvisoDeActualizar(inicio('mobile', ANDROID_100))).toBe(false)
  })

  it('iOS se compara por x-app-version (el nombre), no por el número de compilación', async () => {
    const ios = await prisma.posAppVersionPolicy.findUniqueOrThrow({ where: { platform: 'IOS' } })
    const avisoIos = ios.requiredAnnouncementId as string
    expect(avisoIos).toBeTruthy()

    expect(await lugares(inicio('mobile', { 'x-device-platform': 'IOS', 'x-app-version': '1.15.11' }))).toEqual({
      banner: avisoIos,
      modal: avisoIos,
    })
    expect(await traeAvisoDeActualizar(inicio('mobile', { 'x-device-platform': 'IOS', 'x-app-version': '1.16.0' }))).toBe(false)
    // Sólo con el número (sin nombre) no se puede comparar: no se enseña.
    expect(await traeAvisoDeActualizar(inicio('mobile', { 'x-device-platform': 'IOS', 'x-app-version-code': '1' }))).toBe(false)
  })

  it('después de /clear, el aviso queda ARCHIVED, ya no sale y su detalle es 403', async () => {
    const res = await quitar('ANDROID', await versionActual('ANDROID'))
    expect(res.status).toBe(200)
    expect((await prisma.platformAnnouncement.findUniqueOrThrow({ where: { id: bloquear } })).status).toBe(
      PlatformAnnouncementStatus.ARCHIVED,
    )

    const r = await lugares(inicio('mobile', ANDROID_95))
    expect(r.modal).toBe(normal)
    expect(await traeAvisoDeActualizar(inicio('mobile', ANDROID_95))).toBe(false)

    const detalle = await api().get(`/api/v1/mobile/announcements/${bloquear}`).set('Authorization', `Bearer ${ownerToken}`)
    expect(detalle.status).toBe(403)
  })

  it('ningún aviso de actualizar tiene acuses (PlatformAnnouncementDelivery) ni buzón (Notification)', async () => {
    const avisos = (
      await prisma.platformAnnouncement.findMany({
        where: { posAppPlatform: { not: null }, createdBy: superId },
        select: { id: true },
        take: 100,
      })
    ).map(a => a.id)
    expect(avisos).toEqual(expect.arrayContaining([avisarVentana, avisarBanner, bloquear]))
    expect(await prisma.platformAnnouncementDelivery.count({ where: { announcementId: { in: avisos } } })).toBe(0)
    expect(await prisma.notification.count({ where: { entityId: { in: avisos } } })).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('bitácora: un asiento por cada escritura que dio 200, ninguno por un 409', () => {
  it('cada 200 tiene su asiento con before y after; los 409 no dejan nada', async () => {
    // Sin esto la prueba no probaría la mitad de «ningún 409»: hubo choques de verdad en este archivo.
    expect(escrituras.filter(e => e.status === 409).length).toBeGreaterThanOrEqual(4)

    const filas = await prisma.activityLog.findMany({
      where: { entity: 'PosAppVersionPolicy', staffId: superId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    })
    const avisosCreados = new Set<string>()

    for (const platform of ['ANDROID', 'IOS'] as const) {
      const exitosas = escrituras.filter(e => e.platform === platform && e.status === 200)
      const asientos = filas.filter(f => f.entityId === platform)
      // Un asiento por cada 200, y exactamente esas versiones: un 409 nunca escribe una versión (ni un asiento).
      expect(asientos.map(f => (f.data as any).after.version).sort((x: number, y: number) => x - y)).toEqual(
        exitosas.map(e => e.version as number).sort((x, y) => x - y),
      )

      for (const fila of asientos) {
        const data = fila.data as any
        const escritura = exitosas.find(e => e.version === data.after.version)!
        expect(fila.action).toBe(escritura.tipo === 'SET' ? 'POS_APP_VERSION_POLICY_SET' : 'POS_APP_VERSION_POLICY_CLEARED')
        expect(fila.venueId).toBeNull()
        expect(data.platform).toBe(platform)
        expect(data).toHaveProperty('before')
        expect(data.after).not.toBeNull()
        // La primera revisión no sustituye a nada; las demás sustituyen exactamente a la anterior.
        if (data.after.version === 1) expect(data.before).toBeNull()
        else expect(data.before.version).toBe(data.after.version - 1)
        for (const id of data.announcements.created as string[]) avisosCreados.add(id)
      }
    }

    // Lo que la bitácora dice que se creó son exactamente los avisos de actualizar que existen de este autor.
    const avisos = await prisma.platformAnnouncement.findMany({
      where: { posAppPlatform: { not: null }, createdBy: superId },
      select: { id: true },
      take: 100,
    })
    expect([...avisosCreados].sort()).toEqual(avisos.map(a => a.id).sort())

    // Ni el DUEÑO (403) dejó asiento.
    expect(await prisma.activityLog.count({ where: { entity: 'PosAppVersionPolicy', staffId: ownerId } })).toBe(0)
  })
})
