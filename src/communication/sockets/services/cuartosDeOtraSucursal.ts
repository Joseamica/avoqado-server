import logger from '../../../config/logger'
import { staffHasPermissionInVenue } from '../../../middlewares/checkPermission.middleware'
import { onWithContext } from '../../../observability/socketContext'
import type { AuthenticatedSocket } from '../types'
import type { RoomManagerService } from './roomManager.service'

/**
 * D662 v5 (encargo 64fabe; absorbe la tarjeta 62937a87): el panel se entera AL INSTANTE de lo que pasa en la tienda en línea de la
 * sucursal que mira, aunque su sesión sea de otra.
 *
 * El DASHBOARD manda `joinVenueRoom` / `leaveVenueRoom` con `{ venueId }` desde siempre, pero ningún SERVIDOR lo escuchaba: el socket
 * sólo oía la sucursal de su token, y la Bandeja o Configuración de otra sucursal se enteraban hasta el siguiente sondeo.
 *
 * 🔴 Seguridad (Codex p2v5-r1 #4–#7):
 * - NO entra al cuarto general de la otra sucursal (facturas, logs y comandos de terminal viajan por ahí). Entra a un CANAL propio que
 *   sólo recibe `online_ordering_store_changed` con `{ venueId, timestamp }`: «algo cambió en la tienda, vuelve a leer». Lo que se lee
 *   después pasa por HTTP con sus permisos de siempre; el aviso no trae datos.
 * - Entra SÓLO si la persona tiene en ESA sucursal `orders:read` (Bandeja) u `online-orders:manage` (Configuración), con la misma regla
 *   de `checkPermission` (`staffHasPermissionInVenue`: superadmin activo, o su rol en la sucursal con su lista propia o los permisos del
 *   negocio, incluidos los quitados). Nunca por el `venueId` del token ni por lo que diga el cliente.
 * - Una TERMINAL (token con serial) y una sesión de SUPLANTACIÓN no entran (fallan cerrado: siguen con el sondeo).
 * - Se revalida cada `REVALIDACION_MS`: sin el permiso, o si la base no contesta, sale (falla cerrado). Lo más que recibe alguien a quien
 *   se lo acaban de quitar es «algo cambió» de esa tienda durante ese minuto, sin datos.
 * - Un `leave` que llega mientras se verificaba su `join` gana (cada pedido lleva su turno; sólo el último cuenta), y un socket que se
 *   desconectó mientras tanto no queda suscrito.
 */
export type VerificadorDePermiso = typeof staffHasPermissionInVenue

export const EVENTO_ENTRAR = 'joinVenueRoom'
export const EVENTO_SALIR = 'leaveVenueRoom'
export const PERMISOS_DEL_CANAL = ['orders:read', 'online-orders:manage'] as const
export const REVALIDACION_MS = 60_000
/** Un id de sucursal tiene forma de cuid; cualquier otra cosa no se consulta. */
const ID_VALIDO = /^[a-z0-9]{20,40}$/i

export class CuartosDeOtraSucursal {
  /** Por socket y sucursal, el turno del último pedido (entrar o salir): sólo ése se aplica. */
  private turnos = new Map<string, number>()
  private revalidaciones = new Map<string, ReturnType<typeof setInterval>>()

  constructor(
    private readonly roomManager: RoomManagerService,
    private readonly tienePermiso: VerificadorDePermiso = staffHasPermissionInVenue,
    private readonly intervaloMs: number = REVALIDACION_MS,
  ) {}

  registrar(socket: AuthenticatedSocket): void {
    onWithContext(socket, EVENTO_ENTRAR, (payload: unknown, callback?: (r: unknown) => void) => {
      void this.entrar(socket, payload, callback)
    })
    onWithContext(socket, EVENTO_SALIR, (payload: unknown, callback?: (r: unknown) => void) => {
      this.salir(socket, payload, callback)
    })
    onWithContext(socket, 'disconnect', () => this.olvidar(socket.id))
  }

  private clave(socketId: string, venueId: string): string {
    return `${socketId}:${venueId}`
  }

  private turno(socketId: string, venueId: string): number {
    const n = (this.turnos.get(this.clave(socketId, venueId)) ?? 0) + 1
    this.turnos.set(this.clave(socketId, venueId), n)
    return n
  }

  /** ¿Tiene en [venueId] alguno de los permisos del canal? Lanza si la base falla (quien llama falla cerrado). */
  private async puede(staffId: string, venueId: string): Promise<boolean> {
    for (const permission of PERMISOS_DEL_CANAL) {
      if (await this.tienePermiso({ staffId, venueId, permission })) return true
    }
    return false
  }

  async entrar(socket: AuthenticatedSocket, payload: unknown, callback?: (r: unknown) => void): Promise<boolean> {
    const responder = (ok: boolean, motivo?: string) => {
      if (callback) callback({ success: ok, ...(motivo ? { error: motivo } : {}) })
      return ok
    }
    const ctx = socket.authContext
    const venueId = (payload as { venueId?: unknown } | null)?.venueId
    if (!ctx?.userId || typeof venueId !== 'string' || !ID_VALIDO.test(venueId)) return responder(false, 'Sucursal inválida')
    // La del token: ya oye todo por su cuarto desde que se conectó (como hoy).
    if (venueId === ctx.venueId) return responder(true)
    if (ctx.terminalSerialNumber || ctx.isImpersonating) {
      logger.warn('[Socket] pidió los avisos de otra sucursal desde una terminal o una suplantación (negado)', {
        socketId: socket.id,
        venueId,
      })
      return responder(false, 'Sin acceso a esta sucursal')
    }
    const n = this.turno(socket.id, venueId)
    let puede = false
    try {
      puede = await this.puede(ctx.userId, venueId)
    } catch (error) {
      logger.warn('[Socket] no se pudo verificar el acceso a otra sucursal (no entra)', {
        socketId: socket.id,
        venueId,
        error: error instanceof Error ? error.message : String(error),
      })
      return responder(false, 'No se pudo verificar el acceso')
    }
    if (!puede) {
      logger.warn('[Socket] pidió los avisos de una sucursal sin permiso (negado)', { socketId: socket.id, userId: ctx.userId, venueId })
      return responder(false, 'Sin acceso a esta sucursal')
    }
    // Un `leave` posterior, o la desconexión, ganan: no se entra con un permiso que ya nadie pidió.
    if (this.turnos.get(this.clave(socket.id, venueId)) !== n || !socket.connected) return responder(false, 'Cancelado')
    if (!this.roomManager.joinOnlineStoreChannel(socket, venueId)) return responder(false, 'Cancelado')
    this.programarRevalidacion(socket)
    return responder(true)
  }

  salir(socket: AuthenticatedSocket, payload: unknown, callback?: (r: unknown) => void): void {
    const venueId = (payload as { venueId?: unknown } | null)?.venueId
    if (typeof venueId === 'string' && venueId !== socket.authContext?.venueId) {
      this.turno(socket.id, venueId)
      this.roomManager.leaveOnlineStoreChannel(socket, venueId)
    }
    if (callback) callback({ success: true })
  }

  /** Vuelve a verificar el permiso en cada canal; sin él (o si la base falla) sale. */
  async revalidar(socket: AuthenticatedSocket): Promise<void> {
    const ctx = socket.authContext
    for (const venueId of this.roomManager.getOnlineStoreChannels(socket.id)) {
      const n = this.turnos.get(this.clave(socket.id, venueId))
      let sigue = false
      try {
        sigue = !!ctx?.userId && (await this.puede(ctx.userId, venueId))
      } catch {
        sigue = false
      }
      // Si mientras tanto llegó otro pedido para esa sucursal, ése decide.
      if (!sigue && this.turnos.get(this.clave(socket.id, venueId)) === n) {
        this.roomManager.leaveOnlineStoreChannel(socket, venueId)
        logger.info('[Socket] salió de los avisos de otra sucursal: ya no tiene el permiso', { socketId: socket.id, venueId })
      }
    }
    if (this.roomManager.getOnlineStoreChannels(socket.id).length === 0) this.pararRevalidacion(socket.id)
  }

  private programarRevalidacion(socket: AuthenticatedSocket): void {
    if (this.revalidaciones.has(socket.id)) return
    const t = setInterval(() => void this.revalidar(socket), this.intervaloMs)
    t.unref?.()
    this.revalidaciones.set(socket.id, t)
  }

  private pararRevalidacion(socketId: string): void {
    const t = this.revalidaciones.get(socketId)
    if (t) clearInterval(t)
    this.revalidaciones.delete(socketId)
  }

  private olvidar(socketId: string): void {
    this.pararRevalidacion(socketId)
    for (const clave of Array.from(this.turnos.keys())) if (clave.startsWith(`${socketId}:`)) this.turnos.delete(clave)
  }
}

/**
 * El aviso que reciben los suscritos desde otra sucursal: sólo el negocio y la hora. Lo arma el SERVIDOR, nunca copia la carga del cuarto
 * general (Codex p2v5-r1 #4).
 */
export function avisoDeTiendaSinDatos(venueId: string, now: Date = new Date()): { venueId: string; timestamp: string } {
  return { venueId, timestamp: now.toISOString() }
}
