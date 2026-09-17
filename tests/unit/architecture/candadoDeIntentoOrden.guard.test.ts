/**
 * Guardia estática — Codex R6-2 (webhook primer confirmador, checkpoint 1): el ORDEN de los candados que hacen segura la
 * decisión sobre un intento. Una prueba de intercalación demuestra que dos transacciones se serializan; lo que NO puede
 * demostrar de forma determinista es el orden de adquisición dentro de cada una (un interbloqueo por orden inverso aparece
 * una de cada N corridas). Aquí se fija el orden leyendo la fuente:
 *
 *  · La publicación del vínculo S1: `candadoDeIntento` ANTES de insertar el vínculo y de reabrir.
 *  · Todo escritor por identidad DÉBIL: `candadoDeIntento` → candado de la fila del evento → lectura de S1 (sentencias
 *    separadas: fotografía nueva bajo READ COMMITTED) → escritura.
 *  · La reapertura: `candadoDeIntento` → TODOS los eventos del intento (FOR UPDATE) → los Payments implicados, DISTINTOS y en
 *    `id ASC` con `FOR NO KEY UPDATE` — dos reaperturas con Payments compartidos en orden inverso no pueden interbloquearse.
 *  · La unidad de convergencia del costo: la fila del Payment con `FOR NO KEY UPDATE NOWAIT` como PRIMERA sentencia (mutex sin
 *    espera; NO KEY para no bloquear los INSERT ajenos por FK).
 *  · El candado consultivo: dos llaves (`namespace`, `hashtext(llave)`), con `SET LOCAL lock_timeout` en su propia sentencia.
 *  · La MISMA normalización de la llave (`llaveDeIntento`) al persistir el `attemptId` del evento y al bloquear.
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../../src')
const leer = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8')
/** Índice de `aguja` dentro de `texto` a partir de `desde`; falla la prueba si no está. */
const indice = (texto: string, aguja: string, desde = 0) => {
  const i = texto.indexOf(aguja, desde)
  expect(i).toBeGreaterThanOrEqual(0)
  return i
}
/** `a` aparece ANTES que `b` dentro del tramo que empieza en `desde`. */
const antes = (texto: string, a: string, b: string, desde = 0) => {
  const ia = indice(texto, a, desde)
  const ib = indice(texto, b, desde)
  expect(ia).toBeLessThan(ib)
}

describe('Codex R6-2 · el candado por intento y el orden de adquisición (guardia estática)', () => {
  it('el candado consultivo es de DOS llaves en un namespace propio, con la espera acotada en una sentencia aparte', () => {
    const s = leer('services/tpv/candadoDeIntento.ts')
    expect(s).toMatch(/SET LOCAL lock_timeout/)
    expect(s).toMatch(/pg_advisory_xact_lock\(\$\{NS_CANDADO_INTENTO\}::int, hashtext\(\$\{llave\}\)\)/)
    antes(s, 'SET LOCAL lock_timeout', 'pg_advisory_xact_lock')
  })

  it('la publicación del vínculo toma el candado del intento ANTES de insertar el vínculo y de reabrir, dentro de la MISMA transacción', () => {
    const s = leer('services/terminal-payment.service.ts')
    const desde = indice(s, 'await candadoDeIntento(tx, attemptId)')
    antes(s, 'await candadoDeIntento(tx, attemptId)', 'terminalPaymentAttemptLink.create(', desde)
    antes(s, 'terminalPaymentAttemptLink.create(', 'await recuperarEventosDebilesPorVinculo(attemptId, requestId, tx)', desde)
  })

  it('Codex r1 (P1-C) · el candado por SOLICITUD: namespace propio, y orden fijo solicitud → intentos en la ventana y en la publicación del vínculo; el fallback del webhook inserta bajo el candado de la solicitud', () => {
    const c = leer('services/tpv/candadoDeIntento.ts')
    expect(c).toMatch(/export const NS_CANDADO_SOLICITUD = 7_310_114/)
    expect(c).toMatch(/pg_advisory_xact_lock\(\$\{NS_CANDADO_SOLICITUD\}::int, hashtext\(\$\{requestId\}\)\)/)
    const solicitud = indice(c, 'export async function candadoDeSolicitud(')
    antes(c, 'SET LOCAL lock_timeout', 'pg_advisory_xact_lock(${NS_CANDADO_SOLICITUD}', solicitud)

    const s = leer('services/terminal-payment.service.ts')
    // La VENTANA: candado de la solicitud → vínculos enumerados DENTRO de la transacción → candado de cada intento → veto → CAS.
    const ventana = indice(s, 'async releaseUnprovenNegative(')
    antes(s, 'await candadoDeSolicitud(tx, requestId)', 'tx.terminalPaymentAttemptLink.findMany(', ventana)
    antes(
      s,
      'tx.terminalPaymentAttemptLink.findMany(',
      'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)',
      ventana,
    )
    antes(
      s,
      'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)',
      'await this.aprobacionBancariaConocida(tx, venueId, attemptIds)',
      ventana,
    )
    // Codex r2 (P1-A): el NEGATIVO de la terminal (`closeRow`) se decide y se escribe en UNA transacción con el mismo orden que la
    // ventana — candado de la solicitud → vínculos enumerados DENTRO → candado de cada intento → veto bancario → UPDATE crudo con
    // `NOT EXISTS` de APROBADO (`sinAprobadoVinculadoSql`) — y sólo el `success` se queda fuera de ella.
    const cierre = indice(s, 'private async closeRow(')
    const txDelNegativo = indice(s, 'prisma.$transaction(', cierre)
    antes(s, 'await candadoDeSolicitud(tx, requestId)', 'tx.terminalPaymentAttemptLink.findMany(', txDelNegativo)
    antes(
      s,
      'tx.terminalPaymentAttemptLink.findMany(',
      'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)',
      txDelNegativo,
    )
    antes(
      s,
      'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)',
      'await this.aprobacionBancariaConocida(tx, venueId, attemptIds)',
      txDelNegativo,
    )
    antes(s, 'await this.aprobacionBancariaConocida(tx, venueId, attemptIds)', 'sinAprobadoVinculadoSql(requestId, venueId)', txDelNegativo)
    expect(s.slice(txDelNegativo, indice(s, 'async closeRowFromPaymentTx(', cierre))).toMatch(/OPCIONES_DE_TRANSACCION_DEL_INTENTO/)
    // La PUBLICACIÓN del vínculo: candado de la solicitud → candado del intento → INSERT del vínculo.
    const publicacion = indice(s, 'async handleAttemptOpenedFromSocket(')
    antes(s, 'await candadoDeSolicitud(tx, requestId)', 'await candadoDeIntento(tx, attemptId)', publicacion)
    antes(s, 'await candadoDeIntento(tx, attemptId)', 'terminalPaymentAttemptLink.create(', publicacion)
    // Revisión final (17-sep, B): la RE-RETENCIÓN de una solicitud liberada cuando el banco aprobó después usa el MISMO orden que la
    // ventana — candado de la solicitud → vínculos enumerados DENTRO → candado de cada intento → relectura → CAS con el EXISTS de
    // APROBADO y el NOT EXISTS de Payment ligado —, en su propia transacción del protocolo.
    const reRetencion = indice(s, 'async retenerSolicitudLiberadaPorAprobacion(')
    const txDeReRetencion = indice(s, 'prisma.$transaction(', reRetencion)
    antes(s, 'await candadoDeSolicitud(tx, requestId)', 'tx.terminalPaymentAttemptLink.findMany(', txDeReRetencion)
    antes(
      s,
      'tx.terminalPaymentAttemptLink.findMany(',
      'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)',
      txDeReRetencion,
    )
    antes(
      s,
      'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)',
      'hayAprobadoVinculadoSql(requestId, venueId)',
      txDeReRetencion,
    )
    antes(s, 'hayAprobadoVinculadoSql(requestId, venueId)', 'sinPagoLigadoSql(requestId, venueId)', txDeReRetencion)
    expect(s.slice(txDeReRetencion, indice(s, 'async releaseUnprovenNegativesAfterWindow(', reRetencion))).toMatch(
      /OPCIONES_DE_TRANSACCION_DEL_INTENTO/,
    )
    // El FALLBACK del webhook (55P03 sobre el candado del intento): resuelve la solicitud por el vínculo e inserta bajo SU candado.
    const w = leer('services/tpv/angelpay-webhook.service.ts')
    const ingreso = indice(w, 'async function ingresarEventoDelIntento(')
    const fallback = indice(w, 'if (!esEsperaDeCandadoVencida(error)) throw error', ingreso)
    antes(w, 'terminalPaymentAttemptLink.findUnique(', 'await candadoDeSolicitud(tx, ', fallback)
    antes(w, 'await candadoDeSolicitud(tx, ', 'insertar(tx, marca)', fallback)
  })

  it('Ronda 2 (17-sep, P1) · la re-retención de una solicitud LIBERADA (por aprobación o por un cobro sin ligar) vive en UN núcleo con el orden de la ventana, y nunca corre dentro de una transacción ajena', () => {
    const s = leer('services/terminal-payment.service.ts')
    // El núcleo: candado de la solicitud → vínculos enumerados DENTRO → candado de cada intento → los Payments ligados leídos BAJO
    // los candados → CAS con el EXISTS de Payment ligado (variante del cobro sin ligar) o con EXISTS de aprobado + NOT EXISTS de Payment
    // (variante de la aprobación), en su propia transacción del protocolo.
    const nucleo = indice(s, 'private async reRetenerSolicitudLiberada(')
    const tx = indice(s, 'prisma.$transaction(', nucleo)
    antes(s, 'await candadoDeSolicitud(tx, requestId)', 'tx.terminalPaymentAttemptLink.findMany(', tx)
    antes(s, 'tx.terminalPaymentAttemptLink.findMany(', 'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)', tx)
    antes(s, 'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)', 'await pagosLigados(tx, requestId, venueId)', tx)
    antes(s, 'await pagosLigados(tx, requestId, venueId)', 'hayPagoLigadoSql(requestId, venueId)', tx)
    antes(s, 'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)', 'hayAprobadoVinculadoSql(requestId, venueId)', tx)
    expect(s.slice(tx, indice(s, 'async releaseUnprovenNegativesAfterWindow(', nucleo))).toMatch(/OPCIONES_DE_TRANSACCION_DEL_INTENTO/)
    // Las dos entradas públicas DELEGAN en el núcleo antes de cualquier transacción propia: una sola transacción para las dos variantes.
    for (const fn of ['async retenerSolicitudLiberadaPorAprobacion(', 'async retenerSolicitudLiberadaPorPagoSinLigar(']) {
      antes(s, 'this.reRetenerSolicitudLiberada(', 'prisma.$transaction(', indice(s, fn))
    }
    // La consolidación DETALLADA corre anidada dentro de la transacción del registrador (referencia sin llave, `exclusionPorReferencia`):
    // ahí NO se re-retiene — lo hacen sus llamadores fuera de transacción (la envoltura fuerte y `devolverExistentePorReferencia`).
    const r = leer('services/tpv/registroRepetido.ts')
    const fuerte = indice(r, 'export async function consolidarRegistroRepetido<')
    const detallada = r.slice(indice(r, 'export async function consolidarRegistroRepetidoDetallado'), fuerte)
    expect(detallada).not.toMatch(/retenerLiberadasPorPagoSinLigar|retenerSolicitudLiberadaPorPagoSinLigar/)
    expect(r.slice(fuerte)).toMatch(/terminalPaymentService\.retenerLiberadasPorPagoSinLigar\(/)
    // El registrador la pide DESPUÉS de su transacción financiera (el mismo punto que el aviso de aprobación tardía), y la resolución
    // por referencia la pide al DEVOLVER el existente, nunca dentro de `exclusionPorReferencia`.
    const p = leer('services/tpv/payment.tpv.service.ts')
    const exclusion = p.slice(indice(p, 'async function exclusionPorReferencia('), indice(p, 'type SegundaCapturaRegistrada'))
    expect(exclusion).not.toMatch(/retener/)
    for (const fn of ['export async function recordOrderPayment(', 'export async function recordFastPayment(']) {
      const desde = indice(p, fn)
      // Tras el commit: junto al aviso de aprobación tardía y antes de responder la evidencia (segunda captura / colisión).
      const avisoTardio = indice(p, 'avisarAprobacionTardiaTrasVentana(s0.cierre, {', desde)
      antes(p, 'await retenerSiQuedoSinLigar(', 'if (s0.segundaCaptura) return', avisoTardio)
      // Al devolver el existente por referencia: antes de armar la respuesta.
      const porReferencia = indice(p, 'const devolverExistentePorReferencia = async', desde)
      antes(p, 'await retenerSiQuedoSinLigar(', 'return {', porReferencia)
    }
  })

  it('Ronda 3 (17-sep) · las DOS señales nuevas viven en el MISMO núcleo y bajo los MISMOS candados; sus llamadores la piden fuera de toda transacción', () => {
    const s = leer('services/terminal-payment.service.ts')
    const nucleo = indice(s, 'private async reRetenerSolicitudLiberada(')
    const tx = indice(s, 'prisma.$transaction(', nucleo)
    // La evidencia de CADA variante nueva se arma DESPUÉS de los candados y de la relectura, junto al CAS que la evalúa.
    antes(
      s,
      'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)',
      'hayEvidenciaDeConciliacionSql(requestId, venueId)',
      tx,
    )
    antes(s, 'for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)', 'NOT (${SIN_AFIRMACION_DE_LA_TERMINAL_SQL})', tx)
    // 🔴 P1-B: la identidad (regla T10) se juzga BAJO los candados, sobre la evidencia leída por el SERVIDOR, y antes del CAS.
    antes(s, "if (variante.tipo === 'COLISION_DE_REFERENCIA') {", 'procedenciaDelPagoDeSolicitud(', tx)
    antes(s, 'procedenciaDelPagoDeSolicitud(', 'UPDATE "TerminalPaymentRequest"', tx)
    // Las dos entradas públicas nuevas DELEGAN en el núcleo antes de cualquier transacción propia.
    for (const fn of [
      'async retenerSolicitudLiberadaPorColisionDeReferencia(',
      'async retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(',
    ]) {
      antes(s, 'this.reRetenerSolicitudLiberada(', 'prisma.$transaction(', indice(s, fn))
    }
    // P1-C: en `closeRow`, la afirmación se PERSISTE primero (`escribirSuccessDegradado`) y sólo entonces se pide la
    // re-retención; el resultado se RELEE, porque el del escritor proyecta la fila anterior.
    const cierre = indice(s, 'private async closeRow(')
    antes(s, 'await this.escribirSuccessDegradado(', 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(', cierre)
    antes(s, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(', 'const fresca = await prisma.terminalPaymentRequest.findFirst(', cierre)
    // P1-A: la red durable NO abre transacción propia ni pregunta fila por fila — una consulta correlacionada por lote.
    const red = indice(s, 'private async retenerLiberadasConSenalPositiva(')
    const cuerpoDeLaRed = s.slice(red, indice(s, 'private async paginarLiberadas(', red))
    expect(cuerpoDeLaRed).not.toMatch(/\$transaction/)
    expect(cuerpoDeLaRed).toMatch(/JOIN LATERAL/)
    expect(cuerpoDeLaRed).toMatch(/pagoLigadoDeLaFilaSql\('r'\)/)
    expect(cuerpoDeLaRed).toMatch(/utcTs\(horizonte\)/)
    // P1-B: el registrador la pide DESPUÉS de su transacción financiera y ANTES de responder la colisión al cajero.
    const p = leer('services/tpv/payment.tpv.service.ts')
    for (const fn of ['export async function recordOrderPayment(', 'export async function recordFastPayment(']) {
      const avisoTardio = indice(p, 'avisarAprobacionTardiaTrasVentana(s0.cierre, {', indice(p, fn))
      antes(p, 'await retenerSiHayColisionSobreUnaLiberada(', 'if (s0.colision) return', avisoTardio)
    }
    // Y la evidencia que viaja es la que el registrador CREÓ (la fila del Payment), nunca el `terminalPaymentRequestId` del cuerpo.
    const inicioDeLaEnvoltura = indice(p, 'async function retenerSiHayColisionSobreUnaLiberada(')
    const envoltura = p.slice(inicioDeLaEnvoltura, indice(p, '\n}', inicioDeLaEnvoltura))
    expect(envoltura).toMatch(/evidencia\.terminalPaymentRequestId \?\? solicitudDelRegistro\(evidencia\.processorData\)/)
    expect(envoltura).toMatch(/capturedBySerial/)
    // Sólo el camino REST: el del webhook ya tiene la re-retención de la ronda 1, con un marcador más preciso.
    expect(envoltura).toMatch(/if \(paymentData\.registradoVia === 'webhook'\) return/)
    // P1-A: el BACKFILL la pide ANTES de sellar su evento; un `DEFERRED` no sella (el evento sigue PENDING para el worker).
    const w = leer('services/tpv/angelpay-webhook.service.ts')
    const reclamar = indice(w, 'const reclamarYEstampar = async')
    antes(w, 'await pedirReRetencionDeLiberadas()', 'escribirPorIdentidadDebil({', reclamar)
    expect(w).toMatch(/retenerLiberadasPorPagoSinLigar\(pago, 'BACKFILL'\)/)
  })

  it('Ronda 4 (17-sep) · la RED DURABLE recoge las TRES señales en el MISMO recorrido, y ninguna abre transacción propia', () => {
    const s = leer('services/terminal-payment.service.ts')
    const red = indice(s, 'private async retenerLiberadasConSenalPositiva(')
    const cuerpo = s.slice(red, indice(s, 'private async paginarLiberadas(', red))
    // Un solo SELECT: las dos correlacionadas como LATERAL y la afirmación como prueba de la propia fila, en UN `OR`.
    expect(cuerpo.match(/prisma\.\$queryRaw/g) ?? []).toHaveLength(1)
    expect(cuerpo).toMatch(/LEFT JOIN LATERAL \(\$\{pagoLigadoDeLaFilaSql\('r'\)\} LIMIT 1\) ligado/)
    expect(cuerpo).toMatch(/LEFT JOIN LATERAL \(\$\{evidenciaDeConciliacionDeLaFilaSql\('r'\)\} LIMIT 1\) colision/)
    expect(cuerpo).toMatch(/ligado\."id" IS NOT NULL OR colision\."id" IS NOT NULL OR \$\{hayAfirmacion\}/)
    // El MISMO recorrido: un solo keyset, un solo tope de lotes, un solo horizonte.
    expect(cuerpo).toMatch(/for \(let lote = 0; lote < LOTES_MAXIMOS_DE_LIBERADAS; lote\+\+\)/)
    expect(cuerpo.match(/LIMIT \$\{TAMANO_DEL_LOTE_LIBERADAS\}/g) ?? []).toHaveLength(1)
    // 🔴 El veredicto COMPARTIDO va ANTES que las variantes sin Payment (un cobro atribuible se concilia, no se retiene).
    antes(s, "this.conciliarORetenerLiberada(row, 'BARRIDO_LIGADOS')", 'this.retenerPorSenalSinPago(row, fila)', red)
    // Las dos variantes sin Payment reusan el núcleo (ningún CAS nuevo) y nunca dentro de una transacción.
    const senal = indice(s, 'private async retenerPorSenalSinPago(')
    const cuerpoSenal = s.slice(senal, indice(s, '\n  /**', senal))
    expect(cuerpoSenal).not.toMatch(/\$transaction/)
    expect(cuerpoSenal).toMatch(/retenerSolicitudLiberadaPorColisionDeReferencia\(/)
    expect(cuerpoSenal).toMatch(/retenerSolicitudLiberadaPorAfirmacionDeLaTerminal\(/)
    expect(cuerpoSenal).toMatch(/origen: 'BARRIDO_SENALES'/)
    // P1-C(b): en `closeRow` la relectura ya NO depende de que gane MI llamada — no hay `return escrito` en medio.
    const cierre = indice(s, 'private async closeRow(')
    const bloque = s.slice(indice(s, 'await this.escribirSuccessDegradado(', cierre), indice(s, 'const data:', cierre))
    expect(bloque).not.toMatch(/!== 'HELD'\)[\s\S]*return escrito/)
    antes(s, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(', 'const fresca = await prisma.terminalPaymentRequest.findFirst(', cierre)
  })

  it('el escritor por identidad DÉBIL: candado del intento → candado del evento → lectura de S1 → escritura', () => {
    const s = leer('services/tpv/angelpay-webhook.service.ts')
    const desde = indice(s, 'async function escribirPorIdentidadDebil(')
    const candado = 'if (args.llaveDelIntento) await candadoDeIntento(tx, args.llaveDelIntento)'
    antes(s, candado, '/* evento */ WHERE "id" = ${args.eventLogId} FOR UPDATE', desde)
    antes(s, '/* evento */ WHERE "id" = ${args.eventLogId} FOR UPDATE', 'tx.terminalPaymentAttemptLink.findUnique(', desde)
    antes(s, 'tx.terminalPaymentAttemptLink.findUnique(', 'tx.providerEventLog.updateMany(', desde)
  })

  it('la reapertura: candado del intento → TODOS los eventos (FOR UPDATE) → Payments DISTINTOS en `id ASC` con FOR NO KEY UPDATE → revocación', () => {
    const s = leer('services/tpv/angelpay-webhook.service.ts')
    const desde = indice(s, 'async function reabrirEventosDebiles(')
    antes(s, 'await candadoDeIntento(tx, llave)', 'ORDER BY "createdAt" ASC, "id" ASC\n    FOR UPDATE', desde)
    antes(s, 'ORDER BY "createdAt" ASC, "id" ASC\n    FOR UPDATE', '/* reapertura */', desde)
    const reapertura = indice(s, '/* reapertura */', desde)
    const pagos = s.slice(reapertura, indice(s, 'FOR NO KEY UPDATE`', reapertura) + 'FOR NO KEY UPDATE`'.length)
    expect(pagos).toMatch(/WHERE "id" IN \(\$\{Prisma\.join\(idsDePago\)\}\)\s+ORDER BY "id" ASC\s+FOR NO KEY UPDATE`/)
    expect(s.slice(desde)).toMatch(/const idsDePago = \[\.\.\.new Set\(recuperables\.map\(e => e\.paymentId as string\)\)\]\.sort\(\)/)
    antes(s, 'FOR NO KEY UPDATE`', 'UPDATE "Payment"\n      SET "processorData" = (${datos} - \'angelpayWebhook\')', reapertura)
  })

  it('la unidad de convergencia del costo toma la fila del Payment con FOR NO KEY UPDATE NOWAIT como PRIMERA sentencia y relee bajo ella', () => {
    const s = leer('services/payments/deferredTransactionCost.service.ts')
    const desde = indice(s, 'export async function convergerCostoDeTransaccion(')
    const tx = indice(s, 'prisma.$transaction(', desde)
    const mutex = indice(s, '/* convergencia */ WHERE "id" = ${paymentId} FOR NO KEY UPDATE NOWAIT', tx)
    // Entre abrir la transacción y el mutex no hay otra consulta.
    expect(s.slice(tx, mutex)).not.toMatch(/await tx\.(?!\$queryRaw<)/)
    antes(s, 'FOR NO KEY UPDATE NOWAIT', 'tx.payment.findUniqueOrThrow({ where: { id: paymentId } })', tx)
    expect(s).toMatch(/55P03/)
  })

  it('Codex R7-1 · la consolidación por referencia (registro repetido): candado del intento → Payment FOR UPDATE → S1 releído en otra sentencia — y el `exigeLlave` del llamador NO viaja', () => {
    const s = leer('services/tpv/registroRepetido.ts')
    const desde = indice(s, 'export async function consolidarRegistroRepetidoDetallado')
    antes(s, 'if (llave) await candadoDeIntento(tx, llave)', '/* consolidacion */', desde)
    antes(s, '/* consolidacion */', 'tx.terminalPaymentAttemptLink.findUnique(', desde)
    antes(s, 'tx.terminalPaymentAttemptLink.findUnique(', 'esElMismoCobroPorReferencia(anclas', desde)
    expect(s.slice(desde)).toMatch(/exigeLlave: exigeLlaveVigente/)
    expect(s).not.toMatch(/entrante\.exigeLlave/)
    const registrador = leer('services/tpv/payment.tpv.service.ts')
    expect(registrador).not.toMatch(/exigeLlave: busqueda\.exigeLlave/)
  })

  it('Codex R15-1 · los ingresos sin candado: el INGRESO los ordena bajo el candado ANTES de fechar el evento nuevo; la recuperación desde S4 es transacción PROPIA (candado del intento → reclamo vigente → orden) y corre ANTES de reconciliar; el selector decide marca y primer aprobado en UNA sentencia; la recuperación sella `ordenadoEn` sin quitar la marca', () => {
    const s = leer('services/tpv/angelpay-webhook.service.ts')
    // El ingreso normal: candado → recuperación de lo pendiente → lectura del último → INSERT.
    const ingreso = indice(s, 'async function ingresarEventoDelIntento(')
    antes(s, 'await candadoDeIntento(tx, llaveDelIntento)', 'await ordenarIngresosPendientesBajoCandado(tx, llaveDelIntento)', ingreso)
    antes(s, 'await ordenarIngresosPendientesBajoCandado(tx, llaveDelIntento)', '/* ingreso del intento */', ingreso)
    // El fallback (55P03) inserta MARCADO.
    expect(s.slice(ingreso)).toMatch(/\[MARCA_INGRESO_SIN_CANDADO\]: \{ en: new Date\(\)\.toISOString\(\) \}/)
    // La recuperación desde S4: transacción propia, candado del intento como PRIMERA sentencia, después el claim, después el orden.
    const s4 = indice(s, 'export async function ordenarIngresosSinCandado(')
    const tx = indice(s, 'prisma.$transaction(', s4)
    const candado = indice(s, 'await candadoDeIntento(tx, llave)', tx)
    expect(s.slice(tx, candado)).not.toMatch(/await tx\./)
    antes(s, 'await candadoDeIntento(tx, llave)', '/* reclamo vigente */', tx)
    antes(s, '/* reclamo vigente */', 'return ordenarIngresosPendientesBajoCandado(tx, llave)', tx)
    // La recuperación en sí: pendientes por `id` bajo FOR UPDATE, fechados desde el máximo del intento (no con el reloj) y con la
    // marca CONSERVADA (se sella `ordenadoEn` con `jsonb_set`; nunca se borra la llave).
    const recuperacion = indice(s, 'async function ordenarIngresosPendientesBajoCandado(')
    const fin = indice(s, 'export async function ordenarIngresosSinCandado(', recuperacion)
    const cuerpo = s.slice(recuperacion, fin)
    expect(cuerpo).toMatch(/\/\* ingresos sin candado \*\/[\s\S]*ORDER BY "id" ASC\s+FOR UPDATE`/)
    expect(cuerpo).toMatch(/SELECT max\("createdAt"\) AS max FROM "ProviderEventLog"/)
    expect(cuerpo).toMatch(/jsonb_set\("payload", \$\{ruta\}::text\[\], to_jsonb\(\$\{ordenadoEn\}::text\), true\)/)
    expect(cuerpo).not.toMatch(/#-/)
    expect(cuerpo).not.toMatch(/Date\.now\(\)/)
    // S4: la recuperación va ANTES de reconciliar, dentro del `try` que deja el evento PENDING si algo falla.
    const worker = leer('services/tpv/angelpayEventWorker.service.ts')
    const run = indice(worker, 'export async function runClaimedAngelPayEvent(')
    antes(worker, 'await ordenarIngresosSinCandado({', 'await reconciliarEventoPendiente({', run)
    antes(worker, 'try {', 'await ordenarIngresosSinCandado({', run)
    // El selector: UNA sola sentencia decide `sinOrden` y `primeraId` sobre la misma fotografía.
    const selector = leer('services/tpv/evidenciaDeIngreso.ts')
    const desde = indice(selector, 'export async function evidenciaDurableDelIngreso(')
    const consultas = (selector.slice(desde).match(/db\.\$queryRaw/g) ?? []).length
    expect(consultas).toBe(1)
    expect(selector.slice(desde)).toMatch(/AS "sinOrden"[\s\S]*AS "primeraId"/)
    expect(selector.slice(desde)).toMatch(/if \(fila\?\.sinOrden\) return \{ tipo: 'ORDEN_NO_ACREDITADO' \}/)
  })

  it('Codex R15-2 · la corrección por lote (apply y reverse): ORIGINALES sin esperar (NOWAIT, savepoint interior) → lote en `id ASC` (`bloquearPayments`) → relectura → clasificación; el intento entero vive en un savepoint exterior que se revierte si algo cambió', () => {
    const s = leer('services/shared/candadosDelLote.ts')
    const desde = indice(s, 'export async function bloquearLoteConOriginales(')
    antes(s, 'SAVEPOINT lote_del_protocolo', 'const foto = await fotografiar()', desde)
    antes(s, 'const foto = await fotografiar()', 'await bloquearSinEsperar(tx, original, marcador)', desde)
    antes(s, 'await bloquearSinEsperar(tx, original, marcador)', 'await bloquearPayments(tx, bloqueables, marcador)', desde)
    antes(s, 'await bloquearPayments(tx, bloqueables, marcador)', 'const relectura = await fotografiar()', desde)
    antes(s, 'const relectura = await fotografiar()', 'ROLLBACK TO SAVEPOINT lote_del_protocolo', desde)
    expect(s.slice(desde)).toMatch(/for \(let intento = 0; intento < 3; intento\+\+\)/)
    expect(s.slice(desde)).toMatch(/'RATE_CORRECTION_LOCK_UNSTABLE'/)
    // La fase de originales nunca espera: NOWAIT con su savepoint interior, y el 55P03 se traduce en «ocupado», no en error.
    const sinEsperar = s.slice(indice(s, 'async function bloquearSinEsperar('), desde)
    expect(sinEsperar).toMatch(/FOR NO KEY UPDATE NOWAIT/)
    antes(sinEsperar, 'SAVEPOINT original_sin_esperar', 'FOR NO KEY UPDATE NOWAIT')
    antes(sinEsperar, 'FOR NO KEY UPDATE NOWAIT', 'ROLLBACK TO SAVEPOINT original_sin_esperar')
    // La fase del lote se toma A TRAVÉS del módulo hermano (`bloquearPayments` importado), y el original se pide ordenado y único.
    expect(s).toMatch(/import \{ bloquearPayments, type MarcadorDeCandado \} from '\.\/cobroDelProtocolo'/)
    expect(s.slice(desde)).toMatch(/const originales = \[\.\.\.new Set\(/)
    // apply y reverse: los candados del lote ANTES de clasificar, y se clasifica sólo lo bloqueado.
    for (const rel of [
      'services/superadmin/rateCorrection/rateCorrectionApply.ts',
      'services/superadmin/rateCorrection/rateCorrectionReverse.ts',
    ]) {
      const cuerpo = leer(rel)
      antes(cuerpo, 'await bloquearLoteConOriginales(tx, {', 'await cobrosDelProtocolo(tx, candados.bloqueados)')
      expect(cuerpo).not.toMatch(/bloquearPayments\(/)
    }
  })

  it('Codex R6-2 (c) · READ COMMITTED EXPLÍCITO en toda transacción del protocolo (vínculo, escritor débil, reapertura, consolidación) y en la unidad de costo', () => {
    const candado = leer('services/tpv/candadoDeIntento.ts')
    expect(candado).toMatch(/isolationLevel: Prisma\.TransactionIsolationLevel\.ReadCommitted/)
    const usos = {
      // Ventana de confirmación (plan 16-sep, Task 2): DOS — la publicación del vínculo y la decisión de la ventana
      // (`releaseUnprovenNegative`: candado de CADA intento vinculado → veto bancario → CAS → asiento, una sola fotografía).
      // Codex r2 (P1-A): y TRES con la transacción del NEGATIVO en `closeRow` (mismo orden de candados que la ventana).
      // Revisión final (17-sep, B): y CUATRO con la RE-RETENCIÓN de una solicitud liberada cuando el banco aprobó después
      // (`retenerSolicitudLiberadaPorAprobacion`: el mismo orden que la ventana). Ronda 2 (P1): la re-retención por un cobro
      // SIN LIGAR usa esa MISMA transacción (el núcleo `reRetenerSolicitudLiberada`), así que siguen siendo CUATRO.
      'services/terminal-payment.service.ts': 4,
      // Codex R14-1: el INGRESO del evento también es una transacción del protocolo (candado del intento → createdAt
      // monótono → INSERT), así que son TRES en el webhook: ingreso, publicación del vínculo y escritor por identidad débil.
      // Codex R15-1: y CUATRO con la recuperación de los ingresos sin candado desde S4 (`ordenarIngresosSinCandado`, transacción
      // propia: candado del intento → revalidación del claim → orden de recuperación).
      // Ventana de confirmación (Task 2, fix round 1 (e)): y CINCO con el TOQUE best-effort de la solicitud vinculada tras un
      // ingreso sin candado — transacción propia, con la misma espera acotada (`SET LOCAL lock_timeout`), DESPUÉS de persistir
      // el evento; no toma el candado del intento (el ingreso acaba de vencerlo) y un lock_timeout sólo salta el toque.
      // Codex r1 (P1-C): y SEIS con el INSERT del fallback bajo el candado de la SOLICITUD (transacción propia: candado de la
      // solicitud → insertar), antes del toque; si ese candado también vence, se inserta sin candado como antes (residuo declarado).
      'services/tpv/angelpay-webhook.service.ts': 6,
      'services/tpv/registroRepetido.ts': 1,
      // Plan 16-sep, Task 4: la declaración del cajero decide sobre un intento (candado del intento → Order → solicitud → CAS).
      'services/tpv/no-instrument-resolution.service.ts': 1,
    }
    for (const [rel, n] of Object.entries(usos)) {
      // Sin los `import` (prettier los parte en varias líneas cuando crecen, y `OPCIONES…,\n` dentro de uno no es un uso).
      const cuerpo = leer(rel).replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
      // Usos como OPCIÓN de `$transaction` (no el import): `OPCIONES…,` al cierre de un callback o `, OPCIONES…)` en una línea.
      const apariciones = (cuerpo.match(/OPCIONES_DE_TRANSACCION_DEL_INTENTO(,\n|\))/g) ?? []).length
      expect({ rel, apariciones }).toEqual({ rel, apariciones: n })
      // Ninguna transacción que toma el candado abre con `{ timeout: 10_000 }` a secas.
      const tramos = cuerpo.split('candadoDeIntento(tx')
      for (const tramo of tramos.slice(1)) expect(tramo.slice(0, 2500)).not.toMatch(/\{ timeout: 10_000 \}/)
    }
    expect(leer('services/payments/deferredTransactionCost.service.ts')).toMatch(
      /timeout: opciones\.presupuestoMs \?\? PRESUPUESTO_DE_CONVERGENCIA_MS, isolationLevel: Prisma\.TransactionIsolationLevel\.ReadCommitted/,
    )
  })

  it('Codex R7 (g) · la unidad de costo lee TODO por el MISMO cliente transaccional: en `createTransactionCost` no queda ninguna lectura por el cliente global — configuración, tarifas, proveedor y liquidación reciben `db`', () => {
    const s = leer('services/payments/transactionCost.service.ts')
    const desde = indice(s, 'export async function createTransactionCost(')
    const hasta = indice(s, 'export async function createRefundTransactionCost', desde)
    const cuerpo = s.slice(desde, hasta)
    expect(cuerpo).not.toMatch(/\bprisma\./)
    expect(cuerpo).toMatch(/getEffectivePaymentConfig\(payment\.venueId, db\)/)
    expect(cuerpo).toMatch(/findActiveProviderCostStructure\(merchantAccount\.id, payment\.createdAt, db\)/)
    expect(cuerpo).toMatch(/findActiveVenuePricingStructure\(payment\.venueId, accountType, payment\.createdAt, db\)/)
    expect(cuerpo).toMatch(/calculatePaymentSettlement\(payment, merchantAccount\.id, transactionType, db\)/)
    // Codex R8 (g): no basta con que EXISTA una llamada con `db` — TODAS las llamadas de la unidad (también el fallback a
    // PRIMARY) tienen que llevarlo; se cuentan y se revisa cada una.
    const llamadas: Record<string, number> = {}
    for (const fn of [
      'getEffectivePaymentConfig',
      'findActiveProviderCostStructure',
      'findActiveVenuePricingStructure',
      'calculatePaymentSettlement',
      'getEffectivePricing',
      'getEffectivePricingForSlot',
    ]) {
      const re = new RegExp(`\\b${fn}\\(([^()]*)\\)`, 'g')
      const args = [...cuerpo.matchAll(re)].map(m => m[1].trim())
      llamadas[fn] = args.length
      for (const a of args) expect({ fn, args: a, conDb: /(^|,\s*)db$/.test(a) }).toEqual({ fn, args: a, conDb: true })
    }
    expect(llamadas).toEqual({
      getEffectivePaymentConfig: 1,
      findActiveProviderCostStructure: 1,
      findActiveVenuePricingStructure: 2,
      calculatePaymentSettlement: 1,
      getEffectivePricing: 0,
      getEffectivePricingForSlot: 0,
    })
    // Los helpers que la unidad usa también leen por el cliente que reciben, nunca por el global.
    const proveedor = s.slice(
      indice(s, 'export async function findActiveProviderCostStructure'),
      indice(s, 'export async function findActiveVenuePricingStructure'),
    )
    expect(proveedor).toMatch(/db\.providerCostStructure\.findFirst/)
    expect(proveedor).not.toMatch(/\bprisma\./)
    const negocio = s.slice(
      indice(s, 'export async function findActiveVenuePricingStructure'),
      indice(s, '\nexport ', indice(s, 'export async function findActiveVenuePricingStructure') + 10),
    )
    // Codex R12-14: el helper resuelve UN slot con la consulta acotada, por el cliente que recibe.
    expect(negocio).toMatch(/getEffectivePricingForSlot\(venueId, accountType, effectiveDate, db\)/)
    expect(negocio).not.toMatch(/\bprisma\./)
    const config = leer('services/organization-payment-config.service.ts')
    for (const fn of ['getEffectivePaymentConfig', 'getEffectivePricing', 'getEffectivePricingForSlot']) {
      const ini = indice(config, `export async function ${fn}(`)
      const tramo = config.slice(ini, indice(config, '\nexport ', ini + 10))
      expect({ fn, db: /db: Cliente = prisma\)/.test(tramo) }).toEqual({ fn, db: true })
      expect({ fn, globales: (tramo.match(/\bprisma\./g) ?? []).length }).toEqual({ fn, globales: 0 })
    }
  })

  it('la llave del intento se normaliza IGUAL al persistir el evento y al bloquear (`llaveDeIntento`)', () => {
    const s = leer('services/tpv/angelpay-webhook.service.ts')
    // Codex R14-1: el receptor calcula la llave UNA vez (`llaveDelIntento`) y esa MISMA variable viaja al candado del ingreso
    // (`ingresarEventoDelIntento`) y a la fila (`attemptId`): no hay dos normalizaciones que puedan divergir.
    const desde = indice(s, 'export async function processAngelPayWebhook(')
    const ingresoDesde = indice(s, 'async function ingresarEventoDelIntento(', desde)
    const receptor = s.slice(desde, ingresoDesde)
    // (Codex R15-1: el insertador recibe también la marca del fallback — `(tx, marca) =>`.)
    antes(
      receptor,
      'const llaveDelIntento = llaveDeIntento(payload.payload.integratorReference)',
      'ingresarEventoDelIntento(llaveDelIntento, (tx, marca) =>',
    )
    antes(receptor, 'ingresarEventoDelIntento(llaveDelIntento, (tx, marca) =>', 'attemptId: llaveDelIntento,')
    expect(receptor).not.toMatch(/attemptId: llaveDeIntento\(/)
    // Y el ingreso toma el candado con ESA llave antes de insertar, dentro de la transacción READ COMMITTED del protocolo.
    const ingreso = s.slice(ingresoDesde, indice(s, 'function esEsperaDeCandadoVencida(', ingresoDesde))
    antes(ingreso, 'await candadoDeIntento(tx, llaveDelIntento)', 'const creado = await insertar(tx)')
    expect(ingreso).toMatch(/\/\* ingreso del intento \*\//)
    expect(s).toMatch(/llaveDelEvento = llaveDeIntento\(/)
  })
})
