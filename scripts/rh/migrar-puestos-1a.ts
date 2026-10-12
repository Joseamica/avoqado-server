/**
 * Migración de RH 1a (spec §8): los roles de hoy se vuelven puestos y asignaciones. Idempotente: se puede repetir.
 *
 * Uso: npx ts-node -T -r tsconfig-paths/register scripts/rh/migrar-puestos-1a.ts [--venue <id>] [--dry-run]
 * (-T = sin chequeo de tipos: con él, ts-node revisa todo el proyecto y se queda sin memoria; medido el 11-oct.)
 *
 * 🔴 En producción sólo con el OK del founder, primero con --dry-run (plan RH 1a, § Despliegue).
 * Imprime el nombre de la base antes de tocar nada: léelo.
 */
import prisma from '../../src/utils/prismaClient'
import { migrarSede } from '../../src/services/dashboard/rh/migracion'
import { pagoGenericoPermitido } from '../../src/services/dashboard/rh/marcaBlanca'

async function main() {
  const i = process.argv.indexOf('--venue')
  const solo = i >= 0 ? process.argv[i + 1] : undefined
  if (i >= 0 && !solo) throw new Error('--venue necesita un id')
  const dry = process.argv.includes('--dry-run')
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL')
  console.log(`Base: ${new URL(process.env.DATABASE_URL).pathname.slice(1)} · dry-run: ${dry}`)
  let cursor: string | undefined
  for (;;) {
    const venues = await prisma.venue.findMany({
      where: solo ? { id: solo } : {},
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
      take: 50,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (venues.length === 0) break
    for (const v of venues) {
      if (!(await pagoGenericoPermitido(v.id))) {
        console.log(`omitida (marca blanca): ${v.name}`)
        continue
      }
      if (dry) {
        console.log(`revisaría: ${v.name}`)
        continue
      }
      try {
        const r = await migrarSede(v.id)
        console.log(`${v.name}: ${r.puestosCreados} puestos, ${r.asignacionesCreadas} asignaciones`)
      } catch (e) {
        // Una sede que falla no frena a las demás; su transacción se revirtió entera y la siguiente corrida la reintenta.
        console.error(`FALLÓ ${v.name} (${v.id}): ${e instanceof Error ? e.message : e}`)
        process.exitCode = 1
      }
    }
    cursor = venues[venues.length - 1].id
    if (solo) break
  }
  // Spec §8.5: personas sólo de organización (sin ninguna sede) no reciben asignación; se cuentan personas, no membresías.
  const soloOrg = await prisma.staff.count({ where: { organizations: { some: {} }, venues: { none: {} } } })
  console.log(`Personas sólo de organización (sin sede, no reciben asignación): ${soloOrg}`)
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
