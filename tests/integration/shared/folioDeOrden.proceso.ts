/**
 * D30 — un «proceso del servidor» aparte para `folioDeOrden.integration.test.ts`: su propio Node, su propio cliente de Prisma
 * y el escritor real (`assignTable`). Lo lanza la prueba con `tsx`; nunca corre solo.
 *
 * Por la entrada recibe una línea JSON por orden: `{ venueId, staffId, mesas, t0 }`. Espera a la hora real `t0` (para que los
 * dos procesos escriban a la vez), abre esas mesas en paralelo con el reloj congelado en el milisegundo del ensayo del 17-nov y
 * contesta `D30>` + JSON con los folios. El prefijo separa sus respuestas de lo que imprima el logger.
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

async function main() {
  const { assignTable } = await import('@/services/tpv/table.tpv.service')
  process.stdout.write('D30>LISTO\n')
  for await (const linea of readline.createInterface({ input: process.stdin })) {
    const { venueId, staffId, mesas, t0 } = JSON.parse(linea) as { venueId: string; staffId: string; mesas: string[]; t0: number }
    await new Promise(r => setTimeout(r, Math.max(0, t0 - ahoraReal())))
    const abiertas = await Promise.all(mesas.map(mesa => assignTable(venueId, mesa, staffId, 2)))
    process.stdout.write(`D30>${JSON.stringify(abiertas.map(a => ({ id: a.order.id, folio: a.order.orderNumber })))}\n`)
  }
}

main().catch(error => {
  process.stderr.write(`D30: ${error?.stack ?? error}\n`)
  process.exit(1)
})
