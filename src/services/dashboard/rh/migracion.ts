import { StaffRole, VenueType } from '@prisma/client'
import { DEFAULT_ROLE_DISPLAY_NAMES, SECTOR_ROLE_DEFAULTS } from '../../../utils/roleDisplay'
import { categoryOfVenueType } from '../../../utils/venueTypeCategory'
import { venueDayKey } from '../../../utils/venueDateKeys'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { fechaComoDbDate } from '../staffPay/periodos'
import { tomarCandadoPersona } from './candado'
import { Fecha } from './vigencias'

/*
 * Migración de RH 1a (spec §8): los roles de hoy se vuelven puestos. Idempotente por `migrationKey` y no destructiva:
 * - un puesto por rol en uso de cada sede (`role:<venueId>:<ROL>`);
 * - una asignación por cada StaffVenue ACTIVO (`sv:<staffVenueId>`), relación «Sin definir», desde el día de su alta;
 * - nunca recrea una clave que ya exista, aunque un humano la haya editado o archivado.
 */

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
  const activos = input.staffVenues.filter(s => s.active)
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

/** Una sede por transacción (si el script se corta, la siguiente corrida sigue). Nunca borra ni recrea lo que un humano quitó. */
export async function migrarSede(venueId: string): Promise<{ puestosCreados: number; asignacionesCreadas: number }> {
  // SERIALIZABLE como el alta manual: con READ COMMITTED, la API (que toma su foto ANTES de esperar el candado) podía no ver
  // la asignación de la migración e insertar otra encima (Codex r3-A5; periodosGuardados.ts:46).
  return withSerializableRetry(
    async tx => {
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
      const claves = [...staffVenues.map(s => `sv:${s.id}`), ...new Set(staffVenues.map(s => `role:${venueId}:${s.role}`))]
      const [p, a] = await Promise.all([
        tx.staffPosition.findMany({ where: { migrationKey: { in: claves } }, select: { migrationKey: true }, take: claves.length }),
        tx.staffAssignment.findMany({ where: { migrationKey: { in: claves } }, select: { migrationKey: true }, take: claves.length }),
      ])
      const existentes = new Set([...p, ...a].map(x => x.migrationKey!))
      const plan = planDeMigracion({ venueId, timezone: venue.timezone, venueType: venue.type, roleConfigs, staffVenues, existentes })

      // Nombre ya usado por un puesto activo (creado a mano o renombrado): se prueba «Nombre (ROL)», luego «Nombre (ROL) 2»…
      const ocupado = async (n: string) =>
        !!(await tx.staffPosition.findFirst({
          where: { venueId, archivedAt: null, name: { equals: n, mode: 'insensitive' } },
          select: { id: true },
        }))
      for (const x of plan.puestos) {
        const conRol = x.name.endsWith(` (${x.suggestedRole})`) ? x.name : `${x.name} (${x.suggestedRole})`
        let name = x.name
        if (await ocupado(name)) name = conRol
        for (let k = 2; await ocupado(name); k++) name = `${conRol} ${k}`
        await tx.staffPosition.create({ data: { venueId, name, suggestedRole: x.suggestedRole, migrationKey: x.migrationKey } })
      }

      // Sólo puestos migrados que siguen ACTIVOS: si un humano archivó el puesto, sus personas no se reasignan.
      // A lo sumo uno por rol (la clave es única por sede y rol).
      const migrados = await tx.staffPosition.findMany({
        where: { venueId, migrationKey: { not: null }, archivedAt: null },
        select: { id: true, migrationKey: true },
        take: 50,
      })
      const porClave = new Map(migrados.map(x => [x.migrationKey!, x.id]))
      let asignacionesCreadas = 0
      for (const x of plan.asignaciones) {
        const positionId = porClave.get(x.puestoKey)
        if (!positionId) continue // su puesto se archivó: no se recrea
        // El MISMO candado por persona que toma el alta manual: API y script se forman en fila.
        await tomarCandadoPersona(tx, venueId, x.staffId)
        // Bajo el candado y por persona (sin tope global): quien YA tiene cualquier asignación en la sede no recibe otra.
        const yaTiene = await tx.staffAssignment.findFirst({ where: { venueId, staffId: x.staffId }, select: { id: true } })
        if (yaTiene) continue
        await tx.staffAssignment.create({
          data: {
            venueId,
            staffId: x.staffId,
            positionId,
            relation: null,
            effectiveFrom: fechaComoDbDate(x.effectiveFrom),
            migrationKey: x.migrationKey,
          },
        })
        asignacionesCreadas++
      }
      return { puestosCreados: plan.puestos.length, asignacionesCreadas }
    },
    { timeoutMs: 60_000 },
  )
}
