import crypto from 'crypto'
import {
  Prisma,
  type CardBrand,
  type CfdiCancelStatus,
  type CfdiStatus,
  type CfdiType,
  type OrderStatus,
  type OrderType,
  type PaymentMethod,
  type PaymentStatus,
  type ReservationStatus,
  type SettlementDayType,
  type StaffRole,
  type SupportConversation,
  type TenderSystemKind,
  type TransactionCardType,
  type TransactionStatus,
} from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { aiInput } from '@tests/__helpers__/supportAiInput'
import logger from '@/config/logger'
import { DEFAULT_PERMISSIONS, expandWildcards, resolvePermissions } from '@/lib/permissions'
import { legacyPool } from '@/services/legacy/legacyPool'
import { venueWeekBounds } from '@/services/dashboard/settlementCalendar.dashboard.service'
import type { DataCapability, DataRequest } from '@/services/support/data/catalog'
import { template } from '@/services/support/data/check'
import { grantDataAccess } from '@/services/support/data/consent.service'
import { fmtDate, fmtMoney } from '@/services/support/data/format'
import { lastDaysStart, matchAmount, wholeDayBounds } from '@/services/support/data/params'
import { safeDbText, strictDbText } from '@/services/support/data/sanitize'
import * as dataTexts from '@/services/support/data/texts'
import { supportDataNoticeHash } from '@/services/support/data/texts'
import { deepFreeze } from '@/utils/deepFreeze'
import { venueDayKey } from '@/utils/venueDateKeys'
import { LUNA_SUPPORT_PRICING, getSupportAiConfig } from '@/config/supportWhatsapp'
import { createSupportAiClient } from '@/services/support/answer.service'
import type { LibraryGuide } from '@/services/support/knowledge.service'

/**
 * «Cambió el texto del aviso» (un deploy con otro aviso). T-B44: el aviso nace congelado, así que la prueba cambia la constante del
 * módulo por otra, congelada también; `jest.restoreAllMocks()` la regresa.
 */
export const changeSupportDataNotice = (es: string, en: string) =>
  jest.replaceProperty(dataTexts, 'SUPPORT_DATA_NOTICE', deepFreeze({ es, en }))

/** La capacidad de mentira de las tareas 6 a 11. Lleva sus tipos concretos, igual que las ocho de verdad. */
export const fakeCapability: DataCapability<{ amount: Prisma.Decimal }, { total: number; name: string }> = {
  key: 'fake',
  label: 'dato de prueba',
  object: 'el dato de prueba',
  aiHint: 'Dato de prueba: un monto que la persona escribe.',
  permissions: ['reports:read'],
  gate: { featureCode: 'RESERVATIONS', gateKind: 'FEATURE', refusal: 'PLAN_RESERVATIONS' },
  params: (request, message) => {
    const amount = matchAmount(message, request.amount)
    return amount ? { ok: true, value: { amount } } : { ok: false, refusal: 'PARAM_AMOUNT' }
  },
  read: () => Promise.resolve({ total: 12345.6, name: 'Mesa 12' }),
  render: (scope, _params, result) => {
    const t = template(scope.timezone)
    return t.done(
      `Dato de prueba en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}): ${t.money(result.total)} en ${t.text(result.name)}`,
    )
  },
}

// ─── La siembra de la B (Task 7): una persona, tres sucursales, su vínculo y el interruptor prendido ──────────────────────
// Y dos sucursales a las que la persona NO tiene acceso, para la cerca de datos ajenos (T-B38): una de su organización y una de otra.

export interface DataFixture {
  staffId: string
  orgId: string
  northId: string // Norte: America/Mexico_City
  cancunId: string // Cancún: America/Cancun, otra zona (las pruebas de vigencia la usan)
  /**
   * Sur: America/Mexico_City, la MISMA zona que Norte, la hermana y la ajena. Ninguna siembra escribe aquí: es la pierna sin datos de
   * la cerca (T-B38c). En otra zona, su ventana para la misma pregunta («a las 14:30») caería en otra hora y ninguna siembra entraría,
   * así que no vería un «primero que encuentre» sin filtro de sucursal (R3-1).
   */
  emptyId: string
  siblingId: string // Hermana: de la MISMA organización, sin acceso de la persona
  foreignId: string // Ajena: de OTRA organización
  linkId: string // el vínculo vigente; reset() lo cambia
  /** PERSONAL, con sucursal y aviso general aceptado. La misma plática por sucursal hasta reset(), releída de la base. */
  conversation(venueId?: string): Promise<SupportConversation>
  /** Toca «Aceptar» en la ventana del aviso: grantDataAccess con la huella vigente y acceptNotice (acepta y desbloquea). */
  unlock(venueId?: string): Promise<void>
  /** «Aceptó ayer y hoy no ha tocado»: unlock() y luego su `day` a '2000-01-01'. */
  accept(): Promise<void>
  /**
   * Exactamente estos permisos (más lo que implican), este puesto y estas funciones del plan, en las sucursales de la persona.
   * asPermissionSet: los permisos van en un PermissionSet de la sucursal; si no, en VenueRolePermission del puesto.
   * `features` NO acepta PLAN_PRO ni PLAN_PREMIUM (lanza): la fila del plan entra sólo por `seedPlanRow`, con sus fechas. Una que
   * sobrara abriría los candados de nivel (`venueHasFeatureAccess` cae en `elPlanConcede`). Las que ya hay, `grant` las deja.
   */
  grant(g: { permissions: string[]; role?: StaffRole; features?: string[]; asPermissionSet?: boolean }): Promise<void>
  /** Todo como recién sembrado: vínculo, StaffVenue, membresía, permisos, plan, zona, verificación; sin aceptación, desbloqueos ni registro. */
  reset(): Promise<void>
  clean(): Promise<void>
}

/** Las funciones del plan de las sucursales de la persona al sembrar. Cada tarea C agrega el código del candado de su pantalla. */
const SEEDED_FEATURES = ['RESERVATIONS']
/**
 * C5: las filas del plan de Avoqado (PLAN_PRO y PLAN_PREMIUM, las que lee «Tu plan»). Sólo entran por `seedPlanRow`: `grant` cambia las
 * funciones y las deja (el barrido siembra antes o después de `grant`), y en las sucursales de la persona sólo `reset` las borra.
 */
const PLAN_CODES = ['PLAN_PRO', 'PLAN_PREMIUM']
const PLAN_ROWS = { feature: { code: { in: PLAN_CODES } } }
const SEEDED_ROLE: StaffRole = 'MANAGER'
const DAY_MS = 86_400_000

/** Lo que el puesto trae de fábrica, abierto, menos lo que se quiere dar: así la persona queda con `keep` y lo que implica. */
function deniedFor(role: StaffRole, keep: string[]): string[] {
  const defaults = DEFAULT_PERMISSIONS[role] ?? []
  const all = new Set([...defaults, ...resolvePermissions(defaults)])
  return [...new Set([...all, ...expandWildcards([...all])])].filter(p => !keep.includes(p))
}

/** Persona MANAGER en sus tres sucursales, con su StaffOrganization MEMBER activa y vínculo vigente; prende soporte, híbrido y B. */
export async function seedDataFixture(tag: string): Promise<DataFixture> {
  const suffix = `${tag}-${Date.now()}`
  const digits = String(parseInt(crypto.createHash('sha256').update(suffix).digest('hex').slice(0, 12), 16) % 100_000_000)
  const phone = `+5255${digits.padStart(8, '0')}`
  const receiverId = `support-data-${suffix}`
  const env: Record<string, string> = {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales-only',
    SUPPORT_WHATSAPP_FREE_TEXT_ENABLED: 'true',
    SUPPORT_WHATSAPP_HYBRID_ENABLED: 'true',
    SUPPORT_DATA_ENABLED: 'true',
  }
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)

  const orgId = (await prisma.organization.create({ data: { name: suffix, email: `${suffix}@test.local`, phone: '0000000000' } })).id
  const venue = (name: string, slug: string, timezone: string) =>
    prisma.venue.create({
      data: { organizationId: orgId, name, slug: `${suffix}-${slug}`, status: 'ACTIVE', timezone, kycStatus: 'VERIFIED' },
    })
  const northId = (await venue('Norte', 'norte', 'America/Mexico_City')).id
  const cancunId = (await venue('Cancún', 'cancun', 'America/Cancun')).id
  const emptyId = (await venue('Sur', 'sur', 'America/Mexico_City')).id
  const venues = [northId, cancunId, emptyId]
  const siblingId = (await venue('Hermana', 'hermana', 'America/Mexico_City')).id
  const foreignOrgId = (
    await prisma.organization.create({ data: { name: `${suffix}-ajena`, email: `ajena-${suffix}@test.local`, phone: '0000000000' } })
  ).id
  const foreignId = (
    await prisma.venue.create({
      data: {
        organizationId: foreignOrgId,
        name: 'Ajena',
        slug: `${suffix}-ajena`,
        status: 'ACTIVE',
        timezone: 'America/Mexico_City',
        kycStatus: 'VERIFIED',
      },
    })
  ).id
  const staffId = (
    await prisma.staff.create({
      data: { email: `${suffix}@test.local`, firstName: 'Datos', lastName: 'Prueba', phone, emailVerified: true },
    })
  ).id
  await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER' } })
  await prisma.staffVenue.createMany({ data: venues.map(venueId => ({ staffId, venueId, role: SEEDED_ROLE })) })
  const conversations = new Map<string, string>()

  const setFeatures = async (codes: string[]) => {
    const plan = codes.filter(code => PLAN_CODES.includes(code))
    if (plan.length)
      throw new Error(`grant: ${plan.join(', ')} es la fila del plan de Avoqado; siémbrala con seedPlanRow, no como función del plan`)
    await prisma.venueFeature.deleteMany({ where: { venueId: { in: venues }, NOT: PLAN_ROWS } })
    for (const code of codes) {
      const { id: featureId } = await prisma.feature.upsert({
        where: { code },
        update: {},
        create: { code, name: code, category: 'OPERATIONS', monthlyPrice: 0 },
      })
      await prisma.venueFeature.createMany({ data: venues.map(venueId => ({ venueId, featureId, monthlyPrice: 0, active: true })) })
    }
  }
  const clearPermissions = async () => {
    await prisma.staffVenue.updateMany({ where: { staffId }, data: { permissionSetId: null } })
    await prisma.venueRolePermission.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.permissionSet.deleteMany({ where: { venueId: { in: venues } } })
  }
  const clearSupport = async () => {
    const ids = (await prisma.supportConversation.findMany({ where: { receiverId }, select: { id: true }, take: 500 })).map(c => c.id)
    await prisma.supportEvent.deleteMany({ where: { conversationId: { in: ids } } })
    await prisma.supportAttempt.deleteMany({ where: { message: { conversationId: { in: ids } } } })
    await prisma.supportMessage.deleteMany({ where: { conversationId: { in: ids } } })
    await prisma.supportLinkChallenge.deleteMany({ where: { conversationId: { in: ids } } })
    await prisma.supportConversation.deleteMany({ where: { id: { in: ids } } })
    await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
    await prisma.supportDataQuery.deleteMany({ where: { staffId } })
    await prisma.supportDataAcceptance.deleteMany({ where: { staffId } })
    await prisma.supportDataUnlock.deleteMany({ where: { staffId } })
    await prisma.activityLog.deleteMany({ where: { staffId } })
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
    conversations.clear()
  }
  const relink = async () =>
    (
      await prisma.supportWhatsappLink.create({
        data: { staffId, phone, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY_MS) },
      })
    ).id

  await setFeatures(SEEDED_FEATURES)
  const fixture: DataFixture = {
    staffId,
    orgId,
    northId,
    cancunId,
    emptyId,
    siblingId,
    foreignId,
    linkId: await relink(),
    async conversation(venueId = northId) {
      const id = conversations.get(venueId)
      if (id) return prisma.supportConversation.findUniqueOrThrow({ where: { id } })
      const now = new Date()
      const created = await prisma.supportConversation.create({
        data: {
          phone,
          receiverId,
          linkId: fixture.linkId,
          staffId,
          orgId,
          venueId,
          mode: 'PERSONAL',
          app: 'dashboard',
          noticeAcceptedAt: now,
          lastUserMessageAt: now,
          lastActivityAt: now,
        },
      })
      conversations.set(venueId, created.id)
      return created
    },
    async unlock(venueId = northId) {
      await grantDataAccess(staffId, { venueId, noticeHash: supportDataNoticeHash('es'), acceptNotice: true }, { strongAuthAt: new Date() })
    },
    async accept() {
      await fixture.unlock()
      await prisma.supportDataUnlock.updateMany({ where: { staffId }, data: { day: '2000-01-01' } })
    },
    async grant({ permissions, role = SEEDED_ROLE, features = [], asPermissionSet = false }) {
      await clearPermissions()
      await prisma.staffVenue.updateMany({ where: { staffId }, data: { role } })
      for (const venueId of venues) {
        if (asPermissionSet) {
          const set = await prisma.permissionSet.create({ data: { venueId, name: `Datos ${suffix}`, permissions } })
          await prisma.staffVenue.update({ where: { staffId_venueId: { staffId, venueId } }, data: { permissionSetId: set.id } })
        } else {
          await prisma.venueRolePermission.create({
            data: { venueId, role, permissions, deniedPermissions: deniedFor(role, permissions), modifiedBy: staffId },
          })
        }
      }
      await setFeatures(features)
    },
    async reset() {
      await clearSupport()
      await clearPermissions()
      await prisma.staff.update({ where: { id: staffId }, data: { active: true, lastPasswordReset: null, sessionsRevokedAt: null } })
      await prisma.staffVenue.updateMany({ where: { staffId }, data: { role: SEEDED_ROLE, active: true } })
      await prisma.staffOrganization.update({
        where: { staffId_organizationId: { staffId, organizationId: orgId } },
        data: { role: 'MEMBER', isActive: true, leftAt: null },
      })
      await prisma.venue.update({
        where: { id: northId },
        data: { name: 'Norte', timezone: 'America/Mexico_City', kycStatus: 'VERIFIED', status: 'ACTIVE' },
      })
      await prisma.venue.update({
        where: { id: cancunId },
        data: { name: 'Cancún', timezone: 'America/Cancun', kycStatus: 'VERIFIED', status: 'ACTIVE' },
      })
      await prisma.venue.update({
        where: { id: emptyId },
        data: { name: 'Sur', timezone: 'America/Mexico_City', kycStatus: 'VERIFIED', status: 'ACTIVE' },
      })
      await prisma.venueFeature.deleteMany({ where: { venueId: { in: venues } } }) // también las del plan (C5)
      await setFeatures(SEEDED_FEATURES)
      fixture.linkId = await relink()
    },
    async clean() {
      await clearSupport()
      await clearPermissions()
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await prisma.staffOrganization.deleteMany({ where: { staffId } })
      await prisma.venueFeature.deleteMany({ where: { venueId: { in: venues } } })
      // C7: las facturas y sus emisores, antes que las ventas (el manifiesto de una global es Restrict con la orden; la factura, con la sucursal).
      await clearInvoices([...venues, siblingId, foreignId])
      // Lo que siembran las capacidades (C1: ventas): una sucursal con órdenes no se borra (Order.venue es Restrict).
      await clearSales([...venues, siblingId, foreignId])
      // C6: las cuentas de comercio de prueba (sus reglas se van en cascada), ya sin cobros que las usen.
      await clearCardMerchants([...venues, siblingId, foreignId])
      // C4: sus productos cuelgan de una categoría con Restrict, y su personal no es de la sucursal.
      await clearReservations([...venues, siblingId, foreignId])
      // C8: las cajas, sus turnos y su bitácora (Shift y CashDrawerSession son Restrict con la sucursal), y las personas que las abren.
      await clearCashDrawers([...venues, siblingId, foreignId])
      await prisma.venue.deleteMany({ where: { id: { in: [...venues, siblingId, foreignId] } } })
      await prisma.organization.deleteMany({ where: { id: { in: [orgId, foreignOrgId] } } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
  return fixture
}

// ─── Espías: qué consulta una lectura y qué escribe en el log ───────────────────────────────────────────────────────────────

export interface QueryCall {
  model: string | null // el nombre del modelo de Prisma ('Payment'); null en SQL crudo y en legacyPool.query
  action: string // 'findMany', '$queryRaw', 'legacyPool.query'…
  args: unknown // el objeto de una llamada de modelo; la lista de argumentos de una cruda
}
const MODEL_ACTIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
])
const RAW_ACTIONS = ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe', '$queryRawTyped']
/** La propiedad del cliente de cada modelo ('supportDataQuery' → 'SupportDataQuery'). */
const MODEL_OF = new Map(Prisma.dmmf.datamodel.models.map(m => [m.name.charAt(0).toLowerCase() + m.name.slice(1), m.name]))

type AnyFunction = (...args: unknown[]) => unknown

/**
 * Anota cada delegado de prisma, $queryRaw*, $executeRaw* y legacyPool.query, también los de una transacción interactiva
 * (`prisma.$transaction(async tx => …)`: el `tx` que recibe la función también se anota). Pasa cada llamada tal cual.
 */
export function spyQueries(): { calls: QueryCall[]; restore(): void } {
  const calls: QueryCall[] = []
  const undo: (() => void)[] = []
  const recorded = (model: string | null, action: string, fn: AnyFunction, self: unknown): AnyFunction =>
    function (...args: unknown[]) {
      calls.push({ model, action, args: model ? args[0] : args })
      return fn.apply(self, args)
    }
  const swap = (target: Record<string, unknown>, name: string, wrap: (fn: AnyFunction) => AnyFunction) => {
    const fn = target[name]
    if (typeof fn !== 'function') return
    target[name] = wrap(fn as AnyFunction)
    undo.push(() => (target[name] = fn))
  }
  const client = prisma as unknown as Record<string, unknown>
  for (const [property, model] of MODEL_OF) {
    const delegate = client[property] as Record<string, unknown> | undefined
    if (!delegate) continue
    for (const action of MODEL_ACTIONS) swap(delegate, action, fn => recorded(model, action, fn, delegate))
  }
  for (const action of RAW_ACTIONS) swap(client, action, fn => recorded(null, action, fn, prisma))
  const instrument = (tx: object): object =>
    new Proxy(tx, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (typeof property !== 'string') return value
        if (RAW_ACTIONS.includes(property) && typeof value === 'function') return recorded(null, property, value as AnyFunction, target)
        const model = MODEL_OF.get(property)
        if (!model || !value || typeof value !== 'object') return value
        return new Proxy(value, {
          get(delegate, action) {
            const fn = Reflect.get(delegate, action)
            return typeof action === 'string' && MODEL_ACTIONS.has(action) && typeof fn === 'function'
              ? recorded(model, action, fn as AnyFunction, delegate)
              : fn
          },
        })
      },
    })
  swap(
    client,
    '$transaction',
    fn =>
      function (work: unknown, ...rest: unknown[]) {
        return typeof work === 'function'
          ? fn.call(prisma, (tx: object) => (work as (tx: object) => unknown)(instrument(tx)), ...rest)
          : fn.call(prisma, work, ...rest)
      },
  )
  if (legacyPool) swap(legacyPool as unknown as Record<string, unknown>, 'query', fn => recorded(null, 'legacyPool.query', fn, legacyPool))
  return {
    calls,
    restore: () =>
      undo
        .splice(0)
        .reverse()
        .forEach(back => back()),
  }
}

const LOGGER_METHODS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly', 'log'] as const
/** Cada argumento que recibió el logger mientras el espía estuvo puesto. */
export function spyLogger(): { args(): unknown[]; restore(): void } {
  const target = logger as unknown as Record<string, AnyFunction>
  const spies = LOGGER_METHODS.filter(m => typeof target[m] === 'function').map(m => jest.spyOn(target, m))
  return { args: () => spies.flatMap(s => s.mock.calls.flat()), restore: () => spies.forEach(s => s.mockRestore()) }
}

/** Cada texto y cada número que hay en lo registrado (objetos, listas, Decimal y el mensaje de un Error), sin colgarse en un ciclo. */
function loggedLeaves(value: unknown, seen = new Set<object>()): (string | number | Prisma.Decimal)[] {
  if (typeof value === 'string' || typeof value === 'number') return [value]
  if (typeof value === 'bigint') return [value.toString()]
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  if (Prisma.Decimal.isDecimal(value)) return [value as Prisma.Decimal]
  if (value instanceof Date) return []
  const own = Object.values(value as Record<string, unknown>)
  return [...(value instanceof Error ? [value.message] : []), ...own].flatMap(v => loggedLeaves(v, seen))
}
const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Los importes de `amounts` que aparecen en lo registrado: como número o Decimal igual al centavo, o escritos en un texto
 * («12345.6», «12345.60», «12,345.60», «$12,345.60»; de un negativo, también sus dígitos sin signo). Un conteo o un id no es un
 * importe: un número sólo cuenta si es igual al centavo, y un texto sólo si el importe no está pegado a otra letra, dígito o
 * decimal. Cada importe sale una vez, escrito como String(amount).
 */
export function amountLeaks(loggerArgs: unknown[], amounts: number[]): string[] {
  const leaves = loggedLeaves(loggerArgs)
  return amounts
    .filter(amount => {
      const cents = new Prisma.Decimal(amount).toDecimalPlaces(2)
      const fixed = cents.abs().toFixed(2)
      const [whole, decimals] = fixed.split('.')
      const short = cents.abs().toString().split('.')[1] ?? ''
      const forms = new Set([fixed, `${groupThousands(whole)}.${decimals}`])
      if (short.length < 2)
        forms.add(short ? `${whole}.${short}` : whole).add(short ? `${groupThousands(whole)}.${short}` : groupThousands(whole))
      const written = new RegExp(`(?<![\\p{L}\\p{N}_.,])(?:${[...forms].map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_]|[.,]\\p{N})`, 'u')
      return leaves.some(leaf =>
        typeof leaf === 'string' ? written.test(leaf) : new Prisma.Decimal(leaf).toDecimalPlaces(2).equals(cents),
      )
    })
    .map(amount => String(amount))
}

// ─── Lo que cada capacidad le da a los barridos ─────────────────────────────────────────────────────────────────────────────

/*
 * El contrato del aislamiento entre sucursales (T-B41). Quien pregunta por SU sucursal nunca ve datos de otra, y eso lo garantiza la
 * ESTRUCTURA, no este barrido:
 * 1. Una capacidad (`src/services/support/data/capabilities/`) no toca la base: lee SÓLO llamando servicios del panel
 *    (`src/services/dashboard`, `shared`, `legacy`). Si necesita una consulta que el panel no tiene, la consulta va en un servicio del
 *    panel. Lo vigila `tests/unit/architecture/supportDataCapabilitiesNoDb.test.ts`. Tampoco lee la configuración: sus topes
 *    (`rows`, `openOrdersDays`, `depositGroups`, `depositTimeoutMs`) le llegan en el alcance, que arma el orquestador (T-B41c).
 * 2. La sucursal sólo sale del alcance: todo `venueId` que pasa a un servicio es `scope.venueId` (misma guardia).
 *    Y la organización, NUNCA (T-B41b): la B contesta con datos de UNA sucursal, así que una capacidad no usa `scope.organizationId`,
 *    no pone una llave `organizationId`/`orgId`, no le da valor a un parámetro con ese nombre ni le pasa al panel el alcance entero.
 *    Si un dato necesita la organización, el servicio del panel la saca de la sucursal.
 * 3. Cada servicio NUEVO del panel que agregue una capacidad trae, en SU tarea, una prueba de aislamiento: un renglón de otra sucursal
 *    de la misma organización y uno de otra organización, en la misma ventana y con el mismo valor buscado (mismo monto, misma hora),
 *    nunca sale (también cuando el servicio saca la organización de la sucursal: las hermanas nunca salen). Los servicios del panel
 *    que se reusan tal cual ya cuidan su aislamiento para el panel.
 * El barrido de conducta (`sweeps.integration.test.ts`, con lo que cada capacidad declara aquí abajo) es una SEGUNDA red: no enumera
 * todas las formas de consulta y ese residual está aceptado.
 */

export interface TimeWindow {
  from: Date
  to: Date
}
/** Otra sucursal para la cerca de datos ajenos (T-B38): `f.siblingId` con `marker` 1 y `f.foreignId` con `marker` 2. */
export interface ForeignSeed {
  venueId: string
  marker: 1 | 2
}
export interface CapabilityFixture {
  request: DataRequest
  message: string
  grant: { permissions: string[]; role?: StaffRole; features?: string[] }
  /**
   * Siembra y dice qué cifras salen impresas, los importes ORIGINALES del resultado (en pesos, ninguno igual a un conteo) y la ventana
   * de su lectura. Sin `other`, en `f.northId`. Con `other` (T-B38), lo MISMO en `other.venueId`: los renglones que la lectura
   * imprimiría si no filtrara por sucursal (el mismo monto que busca, el mismo día, la misma ventana), con nombres e importes que
   * llevan `other.marker` y no se parecen a los propios ni a los del otro marcador. Sus `figures` son lo que saldría si se colara
   * (nombres, importes); el barrido revisa que ninguno salga. Sus horas, dentro de la ventana y al menos un minuto antes de la
   * llamada (escritas a mano, nunca el `now()` de la base): el barrido lee su reloj ANTES de sembrar y contesta siempre con él.
   * El barrido lo comprueba leyendo esa sucursal (T-B38b): corre la lectura y la plantilla de la misma capacidad con el alcance de
   * `other.venueId` (armado como el propio, con el mismo reloj) y exige que salgan TODAS sus `figures` y que la respuesta no sea la
   * propia. Una siembra que no crea nada, o lo crea fuera de los filtros o de la ventana, hace fallar el barrido («la siembra es
   * ineficaz»): sin esa prueba, la respuesta propia saldría idéntica aunque la capacidad mezclara sucursales.
   * La pierna sin datos (T-B38c): `seed` NUNCA escribe en `f.emptyId`, ni con `other` ni sin él, ni nada compartido que esa sucursal
   * lea. El barrido también lee esa sucursal con la misma capacidad (su alcance, el mismo reloj), antes y después de sembrar las tres,
   * y esa respuesta no puede cambiar ni traer una cifra sembrada: así cae la lectura del «primero que encuentre» sin filtro de
   * sucursal, que con datos propios sí pasa la comparación.
   */
  seed(f: DataFixture, other?: ForeignSeed): Promise<{ figures: string[]; amounts: number[]; window: TimeWindow }>
  /**
   * Escribe `value` (lo elige el barrido: un número largo, una liga, un correo, un RFC; T-B39) en CADA texto libre que la respuesta
   * imprime, y dice qué sale en su lugar ('[dato omitido]' o '[enlace]', lo que dé safeDbText; en la caja, 'una persona' y 'tu sucursal').
   */
  poison(f: DataFixture, value: string): Promise<{ replacedBy: string[] }>
  windowed: string[] // modelos de Prisma ('Payment') que deben llevar sucursal y ventana
  forbidden: string[] // modelos de Prisma que no debe tocar
  /** Una consulta sin ventana que la capacidad justifica (el conteo de cajas abiertas, el `SET LOCAL statement_timeout`). */
  allowed?: (call: QueryCall) => boolean
}
// ─── C1 · ventas de hoy ──────────────────────────────────────────────────────────────────────────────────────────────────────

let saleSerial = 0
/** Una venta cobrada: su orden y su cobro, a la hora `at`. Devuelve el id de la orden. */
export async function seedSale(
  venueId: string,
  at: Date,
  sale: { subtotal: number; discount?: number; tip?: number; method?: 'CASH' | 'CREDIT_CARD' },
): Promise<string> {
  const discount = sale.discount ?? 0
  const tip = sale.tip ?? 0
  const paid = sale.subtotal - discount
  const { id } = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `B-${Date.now()}-${++saleSerial}`,
      createdAt: at,
      subtotal: sale.subtotal,
      taxAmount: 0,
      discountAmount: discount,
      tipAmount: tip,
      total: paid + tip,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  await prisma.payment.create({
    data: {
      venueId,
      orderId: id,
      amount: paid,
      tipAmount: tip,
      method: sale.method ?? 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: paid,
      createdAt: at,
    },
  })
  return id
}
/** La devolución (un cobro REFUND con importe negativo) de `amount` pesos de una orden, a la hora `at`. */
export async function seedRefund(venueId: string, orderId: string, at: Date, amount: number): Promise<void> {
  await prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: -amount,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REFUND',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: -amount,
      createdAt: at,
    },
  })
}
/** Borra las ventas de esas sucursales (cobros y órdenes). */
export async function clearSales(venueIds: string[]): Promise<void> {
  await prisma.payment.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venueIds } } })
}
/** Una hora de HOY en la zona de la sucursal, dos minutos antes de ahora (o el inicio del día, si apenas empieza). */
export function earlierToday(timezone: string): Date {
  const { from } = wholeDayBounds('today', { timezone, now: new Date() })
  return new Date(Math.max(from.getTime(), Date.now() - 2 * 60_000))
}
/** Lo que sale si se colara la venta de otra sucursal: un importe que no se parece a los propios ni al del otro marcador. */
const FOREIGN_SALE = { 1: 711.11, 2: 722.22 } as const
const salesTodayFixture: CapabilityFixture = {
  request: { capability: 'sales_today', day: 'today', amount: null, time: null, otherVenue: false },
  message: '¿Cuánto vendí hoy?',
  grant: { permissions: ['reports:read'] },
  /** Sin `other`: una venta de $1,250.00 con $50.00 de descuento y $120.00 de propina. Con `other`, una de $711.11 o $722.22. */
  async seed(f, other) {
    const venueId = other?.venueId ?? f.northId
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    await clearSales([venueId])
    const sale = other ? { subtotal: FOREIGN_SALE[other.marker] } : { subtotal: 1250, discount: 50, tip: 120 }
    await seedSale(venueId, earlierToday(timezone), sale)
    return {
      figures: other ? [fmtMoney(sale.subtotal)] : [fmtMoney(1250), fmtMoney(-50), fmtMoney(1200), fmtMoney(120)],
      amounts: other ? [sale.subtotal] : [1250, 50, 1200, 120],
      window: wholeDayBounds('today', { timezone, now: new Date() }),
    }
  },
  /** El único texto libre que imprime es el nombre de la sucursal. */
  async poison(f, value) {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    return { replacedBy: [safeDbText(value)] }
  },
  windowed: ['Payment', 'Order', 'OrderItem', 'OrderPromotion'],
  forbidden: ['CommissionCalculation'],
}

// ─── C2 · buscar un cobro por su monto ───────────────────────────────────────────────────────────────────────────────────────

let paymentSerial = 0
/**
 * Un cobro a la hora `at`, de su propia orden (`Payment.orderId` es obligatorio) o de `orderId`. Devuelve el id de la orden. Lo borra
 * `clearSales` (y `clean()`), como las ventas de C1.
 */
export async function seedPayment(
  venueId: string,
  at: Date,
  payment: {
    amount: number
    tip?: number
    status?: TransactionStatus
    method?: PaymentMethod
    cardBrand?: CardBrand
    maskedPan?: string
    referenceNumber?: string
    orderId?: string
    /**
     * Un tipo de pago del negocio: uno propio («Uber Eats», `kind` null) o uno de sistema (`STORE_CREDIT`, `GIFT_CARD`). Se crea en
     * la sucursal si no existe (lo borra la sucursal, en cascada) y el cobro lleva su id y la copia de su nombre, como los del servidor;
     * el método por omisión es OTHER, el de esos tipos.
     */
    tender?: { name: string; kind?: TenderSystemKind | null }
  },
): Promise<string> {
  const tip = payment.tip ?? 0
  const tender = payment.tender
    ? await prisma.venueTenderType.upsert({
        where: { venueId_normalizedName: { venueId, normalizedName: payment.tender.name.toLowerCase() } },
        update: {},
        create: {
          venueId,
          name: payment.tender.name,
          normalizedName: payment.tender.name.toLowerCase(),
          baseMethod: 'OTHER',
          systemKind: payment.tender.kind ?? null,
        },
        select: { id: true, name: true },
      })
    : null
  const orderId =
    payment.orderId ??
    (
      await prisma.order.create({
        data: {
          venueId,
          orderNumber: `P-${Date.now()}-${++paymentSerial}`,
          createdAt: at,
          subtotal: payment.amount,
          taxAmount: 0,
          tipAmount: tip,
          total: payment.amount + tip,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
        },
        select: { id: true },
      })
    ).id
  await prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: payment.amount,
      tipAmount: tip,
      method: payment.method ?? (payment.cardBrand ? 'CREDIT_CARD' : tender ? 'OTHER' : 'CASH'),
      status: payment.status ?? 'COMPLETED',
      type: 'REGULAR',
      cardBrand: payment.cardBrand,
      maskedPan: payment.maskedPan,
      referenceNumber: payment.referenceNumber,
      tenderTypeId: tender?.id,
      tenderRevision: tender ? 1 : undefined,
      tenderLabel: tender?.name,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: payment.amount,
      createdAt: at,
    },
  })
  return orderId
}
/**
 * Lo que sale si se colara el cobro de otra sucursal: el MISMO total buscado ($850.00), repartido entre importe y propina de otra
 * forma que el propio, así que sus dos cifras no se parecen a las propias ni a las del otro marcador.
 */
const FOREIGN_PAYMENT = { 1: { amount: 711.11, tip: 138.89 }, 2: { amount: 722.22, tip: 127.78 } } as const
const findPaymentFixture: CapabilityFixture = {
  request: { capability: 'find_payment', day: 'today', amount: '850', time: null, otherVenue: false },
  message: '¿Entró un cobro de $850 hoy?',
  grant: { permissions: ['payments:read'] },
  /**
   * Sin `other`: un cobro de $764.50 con $85.50 de propina ($850.00 contando la propina). Con `other`, uno del mismo total, del mismo
   * día y dentro de la ventana. El monto buscado no va en `figures`: también lo dice la respuesta sin cobros.
   */
  async seed(f, other) {
    const venueId = other?.venueId ?? f.northId
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    await clearSales([venueId])
    const payment = other ? FOREIGN_PAYMENT[other.marker] : { amount: 764.5, tip: 85.5 }
    await seedPayment(venueId, earlierToday(timezone), payment)
    return {
      figures: [fmtMoney(payment.amount), fmtMoney(payment.tip)],
      amounts: [payment.amount, payment.tip],
      window: wholeDayBounds('today', { timezone, now: new Date() }),
    }
  },
  /** El único texto libre que imprime es el nombre de la sucursal (la marca y el método salen de una lista fija del código). */
  async poison(f, value) {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    return { replacedBy: [safeDbText(value)] }
  },
  windowed: ['Payment'],
  forbidden: [],
}

// ─── C7 · si la venta de ese cobro tiene factura ─────────────────────────────────────────────────────────────────────────────

let invoiceSerial = 0
/**
 * Una factura de la venta `orderId`, en la sucursal `venueId` (por omisión individual, de ingreso y timbrada), con el emisor de esa
 * sucursal (lo crea si no tiene). Lo que la B nunca puede imprimir (UUID, folio, serie, RFC y ligas) va lleno a propósito. Devuelve su
 * id. La borra `clearInvoices` (y `clean()`).
 */
export async function seedInvoice(
  venueId: string,
  orderId: string | null,
  over: {
    status?: CfdiStatus
    cancelStatus?: CfdiCancelStatus
    replacesCfdiId?: string
    isGlobal?: boolean
    type?: CfdiType
    uuid?: string
    folio?: string
  } = {},
): Promise<string> {
  const emisor =
    (await prisma.fiscalEmisor.findFirst({ where: { venueId }, select: { id: true } })) ??
    (await prisma.fiscalEmisor.create({
      data: { venueId, rfc: 'GODE561231GR8', legalName: 'Emisor de prueba', regimenFiscal: '601', lugarExpedicion: '01000' },
      select: { id: true },
    }))
  const n = ++invoiceSerial
  const { id } = await prisma.cfdi.create({
    data: {
      venueId,
      fiscalEmisorId: emisor.id,
      orderId,
      type: over.type ?? 'INGRESO',
      status: over.status ?? 'STAMPED',
      cancelStatus: over.cancelStatus,
      replacesCfdiId: over.replacesCfdiId,
      isGlobal: over.isGlobal ?? false,
      flow: 'STAFF_B',
      receptorRfc: 'GODE561231GR8',
      receptorNombre: 'Receptor de prueba',
      receptorRegimen: '612',
      receptorCp: '01000',
      usoCfdi: 'G03',
      formaPago: '04',
      metodoPago: 'PUE',
      subtotalCents: 80603,
      taxCents: 12897,
      totalCents: 93500,
      protocoloIva: 1, // `Cfdi_heredada_solo_terminada`: sin protocolo sólo existen las terminadas
      uuid: over.uuid ?? crypto.randomUUID().toUpperCase(),
      serie: 'A',
      folio: over.folio ?? String(9000 + n),
      xmlUrl: `https://storage.test.local/cfdi-${n}.xml`,
      pdfUrl: `https://storage.test.local/cfdi-${n}.pdf`,
      stampedAt: new Date(),
    },
    select: { id: true },
  })
  return id
}
/** Una factura GLOBAL timbrada que cubre `orderIds` por su manifiesto, como la del cierre del periodo. Devuelve su id. */
export async function seedGlobalInvoice(venueId: string, orderIds: string[]): Promise<string> {
  const id = await seedInvoice(venueId, null, { isGlobal: true })
  await prisma.cfdiGlobalOrden.createMany({ data: orderIds.map(orderId => ({ cfdiId: id, orderId, huella: 'support-data' })) })
  return id
}
/** Borra las facturas de esas sucursales (o de sus ventas) y sus emisores. Antes de `clearSales`: el manifiesto de una global es Restrict con la orden. */
export async function clearInvoices(venueIds: string[]): Promise<void> {
  const mine = { OR: [{ venueId: { in: venueIds } }, { order: { venueId: { in: venueIds } } }] }
  await prisma.cfdiGlobalOrden.deleteMany({ where: { OR: [{ cfdi: mine }, { order: { venueId: { in: venueIds } } }] } })
  await prisma.cfdi.deleteMany({ where: mine })
  await prisma.fiscalEmisor.deleteMany({ where: { venueId: { in: venueIds } } })
}
/**
 * Lo que sale si se colara el cobro de otra sucursal: el MISMO total buscado ($850.00), con tarjeta y otros últimos 4, y su venta
 * facturada (la propia no lo está), así que su forma de pago y su estado no se parecen a los propios ni a los del otro marcador.
 */
const FOREIGN_INVOICED = {
  1: { amount: 711.11, tip: 138.89, maskedPan: '411111******7111' },
  2: { amount: 722.22, tip: 127.78, maskedPan: '411111******7222' },
} as const
const paymentInvoiceFixture: CapabilityFixture = {
  request: { capability: 'payment_invoice', day: 'today', amount: '850', time: null, otherVenue: false },
  message: '¿Ya tiene factura la venta del cobro de $850 de hoy?',
  grant: { permissions: ['orders:read', 'cfdi:view'], features: ['CFDI'] },
  /**
   * Sin `other`: un cobro en efectivo de $764.50 con $85.50 de propina ($850.00 contando la propina), y su venta sin factura. Con
   * `other`, uno del mismo total, del mismo día y dentro de la ventana, con tarjeta y su venta facturada en esa sucursal.
   */
  async seed(f, other) {
    const venueId = other?.venueId ?? f.northId
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    await clearInvoices([venueId])
    await clearSales([venueId])
    if (!other) {
      await seedPayment(venueId, earlierToday(timezone), { amount: 764.5, tip: 85.5 })
      return {
        figures: ['Efectivo · Completado', 'su venta no tiene factura'],
        amounts: [764.5, 85.5],
        window: wholeDayBounds('today', { timezone, now: new Date() }),
      }
    }
    const { maskedPan, ...payment } = FOREIGN_INVOICED[other.marker]
    const orderId = await seedPayment(venueId, earlierToday(timezone), { ...payment, cardBrand: 'MASTERCARD', maskedPan })
    await seedInvoice(venueId, orderId)
    return {
      figures: [`Mastercard terminación ${maskedPan.slice(-4)} · Completado`, 'su venta ya tiene factura'],
      amounts: [payment.amount, payment.tip],
      window: wholeDayBounds('today', { timezone, now: new Date() }),
    }
  },
  /** El único texto libre que imprime es el nombre de la sucursal (la forma de pago, el estado y el de la factura salen de listas fijas). */
  async poison(f, value) {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    return { replacedBy: [safeDbText(value)] }
  },
  windowed: ['Payment'],
  forbidden: ['Order'],
}

// ─── C3 · cuentas abiertas de los últimos 7 días ─────────────────────────────────────────────────────────────────────────────

let orderSerial = 0
/**
 * Una cuenta sin cobros a la hora `at` (por omisión, abierta: CONFIRMED y PENDING, que debe todo su total). Con `table`, en la mesa de
 * ese número de la sucursal (la crea si no existe). Devuelve el id de la orden. La borra `clearSales`; las mesas, `clearTables` (y
 * `clean()`, con la sucursal).
 */
export async function seedOrder(
  venueId: string,
  at: Date,
  order: { total?: number; status?: OrderStatus; paymentStatus?: PaymentStatus; type?: OrderType; table?: string } = {},
): Promise<string> {
  const n = ++orderSerial
  const tableId =
    order.table === undefined
      ? null
      : (
          await prisma.table.upsert({
            where: { venueId_number: { venueId, number: order.table } },
            update: {},
            create: { venueId, number: order.table, capacity: 4, qrCode: `qr-${venueId}-${Date.now()}-${n}` },
          })
        ).id
  const total = order.total ?? 100
  const { id } = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `C-${Date.now()}-${n}`,
      createdAt: at,
      type: order.type ?? 'DINE_IN',
      tableId,
      subtotal: total,
      taxAmount: 0,
      total,
      remainingBalance: total,
      status: order.status ?? 'CONFIRMED',
      paymentStatus: order.paymentStatus ?? 'PENDING',
    },
    select: { id: true },
  })
  return id
}
/** Borra las mesas de esas sucursales (después de sus órdenes, con `clearSales`). */
export async function clearTables(venueIds: string[]): Promise<void> {
  await prisma.table.deleteMany({ where: { venueId: { in: venueIds } } })
}
/** Lo que sale si se colara la cuenta de otra sucursal: una mesa con otro nombre y un total que no se parece al propio. */
const FOREIGN_OPEN_ORDER = { 1: { table: 'Patio 1', total: 711.11 }, 2: { table: 'Patio 2', total: 722.22 } } as const
const openOrdersFixture: CapabilityFixture = {
  request: { capability: 'open_orders', day: null, amount: null, time: null, otherVenue: false },
  message: '¿Qué cuentas tengo abiertas?',
  grant: { permissions: ['orders:read'] },
  /**
   * Sin `other`: dos cuentas abiertas de hoy, una a medio pagar en la Mesa 7 ($1,234.56) y una para llevar ($987.65). Con `other`, una
   * abierta de hoy en la mesa «Patio 1» o «Patio 2». Lo que imprime es la mesa: los totales no salen nunca (son los `amounts`).
   */
  async seed(f, other) {
    const venueId = other?.venueId ?? f.northId
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    await clearSales([venueId])
    await clearTables([venueId])
    const now = new Date()
    const own = { table: '7', total: 1234.56 }
    const { table, total } = other ? FOREIGN_OPEN_ORDER[other.marker] : own
    await seedOrder(venueId, earlierToday(timezone), { table, total, paymentStatus: 'PARTIAL' })
    if (!other) await seedOrder(venueId, earlierToday(timezone), { type: 'TAKEOUT', total: 987.65 })
    return {
      figures: [`Mesa ${table}`],
      amounts: other ? [total] : [own.total, 987.65],
      window: { from: lastDaysStart(7, { timezone, now }), to: now },
    }
  },
  /** Los textos libres que imprime: el nombre de la sucursal y el número de mesa (la siembra propia tiene una sola mesa). */
  async poison(f, value) {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    await prisma.table.updateMany({ where: { venueId: f.northId }, data: { number: value } })
    return { replacedBy: [safeDbText(value)] }
  },
  windowed: ['Order'],
  forbidden: ['Payment'],
}

// ─── C4 · reservaciones de hoy ───────────────────────────────────────────────────────────────────────────────────────────────

let reservationSerial = 0
/** El correo del personal que siembra `seedReservation` en esa sucursal: así lo encuentran `poison` y `clearReservations`. */
const reservationStaffEmail = (venueId: string) => `reserva-${venueId}-`
/**
 * Una reservación de una hora que empieza a las `at` (por omisión CONFIRMED, para 2 personas). Con `product`, el servicio (con su
 * categoría); con `customer`, el cliente ligado; con `staff`, quién atiende (una persona nueva, fuera de la sucursal); con `table`, la
 * mesa de ese número (la crea si no existe). La borra `clearReservations` (y `clean()`); las mesas, `clearTables`.
 */
export async function seedReservation(
  venueId: string,
  at: Date,
  r: {
    status?: ReservationStatus
    partySize?: number
    guestName?: string
    guestPhone?: string
    guestEmail?: string
    confirmationCode?: string
    customer?: { firstName: string; lastName: string; phone?: string; email?: string }
    product?: string
    staff?: { firstName: string; lastName: string }
    table?: string
  } = {},
): Promise<string> {
  const n = ++reservationSerial
  const stamp = `${Date.now()}-${n}`
  const productId = r.product
    ? (
        await prisma.product.create({
          data: {
            venueId,
            sku: `RES-SKU-${stamp}`,
            name: r.product,
            price: 100,
            categoryId: (
              await prisma.menuCategory.upsert({
                where: { venueId_slug: { venueId, slug: 'reservaciones' } },
                update: {},
                create: { venueId, name: 'Servicios', slug: 'reservaciones' },
              })
            ).id,
          },
        })
      ).id
    : null
  const customerId = r.customer ? (await prisma.customer.create({ data: { venueId, ...r.customer } })).id : null
  const assignedStaffId = r.staff
    ? (await prisma.staff.create({ data: { email: `${reservationStaffEmail(venueId)}${stamp}@test.local`, ...r.staff } })).id
    : null
  const tableId =
    r.table === undefined
      ? null
      : (
          await prisma.table.upsert({
            where: { venueId_number: { venueId, number: r.table } },
            update: {},
            create: { venueId, number: r.table, capacity: 4, qrCode: `qr-res-${venueId}-${stamp}` },
          })
        ).id
  const endsAt = new Date(at.getTime() + 60 * 60_000)
  const { id } = await prisma.reservation.create({
    data: {
      venueId,
      confirmationCode: r.confirmationCode ?? `RES-${stamp}`,
      status: r.status ?? 'CONFIRMED',
      startsAt: at,
      endsAt,
      blockedEndsAt: endsAt,
      duration: 60,
      partySize: r.partySize ?? 2,
      guestName: r.guestName,
      guestPhone: r.guestPhone,
      guestEmail: r.guestEmail,
      customerId,
      productId,
      assignedStaffId,
      tableId,
    },
    select: { id: true },
  })
  return id
}
/** Borra las reservaciones de esas sucursales y lo que sembró con ellas: servicios, categorías, clientes y personal. */
export async function clearReservations(venueIds: string[]): Promise<void> {
  await prisma.reservation.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.product.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.customer.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.staff.deleteMany({ where: { OR: venueIds.map(venueId => ({ email: { startsWith: reservationStaffEmail(venueId) } })) } })
}
/** Lo que sale si se colara la reservación de otra sucursal: un servicio, un cliente y una persona que no se parecen a los propios. */
const FOREIGN_RESERVATION = {
  1: { product: 'Peinado Alfa', customer: { firstName: 'Bruno', lastName: 'Alfa' }, staff: { firstName: 'Rita', lastName: 'Alfa' } },
  2: { product: 'Peinado Beta', customer: { firstName: 'Carla', lastName: 'Beta' }, staff: { firstName: 'Sara', lastName: 'Beta' } },
} as const
const reservationsTodayFixture: CapabilityFixture = {
  request: { capability: 'reservations_today', day: 'today', amount: null, time: null, otherVenue: false },
  message: '¿Qué reservaciones tengo hoy?',
  grant: { permissions: ['reservations:read'], features: ['RESERVATIONS'] },
  /**
   * Sin `other`: dos de hoy, una de restaurante (Ana Ramírez escrita al reservar, 4 personas, mesa 7) y un minuto después una de salón
   * (Corte, con el cliente Luis Martínez y Paola Gómez). Con `other`, una de salón de hoy con servicio, cliente y persona marcados.
   * Las dos horas, distintas: con la misma, el orden de la lista no estaría fijo. Reservaciones no lleva importes (`amounts` vacío).
   */
  async seed(f, other) {
    const venueId = other?.venueId ?? f.northId
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    await clearReservations([venueId])
    await clearTables([venueId])
    const first = earlierToday(timezone)
    const window = wholeDayBounds('today', { timezone, now: new Date() })
    if (other) {
      const marked = FOREIGN_RESERVATION[other.marker]
      await seedReservation(venueId, first, marked)
      return {
        figures: [marked.product, `${marked.customer.firstName} ${marked.customer.lastName[0]}.`, `con ${marked.staff.firstName}`],
        amounts: [],
        window,
      }
    }
    await seedReservation(venueId, first, { partySize: 4, guestName: 'Ana Ramírez', table: '7' })
    await seedReservation(venueId, new Date(first.getTime() + 60_000), {
      product: 'Corte',
      customer: { firstName: 'Luis', lastName: 'Martínez' },
      staff: { firstName: 'Paola', lastName: 'Gómez' },
    })
    return { figures: ['4 personas · Ana R.', 'mesa 7', 'Corte · Luis M. · con Paola'], amounts: [], window }
  },
  /** Los textos libres que imprime: la sucursal, el servicio, el cliente (escrito al reservar y ligado), quién atiende y la mesa. */
  async poison(f, value) {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    await prisma.product.updateMany({ where: { venueId: f.northId }, data: { name: value } })
    await prisma.customer.updateMany({ where: { venueId: f.northId }, data: { firstName: value } })
    await prisma.reservation.updateMany({ where: { venueId: f.northId, guestName: { not: null } }, data: { guestName: value } })
    await prisma.staff.updateMany({ where: { email: { startsWith: reservationStaffEmail(f.northId) } }, data: { firstName: value } })
    await prisma.table.updateMany({ where: { venueId: f.northId }, data: { number: value } })
    return { replacedBy: [safeDbText(value)] }
  },
  windowed: ['Reservation'],
  forbidden: ['Payment', 'Order'],
}

// ─── C5 · estado del plan ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * LA fila del plan de Avoqado de una sucursal (PLAN_PRO, o PLAN_PREMIUM), con lo que «Tu plan» lee de ella; borra antes las que tenga.
 * Sin `stripeSubscriptionId` es una cortesía (con `endDate`, una prueba regalada): getPlanState no llama a Stripe. Con él, la prueba
 * pone a `retrievePlanSubscription` de mentira. En las tres sucursales de la persona la borra `reset()`; en la hermana y la ajena (donde
 * escribe `seed(f, other)`) se queda hasta la siguiente `seedPlanRow` de esa sucursal o hasta `clean()`, que borra la sucursal (Cascade).
 */
export async function seedPlanRow(
  venueId: string,
  row: {
    code?: 'PLAN_PRO' | 'PLAN_PREMIUM'
    endDate?: Date
    gracePeriodEndsAt?: Date
    suspendedAt?: Date
    stripeSubscriptionId?: string
    monthlyPrice?: number
  } = {},
): Promise<void> {
  const { code = 'PLAN_PRO', monthlyPrice = 0, ...rest } = row
  await prisma.venueFeature.deleteMany({ where: { venueId, ...PLAN_ROWS } })
  const { id: featureId } = await prisma.feature.upsert({
    where: { code },
    update: {},
    create: { code, name: code, category: 'OPERATIONS', monthlyPrice: 0 },
  })
  await prisma.venueFeature.create({ data: { venueId, featureId, monthlyPrice, active: true, ...rest } })
}
/** Lo que sale si se colara el plan de otra sucursal: otro nivel, otra fecha y otro precio (que tampoco se imprime). */
const FOREIGN_PLAN = { 1: { days: 40, price: 711.11 }, 2: { days: 50, price: 722.22 } } as const
const planStatusFixture: CapabilityFixture = {
  request: { capability: 'plan_status', day: null, amount: null, time: null, otherVenue: false },
  message: '¿Cómo está mi plan de Avoqado?',
  /**
   * El puesto de la pantalla (ADMIN) y sólo `billing:subscriptions:read`: trae `billing:read` consigo (`permissions.ts`, y quitarlo no
   * lo quita: lo implicado por lo que se conserva vuelve). Con los dos aquí, la pierna «sin `billing:read`» del barrido pediría un
   * acceso que no existe. Que sin `billing:subscriptions:read` (o sin el puesto) no contesta lo prueban el barrido y la de C5.
   */
  grant: { permissions: ['billing:subscriptions:read'], role: 'ADMIN' },
  /**
   * Sin `other`: una cortesía Pro hasta dentro de 20 días ($1,234.56 al mes, que nunca sale). Con `other`, una cortesía Premium hasta
   * dentro de 40 o 50 días. Sin Stripe: es una fila sin suscripción. Lo que imprime es el nivel y la fecha.
   */
  async seed(f, other) {
    const venueId = other?.venueId ?? f.northId
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    const now = new Date()
    const { days, price } = other ? FOREIGN_PLAN[other.marker] : { days: 20, price: 1234.56 }
    const tier = other ? 'Premium' : 'Pro'
    const endDate = new Date(now.getTime() + days * DAY_MS)
    await seedPlanRow(venueId, { code: other ? 'PLAN_PREMIUM' : 'PLAN_PRO', endDate, monthlyPrice: price })
    return {
      figures: [`${tier}. Tu plan ${tier} es de cortesía hasta el ${fmtDate(endDate, timezone)}.`],
      // El precio de la fila y el que getPlanState calcula con IVA: los dos viajan en el resultado y ninguno se imprime
      amounts: [price, Math.round(price * 1.16 * 100) / 100],
      window: { from: now, to: now }, // sin ventana: ninguna de sus lecturas es por fechas (`windowed` vacío)
    }
  },
  /** El único texto libre que imprime es el nombre de la sucursal. */
  async poison(f, value) {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    return { replacedBy: [safeDbText(value)] }
  },
  windowed: [],
  forbidden: ['ActivityLog', 'Payment', 'Order'],
  /**
   * El contrato de campaña (y su último periodo) se leen con `findFirst` por la sucursal: Prisma pone LIMIT 1. Y la oferta del Plan
   * Básico (develop, #484: `getPublicBasicPlan`) busca LA campaña publicada por su llave de producto: es de la plataforma, no de un negocio.
   */
  allowed: call => {
    if (call.action !== 'findFirst') return false
    const where = (call.args as { where?: { venueId?: unknown; purpose?: unknown; listProductKey?: unknown } } | undefined)?.where
    if (call.model === 'HybridCampaign') return where?.purpose === 'LIST' && typeof where.listProductKey === 'string'
    return ['HybridContract', 'HybridPaymentPeriod'].includes(call.model ?? '') && typeof where?.venueId === 'string'
  },
}

// ─── C6 · lo que cae en el banco esta semana ─────────────────────────────────────────────────────────────────────────────────

const CARD_PROVIDER = {
  code: 'SUPPORT_DATA_CARDS',
  name: 'Procesador de prueba de la B',
  type: 'PAYMENT_PROCESSOR' as const,
  countryCode: ['MX'],
}
const CARD_MERCHANT = 'support-data-card-'
/** Una regla de depósito; lo que falte, el de omisión: crédito, el mismo día natural, corte 23:59 en la CDMX, vigente desde 2020. */
export interface CardRule {
  cardType?: TransactionCardType
  settlementDays?: number
  settlementDayType?: SettlementDayType
  cutoffTime?: string
  cutoffTimezone?: string
  effectiveFrom?: Date
  effectiveTo?: Date | null
}
let merchantSerial = 0
/**
 * Una cuenta de comercio de prueba con sus reglas de depósito. `tag` (el id de una sucursal) va en su id externo: `clearCardMerchants`
 * (y `clean()`) la borra por él, con sus reglas en cascada. La puede usar cualquier sucursal: la cuenta sólo decide la regla.
 */
export async function seedCardMerchant(tag: string, rules: CardRule[] = [{}]): Promise<string> {
  const { id: providerId } = await prisma.paymentProvider.upsert({ where: { code: CARD_PROVIDER.code }, update: {}, create: CARD_PROVIDER })
  const { id } = await prisma.merchantAccount.create({
    data: {
      providerId,
      externalMerchantId: `${CARD_MERCHANT}${tag}-${++merchantSerial}`,
      credentialsEncrypted: {},
      settlementConfigs: {
        create: rules.map(rule => ({
          cardType: 'CREDIT' as const,
          settlementDays: 0,
          settlementDayType: 'CALENDAR_DAYS' as const,
          cutoffTime: '23:59',
          cutoffTimezone: 'America/Mexico_City',
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          effectiveTo: null,
          ...rule,
        })),
      },
    },
    select: { id: true },
  })
  return id
}
/** Borra las cuentas de comercio de prueba de esas etiquetas (antes, sus cobros: `clearSales`). */
export async function clearCardMerchants(tags: string[]): Promise<void> {
  await prisma.merchantAccount.deleteMany({
    where: { OR: tags.map(tag => ({ externalMerchantId: { startsWith: `${CARD_MERCHANT}${tag}-` } })) },
  })
}
let cardSerial = 0
/**
 * Un cobro con tarjeta a la hora `at`, de su propia orden, por la cuenta `merchantAccountId`, con su costo como lo deja el servidor
 * (`venueChargeAmount` ya trae el IVA de la comisión). Con `cost: false`, sin costo (el panel no lo puede ubicar). Lo borra `clearSales`.
 */
export async function seedCardPayment(
  venueId: string,
  merchantAccountId: string,
  at: Date,
  p: {
    amount: number
    tip?: number
    charge?: number | string
    fixed?: number | string
    cardType?: TransactionCardType
    method?: PaymentMethod
    status?: TransactionStatus
    refund?: boolean
    cost?: boolean
  },
): Promise<void> {
  const tip = p.tip ?? 0
  const { id: orderId } = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `T-${Date.now()}-${++cardSerial}`,
      createdAt: at,
      subtotal: Math.abs(p.amount),
      taxAmount: 0,
      tipAmount: Math.abs(tip),
      total: Math.abs(p.amount + tip),
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  await prisma.payment.create({
    data: {
      venueId,
      orderId,
      merchantAccountId,
      amount: p.amount,
      tipAmount: tip,
      method: p.method ?? 'CREDIT_CARD',
      status: p.status ?? 'COMPLETED',
      type: p.refund ? 'REFUND' : 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: p.amount,
      createdAt: at,
      transactionCost:
        p.cost === false
          ? undefined
          : {
              create: {
                merchantAccountId,
                transactionType: p.cardType ?? 'CREDIT',
                amount: p.amount,
                providerRate: 0,
                providerCostAmount: 0,
                venueRate: 0,
                venueChargeAmount: p.charge ?? 0,
                venueFixedFee: p.fixed ?? 0,
                grossProfit: 0,
                profitMargin: 0,
                createdAt: at,
              },
            },
    },
  })
}
/** La cuenta de comercio de prueba de una sucursal para el barrido: la de siempre, o una nueva con la regla del mismo día en su zona. */
async function depositMerchantOf(venueId: string, timezone: string): Promise<string> {
  const found = await prisma.merchantAccount.findFirst({
    where: { externalMerchantId: { startsWith: `${CARD_MERCHANT}${venueId}-` } },
    select: { id: true },
  })
  return found?.id ?? seedCardMerchant(venueId, [{ cutoffTimezone: timezone }])
}
/** La ventana de la lectura de la semana de hoy en esa zona: del lunes menos 21 días (lo que todavía puede caer en ella) al domingo. */
export function depositWindow(timezone: string, now = new Date()): TimeWindow {
  const { weekStart, weekEnd } = venueWeekBounds(venueDayKey(now, timezone), timezone)
  return { from: new Date(weekStart.getTime() - 21 * DAY_MS), to: weekEnd }
}
/** Lo que sale si se colara el depósito de otra sucursal: un importe que no se parece al propio ni al del otro marcador. */
const FOREIGN_DEPOSIT = { 1: 711.11, 2: 722.22 } as const
const depositsWeekFixture: CapabilityFixture = {
  request: { capability: 'deposits_week', day: null, amount: null, time: null, otherVenue: false },
  message: '¿Cuánto me cae en el banco esta semana?',
  grant: { permissions: ['settlements:read'], features: ['ADVANCED_REPORTS'] },
  /**
   * Sin `other`: un cobro con tarjeta de hoy de $1,250.00 con $120.00 de propina y $36.25 de comisión, que cae hoy (la regla del mismo
   * día): $1,333.75 en el día y en el total. Con `other`, uno de $711.11 o $722.22 sin comisión, con la cuenta de esa sucursal.
   */
  async seed(f, other) {
    const venueId = other?.venueId ?? f.northId
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    await clearSales([venueId])
    const merchant = await depositMerchantOf(venueId, timezone)
    const payment = other ? { amount: FOREIGN_DEPOSIT[other.marker] } : { amount: 1250, tip: 120, charge: '36.2500' }
    await seedCardPayment(venueId, merchant, earlierToday(timezone), payment)
    return {
      figures: [fmtMoney(other ? FOREIGN_DEPOSIT[other.marker] : 1333.75)],
      amounts: other ? [FOREIGN_DEPOSIT[other.marker]] : [1250, 120, 1370, 36.25, 1333.75],
      window: depositWindow(timezone),
    }
  },
  /** El único texto libre que imprime es el nombre de la sucursal (los días y los importes salen de sus formatos). */
  async poison(f, value) {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    return { replacedBy: [safeDbText(value)] }
  },
  windowed: ['Payment'],
  forbidden: [],
  /** El tope de tiempo de su transacción: una sentencia sin sucursal ni ventana, la única que no lee datos. */
  allowed: call => call.action === '$executeRawUnsafe' && /^SET LOCAL statement_timeout = \d+$/.test(String((call.args as unknown[])[0])),
}

// ─── C8 · quién abrió o cerró la caja ────────────────────────────────────────────────────────────────────────────────────────

let cashierSerial = 0
/** El correo de las personas que siembra `seedCashier` para esa sucursal: así las encuentran `poison` y `clearCashDrawers`. */
export const cashierEmail = (venueId: string) => `caja-${venueId}-`
/**
 * Una persona del directorio (`Staff`) para las cajas de `venueId`. `membership`: `'venue'` (por omisión) le da su fila en esa sucursal
 * (`StaffVenue`, inactiva con `inactive`); `'organization'`, sólo su fila en la organización de esa sucursal (`StaffOrganization`, como
 * la dueña que no tiene fila en la sucursal); `'none'`, ninguna. La borra `clearCashDrawers` (y `clean()`).
 */
export async function seedCashier(
  venueId: string,
  firstName: string,
  lastName: string,
  how: { membership?: 'venue' | 'organization' | 'none'; inactive?: boolean } = {},
): Promise<string> {
  const { id } = await prisma.staff.create({
    data: { email: `${cashierEmail(venueId)}${Date.now()}-${++cashierSerial}@test.local`, firstName, lastName },
    select: { id: true },
  })
  const membership = how.membership ?? 'venue'
  if (membership === 'venue') await prisma.staffVenue.create({ data: { staffId: id, venueId, role: 'CASHIER', active: !how.inactive } })
  if (membership === 'organization') {
    const { organizationId } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true } })
    await prisma.staffOrganization.create({ data: { staffId: id, organizationId, role: 'OWNER' } })
  }
  return id
}
/**
 * Una caja de `venueId`, como la dejan los escritores: abierta por `openedBy` (un id del directorio, otro, o '') con el nombre guardado
 * `openedByName`; con `closedAt`, cerrada (por `closedBy`, o por nadie: `null`, el cierre del sistema). Lleva fondo, conteo, aparato y
 * nota llenos a propósito: nada de eso puede salir. Devuelve su id.
 */
export async function seedCashDrawer(
  venueId: string,
  d: {
    openedBy: string
    openedByName: string
    openedAt: Date
    closedBy?: string | null
    closedByName?: string | null
    closedAt?: Date | null
    deviceName?: string
    closingNote?: string
  },
): Promise<string> {
  const isClosed = !!d.closedAt
  const { id } = await prisma.cashDrawerSession.create({
    data: {
      venueId,
      deviceName: d.deviceName ?? 'iPad de la barra',
      openedByStaffId: d.openedBy,
      openedByName: d.openedByName,
      openedAt: d.openedAt,
      startingAmount: 1234.56,
      status: isClosed ? 'CLOSED' : 'OPEN',
      ...(isClosed
        ? {
            closedByStaffId: d.closedBy ?? null,
            closedByName: d.closedByName ?? null,
            closedAt: d.closedAt,
            actualAmount: 987.65,
            overShort: -246.91,
            closingNote: d.closingNote ?? 'Cuadró sin novedad',
          }
        : {}),
    },
    select: { id: true },
  })
  return id
}
/** Borra las cajas de esas sucursales (sus movimientos, sus turnos y su bitácora) y las personas que sembró `seedCashier` para ellas. */
export async function clearCashDrawers(venueIds: string[]): Promise<void> {
  await prisma.cashDrawerEvent.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.cashDrawerSession.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.shift.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.activityLog.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.staff.deleteMany({ where: { OR: venueIds.map(venueId => ({ email: { startsWith: cashierEmail(venueId) } })) } })
}
/** Lo que sale si se colara la caja de otra sucursal: quién abrió y quién cerró, con nombres que no se parecen a los propios. */
const FOREIGN_DRAWER = {
  1: { opened: ['Rita', 'Alfa'], closed: ['Sara', 'Alfa'] },
  2: { opened: ['Carla', 'Beta'], closed: ['Bruno', 'Beta'] },
} as const
const cashDrawerFixture: CapabilityFixture = {
  request: { capability: 'cash_drawer', day: 'today', amount: null, time: null, otherVenue: false },
  message: '¿Quién abrió la caja hoy?',
  grant: { permissions: ['shifts:read'] },
  /**
   * Sin `other`: una caja de hoy que abrió Ana López y cerró Luis Pérez un minuto después, las dos personas con su fila en Norte y el
   * nombre guardado igual al del directorio. Con `other`, una igual en esa sucursal, con las personas marcadas de esa sucursal. Lo que
   * imprime son los nombres; el fondo y el conteo (los `amounts`) no salen nunca.
   */
  async seed(f, other) {
    const venueId = other?.venueId ?? f.northId
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    await clearCashDrawers([venueId])
    const { opened, closed } = other ? FOREIGN_DRAWER[other.marker] : ({ opened: ['Ana', 'López'], closed: ['Luis', 'Pérez'] } as const)
    const openedAt = earlierToday(timezone)
    await seedCashDrawer(venueId, {
      openedBy: await seedCashier(venueId, opened[0], opened[1]),
      openedByName: opened.join(' '),
      openedAt,
      closedBy: await seedCashier(venueId, closed[0], closed[1]),
      closedByName: closed.join(' '),
      closedAt: new Date(openedAt.getTime() + 60_000),
    })
    return {
      figures: [opened.join(' '), closed.join(' ')],
      amounts: [1234.56, 987.65, 246.91],
      window: wholeDayBounds('today', { timezone, now: new Date() }),
    }
  },
  /**
   * Los textos libres: el nombre de la sucursal, y quién abrió y quién cerró, guardados en la caja Y en el directorio (iguales, para que
   * pasen la comparación y los detenga la última barrera). Las personas salen «una persona»; la sucursal, lo que dé el filtro estricto.
   */
  async poison(f, value) {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    await prisma.staff.updateMany({ where: { email: { startsWith: cashierEmail(f.northId) } }, data: { firstName: value, lastName: '' } })
    await prisma.cashDrawerSession.updateMany({ where: { venueId: f.northId }, data: { openedByName: value, closedByName: value } })
    return { replacedBy: ['una persona', strictDbText(value, 'tu sucursal')] }
  },
  windowed: ['CashDrawerSession'],
  forbidden: ['CashDrawerEvent', 'Payment', 'Order'],
}

/** Cada tarea C agrega la suya, con la llave de su capacidad. */
export const capabilityFixtures: Record<string, CapabilityFixture> = {
  sales_today: salesTodayFixture,
  deposits_week: depositsWeekFixture,
  find_payment: findPaymentFixture,
  payment_invoice: paymentInvoiceFixture,
  cash_drawer: cashDrawerFixture,
  open_orders: openOrdersFixture,
  reservations_today: reservationsTodayFixture,
  plan_status: planStatusFixture,
}

// ─── El modelo de mentira del worker (Task 9 y T-B43): nada sale a un proveedor ───────────────────────────────────────────────

/** Lo que el worker necesita para llamar al modelo; la llave nunca se usa: el `fetch` es de mentira. */
export const FAKE_SUPPORT_AI_ENV: Record<string, string> = {
  SUPPORT_AI_ENABLED: 'true',
  SUPPORT_AI_MODEL: LUNA_SUPPORT_PRICING.model,
  SUPPORT_AI_PRICING_VERSION: LUNA_SUPPORT_PRICING.version,
  SUPPORT_AI_MONTHLY_USD_LIMIT: '10',
  SUPPORT_OPENAI_API_KEY: 'fixture-never-used',
  WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
}
const FIXTURE_GUIDE_BODY =
  'Para crear un producto abre el menú del panel y toca nuevo producto. Escribe el nombre y el precio, y guarda los cambios.'
/** Una guía aprobada del panel: con la biblioteca vacía el worker contesta «no sé» sin preguntarle al modelo. */
export const fixtureGuide: LibraryGuide = {
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Crear productos',
  summary: 'Da de alta productos y sus precios.',
  steps: ['Da de alta productos y sus precios.'],
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  requiredPermissions: [],
  keywords: [],
  body: FIXTURE_GUIDE_BODY,
  general: false,
  internal: false,
  hash: crypto.createHash('sha256').update(`dashboard/menu/gestionar-productos\n${FIXTURE_GUIDE_BODY}`).digest('hex'),
}
export type FakeAiReply = object | Error
/** Una respuesta del modelo por llamada, en orden. `bodies`: cada petición tal cual; `inputs()`: su `input` ya leído. */
export function fakeSupportAi(replies: FakeAiReply[], onCall?: (n: number) => Promise<void>) {
  const bodies: string[] = []
  const fetcher = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body))
    const n = bodies.length
    await onCall?.(n)
    const reply = replies[n - 1]
    if (!reply) throw new TypeError('fixture: no reply configured for this call')
    if (reply instanceof Error) throw reply
    return new Response(
      JSON.stringify({
        id: `resp_${n}`,
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(reply), annotations: [] }] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  const inputs = () => bodies.map(b => aiInput(JSON.parse(b).input))
  return { fetcher, bodies, inputs, client: createSupportAiClient(getSupportAiConfig()!, fetcher as unknown as typeof fetch) }
}
