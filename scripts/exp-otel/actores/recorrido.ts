/**
 * EXPERIMENTO OTel — el RECORRIDO CONGELADO de un cobro con tarjeta (plan, corrección 1). Ocho pasos:
 *
 *   ① POS  POST /mobile/venues/:venueId/orders                (con un artículo)
 *   ② POS  POST /mobile/venues/:venueId/orders/:orderId/items (ronda; exige TABLE_SERVICE y version)
 *   ③ POS  POST /mobile/venues/:venueId/terminal-payment      (long-poll)
 *   ④ server → TPV  `terminal:payment_request`; TPV → ACK {accepted:true, requestId}
 *   ⑤ TPV  `terminal:payment_attempt_opened`
 *   ⑥ TPV  POST /tpv/venues/:venueId/orders/:orderId (recordPayment) y luego `terminal:payment_result`
 *   ⑦ server: `recordOrderPayment` guarda el Payment y ENCOLA PaymentEffect (en la misma transacción)
 *   ⑧ `PaymentEffectsJob` → `runClaimedPaymentEffect` lleva cada efecto a DONE
 *
 * El banco se SIMULA (la TPV declara la aprobación). La verificación es en Postgres, no en lo que diga la API.
 */
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { Fixture, PosDeScript } from './pos'
import type { TpvDeScript } from './tpv'

export interface ResultadoDelCobro {
  n: number
  ok: boolean
  fallas: string[]
  terminal: string
  requestId: string
  orderId?: string
  paymentId?: string
  attemptId?: string
  inicioIso: string
  /** ms desde el inicio del cobro (reloj monotónico del actor) */
  pasos: Record<string, { ini?: number; fin?: number; status?: number; correlationId?: string | null }>
  efectos?: Array<{ kind: string; status: string; attempts: number; createdAt: string; completedAt: string | null; lastError: string | null }>
  db?: Record<string, unknown>
  ackIntento?: unknown
  ackResultado?: unknown
  respuestaCobro?: unknown
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function unCobro(
  n: number,
  f: Fixture,
  pos: PosDeScript,
  tpv: TpvDeScript,
  db: Client,
  opciones: { esperaEfectosMs: number },
): Promise<ResultadoDelCobro> {
  const t0 = performance.now()
  const rel = (t?: number) => (t === undefined ? undefined : Math.round((t - t0) * 10) / 10)
  const requestId = randomUUID()
  const res: ResultadoDelCobro = {
    n,
    ok: false,
    fallas: [],
    terminal: tpv.serial,
    requestId,
    inicioIso: new Date().toISOString(),
    pasos: {},
  }
  const falla = (m: string) => res.fallas.push(m)

  try {
    // ①
    let ini = performance.now()
    const r1 = await pos.crearOrden()
    res.pasos['1_crear_orden'] = { ini: rel(ini), fin: rel(performance.now()), status: r1.status, correlationId: r1.correlationId }
    const orden = r1.cuerpo?.order
    if (r1.status !== 201 || !orden?.id) throw new Error(`① crear orden: HTTP ${r1.status} ${JSON.stringify(r1.cuerpo).slice(0, 500)}`)
    res.orderId = orden.id
    const version = typeof orden.version === 'number' ? orden.version : 1

    // ②
    ini = performance.now()
    const r2 = await pos.agregarRonda(orden.id, version)
    res.pasos['2_agregar_ronda'] = { ini: rel(ini), fin: rel(performance.now()), status: r2.status, correlationId: r2.correlationId }
    if (r2.status !== 200) throw new Error(`② agregar ronda: HTTP ${r2.status} ${JSON.stringify(r2.cuerpo).slice(0, 500)}`)
    const total = Number(r2.cuerpo?.data?.total)
    if (!Number.isFinite(total) || total <= 0) throw new Error(`② total inválido: ${JSON.stringify(r2.cuerpo?.data?.total)}`)
    const amountCents = Math.round(total * 100)

    // ③ (long-poll) — en paralelo, la TPV hace ④⑤⑥ al recibir la solicitud.
    ini = performance.now()
    const esperaTpv = tpv.esperarLinea(requestId, 120_000)
    const r3 = await pos.cobrarEnTerminal({ orderId: orden.id, amountCents, terminalSerial: tpv.serial, requestId })
    res.pasos['3_cobro_en_terminal'] = { ini: rel(ini), fin: rel(performance.now()), status: r3.status, correlationId: r3.correlationId }
    res.respuestaCobro = r3.cuerpo
    const linea = await esperaTpv.catch(e => {
      falla(String(e.message ?? e))
      return tpv.lineas.get(requestId)
    })
    if (linea) {
      res.pasos['4_solicitud_por_socket'] = { ini: rel(linea.recibido), fin: rel(linea.ackEnviado) }
      res.pasos['5_intento_abierto'] = { ini: rel(linea.intentoAbiertoIni), fin: rel(linea.intentoAbiertoFin) }
      res.pasos['6_registro_del_cobro'] = {
        ini: rel(linea.registroIni),
        fin: rel(linea.registroFin),
        status: linea.registroStatus,
        correlationId: linea.registroCorrelationId,
      }
      res.pasos['6b_resultado_por_socket'] = { ini: rel(linea.resultadoIni), fin: rel(linea.resultadoFin) }
      res.paymentId = linea.paymentId
      res.attemptId = linea.attemptId
      res.ackIntento = linea.ackIntento
      res.ackResultado = linea.ackResultado
      if (linea.error) falla(`TPV: ${linea.error}`)
      if (linea.payload?.orderId !== orden.id) falla(`④ la solicitud por socket trae otra orden: ${linea.payload?.orderId}`)
      if (linea.payload?.amountCents !== amountCents) falla(`④ monto por socket ${linea.payload?.amountCents} ≠ ${amountCents}`)
    } else {
      falla('④ la TPV nunca recibió terminal:payment_request')
    }
    if (r3.status !== 200 || r3.cuerpo?.success !== true) falla(`③ cobro en terminal: HTTP ${r3.status} ${JSON.stringify(r3.cuerpo).slice(0, 500)}`)
    if (res.paymentId && r3.cuerpo?.paymentId && r3.cuerpo.paymentId !== res.paymentId)
      falla(`③ el POS recibió otro paymentId (${r3.cuerpo.paymentId}) que el registrado (${res.paymentId})`)

    // ⑦⑧ — verificación en Postgres.
    if (res.paymentId) {
      const pago = (
        await db.query(`SELECT status::text, amount::text, "merchantAccountId", "orderId", "idempotencyKey" FROM "Payment" WHERE id=$1`, [
          res.paymentId,
        ])
      ).rows[0]
      const ord = (await db.query(`SELECT status::text, "paymentStatus"::text, total::text FROM "Order" WHERE id=$1`, [orden.id])).rows[0]
      const sol = (
        await db.query(`SELECT status::text, "paymentId", "closedVia" FROM "TerminalPaymentRequest" WHERE "requestId"=$1`, [requestId])
      ).rows[0]
      const vinculo = (await db.query(`SELECT "requestId" FROM "TerminalPaymentAttemptLink" WHERE "attemptId"=$1`, [res.attemptId])).rows[0]
      res.db = { pago, orden: ord, solicitud: sol, vinculo: vinculo ?? null }
      if (pago?.status !== 'COMPLETED') falla(`⑦ Payment.status=${pago?.status}`)
      if (pago?.merchantAccountId !== f.merchantAccountId) falla(`⑦ Payment.merchantAccountId=${pago?.merchantAccountId}`)
      if (pago?.idempotencyKey !== res.attemptId) falla(`⑦ Payment.idempotencyKey ≠ attemptId`)
      if (ord?.paymentStatus !== 'PAID') falla(`⑦ Order.paymentStatus=${ord?.paymentStatus}`)
      if (sol?.status !== 'COMPLETED' || sol?.paymentId !== res.paymentId) falla(`⑦ TerminalPaymentRequest=${JSON.stringify(sol)}`)
      if (!vinculo || vinculo.requestId !== requestId) falla(`⑤ sin TerminalPaymentAttemptLink para el intento`)

      // ⑧ el job corre a los segundos 16 y 46 de cada minuto: se espera a que TODOS los efectos queden DONE.
      const t8 = performance.now()
      let efectos: any[] = []
      while (performance.now() - t8 < opciones.esperaEfectosMs) {
        efectos = (
          await db.query(
            `SELECT kind, status, attempts, "createdAt", "completedAt", "lastError" FROM "PaymentEffect" WHERE "paymentId"=$1 ORDER BY kind`,
            [res.paymentId],
          )
        ).rows
        if (efectos.length > 0 && efectos.every(e => e.status === 'DONE')) break
        await sleep(500)
      }
      res.pasos['8_efectos_done'] = { ini: rel(t8), fin: rel(performance.now()) }
      res.efectos = efectos.map(e => ({
        kind: e.kind,
        status: e.status,
        attempts: e.attempts,
        createdAt: new Date(e.createdAt).toISOString(),
        completedAt: e.completedAt ? new Date(e.completedAt).toISOString() : null,
        lastError: e.lastError,
      }))
      if (efectos.length === 0) falla('⑦ no se encoló ningún PaymentEffect')
      else if (!efectos.every(e => e.status === 'DONE'))
        falla(`⑧ efectos sin terminar tras ${opciones.esperaEfectosMs} ms: ${efectos.map(e => `${e.kind}=${e.status}`).join(', ')}`)
    } else {
      falla('⑥ no hubo paymentId')
    }
  } catch (e: any) {
    falla(e?.message ?? String(e))
  }
  res.ok = res.fallas.length === 0
  return res
}
