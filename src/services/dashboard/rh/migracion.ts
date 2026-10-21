import { Prisma, StaffRole, VenueType } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { DEFAULT_ROLE_DISPLAY_NAMES, SECTOR_ROLE_DEFAULTS } from '../../../utils/roleDisplay'
import { categoryOfVenueType } from '../../../utils/venueTypeCategory'
import { venueDayKey } from '../../../utils/venueDateKeys'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { fechaComoDbDate } from '../staffPay/periodos'
import { tomarCandadoPersona } from './candado'
import { checaPorDefault } from './checaAsistencia'
import { Fecha } from './vigencias'

/*
 * Migración de RH 1a (spec §8): los roles de hoy se vuelven puestos. Idempotente por `migrationKey` y no destructiva:
 * - una asignación por cada StaffVenue ACTIVO (`sv:<staffVenueId>`), relación «Sin definir», desde el día de su alta;
 * - el puesto de un rol (`role:<venueId>:<ROL>`) sólo nace si alguien lo va a recibir en esa corrida;
 * - nunca recrea una clave que ya exista, aunque un humano la haya editado o archivado;
 * - SUPERADMIN es interno de Avoqado y el negocio no lo ve: no se migra.
 */

const TIMEOUT_MS = 60_000
const limpiar = (s: string) => s.trim().replace(/\s+/g, ' ')

/**
 * El nombre que el dueño ya ve para ese rol: su `displayName` (aunque el rol esté oculto en los selectores, el equipo lo
 * sigue mostrando así: venueRoleConfig.dashboard.service.ts:233), si no el default del giro, si no el genérico.
 * El giro sale de `VenueType` con `categoryOfVenueType` (el mismo que usan los sugeridos de puestos.service.ts).
 */
function nombreDelRol(role: StaffRole, venueType: VenueType, roleConfigs: Array<{ role: StaffRole; displayName: string }>): string {
  const propio = limpiar(roleConfigs.find(c => c.role === role)?.displayName ?? '')
  return propio || SECTOR_ROLE_DEFAULTS[categoryOfVenueType(venueType)]?.es?.[role] || DEFAULT_ROLE_DISPLAY_NAMES[role]
}

export function planDeMigracion(input: {
  venueId: string
  timezone: string
  venueType: VenueType
  roleConfigs: Array<{ role: StaffRole; displayName: string }>
  staffVenues: Array<{ id: string; staffId: string; role: StaffRole; active: boolean; startDate: Date }>
  existentes: Set<string>
}): {
  puestos: Array<{ migrationKey: string; name: string; suggestedRole: StaffRole }>
  asignaciones: Array<{ migrationKey: string; staffId: string; puestoKey: string; effectiveFrom: Fecha }>
} {
  const activos = input.staffVenues.filter(s => s.active && s.role !== StaffRole.SUPERADMIN)
  const roles = [...new Set(activos.map(s => s.role))].sort()
  const usados = new Set<string>()
  const puestos: Array<{ migrationKey: string; name: string; suggestedRole: StaffRole }> = []
  // Todos los roles en uso apartan su nombre, también los ya migrados: así el nombre sale igual en cada corrida.
  for (const role of roles) {
    const migrationKey = `role:${input.venueId}:${role}`
    let name = nombreDelRol(role, input.venueType, input.roleConfigs)
    if (usados.has(name.toLowerCase())) name = `${name} (${role})`
    usados.add(name.toLowerCase())
    if (!input.existentes.has(migrationKey)) puestos.push({ migrationKey, name, suggestedRole: role })
  }
  const asignaciones = activos
    .filter(s => !input.existentes.has(`sv:${s.id}`))
    .map(s => ({
      migrationKey: `sv:${s.id}`,
      staffId: s.staffId,
      puestoKey: `role:${input.venueId}:${s.role}`,
      effectiveFrom: venueDayKey(s.startDate, input.timezone),
    }))
  return { puestos, asignaciones }
}

/** Lo que una corrida haría en una sede. `positionId: null` = el puesto se crea en esa misma corrida. */
export interface PlanDeSede {
  puestos: Array<{ migrationKey: string; name: string; suggestedRole: StaffRole }>
  asignaciones: Array<{
    migrationKey: string
    staffId: string
    puestoKey: string
    effectiveFrom: Fecha
    positionId: string | null
    tracksAttendance: boolean
  }>
  /** Personas omitidas porque ya tienen una asignación en la sede (puesta a mano). */
  yaTienenPuesto: string[]
  /** Personas omitidas porque un humano archivó el puesto migrado de su rol. */
  puestoArchivado: string[]
}

/** Sólo LEE: la usan la corrida real y el ensayo, así el ensayo muestra exactamente lo que la corrida haría. */
async function planearSede(tx: Prisma.TransactionClient, venueId: string): Promise<PlanDeSede> {
  const venue = await tx.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true, type: true } })
  const staffVenues = await tx.staffVenue.findMany({
    where: { venueId, active: true },
    select: { id: true, staffId: true, role: true, active: true, startDate: true },
    orderBy: { id: 'asc' },
    take: 5001,
  })
  // Una sede con más de 5,000 personas activas no existe hoy; si aparece, se detiene en vez de migrar a medias.
  if (staffVenues.length > 5000) throw new Error(`Sede ${venueId}: más de 5,000 personas activas; migrarla por partes`)
  // @@unique([venueId, role]): a lo sumo una por rol.
  const roleConfigs = await tx.venueRoleConfig.findMany({ where: { venueId }, select: { role: true, displayName: true }, take: 50 })
  const svKeys = staffVenues.map(s => `sv:${s.id}`)
  const [migrados, asignadas] = await Promise.all([
    // La clave es única por sede y rol: a lo sumo un puesto migrado por rol.
    tx.staffPosition.findMany({
      where: { venueId, migrationKey: { not: null } },
      select: { id: true, migrationKey: true, archivedAt: true, tracksAttendanceDefault: true },
      take: 50,
    }),
    tx.staffAssignment.findMany({ where: { migrationKey: { in: svKeys } }, select: { migrationKey: true }, take: svKeys.length }),
  ])
  const existentes = new Set([...migrados, ...asignadas].map(x => x.migrationKey!))
  const base = planDeMigracion({ venueId, timezone: venue.timezone, venueType: venue.type, roleConfigs, staffVenues, existentes })

  // Quien YA tiene cualquier asignación en la sede no recibe otra. Una fila por persona (GROUP BY): un `take` sobre las
  // asignaciones cortaría a alguien cuando otra persona tiene varias versiones.
  const ids = base.asignaciones.map(a => a.staffId)
  const conPuesto = new Set(
    ids.length ? (await tx.staffAssignment.groupBy({ by: ['staffId'], where: { venueId, staffId: { in: ids } } })).map(r => r.staffId) : [],
  )
  const porClave = new Map(migrados.map(p => [p.migrationKey!, p]))
  const plan: PlanDeSede = { puestos: [], asignaciones: [], yaTienenPuesto: [], puestoArchivado: [] }
  for (const a of base.asignaciones) {
    if (conPuesto.has(a.staffId)) {
      plan.yaTienenPuesto.push(a.staffId)
      continue
    }
    const puesto = porClave.get(a.puestoKey)
    if (puesto?.archivedAt) {
      plan.puestoArchivado.push(a.staffId) // un humano lo archivó: sus personas no se reasignan
      continue
    }
    // El checador de la asignación sale del puesto, como en el alta manual (un puesto nuevo nace con el default de su rol:
    // «Solo ver» no checa). La clave es `role:<venueId>:<ROL>`.
    const rol = a.puestoKey.split(':')[2] as StaffRole
    plan.asignaciones.push({
      ...a,
      positionId: puesto?.id ?? null,
      tracksAttendance: puesto?.tracksAttendanceDefault ?? checaPorDefault(rol),
    })
  }

  // Un puesto sólo nace si alguien lo recibe en esta corrida (nada de un «Mesero (WAITER)» vacío junto al «Mesero» que el
  // dueño armó a mano). Si después llega alguien que lo necesita, otra corrida lo crea.
  const necesarios = new Set(plan.asignaciones.filter(a => !a.positionId).map(a => a.puestoKey))
  // Nombre ya usado por un puesto activo (manual o renombrado) o por otro de esta corrida: «Nombre (ROL)», «Nombre (ROL) 2»…
  const tomados = new Set<string>()
  const ocupado = async (n: string) =>
    tomados.has(n.toLowerCase()) ||
    !!(await tx.staffPosition.findFirst({
      where: { venueId, archivedAt: null, name: { equals: n, mode: 'insensitive' } },
      select: { id: true },
    }))
  for (const x of base.puestos.filter(p => necesarios.has(p.migrationKey))) {
    const conRol = x.name.endsWith(` (${x.suggestedRole})`) ? x.name : `${x.name} (${x.suggestedRole})`
    let name = x.name
    if (await ocupado(name)) name = conRol
    for (let k = 2; await ocupado(name); k++) name = `${conRol} ${k}`
    tomados.add(name.toLowerCase())
    plan.puestos.push({ ...x, name })
  }
  return plan
}

/** Ensayo (`--dry-run`): la misma lectura que `migrarSede`, en una transacción READ ONLY (Postgres rechaza cualquier escritura). */
export async function ensayarSede(venueId: string): Promise<PlanDeSede> {
  return prisma.$transaction(
    async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      return planearSede(tx, venueId)
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: TIMEOUT_MS },
  )
}

/** Una sede por transacción (si el script se corta, la siguiente corrida sigue). Nunca borra ni recrea lo que un humano quitó. */
export async function migrarSede(venueId: string): Promise<{ puestosCreados: number; asignacionesCreadas: number }> {
  // SERIALIZABLE como el alta manual: con READ COMMITTED, la API (que toma su foto ANTES de esperar el candado) podía no ver
  // la asignación de la migración e insertar otra encima (Codex r3-A5; periodosGuardados.ts:46).
  return withSerializableRetry(
    async tx => {
      const plan = await planearSede(tx, venueId)
      const nuevos = new Map<string, string>()
      for (const x of plan.puestos) {
        const p = await tx.staffPosition.create({
          data: {
            venueId,
            name: x.name,
            suggestedRole: x.suggestedRole,
            tracksAttendanceDefault: checaPorDefault(x.suggestedRole),
            migrationKey: x.migrationKey,
          },
          select: { id: true },
        })
        nuevos.set(x.migrationKey, p.id)
      }
      for (const x of plan.asignaciones) {
        // El MISMO candado por persona que el alta manual: API y script se forman en fila al escribir. «Ya tiene puesto» se
        // leyó en la foto de esta transacción (SERIALIZABLE), no después del candado: si la API escribe a esta persona en
        // medio, SSI deja un resultado equivalente a hacerlas una tras otra (aborta una con 40001 y withSerializableRetry
        // la repite con foto nueva).
        await tomarCandadoPersona(tx, venueId, x.staffId)
        await tx.staffAssignment.create({
          data: {
            venueId,
            staffId: x.staffId,
            positionId: x.positionId ?? nuevos.get(x.puestoKey)!,
            relation: null,
            effectiveFrom: fechaComoDbDate(x.effectiveFrom),
            tracksAttendance: x.tracksAttendance,
            migrationKey: x.migrationKey,
          },
        })
      }
      return { puestosCreados: plan.puestos.length, asignacionesCreadas: plan.asignaciones.length }
    },
    { timeoutMs: TIMEOUT_MS },
  )
}
