/**
 * EXPERIMENTO OTel — el «POS» de script: habla HTTP con el server como la app Android (`/api/v1/mobile/...`).
 *
 * Autenticación (decisión del coordinador, fase 2): como el POS real — login con correo/contraseña en
 * `POST /api/v1/mobile/auth/login` (con `X-Device-Id`), que devuelve un access de 10 min CON sesión (`sid`), y
 * `POST /api/v1/mobile/auth/refresh` antes de que venza. Si `POS_TOKEN=firmado`, usa un JWT legacy firmado con el
 * secreto desechable (lo que hizo el humo de la fase 1); el modo se anota en cada resultado.
 *
 * Llave del cliente (plan, corrección 5):
 *  - `ninguna` (brazo A = el POS de HOY: Android no tiene emisor de `x-correlation-id`);
 *  - `correlationId` (A+): un id por cobro en `x-correlation-id` en ①②③; uno nuevo por cada lectura;
 *  - `traceparent` (familia B): un trace-id por cobro, un span-id nuevo por petición; uno nuevo por cada lectura.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { CLAVE_POS } from '../lib/constantes'

export type ModoCliente = 'ninguna' | 'correlationId' | 'traceparent'

export interface Fixture {
  orgId: string
  venueId: string
  venue2Id?: string
  staffId: string
  email?: string
  rolStaff: string
  pin: string
  productId: string
  precioProducto: number
  tableId: string
  mesas?: string[]
  merchantAccountId: string
  terminales: Array<{ id: string; serial: string }>
}

export interface RespuestaHttp {
  status: number
  cuerpo: any
  /** id que el server devolvió en `X-Correlation-ID` (lo que hoy liga las líneas de UNA petición). */
  correlationId: string | null
  ms: number
  /** epoch ms al iniciar (para cruzar con las muestras del server) */
  inicio: number
}

/** La llave de UN cobro o de UNA lectura: genera los encabezados de cada petición. */
export class LlaveDeCliente {
  readonly correlationId = randomUUID()
  readonly traceId = randomBytes(16).toString('hex')
  constructor(readonly modo: ModoCliente) {}
  encabezados(): Record<string, string> {
    if (this.modo === 'correlationId') return { 'x-correlation-id': this.correlationId }
    if (this.modo === 'traceparent') return { traceparent: `00-${this.traceId}-${randomBytes(8).toString('hex')}-01` }
    return {}
  }
  /** Lo que el calificador usará como llave de partida (en A se completa con el X-Correlation-ID de la 1.ª respuesta). */
  valor(): string | null {
    return this.modo === 'correlationId' ? this.correlationId : this.modo === 'traceparent' ? this.traceId : null
  }
}

export function tokenFirmadoDelPos(f: Fixture, secreto: string): string {
  return jwt.sign(
    { sub: f.staffId, orgId: f.orgId, venueId: f.venueId, role: f.rolStaff, jti: randomUUID(), emitidoMs: Date.now(), origen: 'POS' },
    secreto,
    { algorithm: 'HS256', expiresIn: 600 },
  )
}

export class PosDeScript {
  readonly deviceId = `exp-otel-pos-${randomUUID().slice(0, 8)}`
  modoToken: 'sesion' | 'firmado' = process.env.POS_TOKEN === 'firmado' ? 'firmado' : 'sesion'
  private access = ''
  private refresh = ''
  private emitido = 0
  private renovando: Promise<void> | null = null

  constructor(
    private readonly base: string,
    private readonly f: Fixture,
    private readonly secreto: string,
  ) {}

  private async postSinToken(ruta: string, cuerpo: unknown): Promise<any> {
    const r = await fetch(`${this.base}${ruta}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': this.deviceId },
      body: JSON.stringify(cuerpo),
    })
    const j: any = await r.json().catch(() => null)
    if (r.status >= 300 || !j?.accessToken) throw new Error(`${ruta}: HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 300)}`)
    return j
  }

  async entrar(): Promise<void> {
    if (this.modoToken === 'firmado') {
      this.access = tokenFirmadoDelPos(this.f, this.secreto)
      this.emitido = Date.now()
      return
    }
    const j = await this.postSinToken('/api/v1/mobile/auth/login', { email: this.f.email, password: CLAVE_POS })
    this.access = j.accessToken
    this.refresh = j.refreshToken
    this.emitido = Date.now()
    // Si el login eligió la otra sucursal, se cambia con el refresh (como el selector de sucursal del POS).
    if (j.selectedVenueId && j.selectedVenueId !== this.f.venueId) await this.renovar()
  }

  private async renovar(): Promise<void> {
    if (this.modoToken === 'firmado') {
      this.access = tokenFirmadoDelPos(this.f, this.secreto)
      this.emitido = Date.now()
      return
    }
    const j = await this.postSinToken('/api/v1/mobile/auth/refresh', { refreshToken: this.refresh, venueId: this.f.venueId })
    this.access = j.accessToken
    this.refresh = j.refreshToken ?? this.refresh
    this.emitido = Date.now()
  }

  private async bearer(): Promise<string> {
    if (Date.now() - this.emitido > 8 * 60_000) {
      if (!this.renovando) this.renovando = this.renovar().finally(() => (this.renovando = null))
      await this.renovando
    }
    return this.access
  }

  async pedir(metodo: string, ruta: string, llave: LlaveDeCliente, cuerpo?: unknown, timeoutMs = 330_000): Promise<RespuestaHttp> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const inicio = Date.now()
    const t0 = performance.now()
    try {
      const r = await fetch(`${this.base}${ruta}`, {
        method: metodo,
        headers: {
          authorization: `Bearer ${await this.bearer()}`,
          'content-type': 'application/json',
          'x-device-id': this.deviceId,
          'x-device-name': 'POS de script (exp-otel)',
          ...llave.encabezados(),
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        signal: ctl.signal,
      })
      const txt = await r.text()
      let json: any = txt
      try {
        json = JSON.parse(txt)
      } catch {
        /* cuerpo no JSON */
      }
      return { status: r.status, cuerpo: json, correlationId: r.headers.get('x-correlation-id'), ms: performance.now() - t0, inicio }
    } catch (e: any) {
      return { status: 0, cuerpo: String(e?.cause?.code ?? e?.message ?? e), correlationId: null, ms: performance.now() - t0, inicio }
    } finally {
      clearTimeout(t)
    }
  }

  /** Lectura AUTENTICADA barata: la prueba de «listo» (no cualquier 200; plan, corrección 10). */
  listo() {
    return this.pedir('GET', `/api/v1/mobile/venues/${this.f.venueId}/tender-types`, new LlaveDeCliente('ninguna'), undefined, 5_000)
  }

  /** ① crear la orden de mesa CON un artículo (vacía se rechaza). */
  crearOrden(llave: LlaveDeCliente, tableId = this.f.tableId) {
    return this.pedir('POST', `/api/v1/mobile/venues/${this.f.venueId}/orders`, llave, {
      items: [{ productId: this.f.productId, quantity: 1 }],
      staffId: this.f.staffId,
      orderType: 'DINE_IN',
      source: 'AVOQADO_ANDROID',
      tableId,
    })
  }

  /** ② agregar una ronda (exige TABLE_SERVICE y `version`). */
  agregarRonda(llave: LlaveDeCliente, orderId: string, version: number) {
    return this.pedir('POST', `/api/v1/mobile/venues/${this.f.venueId}/orders/${orderId}/items`, llave, {
      items: [{ productId: this.f.productId, quantity: 1 }],
      version,
    })
  }

  /** ③ pedir el cobro a la terminal: long-poll hasta que la terminal (o quien decida) contesta. */
  cobrarEnTerminal(llave: LlaveDeCliente, p: { orderId: string; amountCents: number; terminalSerial: string; requestId: string }) {
    return this.pedir('POST', `/api/v1/mobile/venues/${this.f.venueId}/terminal-payment`, llave, {
      terminalId: p.terminalSerial,
      amountCents: p.amountCents,
      tipCents: 0,
      orderId: p.orderId,
      requestId: p.requestId,
      skipReview: true,
      processedByStaffId: this.f.staffId,
    })
  }

  /** Lecturas comunes del POS (mezcla fija de la carga). */
  leerOrdenes(llave: LlaveDeCliente, venueId = this.f.venueId) {
    return this.pedir('GET', `/api/v1/mobile/venues/${venueId}/orders?page=1&pageSize=20`, llave)
  }
  leerOrden(llave: LlaveDeCliente, orderId: string) {
    return this.pedir('GET', `/api/v1/mobile/venues/${this.f.venueId}/orders/${orderId}`, llave)
  }
  leerTiposDePago(llave: LlaveDeCliente, venueId = this.f.venueId) {
    return this.pedir('GET', `/api/v1/mobile/venues/${venueId}/tender-types`, llave)
  }
}
