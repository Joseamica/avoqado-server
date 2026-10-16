/**
 * EXPERIMENTO OTel — HUMO (fase 1). Corre DENTRO del contenedor de actores, en la red interna, fuera de la cuota del
 * server. Sin humo verde no se mide nada (plan, corrección 3).
 *
 * 1. Espera una respuesta AUTENTICADA del server (no cualquier 200) y anota cuánto tardó desde que arrancó el contenedor.
 * 2. Hace login por PIN de las TPV de script y abre sus sockets.
 * 3. Corre el recorrido congelado N veces SEGUIDAS (por defecto 5), rotando terminales.
 * 4. Escribe exp-out/humo-<brazo>.json. Sale con 1 si un solo cobro falló.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import { Fixture, PosDeScript } from './pos'
import { TpvDeScript } from './tpv'
import { unCobro, ResultadoDelCobro } from './recorrido'

const BASE = process.env.SERVER_URL || 'http://srv:3000'
const N = Number(process.env.N_COBROS || 5)
const BRAZO = process.env.BRAZO || 'A'
const OUT = process.env.OUT_DIR || 'exp-out'
const T0 = Number(process.env.SERVER_T0_MS || Date.now())
const N_TPV = Number(process.env.N_TPV || 3)

async function main() {
  const f: Fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE || path.join(OUT, 'fixture.json'), 'utf8'))
  const secreto = process.env.ACCESS_TOKEN_SECRET!
  const pos = new PosDeScript(BASE, f, secreto)

  // 1. listo = primera respuesta 200 AUTENTICADA.
  let listoMs: number | null = null
  let ultimo = ''
  const limite = Date.now() + 240_000
  while (Date.now() < limite) {
    try {
      const r = await pos.listo()
      ultimo = `HTTP ${r.status}`
      if (r.status === 200) {
        listoMs = Date.now() - T0
        break
      }
    } catch (e: any) {
      ultimo = e?.cause?.code ?? e?.message ?? String(e)
    }
    await new Promise(r => setTimeout(r, 250))
  }
  if (listoMs === null) throw new Error(`el server no dio una respuesta autenticada en 240 s (último: ${ultimo})`)
  console.log(`✅ listo (respuesta autenticada) a los ${listoMs} ms del arranque del contenedor`)

  // 2. TPVs.
  const tpvs: TpvDeScript[] = []
  for (const t of f.terminales.slice(0, N_TPV)) {
    const tpv = new TpvDeScript(BASE, f, t.serial)
    await tpv.login()
    await tpv.conectar()
    tpvs.push(tpv)
  }
  console.log(`✅ ${tpvs.length} TPV conectadas por socket`)

  const db = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'exp-otel-actores' })
  await db.connect()

  // 3. N cobros seguidos.
  const cobros: ResultadoDelCobro[] = []
  for (let i = 1; i <= N; i++) {
    const tpv = tpvs[(i - 1) % tpvs.length]
    // El job de efectos corre a los segundos 16 y 46: 90 s cubren dos vueltas aunque una se pierda.
    const r = await unCobro(i, f, pos, tpv, db, { esperaEfectosMs: 90_000 })
    cobros.push(r)
    console.log(
      `${r.ok ? '✅' : '❌'} cobro ${i}/${N} terminal=${r.terminal} orden=${r.orderId} pago=${r.paymentId} ` +
        `efectos=${(r.efectos ?? []).map(e => `${e.kind}:${e.status}`).join(',')}` +
        (r.ok ? '' : `\n   fallas: ${r.fallas.join(' | ')}`),
    )
  }
  await db.end()
  const inesperados = tpvs.flatMap(t => t.eventosInesperados.map(e => ({ terminal: t.serial, ...e })))
  for (const t of tpvs) t.cerrar()

  const ok = cobros.filter(c => c.ok).length
  const salida = {
    brazo: BRAZO,
    fecha: new Date().toISOString(),
    nodeActores: process.version,
    listoMs,
    n: N,
    exitosos: ok,
    veredicto: ok === N ? 'VERDE' : 'ROJO',
    // difusiones normales (order_created, payment_completed…), no errores
    otrosEventosDeSocket: inesperados,
    cobros,
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `humo-${BRAZO}.json`), JSON.stringify(salida, null, 2))
  console.log(`\nHUMO ${BRAZO}: ${ok}/${N} cobros completos de punta a punta → ${salida.veredicto}`)
  process.exit(ok === N ? 0 : 1)
}

main().catch(e => {
  console.error('❌ humo abortado:', e)
  process.exit(2)
})
