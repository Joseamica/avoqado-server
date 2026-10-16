/**
 * EXPERIMENTO OTel — HUMO: el recorrido congelado N veces SEGUIDAS, verificado en Postgres. Sin humo verde no se mide
 * nada (plan, corrección 3). Escribe OUT_DIR/humo-<BRAZO>.json y sale con 1 si un cobro falló.
 */
import { Client } from 'pg'
import { unCobro, ResultadoDelCobro } from './recorrido'
import { esperarListo, montar, escribir, MODO, leerFixture } from './montaje'

const N = Number(process.env.N_COBROS || 5)
const BRAZO = process.env.BRAZO || 'A'

async function main() {
  const t0 = Number(process.env.SERVER_T0_MS || Date.now())
  const listoMs = await esperarListo(leerFixture(), t0)
  console.log(`✅ listo (respuesta autenticada) a los ${listoMs} ms del arranque del contenedor`)
  const m = await montar(Number(process.env.N_TPV || 3))
  const db = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'exp-otel-actores' })
  await db.connect()
  const cobros: ResultadoDelCobro[] = []
  for (let i = 1; i <= N; i++) {
    // El job de efectos corre a los segundos 16 y 46: 90 s cubren dos vueltas aunque una se pierda.
    const r = await unCobro(i, m.f, m.pos, m.tpvs[(i - 1) % m.tpvs.length], db, { esperaEfectosMs: 90_000, modo: MODO, tableId: m.f.mesas?.[i] })
    cobros.push(r)
    console.log(
      `${r.ok ? '✅' : '❌'} cobro ${i}/${N} terminal=${r.terminal} pago=${r.paymentId} ` +
        `efectos=${(r.efectos ?? []).map(e => `${e.kind}:${e.status}`).join(',')}` +
        (r.ok ? '' : `\n   fallas: ${r.fallas.join(' | ')}`),
    )
  }
  await db.end()
  // difusiones normales (order_created, payment_completed…), no errores
  const otros = m.tpvs.flatMap(t => t.eventosInesperados.map(e => ({ terminal: t.serial, ...e })))
  for (const t of m.tpvs) t.cerrar()
  const ok = cobros.filter(c => c.ok).length
  escribir(`humo-${BRAZO}.json`, {
    brazo: BRAZO,
    modoCliente: MODO,
    modoTokenPos: m.pos.modoToken,
    paridadDelTokenTpv: m.paridadDelTokenTpv,
    fecha: new Date().toISOString(),
    listoMs,
    n: N,
    exitosos: ok,
    veredicto: ok === N ? 'VERDE' : 'ROJO',
    otrosEventosDeSocket: otros.length,
    cobros,
  })
  console.log(`\nHUMO ${BRAZO}: ${ok}/${N} cobros completos de punta a punta → ${ok === N ? 'VERDE' : 'ROJO'}`)
  process.exit(ok === N ? 0 : 1)
}

main().catch(e => {
  console.error('❌ humo abortado:', e)
  process.exit(2)
})
