/**
 * Migración de RH 1a (spec §8): los roles de hoy se vuelven puestos y asignaciones. Idempotente: se puede repetir.
 *
 * Uso:
 *   Ensayo (sólo lee):  npx ts-node -T -r tsconfig-paths/register scripts/rh/migrar-puestos-1a.ts --dry-run [--venue <id>]
 *   De verdad:          npx ts-node -T -r tsconfig-paths/register scripts/rh/migrar-puestos-1a.ts --confirmar-base <base> [--venue <id>]
 * (-T = sin chequeo de tipos: con él, ts-node revisa todo el proyecto y se queda sin memoria; medido el 11-oct.)
 *
 * 🔴 En producción sólo con el OK del founder, primero con --dry-run (plan RH 1a, § Despliegue). Para escribir hay que
 * repetir el nombre de la base que imprime el ensayo: así nadie migra la base equivocada por un DATABASE_URL olvidado.
 */
import { VenueStatus } from '@prisma/client'
import prisma from '../../src/utils/prismaClient'
import { ensayarSede, migrarSede } from '../../src/services/dashboard/rh/migracion'
import { pagoGenericoPermitido } from '../../src/services/dashboard/rh/marcaBlanca'

// La demo pública se borra sola y una sede cerrada es inmutable: ninguna recibe puestos.
const EXCLUIDAS: Partial<Record<VenueStatus, string>> = { LIVE_DEMO: 'demo pública', CLOSED: 'sede cerrada' }
const ESTADOS_EXCLUIDOS = Object.keys(EXCLUIDAS) as VenueStatus[]

const USO = 'Sólo se aceptan --dry-run, --venue <id> y --confirmar-base <base> (el valor va separado por espacio, sin «=»).'

/** Lee los argumentos; cualquier cosa fuera de los tres conocidos es un error (un `--venue=<id>` mal escrito migraría TODAS las sedes). */
function leerArgumentos(args: string[]): { solo?: string; confirmada?: string; dry: boolean } {
  const r: { solo?: string; confirmada?: string; dry: boolean } = { dry: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry-run') r.dry = true
    else if (a === '--venue' || a === '--confirmar-base') {
      const valor = args[++i]
      if (!valor || valor.startsWith('--')) throw new Error(`${a} necesita un valor. ${USO}`)
      if (a === '--venue') r.solo = valor
      else r.confirmada = valor
    } else throw new Error(`Argumento desconocido: «${a}». ${USO}`)
  }
  return r
}

async function main() {
  let args: ReturnType<typeof leerArgumentos>
  try {
    args = leerArgumentos(process.argv.slice(2))
  } catch (e) {
    console.error(`No se hizo nada. ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
    return
  }
  const { solo, confirmada, dry } = args
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL')
  const url = new URL(process.env.DATABASE_URL)
  const base = url.pathname.slice(1)
  // Nunca usuario ni contraseña en pantalla: sólo host, puerto y base.
  console.log(`Base: ${base} · host: ${url.hostname}:${url.port || '5432'} · dry-run: ${dry}`)
  if (!dry && confirmada !== base) {
    console.error(
      `No se escribió nada. Para migrar de verdad repite el nombre de la base: --confirmar-base ${base}\n` +
        'Para sólo revisar qué haría, usa --dry-run.',
    )
    process.exitCode = 1
    return
  }
  if (!solo) {
    const omitidas = await prisma.venue.count({ where: { status: { in: ESTADOS_EXCLUIDOS } } })
    console.log(`Sedes omitidas por estado (demo pública o cerrada): ${omitidas}`)
  }

  const total = { sedes: 0, puestos: 0, asignaciones: 0, yaTienenPuesto: 0, puestoArchivado: 0, fallidas: 0 }
  let cursor: string | undefined
  for (;;) {
    const venues = await prisma.venue.findMany({
      where: solo ? { id: solo } : { status: { notIn: ESTADOS_EXCLUIDOS } },
      select: { id: true, name: true, status: true },
      orderBy: { id: 'asc' },
      take: 50,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (venues.length === 0) {
      if (solo && !cursor) console.log(`No existe la sede ${solo}.`)
      break
    }
    for (const v of venues) {
      const porEstado = EXCLUIDAS[v.status]
      if (porEstado) {
        console.log(`omitida (${porEstado}): ${v.name}`)
        continue
      }
      if (!(await pagoGenericoPermitido(v.id))) {
        console.log(`omitida (marca blanca): ${v.name}`)
        continue
      }
      try {
        if (dry) {
          const p = await ensayarSede(v.id)
          const nombres = p.puestos.map(x => `«${x.name}»`).join(', ')
          console.log(
            `${v.name}: crearía ${p.puestos.length} puestos${nombres ? ` (${nombres})` : ''} y ${p.asignaciones.length} asignaciones; ` +
              `omitiría ${p.yaTienenPuesto.length} personas que ya tienen puesto y ${p.puestoArchivado.length} con su puesto archivado`,
          )
          total.puestos += p.puestos.length
          total.asignaciones += p.asignaciones.length
          total.yaTienenPuesto += p.yaTienenPuesto.length
          total.puestoArchivado += p.puestoArchivado.length
        } else {
          const r = await migrarSede(v.id)
          console.log(`${v.name}: creó ${r.puestosCreados} puestos y ${r.asignacionesCreadas} asignaciones`)
          total.puestos += r.puestosCreados
          total.asignaciones += r.asignacionesCreadas
        }
        total.sedes++
      } catch (e) {
        // Una sede que falla no frena a las demás; su transacción se revirtió entera y la siguiente corrida la reintenta.
        console.error(`FALLÓ ${v.name} (${v.id}): ${e instanceof Error ? e.message : e}`)
        total.fallidas++
        process.exitCode = 1
      }
    }
    cursor = venues[venues.length - 1].id
    if (solo) break
  }

  const verbo = dry ? 'crearía' : 'creó'
  console.log(
    `TOTAL — ${total.sedes} sedes revisadas, ${total.fallidas} fallidas: ${verbo} ${total.puestos} puestos y ${total.asignaciones} asignaciones` +
      (dry ? `; omitiría ${total.yaTienenPuesto} (ya tienen puesto) y ${total.puestoArchivado} (puesto archivado)` : ''),
  )
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
