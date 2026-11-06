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
 * Desde el 3-nov-2026 también cubre «Por cobrar» desde una factura (spec 2026-11-03-por-cobrar-desde-factura-y-filtros): anexar y quitar
 * una factura de «Facturas CFDI» (el UPDATE condicional por versión y estado, que otra conexión puede invalidar a media operación), el alta
 * desde ella con su rollback, ONE_TIME y NONE en una base migrada, las candidatas y los filtros y grupos de la lista. Cada prueba de esa
 * parte se comprobó contra una mutación del código (quitar la condición, el candado o el filtro que protege): sin ella, la prueba falla.
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
import type { PlatformCfdiStatus, PlatformChargeFrequency, PlatformChargeInvoiceMode } from '@prisma/client'
import jwt from 'jsonwebtoken'
import app from '@/app'
import { aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'
import { startApiServer, api } from '@tests/__helpers__/apiServer'
import { ConflictError } from '@/errors/AppError'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import {
  createCharge,
  generateAllActive,
  getCharge,
  pauseCharge,
  updateCharge,
} from '@/services/superadmin/platform-charges/charges.service'
import type { ChargeInput } from '@/services/superadmin/platform-charges/charges.service'
import { registerPlatformPayment } from '@/services/superadmin/platform-billing/platformCfdi.service'
import { listInvoiceCandidates, linkInvoice, unlinkInvoice } from '@/services/superadmin/platform-charges/invoice-link.service'
import { invoiceOccurrence } from '@/services/superadmin/platform-charges/invoice.service'
import {
  groupOccurrences,
  listOccurrences,
  payOccurrence,
  payPreview,
  reopenOccurrence,
  skipOccurrence,
  summarizeOccurrences,
} from '@/services/superadmin/platform-charges/occurrences.service'
import type { InvoiceCategory, OccurrenceFilters, OccurrenceGroupBy } from '@/services/superadmin/platform-charges/occurrences.service'
import { addDays, calendarDayToDb, dbToCalendarDay, todayInMexico } from '@/services/superadmin/platform-charges/schedule'
import { computeChargeTotals, conceptToCfdiLine } from '@/services/superadmin/platform-charges/totals'
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
    // Un cobro que el código creó cuando la prueba esperaba un rechazo (un defecto) no llegó a anotarse: es de ESTA corrida porque lo creó el
    // superadmin de esta corrida (su id es único), así que también se borra.
    if (superId) {
      const sinAnotar = await prisma.platformCharge.findMany({
        where: { createdById: superId, id: { notIn: creado.charges } },
        select: { id: true },
        take: 10_000,
      })
      creado.charges.push(...sinAnotar.map(c => c.id))
    }
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
const del = (path: string, token = superToken) => api().delete(`${BASE}${path}`).set('Authorization', `Bearer ${token}`)

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
    expect(lista.body.meta).toEqual({ total: 3, page: 1, pageSize: 50, sumCents: 3 * TOTAL }) // la lista también suma TODO el filtro
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

  it('«Próximo cobro» por HTTP: la lista trae la fecha aunque falten más de 7 días; pagar la mueve a la siguiente y pausar la quita', async () => {
    const hoy = todayInMexico(new Date())
    const lejos = addDays(hoy, 20)
    const lejano = await nuevoCobro({ customerName: unico('Lejano'), frequency: 'MONTHLY', anchorDate: lejos }, new Date())
    const semanal = await nuevoCobro({ customerName: unico('Semanal'), frequency: 'WEEKLY', anchorDate: hoy }, new Date())
    const proximo = async (cobro: { id: string; customerName: string }) => {
      const res = await get(`/?q=${encodeURIComponent(cobro.customerName)}`)
      expect(res.status).toBe(200)
      return res.body.data.find((fila: { id: string }) => fila.id === cobro.id)?.nextDueDate
    }

    // Su primera fecha cae en 20 días: todavía no existe en «Fechas de cobro», pero la columna ya la dice.
    expect(await ocurrenciasDe(lejano.id)).toHaveLength(0)
    expect(await proximo(lejano)).toBe(lejos)

    // Semanal desde hoy: toca hoy; pagada, toca dentro de 7 días; pausado, no hay próximo.
    expect(await proximo(semanal)).toBe(hoy)
    const deHoy = await porFecha(semanal.id, hoy)
    expect((await post(`/occurrences/${deHoy.id}/pay`, { invoice: false })).status).toBe(200)
    expect(await proximo(semanal)).toBe(addDays(hoy, 7))
    expect((await post(`/${semanal.id}/pause`, { skipOverdue: true })).status).toBe(200)
    expect(await proximo(semanal)).toBeNull()
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// «Por cobrar» DESDE UNA FACTURA (spec 2026-11-03-por-cobrar-desde-factura-y-filtros): anexar y quitar una factura que ya existe en «Facturas
// CFDI», el alta desde ella, una sola vez, sin factura, los filtros y los grupos. Todo contra Postgres real: lo que aquí se demuestra
// (la fila que otra conexión toma, un UPDATE condicional que se reevalúa al despertar, `some`/`none` de las relaciones, `distinct` + `take`,
// los enums de una base migrada, una columna `date` bajo dos zonas) no lo puede demostrar un doble en memoria.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Una factura de ingreso ya timbrada en «Facturas CFDI», con renglones que SÍ caben en el modelo del 16 % (y por eso sus totales cuadran). */
let facturaN = 0
async function nuevaFactura(over: Partial<Prisma.PlatformCfdiUncheckedCreateInput> = {}, conceptos: ChargeConcept[] = [RENTA, LICENCIA]) {
  facturaN += 1
  const fila = await prisma.platformCfdi.create({
    data: {
      platformEmisorId: creado.emisores[0],
      type: 'INGRESO',
      receptorRfc: RECEPTOR.rfc,
      receptorNombre: RECEPTOR.razonSocial,
      receptorRegimen: RECEPTOR.regimenFiscal,
      receptorCp: RECEPTOR.codigoPostal,
      usoCfdi: 'G03',
      formaPago: '03',
      metodoPago: 'PUE',
      lines: conceptos.map(conceptToCfdiLine) as unknown as Prisma.InputJsonValue,
      ...computeChargeTotals(conceptos),
      status: 'STAMPED',
      serie: 'F',
      folio: String(5000 + facturaN),
      uuid: `UUID-${suffix}-f${facturaN}`,
      stampedAt: new Date('2026-11-01T12:00:00.000Z'),
      createdAt: new Date('2026-11-01T12:00:00.000Z'),
      createdById: superId,
      ...over,
    },
  })
  creado.cfdis.push(fila.id)
  return fila
}
const facturaDe = (id: string) => prisma.platformCfdi.findUniqueOrThrow({ where: { id } })

/** Un cobro mensual con UNA fecha (el 2-nov), AUTOMATIC y con perfil: anexar lo vuelve MANUAL y se nota. */
async function cobroDeUnaFecha(over: Partial<ChargeInput> = {}) {
  const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02', ...over })
  return { cobro, fecha: await porFecha(cobro.id, '2026-11-02') }
}

/**
 * OTRA conexión abre una transacción, cambia la fila de la factura y la deja SIN confirmar: la fila queda tomada y su `updatedAt` ya cambió.
 * Es lo que hace «Facturas CFDI» al pedir una cancelación mientras «Por cobrar» está por escribir (`cancelPlatformCfdi` no toma el candado del
 * cobro). `pid` es el backend de esa conexión; `confirmar` hace commit; `terminada` es la transacción.
 */
function otraConexionCambia(cfdiId: string, data: Prisma.PlatformCfdiUpdateInput) {
  const puede = diferido<void>()
  const lista = diferido<number>()
  const terminada = prisma.$transaction(
    async tx => {
      await tx.platformCfdi.update({ where: { id: cfdiId }, data })
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      lista.resolver(Number(pid))
      await puede.promesa
    },
    { timeout: 60_000, maxWait: 60_000 },
  )
  terminada.catch(error => lista.rechazar(error))
  return { pid: lista.promesa, confirmar: () => puede.resolver(), terminada }
}

/** Espera a que alguien esté bloqueado en una fila de la factura por la transacción `pid`: el UPDATE condicional llegó y espera. */
async function esperaLaFila(pid: number) {
  const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /UPDATE .*"PlatformCfdi"/, ms: 60_000 })
  expect(espera).not.toBeNull() // el cruce SE PROVOCÓ: el UPDATE de la factura espera a la otra conexión
  expect(espera!.waitEventType).toBe('Lock')
}

const vivasDe = (occurrenceId: string) =>
  prisma.platformCfdi.count({
    where: { platformChargeOccurrenceId: occurrenceId, status: { in: ['STAMPED', 'CANCEL_REQUESTED', 'STAMPING'] } },
  })

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('anexar y quitar una factura: la escritura condicional y los cruces (Postgres real)', () => {
  it('1 · dos pestañas anexan la MISMA factura a fechas de DOS cobros (candados distintos): una gana y la otra recibe 409 «ya es de otro cobro»', async () => {
    const a = await cobroDeUnaFecha()
    const b = await cobroDeUnaFecha()
    const factura = await nuevaFactura()
    const aparcada = aparcarLaTransaccion(1)
    try {
      const ganadora = linkInvoice(a.fecha.id, { cfdiId: factura.id }, superId, NOW)
      ganadora.catch(() => undefined)
      const pid = await aTiempo(
        aparcada.pid,
        60_000,
        'la ganadora ya anexó la factura y quedó aparcada, sin commit, con la fila de la factura tomada',
      )

      // La otra pestaña es de OTRO cobro: no comparte candado, pasa todas sus comprobaciones leyendo la factura aún suelta y llega a escribirla.
      const perdedora = Promise.resolve(post(`/occurrences/${b.fecha.id}/invoice-link`, { cfdiId: factura.id }))
      await esperaLaFila(pid)
      aparcada.soltar()

      await ganadora
      const res = await perdedora
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ code: 'PLATFORM_CHARGE_INVOICE_LINK_TAKEN' })
      expect(res.body.message).toMatch(/ya es de otro cobro/)
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }

    // Queda ligada a UNA sola fecha, la de la ganadora; la otra no cambió en nada (la transacción se deshizo).
    expect(await facturaDe(factura.id)).toMatchObject({ platformChargeOccurrenceId: a.fecha.id, status: 'STAMPED' })
    expect((await facturaDe(factura.id)).chargeLinkedAt).not.toBeNull()
    expect(await prisma.platformCfdi.count({ where: { id: factura.id, platformChargeOccurrenceId: { not: null } } })).toBe(1)
    expect(await prisma.platformCfdi.count({ where: { platformChargeOccurrenceId: b.fecha.id } })).toBe(0)
    expect((await porFecha(a.cobro.id, '2026-11-02')).invoiceMode).toBe('MANUAL') // la ganadora la volvió manual
    expect((await porFecha(b.cobro.id, '2026-11-02')).invoiceMode).toBe('AUTOMATIC') // la perdedora quedó como estaba
    expect(await bitacoras('PLATFORM_CHARGE_INVOICE_LINKED', a.cobro.id, 1)).toHaveLength(1)
    expect(await prisma.activityLog.count({ where: { action: 'PLATFORM_CHARGE_INVOICE_LINKED', entityId: b.cobro.id } })).toBe(0)
  })

  it('1 · disparadas juntas (sin detener nada), varias veces: SIEMPRE una gana y la otra recibe «ya es de otro cobro»; la factura queda en una sola fecha', async () => {
    for (let i = 0; i < 4; i++) {
      const a = await cobroDeUnaFecha()
      const b = await cobroDeUnaFecha()
      const factura = await nuevaFactura()

      const { cumplidas, rechazadas } = settle(
        await Promise.allSettled([
          linkInvoice(a.fecha.id, { cfdiId: factura.id }, superId, NOW),
          linkInvoice(b.fecha.id, { cfdiId: factura.id }, superId, NOW),
        ]),
      )

      expect(cumplidas).toHaveLength(1)
      expect(rechazadas).toHaveLength(1)
      expect(rechazadas[0]).toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_LINK_TAKEN' })
      const ligadas = await prisma.platformCfdi.findMany({
        where: { id: factura.id },
        select: { platformChargeOccurrenceId: true },
        take: 2,
      })
      expect([a.fecha.id, b.fecha.id]).toContain(ligadas[0].platformChargeOccurrenceId)
      expect((await vivasDe(a.fecha.id)) + (await vivasDe(b.fecha.id))).toBe(1)
    }
  })

  describe('2 · el UPDATE condicional por versión (`updatedAt`, columna timestamp(3)) y por estado', () => {
    it('un anexado normal, sin cruces, SÍ escribe: aunque la versión de la factura traiga microsegundos que la columna redondea', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha()
      const factura = await nuevaFactura()
      // Una versión escrita con SQL a mano, con microsegundos: la columna es timestamp(3) y la redondea a milisegundos, como la lee Prisma.
      await prisma.$executeRaw`UPDATE "PlatformCfdi" SET "updatedAt" = '2026-11-02 10:00:00.123456' WHERE id = ${factura.id}`
      const [{ texto }] = await prisma.$queryRaw<{ texto: string }[]>`
        SELECT to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS.US') AS texto FROM "PlatformCfdi" WHERE id = ${factura.id}`
      expect(texto).toBe('2026-11-02 10:00:00.123000') // la columna ya redondeó: lo que Prisma lee es lo que Postgres compara
      const instante = new Date('2026-11-02T18:00:00.123Z')

      const vista = await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, instante)

      expect(vista.invoice).toMatchObject({ id: factura.id, status: 'STAMPED', linked: true })
      const ligada = await facturaDe(factura.id)
      expect(ligada.platformChargeOccurrenceId).toBe(fecha.id) // el UPDATE condicional escribió (no devolvió 0 filas)
      expect(ligada.chargeLinkedAt).toEqual(instante) // y el instante se guardó al milisegundo
      expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({ invoiceMode: 'MANUAL', totalCents: TOTAL })
    })

    it.each<[string, Prisma.PlatformCfdiUpdateInput, boolean]>([
      ['cambia un dato de la factura (sólo su versión)', { lastError: 'otra pestaña la tocó' }, true],
      ['pide cancelarla (su estado y su versión)', { status: 'CANCEL_REQUESTED' }, false],
    ])(
      'otra conexión %s DESPUÉS de leerla y ANTES de escribir: 409 «acaba de cambiar» y no liga NADA',
      async (_caso, cambio, reintentoFunciona) => {
        const { cobro, fecha } = await cobroDeUnaFecha()
        const factura = await nuevaFactura()
        const otra = otraConexionCambia(factura.id, cambio)
        let anexando: Promise<unknown> | undefined
        try {
          const pid = await aTiempo(otra.pid, 60_000, 'la otra conexión cambió la factura y la dejó sin confirmar')
          // «Por cobrar» lee la factura (aún con la versión vieja, la otra no confirmó) y llega a su UPDATE condicional, que espera la fila.
          anexando = linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
          anexando.catch(() => undefined)
          await esperaLaFila(pid)
          otra.confirmar() // la otra conexión confirma: el UPDATE despierta y VUELVE a evaluar su condición contra la versión nueva
          await otra.terminada

          await expect(anexando).rejects.toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_LINK_CHANGED' })
        } finally {
          otra.confirmar()
          await otra.terminada.catch(() => undefined)
        }

        // No ligó nada: ni la factura, ni la fecha (conserva su modo y sus números), ni la bitácora.
        expect(await facturaDe(factura.id)).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
        expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({ invoiceMode: 'AUTOMATIC', totalCents: TOTAL })
        expect(await prisma.activityLog.count({ where: { action: 'PLATFORM_CHARGE_INVOICE_LINKED', entityId: cobro.id } })).toBe(0)

        // Y tras revisarla, reintentar: con sólo un dato distinto sí se anexa; una cancelación en trámite ya no es «vigente».
        if (reintentoFunciona) {
          await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
          expect((await facturaDe(factura.id)).platformChargeOccurrenceId).toBe(fecha.id)
        } else {
          await expect(linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)).rejects.toMatchObject({
            statusCode: 409,
            code: 'PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED',
          })
        }
      },
    )
  })

  describe('3 · anexar mientras otra pestaña timbra la MISMA fecha (el candado del cobro lo serializa)', () => {
    it('«Facturar» reservando, detenida con su candado: anexar espera, ve la factura en camino y recibe 409; queda UNA sola viva y la suelta sigue libre', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha()
      await payOccurrence(fecha.id, { invoice: false }, superId, NOW)
      const suelta = await nuevaFactura()
      // La transacción 1 de «Facturar» prepara la foto; la 2 es la RESERVA (crea la fila STAMPING): ésa se detiene con el candado tomado.
      const aparcada = aparcarLaTransaccion(2)
      let facturando: Promise<unknown> | undefined
      try {
        facturando = invoiceOccurrence(fecha.id, { actorId: superId, receptor: RECEPTOR })
        facturando.catch(() => undefined)
        const pid = await aTiempo(aparcada.pid, 60_000, 'la reserva creó su fila STAMPING y quedó aparcada, sin commit')

        const anexando = linkInvoice(fecha.id, { cfdiId: suelta.id }, superId, NOW)
        anexando.catch(() => undefined)
        await esperaElCandado(pid) // anexar llegó segunda: espera el candado del cobro
        aparcada.soltar()

        await expect(anexando).rejects.toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE' })
        expect(((await facturando) as { status: string }).status).toBe('STAMPED')
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect(await vivasDe(fecha.id)).toBe(1) // no hay dos facturas vivas en la fecha
      expect(await facturasDe(fecha.id)).toHaveLength(1)
      expect(await facturaDe(suelta.id)).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null }) // la candidata sigue libre
      expect(pac.createInvoice).toHaveBeenCalledTimes(1)
      expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PAID')
    })

    it('ANEXAR primero, detenido con su candado: «Facturar» espera, ve la anexada y recibe 409 «ya tiene anexada»; el PAC jamás se llama', async () => {
      const { fecha } = await cobroDeUnaFecha()
      await payOccurrence(fecha.id, { invoice: false }, superId, NOW)
      const factura = await nuevaFactura()
      const aparcada = aparcarLaTransaccion(1)
      let anexando: Promise<unknown> | undefined
      let facturando: Promise<unknown> | undefined
      try {
        anexando = linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
        anexando.catch(() => undefined)
        const pid = await aTiempo(aparcada.pid, 60_000, 'anexar escribió la factura y quedó aparcado con el candado, sin commit')

        // «Facturar» aún no ve la anexada (sin commit): llega hasta la foto y espera el candado.
        facturando = invoiceOccurrence(fecha.id, { actorId: superId, receptor: RECEPTOR })
        facturando.catch(() => undefined)
        await esperaElCandado(pid)
        aparcada.soltar()

        await anexando
        await expect(facturando).rejects.toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_LINKED' })
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect(pac.createInvoice).not.toHaveBeenCalled()
      expect(await vivasDe(fecha.id)).toBe(1)
      expect((await facturasDe(fecha.id)).map(f => f.id)).toEqual([factura.id]) // la única fila de la fecha es la anexada
    })

    it('anexar entra ENTRE la foto y la reserva de «Facturar»: la reserva (reserveCheck, bajo el candado) ve la anexada, no deja fila y NO llama al PAC', async () => {
      const { fecha } = await cobroDeUnaFecha()
      await payOccurrence(fecha.id, { invoice: false }, superId, NOW)
      const factura = await nuevaFactura()
      const retenida = retenerLaTransaccion(2) // la 1 prepara la foto; la 2 es la reserva: se detiene ANTES de empezar
      let facturando: Promise<unknown> | undefined
      try {
        facturando = invoiceOccurrence(fecha.id, { actorId: superId, receptor: RECEPTOR })
        facturando.catch(() => undefined)
        await aTiempo(retenida.llego, 60_000, '«Facturar» terminó de preparar su foto y está por reservar la factura')

        await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW) // anexar entra completo en el hueco y confirma
        expect((await facturaDe(factura.id)).platformChargeOccurrenceId).toBe(fecha.id)
        retenida.soltar()

        await expect(facturando).rejects.toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_LINKED' })
      } finally {
        retenida.soltar()
        retenida.restaurar()
      }

      expect(pac.createInvoice).not.toHaveBeenCalled()
      expect((await facturasDe(fecha.id)).map(f => f.id)).toEqual([factura.id]) // la fila de la reserva no nació
    })
  })

  describe('4 · con una anexada viva, «Facturar» devuelve ESA factura y no llama al PAC', () => {
    it('con perfil fiscal en el cobro: devuelve la anexada, ni consulta ni timbra, y «Ya me pagó» con la casilla marcada sólo marca pagado', async () => {
      const { fecha } = await cobroDeUnaFecha()
      const factura = await nuevaFactura()
      await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
      await payOccurrence(fecha.id, { invoice: false }, superId, NOW)

      const devuelta = await invoiceOccurrence(fecha.id, { actorId: superId, receptor: RECEPTOR })

      expect(devuelta.id).toBe(factura.id)
      expect(devuelta.status).toBe('STAMPED')
      expect(pac.createInvoice).not.toHaveBeenCalled()
      expect(pac.findByExternalId).not.toHaveBeenCalled()
      expect(await facturasDe(fecha.id)).toHaveLength(1)

      // «Ya me pagó» con «Timbrar ahora» sobre OTRA fecha con anexada: marca pagado, y la factura que regresa es la anexada, sin timbrar.
      const otra = await cobroDeUnaFecha()
      const segunda = await nuevaFactura()
      await linkInvoice(otra.fecha.id, { cfdiId: segunda.id }, superId, NOW)
      const pagada = await payOccurrence(otra.fecha.id, { invoice: true, receptor: RECEPTOR }, superId, NOW)
      expect(pagada.occurrence.status).toBe('PAID')
      expect(pagada.invoice).toMatchObject({ ok: true, cfdi: { id: segunda.id } })
      expect(pac.createInvoice).not.toHaveBeenCalled()
    })

    it('SIN perfil fiscal en el cobro (externo): devuelve la anexada sin pedir datos; sin anexada, el mismo cobro sí exige datos fiscales (NEEDS_FISCAL_DATA)', async () => {
      const sinPerfil = async () => {
        const cobro = await createCharge(
          {
            customerType: 'STANDALONE',
            customerName: unico('Externo sin perfil'),
            frequency: 'MONTHLY',
            anchorDate: '2026-11-02',
            concepts: [RENTA, LICENCIA],
            invoiceMode: 'MANUAL',
          },
          superId,
          NOW,
        )
        creado.charges.push(cobro.id)
        expect(cobro.billingTaxProfileId).toBeNull()
        const fecha = await porFecha(cobro.id, '2026-11-02')
        await payOccurrence(fecha.id, { invoice: false }, superId, NOW)
        return fecha
      }
      const conAnexada = await sinPerfil()
      const factura = await nuevaFactura()
      await linkInvoice(conAnexada.id, { cfdiId: factura.id }, superId, NOW)

      const devuelta = await invoiceOccurrence(conAnexada.id, { actorId: superId }) // sin receptor y sin perfil: no se necesitan

      expect(devuelta.id).toBe(factura.id)
      expect(pac.createInvoice).not.toHaveBeenCalled()

      const sinAnexada = await sinPerfil()
      await expect(invoiceOccurrence(sinAnexada.id, { actorId: superId, receptor: RECEPTOR })).rejects.toMatchObject({
        code: 'NEEDS_FISCAL_DATA',
      })
      expect(pac.createInvoice).not.toHaveBeenCalled()
    })
  })

  describe('5 · una fecha futura con factura anexada sobrevive a editar y a pausar, con su FK', () => {
    /** Semanal con ancla hoy: la de hoy y la del 9-nov (futura, sin pagar) con una factura ANEXADA. */
    async function cobroConFuturaAnexada() {
      const cobro = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-11-02', invoiceMode: 'MANUAL' })
      expect(await resumen(cobro.id)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING'])
      const futura = await porFecha(cobro.id, '2026-11-09')
      const factura = await nuevaFactura()
      await linkInvoice(futura.id, { cfdiId: factura.id }, superId, NOW)
      return { cobro, futura, factura }
    }
    const sigueLigada = async (facturaId: string, fechaId: string) => {
      const fila = await facturaDe(facturaId)
      expect(fila).toMatchObject({ platformChargeOccurrenceId: fechaId, status: 'STAMPED' })
      expect(fila.chargeLinkedAt).not.toBeNull()
    }

    it('editar los conceptos regenera lo futuro SIN borrar la fecha anexada (la misma fila, el mismo id, la misma FK); una futura sin factura sí se borra y se regenera', async () => {
      const { cobro, futura, factura } = await cobroConFuturaAnexada()
      const control = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-11-02', invoiceMode: 'MANUAL' })
      const controlVieja = await porFecha(control.id, '2026-11-09')

      await updateCharge(cobro.id, { concepts: [RENTA] }, superId, NOW)
      await updateCharge(control.id, { concepts: [RENTA] }, superId, NOW)

      // El deleteMany de Postgres respetó `invoices: { none: {} }`: la anexada sigue, con su id y su FK (SetNull la habría soltado).
      expect(await resumen(cobro.id)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING'])
      expect((await porFecha(cobro.id, '2026-11-09')).id).toBe(futura.id)
      await sigueLigada(factura.id, futura.id)
      // Y no es que el borrado no hiciera nada: la futura SIN factura del cobro de control se borró y nació otra con la foto nueva.
      expect(await prisma.platformChargeOccurrence.findUnique({ where: { id: controlVieja.id } })).toBeNull()
      expect(await porFecha(control.id, '2026-11-09')).toMatchObject({ status: 'PENDING', totalCents: 58000 })
    })

    it('editar el CALENDARIO con esa fecha es 409 «tiene una factura anexada; quítala para cambiar la fecha», y no cambia nada', async () => {
      const { cobro, futura, factura } = await cobroConFuturaAnexada()

      await expect(updateCharge(cobro.id, { anchorDate: '2026-11-03' }, superId, NOW)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PLATFORM_CHARGE_FUTURE_INVOICED',
        message: 'El cobro del 9 nov tiene una factura anexada; quítala para cambiar la fecha',
      })

      expect((await prisma.platformCharge.findUniqueOrThrow({ where: { id: cobro.id } })).anchorDate.toISOString()).toBe(
        '2026-11-02T00:00:00.000Z',
      )
      expect(await resumen(cobro.id)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING'])
      await sigueLigada(factura.id, futura.id)
    })

    it('pausar borra las futuras SIN factura y deja la anexada con su FK', async () => {
      const { cobro, futura, factura } = await cobroConFuturaAnexada()
      const control = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-11-02', invoiceMode: 'MANUAL' })

      await pauseCharge(cobro.id, { skipOverdue: false }, superId, NOW)
      await pauseCharge(control.id, { skipOverdue: false }, superId, NOW)

      expect((await prisma.platformCharge.findUniqueOrThrow({ where: { id: cobro.id } })).pausedAt).not.toBeNull()
      expect(await resumen(cobro.id)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING'])
      expect((await porFecha(cobro.id, '2026-11-09')).id).toBe(futura.id)
      await sigueLigada(factura.id, futura.id)
      expect(await resumen(control.id)).toEqual(['2026-11-02:PENDING']) // la del control, sin factura, sí se borró
    })
  })

  describe('6 · lo que enseña la fila: la factura VIVA, aunque haya cancelaciones más nuevas', () => {
    const base = new Date('2026-11-01T10:00:00.000Z').getTime()
    const minutos = (n: number) => new Date(base + n * 60_000)
    /** Una factura de la fecha con su llave de intento (única por fecha) y una hora de creación exacta. */
    const deLaFecha = (
      occurrenceId: string,
      k: number,
      status: PlatformCfdiStatus,
      minuto: number,
      over: Partial<Prisma.PlatformCfdiUncheckedCreateInput> = {},
    ) =>
      nuevaFactura({
        platformChargeOccurrenceId: occurrenceId,
        status,
        idempotencyKey: `por-cobrar:${occurrenceId}:${k}`,
        uuid: ['STAMPED', 'CANCEL_REQUESTED'].includes(status) ? `UUID-${suffix}-${occurrenceId}-${k}` : null,
        createdAt: minutos(minuto),
        ...over,
      })

    it('una anexada vigente MÁS VIEJA que once canceladas: la fila y la lista enseñan la anexada', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha({ invoiceMode: 'MANUAL' })
      const viva = await deLaFecha(fecha.id, 0, 'STAMPED', 0, { chargeLinkedAt: minutos(1) })
      for (let i = 1; i <= 11; i++) await deLaFecha(fecha.id, i, 'CANCELLED', 10 + i)
      // La trampa existe de verdad: la más nueva de la fecha es una cancelada (así la habría leído `take: 1` a secas).
      const masNueva = await prisma.platformCfdi.findFirstOrThrow({
        where: { platformChargeOccurrenceId: fecha.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      expect(masNueva.status).toBe('CANCELLED')

      const lista = await get(`/occurrences?view=open&q=${encodeURIComponent(cobro.customerName)}`)

      expect(lista.status).toBe(200)
      expect(lista.body.data).toHaveLength(1)
      expect(lista.body.data[0].invoice).toMatchObject({ id: viva.id, status: 'STAMPED', linked: true })
    })

    it('una lista de VARIAS fechas trae la viva de CADA una (distinct + take reales), con varias vivas en una fecha y una página de sólo dos', async () => {
      const cobro = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-10-19', invoiceMode: 'MANUAL' })
      expect(await resumen(cobro.id)).toEqual(['2026-10-19:PENDING', '2026-10-26:PENDING', '2026-11-02:PENDING', '2026-11-09:PENDING'])
      const [f1019, f1026, f1102, f1109] = await ocurrenciasDe(cobro.id)

      // 19-oct: TRES vivas (no deberían existir, y aun así no pueden quitarle su lugar a otra fecha): gana la más nueva.
      await deLaFecha(f1019.id, 0, 'STAMPED', 0, { chargeLinkedAt: minutos(1) })
      await deLaFecha(f1019.id, 1, 'CANCEL_REQUESTED', 5)
      const mas = await deLaFecha(f1019.id, 2, 'STAMPING', 9)
      for (let i = 3; i < 6; i++) await deLaFecha(f1019.id, i, 'CANCELLED', 20 + i)
      // 26-oct: UNA viva anexada, más vieja que dos intentos fallidos.
      const viva1026 = await deLaFecha(f1026.id, 0, 'CANCEL_REQUESTED', 2, { chargeLinkedAt: minutos(3) })
      await deLaFecha(f1026.id, 1, 'STAMP_FAILED', 30)
      await deLaFecha(f1026.id, 2, 'STAMP_FAILED', 31)
      // 2-nov: sólo canceladas (sin viva: sale la más nueva). 9-nov: nada.
      await deLaFecha(f1102.id, 0, 'CANCELLED', 40)
      const nueva1102 = await deLaFecha(f1102.id, 1, 'CANCELLED', 41)

      const filtros = { view: 'open' as const, q: cobro.customerName }
      const pagina1 = await listOccurrences({ ...filtros, page: 1, pageSize: 2 }, NOW)
      const pagina2 = await listOccurrences({ ...filtros, page: 2, pageSize: 2 }, NOW)
      const completa = await listOccurrences({ ...filtros, pageSize: 100 }, NOW)

      expect(pagina1.rows.map(r => [r.id, r.invoice?.id])).toEqual([
        [f1019.id, mas.id],
        [f1026.id, viva1026.id],
      ])
      expect(pagina1.rows[1].invoice).toMatchObject({ status: 'CANCEL_REQUESTED', linked: true })
      expect(pagina2.rows.map(r => [r.id, r.invoice?.id ?? null])).toEqual([
        [f1102.id, nueva1102.id],
        [f1109.id, null],
      ])
      expect(completa.rows.map(r => r.invoice?.id ?? null)).toEqual([mas.id, viva1026.id, nueva1102.id, null])
    })
  })

  describe('7 · omitir con una anexada viva', () => {
    it('omitir esa fecha es 409 «tiene anexada la factura»; pausar con «omitir lo vencido» la deja PENDING y omite las demás', async () => {
      const cobro = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-10-19', invoiceMode: 'MANUAL' })
      expect(await resumen(cobro.id)).toEqual(['2026-10-19:PENDING', '2026-10-26:PENDING', '2026-11-02:PENDING', '2026-11-09:PENDING'])
      const [f1019, f1026] = await ocurrenciasDe(cobro.id)
      const anexada = await nuevaFactura()
      await linkInvoice(f1026.id, { cfdiId: anexada.id }, superId, NOW)
      // Una timbrada DESDE «Por cobrar» (sin `chargeLinkedAt`) no cuenta como anexada: esa sí se omite como siempre.
      await nuevaFactura({ platformChargeOccurrenceId: f1019.id })

      const omitir = await post(`/occurrences/${f1026.id}/skip`)
      expect(omitir.status).toBe(409)
      expect(omitir.body).toMatchObject({ code: 'PLATFORM_CHARGE_INVOICE_LINKED' })
      expect(omitir.body.message).toMatch(/tiene anexada la factura F-\d+; quítala antes de omitirla/)
      expect((await porFecha(cobro.id, '2026-10-26')).status).toBe('PENDING')

      await pauseCharge(cobro.id, { skipOverdue: true }, superId, NOW)

      expect(await resumen(cobro.id)).toEqual(['2026-10-19:SKIPPED', '2026-10-26:PENDING', '2026-11-02:SKIPPED']) // la de la anexada sigue por cobrar; la futura sin factura se borró
      expect((await facturaDe(anexada.id)).platformChargeOccurrenceId).toBe(f1026.id)
      const [pausa] = await bitacoras('PLATFORM_CHARGE_PAUSED', cobro.id, 1)
      expect(pausa.data).toMatchObject({ skipOverdue: true, removedFuture: 1, skippedOverdue: 2 })
    })

    it('anexar primero, detenido con su candado: omitir espera, ve la anexada y recibe 409', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha({ invoiceMode: 'MANUAL' })
      const factura = await nuevaFactura()
      const aparcada = aparcarLaTransaccion(1)
      let anexando: Promise<unknown> | undefined
      let omitiendo: Promise<unknown> | undefined
      try {
        anexando = linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
        anexando.catch(() => undefined)
        const pid = await aTiempo(aparcada.pid, 60_000, 'anexar quedó aparcado con el candado, sin commit')

        omitiendo = skipOccurrence(fecha.id, superId, NOW)
        omitiendo.catch(() => undefined)
        await esperaElCandado(pid)
        aparcada.soltar()

        await anexando
        await expect(omitiendo).rejects.toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_LINKED' })
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }
      expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PENDING')
      expect((await facturaDe(factura.id)).platformChargeOccurrenceId).toBe(fecha.id)
    })
  })

  describe('8 · quitar lo anexado', () => {
    it('con la cancelación en trámite (CANCEL_REQUESTED) es 409 «sigue en trámite ante el SAT» y la factura sigue ligada', async () => {
      const { fecha } = await cobroDeUnaFecha()
      const factura = await nuevaFactura()
      await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
      await prisma.platformCfdi.update({ where: { id: factura.id }, data: { status: 'CANCEL_REQUESTED' } })

      const res = await del(`/occurrences/${fecha.id}/invoice-link?cfdiId=${factura.id}`)

      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ code: 'PLATFORM_CHARGE_INVOICE_CANCEL_PENDING' })
      expect(res.body.message).toMatch(/sigue en trámite ante el SAT/)
      const fila = await facturaDe(factura.id)
      expect(fila).toMatchObject({ platformChargeOccurrenceId: fecha.id, status: 'CANCEL_REQUESTED' })
      expect(fila.chargeLinkedAt).not.toBeNull()
    })

    it('una STAMPED: la factura queda LIBRE, la fecha conserva sus números y su modo, y después se anexa a OTRO cobro', async () => {
      const unConcepto: ChargeConcept[] = [
        { description: 'Venta de equipo', amountCents: 20000, ivaMode: 'WITHOUT_IVA', satProductKey: '43211509', satUnitKey: 'H87' },
      ]
      const factura = await nuevaFactura({}, unConcepto) // 20,000 + 3,200 de IVA = 23,200 (no es lo que traía la fecha)
      const a = await cobroDeUnaFecha()
      const b = await cobroDeUnaFecha()
      await linkInvoice(a.fecha.id, { cfdiId: factura.id }, superId, NOW)
      const anexada = await porFecha(a.cobro.id, '2026-11-02')
      expect(anexada).toMatchObject({ subtotalCents: 20000, taxCents: 3200, totalCents: 23200, invoiceMode: 'MANUAL' }) // tomó lo que dice la factura
      expect(anexada.concepts).toEqual(unConcepto)

      const vista = await unlinkInvoice(a.fecha.id, { cfdiId: factura.id }, superId, NOW)

      expect(vista.invoice).toBeNull()
      expect(await facturaDe(factura.id)).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null, status: 'STAMPED' }) // libre y vigente
      expect(await porFecha(a.cobro.id, '2026-11-02')).toMatchObject({
        subtotalCents: 20000,
        taxCents: 3200,
        totalCents: 23200,
        invoiceMode: 'MANUAL',
      }) // conserva sus números
      const [quitada] = await bitacoras('PLATFORM_CHARGE_INVOICE_UNLINKED', a.cobro.id, 1)
      expect(quitada.data).toMatchObject({ platformCfdiId: factura.id, status: 'STAMPED', occurrenceId: a.fecha.id })

      // Libre: aparece otra vez entre las candidatas del cliente y se anexa a la fecha de otro cobro.
      const candidatas = await listInvoiceCandidates({ customerType: 'STANDALONE', rfc: RECEPTOR.rfc, q: factura.folio ?? undefined })
      expect(candidatas.rows.map(c => c.id)).toContain(factura.id)
      await linkInvoice(b.fecha.id, { cfdiId: factura.id }, superId, NOW)
      expect((await facturaDe(factura.id)).platformChargeOccurrenceId).toBe(b.fecha.id)
      expect(await porFecha(b.cobro.id, '2026-11-02')).toMatchObject({ totalCents: 23200, invoiceMode: 'MANUAL' })
    })

    it('si «Facturas CFDI» pide cancelarla después de leerla, el UPDATE condicional de quitar da 0 filas: 409 «acaba de cambiar» y sigue ligada', async () => {
      const { fecha } = await cobroDeUnaFecha()
      const factura = await nuevaFactura()
      await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
      const otra = otraConexionCambia(factura.id, { status: 'CANCEL_REQUESTED' })
      try {
        const pid = await aTiempo(otra.pid, 60_000, 'la otra conexión pidió la cancelación y la dejó sin confirmar')
        const quitando = unlinkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW) // la lee STAMPED (la otra no confirmó) y su UPDATE espera la fila
        quitando.catch(() => undefined)
        await esperaLaFila(pid)
        otra.confirmar()
        await otra.terminada

        await expect(quitando).rejects.toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_LINK_CHANGED' })
        await expect(quitando).rejects.toThrow(/No se pudo quitar/)
      } finally {
        otra.confirmar()
        await otra.terminada.catch(() => undefined)
      }
      expect(await facturaDe(factura.id)).toMatchObject({ platformChargeOccurrenceId: fecha.id, status: 'CANCEL_REQUESTED' })
    })

    it('una factura timbrada DESDE «Por cobrar» (sin marca de anexada) no se quita: 409, y sigue en su fecha', async () => {
      const { fecha } = await cobroDeUnaFecha()
      const desdeAqui = await nuevaFactura({ platformChargeOccurrenceId: fecha.id })

      await expect(unlinkInvoice(fecha.id, { cfdiId: desdeAqui.id }, superId, NOW)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PLATFORM_CHARGE_INVOICE_NOT_LINKED',
      })
      expect((await facturaDe(desdeAqui.id)).platformChargeOccurrenceId).toBe(fecha.id)
    })

    it('«Deshacer» una fecha pagada con anexada pide quitarla primero; tras quitarla, regresa a pendiente con el modo del cobro', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha() // AUTOMATIC
      const factura = await nuevaFactura()
      await payOccurrence(fecha.id, { invoice: false }, superId, NOW) // PAID, y pasa a MANUAL
      await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)

      await expect(reopenOccurrence(fecha.id, superId, NOW)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PLATFORM_CHARGE_INVOICE_LINKED',
        message: 'Quita primero la factura F-' + (factura.folio ?? ''),
      })
      expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PAID')

      await unlinkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
      const vista = await reopenOccurrence(fecha.id, superId, NOW)

      expect(vista).toMatchObject({ status: 'PENDING', paidAt: null, invoiceMode: 'AUTOMATIC', invoice: null })
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('alta desde una factura: POST /platform-charges con invoiceId, por HTTP (todo en una transacción)', () => {
  const hoy = () => todayInMexico(new Date())
  const masDias = (dia: string, n: number) => new Date(calendarDayToDb(dia).getTime() + n * 86_400_000).toISOString().slice(0, 10)
  const cuerpo = (nombre: string, over: Record<string, unknown> = {}) => ({
    customerType: 'STANDALONE',
    customerName: nombre,
    anchorDate: hoy(),
    ...over,
  })
  const UN_CONCEPTO: ChargeConcept[] = [
    { description: 'Suscripción anual', amountCents: 123456, ivaMode: 'WITHOUT_IVA', satProductKey: '81112501', satUnitKey: 'E48' },
  ]
  /** 123,456 × 16 % = 19,752.96 → 19,753 de IVA; total 143,209 (a mano, no con la fórmula del código). */
  const SUBTOTAL = 123456
  const IVA = 19753
  const TOTAL_FACTURA = 143209

  async function altaDesdeFactura() {
    const perfil = await nuevoPerfil()
    const factura = await nuevaFactura({ billingTaxProfileId: perfil.id }, UN_CONCEPTO)
    const nombre = unico('Cobro desde factura')
    const res = await post(
      '/',
      cuerpo(nombre, {
        invoiceId: factura.id,
        // Lo que el cuerpo diga de esto se ignora: lo deriva el servidor de la factura.
        billingTaxProfileId: (await nuevoPerfil({ rfc: 'XEXX010101000' })).id,
        frequency: 'WEEKLY',
        invoiceMode: 'AUTOMATIC',
        concepts: [
          { description: 'IGNORAR ESTE CONCEPTO', amountCents: 999, ivaMode: 'WITH_IVA', satProductKey: '11111111', satUnitKey: 'H87' },
        ],
      }),
    )
    expect(res.status).toBe(201)
    const chargeId: string = res.body.data.id
    creado.charges.push(chargeId)
    return { res, chargeId, factura, perfil, nombre }
  }

  it('9 · nace UNA SOLA VEZ y MANUAL, con una sola fecha ligada que toma los totales y los conceptos de la factura; lo que el cuerpo diga de ellos se ignora', async () => {
    const { res, chargeId, factura, perfil, nombre } = await altaDesdeFactura()

    expect(res.body.data).toMatchObject({ frequency: 'ONE_TIME', invoiceMode: 'MANUAL', anchorDate: hoy(), billingTaxProfileId: perfil.id })
    const fechas = await ocurrenciasDe(chargeId)
    expect(fechas).toHaveLength(1) // una sola fecha, aunque el cuerpo pidió WEEKLY
    expect(dbToCalendarDay(fechas[0].dueDate)).toBe(hoy())
    expect(fechas[0]).toMatchObject({
      status: 'PENDING',
      invoiceMode: 'MANUAL',
      subtotalCents: SUBTOTAL,
      taxCents: IVA,
      totalCents: TOTAL_FACTURA,
    })
    expect(fechas[0].concepts).toEqual(UN_CONCEPTO) // los de la factura, no «IGNORAR ESTE CONCEPTO»
    expect(factura).toMatchObject({ subtotalCents: SUBTOTAL, taxCents: IVA, totalCents: TOTAL_FACTURA })
    const cobro = await prisma.platformCharge.findUniqueOrThrow({ where: { id: chargeId } })
    expect(cobro.concepts).toEqual(UN_CONCEPTO)
    expect(cobro).toMatchObject({ frequency: 'ONE_TIME', invoiceMode: 'MANUAL', billingTaxProfileId: perfil.id })

    // La factura quedó ligada a esa fecha, marcada como anexada (se puede quitar).
    const ligada = await facturaDe(factura.id)
    expect(ligada.platformChargeOccurrenceId).toBe(fechas[0].id)
    expect(ligada.chargeLinkedAt).not.toBeNull()

    // Lo que ve la pantalla: el cobro por su id y la fila con su factura y la suma del filtro.
    const uno = await get(`/${chargeId}`)
    expect(uno.status).toBe(200)
    expect(uno.body.data).toMatchObject({ id: chargeId, frequency: 'ONE_TIME', anchorDate: hoy() })
    const lista = await get(`/occurrences?view=open&q=${encodeURIComponent(nombre)}`)
    expect(lista.body.meta).toMatchObject({ total: 1, sumCents: TOTAL_FACTURA })
    expect(lista.body.data[0].invoice).toMatchObject({ id: factura.id, status: 'STAMPED', linked: true })

    // La bitácora: el alta (con la factura) y el anexado, ya con el cobro confirmado.
    const [alta] = await bitacoras('PLATFORM_CHARGE_CREATED', chargeId, 1)
    expect(alta.data).toMatchObject({ frequency: 'ONE_TIME', invoiceMode: 'MANUAL', invoiceId: factura.id })
    const [anexo] = await bitacoras('PLATFORM_CHARGE_INVOICE_LINKED', chargeId, 1)
    expect(anexo.data).toMatchObject({ platformCfdiId: factura.id, occurrenceId: fechas[0].id, totalCents: TOTAL_FACTURA })
  })

  it('9 · editar ese cobro: 409 mientras tenga la factura; tras quitarla, edita su única fecha EN SU LUGAR (mismo id) y conserva los números de la factura; no se vuelve recurrente ni se pausa', async () => {
    const { chargeId, factura } = await altaDesdeFactura()
    const [fecha] = await ocurrenciasDe(chargeId)

    const conFactura = await patch(`/${chargeId}`, { anchorDate: masDias(hoy(), 3) })
    expect(conFactura.status).toBe(409)
    expect(conFactura.body).toMatchObject({ code: 'PLATFORM_CHARGE_ONE_TIME_HAS_INVOICE' })
    expect(dbToCalendarDay((await ocurrenciasDe(chargeId))[0].dueDate)).toBe(hoy())

    const quitada = await del(`/occurrences/${fecha.id}/invoice-link?cfdiId=${factura.id}`)
    expect(quitada.status).toBe(200)
    expect((await facturaDe(factura.id)).platformChargeOccurrenceId).toBeNull()

    const editada = await patch(`/${chargeId}`, { anchorDate: masDias(hoy(), 3) })
    expect(editada.status).toBe(200)
    const [despues] = await ocurrenciasDe(chargeId)
    expect(despues.id).toBe(fecha.id) // en su lugar: ni borró ni regeneró la fila
    expect(dbToCalendarDay(despues.dueDate)).toBe(masDias(hoy(), 3))
    expect(despues).toMatchObject({ subtotalCents: SUBTOTAL, taxCents: IVA, totalCents: TOTAL_FACTURA }) // sólo cambió la fecha

    const recurrente = await patch(`/${chargeId}`, { frequency: 'WEEKLY' })
    expect(recurrente.status).toBe(400)
    expect(recurrente.body).toMatchObject({ code: 'PLATFORM_CHARGE_ONE_TIME_FIXED' })
    const pausa = await post(`/${chargeId}/pause`, { skipOverdue: false })
    expect(pausa.status).toBe(400)
    expect(pausa.body).toMatchObject({ code: 'PLATFORM_CHARGE_ONE_TIME_NO_PAUSE' })
  })

  describe('10 · rollback real: si la factura no se puede anexar, NO queda ningún cobro ni fecha', () => {
    const SIN_IVA_EXENTA = [
      {
        description: 'Renglón exento',
        satProductKey: '81112501',
        satUnitKey: 'E48',
        quantity: 1,
        unitPriceCents: 10000,
        taxExempt: true,
      },
    ]
    interface Caso {
      factura: { id: string }
      extra?: Record<string, unknown>
      status: number
      code: string
      /** Lo que la factura debe seguir teniendo tras el rechazo. */
      ligadaA?: string | null
    }
    const casos: Array<[string, () => Promise<Caso>]> = [
      [
        'la factura ya es de OTRO cobro',
        async () => {
          const ocupada = await cobroDeUnaFecha({ invoiceMode: 'MANUAL' })
          const factura = await nuevaFactura()
          await linkInvoice(ocupada.fecha.id, { cfdiId: factura.id }, superId, NOW)
          return { factura, status: 409, code: 'PLATFORM_CHARGE_INVOICE_LINK_TAKEN', ligadaA: ocupada.fecha.id }
        },
      ],
      [
        'es de OTRO cliente',
        async () => ({
          factura: await nuevaFactura({ organizationId: `org-b-${suffix}`, receptorRfc: 'XEXX010101000' }),
          extra: { customerType: 'ORGANIZATION', organizationId: `org-a-${suffix}` },
          status: 409,
          code: 'PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER',
        }),
      ],
      [
        'ya tiene PAGOS (amountPaidCents)',
        async () => ({
          factura: await nuevaFactura({ amountPaidCents: 5000 }),
          status: 409,
          code: 'PLATFORM_CHARGE_INVOICE_LINK_HAS_PAYMENTS',
        }),
      ],
      [
        'ya tiene un complemento de pago VIVO (aunque amountPaidCents siga en 0)',
        async () => {
          const factura = await nuevaFactura()
          await nuevaFactura({ type: 'PAGO', parentPlatformCfdiId: factura.id, status: 'STAMPED' })
          return { factura, status: 409, code: 'PLATFORM_CHARGE_INVOICE_LINK_HAS_PAYMENTS' }
        },
      ],
      [
        'no está timbrada (cancelada)',
        async () => ({
          factura: await nuevaFactura({ status: 'CANCELLED' }),
          status: 409,
          code: 'PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED',
        }),
      ],
      [
        'no cabe en lo que «Por cobrar» sabe calcular (un renglón exento)',
        async () => ({
          factura: await nuevaFactura({
            lines: SIN_IVA_EXENTA as unknown as Prisma.InputJsonValue,
            subtotalCents: 10000,
            taxCents: 0,
            totalCents: 10000,
          }),
          status: 409,
          code: 'PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE',
        }),
      ],
      [
        'la factura ya no existe',
        async () => ({ factura: { id: 'cnoexiste0000000000000000' }, status: 404, code: 'PLATFORM_CHARGE_INVOICE_LINK_NOT_FOUND' }),
      ],
    ]

    it.each(casos)('%s: 409/404 y la base queda EXACTAMENTE como estaba', async (_nombre, armar) => {
      const caso = await armar()
      const nombre = unico('Cobro que se deshace')
      const contar = async () => ({
        cobros: await prisma.platformCharge.count({ where: { createdById: superId } }),
        fechas: await prisma.platformChargeOccurrence.count({ where: { charge: { createdById: superId } } }),
      })
      const antes = await contar()
      const facturaAntes = await prisma.platformCfdi.findUnique({ where: { id: caso.factura.id } })

      const res = await post('/', cuerpo(nombre, { invoiceId: caso.factura.id, ...(caso.extra ?? {}) }))

      expect(res.status).toBe(caso.status)
      expect(res.body).toMatchObject({ code: caso.code })
      expect(await contar()).toEqual(antes) // ni un cobro ni una fecha: la transacción se deshizo entera
      expect(await prisma.platformCharge.count({ where: { customerName: nombre } })).toBe(0)
      const facturaDespues = await prisma.platformCfdi.findUnique({ where: { id: caso.factura.id } })
      expect(facturaDespues).toEqual(facturaAntes) // y la factura, intacta (ni vínculo ni versión nueva)
      if (caso.ligadaA !== undefined) expect(facturaDespues?.platformChargeOccurrenceId).toBe(caso.ligadaA)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('11 · una sola vez (ONE_TIME) y sin factura (NONE): los enums de una base migrada de verdad', () => {
  it('se guardan y se leen como enums de Postgres; la fecha nace con el alta aunque sea lejana o vencida; el generador diario NO toca un ONE_TIME', async () => {
    const [{ frecuencias }] = await prisma.$queryRaw<{ frecuencias: string[] }[]>`
      SELECT array_agg(e::text) AS frecuencias FROM unnest(enum_range(NULL::"PlatformChargeFrequency")) e`
    const [{ modos }] = await prisma.$queryRaw<{ modos: string[] }[]>`
      SELECT array_agg(e::text) AS modos FROM unnest(enum_range(NULL::"PlatformChargeInvoiceMode")) e`
    expect(frecuencias).toContain('ONE_TIME')
    expect(modos).toContain('NONE')

    const sinClaves = { description: 'Venta de equipo', amountCents: 100000, ivaMode: 'WITH_IVA' as const } // sin claves del SAT: NONE no las pide
    const lejana = await nuevoCobro({ frequency: 'ONE_TIME', anchorDate: '2026-12-20', invoiceMode: 'NONE', concepts: [sinClaves] })
    const vencida = await nuevoCobro({ frequency: 'ONE_TIME', anchorDate: '2026-10-20', invoiceMode: 'NONE', concepts: [sinClaves] })

    // Lo que Postgres guardó, leído como texto de su enum (no lo que Prisma cree).
    for (const cobro of [lejana, vencida]) {
      const [guardado] = await prisma.$queryRaw<{ frecuencia: string; modo: string }[]>`
        SELECT frequency::text AS frecuencia, "invoiceMode"::text AS modo FROM "PlatformCharge" WHERE id = ${cobro.id}`
      expect(guardado).toEqual({ frecuencia: 'ONE_TIME', modo: 'NONE' })
      const fechas = await prisma.$queryRaw<{ modo: string }[]>`
        SELECT "invoiceMode"::text AS modo FROM "PlatformChargeOccurrence" WHERE "chargeId" = ${cobro.id}`
      expect(fechas).toEqual([{ modo: 'NONE' }])
    }
    expect(await prisma.platformCharge.findUniqueOrThrow({ where: { id: lejana.id } })).toMatchObject({
      frequency: 'ONE_TIME',
      invoiceMode: 'NONE',
    })

    // Su única fecha nació con el alta: la lejana (más allá de hoy+7) y la vencida; con los conceptos sin claves y los totales del 16 %.
    expect(await resumen(lejana.id)).toEqual(['2026-12-20:PENDING'])
    expect(await resumen(vencida.id)).toEqual(['2026-10-20:PENDING'])
    const [fechaLejana] = await ocurrenciasDe(lejana.id)
    expect(fechaLejana.concepts).toEqual([{ ...sinClaves, satProductKey: '', satUnitKey: '' }])
    expect(fechaLejana).toMatchObject({ subtotalCents: 86207, taxCents: 13793, totalCents: 100000, invoiceMode: 'NONE' })
    expect((await payPreview(fechaLejana.id)).willInvoice).toBe(false) // sin factura: la casilla de «Ya me pagó» sale sin marcar

    // El generador diario no recorre un ONE_TIME: ni toca su fila ni la vuelve a crear si falta. Uno semanal, de control, sí se regenera.
    const semanal = await nuevoCobro({ frequency: 'WEEKLY', anchorDate: '2026-11-02', invoiceMode: 'MANUAL' })
    await generateAllActive(NOW)
    const [intacta] = await ocurrenciasDe(lejana.id)
    expect(intacta).toMatchObject({ id: fechaLejana.id })
    expect(intacta.updatedAt).toEqual(fechaLejana.updatedAt)
    expect(await resumen(vencida.id)).toEqual(['2026-10-20:PENDING'])

    await prisma.platformChargeOccurrence.deleteMany({ where: { chargeId: { in: [lejana.id, vencida.id, semanal.id] } } })
    await generateAllActive(NOW)
    expect(await resumen(semanal.id)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING']) // el recurrente sí se regeneró
    expect(await resumen(lejana.id)).toEqual([]) // el ONE_TIME, no
    expect(await resumen(vencida.id)).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Un conjunto de fechas que cubre los tres modos (AUTOMATIC, MANUAL y NONE) y TODAS las combinaciones de factura que importan. La categoría
// de cada una está escrita a mano aquí, con la regla de la spec (STAMPED, PROBLEM, NONE, PENDING, en ese orden), no calculada con el código.
type Categoria = InvoiceCategory
interface Semilla {
  cobro: 'A' | 'B' | 'C' | 'D'
  dia: string
  modo: PlatformChargeInvoiceMode
  facturas: PlatformCfdiStatus[]
  categoria: Categoria
}
const SEMILLAS: Semilla[] = [
  // A (mensual): un renglón por combinación
  { cobro: 'A', dia: '2026-01-15', modo: 'AUTOMATIC', facturas: [], categoria: 'PENDING' },
  { cobro: 'A', dia: '2026-02-15', modo: 'MANUAL', facturas: [], categoria: 'PENDING' },
  { cobro: 'A', dia: '2026-03-15', modo: 'NONE', facturas: [], categoria: 'NONE' },
  { cobro: 'A', dia: '2026-04-15', modo: 'MANUAL', facturas: ['STAMPED'], categoria: 'STAMPED' },
  { cobro: 'A', dia: '2026-05-15', modo: 'AUTOMATIC', facturas: ['CANCEL_REQUESTED'], categoria: 'STAMPED' },
  { cobro: 'A', dia: '2026-06-15', modo: 'MANUAL', facturas: ['STAMPING'], categoria: 'PROBLEM' },
  { cobro: 'A', dia: '2026-07-15', modo: 'AUTOMATIC', facturas: ['STAMP_FAILED'], categoria: 'PROBLEM' },
  { cobro: 'A', dia: '2026-08-15', modo: 'MANUAL', facturas: ['CANCELLED'], categoria: 'PENDING' }, // una cancelada no cuenta como factura
  { cobro: 'A', dia: '2026-09-15', modo: 'NONE', facturas: ['CANCELLED'], categoria: 'NONE' },
  { cobro: 'A', dia: '2026-10-15', modo: 'AUTOMATIC', facturas: ['STAMPED', 'STAMP_FAILED'], categoria: 'STAMPED' }, // lo timbrado manda sobre un intento fallido
  { cobro: 'A', dia: '2026-11-15', modo: 'MANUAL', facturas: ['STAMPING', 'CANCELLED'], categoria: 'PROBLEM' },
  { cobro: 'A', dia: '2026-12-15', modo: 'NONE', facturas: ['STAMPED'], categoria: 'STAMPED' }, // una fecha sin factura que ya se facturó
  { cobro: 'A', dia: '2027-01-15', modo: 'NONE', facturas: ['STAMPING'], categoria: 'PROBLEM' }, // un intento en camino manda sobre el modo NONE
  { cobro: 'A', dia: '2027-02-15', modo: 'MANUAL', facturas: ['DRAFT'], categoria: 'PENDING' }, // un borrador no es factura
  { cobro: 'A', dia: '2027-03-15', modo: 'NONE', facturas: ['DRAFT'], categoria: 'NONE' },
  {
    cobro: 'A',
    dia: '2027-04-15',
    modo: 'AUTOMATIC',
    facturas: ['STAMPED', 'CANCEL_REQUESTED', 'STAMPING', 'STAMP_FAILED', 'CANCELLED', 'DRAFT'],
    categoria: 'STAMPED',
  },
  // B (semanal): pegadas a fin de mes
  { cobro: 'B', dia: '2026-01-31', modo: 'MANUAL', facturas: [], categoria: 'PENDING' },
  { cobro: 'B', dia: '2026-02-28', modo: 'MANUAL', facturas: ['STAMPED'], categoria: 'STAMPED' },
  { cobro: 'B', dia: '2026-03-01', modo: 'NONE', facturas: [], categoria: 'NONE' },
  // C (una sola vez, de una ORGANIZACIÓN)
  { cobro: 'C', dia: '2026-12-31', modo: 'MANUAL', facturas: ['STAMPING'], categoria: 'PROBLEM' },
  // D (quincenal, con el MISMO NOMBRE que A: se suman en un solo grupo por cliente)
  { cobro: 'D', dia: '2027-01-01', modo: 'AUTOMATIC', facturas: [], categoria: 'PENDING' },
  { cobro: 'D', dia: '2028-02-29', modo: 'MANUAL', facturas: ['STAMPED'], categoria: 'STAMPED' }, // el 29 de un año bisiesto
]
interface FilaSembrada extends Semilla {
  id: string
  total: number
  nombre: string
  frecuencia: PlatformChargeFrequency
  tipo: 'STANDALONE' | 'ORGANIZATION'
}

/** Un cobro sembrado a mano (sin pasar por el generador): para ocurrencias de fechas y estados exactos. */
async function cobroDeSemilla(nombre: string, over: Partial<Prisma.PlatformChargeUncheckedCreateInput> = {}) {
  const billingTaxProfileId = 'billingTaxProfileId' in over ? over.billingTaxProfileId : (await nuevoPerfil()).id
  const cobro = await prisma.platformCharge.create({
    data: {
      customerType: 'STANDALONE',
      customerName: nombre,
      frequency: 'MONTHLY',
      anchorDate: calendarDayToDb('2026-01-01'),
      concepts: [RENTA] as unknown as Prisma.InputJsonValue,
      invoiceMode: 'MANUAL',
      createdById: superId,
      ...over,
      billingTaxProfileId,
    },
  })
  creado.charges.push(cobro.id)
  return cobro
}
const fechaDeSemilla = (
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

/** Siembra los cuatro cobros y todas las fechas de `SEMILLAS` con sus facturas. `prefijo` termina en «|» para que la búsqueda no choque con otro. */
async function sembrarFiltros(prefijo: string): Promise<FilaSembrada[]> {
  const defs = {
    A: { nombre: `${prefijo} Alfa`, frecuencia: 'MONTHLY', tipo: 'STANDALONE' },
    B: { nombre: `${prefijo} Beta`, frecuencia: 'WEEKLY', tipo: 'STANDALONE' },
    C: { nombre: `${prefijo} Gamma`, frecuencia: 'ONE_TIME', tipo: 'ORGANIZATION' },
    D: { nombre: `${prefijo} Alfa`, frecuencia: 'BIWEEKLY', tipo: 'STANDALONE' },
  } as const
  const cobros = {} as Record<'A' | 'B' | 'C' | 'D', { id: string }>
  for (const clave of ['A', 'B', 'C', 'D'] as const) {
    const d = defs[clave]
    cobros[clave] = await cobroDeSemilla(
      d.nombre,
      d.tipo === 'ORGANIZATION'
        ? { frequency: d.frecuencia, customerType: 'ORGANIZATION', organizationId: `org-sembrada-${suffix}`, billingTaxProfileId: null }
        : { frequency: d.frecuencia },
    )
  }

  const filas: FilaSembrada[] = []
  for (const [i, semilla] of SEMILLAS.entries()) {
    const total = 1000 + 111 * i // cada fecha, un total distinto: una suma equivocada no puede cuadrar de casualidad
    const fecha = await fechaDeSemilla(cobros[semilla.cobro].id, semilla.dia, total, { invoiceMode: semilla.modo })
    for (const [k, status] of semilla.facturas.entries()) {
      await nuevaFactura({
        platformChargeOccurrenceId: fecha.id,
        status,
        idempotencyKey: `por-cobrar:${fecha.id}:${k}`,
        uuid: status === 'STAMPED' || status === 'CANCEL_REQUESTED' ? `UUID-${suffix}-${fecha.id}-${k}` : null,
        createdAt: new Date(Date.UTC(2026, 10, 1, 12, k)),
      })
    }
    const d = defs[semilla.cobro]
    filas.push({ ...semilla, id: fecha.id, total, nombre: d.nombre, frecuencia: d.frecuencia, tipo: d.tipo })
  }
  return filas
}
const suma = (filas: FilaSembrada[]) => filas.reduce((s, f) => s + f.total, 0)
const ids = (xs: Array<{ id: string }>) => xs.map(x => x.id).sort()

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('candidatas para anexar: sólo facturas de ingreso, timbradas y sin cobro, del cliente que se pide', () => {
  it('trae las que se pueden anexar (de la más nueva a la más vieja), con su total, y deja fuera las demás; busca por folio, serie-folio y RFC; el tope lo pone el servidor', async () => {
    const rfc = 'ZZ' + String(Date.now()).slice(-9)
    const minuto = (n: number) => new Date(Date.UTC(2026, 10, 1, 8, n))
    const propia = (over: Partial<Prisma.PlatformCfdiUncheckedCreateInput>) => nuevaFactura({ receptorRfc: rfc, ...over })
    const a = await propia({ serie: 'A', folio: '19', createdAt: minuto(30) })
    const b = await propia({ serie: 'A', folio: '18', createdAt: minuto(20) })
    const conPagos = await propia({ serie: 'B', folio: '7', amountPaidCents: 1000, createdAt: minuto(10) })
    const conComplemento = await propia({ serie: 'B', folio: '8', createdAt: minuto(9) })
    await propia({ type: 'PAGO', parentPlatformCfdiId: conComplemento.id, createdAt: minuto(9) })
    const conComplementoCancelado = await propia({ serie: 'B', folio: '9', createdAt: minuto(8) })
    await propia({ type: 'PAGO', parentPlatformCfdiId: conComplementoCancelado.id, status: 'CANCELLED', uuid: null, createdAt: minuto(8) })
    const exenta = await propia({
      serie: 'C',
      folio: '1',
      createdAt: minuto(7),
      lines: [
        {
          description: 'Renglón exento',
          satProductKey: '81112501',
          satUnitKey: 'E48',
          quantity: 1,
          unitPriceCents: 10000,
          taxExempt: true,
        },
      ] as unknown as Prisma.InputJsonValue,
      subtotalCents: 10000,
      taxCents: 0,
      totalCents: 10000,
    })
    // Las que NO son candidatas:
    const ocupada = await cobroDeUnaFecha({ invoiceMode: 'MANUAL' })
    await propia({ platformChargeOccurrenceId: ocupada.fecha.id, chargeLinkedAt: minuto(1) }) // ya anexada a un cobro
    await propia({ status: 'CANCELLED' })
    await propia({ status: 'STAMPING', uuid: null })
    await propia({ status: 'DRAFT', uuid: null })
    await propia({ uuid: null }) // «timbrada» sin UUID: una fila mal escrita
    await propia({ type: 'PAGO' }) // un complemento no es una factura que se cobre

    const todas = await listInvoiceCandidates({ customerType: 'STANDALONE', rfc, pageSize: 100 })

    expect(todas.rows.map(c => c.id)).toEqual([a.id, b.id, conPagos.id, conComplemento.id, conComplementoCancelado.id, exenta.id])
    expect(todas).toMatchObject({ total: 6, page: 1, pageSize: 100 })
    const porId = new Map(todas.rows.map(c => [c.id, c]))
    expect(porId.get(a.id)).toMatchObject({ serie: 'A', folio: '19', totalCents: TOTAL, hasPayments: false })
    expect(porId.get(a.id)!.concepts).toEqual([RENTA, LICENCIA])
    expect(porId.get(a.id)!.descriptions).toEqual([RENTA.description, LICENCIA.description])
    expect(porId.get(conPagos.id)!.hasPayments).toBe(true) // amountPaidCents > 0
    expect(porId.get(conComplemento.id)!.hasPayments).toBe(true) // un complemento vivo
    expect(porId.get(conComplementoCancelado.id)!.hasPayments).toBe(false) // uno cancelado no cuenta
    expect(porId.get(exenta.id)!.concepts).toBeNull() // no cabe en el modelo del 16 %

    const pagina2 = await listInvoiceCandidates({ customerType: 'STANDALONE', rfc, page: 2, pageSize: 2 })
    expect(pagina2.rows.map(c => c.id)).toEqual([conPagos.id, conComplemento.id])
    expect(pagina2).toMatchObject({ total: 6, page: 2, pageSize: 2 })
    expect((await listInvoiceCandidates({ customerType: 'STANDALONE', rfc, pageSize: 500 })).pageSize).toBe(100)

    for (const [q, esperada] of [
      ['A-19', a],
      ['a19', a],
      ['A18', b],
      ['B-7', conPagos],
    ] as const) {
      expect((await listInvoiceCandidates({ customerType: 'STANDALONE', rfc, q })).rows.map(c => c.id)).toEqual([esperada.id])
    }

    // Por organización: sólo las de ESA organización (o de su RFC); un cliente que no existe no se lleva las de todos.
    const org = `org-cand-${suffix}`
    const deLaOrg = await nuevaFactura({ organizationId: org, receptorRfc: 'XEXX010101000' })
    expect((await listInvoiceCandidates({ customerType: 'ORGANIZATION', organizationId: org })).rows.map(c => c.id)).toEqual([deLaOrg.id])
    expect((await listInvoiceCandidates({ customerType: 'ORGANIZATION', organizationId: `${org}-x` })).rows).toEqual([])
    // Sin decir de qué cliente es, NO se listan las de todos.
    await expect(listInvoiceCandidates({ customerType: 'ORGANIZATION' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PLATFORM_CHARGE_INVOICE_CANDIDATES_NEEDS_CUSTOMER',
    })
    await expect(listInvoiceCandidates({})).rejects.toMatchObject({
      statusCode: 400,
      code: 'PLATFORM_CHARGE_INVOICE_CANDIDATES_NEEDS_CUSTOMER',
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('15 · las rutas nuevas, por HTTP con el guardia real (llegan a SU handler, no a una ruta /:id equivocada)', () => {
  const NUEVAS: Array<['get' | 'post' | 'delete', string]> = [
    ['get', '/occurrences/groups?groupBy=customer'],
    ['get', '/invoice-candidates?rfc=XAXX010101000'],
    ['post', '/occurrences/x/invoice-link'],
    ['delete', '/occurrences/x/invoice-link'],
    ['get', '/x'],
  ]

  it('sin token es 401 y un DUEÑO recibe 403, en cada ruta nueva', async () => {
    for (const [metodo, ruta] of NUEVAS) {
      const sinToken = await api()[metodo](`${BASE}${ruta}`).send({})
      expect([metodo, ruta, sinToken.status]).toEqual([metodo, ruta, 401])
      const comoDueno = await api()[metodo](`${BASE}${ruta}`).set('Authorization', `Bearer ${ownerToken}`).send({})
      expect([metodo, ruta, comoDueno.status]).toEqual([metodo, ruta, 403])
    }
  })

  it('/occurrences/groups, /invoice-candidates y /:id contestan lo suyo (cada una con su forma y sus 400/404), y una fecha que no existe no es un grupo', async () => {
    const prefijo = unico('Rutas') + '|'
    const filas = await sembrarFiltros(prefijo)
    const cobro = await nuevoCobro({ frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const rfc = 'ZZ' + String(Date.now()).slice(-9)
    const factura = await nuevaFactura({ receptorRfc: rfc })

    const grupos = await get(`/occurrences/groups?groupBy=invoice&view=open&q=${encodeURIComponent(prefijo)}`)
    expect(grupos.status).toBe(200)
    expect(grupos.body).toMatchObject({ success: true, meta: { groupBy: 'invoice', truncated: false } })
    for (const grupo of grupos.body.data) expect(Object.keys(grupo).sort()).toEqual(['count', 'key', 'label', 'totalCents'])
    const porCategoria = Object.fromEntries(grupos.body.data.map((g: { key: string; count: number }) => [g.key, g.count]))
    const esperado = (categoria: Categoria) => filas.filter(f => f.categoria === categoria).length
    expect(porCategoria).toEqual({
      STAMPED: esperado('STAMPED'),
      PROBLEM: esperado('PROBLEM'),
      PENDING: esperado('PENDING'),
      NONE: esperado('NONE'),
    })

    const sinGrupo = await get('/occurrences/groups')
    expect(sinGrupo.status).toBe(400)
    expect(sinGrupo.body.message).toMatch(/Elige cómo agrupar/)

    // Sin cliente es el 400 de las candidatas (con una ruta /:id sería un 404 «Cobro no encontrado»).
    const sinCliente = await get('/invoice-candidates')
    expect(sinCliente.status).toBe(400)
    expect(sinCliente.body).toMatchObject({ code: 'PLATFORM_CHARGE_INVOICE_CANDIDATES_NEEDS_CUSTOMER' })
    const candidatas = await get(`/invoice-candidates?customerType=STANDALONE&rfc=${rfc}`)
    expect(candidatas.status).toBe(200)
    expect(candidatas.body.meta).toEqual({ total: 1, page: 1, pageSize: 50 })
    expect(candidatas.body.data[0]).toMatchObject({ id: factura.id, totalCents: TOTAL, hasPayments: false, receptorRfc: rfc })

    const uno = await get(`/${cobro.id}`)
    expect(uno.status).toBe(200)
    expect(uno.body.data).toMatchObject({ id: cobro.id, frequency: 'MONTHLY', anchorDate: '2026-11-02' })
    const noExiste = await get('/cnoexiste0000000000000000')
    expect(noExiste.status).toBe(404)
    expect(noExiste.body).toMatchObject({ code: 'PLATFORM_CHARGE_NOT_FOUND' })

    // Anexar y quitar por HTTP: 404 si la fecha no existe; y el recorrido completo con la factura de arriba.
    expect((await post('/occurrences/cnoexiste0000000000000000/invoice-link', { cfdiId: factura.id })).status).toBe(404)
    expect((await post(`/occurrences/${filas[0].id}/invoice-link`, {})).status).toBe(400) // sin cfdiId
    const fecha = await porFecha(cobro.id, '2026-11-02')
    const delCliente = await nuevaFactura() // la de arriba es de otro RFC: ésta es del perfil del cobro
    const anexada = await post(`/occurrences/${fecha.id}/invoice-link`, { cfdiId: delCliente.id })
    expect(anexada.status).toBe(200)
    expect(anexada.body.data).toMatchObject({ id: fecha.id, invoiceMode: 'MANUAL', invoice: { id: delCliente.id, linked: true } })
    expect((await del(`/occurrences/${fecha.id}/invoice-link`)).status).toBe(400) // sin la factura confirmada
    const quitada = await del(`/occurrences/${fecha.id}/invoice-link?cfdiId=${delCliente.id}`)
    expect(quitada.status).toBe(200)
    expect(quitada.body.data.invoice).toBeNull()
  })

  it('«desde» después de «hasta» es 400 en la lista y en los grupos, y un día que no existe también; los filtros de varios valores llegan por la URL de las dos formas', async () => {
    const prefijo = unico('Urls') + '|'
    const filas = await sembrarFiltros(prefijo)
    const q = `q=${encodeURIComponent(prefijo)}`

    for (const ruta of ['/occurrences?', '/occurrences/groups?groupBy=month&']) {
      const alReves = await get(`${ruta}from=2026-12-01&to=2026-01-01`)
      expect([ruta, alReves.status]).toEqual([ruta, 400])
      expect(alReves.body).toMatchObject({ code: 'PLATFORM_CHARGE_INVALID_DATE_RANGE' })
      const inexistente = await get(`${ruta}from=2026-02-30`)
      expect([ruta, inexistente.status]).toEqual([ruta, 400])
      expect(inexistente.body).toMatchObject({ code: 'PLATFORM_CHARGE_INVALID_DATE' })
      const mal = await get(`${ruta}from=ayer`)
      expect([ruta, mal.status]).toEqual([ruta, 400])
      expect(mal.body.message).toMatch(/AAAA-MM-DD/)
    }

    const de = (pasa: (f: FilaSembrada) => boolean) => ({ total: filas.filter(pasa).length, sumCents: suma(filas.filter(pasa)) })
    const esperadaCategoria = de(f => f.categoria === 'STAMPED' || f.categoria === 'PROBLEM')
    for (const url of [
      `/occurrences?${q}&invoice=STAMPED&invoice=PROBLEM`,
      `/occurrences?${q}&invoice=STAMPED,PROBLEM`,
      `/occurrences?${q}&invoice=STAMPED,PROBLEM,PROBLEM`,
    ]) {
      const res = await get(url)
      expect([url, res.status]).toEqual([url, 200])
      expect(res.body.meta).toMatchObject({ total: esperadaCategoria.total, sumCents: esperadaCategoria.sumCents })
    }
    const periodicidad = await get(`/occurrences?${q}&frequency=WEEKLY,ONE_TIME&customerType=ORGANIZATION,STANDALONE`)
    expect(periodicidad.body.meta).toMatchObject(de(f => f.frecuencia === 'WEEKLY' || f.frecuencia === 'ONE_TIME'))
    const organizacion = await get(`/occurrences?${q}&customerType=ORGANIZATION`)
    expect(organizacion.body.meta).toMatchObject(de(f => f.tipo === 'ORGANIZATION'))
    const sinNada = await get(`/occurrences?${q}&invoice=&frequency=`) // vacío = sin filtro
    expect(sinNada.body.meta.total).toBe(filas.length)
    const malaCategoria = await get(`/occurrences?${q}&invoice=CASI`)
    expect(malaCategoria.status).toBe(400)
    expect(malaCategoria.body.message).toMatch(/El estado de la factura debe ser/)
    const porCliente = await get(`/occurrences?${q}&customer=${encodeURIComponent(`${prefijo} Beta`)}`)
    expect(porCliente.body.meta).toMatchObject(de(f => f.nombre === `${prefijo} Beta`))
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Con la sesión de Postgres en UTC (la de producción) y en America/Mexico_City (la de la Mac), como el bloque de arriba: `dueDate` es una
// columna `date` y un filtro o un grupo por mes no puede correrla un día según la zona. Termina en CDMX, igual que el de arriba.
describe.each(['UTC', 'America/Mexico_City'])('filtros, grupos y fechas con la sesión de Postgres en %s', zona => {
  beforeAll(() => fijarZonaDeSesion(zona))

  const CATEGORIAS: Categoria[] = ['STAMPED', 'PROBLEM', 'PENDING', 'NONE']
  const lista = (extra: Partial<OccurrenceFilters>, prefijo: string, pageSize = 100) =>
    listOccurrences({ view: 'open', q: prefijo, ...extra, pageSize }, NOW)

  it('la sesión de la base es la que se pidió (la prueba no se engaña sola)', async () => {
    const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
    expect(tz).toBe(zona)
  })

  it('12 · cada fecha cae en EXACTAMENTE una categoría de factura (some/none en Postgres) y las cuatro suman el total; coincide con un SQL escrito a mano', async () => {
    const prefijo = unico('Categorías') + '|'
    const filas = await sembrarFiltros(prefijo)
    const todo = await lista({}, prefijo)
    expect(todo.total).toBe(filas.length)
    expect(todo.sumCents).toBe(suma(filas))

    const categoriasDe = new Map<string, Categoria[]>()
    let cuenta = 0
    for (const categoria of CATEGORIAS) {
      const r = await lista({ invoice: [categoria] }, prefijo)
      const esperadas = filas.filter(f => f.categoria === categoria)
      expect(ids(r.rows)).toEqual(ids(esperadas))
      expect(r).toMatchObject({ total: esperadas.length, sumCents: suma(esperadas) })
      cuenta += r.total
      for (const fila of r.rows) categoriasDe.set(fila.id, [...(categoriasDe.get(fila.id) ?? []), categoria])
    }
    expect(cuenta).toBe(todo.total) // las cuatro suman el total: ninguna fecha se queda fuera
    expect(categoriasDe.size).toBe(filas.length)
    for (const [, categorias] of categoriasDe) expect(categorias).toHaveLength(1) // y ninguna cuenta dos veces
    // Cada categoría del conjunto está de verdad cubierta (si no, la prueba no probaría nada de ella).
    for (const categoria of CATEGORIAS) expect(filas.filter(f => f.categoria === categoria).length).toBeGreaterThanOrEqual(3)

    // Un SQL escrito a mano, con EXISTS, que NO pasa por Prisma: contesta lo mismo que la lista.
    const sql = await prisma.$queryRaw<{ id: string; categoria: string }[]>`
      SELECT o.id,
        CASE
          WHEN EXISTS (SELECT 1 FROM "PlatformCfdi" c WHERE c."platformChargeOccurrenceId" = o.id AND c.status::text IN ('STAMPED', 'CANCEL_REQUESTED')) THEN 'STAMPED'
          WHEN EXISTS (SELECT 1 FROM "PlatformCfdi" c WHERE c."platformChargeOccurrenceId" = o.id AND c.status::text IN ('STAMPING', 'STAMP_FAILED')) THEN 'PROBLEM'
          WHEN o."invoiceMode"::text = 'NONE' THEN 'NONE'
          ELSE 'PENDING'
        END AS categoria
      FROM "PlatformChargeOccurrence" o
      JOIN "PlatformCharge" ch ON ch.id = o."chargeId"
      WHERE ch."customerName" LIKE ${prefijo + '%'}`
    expect(sql).toHaveLength(filas.length)
    expect(Object.fromEntries(sql.map(r => [r.id, r.categoria]))).toEqual(Object.fromEntries(filas.map(f => [f.id, f.categoria])))

    // Varias categorías se unen con OR, sin repetir.
    const dos = await lista({ invoice: ['STAMPED', 'PROBLEM'] }, prefijo)
    const esperadasDos = filas.filter(f => f.categoria === 'STAMPED' || f.categoria === 'PROBLEM')
    expect(ids(dos.rows)).toEqual(ids(esperadasDos))
    expect(dos.total).toBe(esperadasDos.length)
  })

  it('13 · cada grupo (por cliente, mes, periodicidad y factura) cuadra en cuenta y suma con la lista filtrada por ESE grupo, y los grupos suman el total del filtro', async () => {
    const prefijo = unico('Grupos') + '|'
    const filas = await sembrarFiltros(prefijo)
    const ultimoDia = (mes: string) => new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate()
    const claveDe: Record<OccurrenceGroupBy, (f: FilaSembrada) => string> = {
      customer: f => f.nombre,
      month: f => f.dia.slice(0, 7),
      frequency: f => f.frecuencia,
      invoice: f => f.categoria,
    }
    /** El filtro que equivale a «estar en este grupo»; los extremos de mes respetan lo que el caso ya acotaba. */
    const filtroDeGrupo = (por: OccurrenceGroupBy, clave: string, caso: Partial<OccurrenceFilters>): Partial<OccurrenceFilters> => {
      if (por === 'customer') return { customer: clave }
      if (por === 'frequency') return { frequency: [clave as PlatformChargeFrequency] }
      if (por === 'invoice') return { invoice: [clave as Categoria] }
      const desde = `${clave}-01`
      const hasta = `${clave}-${String(ultimoDia(clave)).padStart(2, '0')}`
      return { from: caso.from && caso.from > desde ? caso.from : desde, to: caso.to && caso.to < hasta ? caso.to : hasta }
    }
    const casos: Array<{ nombre: string; filtros: Partial<OccurrenceFilters>; pasa: (f: FilaSembrada) => boolean }> = [
      { nombre: 'sin más filtros', filtros: {}, pasa: () => true },
      {
        nombre: 'periodicidad y fechas',
        filtros: { frequency: ['MONTHLY', 'BIWEEKLY'], from: '2026-04-01', to: '2027-12-31' },
        pasa: f => (f.frecuencia === 'MONTHLY' || f.frecuencia === 'BIWEEKLY') && f.dia >= '2026-04-01' && f.dia <= '2027-12-31',
      },
      { nombre: 'factura', filtros: { invoice: ['PROBLEM', 'NONE'] }, pasa: f => f.categoria === 'PROBLEM' || f.categoria === 'NONE' },
      { nombre: 'tipo de cliente', filtros: { customerType: ['STANDALONE'] }, pasa: f => f.tipo === 'STANDALONE' },
    ]

    for (const caso of casos) {
      const filtros = { view: 'open' as const, q: prefijo, ...caso.filtros }
      const delFiltro = filas.filter(caso.pasa)
      const total = await listOccurrences({ ...filtros, pageSize: 1 }, NOW)
      expect([caso.nombre, total.total, total.sumCents]).toEqual([caso.nombre, delFiltro.length, suma(delFiltro)])

      for (const por of Object.keys(claveDe) as OccurrenceGroupBy[]) {
        const donde = `${caso.nombre} · por ${por}`
        const { groups, truncated } = await groupOccurrences(filtros, por)

        const esperado = new Map<string, { count: number; totalCents: number }>()
        for (const f of delFiltro) {
          const g = esperado.get(claveDe[por](f)) ?? { count: 0, totalCents: 0 }
          esperado.set(claveDe[por](f), { count: g.count + 1, totalCents: g.totalCents + f.total })
        }
        expect([donde, truncated]).toEqual([donde, false])
        expect([donde, Object.fromEntries(groups.map(g => [g.key, { count: g.count, totalCents: g.totalCents }]))]).toEqual([
          donde,
          Object.fromEntries(esperado),
        ])
        // Los grupos suman EXACTAMENTE el total del filtro (nada se pierde ni se cuenta dos veces).
        expect([donde, groups.reduce((s, g) => s + g.count, 0), groups.reduce((s, g) => s + g.totalCents, 0)]).toEqual([
          donde,
          total.total,
          total.sumCents,
        ])
        // Y cada grupo cuadra con la lista filtrada por ese grupo (el clic en un grupo enseña lo que el grupo sumó).
        for (const grupo of groups) {
          const delGrupo = await listOccurrences({ ...filtros, ...filtroDeGrupo(por, grupo.key, caso.filtros), pageSize: 1 }, NOW)
          expect([donde, grupo.key, delGrupo.total, delGrupo.sumCents]).toEqual([donde, grupo.key, grupo.count, grupo.totalCents])
        }
      }
    }

    // Detalles de cada agrupación (sin más filtros).
    const todos = { view: 'open' as const, q: prefijo }
    const porCliente = (await groupOccurrences(todos, 'customer')).groups
    const alfa = porCliente.find(g => g.key === `${prefijo} Alfa`)!
    expect(alfa).toMatchObject({ label: `${prefijo} Alfa`, count: filas.filter(f => f.cobro === 'A' || f.cobro === 'D').length }) // dos cobros con el mismo nombre = un grupo
    expect(porCliente.map(g => g.label)).toEqual([...porCliente.map(g => g.label)].sort((x, y) => x.localeCompare(y, 'es')))
    const porMes = (await groupOccurrences(todos, 'month')).groups
    expect(porMes.map(g => g.key)).toEqual([...porMes.map(g => g.key)].sort()) // de más viejo a más nuevo
    expect(porMes.find(g => g.key === '2026-01')!.label).toBe('enero 2026')
    expect(porMes.find(g => g.key === '2028-02')!.label).toBe('febrero 2028')
    const porPeriodicidad = (await groupOccurrences(todos, 'frequency')).groups
    expect(Object.fromEntries(porPeriodicidad.map(g => [g.key, g.label]))).toEqual({
      MONTHLY: 'Mensual',
      WEEKLY: 'Semanal',
      BIWEEKLY: 'Quincenal',
      ONE_TIME: 'Una sola vez',
    })
    await expect(groupOccurrences(todos, 'dia' as OccurrenceGroupBy)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PLATFORM_CHARGE_INVALID_GROUP_BY',
    })
  })

  it('14 · «desde» y «hasta» (los dos extremos incluidos) y el grupo por mes: el último día del mes cae en su mes, también el 29 de un año bisiesto, y la fecha guardada no se corre un día', async () => {
    const prefijo = unico('Fechas') + '|'
    const filas = await sembrarFiltros(prefijo)

    const rangos: Array<[string | undefined, string | undefined]> = [
      ['2026-02-01', '2026-02-28'], // un mes entero, de su día 1 a su último día
      ['2026-01-31', '2026-01-31'], // un solo día: el último de enero
      [undefined, '2026-01-31'], // sólo «hasta», en el último día de enero
      ['2028-02-29', undefined], // sólo «desde», en el 29 de un año bisiesto
      ['2026-12-31', '2027-01-01'], // el cambio de año
      ['2026-03-01', '2026-03-01'], // el primer día de marzo no es del 28 de febrero
      ['2027-01-01', undefined],
    ]
    for (const [desde, hasta] of rangos) {
      const donde = `${desde ?? '…'} → ${hasta ?? '…'}`
      const r = await lista({ ...(desde ? { from: desde } : {}), ...(hasta ? { to: hasta } : {}) }, prefijo)
      const esperadas = filas.filter(f => (!desde || f.dia >= desde) && (!hasta || f.dia <= hasta))
      expect([donde, ids(r.rows)]).toEqual([donde, ids(esperadas)])
      expect([donde, r.total, r.sumCents]).toEqual([donde, esperadas.length, suma(esperadas)])
      expect(esperadas.length).toBeGreaterThan(0) // el rango toca algo: la prueba no pasa «por vacía»
    }
    expect((await lista({ from: '2026-01-31', to: '2026-01-31' }, prefijo)).rows.map(r => r.dueDate)).toEqual(['2026-01-31'])
    expect((await lista({ from: '2026-02-01', to: '2026-02-28' }, prefijo)).rows.map(r => r.dueDate)).toEqual(['2026-02-15', '2026-02-28'])

    // Por mes: lo de cada fin de mes cae en SU mes (con la oracle escrita a mano de arriba y con los números a la vista).
    const { groups } = await groupOccurrences({ view: 'open', q: prefijo }, 'month')
    const porMes = Object.fromEntries(groups.map(g => [g.key, g.count]))
    expect(porMes).toMatchObject({ '2026-01': 2, '2026-02': 2, '2026-03': 2, '2026-12': 2, '2027-01': 2, '2028-02': 1 })
    const esperadoPorMes = new Map<string, number>()
    for (const f of filas) esperadoPorMes.set(f.dia.slice(0, 7), (esperadoPorMes.get(f.dia.slice(0, 7)) ?? 0) + 1)
    expect(porMes).toEqual(Object.fromEntries(esperadoPorMes))

    // La fecha guardada es la del calendario, sea cual sea la zona de la sesión: leída con SQL (como texto) y por la lista.
    const guardadas = await prisma.$queryRaw<{ id: string; dia: string }[]>`
      SELECT o.id, to_char(o."dueDate", 'YYYY-MM-DD') AS dia
      FROM "PlatformChargeOccurrence" o JOIN "PlatformCharge" ch ON ch.id = o."chargeId"
      WHERE ch."customerName" LIKE ${prefijo + '%'}`
    expect(Object.fromEntries(guardadas.map(g => [g.id, g.dia]))).toEqual(Object.fromEntries(filas.map(f => [f.id, f.dia])))
    const todas = await lista({}, prefijo)
    expect(Object.fromEntries(todas.rows.map(r => [r.id, r.dueDate]))).toEqual(Object.fromEntries(filas.map(f => [f.id, f.dia])))

    // «Desde» después de «hasta», y un día que no existe, son 400 también aquí (no los decide la zona).
    await expect(lista({ from: '2026-12-01', to: '2026-01-01' }, prefijo)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PLATFORM_CHARGE_INVALID_DATE_RANGE',
    })
    await expect(lista({ to: '2026-02-30' }, prefijo)).rejects.toMatchObject({ statusCode: 400, code: 'PLATFORM_CHARGE_INVALID_DATE' })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// La auditoría r2 de anexar (docs/audit/2026-11-03-por-cobrar-anexar/codex-r2.md): cada hallazgo, contra Postgres real y con sus cruces observados.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('16 · auditoría r2 de anexar: confirmar el importe, quitar la factura confirmada, lo que no cabe, el complemento y «una sola vez»', () => {
  const UN_CONCEPTO: ChargeConcept[] = [
    { description: 'Venta de equipo', amountCents: 20000, ivaMode: 'WITHOUT_IVA', satProductKey: '43211509', satUnitKey: 'H87' },
  ]
  const TOTAL_DEL_CONCEPTO = 23200 // 20,000 + 3,200 de IVA, a mano

  /** Los complementos que `registerPlatformPayment` dejó sobre una factura; se anotan para que la limpieza final también los borre. */
  async function complementosDe(facturaId: string) {
    const filas = await prisma.platformCfdi.findMany({ where: { parentPlatformCfdiId: facturaId }, take: 20 })
    creado.cfdis.push(...filas.map(f => f.id))
    return filas
  }
  const pagoDe = (platformCfdiId: string) => ({
    platformCfdiId,
    paymentDate: '2026-11-02T12:00:00',
    formaPago: '03',
    idempotencyKey: unico('pago'),
    performedById: superId,
  })

  beforeEach(() => {
    Object.assign(pac, {
      createPaymentComplement: jest.fn(async () => ({
        providerInvoiceId: `fa-rep-${++consecutivo}`,
        uuid: `UUID-REP-${suffix}-${consecutivo}`,
        folio: '9',
        stampedAt: new Date(),
      })),
    })
  })

  describe('1 · «Ya me pagó» confirma el importe que se vio', () => {
    it('otra pestaña anexa una factura de OTRO monto mientras «Ya me pagó» espera el candado: 409 con el monto nuevo y la fecha sigue PENDIENTE', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha() // $1,079.00 es lo que el operador vio
      const factura = await nuevaFactura({}, UN_CONCEPTO) // $232.00
      const aparcada = aparcarLaTransaccion(1)
      let pagado: unknown
      try {
        const anexando = linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
        anexando.catch(() => undefined)
        const pid = await aTiempo(aparcada.pid, 60_000, 'anexar escribió la fecha y quedó aparcado con el candado, sin commit')

        const pagando = payOccurrence(fecha.id, { invoice: false, expectedTotalCents: TOTAL }, superId, NOW)
        pagando.catch(() => undefined)
        await esperaElCandado(pid) // «Ya me pagó» llegó segundo: espera el candado del cobro
        aparcada.soltar()

        await anexando
        pagado = await pagando.then(
          () => 'se marcó pagado',
          error => error,
        )
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect(pagado).toMatchObject({
        statusCode: 409,
        code: 'PLATFORM_CHARGE_OCCURRENCE_TOTAL_CHANGED',
        message: 'El monto de este cobro cambió a $232.00; revísalo y confirma otra vez',
      })
      expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({
        status: 'PENDING',
        paidAt: null,
        paidById: null,
        totalCents: TOTAL_DEL_CONCEPTO,
      })
      expect(await prisma.activityLog.count({ where: { action: 'PLATFORM_CHARGE_PAID', entityId: cobro.id } })).toBe(0)
    })

    it('por HTTP: con el total viejo es 409; con el nuevo marca pagado; repetir con el viejo sobre la ya pagada es éxito; un total mal formado es 400', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha()
      const factura = await nuevaFactura({}, UN_CONCEPTO)
      await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)

      const viejo = await post(`/occurrences/${fecha.id}/pay`, { invoice: false, expectedTotalCents: TOTAL })
      expect(viejo.status).toBe(409)
      expect(viejo.body).toMatchObject({ code: 'PLATFORM_CHARGE_OCCURRENCE_TOTAL_CHANGED' })
      expect(viejo.body.message).toBe('El monto de este cobro cambió a $232.00; revísalo y confirma otra vez')
      expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PENDING')

      expect((await post(`/occurrences/${fecha.id}/pay`, { invoice: false, expectedTotalCents: -5 })).status).toBe(400)
      expect((await post(`/occurrences/${fecha.id}/pay`, { invoice: false, expectedTotalCents: 10.5 })).status).toBe(400)
      expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PENDING')

      const nuevo = await post(`/occurrences/${fecha.id}/pay`, { invoice: false, expectedTotalCents: TOTAL_DEL_CONCEPTO })
      expect(nuevo.status).toBe(200)
      expect(nuevo.body.data.occurrence).toMatchObject({ status: 'PAID', totalCents: TOTAL_DEL_CONCEPTO })

      const repetido = await post(`/occurrences/${fecha.id}/pay`, { invoice: false, expectedTotalCents: TOTAL })
      expect(repetido.status).toBe(200) // repetir sobre una pagada sigue siendo éxito
      expect(repetido.body.data.occurrence.status).toBe('PAID')
      expect(await bitacoras('PLATFORM_CHARGE_PAID', cobro.id, 1)).toHaveLength(1)
    })

    it('sin el campo, igual que siempre (los clientes viejos no lo mandan)', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha()

      const res = await post(`/occurrences/${fecha.id}/pay`, { invoice: false })

      expect(res.status).toBe(200)
      expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PAID')
    })
  })

  describe('2 · quitar suelta SÓLO la factura confirmada', () => {
    it('la pestaña vieja confirma «Quitar A» cuando otra ya quitó A y está anexando B (con el candado tomado): 409 «no anexada», B sigue anexada y nadie la soltó', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha()
      const a = await nuevaFactura()
      const b = await nuevaFactura()
      await linkInvoice(fecha.id, { cfdiId: a.id }, superId, NOW)
      await unlinkInvoice(fecha.id, { cfdiId: a.id }, superId, NOW) // la otra pestaña quitó A…
      const aparcada = aparcarLaTransaccion(1)
      let confirmada: unknown
      try {
        const anexando = linkInvoice(fecha.id, { cfdiId: b.id }, superId, NOW) // …y está anexando B
        anexando.catch(() => undefined)
        const pid = await aTiempo(aparcada.pid, 60_000, 'anexar B escribió su vínculo y quedó aparcado con el candado, sin commit')

        const quitandoA = unlinkInvoice(fecha.id, { cfdiId: a.id }, superId, NOW) // la pestaña vieja confirma
        quitandoA.catch(() => undefined)
        await esperaElCandado(pid)
        aparcada.soltar()

        await anexando
        confirmada = await quitandoA.then(
          () => 'quitó algo',
          error => error,
        )
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect(confirmada).toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_NOT_LINKED' })
      const fila = await facturaDe(b.id)
      expect(fila.platformChargeOccurrenceId).toBe(fecha.id) // B sigue en su fecha…
      expect(fila.chargeLinkedAt).not.toBeNull() // …y anexada: con el código viejo la habría soltado
      expect(await facturaDe(a.id)).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
      const quitadas = await bitacoras('PLATFORM_CHARGE_INVOICE_UNLINKED', cobro.id, 1)
      expect(quitadas).toHaveLength(1) // sólo la primera: la tardía no dejó rastro de haber quitado nada
      expect(quitadas[0].data).toMatchObject({ platformCfdiId: a.id })
    })

    it('por HTTP: sin ?cfdiId es 400; con la factura confirmada la quita; con otra factura (de otra fecha) es 409 y no toca nada', async () => {
      const uno = await cobroDeUnaFecha()
      const otro = await cobroDeUnaFecha()
      const delUno = await nuevaFactura()
      const delOtro = await nuevaFactura()
      await linkInvoice(uno.fecha.id, { cfdiId: delUno.id }, superId, NOW)
      await linkInvoice(otro.fecha.id, { cfdiId: delOtro.id }, superId, NOW)

      expect((await del(`/occurrences/${uno.fecha.id}/invoice-link`)).status).toBe(400)
      const ajena = await del(`/occurrences/${uno.fecha.id}/invoice-link?cfdiId=${delOtro.id}`)
      expect(ajena.status).toBe(409)
      expect(ajena.body).toMatchObject({ code: 'PLATFORM_CHARGE_INVOICE_NOT_LINKED' })
      expect((await facturaDe(delOtro.id)).platformChargeOccurrenceId).toBe(otro.fecha.id)
      expect((await facturaDe(delUno.id)).platformChargeOccurrenceId).toBe(uno.fecha.id)

      expect((await del(`/occurrences/${uno.fecha.id}/invoice-link?cfdiId=${delUno.id}`)).status).toBe(200)
      expect((await facturaDe(delUno.id)).platformChargeOccurrenceId).toBeNull()
    })
  })

  describe('3 · una factura que no cabe en el modelo del 16 % no se anexa NUNCA, ni con el mismo total', () => {
    it('un renglón exento de $100 a una fecha de $100, pendiente o ya pagada: 409 NOT_REPRESENTABLE y no se escribe nada', async () => {
      const cien: ChargeConcept[] = [{ ...LICENCIA, amountCents: 10000 }] // con IVA incluido: $100.00 en total
      const exenta = () =>
        nuevaFactura({
          lines: [
            {
              description: 'Renglón exento',
              satProductKey: '81112501',
              satUnitKey: 'E48',
              quantity: 1,
              unitPriceCents: 10000,
              taxExempt: true,
            },
          ] as unknown as Prisma.InputJsonValue,
          subtotalCents: 10000,
          taxCents: 0,
          totalCents: 10000,
        })

      for (const pagada of [false, true]) {
        const { cobro, fecha } = await cobroDeUnaFecha({ concepts: cien })
        expect((await porFecha(cobro.id, '2026-11-02')).totalCents).toBe(10000) // el MISMO total que la factura
        if (pagada) await payOccurrence(fecha.id, { invoice: false }, superId, NOW)
        const antes = await porFecha(cobro.id, '2026-11-02')
        const factura = await exenta()

        await expect(linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)).rejects.toMatchObject({
          statusCode: 409,
          code: 'PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE',
        })

        expect(await facturaDe(factura.id)).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
        expect(await porFecha(cobro.id, '2026-11-02')).toEqual(antes) // ni la fecha ni su modo cambiaron
        expect(await prisma.activityLog.count({ where: { action: 'PLATFORM_CHARGE_INVOICE_LINKED', entityId: cobro.id } })).toBe(0)
      }
    })
  })

  describe('4 · un complemento de pago no pasa sobre una factura anexada a un cobro sin pagar (reserva del complemento contra anexar)', () => {
    const anexadaVigente = (facturaId: string) =>
      facturaDe(facturaId).then(f => ({ fecha: f.platformChargeOccurrenceId, marca: f.chargeLinkedAt }))

    it('la RESERVA del complemento primero, detenida con la fila del padre tomada: anexar espera esa fila, ve que la versión cambió y recibe 409 «acaba de cambiar»; la factura queda libre', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha()
      const padre = await nuevaFactura({ metodoPago: 'PPD' })
      const aparcada = aparcarLaTransaccion(1) // la transacción 1 de registerPlatformPayment es la RESERVA (toca al padre y crea la fila STAMPING)
      let complemento: Promise<unknown> | undefined
      try {
        complemento = registerPlatformPayment(pagoDe(padre.id))
        complemento.catch(() => undefined)
        const pid = await aTiempo(aparcada.pid, 60_000, 'la reserva tocó al padre y creó su fila STAMPING, sin commit')

        // Anexar lee al padre con la versión de antes (la reserva no confirmó), no ve ningún complemento y llega a su UPDATE condicional.
        const anexando = linkInvoice(fecha.id, { cfdiId: padre.id }, superId, NOW)
        anexando.catch(() => undefined)
        await esperaLaFila(pid) // el cruce SE PROVOCÓ: el UPDATE de anexar espera la fila del padre
        aparcada.soltar()

        await complemento
        await expect(anexando).rejects.toMatchObject({ statusCode: 409, code: 'PLATFORM_CHARGE_INVOICE_LINK_CHANGED' })
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect(await anexadaVigente(padre.id)).toEqual({ fecha: null, marca: null })
      expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({ status: 'PENDING', invoiceMode: 'AUTOMATIC', totalCents: TOTAL })
      const reps = await complementosDe(padre.id)
      expect(reps).toHaveLength(1)
      expect(reps[0]).toMatchObject({ type: 'PAGO', status: 'STAMPED' })
      expect((await facturaDe(padre.id)).amountPaidCents).toBe(TOTAL)
    })

    it('ANEXAR primero, detenido con la fila del padre tomada: la reserva espera (su UPDATE toca al padre), ve el vínculo ya escrito y recibe 409; no hay fila de complemento ni PAC', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha()
      const padre = await nuevaFactura({ metodoPago: 'PPD' })
      const aparcada = aparcarLaTransaccion(1)
      let complemento: Promise<unknown> | undefined
      try {
        const anexando = linkInvoice(fecha.id, { cfdiId: padre.id }, superId, NOW)
        anexando.catch(() => undefined)
        const pid = await aTiempo(
          aparcada.pid,
          60_000,
          'anexar escribió el vínculo y quedó aparcado con la fila del padre tomada, sin commit',
        )

        // El complemento lee al padre sin vínculo (anexar no confirmó) y entra a su reserva, donde el UPDATE que lo toca espera la fila.
        complemento = registerPlatformPayment(pagoDe(padre.id))
        complemento.catch(() => undefined)
        await esperaLaFila(pid)
        aparcada.soltar()

        await anexando
        await expect(complemento).rejects.toMatchObject({
          code: 'VALIDATION',
          message:
            'Esta factura está anexada a un cobro sin pagar en «Por cobrar». Márcalo como pagado primero y después registra el complemento',
        })
      } finally {
        aparcada.soltar()
        aparcada.restaurar()
      }

      expect(await complementosDe(padre.id)).toHaveLength(0) // la reserva no dejó fila
      expect((pac as unknown as { createPaymentComplement: jest.Mock }).createPaymentComplement).not.toHaveBeenCalled()
      expect((await anexadaVigente(padre.id)).fecha).toBe(fecha.id)
      expect((await facturaDe(padre.id)).amountPaidCents).toBe(0)
      expect((await porFecha(cobro.id, '2026-11-02')).status).toBe('PENDING')

      // Y con la fecha ya pagada, el complemento sí pasa: el cobro dejó de deberse.
      await payOccurrence(fecha.id, { invoice: false }, superId, NOW)
      const rep = await registerPlatformPayment(pagoDe(padre.id))
      expect(rep.status).toBe('STAMPED')
      expect(await complementosDe(padre.id)).toHaveLength(1)
    })

    it('una factura sin vínculo, y una timbrada desde «Por cobrar» (sin marca de anexada), reciben su complemento como siempre', async () => {
      const { fecha } = await cobroDeUnaFecha()
      const sinVinculo = await nuevaFactura({ metodoPago: 'PPD' })
      const desdeAqui = await nuevaFactura({ metodoPago: 'PPD', platformChargeOccurrenceId: fecha.id })

      expect((await registerPlatformPayment(pagoDe(sinVinculo.id))).status).toBe('STAMPED')
      expect((await registerPlatformPayment(pagoDe(desdeAqui.id))).status).toBe('STAMPED')
      await complementosDe(sinVinculo.id)
      await complementosDe(desdeAqui.id)
    })
  })

  describe('5 · una sola vez: el cobro y su única fecha dicen lo mismo', () => {
    it('anexar otra factura de otro monto y quitarla: getCharge y la fecha coinciden; editar sólo la fecha los conserva', async () => {
      const cobro = await nuevoCobro({ frequency: 'ONE_TIME', anchorDate: '2026-11-02', invoiceMode: 'AUTOMATIC' }) // [RENTA, LICENCIA] = $1,079.00
      const fecha = await porFecha(cobro.id, '2026-11-02')
      const factura = await nuevaFactura({}, UN_CONCEPTO)

      await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
      const anexado = await getCharge(cobro.id)
      expect(anexado.concepts).toEqual(UN_CONCEPTO) // el editor carga esto: ya no son los $1,079.00 del alta
      expect(anexado.invoiceMode).toBe('MANUAL')
      expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({
        concepts: UN_CONCEPTO,
        totalCents: TOTAL_DEL_CONCEPTO,
        invoiceMode: 'MANUAL',
      })

      await unlinkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
      const quitado = await getCharge(cobro.id)
      expect(quitado.concepts).toEqual(UN_CONCEPTO)
      expect(quitado.invoiceMode).toBe('MANUAL')
      expect(await porFecha(cobro.id, '2026-11-02')).toMatchObject({
        concepts: UN_CONCEPTO,
        totalCents: TOTAL_DEL_CONCEPTO,
        invoiceMode: 'MANUAL',
      })

      // Editar sólo la fecha: la fecha conserva su monto y el cobro sigue diciendo lo mismo.
      await updateCharge(cobro.id, { anchorDate: '2026-11-03' }, superId, NOW)
      expect(await porFecha(cobro.id, '2026-11-03')).toMatchObject({ id: fecha.id, concepts: UN_CONCEPTO, totalCents: TOTAL_DEL_CONCEPTO })
      expect((await getCharge(cobro.id)).concepts).toEqual(UN_CONCEPTO)
      // Guardar lo que el editor mostró no cambia nada: ya coincide con el cobro.
      await updateCharge(cobro.id, { concepts: (await getCharge(cobro.id)).concepts as unknown as ChargeConcept[] }, superId, NOW)
      expect(await porFecha(cobro.id, '2026-11-03')).toMatchObject({ concepts: UN_CONCEPTO, totalCents: TOTAL_DEL_CONCEPTO })
    })

    it('un cobro recurrente conserva lo suyo: el vínculo es de esa fecha', async () => {
      const { cobro, fecha } = await cobroDeUnaFecha() // MONTHLY, AUTOMATIC
      const factura = await nuevaFactura({}, UN_CONCEPTO)

      await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)

      const intacto = await getCharge(cobro.id)
      expect(intacto.invoiceMode).toBe('AUTOMATIC')
      expect(intacto.concepts).toEqual([RENTA, LICENCIA])
    })
  })

  describe('6 · la confirmación de un complemento y su reintento con la MISMA llave no se esperan en cruz (Codex r3, hallazgo 1)', () => {
    it('la confirmación a media transacción con su primer UPDATE hecho, y el reintento detrás: uno espera al otro, nadie se aborta, el complemento queda STAMPED y el padre suma UNA vez', async () => {
      const padre = await nuevaFactura({ metodoPago: 'PPD' })
      const entrada = pagoDe(padre.id) // la misma llave para las dos peticiones
      const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>
      const soltarReintento = diferido<void>()
      const llegoElReintento = diferido<void>()
      const soltarConfirmacion = diferido<void>()
      const pidDeLaConfirmacion = diferido<number>()
      let vistas = 0
      // Sólo la prueba espía `prisma.$transaction` (nada en producción): 1 = la reserva del REINTENTO, que se detiene ANTES de empezar (ya pasó su
      // consulta de «¿ya existe esa llave?»); 2 = la reserva de la confirmación; 3 = su confirmación después del PAC, que se detiene DESPUÉS de su primer UPDATE.
      const espia = jest.spyOn(prisma, '$transaction').mockImplementation((async (arg: unknown, opciones?: Record<string, unknown>) => {
        if (typeof arg !== 'function') return original(arg, opciones)
        vistas += 1
        const abiertas = { ...(opciones ?? {}), timeout: 60_000, maxWait: 60_000 }
        if (vistas === 1) {
          llegoElReintento.resolver()
          await soltarReintento.promesa
          return original(arg, abiertas)
        }
        if (vistas !== 3) return original(arg, abiertas)
        const cuerpo = arg as (tx: any) => Promise<unknown>
        return original(async (tx: any) => {
          let escrituras = 0
          const modelo = new Proxy(tx.platformCfdi, {
            get(destino, nombre) {
              const valor = destino[nombre]
              if (nombre !== 'update') return typeof valor === 'function' ? valor.bind(destino) : valor
              return async (...args: unknown[]) => {
                const resultado = await destino.update(...args)
                escrituras += 1
                if (escrituras === 1) {
                  const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
                  pidDeLaConfirmacion.resolver(Number(pid))
                  await soltarConfirmacion.promesa
                }
                return resultado
              }
            },
          })
          return cuerpo(new Proxy(tx, { get: (destino, nombre) => (nombre === 'platformCfdi' ? modelo : destino[nombre]) }))
        }, abiertas)
      }) as never)

      let resultados: PromiseSettledResult<unknown>[] = []
      try {
        const reintento = registerPlatformPayment(entrada)
        reintento.catch(() => undefined)
        await aTiempo(llegoElReintento.promesa, 60_000, 'el reintento leyó todo y está por reservar')

        const confirmacion = registerPlatformPayment(entrada)
        confirmacion.catch(() => undefined)
        const pid = await aTiempo(
          pidDeLaConfirmacion.promesa,
          60_000,
          'la confirmación timbró y quedó a media transacción, con su primer UPDATE hecho',
        )

        soltarReintento.resolver()
        // El reintento llegó a su reserva y alguien lo bloquea: la confirmación (con el padre tomado, o con el complemento tomado si el orden fuera el otro).
        const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /(UPDATE|INSERT) .*"PlatformCfdi"/, ms: 60_000 })
        expect(espera).not.toBeNull() // el cruce SE PROVOCÓ
        expect(espera!.waitEventType).toBe('Lock')
        soltarConfirmacion.resolver()

        resultados = await aTiempo(
          Promise.allSettled([confirmacion, reintento]),
          90_000,
          'las dos peticiones terminaron (o Postgres abortó una)',
        )
      } finally {
        soltarReintento.resolver()
        soltarConfirmacion.resolver()
        espia.mockRestore()
      }

      const [confirmada, reintentada] = resultados as [
        PromiseSettledResult<{ id: string; status: string }>,
        PromiseSettledResult<{ id: string; status: string }>,
      ]
      expect([confirmada.status, reintentada.status]).toEqual(['fulfilled', 'fulfilled']) // con el orden cruzado, Postgres aborta una (deadlock)
      expect((confirmada as PromiseFulfilledResult<{ id: string; status: string }>).value.status).toBe('STAMPED')
      expect((reintentada as PromiseFulfilledResult<{ id: string; status: string }>).value.id).toBe(
        (confirmada as PromiseFulfilledResult<{ id: string; status: string }>).value.id,
      ) // el reintento devuelve la fila que ya existe

      const filas = await prisma.platformCfdi.findMany({ where: { idempotencyKey: entrada.idempotencyKey }, take: 5 })
      creado.cfdis.push(...filas.map(f => f.id))
      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({ type: 'PAGO', status: 'STAMPED', parentPlatformCfdiId: padre.id })
      expect(filas[0].uuid).not.toBeNull()
      expect((await facturaDe(padre.id)).amountPaidCents).toBe(TOTAL) // el padre suma UNA vez, aunque el PAC sí timbró
      expect((pac as unknown as { createPaymentComplement: jest.Mock }).createPaymentComplement).toHaveBeenCalledTimes(1)
    })
  })

  describe('7 · una sola vez pagado SIN timbrar: anexar, quitar y «Deshacer» no reviven el modo anterior (Codex r3, hallazgo 2)', () => {
    it('la fecha ya es MANUAL y el cobro AUTOMATIC: anexar una factura del MISMO total alinea el cobro; tras quitar y deshacer, los dos siguen en MANUAL', async () => {
      const cobro = await nuevoCobro({ frequency: 'ONE_TIME', anchorDate: '2026-11-02', invoiceMode: 'AUTOMATIC' })
      const fecha = await porFecha(cobro.id, '2026-11-02')
      const factura = await nuevaFactura() // [RENTA, LICENCIA]: el mismo total que la fecha
      await payOccurrence(fecha.id, { invoice: false }, superId, NOW)
      expect((await porFecha(cobro.id, '2026-11-02')).invoiceMode).toBe('MANUAL')
      expect((await getCharge(cobro.id)).invoiceMode).toBe('AUTOMATIC')

      await linkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
      expect((await getCharge(cobro.id)).invoiceMode).toBe('MANUAL') // la fecha no cambió, y aun así el cobro se alineó

      await unlinkInvoice(fecha.id, { cfdiId: factura.id }, superId, NOW)
      await reopenOccurrence(fecha.id, superId, NOW)

      const fechaFinal = await porFecha(cobro.id, '2026-11-02')
      const cobroFinal = await getCharge(cobro.id)
      expect(fechaFinal).toMatchObject({ status: 'PENDING', invoiceMode: 'MANUAL', totalCents: TOTAL })
      expect(cobroFinal.invoiceMode).toBe('MANUAL') // el editor y la fecha dicen lo mismo
      expect(cobroFinal.concepts).toEqual(fechaFinal.concepts)
    })
  })
})
