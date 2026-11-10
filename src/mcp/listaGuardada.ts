/**
 * D19 (10-nov-2026): copia en memoria de la respuesta de `tools/list` del MCP, por conexión.
 *
 * Por qué: cada `tools/list` armaba un servidor nuevo, registraba las ~460 herramientas y convertía sus esquemas a JSON Schema.
 * En producción eso retuvo el hilo único del SERVIDOR 209–457 ms (5 de los 14 avisos con el MCP en vuelo, 7 al 10-nov), y en
 * ese rato no avanzaba ningún cobro de ningún negocio.
 *
 * Quién comparte copia: sólo quien llega con EXACTAMENTE lo mismo que recibe el registro de herramientas: el alcance entero
 * (persona, organización, rol, negocios, permisos de cada negocio, superadmin, scopes OAuth, app, solo demo), las banderas de
 * módulos y el perfil. El alcance se resuelve en CADA petición antes de buscar la copia, así que un permiso quitado cambia la
 * llave al instante. Si el alcance trae algo que no se puede escribir de forma estable, no hay llave y se arma como siempre.
 *
 * Qué guarda: el JSON de la respuesta (un string), y devuelve una copia nueva cada vez. Nunca lo que contesta una herramienta.
 * Una sola instancia (regla `una-sola-instancia.md`), sin Redis: memoria basta y un despliegue empieza vacío.
 */
import { createHash } from 'crypto'

/**
 * 24 h: la llave ya cambia con cualquier permiso, negocio, módulo o app (se resuelve en cada petición), y lo de fuera de la
 * llave sólo cambia con un despliegue, que empieza vacío. Con las 129 listas reales del 7 al 10-nov: 5 min habrían
 * reutilizado el 38 %; 24 h, el 83 %. La vida sólo suelta la memoria de quien dejó de preguntar.
 */
export const VIDA_DE_LA_LISTA_MS = 24 * 60 * 60_000
/** Una lista de superadmin (todas las herramientas) pesa ~1–2 MB de JSON; las de un negocio, decenas de KB. */
export const TOPE_DE_BYTES_DE_LISTAS = 32 * 1024 * 1024

interface Entrada {
  json: string
  guardadoEn: number
  bytes: number
}

const listas = new Map<string, Entrada>()
let bytesGuardados = 0

/** Texto estable de un valor, o null si trae algo que no se puede escribir igual siempre (función, símbolo, clase rara, ciclo). */
function estable(valor: unknown, enCamino: Set<object>): string | null {
  if (valor === null) return 'null'
  if (valor === undefined) return 'undefined'
  switch (typeof valor) {
    case 'string':
      return JSON.stringify(valor)
    case 'boolean':
      return String(valor)
    case 'number':
      return Number.isFinite(valor) ? JSON.stringify(valor) : `n:${String(valor)}`
    case 'object':
      break
    default:
      return null
  }
  const objeto = valor as object
  if (enCamino.has(objeto)) return null
  enCamino.add(objeto)
  try {
    if (objeto instanceof Date) return `D:${objeto.getTime()}`
    if (Array.isArray(objeto)) {
      const partes = objeto.map(v => estable(v, enCamino))
      return partes.includes(null) ? null : `[${partes.join(',')}]`
    }
    if (objeto instanceof Map || objeto instanceof Set) {
      const pares = objeto instanceof Map ? [...objeto.entries()] : [...objeto.values()].map(v => [v, true] as const)
      const partes = pares.map(([k, v]) => {
        const a = estable(k, enCamino)
        const b = estable(v, enCamino)
        return a === null || b === null ? null : `${a}=>${b}`
      })
      if (partes.includes(null)) return null
      return `${objeto instanceof Map ? 'M' : 'S'}{${(partes as string[]).sort().join(',')}}`
    }
    const proto = Object.getPrototypeOf(objeto)
    if (proto !== Object.prototype && proto !== null) return null
    const partes = Object.keys(objeto)
      .sort()
      .map(k => {
        const v = estable((objeto as Record<string, unknown>)[k], enCamino)
        return v === null ? null : `${JSON.stringify(k)}:${v}`
      })
    return partes.includes(null) ? null : `{${partes.join(',')}}`
  } finally {
    enCamino.delete(objeto)
  }
}

/** La llave de una conexión: sha256 de TODO lo que recibe el registro de herramientas. null = no se guarda. */
export function llaveDeListaMcp(entrada: { perfil: string; banderas: object; alcance: object }): string | null {
  const texto = estable(entrada, new Set())
  return texto === null ? null : createHash('sha256').update(`v1|${texto}`).digest('hex')
}

function soltar(llave: string): void {
  const e = listas.get(llave)
  if (!e) return
  bytesGuardados -= e.bytes
  listas.delete(llave)
}

/** Una copia nueva de la lista guardada, o undefined si no hay una vigente. */
export function listaMcpGuardada(llave: string, ahora = Date.now()): Record<string, unknown> | undefined {
  const e = listas.get(llave)
  if (!e) return undefined
  if (ahora - e.guardadoEn >= VIDA_DE_LA_LISTA_MS) {
    soltar(llave)
    return undefined
  }
  return JSON.parse(e.json)
}

/** Guarda la respuesta de un `tools/list`; cualquier otra cosa (un error, otra forma) se ignora. */
export function guardarListaMcp(llave: string, resultado: unknown, ahora = Date.now()): void {
  if (!Array.isArray((resultado as { tools?: unknown } | null)?.tools)) return
  soltar(llave)
  for (const [k, e] of listas) if (ahora - e.guardadoEn >= VIDA_DE_LA_LISTA_MS) soltar(k)
  const json = JSON.stringify(resultado)
  const bytes = json.length * 2
  if (bytes > TOPE_DE_BYTES_DE_LISTAS) return
  listas.set(llave, { json, guardadoEn: ahora, bytes })
  bytesGuardados += bytes
  // El Map recuerda el orden de inserción: la primera es la que se guardó hace más tiempo.
  for (const masVieja of listas.keys()) {
    if (bytesGuardados <= TOPE_DE_BYTES_DE_LISTAS) break
    soltar(masVieja)
  }
}

export function vaciarListasMcp(): void {
  listas.clear()
  bytesGuardados = 0
}
