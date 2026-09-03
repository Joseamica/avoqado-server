/**
 * Libera los PINs retenidos por filas StaffVenue DADAS DE BAJA (active=false).
 *
 * Por qué existe: el candado de la base es @@unique([venueId, pin]) SIN condición de
 * activo — cuenta también a los dados de baja. Históricamente las bajas conservaban el
 * PIN en su fila inactiva, así que ese PIN quedaba bloqueado para siempre en la sucursal
 * y cualquier intento de reasignarlo reventaba con P2002 → 500 opaco. Caso real:
 * PlayTelecom 2026-08-31, "No se pudo dar el acceso" en la migración de terminal (el PIN
 * de la tienda, 1671, lo retenía una persona dada de baja). Desde ese día los caminos de
 * baja ya ponen pin=null (test: tests/unit/services/staffvenue-baja-libera-pin.test.ts);
 * este script limpia lo que quedó de ANTES.
 *
 *   npx tsx scripts/liberar-pines-retenidos.ts                                  # dry-run
 *   npx tsx scripts/liberar-pines-retenidos.ts --org-id=<id>                    # dry-run, sólo esa organización
 *   npx tsx scripts/liberar-pines-retenidos.ts --apply --actor-staff-id=<id>    # escribe (acepta --org-id)
 *
 * Qué NO toca (deliberado):
 *   - Filas con deactivatedBySeatCap=true: esa gente NO se fue — el tope de asientos la
 *     apagó y un re-upgrade del plan la reactiva automáticamente CON su PIN.
 *   - Filas activas: jamás. Sólo bajas.
 *
 * Re-ejecutable e idempotente: la segunda corrida encuentra 0 filas.
 * --apply escribe un ActivityLog por sucursal afectada (quién perdió qué PIN), con el
 * actor que se pase en --actor-staff-id.
 */
import prisma from '../src/utils/prismaClient'

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]

const VALID_FLAG_PREFIXES = ['--actor-staff-id=', '--org-id=']
const VALID_FLAG_EXACT = ['--apply']

function validarBanderas(argv: string[]): void {
  const desconocidas = argv.filter(
    a => a.startsWith('--') && !VALID_FLAG_EXACT.includes(a) && !VALID_FLAG_PREFIXES.some(prefix => a.startsWith(prefix)),
  )
  if (desconocidas.length) {
    throw new Error(
      `Bandera(s) no reconocida(s): ${desconocidas.join(', ')}.\n` + `Válidas: ${[...VALID_FLAG_EXACT, ...VALID_FLAG_PREFIXES].join(', ')}`,
    )
  }
}

/**
 * El filtro que define "PIN retenido por una baja". Exportado para que el test fije su
 * FORMA: active=false + pin presente + NUNCA las suspensiones por tope de asientos.
 */
export const WHERE_PINES_RETENIDOS = {
  active: false,
  pin: { not: null },
  deactivatedBySeatCap: false,
} as const

/** El filtro completo, opcionalmente acotado a UNA organización (--org-id). */
export function wherePinesRetenidos(orgId?: string) {
  return {
    ...WHERE_PINES_RETENIDOS,
    ...(orgId ? { venue: { organizationId: orgId } } : {}),
  }
}

async function main() {
  validarBanderas(process.argv.slice(2))
  const apply = process.argv.includes('--apply')
  const actorStaffId = arg('actor-staff-id')
  const orgId = arg('org-id')

  if (apply && !actorStaffId) {
    throw new Error('--apply exige --actor-staff-id=<id> (queda en ActivityLog como el actor de la limpieza)')
  }

  const retenidos = await prisma.staffVenue.findMany({
    where: wherePinesRetenidos(orgId),
    select: {
      id: true,
      pin: true,
      endDate: true,
      staff: { select: { id: true, firstName: true, lastName: true, email: true } },
      venue: { select: { id: true, name: true } },
    },
    orderBy: [{ venue: { name: 'asc' } }, { endDate: 'asc' }],
  })

  if (retenidos.length === 0) {
    console.log('✅ No hay PINs retenidos por bajas. Nada que limpiar.')
    return
  }

  console.log(`${apply ? '🔧 APLICANDO' : '🔎 DRY-RUN (nada se escribe; usa --apply para ejecutar)'}\n`)
  const porVenue = new Map<string, typeof retenidos>()
  for (const r of retenidos) {
    const key = r.venue.id
    if (!porVenue.has(key)) porVenue.set(key, [])
    porVenue.get(key)!.push(r)
  }

  for (const [, filas] of porVenue) {
    console.log(`📍 ${filas[0].venue.name} — ${filas.length} PIN(s) retenido(s):`)
    for (const r of filas) {
      const nombre = `${r.staff.firstName} ${r.staff.lastName}`.trim() || r.staff.email
      const baja = r.endDate ? r.endDate.toISOString().slice(0, 10) : 'sin fecha'
      console.log(`   - PIN ${r.pin} · ${nombre} · baja: ${baja}`)
    }
  }
  console.log(`\nTotal: ${retenidos.length} fila(s) en ${porVenue.size} sucursal(es).`)

  if (!apply) return

  await prisma.$transaction(async tx => {
    const result = await tx.staffVenue.updateMany({
      where: { ...wherePinesRetenidos(orgId), id: { in: retenidos.map(r => r.id) } },
      data: { pin: null },
    })
    console.log(`\n✅ Liberados ${result.count} PIN(s).`)
  })

  // Un asiento por sucursal, fuera de la transacción (fire-and-forget no aplica en un
  // script: aquí sí esperamos, pero un fallo del log no revierte la limpieza ya hecha).
  for (const [venueId, filas] of porVenue) {
    await prisma.activityLog
      .create({
        data: {
          action: 'STAFF_PIN_RELEASED_BULK',
          entity: 'StaffVenue',
          entityId: venueId,
          staffId: actorStaffId!,
          venueId,
          data: {
            reason: 'PIN retenido por baja anterior al fix (bloqueaba reasignarlo: @@unique(venueId, pin) cuenta inactivos)',
            released: filas.map(r => ({ staffId: r.staff.id, pin: r.pin })),
          },
        },
      })
      .catch(e => console.warn(`⚠️ ActivityLog falló para venue ${venueId}: ${e.message}`))
  }
}

if (require.main === module) {
  main()
    .catch(e => {
      console.error('💥', e.message)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
