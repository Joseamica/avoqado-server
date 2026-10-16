/**
 * EXPERIMENTO OTel — GENERADOR DE CARGA ABIERTA (plan, corrección 9). Corre en el contenedor de actores, FUERA de la
 * cuota del server. «Abierta» = los cobros llegan a tasa FIJA aunque los anteriores no hayan terminado (no espera a que
 * el server conteste para mandar el siguiente: así un server lento se ve como latencia, no como menos carga).
 *
 * Mezcla FIJA por cobro iniciado: el recorrido completo ①–⑥ (POS + TPV) + 3 lecturas comunes del POS
 * (lista de órdenes, tipos de pago — alternando las dos sucursales — y el detalle de la orden recién creada).
 *
 * Uso: VENTANAS='[{"nombre":"alta","tasa":4,"duracionS":180}, ...]' (con un calentamiento antes si se pide).
 * Escribe OUT_DIR/<SALIDA> con, por ventana: inicio/fin (epoch), peticiones por etiqueta con p50/p95/p99 y errores,
 * cobros completos/fallidos, y la lista de pagos para medir «hasta DONE».
 */
import { Client } from 'pg'
import { LlaveDeCliente, RespuestaHttp } from './pos'
import { unCobro } from './recorrido'
import { esperarListo, montar, escribir, MODO, Montaje } from './montaje'

interface Registro {
  etiqueta: string
  ms: number
  status: number
  inicio: number
}
interface Ventana {
  nombre: string
  tasa: number
  duracionS: number
  medirDone?: boolean
  /** fase del cron de efectos (corre a :16 y :46): la ventana arranca en este segundo del minuto */
  alinearSegundo?: number
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN
}
const resumen = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : NaN })

async function ventana(m: Montaje, v: Ventana, db: Client) {
  const registros: Registro[] = []
  const cobros: Array<{ ok: boolean; ms: number; falla?: string; paymentId?: string; inicio: number }> = []
  let sinTerminal = 0
  let mesa = 0
  let lectura = 0
  const mesas = m.f.mesas ?? [m.f.tableId]
  const anotar = (etiqueta: string, r: RespuestaHttp) => registros.push({ etiqueta, ms: r.ms, status: r.status, inicio: r.inicio })
  const enVuelo = new Set<Promise<void>>()
  const lanzar = (p: Promise<void>) => {
    enVuelo.add(p)
    void p.finally(() => enVuelo.delete(p))
  }

  const llegada = () => {
    // Lecturas (cada una con su propia llave de cliente en A+/B).
    lanzar(m.pos.leerOrdenes(new LlaveDeCliente(MODO)).then(r => anotar('GET ordenes', r)))
    const otraSucursal = m.f.venue2Id && lectura++ % 2 === 1 ? m.f.venue2Id : undefined
    lanzar(m.pos.leerTiposDePago(new LlaveDeCliente(MODO), otraSucursal).then(r => anotar('GET tipos-de-pago', r)))
    const tpv = m.tpvs.find(t => !t.ocupada)
    if (!tpv) {
      sinTerminal++
      return
    }
    tpv.ocupada = true
    const tableId = mesas[mesa++ % mesas.length]
    const inicio = Date.now()
    lanzar(
      unCobro(0, m.f, m.pos, tpv, null, { esperaEfectosMs: 0, modo: MODO, tableId })
        .then(async r => {
          for (const [k, p] of Object.entries(r.pasos))
            if (p.status !== undefined && p.ini !== undefined && p.fin !== undefined)
              registros.push({ etiqueta: k, ms: p.fin - p.ini, status: p.status, inicio: p.inicio ?? inicio })
          if (r.orderId) anotar('GET orden', await m.pos.leerOrden(new LlaveDeCliente(MODO), r.orderId))
          const p3 = r.pasos['3_cobro_en_terminal']
          cobros.push({ ok: r.ok, ms: (p3?.fin ?? NaN) - 0, falla: r.fallas[0], paymentId: r.paymentId, inicio })
        })
        .finally(() => {
          tpv.ocupada = false
        }),
    )
  }

  if (v.alinearSegundo !== undefined) {
    const a = new Date()
    let ms = ((v.alinearSegundo - a.getSeconds() + 60) % 60) * 1000 - a.getMilliseconds()
    if (ms < 0) ms += 60_000
    await new Promise(r => setTimeout(r, ms))
  }
  const ini = Date.now()
  // marca para el orquestador (p. ej. el brazo C «recuperación» cambia el destino a mitad de la ventana)
  escribir(`ventana-${v.nombre}.inicio.json`, { inicio: ini })
  const intervalo = 1000 / v.tasa
  const total = Math.round(v.tasa * v.duracionS)
  for (let k = 0; k < total; k++) {
    const objetivo = ini + k * intervalo
    const espera = objetivo - Date.now()
    if (espera > 0) await new Promise(r => setTimeout(r, espera))
    llegada()
  }
  const fin = Date.now()
  const limite = Date.now() + 60_000
  while (enVuelo.size && Date.now() < limite) await Promise.race([...enVuelo, new Promise(r => setTimeout(r, 1000))])

  const porEtiqueta: Record<string, any> = {}
  for (const e of [...new Set(registros.map(r => r.etiqueta))]) {
    const rs = registros.filter(r => r.etiqueta === e)
    porEtiqueta[e] = {
      ...resumen(rs.map(r => r.ms)),
      errores: rs.filter(r => r.status === 0 || r.status >= 500).length,
      no2xx: rs.filter(r => r.status < 200 || r.status >= 300).length,
      // crudo (para p95 agregado y comparaciones pareadas en el reporte)
      ms: rs.filter(r => r.inicio >= ini && r.inicio <= fin).map(r => Math.round(r.ms * 10) / 10),
    }
  }
  const fallas: Record<string, number> = {}
  for (const c of cobros.filter(c => !c.ok)) fallas[(c.falla ?? '?').slice(0, 80)] = (fallas[(c.falla ?? '?').slice(0, 80)] ?? 0) + 1

  // «hasta DONE»: sólo si se pide (tasa baja). Se espera dos vueltas del cron y se lee la base.
  let done: any = null
  const pagos = cobros.map(c => c.paymentId).filter(Boolean) as string[]
  if (v.medirDone && pagos.length) {
    await new Promise(r => setTimeout(r, 65_000))
    const filas = (
      await db.query(`SELECT "paymentId", kind, status, "createdAt", "completedAt" FROM "PaymentEffect" WHERE "paymentId" = ANY($1)`, [pagos])
    ).rows
    done = filas.map(f => ({ kind: f.kind, status: f.status, creado: new Date(f.createdAt).getTime(), completado: f.completedAt ? new Date(f.completedAt).getTime() : null }))
  }
  const pendientes = Number((await db.query(`SELECT count(*)::int AS n FROM "PaymentEffect" WHERE status IN ('PENDING','PROCESSING')`)).rows[0].n)

  return {
    nombre: v.nombre,
    tasa: v.tasa,
    duracionS: v.duracionS,
    inicio: ini,
    fin,
    llegadas: total,
    sinTerminal,
    peticionesHttp: registros.filter(r => r.inicio >= ini && r.inicio <= fin).length,
    porEtiqueta,
    cobros: { iniciados: cobros.length, ok: cobros.filter(c => c.ok).length, fallas },
    efectosPendientesAlFinal: pendientes,
    done,
  }
}

async function main() {
  const t0 = Number(process.env.SERVER_T0_MS || Date.now())
  const ventanas: Ventana[] = JSON.parse(process.env.VENTANAS || '[]')
  const f0 = (await import('./montaje')).leerFixture()
  const listoMs = await esperarListo(f0, t0)
  console.log(`✅ listo (respuesta autenticada) a los ${listoMs} ms`)
  const reposoS = Number(process.env.REPOSO_S || 0)
  const inicioReposo = Date.now()
  if (reposoS) await new Promise(r => setTimeout(r, reposoS * 1000))
  const finReposo = Date.now()
  const m = await montar(Number(process.env.N_TPV || 40))
  const db = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'exp-otel-carga' })
  await db.connect()
  const resultados = []
  for (const v of ventanas) {
    console.log(`▶ ventana ${v.nombre}: ${v.tasa} cobros/s × ${v.duracionS} s`)
    const r = await ventana(m, v, db)
    console.log(`  ${r.cobros.ok}/${r.cobros.iniciados} cobros ok · sin terminal ${r.sinTerminal} · pendientes ${r.efectosPendientesAlFinal}`)
    resultados.push(r)
  }
  await db.end()
  for (const t of m.tpvs) t.cerrar()
  escribir(process.env.SALIDA || 'carga.json', {
    modoCliente: MODO,
    modoTokenPos: m.pos.modoToken,
    paridadDelTokenTpv: m.paridadDelTokenTpv,
    listoMs,
    reposo: { inicio: inicioReposo, fin: finReposo },
    ventanas: resultados,
  })
  process.exit(0)
}

if (require.main === module)
  main().catch(e => {
    console.error('❌ carga abortada:', e)
    process.exit(2)
  })
