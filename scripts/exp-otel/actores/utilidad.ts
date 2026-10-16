/**
 * EXPERIMENTO OTel — corrida de UTILIDAD (plan 1a/1b/1c). Dentro del contenedor de actores.
 *
 * - Fondo: lecturas del POS a 4 por segundo, alternando DOS sucursales (prueba de contextos con venues concurrentes,
 *   corrección 7) — también son «los que esperan» cuando la falla congela el hilo.
 * - Primer plano: 5 cobros SEGUIDOS del recorrido congelado, verificados en Postgres.
 *
 * Escribe en OUT_DIR/<CORRIDA>/:
 *   llaves.json            lo ÚNICO del cliente que ve el calificador: la llave de partida de cada cobro
 *                          (A: el X-Correlation-ID que el server devolvió en ①; A+: su correlationId; B: su trace-id)
 *   referencia-cliente.json el reloj monotónico APARTE (corrección 6) y las respuestas de la API — NO lo lee el
 *                          calificador; lo usa el reporte para comprobar y para comparar respuestas entre brazos.
 */
import { Client } from 'pg'
import { LlaveDeCliente } from './pos'
import { unCobro, ResultadoDelCobro } from './recorrido'
import { esperarListo, montar, escribir, MODO, leerFixture } from './montaje'

async function main() {
  const corrida = process.env.CORRIDA!
  const t0 = Number(process.env.SERVER_T0_MS || Date.now())
  const f = leerFixture()
  const listoMs = await esperarListo(f, t0)
  const m = await montar(3)
  const db = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'exp-otel-utilidad' })
  await db.connect()

  let vivo = true
  let k = 0
  const fondo = (async () => {
    while (vivo) {
      const venue = m.f.venue2Id && k % 2 === 1 ? m.f.venue2Id : m.f.venueId
      k++
      void (k % 3 === 0 ? m.pos.leerTiposDePago(new LlaveDeCliente(MODO), venue) : m.pos.leerOrdenes(new LlaveDeCliente(MODO), venue))
      await new Promise(r => setTimeout(r, 250))
    }
  })()
  await new Promise(r => setTimeout(r, 3000))

  const cobros: ResultadoDelCobro[] = []
  const N = Number(process.env.N_COBROS || 5)
  for (let i = 1; i <= N; i++) {
    const r = await unCobro(i, m.f, m.pos, m.tpvs[(i - 1) % m.tpvs.length], db, {
      esperaEfectosMs: Number(process.env.ESPERA_EFECTOS_MS || 65_000),
      modo: MODO,
      tableId: m.f.mesas?.[i] ?? m.f.tableId,
      guardarRespuestas: true,
    })
    cobros.push(r)
    console.log(`${r.ok ? '✅' : '⚠️'} cobro ${i}/${N} ${r.fallas.join(' | ').slice(0, 200)}`)
  }
  vivo = false
  await fondo
  await db.end()
  for (const t of m.tpvs) t.cerrar()

  escribir(`${corrida}/llaves.json`, { modoCliente: MODO, cobros: cobros.map(c => ({ n: c.n, llave: c.llaveInicial })) })
  escribir(`${corrida}/referencia-cliente.json`, { modoCliente: MODO, listoMs, modoTokenPos: m.pos.modoToken, cobros })
  process.exit(0)
}

main().catch(e => {
  console.error('❌ utilidad abortada:', e)
  process.exit(2)
})
