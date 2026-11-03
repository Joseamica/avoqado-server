/**
 * «Por cobrar» contra Postgres REAL (spec 2026-11-02-por-cobrar-superadmin §3.4, §5, §6 y §10): la API de SUPERADMIN con la app
 * entera, el JWT real y la base real, y los cruces entre pestañas con el candado del cobro de verdad.
 *
 * Lo ÚNICO falso es el PAC (Facturapi): un proveedor controlable por prueba. Los dobles en memoria de las pruebas unitarias no
 * pueden demostrar nada de esto: que `SELECT … FOR UPDATE` de verdad bloquee a la otra transacción, que la llave única impida dos
 * fechas, que los filtros de una columna `@db.Date` y el orden/paginación funcionen en Postgres, ni que un 403 salga del guardia
 * real. Los cruces NO se suponen por tiempos: se detiene una transacción con su candado tomado, se OBSERVA en `pg_stat_activity` /
 * `pg_blocking_pids` que la otra espera, y recién entonces se suelta (`tests/__helpers__/candadosDePostgres.ts`).
 *
 * Las fechas se prueban con la sesión de Postgres en UTC (la de producción) y en America/Mexico_City (la de la Mac): `dueDate` y
 * `paidAt` no pueden correrse un día según la zona.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://postgres:<password>@localhost:5432/avoqado_por_cobrar_test_<fecha>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/superadmin/platform-charges.integration.test.ts --ci
 */
// La bitácora se prueba de verdad: el setup de integración simula `logAction`.
jest.unmock('@/services/dashboard/activity-log.service')
// El PAC es la frontera: un proveedor falso que cada prueba controla. Todo lo demás (candado, transacciones, rutas) es real.
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))

import { Prisma, StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import app from '@/app'
import { aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'
import { startApiServer, api } from '@tests/__helpers__/apiServer'
import { ConflictError } from '@/errors/AppError'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import { createCharge, generateAllActive, pauseCharge, updateCharge } from '@/services/superadmin/platform-charges/charges.service'
import type { ChargeInput } from '@/services/superadmin/platform-charges/charges.service'
import { invoiceOccurrence } from '@/services/superadmin/platform-charges/invoice.service'
import {
  listOccurrences,
  payOccurrence,
  payPreview,
  reopenOccurrence,
  skipOccurrence,
  summarizeOccurrences,
} from '@/services/superadmin/platform-charges/occurrences.service'
import { calendarDayToDb, dbToCalendarDay, todayInMexico } from '@/services/superadmin/platform-charges/schedule'
import type { ChargeConcept } from '@/services/superadmin/platform-charges/types'
import prisma from '@/utils/prismaClient'

jest.setTimeout(180_000)

const suffix = `pc${Date.now()}`
/** Lo que el operador ve en pantalla: los datos del perfil del cobro. Sin esto no se timbra. */
const RECEPTOR = { rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL', regimenFiscal: '616', codigoPostal: '06000' }

const BASE = '/api/v1/superadmin/platform-charges'

const NOW = new Date('2026-11-02T18:00:00.000Z') // 12:00 en CDMX · lunes 2-nov-2026
const NOW_TARDE = new Date('2026-11-03T05:30:00.000Z') // 23:30 del 2-nov en CDMX, pero en UTC ya es 3-nov

const RENTA: ChargeConcept = {
  description: 'Renta de terminal',
  amountCents: 50000,
  ivaMode: 'WITHOUT_IVA',
  satProductKey: '81112401',
  satUnitKey: 'E48',
}
const LICENCIA: ChargeConcept = {
  description: 'Licencia',
  amountCents: 49900,
  ivaMode: 'WITH_IVA',
  satProductKey: '43232611',
  satUnitKey: 'E48',
}
/** $500 sin IVA + $499 con IVA, a mano: A=50000, B=49900 → subtotal 93017, IVA 14883, total 107900 (= 58000 + 49900). */
const TOTAL = 107900

// ── Lo que este archivo crea (y SÓLO eso se borra) ────────────────────────────────────────────────────────────────────────

const creado = {
  staff: [] as string[],
  venues: [] as string[],
  orgs: [] as string[],
  charges: [] as string[],
  profiles: [] as string[],
  emisores: [] as string[],
  cfdis: [] as string[],
}

let superToken = ''
let ownerToken = ''
let superId = ''

const tokenDe = (staffId: string, orgId: string, venueId: string, role: StaffRole) =>
  jwt.sign({ sub: staffId, orgId, venueId, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '30m' })

/**
 * El ajuste de zona que la BASE traía fijado ANTES de que este archivo la moviera (`null` = ninguno: valía el del servidor). Se
 * restaura tal cual al final, para no dejarle a las demás pruebas de la misma base una zona que no era la suya.
 */
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

/** Pone la zona de las sesiones NUEVAS de la base y recicla el pool para que las conexiones de Prisma la lean. */
async function fijarZonaDeSesion(zona: string): Promise<void> {
  const db = await nombreDeLaBase()
  await prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO '${zona}'`)
  await prisma.$disconnect()
  const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
  expect(tz).toBe(zona)
}

beforeAll(async () => {
  ajusteOriginal = { valor: await ajusteDeZonaDeLaBase() }

  const org = await prisma.organization.create({ data: { name: `Org ${suffix}`, email: `org-${suffix}@test.mx`, phone: '5555555555' } })
  creado.orgs.push(org.id)
  const venue = await prisma.venue.create({ data: { organizationId: org.id, name: `Venue ${suffix}`, slug: `venue-${suffix}` } })
  creado.venues.push(venue.id)

  const superadmin = await prisma.staff.create({
    data: { email: `super-${suffix}@test.mx`, firstName: 'Súper', lastName: 'Cobros', emailVerified: true },
  })
  const owner = await prisma.staff.create({
    data: { email: `owner-${suffix}@test.mx`, firstName: 'Dueño', lastName: 'Cobros', emailVerified: true },
  })
  creado.staff.push(superadmin.id, owner.id)
  superId = superadmin.id
  await prisma.staffVenue.create({ data: { staffId: superadmin.id, venueId: venue.id, role: StaffRole.SUPERADMIN, active: true } })
  await prisma.staffVenue.create({ data: { staffId: owner.id, venueId: venue.id, role: StaffRole.OWNER, active: true } })
  superToken = tokenDe(superadmin.id, org.id, venue.id, StaffRole.SUPERADMIN)
  ownerToken = tokenDe(owner.id, org.id, venue.id, StaffRole.OWNER)

  // El emisor activo con CSD (sin `PLATFORM_CHARGES_SANDBOX`, el flujo es el real y lo exige). La llave es del PAC falso: no hace falta.
  const emisor = await prisma.platformEmisor.create({
    data: {
      rfc: 'EKU9003173C9',
      legalName: `ESCUELA KEMPER URGATE ${suffix}`,
      regimenFiscal: '601',
      lugarExpedicion: '06000',
      provider: 'FACTURAPI',
      csdStatus: 'ACTIVE',
      isActive: true,
      serie: 'A',
    },
  })
  creado.emisores.push(emisor.id)
})

afterAll(async () => {
  try {
    // Toda limpieza va con ids que ESTE archivo creó: un `where` con un valor undefined vaciaría la tabla.
    if (ajusteOriginal) {
      const db = await nombreDeLaBase()
      await prisma.$executeRawUnsafe(
        ajusteOriginal.valor === null
          ? `ALTER DATABASE "${db}" RESET timezone`
          : `ALTER DATABASE "${db}" SET timezone TO '${ajusteOriginal.valor.replace(/'/g, "''")}'`,
      )
      await prisma.$disconnect()
    }
    const ocurrencias = creado.charges.length
      ? (
          await prisma.platformChargeOccurrence.findMany({
            where: { chargeId: { in: creado.charges } },
            select: { id: true },
            take: 100_000,
          })
        ).map(o => o.id)
      : []
    if (ocurrencias.length) await prisma.platformCfdi.deleteMany({ where: { platformChargeOccurrenceId: { in: ocurrencias } } })
    if (creado.cfdis.length) await prisma.platformCfdi.deleteMany({ where: { id: { in: creado.cfdis } } })
    if (creado.charges.length) {
      await prisma.platformChargeOccurrence.deleteMany({ where: { chargeId: { in: creado.charges } } })
      await prisma.activityLog.deleteMany({ where: { entity: 'PlatformCharge', entityId: { in: creado.charges } } })
      await prisma.platformCharge.deleteMany({ where: { id: { in: creado.charges } } })
    }
    if (creado.staff.length) await prisma.activityLog.deleteMany({ where: { staffId: { in: creado.staff } } })
    if (creado.profiles.length) await prisma.billingTaxProfile.deleteMany({ where: { id: { in: creado.profiles } } })
    if (creado.emisores.length) await prisma.platformEmisor.deleteMany({ where: { id: { in: creado.emisores } } })
    if (creado.staff.length) {
      await prisma.staffVenue.deleteMany({ where: { staffId: { in: creado.staff } } })
      await prisma.staff.deleteMany({ where: { id: { in: creado.staff } } })
    }
    if (creado.venues.length) await prisma.venue.deleteMany({ where: { id: { in: creado.venues } } })
    if (creado.orgs.length) await prisma.organization.deleteMany({ where: { id: { in: creado.orgs } } })
  } catch (error) {
    console.error('La limpieza de platform-charges.integration falló:', error)
  }
})

startApiServer(() => app)

// ── El PAC falso ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Sello {
  providerInvoiceId: string
  uuid: string
  serie: string
  folio: string
  totalCents: number
  stampedAt: Date
  status: 'valid'
}
let consecutivo = 0
const sello = (over: Partial<Sello> = {}): Sello => {
  consecutivo += 1
  return {
    providerInvoiceId: `fa-${suffix}-${consecutivo}`,
    uuid: `UUID-${suffix}-${consecutivo}`,
    serie: 'A',
    folio: '118',
    totalCents: TOTAL,
    stampedAt: new Date(),
    status: 'valid',
    ...over,
  }
}

let pac: {
  createInvoice: jest.Mock
  getInvoice: jest.Mock
  findByExternalId: jest.Mock
  getCancellationStatus: jest.Mock
  sendInvoiceByEmail: jest.Mock
}

beforeEach(() => {
  pac = {
    createInvoice: jest.fn(async () => sello()),
    getInvoice: jest.fn(),
    findByExternalId: jest.fn(async () => null),
    getCancellationStatus: jest.fn(),
    sendInvoiceByEmail: jest.fn().mockResolvedValue(undefined),
  }
  ;(resolveFiscalProvider as jest.Mock).mockReturnValue(pac)
})

// ── Utilerías ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

let n = 0
const unico = (texto: string) => `${texto} ${suffix} ${++n}`

interface Diferido<T> {
  promesa: Promise<T>
  resolver: (valor: T) => void
  rechazar: (motivo: unknown) => void
}
function diferido<T>(): Diferido<T> {
  let resolver!: (valor: T) => void
  let rechazar!: (motivo: unknown) => void
  const promesa = new Promise<T>((res, rej) => {
    resolver = res
    rechazar = rej
  })
  return { promesa, resolver, rechazar }
}

async function nuevoPerfil(over: Partial<Prisma.BillingTaxProfileUncheckedCreateInput> = {}) {
  const perfil = await prisma.billingTaxProfile.create({
    data: {
      customerType: 'STANDALONE',
      displayName: unico('Receptor'),
      rfc: 'XAXX010101000',
      razonSocial: 'PUBLICO EN GENERAL',
      regimenFiscal: '616',
      codigoPostal: '06000',
      ...over,
    },
  })
  creado.profiles.push(perfil.id)
  return perfil
}

/** Un cobro de un cliente externo (STANDALONE) con su perfil, creado por el servicio REAL (con sus ocurrencias). */
async function nuevoCobro(over: Partial<ChargeInput> = {}, now: Date = NOW) {
  const perfilId = over.billingTaxProfileId ?? (await nuevoPerfil()).id
  const cobro = await createCharge(
    {
      customerType: 'STANDALONE',
      customerName: unico('Cliente'),
      billingTaxProfileId: perfilId,
      frequency: 'WEEKLY',
      anchorDate: '2026-11-02',
      concepts: [RENTA, LICENCIA],
      invoiceMode: 'AUTOMATIC',
      ...over,
    },
    superId,
    now,
  )
  creado.charges.push(cobro.id)
  return cobro
}

const ocurrenciasDe = (chargeId: string) =>
  prisma.platformChargeOccurrence.findMany({ where: { chargeId }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: 200 })
const porFecha = async (chargeId: string, dia: string) =>
  prisma.platformChargeOccurrence.findUniqueOrThrow({ where: { chargeId_dueDate: { chargeId, dueDate: calendarDayToDb(dia) } } })
/** `['2026-11-02:PAID', …]` por fecha: el estado final de las filas, legible. */
const resumen = async (chargeId: string) => (await ocurrenciasDe(chargeId)).map(o => `${dbToCalendarDay(o.dueDate)}:${o.status}`)
const facturasDe = (occurrenceId: string) =>
  prisma.platformCfdi.findMany({ where: { platformChargeOccurrenceId: occurrenceId }, orderBy: { createdAt: 'asc' }, take: 20 })

const settle = <T>(resultados: PromiseSettledResult<T>[]) => ({
  cumplidas: resultados.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled').map(r => r.value),
  rechazadas: resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason),
})

const get = (path: string, token = superToken) => api().get(`${BASE}${path}`).set('Authorization', `Bearer ${token}`)
const post = (path: string, body: object = {}, token = superToken) =>
  api().post(`${BASE}${path}`).set('Authorization', `Bearer ${token}`).send(body)
const patch = (path: string, body: object, token = superToken) =>
  api().patch(`${BASE}${path}`).set('Authorization', `Bearer ${token}`).send(body)

/** `logAction` va después del commit y sin esperar: se sondea un momento hasta que lleguen las filas esperadas. */
async function filasDeBitacora(where: Prisma.ActivityLogWhereInput, esperadas: number) {
  const limite = Date.now() + 5_000
  for (;;) {
    const filas = await prisma.activityLog.findMany({ where, take: 50 })
    if (filas.length >= esperadas || Date.now() > limite) return filas
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
const bitacoras = (action: string, chargeId: string, esperadas: number) =>
  filasDeBitacora({ action, entity: 'PlatformCharge', entityId: chargeId }, esperadas)

/**
 * Como `aparcarLaSiguienteTransaccion`, pero aparca la transacción interactiva NÚMERO `numero` (1 = la próxima): corre su cuerpo
 * completo y se queda esperando ANTES del commit, con sus candados tomados. Las demás pasan intactas. Hace falta para detener la
 * RESERVA de la factura, que es la segunda transacción de «Facturar» (la primera prepara la foto).
 */
function aparcarLaTransaccion(numero: number) {
  const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>
  const puede = diferido<void>()
  const avisar = diferido<number>()
  let vistas = 0
  const espia = jest.spyOn(prisma, '$transaction').mockImplementation(((arg: unknown, opciones?: Record<string, unknown>) => {
    if (typeof arg !== 'function') return original(arg, opciones)
    vistas += 1
    if (vistas !== numero) return original(arg, opciones)
    const cuerpo = arg as (tx: any) => Promise<unknown>
    return original(
      async (tx: any) => {
        const resultado = await cuerpo(tx)
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
        avisar.resolver(Number(pid))
        await puede.promesa
        return resultado
      },
      { ...(opciones ?? {}), timeout: 60_000 },
    )
  }) as never)
  return { pid: avisar.promesa, soltar: () => puede.resolver(), restaurar: () => espia.mockRestore() }
}

/**
 * Detiene la transacción interactiva NÚMERO `numero` ANTES de que empiece (1 = la próxima): no hay candados tomados, es el hueco
 * entre lo que se hizo antes y lo que se hará después. La reserva de la factura es la segunda de «Facturar» (la primera prepara la
 * foto): aquí se prueba lo que pasa si «Deshacer» entra completo justo en ese hueco.
 */
function retenerLaTransaccion(numero: number) {
  const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>
  const puede = diferido<void>()
  const llego = diferido<void>()
  let vistas = 0
  const espia = jest.spyOn(prisma, '$transaction').mockImplementation((async (arg: unknown, opciones?: Record<string, unknown>) => {
    if (typeof arg === 'function') {
      vistas += 1
      if (vistas === numero) {
        llego.resolver()
        await puede.promesa
      }
    }
    return original(arg, opciones)
  }) as never)
  return { llego: llego.promesa, soltar: () => puede.resolver(), restaurar: () => espia.mockRestore() }
}

/** Espera a que alguien esté bloqueado en el candado de un cobro por la transacción `pid`; falla con un mensaje claro si no. */
async function esperaElCandado(pid: number) {
  // 60 s: con la Mac cargada, el generador tarda en llegar al cobro porque antes recorre todos los activos.
  const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /FOR UPDATE/, ms: 60_000 })
  expect(espera).not.toBeNull() // el cruce SE PROVOCÓ: la otra transacción espera el candado del cobro
  expect(espera!.waitEventType).toBe('Lock')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('API de SUPERADMIN: el guardia real y la forma de lo que sale (HTTP, JWT y Postgres reales)', () => {
  const RUTAS: Array<['get' | 'post' | 'patch', string]> = [
    ['get', '/summary'],
    ['get', '/occurrences'],
    ['get', '/occurrences/x/pay-preview'],
    ['post', '/occurrences/x/pay'],
    ['post', '/occurrences/x/skip'],
    ['post', '/occurrences/x/reopen'],
    ['post', '/occurrences/x/invoice'],
    ['get', '/'],
    ['post', '/'],
    ['patch', '/x'],
    ['post', '/x/pause'],
    ['post', '/x/resume'],
  ]

  it('quien no es SUPERADMIN recibe 403 en CADA ruta (lecturas y escrituras), y sin token es 401', async () => {
    for (const [metodo, ruta] of RUTAS) {
      const sinToken = await api()[metodo](`${BASE}${ruta}`).send({})
      expect([metodo, ruta, sinToken.status]).toEqual([metodo, ruta, 401])
      const comoDueno = await api()[metodo](`${BASE}${ruta}`).set('Authorization', `Bearer ${ownerToken}`).send({})
      expect([metodo, ruta, comoDueno.status]).toEqual([metodo, ruta, 403])
    }
  })

  it('un DUEÑO tampoco puede escribir: su intento de crear un cobro no deja nada', async () => {
    const nombre = unico('Cliente del dueño')
    const res = await post(
      '/',
      {
        customerType: 'STANDALONE',
        customerName: nombre,
        frequency: 'WEEKLY',
        anchorDate: '2026-11-02',
        concepts: [RENTA],
        invoiceMode: 'MANUAL',
      },
      ownerToken,
    )

    expect(res.status).toBe(403)
    expect(await prisma.platformCharge.count({ where: { customerName: nombre } })).toBe(0)
  })

  it('crear un cobro y leerlo: anchorDate y dueDate salen como TEXTO YYYY-MM-DD (nunca un instante), con sus totales y su bucket', async () => {
    const hoy = todayInMexico(new Date())
    const ancla = new Date(calendarDayToDb(hoy).getTime() - 7 * 86_400_000).toISOString().slice(0, 10) // hoy − 7 días
    const perfil = await nuevoPerfil()
    const nombre = unico('Estética')

    const creada = await post('/', {
      customerType: 'STANDALONE',
      customerName: nombre,
      billingTaxProfileId: perfil.id,
      frequency: 'WEEKLY',
      anchorDate: ancla,
      concepts: [RENTA, LICENCIA],
      invoiceMode: 'AUTOMATIC',
    })

    expect(creada.status).toBe(201)
    creado.charges.push(creada.body.data.id)
    expect(creada.body).toMatchObject({
      success: true,
      data: { customerName: nombre, anchorDate: ancla, invoiceMode: 'AUTOMATIC', pausedAt: null },
    })
    expect(typeof creada.body.data.anchorDate).toBe('string')

    const lista = await get(`/occurrences?view=open&q=${encodeURIComponent(nombre)}`)
    expect(lista.status).toBe(200)
    expect(lista.body.meta).toEqual({ total: 3, page: 1, pageSize: 50 })
    const filas = lista.body.data as Array<Record<string, any>>
    expect(filas.map(f => [f.dueDate, f.bucket])).toEqual([
      [ancla, 'OVERDUE'],
      [hoy, 'TODAY'],
      [new Date(calendarDayToDb(hoy).getTime() + 7 * 86_400_000).toISOString().slice(0, 10), 'UPCOMING'],
    ])
    for (const f of filas) {
      expect(typeof f.dueDate).toBe('string')
      expect(f.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(f).toMatchObject({ customerName: nombre, frequency: 'WEEKLY', totalCents: TOTAL, status: 'PENDING', invoice: null })
    }

    const cobros = await get(`/?q=${encodeURIComponent(nombre)}`)
    expect(cobros.status).toBe(200)
    expect(cobros.body.meta).toMatchObject({ total: 1 })
    expect(cobros.body.data[0]).toMatchObject({ id: creada.body.data.id, anchorDate: ancla })
    expect(typeof cobros.body.data[0].anchorDate).toBe('string')

    const resumenHttp = await get('/summary')
    expect(resumenHttp.status).toBe(200)
    expect(resumenHttp.body.data.today).toBe(hoy)
  })

  it('lo mal formado es 400 en español (y nada se escribe): tipo de cliente, periodicidad, vista y la casilla de la factura', async () => {
    const malo = await post('/', {
      customerType: 'NADIE',
      customerName: 'x',
      frequency: 'DIARIO',
      anchorDate: 'ayer',
      concepts: [],
      invoiceMode: 'AUTOMATIC',
    })
    expect(malo.status).toBe(400)
    expect(malo.body.message).toMatch(/Error de validación/)
    expect(malo.body.message).toMatch(/El tipo de cliente debe ser/)
    expect(malo.body.message).toMatch(/La periodicidad debe ser/)
    expect(malo.body.message).toMatch(/AAAA-MM-DD/)

    const vista = await get('/occurrences?view=todo')
    expect(vista.status).toBe(400)
    expect(vista.body.message).toMatch(/La vista debe ser open, paid o skipped/)

    const sinCasilla = await post('/occurrences/x/pay', {})
    expect(sinCasilla.status).toBe(400)
    expect(sinCasilla.body.message).toMatch(/Indica si se timbra la factura ahora/)
  })

  it('el tope de página lo impone el servidor: pageSize=500 devuelve a lo más 100 filas y dice cuál usó', async () => {
    const res = await get('/occurrences?view=paid&pageSize=500&page=1')

    expect(res.status).toBe(200)
    expect(res.body.meta.pageSize).toBe(100)
    expect(res.body.data.length).toBeLessThanOrEqual(100)
    expect(typeof res.body.meta.total).toBe('number')
  })

  it('un cobro de una organización con el perfil fiscal de OTRO cliente es 400 (el BadRequestError del servicio pasa por el manejador)', async () => {
    const ajeno = await nuevoPerfil({ customerType: 'ORGANIZATION', organizationId: `org-ajena-${suffix}` })

    const res = await post('/', {
      customerType: 'STANDALONE',
      customerName: unico('Mal perfil'),
      billingTaxProfileId: ajeno.id,
      frequency: 'WEEKLY',
      anchorDate: todayInMexico(new Date()),
      concepts: [RENTA],
      invoiceMode: 'AUTOMATIC',
    })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'PLATFORM_CHARGE_TAX_PROFILE_MISMATCH' })
  })

  it('el recorrido completo por HTTP: vista previa, pagar sin timbrar, repetir, omitir, deshacer, pagar con factura y la bitácora de cada paso', async () => {
    const hoy = todayInMexico(new Date())
    const perfil = await nuevoPerfil()
    const nombre = unico('Taller')
    const cobro = await post('/', {
      customerType: 'STANDALONE',
      customerName: nombre,
      billingTaxProfileId: perfil.id,
      frequency: 'MONTHLY',
      anchorDate: hoy,
      concepts: [RENTA, LICENCIA],
      invoiceMode: 'AUTOMATIC',
    })
    expect(cobro.status).toBe(201)
    const chargeId: string = cobro.body.data.id
    creado.charges.push(chargeId)
    const [ocurrencia] = await ocurrenciasDe(chargeId)
    const id = ocurrencia.id

    // Vista previa: a quién se timbraría y por cuánto.
    const vista = await get(`/occurrences/${id}/pay-preview`)
    expect(vista.status).toBe(200)
    expect(vista.body.data).toMatchObject({
      customerName: nombre,
      customerType: cobro.body.data.customerType,
      organizationId: cobro.body.data.organizationId,
      venueId: cobro.body.data.venueId,
      billingTaxProfileId: cobro.body.data.billingTaxProfileId,
      totalCents: TOTAL,
      willInvoice: true,
      receptor: RECEPTOR,
      pendingPpdCount: 0,
    })

    // Omitir → una omitida no se paga (409) → deshacer.
    const omitida = await post(`/occurrences/${id}/skip`)
    expect(omitida.body.data).toMatchObject({ id, status: 'SKIPPED', bucket: null })
    const pagarOmitida = await post(`/occurrences/${id}/pay`, { invoice: false })
    expect(pagarOmitida.status).toBe(409) // el ConflictError conserva su 409 (no lo vuelve 422 ni 500)
    expect(pagarOmitida.body.message).toMatch(/omitido/)
    const reabierta = await post(`/occurrences/${id}/reopen`)
    expect(reabierta.status).toBe(200)
    expect(reabierta.body.data).toMatchObject({ id, status: 'PENDING', paidAt: null, skippedAt: null, bucket: 'TODAY' })

    // Pagar SIN timbrar: una automática queda manual y no se factura. Repetir contesta éxito y no vuelve a escribir.
    const pagada = await post(`/occurrences/${id}/pay`, { invoice: false })
    expect(pagada.status).toBe(200)
    expect(pagada.body.data.occurrence).toMatchObject({ id, status: 'PAID', invoiceMode: 'MANUAL', bucket: null })
    expect(pagada.body.data.invoice).toBeNull()
    const otraVez = await post(`/occurrences/${id}/pay`, { invoice: true, receptor: RECEPTOR })
    expect(otraVez.status).toBe(200)
    expect(otraVez.body.data.invoice).toBeNull()
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(await facturasDe(id)).toHaveLength(0)
    expect(await bitacoras('PLATFORM_CHARGE_PAID', chargeId, 1)).toHaveLength(1) // repetir no repite la bitácora

    // «Facturar» (el botón de una pagada sin factura): timbra con la llave por-cobrar:<id>:0 y la fila queda viva.
    const facturada = await post(`/occurrences/${id}/invoice`, { receptor: RECEPTOR })
    expect(facturada.status).toBe(200)
    expect(facturada.body.data.cfdi).toMatchObject({ status: 'STAMPED', serie: 'A', folio: '118', idempotencyKey: `por-cobrar:${id}:0` })
    expect(facturada.body.data.occurrence).toMatchObject({
      id,
      status: 'PAID',
      invoice: { status: 'STAMPED', serie: 'A', folio: '118', emailSentAt: null },
    })
    expect(pac.createInvoice).toHaveBeenCalledTimes(1)

    // Con la factura viva no se deshace: 409 con el texto de la spec.
    const deshacer = await post(`/occurrences/${id}/reopen`)
    expect(deshacer.status).toBe(409)
    expect(deshacer.body.message).toBe('Cancela primero la factura A-118 en Facturas CFDI')
    expect((await porFecha(chargeId, hoy)).status).toBe('PAID')

    // La bitácora de cada paso llegó de verdad a la base, con quien lo hizo.
    const [pago] = await bitacoras('PLATFORM_CHARGE_PAID', chargeId, 1)
    expect(pago).toMatchObject({ staffId: superId, entity: 'PlatformCharge', entityId: chargeId })
    expect(pago.data).toMatchObject({ occurrenceId: id, dueDate: hoy, totalCents: TOTAL, invoice: false, invoiceMode: 'MANUAL' })
    expect(await bitacoras('PLATFORM_CHARGE_SKIPPED', chargeId, 1)).toHaveLength(1)
    expect(await bitacoras('PLATFORM_CHARGE_REOPENED', chargeId, 1)).toHaveLength(1)
    const emitidas = await filasDeBitacora({ action: 'PLATFORM_CFDI_ISSUED', entity: 'PlatformCfdi', staffId: superId }, 1)
    expect(emitidas.filter(e => (e.data as { platformChargeOccurrenceId?: string })?.platformChargeOccurrenceId === id)).toHaveLength(1) // una sola
  })

  it('«Ya me pagó» con factura que FALLA: responde 200, sigue pagada y trae el motivo (un RFC malo es VALIDATION con su campo)', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const [ocurrencia] = await ocurrenciasDe(cobro.id)
    pac.createInvoice.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'El campo Rfc del receptor no se encuentra en el listado del SAT.'),
    )

    const res = await post(`/occurrences/${ocurrencia.id}/pay`, { invoice: true, receptor: RECEPTOR })

    expect(res.status).toBe(200)
    expect(res.body.data.occurrence.status).toBe('PAID')
    expect(res.body.data.invoice).toMatchObject({ ok: false, code: 'VALIDATION', field: 'rfc' })
    expect(res.body.data.occurrence.invoice).toMatchObject({ status: 'STAMP_FAILED' })
  })

  it('🔴 «Consultar estado» (sin datos) sólo consulta: con el intento perdido lo cierra y no timbra; «Facturar» con lo que se ve, sí', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const [ocurrencia] = await ocurrenciasDe(cobro.id)
    await post(`/occurrences/${ocurrencia.id}/pay`, { invoice: false })
    pac.createInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))
    await post(`/occurrences/${ocurrencia.id}/invoice`, { receptor: RECEPTOR })
    await prisma.platformCfdi.updateMany({
      where: { platformChargeOccurrenceId: ocurrencia.id },
      data: { createdAt: new Date(Date.now() - 3 * 60_000) },
    })
    pac.findByExternalId.mockResolvedValue(null)
    pac.createInvoice.mockClear()

    const consulta = await post(`/occurrences/${ocurrencia.id}/invoice`, {})

    expect(consulta.status).toBe(409)
    expect(consulta.body.message).toMatch(/usa «Facturar»/)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(await facturasDe(ocurrencia.id)).toHaveLength(0)

    const facturada = await post(`/occurrences/${ocurrencia.id}/invoice`, { receptor: RECEPTOR })
    expect(facturada.status).toBe(200)
    expect(facturada.body.data.cfdi).toMatchObject({ status: 'STAMPED', receptorRfc: 'XAXX010101000' })
  })

  it('pagar con factura sin decir a quién se confirmó es 400 y no marca nada', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const [ocurrencia] = await ocurrenciasDe(cobro.id)

    const res = await post(`/occurrences/${ocurrencia.id}/pay`, { invoice: true })

    expect(res.status).toBe(400)
    expect((await ocurrenciasDe(cobro.id))[0].status).toBe('PENDING')
  })

  it('un corte de red al timbrar es 502 y dice «pudo quedar en camino… no la timbres otra vez»; el reintento inmediato es un 409', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const [ocurrencia] = await ocurrenciasDe(cobro.id)
    await post(`/occurrences/${ocurrencia.id}/pay`, { invoice: false })
    pac.createInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))

    const corte = await post(`/occurrences/${ocurrencia.id}/invoice`, { receptor: RECEPTOR })

    expect(corte.status).toBe(502)
    expect(corte.body).toMatchObject({ success: false, code: 'PROVIDER' })
    expect(corte.body.error).toMatch(/^La factura pudo quedar en camino: consulta su estado en 2 minutos y no la timbres otra vez\./)
    expect(corte.body.error).toContain('ECONNRESET')
    const [fila] = await facturasDe(ocurrencia.id)
    expect(fila).toMatchObject({ status: 'STAMPING', lastError: 'ECONNRESET' })

    const reintento = await post(`/occurrences/${ocurrencia.id}/invoice`, { receptor: RECEPTOR })
    expect(reintento.status).toBe(409)
    expect(reintento.body.message).toMatch(/se está timbrando/)
    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    // La lista expone el STAMPING con su error para el aviso de la pantalla.
    const lista = await get(`/occurrences?view=paid&q=${encodeURIComponent(cobro.customerName)}`)
    expect(lista.body.data[0].invoice).toMatchObject({ status: 'STAMPING', lastError: 'ECONNRESET', emailSentAt: null })
  })

  it('editar, pausar y reanudar por HTTP: las rutas están cableadas y la fecha vuelve como texto', async () => {
    const cobro = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-11-02' })
    const ids = await ocurrenciasDe(cobro.id)

    const editado = await patch(`/${cobro.id}`, { customerName: unico('Renombrado') })
    expect(editado.status).toBe(200)
    expect(editado.body.data).toMatchObject({ id: cobro.id, anchorDate: '2026-11-02' })

    const pausado = await post(`/${cobro.id}/pause`, { skipOverdue: true })
    expect(pausado.status).toBe(200)
    expect(pausado.body.data.pausedAt).not.toBeNull()
    expect(ids.length).toBeGreaterThan(0)

    const reanudado = await post(`/${cobro.id}/resume`)
    expect(reanudado.status).toBe(200)
    expect(reanudado.body.data).toMatchObject({ pausedAt: null, anchorDate: '2026-11-02' })

    const inexistente = await post('/no-existe/resume')
    expect(inexistente.status).toBe(404)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('dos pestañas a la vez (el candado del cobro de verdad bloquea a la otra transacción)', () => {
  it('dos «Ya me pagó» a la vez, la primera detenida con su candado: la segunda espera, ve «ya pagada» y NO factura. Una sola factura', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const ocurrencia = await porFecha(cobro.id, '2026-11-02')
    const aparcada = aparcarLaTransaccion(1)
    try {
      const primera = payOccurrence(ocurrencia.id, { invoice: true, receptor: RECEPTOR }, superId, NOW)
      const pid = await aTiempo(aparcada.pid, 60_000, 'la primera marcó PAID y quedó aparcada con su candado')

      const segunda = payOccurrence(ocurrencia.id, { invoice: true, receptor: RECEPTOR }, superId, NOW)
      await esperaElCandado(pid)
      aparcada.soltar()

      const [a, b] = await Promise.all([primera, segunda])
      expect(a.invoice).toMatchObject({ ok: true, cfdi: { status: 'STAMPED' } })
      expect(b.invoice).toBeNull() // «ya pagado»: éxito, sin volver a facturar
      expect(b.occurrence.status).toBe('PAID')
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }

    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    expect(await facturasDe(ocurrencia.id)).toHaveLength(1)
    expect((await porFecha(cobro.id, '2026-11-02')).paidById).toBe(superId)
    expect(await bitacoras('PLATFORM_CHARGE_PAID', cobro.id, 1)).toHaveLength(1)
  })

  it('dos «Ya me pagó» disparados juntos (sin detener nada), varias veces: SIEMPRE una factura y un solo pago', async () => {
    for (let i = 0; i < 4; i++) {
      pac.createInvoice.mockClear()
      const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
      const ocurrencia = await porFecha(cobro.id, '2026-11-02')

      const resultados = settle(
        await Promise.allSettled([
          payOccurrence(ocurrencia.id, { invoice: true, receptor: RECEPTOR }, superId, NOW),
          payOccurrence(ocurrencia.id, { invoice: true, receptor: RECEPTOR }, superId, NOW),
        ]),
      )

      expect(resultados.rechazadas).toHaveLength(0)
      expect(pac.createInvoice).toHaveBeenCalledTimes(1)
      expect(await facturasDe(ocurrencia.id)).toHaveLength(1)
      expect(resultados.cumplidas.filter(r => r.invoice !== null)).toHaveLength(1)
    }
  })

  it('«Facturar» detenida entre la reserva y el proveedor: «Deshacer» contesta 409 «se está timbrando», y la factura termina viva', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const ocurrencia = await porFecha(cobro.id, '2026-11-02')
    await payOccurrence(ocurrencia.id, { invoice: false }, superId, NOW)

    const enProveedor = diferido<void>()
    const respuesta = diferido<Sello>()
    pac.createInvoice.mockImplementationOnce(() => {
      enProveedor.resolver() // la reserva YA se confirmó (la fila STAMPING existe) y el timbrado está en vuelo
      return respuesta.promesa
    })
    const facturando = invoiceOccurrence(ocurrencia.id, { actorId: superId, receptor: RECEPTOR })
    await aTiempo(enProveedor.promesa, 60_000, 'Facturar llegó al proveedor falso, ya con su fila STAMPING reservada')
    expect((await facturasDe(ocurrencia.id))[0]).toMatchObject({ status: 'STAMPING', idempotencyKey: `por-cobrar:${ocurrencia.id}:0` })

    const deshacer = await reopenOccurrence(ocurrencia.id, superId, NOW).catch((e: unknown) => e)

    expect(deshacer).toBeInstanceOf(ConflictError)
    expect((deshacer as ConflictError).statusCode).toBe(409)
    expect((deshacer as ConflictError).message).toMatch(/se está timbrando/)
    expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PAID') // sigue pagada

    respuesta.resolver(sello())
    const cfdi = await facturando
    expect(cfdi.status).toBe('STAMPED')
    expect(await facturasDe(ocurrencia.id)).toHaveLength(1)
    expect((await porFecha(cobro.id, '2026-11-02')).invoiceSeq).toBe(0)
  })

  it('la RESERVA de «Facturar» detenida con su candado: «Deshacer» espera el candado, ve la fila reservada y contesta 409 (nunca una factura de una pendiente)', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const ocurrencia = await porFecha(cobro.id, '2026-11-02')
    await payOccurrence(ocurrencia.id, { invoice: false }, superId, NOW)
    const enProveedor = diferido<void>()
    const respuesta = diferido<Sello>()
    pac.createInvoice.mockImplementationOnce(() => {
      enProveedor.resolver()
      return respuesta.promesa
    })

    // La transacción 1 de «Facturar» prepara la foto; la 2 es la RESERVA (comprueba PAID y crea la fila STAMPING): ésa se detiene.
    const aparcada = aparcarLaTransaccion(2)
    let facturando: Promise<unknown> | undefined
    let deshaciendo: Promise<unknown> | undefined
    try {
      facturando = invoiceOccurrence(ocurrencia.id, { actorId: superId, receptor: RECEPTOR })
      const pid = await aTiempo(aparcada.pid, 60_000, 'la reserva creó su fila y quedó aparcada, sin commit, con el candado del cobro')

      deshaciendo = reopenOccurrence(ocurrencia.id, superId, NOW)
      deshaciendo.catch(() => undefined)
      await esperaElCandado(pid) // «Deshacer» llegó al candado sin ver la fila (aún sin commit) y espera
      aparcada.soltar() // la reserva se confirma
      await aTiempo(enProveedor.promesa, 60_000, 'la factura llegó al proveedor falso')

      const error = await deshaciendo.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).statusCode).toBe(409)
      expect((error as ConflictError).message).toMatch(/intento de factura/) // la fila STAMPING de la llave actual
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      respuesta.resolver(sello())
    }
    expect(((await facturando) as { status: string }).status).toBe('STAMPED')

    expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PAID')
    expect(await facturasDe(ocurrencia.id)).toHaveLength(1)
    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('«Deshacer» primero, detenido con su candado: «Facturar» (que ya había visto PAID) espera, ve PENDING y NO llama al proveedor', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const ocurrencia = await porFecha(cobro.id, '2026-11-02')
    await payOccurrence(ocurrencia.id, { invoice: false }, superId, NOW)

    const aparcada = aparcarLaTransaccion(1)
    let deshaciendo: Promise<unknown> | undefined
    let facturando: Promise<unknown> | undefined
    try {
      deshaciendo = reopenOccurrence(ocurrencia.id, superId, NOW)
      const pid = await aTiempo(aparcada.pid, 60_000, '«Deshacer» ya escribió PENDING y quedó aparcado con el candado, sin commit')

      facturando = invoiceOccurrence(ocurrencia.id, { actorId: superId, receptor: RECEPTOR })
      facturando.catch(() => undefined)
      await esperaElCandado(pid) // «Facturar» pasó su primera comprobación de PAID (lo confirmado todavía es PAID) y espera el candado
      aparcada.soltar()

      const error = await facturando.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).statusCode).toBe(409)
      expect((error as ConflictError).message).toMatch(/no está marcado como pagado/)
      await deshaciendo
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }

    expect(pac.createInvoice).not.toHaveBeenCalled() // el proveedor jamás se llamó
    expect(await facturasDe(ocurrencia.id)).toHaveLength(0)
    expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PENDING')
  })

  it('«Deshacer» entra ENTRE la foto y la reserva de «Facturar»: la reserva (reserveCheck, en su misma transacción) ve PENDING, no deja fila y NO llama al proveedor', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const ocurrencia = await porFecha(cobro.id, '2026-11-02')
    await payOccurrence(ocurrencia.id, { invoice: false }, superId, NOW)

    const retenida = retenerLaTransaccion(2) // la 1 prepara la foto; la 2 es la reserva: se detiene ANTES de empezar
    let facturando: Promise<unknown> | undefined
    try {
      facturando = invoiceOccurrence(ocurrencia.id, { actorId: superId, receptor: RECEPTOR })
      facturando.catch(() => undefined)
      await aTiempo(retenida.llego, 60_000, '«Facturar» terminó de preparar su foto y está por reservar la factura')

      await reopenOccurrence(ocurrencia.id, superId, NOW) // «Deshacer» entra completo en el hueco y confirma PENDING
      expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PENDING')
      retenida.soltar()

      const error = await facturando.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).statusCode).toBe(409)
      expect((error as ConflictError).message).toMatch(/no está marcado como pagado/)
    } finally {
      retenida.soltar()
      retenida.restaurar()
    }

    expect(pac.createInvoice).not.toHaveBeenCalled() // el proveedor jamás se llamó
    expect(await facturasDe(ocurrencia.id)).toHaveLength(0) // y la fila de la reserva no nació
    expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PENDING')
  })

  describe('editar la fecha y pagar a la vez', () => {
    /** Semanal con ancla el 5-nov (hoy+3): una sola ocurrencia, FUTURA y pendiente, dentro de la ventana de generación. */
    const cobroConUnaFutura = async () => {
      const cobro = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-11-05', invoiceMode: 'MANUAL' })
      expect(await resumen(cobro.id)).toEqual(['2026-11-05:PENDING'])
      return cobro
    }

    it('PAGAR primero (detenido con su candado): editar la fecha espera y contesta 409 «Ya marcaste el cobro del 5 nov»: queda una pagada y NINGUNA nueva', async () => {
      const cobro = await cobroConUnaFutura()
      const ocurrencia = await porFecha(cobro.id, '2026-11-05')
      const aparcada = aparcarLaTransaccion(1)
      let editando: Promise<unknown> | undefined
      try {
        const pagando = payOccurrence(ocurrencia.id, { invoice: false }, superId, NOW)
        const pid = await aTiempo(aparcada.pid, 60_000, 'pagar escribió PAID y quedó aparcado con el candado')
        editando = updateCharge(cobro.id, { anchorDate: '2026-11-06' }, superId, NOW)
        editando.catch(() => undefined)
        await esperaElCandado(pid)
        aparcada.soltar()
        await pagando
        const error = await editando.catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ConflictError)
        expect((error as ConflictError).message).toBe('Ya marcaste el cobro del 5 nov; deshazlo para cambiar la fecha')
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect(await resumen(cobro.id)).toEqual(['2026-11-05:PAID']) // ni una pendiente nueva del mismo periodo
      expect((await prisma.platformCharge.findUniqueOrThrow({ where: { id: cobro.id } })).anchorDate.toISOString()).toBe(
        '2026-11-05T00:00:00.000Z',
      ) // el ancla no cambió
    })

    it('EDITAR primero (detenido con su candado): pagar espera, ya no encuentra la ocurrencia vieja (404) y queda sólo la nueva, pendiente', async () => {
      const cobro = await cobroConUnaFutura()
      const vieja = await porFecha(cobro.id, '2026-11-05')
      const aparcada = aparcarLaTransaccion(1)
      let pagando: Promise<unknown> | undefined
      try {
        const editando = updateCharge(cobro.id, { anchorDate: '2026-11-06' }, superId, NOW)
        const pid = await aTiempo(aparcada.pid, 60_000, 'editar regeneró las fechas y quedó aparcado con el candado')
        pagando = payOccurrence(vieja.id, { invoice: false }, superId, NOW)
        pagando.catch(() => undefined)
        await esperaElCandado(pid)
        aparcada.soltar()
        await editando
        const error = await pagando.catch((e: unknown) => e)
        expect(error).toMatchObject({ statusCode: 404, code: 'PLATFORM_CHARGE_OCCURRENCE_NOT_FOUND' })
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect(await resumen(cobro.id)).toEqual(['2026-11-06:PENDING'])
    })

    it('disparadas juntas, varias veces: el resultado NUNCA deja una pagada y una pendiente nueva del mismo periodo', async () => {
      const finales = new Set<string>()
      for (let i = 0; i < 6; i++) {
        const cobro = await cobroConUnaFutura()
        const ocurrencia = await porFecha(cobro.id, '2026-11-05')

        await Promise.allSettled([
          payOccurrence(ocurrencia.id, { invoice: false }, superId, NOW),
          updateCharge(cobro.id, { anchorDate: '2026-11-06' }, superId, NOW),
        ])

        finales.add((await resumen(cobro.id)).join(','))
      }
      // Los dos desenlaces legítimos, y ninguno más: o ganó el pago (y la edición recibió el 409), o ganó la edición (y el pago, un 404).
      for (const final of finales) expect(['2026-11-05:PAID', '2026-11-06:PENDING']).toContain(final)
    })
  })

  describe('generar y pausar a la vez', () => {
    /** Semanal con ancla hoy: la de hoy y la de dentro de 7 días (futura, pendiente). */
    const cobroActivo = async () => {
      const cobro = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-11-02', invoiceMode: 'MANUAL' })
      expect(await resumen(cobro.id)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING'])
      return cobro
    }
    const futurasPendientes = async (chargeId: string) =>
      (await ocurrenciasDe(chargeId)).filter(o => o.status === 'PENDING' && dbToCalendarDay(o.dueDate) > '2026-11-02')

    it('PAUSAR primero (detenido con su candado): el generador, que ya había leído el cobro como activo, espera, lo relee pausado y NO reinserta nada', async () => {
      const cobro = await cobroActivo()
      const aparcada = aparcarLaTransaccion(1)
      let generando: Promise<unknown> | undefined
      try {
        const pausando = pauseCharge(cobro.id, { skipOverdue: false }, superId, NOW)
        const pid = await aTiempo(aparcada.pid, 60_000, 'pausar borró las futuras y quedó aparcado con el candado')
        // Se borró la futura y está sin confirmar: el generador todavía ve el cobro activo (pausedAt null) y la fecha ya no existe.
        generando = generateAllActive(NOW)
        generando.catch(() => undefined)
        await esperaElCandado(pid)
        aparcada.soltar()
        await Promise.all([pausando, generando])
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect((await prisma.platformCharge.findUniqueOrThrow({ where: { id: cobro.id } })).pausedAt).not.toBeNull()
      expect(await futurasPendientes(cobro.id)).toHaveLength(0) // ninguna PENDING futura
      expect(await resumen(cobro.id)).toEqual(['2026-11-02:PENDING']) // lo de hoy se conserva por cobrar
    })

    it('disparados juntos, varias veces (el generador recorre todos los cobros activos): jamás queda una PENDING futura de un cobro pausado', async () => {
      for (let i = 0; i < 6; i++) {
        const cobro = await cobroActivo()

        const resultados = settle(
          await Promise.allSettled([pauseCharge(cobro.id, { skipOverdue: false }, superId, NOW), generateAllActive(NOW)]),
        )

        expect(resultados.rechazadas).toHaveLength(0)
        expect((await prisma.platformCharge.findUniqueOrThrow({ where: { id: cobro.id } })).pausedAt).not.toBeNull()
        expect(await futurasPendientes(cobro.id)).toHaveLength(0)
      }
    })
  })

  describe('la llave única [chargeId, dueDate]', () => {
    it('impide dos ocurrencias de la misma fecha, aunque se intente a mano o con skipDuplicates', async () => {
      const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
      const existente = await porFecha(cobro.id, '2026-11-02')
      const copia = {
        chargeId: cobro.id,
        dueDate: calendarDayToDb('2026-11-02'),
        concepts: existente.concepts as Prisma.InputJsonValue,
        subtotalCents: existente.subtotalCents,
        taxCents: existente.taxCents,
        totalCents: existente.totalCents,
        invoiceMode: existente.invoiceMode,
      }

      await expect(prisma.platformChargeOccurrence.create({ data: copia })).rejects.toMatchObject({ code: 'P2002' })
      const { count } = await prisma.platformChargeOccurrence.createMany({ data: [copia], skipDuplicates: true })

      expect(count).toBe(0)
      expect(await ocurrenciasDe(cobro.id)).toHaveLength(1)
    })

    it('dos generadores a la vez no duplican fechas: las filas son las mismas y las ya pagadas no se tocan', async () => {
      const cobro = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-11-02', invoiceMode: 'MANUAL' })
      const hoy = await porFecha(cobro.id, '2026-11-02')
      await payOccurrence(hoy.id, { invoice: false }, superId, NOW)
      const antes = await resumen(cobro.id)

      const resultados = settle(await Promise.allSettled([generateAllActive(NOW), generateAllActive(NOW)]))

      expect(resultados.rechazadas).toHaveLength(0)
      expect(await resumen(cobro.id)).toEqual(antes)
      expect(antes).toEqual(['2026-11-02:PAID', '2026-11-09:PENDING'])
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('«Deshacer» frente a una factura que falló o que quedó en camino (el PAC falso contesta lo que cada caso pide)', () => {
  /** Una ocurrencia que se pagó con factura y el timbrado falló como se indique. */
  async function pagadaConFalla(error: Error) {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const ocurrencia = await porFecha(cobro.id, '2026-11-02')
    pac.createInvoice.mockRejectedValueOnce(error)
    const resultado = await payOccurrence(ocurrencia.id, { invoice: true, receptor: RECEPTOR }, superId, NOW)
    expect(resultado.invoice).toMatchObject({ ok: false })
    expect(resultado.occurrence.status).toBe('PAID') // el cobro sigue pagado
    return { cobro, ocurrencia }
  }
  /** Pasan los 2 minutos de espera de un intento que nunca nos contestó. */
  const pasanDosMinutos = (occurrenceId: string) =>
    prisma.platformCfdi.updateMany({
      where: { platformChargeOccurrenceId: occurrenceId },
      data: { createdAt: new Date(Date.now() - 3 * 60_000) },
    })

  it('tras un rechazo CONFIRMADO del PAC: se confirma con él, se borra el intento (sube invoiceSeq) y regresa a pendiente', async () => {
    const { cobro, ocurrencia } = await pagadaConFalla(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'El campo Rfc del receptor no se encuentra en el listado del SAT.'),
    )
    expect((await facturasDe(ocurrencia.id))[0].status).toBe('STAMP_FAILED')
    pac.findByExternalId.mockResolvedValue(null) // el PAC no tiene nada con esa llave

    const vista = await reopenOccurrence(ocurrencia.id, superId, NOW)

    expect(vista).toMatchObject({ id: ocurrencia.id, status: 'PENDING', paidAt: null, invoice: null })
    expect(pac.findByExternalId).toHaveBeenCalledWith(`por-cobrar:${ocurrencia.id}:0`)
    expect(await facturasDe(ocurrencia.id)).toHaveLength(0)
    expect((await porFecha(cobro.id, '2026-11-02')).invoiceSeq).toBe(1)
  })

  it('tras un corte de red: dentro de los 2 minutos es 409 y NADA cambia; pasados, si el PAC no tiene nada con esa llave, se cierra y regresa a pendiente', async () => {
    const { cobro, ocurrencia } = await pagadaConFalla(new Error('ECONNRESET'))
    expect((await facturasDe(ocurrencia.id))[0]).toMatchObject({ status: 'STAMPING', lastError: 'ECONNRESET' })

    const pronto = await reopenOccurrence(ocurrencia.id, superId, NOW).catch((e: unknown) => e)

    expect(pronto).toBeInstanceOf(ConflictError)
    expect((pronto as ConflictError).message).toMatch(/se está timbrando/)
    expect(pac.findByExternalId).not.toHaveBeenCalled() // dentro de la espera ni siquiera se le pregunta al PAC
    expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PAID')
    expect(await facturasDe(ocurrencia.id)).toHaveLength(1)

    await pasanDosMinutos(ocurrencia.id)
    pac.findByExternalId.mockResolvedValue(null)
    const despues = await reopenOccurrence(ocurrencia.id, superId, NOW)

    expect(despues.status).toBe('PENDING')
    expect(await facturasDe(ocurrencia.id)).toHaveLength(0)
    expect((await porFecha(cobro.id, '2026-11-02')).invoiceSeq).toBe(1)
  })

  it('tras un corte de red donde el PAC SÍ timbró: «Deshacer» descubre el documento, lo adopta y NO deja deshacer (sigue pagada, con su factura viva)', async () => {
    const { cobro, ocurrencia } = await pagadaConFalla(new Error('ETIMEDOUT'))
    await pasanDosMinutos(ocurrencia.id)
    pac.findByExternalId.mockResolvedValue({ ...sello(), customerTaxId: 'XAXX010101000', isGlobal: false })

    const error = await reopenOccurrence(ocurrencia.id, superId, NOW).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toBe('Cancela primero la factura A-118 en Facturas CFDI')
    const [factura] = await facturasDe(ocurrencia.id)
    expect(factura).toMatchObject({
      status: 'STAMPED',
      serie: 'A',
      folio: '118',
      lastError: null,
      idempotencyKey: `por-cobrar:${ocurrencia.id}:0`,
    })
    expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PAID')
    expect(pac.createInvoice).toHaveBeenCalledTimes(1) // jamás se timbró otra
    const emitidas = await filasDeBitacora({ action: 'PLATFORM_CFDI_ISSUED', entity: 'PlatformCfdi', entityId: factura.id }, 1)
    expect(emitidas).toHaveLength(1)
    expect(emitidas[0].data).toMatchObject({ adopted: true, platformChargeOccurrenceId: ocurrencia.id })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// El orden va UTC y luego CDMX a propósito: la base queda al final en CDMX (el valor local de siempre), y `afterAll` restaura el original.
describe.each(['UTC', 'America/Mexico_City'])('fechas, listas y tarjetas con la sesión de Postgres en %s', zona => {
  /** Una marca por zona: los nombres de una zona nunca coinciden con la búsqueda de la otra. */
  const marca = zona === 'UTC' ? 'u' : 'm'
  beforeAll(() => fijarZonaDeSesion(zona))

  /** Un cobro «a mano» (sin pasar por el generador) para sembrar ocurrencias exactas. */
  async function cobroSembrado(nombre: string) {
    const perfil = await nuevoPerfil()
    const cobro = await prisma.platformCharge.create({
      data: {
        customerType: 'STANDALONE',
        customerName: nombre,
        billingTaxProfileId: perfil.id,
        frequency: 'MONTHLY',
        anchorDate: calendarDayToDb('2026-10-01'),
        concepts: [RENTA] as unknown as Prisma.InputJsonValue,
        invoiceMode: 'MANUAL',
        createdById: superId,
      },
    })
    creado.charges.push(cobro.id)
    return cobro
  }
  const sembrar = (
    chargeId: string,
    dia: string,
    totalCents: number,
    over: Partial<Prisma.PlatformChargeOccurrenceUncheckedCreateInput> = {},
  ) =>
    prisma.platformChargeOccurrence.create({
      data: {
        chargeId,
        dueDate: calendarDayToDb(dia),
        concepts: [RENTA] as unknown as Prisma.InputJsonValue,
        subtotalCents: totalCents,
        taxCents: 0,
        totalCents,
        invoiceMode: 'MANUAL',
        ...over,
      },
    })

  it('la sesión de la base es la que se pidió (la prueba no se engaña sola)', async () => {
    const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
    expect(tz).toBe(zona)
  })

  it('las tarjetas cortan por el día de CDMX (a las 23:30 de CDMX «hoy» sigue siendo hoy) y «este mes» por paidAt, al milisegundo', async () => {
    // Cada instante se mide ANTES y DESPUÉS de sembrar (con el mismo `now`): sólo cuenta lo que esta prueba agrega.
    const instantes = {
      tarde: NOW_TARDE, // 23:30 del 2-nov en CDMX (3-nov en UTC)
      ultimoMilisegundo: new Date('2026-11-03T05:59:59.999Z'), // el último milisegundo del 2-nov en CDMX
      medianoche: new Date('2026-11-03T06:00:00.000Z'), // la medianoche de CDMX: ya es 3-nov
      diciembre: new Date('2026-12-01T06:00:00.000Z'), // la medianoche de CDMX del 1-dic
    }
    const medir = async () =>
      Object.fromEntries(await Promise.all(Object.entries(instantes).map(async ([clave, now]) => [clave, await summarizeOccurrences(now)])))
    const antes = await medir()

    const pendientes = await cobroSembrado(unico('Pendientes'))
    await sembrar(pendientes.id, '2026-11-01', 100) // vencida
    await sembrar(pendientes.id, '2026-11-02', 200) // hoy
    await sembrar(pendientes.id, '2026-11-03', 300) // mañana
    await sembrar(pendientes.id, '2026-11-09', 400) // hoy+7: todavía cuenta como próxima
    await sembrar(pendientes.id, '2026-11-10', 500) // hoy+8: fuera de los próximos 7 días
    const pagadas = await cobroSembrado(unico('Pagadas'))
    const pago = (dia: string, total: number, paidAt: string) =>
      sembrar(pagadas.id, dia, total, { status: 'PAID', paidAt: new Date(paidAt), paidById: superId })
    await pago('2026-10-01', 1000, '2026-11-01T05:59:59.999Z') // 31-oct 23:59:59.999 en CDMX: octubre
    await pago('2026-10-02', 2000, '2026-11-01T06:00:00.000Z') // 1-nov 00:00:00 en CDMX: noviembre
    await pago('2026-10-03', 4000, '2026-12-01T05:59:59.999Z') // 30-nov 23:59:59.999 en CDMX: noviembre
    await pago('2026-10-04', 8000, '2026-12-01T06:00:00.000Z') // 1-dic 00:00:00 en CDMX: diciembre

    const despues = await medir()
    const cambio = (clave: string, tarjeta: 'overdue' | 'dueToday' | 'upcoming' | 'paidThisMonth') => ({
      count: despues[clave][tarjeta].count - antes[clave][tarjeta].count,
      totalCents: despues[clave][tarjeta].totalCents - antes[clave][tarjeta].totalCents,
    })

    // A las 23:30 y en el último milisegundo del 2-nov de CDMX «hoy» sigue siendo el 2-nov, aunque en UTC ya sea el 3.
    for (const clave of ['tarde', 'ultimoMilisegundo']) {
      expect(despues[clave].today).toBe('2026-11-02')
      expect(cambio(clave, 'overdue')).toEqual({ count: 1, totalCents: 100 })
      expect(cambio(clave, 'dueToday')).toEqual({ count: 1, totalCents: 200 })
      expect(cambio(clave, 'upcoming')).toEqual({ count: 2, totalCents: 700 }) // 3-nov y 9-nov; el 10 queda fuera
      expect(cambio(clave, 'paidThisMonth')).toEqual({ count: 2, totalCents: 6000 }) // 2000 + 4000: los dos bordes de noviembre
    }
    // En la medianoche de CDMX el corte da un día: la del 2-nov pasa a vencida, la del 3 es la de hoy y entra el 10 a los próximos.
    expect(despues.medianoche.today).toBe('2026-11-03')
    expect(cambio('medianoche', 'overdue')).toEqual({ count: 2, totalCents: 300 })
    expect(cambio('medianoche', 'dueToday')).toEqual({ count: 1, totalCents: 300 })
    expect(cambio('medianoche', 'upcoming')).toEqual({ count: 2, totalCents: 900 })
    expect(cambio('medianoche', 'paidThisMonth')).toEqual({ count: 2, totalCents: 6000 })
    // Y al cambiar de mes en CDMX, «este mes» es diciembre: sólo cuenta lo pagado a partir de su medianoche.
    expect(despues.diciembre.today).toBe('2026-12-01')
    expect(cambio('diciembre', 'overdue')).toEqual({ count: 5, totalCents: 1500 })
    expect(cambio('diciembre', 'paidThisMonth')).toEqual({ count: 1, totalCents: 8000 })
  })

  it('la lista: orden por fecha con el id de desempate, pagina sin repetir ni perder filas, el total no depende de la página y «q» busca sin importar mayúsculas', async () => {
    const prefijo = `Orden ${suffix}${marca}`
    const a = await cobroSembrado(`${prefijo} A`)
    const b = await cobroSembrado(`${prefijo} B`)
    const c = await cobroSembrado(`${prefijo} C`)
    for (const [cobro, dias] of [
      [a, ['2026-11-04', '2026-11-02']],
      [b, ['2026-11-02', '2026-11-03']],
      [c, ['2026-11-02']],
    ] as const) {
      for (const dia of dias) await sembrar(cobro.id, dia, 1000)
    }

    const todo = await listOccurrences({ view: 'open', q: prefijo.toUpperCase(), pageSize: 100 }, NOW)

    expect(todo.total).toBe(5)
    expect(todo.rows.map(r => r.dueDate)).toEqual(['2026-11-02', '2026-11-02', '2026-11-02', '2026-11-03', '2026-11-04'])
    const esperado = await prisma.platformChargeOccurrence.findMany({
      where: { chargeId: { in: [a.id, b.id, c.id] }, status: 'PENDING' },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: 10,
    })
    expect(todo.rows.map(r => r.id)).toEqual(esperado.map(o => o.id)) // el desempate por id es el de la base

    // Tres páginas de 2: la unión es exactamente la lista completa, sin repetidas ni faltantes, y el total no cambia.
    const paginas = [] as string[][]
    for (const page of [1, 2, 3]) {
      const p = await listOccurrences({ view: 'open', q: prefijo, page, pageSize: 2 }, NOW)
      expect(p.total).toBe(5)
      expect(p.pageSize).toBe(2)
      paginas.push(p.rows.map(r => r.id))
    }
    expect(paginas.map(p => p.length)).toEqual([2, 2, 1])
    expect(paginas.flat()).toEqual(todo.rows.map(r => r.id))

    expect((await listOccurrences({ view: 'open', q: `${prefijo} B` }, NOW)).total).toBe(2)
    expect((await listOccurrences({ view: 'open', q: `no existe ${suffix}` }, NOW)).rows).toEqual([])
    const enorme = await listOccurrences({ view: 'open', q: prefijo, pageSize: 500 }, NOW)
    expect(enorme.pageSize).toBe(100)
  })

  it('los pagados van del más reciente al más viejo con el id de desempate, y cada fila trae su factura MÁS RECIENTE', async () => {
    const prefijo = `Pagados ${suffix}${marca}`
    const a = await cobroSembrado(`${prefijo} A`)
    const b = await cobroSembrado(`${prefijo} B`)
    const c = await cobroSembrado(`${prefijo} C`)
    const t1 = new Date('2026-11-02T10:00:00.000Z')
    const t2 = new Date('2026-11-02T11:00:00.000Z')
    const oa = await sembrar(a.id, '2026-10-01', 1000, { status: 'PAID', paidAt: t1, paidById: superId })
    await sembrar(b.id, '2026-10-01', 1000, { status: 'PAID', paidAt: t2, paidById: superId })
    await sembrar(c.id, '2026-10-01', 1000, { status: 'PAID', paidAt: t2, paidById: superId })
    const facturaBase = {
      platformEmisorId: creado.emisores[0],
      type: 'INGRESO' as const,
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'PUBLICO EN GENERAL',
      receptorRegimen: '616',
      receptorCp: '06000',
      usoCfdi: 'G03',
      formaPago: '03',
      metodoPago: 'PUE',
      platformChargeOccurrenceId: oa.id,
      createdById: superId,
    }
    const vieja = await prisma.platformCfdi.create({
      data: {
        ...facturaBase,
        status: 'CANCELLED',
        idempotencyKey: `por-cobrar:${oa.id}:0`,
        createdAt: new Date('2026-11-02T10:01:00.000Z'),
      },
    })
    const nueva = await prisma.platformCfdi.create({
      data: {
        ...facturaBase,
        status: 'STAMPED',
        serie: 'A',
        folio: '200',
        uuid: `UUID-${suffix}${marca}`,
        idempotencyKey: `por-cobrar:${oa.id}:1`,
        createdAt: new Date('2026-11-02T10:05:00.000Z'),
      },
    })
    creado.cfdis.push(vieja.id, nueva.id)

    const { rows, total } = await listOccurrences({ view: 'paid', q: prefijo, pageSize: 100 }, NOW)

    expect(total).toBe(3)
    expect(rows.map(r => r.paidAt!.toISOString())).toEqual([t2, t2, t1].map(t => t.toISOString()))
    const esperado = await prisma.platformChargeOccurrence.findMany({
      where: { chargeId: { in: [a.id, b.id, c.id] } },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
      take: 10,
    })
    expect(rows.map(r => r.id)).toEqual(esperado.map(o => o.id))
    const conFactura = rows.find(r => r.id === oa.id)!
    expect(conFactura.invoice).toMatchObject({ id: nueva.id, status: 'STAMPED', serie: 'A', folio: '200' }) // la más reciente, no la cancelada
    expect(rows.filter(r => r.id !== oa.id).every(r => r.invoice === null)).toBe(true)
    expect(rows.every(r => r.bucket === null)).toBe(true)
  })

  it('«omitidos» sólo trae las omitidas, y dueDate sale idéntico en la lista y en la fila pagada (nunca un día antes)', async () => {
    const cobro = await cobroSembrado(`Omitidos ${suffix}${marca}`)
    await sembrar(cobro.id, '2026-11-01', 100, { status: 'SKIPPED', skippedAt: NOW, skippedById: superId })
    await sembrar(cobro.id, '2026-11-02', 100)

    const omitidos = await listOccurrences({ view: 'skipped', q: cobro.customerName }, NOW)
    const abiertos = await listOccurrences({ view: 'open', q: cobro.customerName }, NOW)

    expect(omitidos.rows.map(r => [r.dueDate, r.status, r.bucket])).toEqual([['2026-11-01', 'SKIPPED', null]])
    expect(abiertos.rows.map(r => [r.dueDate, r.status, r.bucket])).toEqual([['2026-11-02', 'PENDING', 'TODAY']])
  })

  it('pendingPpdCount cuenta en la base las PPD STAMPED del perfil con saldo, y con alguna NO se timbra aunque sea automática', async () => {
    const perfil = await nuevoPerfil()
    const otro = await nuevoPerfil()
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02', billingTaxProfileId: perfil.id })
    const ocurrencia = await porFecha(cobro.id, '2026-11-02')
    const base = {
      platformEmisorId: creado.emisores[0],
      type: 'INGRESO' as const,
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'PUBLICO EN GENERAL',
      receptorRegimen: '616',
      receptorCp: '06000',
      usoCfdi: 'G03',
      formaPago: '99',
      metodoPago: 'PPD',
      subtotalCents: 86207,
      taxCents: 13793,
      totalCents: 100000,
      amountPaidCents: 0,
      status: 'STAMPED' as const,
      billingTaxProfileId: perfil.id,
      createdById: superId,
    }
    const cuentas: Array<[string, Partial<Prisma.PlatformCfdiUncheckedCreateInput>]> = [
      ['sin pagar', {}], // cuenta
      ['con un abono', { amountPaidCents: 40000 }], // cuenta: todavía le deben
      ['liquidada', { amountPaidCents: 100000 }], // no
      ['PUE', { metodoPago: 'PUE', formaPago: '03' }], // no
      ['PPD cancelada', { status: 'CANCELLED' }], // no
      ['PPD que falló', { status: 'STAMP_FAILED' }], // no
      ['de otro perfil', { billingTaxProfileId: otro.id }], // no
    ]
    for (const [, over] of cuentas) creado.cfdis.push((await prisma.platformCfdi.create({ data: { ...base, ...over } })).id)

    const conDeuda = await payPreview(ocurrencia.id)

    expect(conDeuda.pendingPpdCount).toBe(2)
    expect(conDeuda.willInvoice).toBe(false) // aunque la ocurrencia sea automática: «no timbres otra y registra el pago allá»
    expect(conDeuda.receptor).toEqual(RECEPTOR)

    // Liquidadas las dos, ya no hay aviso y vuelve a timbrar.
    await prisma.platformCfdi.updateMany({
      where: { billingTaxProfileId: perfil.id, metodoPago: 'PPD', status: 'STAMPED', amountPaidCents: { lt: 100000 } },
      data: { amountPaidCents: 100000 },
    })
    const sinDeuda = await payPreview(ocurrencia.id)
    expect(sinDeuda).toMatchObject({ pendingPpdCount: 0, willInvoice: true })
  })

  it('skipOccurrence y reopenOccurrence sobre filas reales: el estado y las marcas quedan exactas en la base', async () => {
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02', invoiceMode: 'MANUAL' })
    const ocurrencia = await porFecha(cobro.id, '2026-11-02')

    await skipOccurrence(ocurrencia.id, superId, NOW)
    expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({ status: 'SKIPPED', skippedById: superId, skippedAt: NOW, paidAt: null })

    await reopenOccurrence(ocurrencia.id, superId, NOW)
    expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({
      status: 'PENDING',
      skippedAt: null,
      skippedById: null,
      paidAt: null,
      paidById: null,
    })

    await payOccurrence(ocurrencia.id, { invoice: false }, superId, NOW)
    expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({ status: 'PAID', paidById: superId, paidAt: NOW, skippedAt: null })
    await reopenOccurrence(ocurrencia.id, superId, NOW)
    expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({ status: 'PENDING', paidAt: null, paidById: null })
  })
})
