/**
 * Fase 0 del turno de caja del negocio — corrida A MANO de «pagada pero abierta».
 *
 *   npx tsx scripts/reconciliar-pagadas-pero-abiertas.ts                          # simulación: lista, no toca nada
 *   npx tsx scripts/reconciliar-pagadas-pero-abiertas.ts --desde 2025-01-01       # abre la ventana al rezago viejo
 *   npx tsx scripts/reconciliar-pagadas-pero-abiertas.ts --apply --confirm-host <host de DATABASE_URL>
 *
 * Corre la MISMA lógica que el barrido automático (`PaidOrderReconcilerJob.runNow`): ni criterio
 * propio ni cerrador propio. Si este script y el tic de cada 10 minutos pudieran elegir órdenes
 * distintas, la lista que el founder aprueba no sería la que se repara.
 *
 * 🔴 Escribir exige repetir el host de la base en la línea de comandos. Es la única defensa contra
 * el error que de verdad pasa: un `DATABASE_URL` heredado del `.env` —o exportado en otra pestaña—
 * apuntando a una base que no era. `import 'dotenv/config'` NO pisa una variable que ya viene del
 * entorno, así que el operador puede apuntar este mismo script a otra base desde el comando; por
 * eso la PRIMERA línea que imprime es a qué base se conectó, antes de leer nada.
 *
 * 🔴 A propósito NO importa `scripts/_solo-base-local.ts`: ese cortafuegos rechaza toda base que no
 * sea local, y el trabajo de este script incluye producción. Su candado es el host, no el entorno.
 *
 * La simulación es de sólo lectura POR CONSTRUCCIÓN, no por disciplina: `runNow({ dryRun: true })`
 * regresa en `src/jobs/paid-order-reconciler.job.ts:129`, antes del bucle que repara y antes de la
 * bitácora. Lo único que este script escribe por su cuenta es texto en pantalla.
 *
 * Reparar NO es inocuo y el docstring del barrido lo detalla: se reestampa `completedAt` con la
 * hora de la corrida, `tipAmount`/`total` se reescriben desde los cobros, la mesa se libera si la
 * cuenta quedó saldada, y una candidata con sobrepago emite su aviso. Cada reparación deja
 * `ActivityLog ORDER_RECONCILED_PAID`.
 *
 * Autorizado por el founder el 2-sep-2026 («dale») tras la aprobación del dueño de Testarudo.
 */
import 'dotenv/config'
import { Prisma } from '@prisma/client'
import { PaidOrderReconcilerJob } from '../src/jobs/paid-order-reconciler.job'
import type { CandidataPagadaAbierta } from '../src/services/shared/pagadaPeroAbierta'
import prisma from '../src/utils/prismaClient'

/**
 * Cron inerte: el constructor del barrido agenda su tic de cada 10 minutos si no se le pasa uno.
 * Una corrida a mano NO debe registrar un cron —ni dejar el proceso vivo esperándolo—, así que se
 * le entrega este par de funciones que no hacen nada.
 */
const cronInerte = { start: () => undefined, stop: () => undefined }

/**
 * Espejo de `BATCH_LIMIT` del barrido, y SÓLO para el aviso: si la lista llega al tope, puede haber
 * más rezago del que se ve. Ninguna decisión depende de este número; si allá cambia, aquí lo peor
 * que pasa es que el aviso salga de más o de menos.
 */
const TOPE_POR_PASADA = 50

const RE_FECHA_CIVIL = /^\d{4}-\d{2}-\d{2}$/

/**
 * Rechazo de seguridad (host equivocado, `--desde` inválido, `DATABASE_URL` inservible). El motivo
 * se imprime donde se detecta y esto sólo lleva el código de salida hasta la cadena final.
 *
 * 🔴 Por qué no un `process.exit(2)` en el sitio: un exit seco NO drena la salida, y hacia un pipe
 * (`2>&1 | tee`) `process.stderr` es asíncrono — se perdía justo el renglón que dice qué host hay
 * que repetir, que es el único con el que el operador puede corregir su comando. Saliendo por la
 * cadena de abajo, todo rechazo pasa por el mismo drenado que el camino bueno.
 */
class Rechazo extends Error {
  constructor(readonly codigo: number) {
    super(`rechazo (${codigo})`)
    this.name = 'Rechazo'
  }
}

function leerValor(bandera: string): string | undefined {
  const i = process.argv.indexOf(bandera)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** `--desde YYYY-MM-DD`: abre la ventana más allá de los 30 días que barre el tic. */
function leerDesde(): Date | undefined {
  const crudo = leerValor('--desde')
  if (crudo === undefined) return undefined
  if (!RE_FECHA_CIVIL.test(crudo)) {
    console.error(`--desde espera una fecha en formato YYYY-MM-DD (recibí «${crudo}»). No se leyó nada.`)
    throw new Rechazo(2)
  }
  // Fecha civil a medianoche UTC: es una cota inferior de rezago, no un día de negocio, así que no
  // necesita la zona del venue — y así el resultado no depende del reloj de la máquina que corre.
  const desde = new Date(`${crudo}T00:00:00Z`)
  if (Number.isNaN(desde.getTime())) {
    console.error(`--desde: «${crudo}» no es una fecha que exista. No se leyó nada.`)
    throw new Rechazo(2)
  }
  return desde
}

/** Host de la base a la que ESTA corrida se va a conectar. Nunca se imprime la cadena completa. */
function hostDeLaBase(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('Falta DATABASE_URL: no hay base a la que conectarse.')
    throw new Rechazo(2)
  }
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    console.error('DATABASE_URL no es una URL válida (su valor no se imprime).')
    throw new Rechazo(2)
  }
  // 🔴 Un DSN por socket unix (`postgres:///base`) deja el host VACÍO, y entonces `--confirm-host ""`
  // satisface la comparación: el candado se abriría solo. Sin host no hay nada que confirmar, así que
  // no se escribe. La comprobación va FUERA del `try` a propósito: dentro, su propio `throw` caería en
  // el `catch` de arriba y el operador leería «no es una URL válida», que es mentira.
  if (!host) {
    console.error('DATABASE_URL no declara un host (¿conexión por socket?): no hay nada que repetir en --confirm-host.')
    throw new Rechazo(2)
  }
  return host
}

const pesos = (monto: string): string => `$${new Prisma.Decimal(monto).toFixed(2)}`

/** Una sola consulta para todos los negocios de la lista: el founder lee nombres, no ids. */
async function nombresDeNegocios(candidatas: CandidataPagadaAbierta[]): Promise<Map<string, string>> {
  const ids = [...new Set(candidatas.map(c => c.venueId))]
  if (ids.length === 0) return new Map()
  const negocios = await prisma.venue.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  return new Map(negocios.map(n => [n.id, n.name]))
}

async function imprimirLista(candidatas: CandidataPagadaAbierta[]): Promise<void> {
  if (candidatas.length === 0) {
    console.log('\nNo hay órdenes cobradas que sigan abiertas en esta ventana. Nada que reparar.\n')
    return
  }
  const nombres = await nombresDeNegocios(candidatas)
  console.table(
    candidatas.map(c => ({
      negocio: nombres.get(c.venueId) ?? c.venueId,
      folio: c.orderNumber,
      estado: `${c.status}/${c.paymentStatus}`,
      cuenta: pesos(c.base),
      cobrado: pesos(c.pagado),
      cobros: c.paymentIds.length,
    })),
  )
  const suma = candidatas.reduce((acc, c) => acc.add(new Prisma.Decimal(c.base)), new Prisma.Decimal(0))
  console.log(`${candidatas.length} ${candidatas.length === 1 ? 'orden' : 'órdenes'} por cerrar — ${pesos(suma.toFixed(2))} de cuenta\n`)
  if (candidatas.length >= TOPE_POR_PASADA) {
    console.log(`⚠️  La lista llegó al tope de una pasada (${TOPE_POR_PASADA}): puede haber más. Vuelve a correr después de aplicar.\n`)
  }
}

async function main(): Promise<void> {
  const aplicar = process.argv.includes('--apply')
  const desde = leerDesde()
  const host = hostDeLaBase()
  const ventana = desde ? `desde ${desde.toISOString().slice(0, 10)}` : 'últimos 30 días (ventana del barrido)'
  console.log(`Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}  ventana: ${ventana}\n`)

  if (aplicar) {
    const confirmado = leerValor('--confirm-host')
    if (confirmado !== host) {
      console.error('🔴 No se escribió NADA.')
      console.error(`Para reparar en esta base hay que repetir su host exacto:  --confirm-host ${host}`)
      console.error(confirmado === undefined ? 'No recibí --confirm-host.' : `Recibí «${confirmado}».`)
      throw new Rechazo(2)
    }
  }

  const barrido = new PaidOrderReconcilerJob({ cron: cronInerte })

  const simulacion = await barrido.runNow({ dryRun: true, since: desde })
  await imprimirLista(simulacion.candidates)

  if (!aplicar) {
    console.log('Simulación: no se tocó nada.')
    if (simulacion.candidates.length > 0) {
      console.log(
        `Para repararlas:  npx tsx scripts/reconciliar-pagadas-pero-abiertas.ts${desde ? ` --desde ${desde.toISOString().slice(0, 10)}` : ''} --apply --confirm-host ${host}`,
      )
    }
    return
  }

  const resultado = await barrido.runNow({ since: desde })
  console.log(`Revisadas ${resultado.scanned} · reparadas ${resultado.reconciled} · fallidas ${resultado.failed}`)
  if (resultado.skipped > 0) {
    // El candado `running` es de ESTA instancia, recién creada, así que aquí no debería saltar nunca.
    // Y no promete lo que parece: NO protege contra el tic de 10 min del servidor desplegado — si
    // coinciden, lo peor que pasa es que se repita trabajo idempotente sobre las mismas órdenes.
    console.log('⚠️  El barrido se saltó su propia pasada y aquí eso no debería ocurrir: el candado es de esta')
    console.log('    instancia, que acaba de nacer. Vuelve a correr y repórtalo.')
  }

  const despues = await barrido.runNow({ dryRun: true, since: desde })
  console.log(
    `\nQuedan ${despues.candidates.length} candidatas (deben ser sólo las que fallaron, o las que no cupieron en el lote de ${TOPE_POR_PASADA} de esta pasada).`,
  )
  if (resultado.failed > 0) {
    console.log('El motivo de cada fallida está en el log del servidor. Una fallida que ya no salga aquí es la')
    console.log('gracia de 5 minutos del criterio: reaparecerá en la siguiente corrida.')
  }
  await imprimirLista(despues.candidates)
}

/**
 * Espera a que la salida llegue de verdad al otro lado antes de matar el proceso: hacia un pipe
 * (`| tee`, `| tail`) `process.stdout` es ASÍNCRONO, y un `process.exit` seco cortaría la tabla a
 * media línea — justo la tabla que el founder tiene que leer.
 *
 * 🔴 Se drenan LOS DOS flujos: los rechazos se imprimen por `stderr`, que es un stream aparte con su
 * propio búfer aunque `2>&1` los mande al mismo sitio. Drenar sólo stdout dejaba truncado el
 * «repite su host exacto», que es el renglón que sirve para corregir el comando.
 */
function drenarFlujo(flujo: NodeJS.WriteStream): Promise<void> {
  if (flujo.writableLength === 0) return Promise.resolve()
  return new Promise(resolve => flujo.write('', () => resolve()))
}

async function drenarSalida(): Promise<void> {
  await drenarFlujo(process.stdout)
  await drenarFlujo(process.stderr)
}

main()
  .then(() => 0)
  .catch(error => {
    // Un `Rechazo` ya imprimió su motivo donde se detectó; aquí sólo trae su código para que la
    // salida pase por el drenado de abajo en vez de por un `process.exit` seco.
    if (error instanceof Rechazo) return error.codigo
    console.error(error)
    return 1
  })
  .then(async codigo => {
    await prisma.$disconnect().catch(() => undefined)
    // 🔴 Salida EXPLÍCITA, y no es cosmético: este script no termina solo. `posSyncOrder.service`
    // —que entra al grafo por el servicio de cobro— deja un `setInterval` de un minuto vivo al
    // importarse (limpia su caché de pagos recientes) mientras `NODE_ENV !== 'test'`, así que el
    // event loop nunca se vacía. Medido con `getActiveResourcesInfo()`: al acabar el trabajo queda
    // un 'Timeout' pendiente. Sin esta línea la corrida se ve COLGADA, y contra producción eso
    // invita a matarla a media reparación.
    await drenarSalida()
    process.exit(codigo)
  })
