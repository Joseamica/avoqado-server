/**
 * EXPERIMENTO OTel — la «TPV» de script. Entra como la terminal real:
 *  - login por PIN en `POST /api/v1/tpv/venues/:venueId/auth` (el token sale firmado por el server con el serial);
 *  - socket.io-client con `auth.token`, `auth.terminalId` = ese serial y `terminalPaymentAckVersion=1` (plan, corrección 2).
 *    No anuncia `terminalPaymentCancelDispositionVersion` ni `terminalPaymentProbeVersion`: el humo no cancela ni sondea.
 *
 * Al recibir `terminal:payment_request` hace lo que hace la APK de Nexgo/AngelPay (OrderPaymentRecorder +
 * SocketManager.kt): ④ ACK `{accepted:true, requestId}` → ⑤ `terminal:payment_attempt_opened {requestId, attemptId}`
 * → BANCO SIMULADO (declara la aprobación; no hay SDK ni procesador) → ⑥ `POST /api/v1/tpv/venues/:venueId/orders/:orderId`
 * con `terminalPaymentRequestId` e `idempotencyKey = attemptId` → `terminal:payment_result {status:'success', paymentId}`.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { io, Socket } from 'socket.io-client'
import type { Fixture } from './pos'

export interface LineaDeTiempoTpv {
  requestId: string
  /** marcas monotónicas (performance.now) */
  recibido?: number
  ackEnviado?: number
  intentoAbiertoIni?: number
  intentoAbiertoFin?: number
  ackIntento?: any
  registroIni?: number
  registroFin?: number
  registroStatus?: number
  registroCorrelationId?: string | null
  paymentId?: string
  attemptId?: string
  resultadoIni?: number
  resultadoFin?: number
  ackResultado?: any
  error?: string
  payload?: any
}

export class TpvDeScript {
  socket: Socket | null = null
  token = ''
  readonly lineas = new Map<string, LineaDeTiempoTpv>()
  private esperas = new Map<string, (l: LineaDeTiempoTpv) => void>()
  eventosInesperados: Array<{ evento: string; at: string }> = []

  constructor(
    private readonly base: string,
    private readonly f: Fixture,
    readonly serial: string,
    private readonly encabezadosExtra: () => Record<string, string> = () => ({}),
  ) {}

  async login(): Promise<void> {
    const r = await fetch(`${this.base}/api/v1/tpv/venues/${this.f.venueId}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: this.f.pin, serialNumber: this.serial }),
    })
    const cuerpo: any = await r.json().catch(() => null)
    const token = cuerpo?.accessToken ?? cuerpo?.data?.accessToken
    if (r.status >= 300 || !token) throw new Error(`login TPV ${this.serial} falló: HTTP ${r.status} ${JSON.stringify(cuerpo)?.slice(0, 400)}`)
    this.token = token
  }

  async conectar(): Promise<void> {
    const s = io(this.base, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: this.token, terminalId: this.serial, terminalPaymentAckVersion: '1' },
    })
    this.socket = s
    s.on('terminal:payment_request', (payload: any, ack?: (r: unknown) => void) => {
      void this.alRecibirCobro(payload, ack)
    })
    s.onAny((evento: string) => {
      if (evento !== 'terminal:payment_request') this.eventosInesperados.push({ evento, at: new Date().toISOString() })
    })
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`socket ${this.serial}: sin conexión en 15 s`)), 15_000)
      s.once('connect', () => {
        clearTimeout(t)
        resolve()
      })
      s.once('connect_error', e => {
        clearTimeout(t)
        reject(new Error(`socket ${this.serial}: ${e.message}`))
      })
    })
  }

  /** Espera a que la TPV termine de procesar ESA solicitud (con o sin error). */
  esperarLinea(requestId: string, timeoutMs: number): Promise<LineaDeTiempoTpv> {
    const ya = this.lineas.get(requestId)
    if (ya && (ya.resultadoFin !== undefined || ya.error)) return Promise.resolve(ya)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`TPV ${this.serial}: la solicitud ${requestId} no terminó en ${timeoutMs} ms`)), timeoutMs)
      this.esperas.set(requestId, l => {
        clearTimeout(t)
        resolve(l)
      })
    })
  }

  private terminar(l: LineaDeTiempoTpv) {
    const cb = this.esperas.get(l.requestId)
    this.esperas.delete(l.requestId)
    cb?.(l)
  }

  private async alRecibirCobro(payload: any, ack?: (r: unknown) => void) {
    const requestId: string = payload?.requestId
    const l: LineaDeTiempoTpv = { requestId, recibido: performance.now(), payload }
    this.lineas.set(requestId, l)
    try {
      // ④ ACK durable (la APK lo manda tras guardar la solicitud en su bandeja).
      ack?.({ accepted: true, requestId })
      l.ackEnviado = performance.now()

      // ⑤ el intento se anuncia ANTES de tocar el lector.
      const attemptId = randomUUID()
      l.attemptId = attemptId
      l.intentoAbiertoIni = performance.now()
      l.ackIntento = await this.socket!.timeout(15_000).emitWithAck('terminal:payment_attempt_opened', { requestId, attemptId })
      l.intentoAbiertoFin = performance.now()
      if (!l.ackIntento?.success || l.ackIntento?.executionAuthorized !== true) {
        throw new Error(`attempt_opened no autorizó ejecutar: ${JSON.stringify(l.ackIntento)}`)
      }

      // BANCO SIMULADO: la TPV de script declara la aprobación (no hay SDK ni procesador).
      const autorizacion = String(randomInt(100000, 999999))
      const referencia = String(randomInt(100000000, 999999999)) + String(randomInt(100, 999))

      // ⑥ registrar el cobro (como OrderPaymentRecorder.buildAngelPayOrderPaymentRequest).
      l.registroIni = performance.now()
      const r = await fetch(`${this.base}/api/v1/tpv/venues/${this.f.venueId}/orders/${payload.orderId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...this.encabezadosExtra() },
        body: JSON.stringify({
          venueId: this.f.venueId,
          amount: payload.amountCents,
          tip: payload.tipCents ?? 0,
          status: 'COMPLETED',
          method: 'CREDIT_CARD',
          source: 'AVOQADO_TPV',
          splitType: 'FULLPAYMENT',
          staffId: this.f.staffId,
          authorizationNumber: autorizacion,
          referenceNumber: referencia,
          maskedPan: '************4242',
          cardBrand: 'VISA',
          entryMode: 'CONTACTLESS',
          currency: 'MXN',
          isInternational: false,
          merchantAccountId: this.f.merchantAccountId,
          deviceSerialNumber: this.serial,
          idempotencyKey: attemptId,
          terminalPaymentRequestId: requestId,
        }),
      })
      const txt = await r.text()
      l.registroFin = performance.now()
      l.registroStatus = r.status
      l.registroCorrelationId = r.headers.get('x-correlation-id')
      let cuerpo: any = null
      try {
        cuerpo = JSON.parse(txt)
      } catch {
        /* no JSON */
      }
      if (r.status !== 201 || !cuerpo?.data?.id) throw new Error(`registro del cobro: HTTP ${r.status} ${txt.slice(0, 600)}`)
      l.paymentId = cuerpo.data.id

      // y el resultado por socket (la APK lo emite tras persistirlo en su bandeja).
      l.resultadoIni = performance.now()
      l.ackResultado = await this.socket!.timeout(15_000).emitWithAck('terminal:payment_result', {
        requestId,
        status: 'success',
        paymentId: l.paymentId,
        transactionId: referencia,
        errorMessage: null,
        cardDetails: { maskedPan: '************4242', cardBrand: 'VISA', entryMode: 'CONTACTLESS', authorizationNumber: autorizacion },
        completedAt: new Date().toISOString(),
      })
      l.resultadoFin = performance.now()
    } catch (e: any) {
      l.error = e?.message ?? String(e)
    } finally {
      this.terminar(l)
    }
  }

  cerrar() {
    this.socket?.close()
  }
}
