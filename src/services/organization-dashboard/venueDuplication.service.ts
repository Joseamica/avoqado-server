/**
 * «Duplicar tienda»: crea una tienda nueva dentro de la organización copiando la configuración de una suya
 * (diseño `docs/superpowers/specs/2026-11-04-duplicar-tienda-design.md` del workspace; mandan sus secciones
 * «Cambios tras Codex r1/r2 del plan»).
 *
 * Se copia: las 16 columnas permitidas de `Venue`, `VenueSettings`, `VenueModule`, `VenuePaymentConfig` (mismas cuentas
 * de cobro), `VenuePricingStructure`, `VenueRoleConfig`, `VenueRolePermission` y las filas OWNER/ADMIN activas de la
 * modelo cuyo staff sigue activo en la organización (con su `PermissionSet` clonado). El supervisor entra como MANAGER.
 * No se copia: conexiones (Google, Stripe), `VenueFeature`, `VenueCommission` ni nada transaccional.
 */
import { NotificationChannel, NotificationType, Prisma, PrismaClient, StaffRole, VenueStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import { MODULE_CODES, ModuleService, moduleService } from '../modules/module.service'
import * as notificationService from '../dashboard/notification.service'
import { generateSlug, validateSlug } from '../../utils/slugify'
import { nombreChoca } from './venueDuplication.rules'

export const VENUE_DUPLICATED = 'VENUE_DUPLICATED'

/** Lo único de `Venue` que viene de la modelo (Codex r1, punto 3). Todo lo demás nace en el default del esquema. */
const COLUMNAS_DE_LA_MODELO = {
  type: true,
  currency: true,
  timezone: true,
  language: true,
  country: true,
  status: true,
  active: true,
  kycStatus: true,
  operationalRole: true,
  posStatus: true,
  salesEnabled: true,
  whatsappContactMode: true,
  feeType: true,
  feeValue: true,
  planTier: true,
  seatCapExempt: true,
} as const satisfies Prisma.VenueSelect

// ponytail: cuántas tiendas/personas lista el formulario; una organización tiene ~60 hoy. Paginar si alguna pasa de mil.
const TOPE_DE_OPCIONES = 1000

export interface DuplicateVenueInput {
  orgId: string
  actorStaffId: string
  idempotencyKey: string
  templateVenueId: string
  name: string
  address: { address: string; city: string; state: string; zipCode: string; country?: string; latitude: number; longitude: number }
  supervisorStaffId: string
}

export interface DuplicateVenueResult {
  venueId: string
  slug: string
  name: string
}

export async function getVenueDuplicationOptions(orgId: string): Promise<{
  enabled: boolean
  templates: { id: string; name: string; city: string | null }[]
  supervisors: { staffId: string; name: string }[]
}> {
  if (!(await moduleService.isModuleEnabledForOrganization(orgId, MODULE_CODES.VENUE_DUPLICATION))) {
    return { enabled: false, templates: [], supervisors: [] }
  }
  const [templates, staff] = await Promise.all([
    prisma.venue.findMany({
      where: { organizationId: orgId, status: VenueStatus.ACTIVE, active: true },
      select: { id: true, name: true, city: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: TOPE_DE_OPCIONES,
    }),
    prisma.staff.findMany({
      where: {
        active: true,
        organizations: { some: { organizationId: orgId, isActive: true } },
        venues: { some: { role: StaffRole.MANAGER, active: true, venue: { organizationId: orgId } } },
      },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      take: TOPE_DE_OPCIONES,
    }),
  ])
  return { enabled: true, templates, supervisors: staff.map(p => ({ staffId: p.id, name: `${p.firstName} ${p.lastName}`.trim() })) }
}

export async function duplicateVenue(input: DuplicateVenueInput): Promise<DuplicateVenueResult> {
  const { orgId, templateVenueId, actorStaffId, idempotencyKey } = input

  const resultado = await prisma.$transaction(
    async tx => {
      // Un duplicado a la vez por organización: el doble clic espera aquí y luego ve la bitácora del primero.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`venue-duplication:${orgId}`}))::text`

      const previa = await tx.activityLog.findFirst({
        where: {
          action: VENUE_DUPLICATED,
          organizationId: orgId,
          // ponytail: ventana de 30 días para que la búsqueda use el índice de createdAt; la llave es por apertura del diálogo.
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          data: { path: ['idempotencyKey'], equals: idempotencyKey },
        },
        orderBy: { createdAt: 'desc' },
        select: { entityId: true },
      })
      if (previa?.entityId) {
        const hecha = await tx.venue.findFirst({
          where: { id: previa.entityId, organizationId: orgId },
          select: { id: true, slug: true, name: true },
        })
        if (hecha) return { venue: hecha, modelo: null }
      }

      if (!(await new ModuleService(tx as unknown as PrismaClient).isModuleEnabledForOrganization(orgId, MODULE_CODES.VENUE_DUPLICATION))) {
        throw new ForbiddenError('La duplicación de tiendas no está activa para esta organización', 'module_disabled')
      }

      const modelo = await tx.venue.findFirst({
        where: { id: templateVenueId, organizationId: orgId },
        select: { ...COLUMNAS_DE_LA_MODELO, id: true, name: true },
      })
      if (!modelo) throw new NotFoundError('No encontramos esa tienda en tu organización')
      if (modelo.status !== VenueStatus.ACTIVE || !modelo.active) {
        throw new BadRequestError('Esa tienda ya no está activa; elige otra', 'TEMPLATE_NOT_ACTIVE')
      }

      // Lo contratado pertenece a su tienda: si la modelo depende de ello, la nueva no tendría el mismo plan.
      const ahora = new Date()
      // Contrato: cualquiera sin `endedAt` (aunque su cancelación ya pasó, su concesión puede seguir viva). Concesión:
      // la misma condición de «viva» que `getContractBaseTier` (basePlan.service), con o sin contrato.
      const [featureActiva, contratoSinTerminar, concesionViva] = await Promise.all([
        tx.venueFeature.findFirst({
          where: { venueId: modelo.id, active: true, suspendedAt: null, OR: [{ endDate: null }, { endDate: { gte: ahora } }] },
          select: { id: true },
        }),
        tx.hybridContract.findFirst({ where: { venueId: modelo.id, endedAt: null }, select: { id: true } }),
        tx.capabilityGrant.findFirst({
          where: { venueId: modelo.id, revokedAt: null, startsAt: { lte: ahora }, endsAt: { gt: ahora } },
          select: { id: true },
        }),
      ])
      if (featureActiva || contratoSinTerminar || concesionViva) {
        throw new BadRequestError('Esta tienda tiene un plan contratado; para duplicarla habla con Avoqado', 'TEMPLATE_HAS_PAID_PLAN')
      }

      const supervisor = await tx.staff.findFirst({
        where: { id: input.supervisorStaffId, active: true, organizations: { some: { organizationId: orgId, isActive: true } } },
        select: { id: true },
      })
      if (!supervisor) throw new BadRequestError('Esa persona no está activa en tu organización', 'SUPERVISOR_NOT_IN_ORG')

      // ponytail: compara contra todas las tiendas de la organización (~60); es una revisión de exactitud, no un listado.
      const existentes = await tx.venue.findMany({ where: { organizationId: orgId }, select: { name: true } })
      const choque = nombreChoca(
        input.name,
        existentes.map(v => v.name),
      )
      if (choque.choca) {
        throw new BadRequestError(
          choque.numero ? `Ya hay una tienda con el número ${choque.numero}` : 'Ya hay una tienda con ese nombre',
          'VENUE_NAME_TAKEN',
        )
      }

      const { id: _id, name: _name, ...columnas } = modelo
      // Campo por campo: nada de la entrada fuera de la dirección llega a la tienda (plan, tarifa, Stripe…).
      const a = input.address
      const venue = await crearConSlugLibre(tx, input.name, {
        ...columnas,
        address: a.address,
        city: a.city,
        state: a.state,
        zipCode: a.zipCode,
        country: a.country ?? columnas.country,
        latitude: a.latitude,
        longitude: a.longitude,
        organizationId: orgId,
        name: input.name.trim(),
        status: VenueStatus.ACTIVE,
        active: true,
      })

      await copiarConfiguracion(tx, modelo.id, venue.id)
      await copiarGente(tx, orgId, modelo.id, venue.id, supervisor.id)

      // Esperada y sin try/catch: es la llave del reintento; si falla, la tienda no queda.
      await tx.activityLog.create({
        data: {
          action: VENUE_DUPLICATED,
          entity: 'Venue',
          entityId: venue.id,
          staffId: actorStaffId,
          venueId: venue.id,
          organizationId: orgId,
          data: { templateVenueId: modelo.id, organizationId: orgId, idempotencyKey, name: venue.name },
        },
      })
      return { venue, modelo: modelo.name }
    },
    { maxWait: 10_000, timeout: 30_000 },
  )

  if (resultado.modelo !== null) await avisarASuperadmins(actorStaffId, resultado.venue, resultado.modelo)
  return { venueId: resultado.venue.id, slug: resultado.venue.slug, name: resultado.venue.name }
}

const slugTomado = (e: unknown) =>
  (e as { code?: string }).code === 'P2002' && String((e as { meta?: { target?: unknown } }).meta?.target ?? '').includes('slug')

/**
 * Crea el `Venue` con el slug de `createVenueForOrganization` (del nombre; con sufijo si está tomado o reservado).
 * El slug es único en TODA la plataforma y el candado es sólo de la organización: si otra tienda ya lo tiene (o lo
 * toma a la vez), se regresa al punto de guardado y se prueba con sufijo, sin perder la transacción.
 */
async function crearConSlugLibre(
  tx: Prisma.TransactionClient,
  nombre: string,
  data: Omit<Prisma.VenueUncheckedCreateInput, 'slug'>,
): Promise<{ id: string; slug: string; name: string }> {
  const base = generateSlug(nombre) || 'tienda'
  const primero = validateSlug(base).isValid ? base : `${base}-tienda`
  for (let intento = 0; ; intento++) {
    const slug = intento === 0 ? primero : `${base}-${Math.random().toString(36).substring(2, 6)}`
    await tx.$executeRaw`SAVEPOINT crear_tienda`
    try {
      const venue = await tx.venue.create({ data: { ...data, slug }, select: { id: true, slug: true, name: true } })
      await tx.$executeRaw`RELEASE SAVEPOINT crear_tienda`
      return venue
    } catch (error) {
      if (intento >= 4 || !slugTomado(error)) throw error
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT crear_tienda`
    }
  }
}

const FUERA_DE_LA_COPIA = new Set(['id', 'venueId', 'createdAt', 'updatedAt', 'enabledAt'])
/** Columnas que son de la tienda modelo y no de su configuración: la nueva las deja en su default. */
const NO_SE_COPIA: Partial<Record<Prisma.ModelName, readonly string[]>> = {
  VenueSettings: ['googleReviewLink'], // la liga de reseñas de Google del lugar de la modelo
}
/** Columnas Json por modelo, leídas una vez del esquema: un Json nulo se escribe como DbNull. */
const COLUMNAS_JSON = new Map(
  Prisma.dmmf.datamodel.models.map(m => [m.name, new Set(m.fields.filter(f => f.type === 'Json').map(f => f.name))]),
)

/** Fila de configuración lista para otra tienda: sin id, venueId ni fechas de registro. */
function copia<T>(modelo: Prisma.ModelName, fila: object, venueId: string): T {
  const json = COLUMNAS_JSON.get(modelo)
  const fuera = NO_SE_COPIA[modelo] ?? []
  const datos: Record<string, unknown> = { venueId }
  for (const [k, v] of Object.entries(fila)) {
    if (FUERA_DE_LA_COPIA.has(k) || fuera.includes(k)) continue
    datos[k] = v === null && json?.has(k) ? Prisma.DbNull : v
  }
  return datos as T
}

async function copiarConfiguracion(tx: Prisma.TransactionClient, desde: string, hacia: string): Promise<void> {
  const where = { venueId: desde }
  const [settings, modulos, pago, tarifas, puestos, permisos] = await Promise.all([
    tx.venueSettings.findUnique({ where }),
    tx.venueModule.findMany({ where }),
    tx.venuePaymentConfig.findUnique({ where }),
    tx.venuePricingStructure.findMany({ where }),
    tx.venueRoleConfig.findMany({ where }),
    tx.venueRolePermission.findMany({ where }),
  ])
  if (settings) await tx.venueSettings.create({ data: copia<Prisma.VenueSettingsUncheckedCreateInput>('VenueSettings', settings, hacia) })
  if (pago)
    await tx.venuePaymentConfig.create({ data: copia<Prisma.VenuePaymentConfigUncheckedCreateInput>('VenuePaymentConfig', pago, hacia) })
  if (modulos.length)
    await tx.venueModule.createMany({ data: modulos.map(f => copia<Prisma.VenueModuleCreateManyInput>('VenueModule', f, hacia)) })
  if (tarifas.length)
    await tx.venuePricingStructure.createMany({
      data: tarifas.map(f => copia<Prisma.VenuePricingStructureCreateManyInput>('VenuePricingStructure', f, hacia)),
    })
  if (puestos.length)
    await tx.venueRoleConfig.createMany({
      data: puestos.map(f => copia<Prisma.VenueRoleConfigCreateManyInput>('VenueRoleConfig', f, hacia)),
    })
  if (permisos.length)
    await tx.venueRolePermission.createMany({
      data: permisos.map(f => copia<Prisma.VenueRolePermissionCreateManyInput>('VenueRolePermission', f, hacia)),
    })
}

/** OWNER/ADMIN activos de la modelo que siguen activos en la organización, con su PermissionSet clonado; más el supervisor. */
async function copiarGente(tx: Prisma.TransactionClient, orgId: string, desde: string, hacia: string, supervisorId: string): Promise<void> {
  const filas = await tx.staffVenue.findMany({
    where: {
      venueId: desde,
      active: true,
      role: { in: [StaffRole.OWNER, StaffRole.ADMIN] },
      staff: { active: true, organizations: { some: { organizationId: orgId, isActive: true } } },
    },
    select: { staffId: true, role: true, pin: true, permissions: true, permissionSetId: true },
  })

  const conjuntos = new Map<string, string>()
  const ids = [...new Set(filas.map(f => f.permissionSetId).filter((id): id is string => !!id))]
  for (const set of await tx.permissionSet.findMany({ where: { id: { in: ids }, venueId: desde } })) {
    const clon = await tx.permissionSet.create({
      data: copia<Prisma.PermissionSetUncheckedCreateInput>('PermissionSet', set, hacia),
      select: { id: true },
    })
    conjuntos.set(set.id, clon.id)
  }

  const data: Prisma.StaffVenueCreateManyInput[] = filas.map(f => ({
    staffId: f.staffId,
    venueId: hacia,
    role: f.role,
    pin: f.pin,
    permissions: f.permissions ?? Prisma.DbNull,
    // Nunca se comparte el id de la modelo: un conjunto ajeno a ella se suelta.
    permissionSetId: f.permissionSetId ? (conjuntos.get(f.permissionSetId) ?? null) : null,
  }))
  // Si el supervisor ya entra como OWNER/ADMIN, se queda con ese rol.
  if (!filas.some(f => f.staffId === supervisorId)) data.push({ staffId: supervisorId, venueId: hacia, role: StaffRole.MANAGER })
  await tx.staffVenue.createMany({ data })
}

/** Después del commit; nunca lanza (patrón de `notifySuperadminsNewKycSubmission`). */
async function avisarASuperadmins(actorStaffId: string, venue: { id: string; name: string }, modelo: string): Promise<void> {
  try {
    const [actor, superadmins] = await Promise.all([
      prisma.staff.findUnique({ where: { id: actorStaffId }, select: { firstName: true, lastName: true } }),
      prisma.staffVenue.findMany({
        where: { role: StaffRole.SUPERADMIN, active: true },
        select: { staffId: true },
        distinct: ['staffId'],
        take: 100,
      }),
    ])
    const quien = actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'Alguien'
    for (const { staffId } of superadmins) {
      await notificationService.sendNotification({
        recipientId: staffId,
        type: NotificationType.ALERT,
        title: 'Tienda nueva por duplicado',
        message: `${quien} creó ${venue.name} copiando ${modelo}`,
        entityType: 'Venue',
        entityId: venue.id,
        metadata: { venueId: venue.id, venueName: venue.name, templateVenueName: modelo },
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      })
    }
  } catch (error) {
    logger.error('No se pudo avisar a los superadmins de la tienda duplicada', { venueId: venue.id, error })
  }
}
