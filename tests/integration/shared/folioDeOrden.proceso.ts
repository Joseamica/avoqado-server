/**
 * D30 — un «proceso del servidor» aparte para `folioDeOrden.integration.test.ts`: su propio Node, su propio cliente de Prisma
 * y el escritor real (`assignTable`). La prueba lo lanza con `node --import tsx` (el PID es el del Node que escribe, así un
 * SIGKILL lo interrumpe de verdad); nunca corre solo.
 *
 * Por la entrada recibe una línea JSON por orden: `{ venueId, pasos: [{ mesa, staffId }], t0, serie }`. Espera a la hora real
 * `t0` (para que los dos procesos escriban a la vez) y abre las mesas con el reloj congelado en el milisegundo del ensayo del
 * 17-nov: en paralelo y una sola respuesta, o con `serie` una tras otra y una respuesta por mesa (la prueba lo mata a la mitad).
 * Contesta `D30>` + JSON; el prefijo separa sus respuestas de lo que imprima el logger.
 */
import readline from 'readline'
import { motivoParaRechazarBaseDePruebas } from '../../__helpers__/baseDePruebasPermitida'

const url = process.env.TEST_DATABASE_URL ?? ''
const motivo = motivoParaRechazarBaseDePruebas(url)
if (motivo) {
  process.stderr.write(`D30: base rechazada (${motivo})\n`)
  process.exit(2)
}
process.env.DATABASE_URL = url

const ahoraReal = () => performance.timeOrigin + performance.now()
Date.now = () => 1_794_963_374_538 // ensayo del 17-nov: ORD-1794963374538 dos veces

type Orden = { venueId: string; pasos: Array<{ mesa: string; staffId: string }>; t0: number; serie?: boolean }

async function main() {
  const { assignTable } = await import('@/services/tpv/table.tpv.service')
  const abrir = async (venueId: string, p: Orden['pasos'][number]) => {
    const { order } = await assignTable(venueId, p.mesa, p.staffId, 2)
    return { id: order.id, mesa: p.mesa, folio: order.orderNumber }
  }
  const responder = (x: unknown) => process.stdout.write(`D30>${JSON.stringify(x)}\n`)
  responder({ pid: process.pid })
  for await (const linea of readline.createInterface({ input: process.stdin })) {
    const { venueId, pasos, t0, serie } = JSON.parse(linea) as Orden
    await new Promise(r => setTimeout(r, Math.max(0, t0 - ahoraReal())))
    if (serie) for (const p of pasos) responder([await abrir(venueId, p)])
    else responder(await Promise.all(pasos.map(p => abrir(venueId, p))))
  }
}

main().catch(error => {
  process.stderr.write(`D30: ${error?.stack ?? error}\n`)
  process.exit(1)
})
