/**
 * Corrige `Shift.totalOrders` de los turnos CERRADOS: guardaba renglones de producto, no órdenes.
 *
 *   npx tsx scripts/recalcular-ordenes-de-turnos.ts --base render                      # simulación
 *   npx tsx scripts/recalcular-ordenes-de-turnos.ts --base render --venue <slug|id> --desde 2026-09-01
 *   npx tsx scripts/recalcular-ordenes-de-turnos.ts --base render --apply --confirm-host <host>
 *
 * ## Qué repara
 *
 * Hasta el 18-oct-2026 el cierre del turno (`closeShiftUsingRequest`) escribía
 * `totalOrders: orderItems.length`. Medido en producción ese día: 47 de 47 turnos cerrados con
 * `reportData` guardaban exactamente sus renglones (Testarudo: 270 «órdenes» en un turno de 124),
 * y los «Pago rápido» sin renglones contaban 0. La lista de Turnos del panel enseñaba ese número y
 * el detalle otro. El cierre ya cuenta órdenes; esto corrige lo que quedó atrás.
 *
 * El número nuevo sale de LA MISMA regla que el cierre: `readShiftPaymentsForClose` (el conjunto de
 * cobros que firmó el dinero, con `endTime` como corte) + `contarOrdenesCobradas`.
 *
 * ## Lo que NO toca
 *
 * Sólo `Shift.totalOrders`. Ningún importe, ningún cobro, ninguna orden, ni el `reportData` impreso.
 * Turnos OPEN/CLOSING no se tocan: su contador lo lleva el cobro y ya es correcto.
 *
 * ## Escribir exige DOS llaves
 *
 * `--apply` y `--confirm-host <host exacto>`. Cada escritura es un CAS sobre el valor leído
 * (`totalOrders` = lo que se vio): si alguien lo cambió entre la lectura y la escritura, ese turno
 * se salta y se dice. Bitácora: un `SHIFT_TOTAL_ORDERS_RECOUNTED` por turno con `de` y `a`, que es lo
 * que hace la corrección reversible.
 */
import 'dotenv/config'

const RE_FECHA_CIVIL = /^\d{4}-\d{2}-\d{2}$/
const PAGINA = 200
const EJEMPLOS_POR_VENUE = 3

class Rechazo extends Error {
  constructor(readonly codigo: number) {
    super(`rechazo (${codigo})`)
    this.name = 'Rechazo'
  }
}

function detener(...lineas: string[]): never {
  console.error('🔴 No se escribió NADA.')
  for (const l of lineas) console.error(l)
  throw new Rechazo(2)
}

function leerValor(bandera: string): string | undefined {
  const i = process.argv.indexOf(bandera)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Elige la base ANTES de que exista el cliente de Prisma. */
function elegirBase(): void {
  const base = leerValor('--base')
  if (base === undefined || base === 'local') return
  if (base !== 'render') detener(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
  const url = process.env.RENDER_DATABASE_URL
  if (!url) detener('--base render: falta RENDER_DATABASE_URL en el entorno.')
  process.env.DATABASE_URL = url
}

/** Host de la base a la que ESTA corrida se va a conectar. Nunca se imprime la cadena completa. */
function hostDeLaBase(): string {
  const url = process.env.DATABASE_URL
  if (!url) detener('Falta DATABASE_URL: no hay base a la que conectarse.')
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    detener('DATABASE_URL no es una URL válida (su valor no se imprime).')
  }
  if (!host) detener('DATABASE_URL no declara un host (¿conexión por socket?): no hay nada que repetir en --confirm-host.')
  return host
}

function leerDesde(): Date | undefined {
  const crudo = leerValor('--desde')
  if (crudo === undefined) return undefined
  if (!RE_FECHA_CIVIL.test(crudo)) detener(`--desde espera una fecha YYYY-MM-DD (recibí «${crudo}»).`)
  return new Date(`${crudo}T00:00:00.000-06:00`)
}

interface Correccion {
  shiftId: string
  venueId: string
  venueName: string
  startTime: Date
  de: number
  a: number
}

async function main(): Promise<void> {
  const venueRef = leerValor('--venue')
  const desde = leerDesde()
  elegirBase()
  const host = hostDeLaBase()
  const aplicar = process.argv.includes('--apply')
  console.log(
    `Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN (sólo lectura)'}  venue: ${venueRef ?? 'todos'}  desde: ${desde?.toISOString() ?? 'siempre'}`,
  )
  if (aplicar) {
    const confirmado = leerValor('--confirm-host')
    if (confirmado !== host) {
      detener(
        `Para escribir en esta base hay que repetir su host exacto:  --confirm-host ${host}`,
        confirmado === undefined ? 'No recibí --confirm-host.' : `Recibí «${confirmado}».`,
      )
    }
  }

  // Imports dinámicos: el cliente de Prisma lee DATABASE_URL al cargarse, y `elegirBase` ya la eligió.
  const { default: prisma } = await import('../src/utils/prismaClient')
  const { logAction } = await import('../src/services/dashboard/activity-log.service')
  const { readShiftPaymentsForClose, contarOrdenesCobradas } = await import('../src/services/tpv/shift.tpv.service')

  try {
    let venueId: string | undefined
    if (venueRef) {
      const venue = await prisma.venue.findFirst({ where: { OR: [{ slug: venueRef }, { id: venueRef }] }, select: { id: true } })
      if (!venue) detener(`No encontré el venue «${venueRef}».`)
      venueId = venue.id
    }

    const correcciones: Correccion[] = []
    let revisados = 0
    let cursor: string | undefined
    while (true) {
      const turnos = await prisma.shift.findMany({
        where: {
          status: 'CLOSED',
          endTime: { not: null },
          ...(venueId ? { venueId } : {}),
          ...(desde ? { startTime: { gte: desde } } : {}),
        },
        select: { id: true, venueId: true, startTime: true, endTime: true, totalOrders: true, venue: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take: PAGINA,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      for (const t of turnos) {
        revisados++
        const cobros = await readShiftPaymentsForClose(t.venueId, t.id, t.startTime, t.endTime as Date)
        const a = contarOrdenesCobradas(cobros)
        if (a !== t.totalOrders) {
          correcciones.push({ shiftId: t.id, venueId: t.venueId, venueName: t.venue.name, startTime: t.startTime, de: t.totalOrders, a })
        }
      }
      if (turnos.length < PAGINA) break
      cursor = turnos[turnos.length - 1].id
    }

    // Resumen por negocio
    const porVenue = new Map<string, Correccion[]>()
    for (const c of correcciones) porVenue.set(c.venueName, [...(porVenue.get(c.venueName) ?? []), c])
    console.log(`\nTurnos cerrados revisados: ${revisados} · a corregir: ${correcciones.length}\n`)
    console.log(`${'Negocio'.padEnd(28)} ${'turnos'.padStart(6)} ${'guardado'.padStart(9)} ${'→ órdenes'.padStart(10)}`)
    for (const [nombre, lista] of [...porVenue.entries()].sort((x, y) => y[1].length - x[1].length)) {
      const de = lista.reduce((s, c) => s + c.de, 0)
      const a = lista.reduce((s, c) => s + c.a, 0)
      console.log(
        `${nombre.slice(0, 28).padEnd(28)} ${String(lista.length).padStart(6)} ${String(de).padStart(9)} ${String(a).padStart(10)}`,
      )
      for (const c of lista.slice(0, EJEMPLOS_POR_VENUE)) {
        console.log(`    ${c.startTime.toISOString().slice(0, 10)}  ${c.shiftId}  ${c.de} → ${c.a}`)
      }
    }

    if (!aplicar) {
      console.log(`\nSimulación: no se escribió nada. Para aplicar:  --apply --confirm-host ${host}`)
      return
    }

    let escritos = 0
    const saltados: Correccion[] = []
    for (const c of correcciones) {
      // CAS sobre el valor leído: si alguien lo cambió en medio, no se pisa.
      const r = await prisma.shift.updateMany({
        where: { id: c.shiftId, venueId: c.venueId, status: 'CLOSED', totalOrders: c.de },
        data: { totalOrders: c.a },
      })
      if (r.count !== 1) {
        saltados.push(c)
        continue
      }
      escritos++
      await logAction({
        venueId: c.venueId,
        action: 'SHIFT_TOTAL_ORDERS_RECOUNTED',
        entity: 'Shift',
        entityId: c.shiftId,
        data: { de: c.de, a: c.a, motivo: 'totalOrders guardaba renglones de producto, no órdenes (corrección 2026-10-18)' },
      })
    }
    console.log(`\nEscritos: ${escritos} · saltados (cambiaron entre lectura y escritura): ${saltados.length}`)
    for (const c of saltados) console.log(`    ${c.shiftId}  esperaba ${c.de}`)
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

function drenarFlujo(flujo: NodeJS.WriteStream): Promise<void> {
  if (flujo.writableLength === 0) return Promise.resolve()
  return new Promise(resolve => flujo.write('', () => resolve()))
}

main()
  .then(() => Promise.all([drenarFlujo(process.stdout), drenarFlujo(process.stderr)]))
  .then(() => process.exit(0))
  .catch(async e => {
    const codigo = e instanceof Rechazo ? e.codigo : 1
    if (!(e instanceof Rechazo)) console.error(e)
    await Promise.all([drenarFlujo(process.stdout), drenarFlujo(process.stderr)])
    process.exit(codigo)
  })
