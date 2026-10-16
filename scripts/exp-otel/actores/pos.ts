/**
 * EXPERIMENTO OTel — el «POS» de script: habla HTTP con el server como la app Android (`/api/v1/mobile/...`), con un
 * JWT HS256 de staff firmado con el secreto DESECHABLE del experimento (plan, corrección 2).
 *
 * Brazo A = el cliente de HOY: NO manda `x-correlation-id` (Android no tiene emisor; plan, corrección 4). Los brazos
 * A+/B de la fase 2 agregarán aquí su llave (`x-correlation-id` / `traceparent`) con `encabezadosExtra`.
 */
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'

export interface Fixture {
  orgId: string
  venueId: string
  staffId: string
  rolStaff: string
  pin: string
  productId: string
  precioProducto: number
  tableId: string
  merchantAccountId: string
  terminales: Array<{ id: string; serial: string }>
}

export interface RespuestaHttp {
  status: number
  cuerpo: any
  /** id que el server devolvió en `X-Correlation-ID` (lo que hoy liga las líneas de UNA petición). */
  correlationId: string | null
  ms: number
}

export function tokenDelPos(f: Fixture, secreto: string): string {
  // Misma forma que `generateAccessToken(..., { pos: true })` sin `sid` (token legacy, aceptado en fase 1 del rollout):
  // sub/orgId/venueId/role/jti/emitidoMs/origen. 10 min, como el access del POS.
  return jwt.sign(
    { sub: f.staffId, orgId: f.orgId, venueId: f.venueId, role: f.rolStaff, jti: randomUUID(), emitidoMs: Date.now(), origen: 'POS' },
    secreto,
    { algorithm: 'HS256', expiresIn: 600 },
  )
}

export class PosDeScript {
  constructor(
    private readonly base: string,
    private readonly f: Fixture,
    private readonly secreto: string,
    private readonly encabezadosExtra: () => Record<string, string> = () => ({}),
  ) {}

  private token = ''
  private tokenEmitido = 0

  private bearer(): string {
    // Se renueva antes de vencer (el POS real refresca su access de 10 min).
    if (!this.token || Date.now() - this.tokenEmitido > 8 * 60_000) {
      this.token = tokenDelPos(this.f, this.secreto)
      this.tokenEmitido = Date.now()
    }
    return this.token
  }

  async pedir(metodo: string, ruta: string, cuerpo?: unknown, timeoutMs = 330_000): Promise<RespuestaHttp> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const t0 = performance.now()
    try {
      const r = await fetch(`${this.base}${ruta}`, {
        method: metodo,
        headers: {
          authorization: `Bearer ${this.bearer()}`,
          'content-type': 'application/json',
          'x-device-name': 'POS de script (exp-otel)',
          ...this.encabezadosExtra(),
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        signal: ctl.signal,
      })
      const txt = await r.text()
      let json: any = txt
      try {
        json = JSON.parse(txt)
      } catch {
        /* cuerpo no JSON: se conserva el texto */
      }
      return { status: r.status, cuerpo: json, correlationId: r.headers.get('x-correlation-id'), ms: performance.now() - t0 }
    } finally {
      clearTimeout(t)
    }
  }

  /** Lectura AUTENTICADA barata: la prueba de «listo» (no cualquier 200; plan, corrección 10). */
  listo() {
    return this.pedir('GET', `/api/v1/mobile/venues/${this.f.venueId}/tender-types`, undefined, 5_000)
  }

  /** ① crear la orden de mesa CON un artículo (vacía se rechaza). */
  crearOrden() {
    return this.pedir('POST', `/api/v1/mobile/venues/${this.f.venueId}/orders`, {
      items: [{ productId: this.f.productId, quantity: 1 }],
      staffId: this.f.staffId,
      orderType: 'DINE_IN',
      source: 'AVOQADO_ANDROID',
      tableId: this.f.tableId,
    })
  }

  /** ② agregar una ronda (exige TABLE_SERVICE y `version`). */
  agregarRonda(orderId: string, version: number) {
    return this.pedir('POST', `/api/v1/mobile/venues/${this.f.venueId}/orders/${orderId}/items`, {
      items: [{ productId: this.f.productId, quantity: 1 }],
      version,
    })
  }

  /** ③ pedir el cobro a la terminal: long-poll hasta que la terminal (o quien decida) contesta. */
  cobrarEnTerminal(p: { orderId: string; amountCents: number; terminalSerial: string; requestId: string }) {
    return this.pedir('POST', `/api/v1/mobile/venues/${this.f.venueId}/terminal-payment`, {
      terminalId: p.terminalSerial,
      amountCents: p.amountCents,
      tipCents: 0,
      orderId: p.orderId,
      requestId: p.requestId,
      skipReview: true,
      processedByStaffId: this.f.staffId,
    })
  }
}
