/**
 * D6 de Flautas (20-nov, opción B del founder: «como Square y Toast»): qué pantallas de cocina están CONECTADAS. Una
 * pantalla pide su tablero (`GET kds/orders?stationId=…`) cada 10 s mientras se ve (`KDSViewModel.mientrasSeVe`); aquí vive
 * la última vez que lo pidió cada estación. La caja lo pregunta para decir con una franja FIJA «La pantalla de cocina de X no
 * está conectada», en vez de avisar «No salió» orden por orden cuando la venta ya está en el servidor.
 *
 * ponytail: en memoria y por proceso. Sirve con UNA instancia del servidor (hoy, sin Redis). Con varias, cada una vería sólo
 * las lecturas que le tocaron: entonces una fila con fecha en `PrintStation`. Un reinicio la vacía: una pantalla viva sale
 * como no conectada hasta su siguiente lectura (≤ 10 s).
 */

/**
 * Conectada = pidió su tablero hace a lo más esto. Lee cada 10 s DESPUÉS de terminar su vuelta (tablero, canales y, cada
 * seis vueltas, la config): Codex r5 #3, una vuelta lenta puede pasar de 45 s con el tablero abierto. 90 s aguanta varias.
 */
export const PANTALLA_VIVA_MS = 90_000
/** Codex r5 #4: tras un arranque o despliegue el mapa está vacío; hasta que pase la ventana, «no se sabe» de las que faltan. */
const ARRANQUE = Date.now()
/** Lo que no se lee en este tiempo se olvida: la memoria no crece con estaciones viejas. */
const OLVIDO_MS = 10 * 60_000
/** Defensa: un negocio real tiene 1-5 estaciones; ids basura no hacen crecer la memoria sin tope. */
const MAX_ESTACIONES_POR_NEGOCIO = 100

const vistas = new Map<string, Map<string, number>>()

/** La pantalla de [stationId] acaba de leer su tablero. */
export function marcarPantallaViva(venueId: string, stationId: string, ahora: number = Date.now()): void {
  let delNegocio = vistas.get(venueId)
  if (!delNegocio) {
    delNegocio = new Map()
    vistas.set(venueId, delNegocio)
  }
  // Se borra y se vuelve a poner: el orden del Map queda de la más vieja a la más nueva, y el tope saca la más vieja.
  delNegocio.delete(stationId)
  delNegocio.set(stationId, ahora)
  if (delNegocio.size > MAX_ESTACIONES_POR_NEGOCIO) {
    const masVieja = delNegocio.keys().next().value
    if (masVieja !== undefined) delNegocio.delete(masVieja)
  }
}

export interface PantallasConectadas {
  /** Las estaciones de [venueId] cuya pantalla leyó su tablero hace ≤ [PANTALLA_VIVA_MS]. */
  conectadas: string[]
  /** `false` justo después de arrancar: una estación que no sale aquí NO se puede dar por desconectada todavía. */
  completo: boolean
}

export function pantallasConectadas(venueId: string, ahora: number = Date.now(), arranque: number = ARRANQUE): PantallasConectadas {
  const completo = ahora - arranque > PANTALLA_VIVA_MS
  const delNegocio = vistas.get(venueId)
  if (!delNegocio) return { conectadas: [], completo }
  const conectadas: string[] = []
  for (const [stationId, vista] of delNegocio) {
    if (ahora - vista > OLVIDO_MS) delNegocio.delete(stationId)
    else if (ahora - vista <= PANTALLA_VIVA_MS) conectadas.push(stationId)
  }
  if (delNegocio.size === 0) vistas.delete(venueId)
  return { conectadas, completo }
}

/** Sólo para las pruebas: empieza de cero. */
export function olvidarPantallas(): void {
  vistas.clear()
}
