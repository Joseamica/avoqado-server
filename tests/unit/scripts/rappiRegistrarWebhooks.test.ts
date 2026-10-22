/**
 * El script que registra los avisos de Rappi, de punta a punta contra un Rappi SIMULADO en memoria y un directorio temporal
 * real. Ni red ni `.env`: `rappi.client` y `rappi.token` se sustituyen aquí.
 *
 * Reproduce los tres bloqueantes que Codex encontró en el bloque 0 de «Rappi fase 2» (docs/audit/2026-10-20-rappi-fase-2/codex-b0.md):
 *  · #1 🔴 la respuesta de un CREAR se pierde ⇒ Rappi tiene el aviso y el archivo no tiene su secreto. La corrida siguiente
 *    decía «Sin fallos» con exit 0 y el servidor rechazaría esos avisos con 401 para siempre.
 *  · #2 🔴 repetir una corrida buena reescribía el archivo ANTES de tocar Rappi; con el disco lleno quedaba vacío.
 *  · #3 🔴 dos corridas a la vez con el mismo archivo podían terminar «bien» con claves distintas en Rappi y en disco.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import { rappiApi } from '../../../src/services/delivery-channels/providers/rappi/rappi.client'
import { RUTA_POR_EVENTO } from '../../../src/services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { main } from '../../../scripts/rappi-registrar-webhooks'

jest.mock('../../../src/services/delivery-channels/providers/rappi/rappi.client', () => ({
  rappiApi: jest.fn(),
  getRappiEnvironment: () => 'DEV',
  tiendasEscribiblesRappi: () => ['900175499'],
  apiBaseSelfOnboarding: () => 'https://self-onboarding.rappi.prueba',
}))
jest.mock('../../../src/services/delivery-channels/providers/rappi/rappi.token', () => ({
  // Un JWT con el `azp` (el clientId de la integración); la firma no se verifica.
  getRappiToken: async () => `cabecera.${Buffer.from(JSON.stringify({ azp: 'cliente-prueba' })).toString('base64url')}.firma`,
}))

const API = '/api/v2/restaurants-integrations-public-api'
const BASE = 'https://abc.ngrok.app'
const INTEGRACION = 'STORE_PROVISIONING_STATUS'
const EVENTOS_DE_TIENDA = Object.values(RUTA_POR_EVENTO).filter(e => e !== INTEGRACION)

// ── El Rappi simulado ─────────────────────────────────────────────────────────────────────

interface Peticion {
  metodo: string
  ruta: string
  cuerpo?: unknown
  storeIds?: readonly string[]
}

let rappi: {
  porTienda: Map<string, { url: string; tiendas: string[] }>
  secretoDe: Map<string, string>
  integracion?: { url: string; secreto: string }
  /** Clave de la petición ⇒ Rappi la APLICA pero la respuesta no llega (vence a los 10 s). */
  perder: Set<string>
  /** Clave ⇒ Rappi la rechaza con ese estado, sin aplicarla. */
  rechazar: Map<string, number>
  /** Eventos cuyo CREAR responde 200 sin el campo `secret`. */
  crearSinSecreto: Set<string>
  llamadas: string[]
  /** Se llama en cada petición, antes de contestar: para mirar el disco mientras el script corre. */
  espiar?: () => void
}
let n = 0
const secretoNuevo = () => `rappi-secreto-${++n}`

function nuevoRappi(): typeof rappi {
  return { porTienda: new Map(), secretoDe: new Map(), perder: new Set(), rechazar: new Map(), crearSinSecreto: new Set(), llamadas: [] }
}

const ok = (cuerpo: unknown, status = 200) => ({ ok: true, status, raw: cuerpo === undefined ? '' : JSON.stringify(cuerpo) })

async function rappiSimulado(p: Peticion) {
  rappi.espiar?.()
  const ruta = p.ruta.replace(API, '')
  let m: RegExpMatchArray | null

  if (p.metodo === 'GET' && (m = ruta.match(/^\/webhook\/([A-Z_]+)$/))) {
    rappi.llamadas.push(`GET webhook ${m[1]}`)
    if (rappi.rechazar.has(`GET webhook ${m[1]}`)) return { ok: false, status: rappi.rechazar.get(`GET webhook ${m[1]}`)!, raw: '' }
    const r = rappi.porTienda.get(m[1])
    return ok(r ? [{ event: m[1], stores: r.tiendas.map(t => ({ store_id: t, url: r.url, state: 'ENABLE' })) }] : [])
  }
  if (p.metodo === 'GET' && /^\/clients\/[^/]+\/webhooks$/.test(ruta)) {
    rappi.llamadas.push('GET clients webhooks')
    return ok(rappi.integracion ? [{ clientId: 'cliente-prueba', event: INTEGRACION, url: rappi.integracion.url, state: true }] : [])
  }

  // Escrituras
  let clave: string
  let aplicar: () => unknown
  if (p.metodo === 'POST' && ruta === '/webhook') {
    const { event, data } = p.cuerpo as { event: string; data: Array<{ url: string; stores: string[] }> }
    clave = `POST webhook ${event}`
    aplicar = () => {
      rappi.porTienda.set(event, { url: data[0].url, tiendas: [...data[0].stores] })
      rappi.secretoDe.set(event, secretoNuevo())
      const respuesta: Record<string, unknown> = {
        event,
        stores: data[0].stores.map(t => ({ url: data[0].url, store_id: t, state: 'ENABLE' })),
      }
      if (!rappi.crearSinSecreto.has(event)) respuesta.secret = rappi.secretoDe.get(event)
      return respuesta
    }
  } else if (p.metodo === 'PUT' && (m = ruta.match(/^\/webhook\/([A-Z_]+)\/(change-url|add-stores|reset-secret)$/))) {
    const [, event, que] = m
    clave = `PUT ${que} ${event}`
    aplicar = () => {
      const r = rappi.porTienda.get(event)
      if (!r) throw Object.assign(new Error('406'), { status: 406 })
      if (que === 'change-url') r.url = (p.cuerpo as { url: string }).url
      if (que === 'add-stores') r.tiendas.push(...(p.cuerpo as Array<{ stores: string[] }>)[0].stores)
      if (que === 'reset-secret') {
        rappi.secretoDe.set(event, secretoNuevo())
        return { event, secret: rappi.secretoDe.get(event) }
      }
      return { event }
    }
  } else if (p.metodo === 'POST' && /^\/clients\/[^/]+\/webhooks$/.test(ruta)) {
    const { url, secret } = p.cuerpo as { url: string; secret: string }
    clave = 'POST clients webhooks'
    aplicar = () => {
      rappi.integracion = { url, secreto: secret }
      return { clientId: 'cliente-prueba', event: INTEGRACION, url, state: true }
    }
  } else {
    throw new Error(`el Rappi simulado no conoce ${p.metodo} ${p.ruta}`)
  }

  rappi.llamadas.push(clave)
  if (rappi.rechazar.has(clave)) return { ok: false, status: rappi.rechazar.get(clave)!, raw: '' }
  let respuesta: unknown
  try {
    respuesta = aplicar()
  } catch (e) {
    return { ok: false, status: (e as { status?: number }).status ?? 500, raw: '' }
  }
  if (rappi.perder.has(clave)) throw new Error('The operation was aborted due to timeout')
  return ok(respuesta)
}

// ── El escenario ──────────────────────────────────────────────────────────────────────────

let dir: string
let salida: string
let pantalla: string[]
const candado = () => `${salida}.lock`
const args = () => ['--base', BASE, '--salida', salida]
const archivo = () => JSON.parse(fs.readFileSync(salida, 'utf8')) as Record<string, string>
const dijo = () => pantalla.join('\n')

/** Lo que Rappi usaría para firmar cada aviso: el archivo tiene que coincidir con esto. */
function secretosDeRappi(): Record<string, string> {
  return { ...Object.fromEntries(rappi.secretoDe), ...(rappi.integracion ? { [INTEGRACION]: rappi.integracion.secreto } : {}) }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rappi-registro-'))
  salida = path.join(dir, 'secretos-dev.json')
  rappi = nuevoRappi()
  pantalla = []
  ;(rappiApi as jest.Mock).mockReset().mockImplementation(rappiSimulado)
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void pantalla.push(a.join(' ')))
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void pantalla.push(a.join(' ')))
})

afterEach(() => {
  jest.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('rappi-registrar-webhooks', () => {
  // ── 2 · REGRESIÓN: lo que ya funcionaba ─────────────────────────────────────────────
  it('primera corrida limpia: crea los 11 avisos, el archivo queda igual a lo que Rappi usa para firmar, 600 y exit 0', async () => {
    expect(await main(args())).toBe(0)

    expect(archivo()).toEqual(secretosDeRappi())
    expect(Object.keys(archivo()).sort()).toEqual([...EVENTOS_DE_TIENDA, INTEGRACION].sort())
    expect(fs.statSync(salida).mode & 0o777).toBe(0o600)
    expect(dijo()).toContain('Sin fallos')
    expect(dijo()).not.toMatch(/rappi-secreto-/) // ningún secreto a la pantalla
  })

  it('la segunda corrida es todo NADA, sin una sola escritura a Rappi, y sale con 0', async () => {
    await main(args())
    rappi.llamadas = []

    expect(await main(args())).toBe(0)

    expect(rappi.llamadas.every(l => l.startsWith('GET'))).toBe(true)
    expect(archivo()).toEqual(secretosDeRappi())
  })

  it('un CREAR que Rappi rechaza no se rota (no existe allá) y la corrida sale con 1', async () => {
    rappi.rechazar.set('POST webhook PING', 500)

    expect(await main(args())).toBe(1)

    expect(rappi.llamadas).not.toContain('PUT reset-secret PING')
    expect(archivo().PING).toBeUndefined()
    expect(dijo()).not.toContain('Sin fallos')
  })

  // ── 1 · Hallazgo #1: respuesta perdida = aviso sin secreto ──────────────────────────
  it('🔴 #1 la respuesta del CREAR se pierde: la corrida siguiente ROTA ese secreto y sólo entonces termina bien', async () => {
    rappi.perder.add('POST webhook NEW_ORDER')
    expect(await main(args())).toBe(1)
    expect(rappi.porTienda.has('NEW_ORDER')).toBe(true) // Rappi sí lo creó…
    expect(archivo().NEW_ORDER).toBeUndefined() // …y el archivo no tiene su secreto

    rappi.perder.clear()
    rappi.llamadas = []
    expect(await main(args())).toBe(0)

    expect(rappi.llamadas).toContain('PUT reset-secret NEW_ORDER')
    expect(rappi.llamadas.filter(l => l.startsWith('PUT reset-secret'))).toEqual(['PUT reset-secret NEW_ORDER']) // sólo el que falta
    expect(archivo()).toEqual(secretosDeRappi())
    expect(dijo()).not.toMatch(/rappi-secreto-/)
  })

  it('🔴 #1 un CREAR que Rappi acepta pero responde sin `secret` se rota en la MISMA corrida', async () => {
    rappi.crearSinSecreto.add('PING')

    expect(await main(args())).toBe(0)

    expect(rappi.llamadas).toContain('PUT reset-secret PING')
    expect(archivo()).toEqual(secretosDeRappi())
  })

  it('🔴 #1 si la rotación falla: exit 1, NO dice «Sin fallos», y dice qué falta y qué hacer', async () => {
    await main(args())
    const sinNewOrder = archivo()
    delete sinNewOrder.NEW_ORDER
    fs.writeFileSync(salida, JSON.stringify(sinNewOrder))
    rappi.rechazar.set('PUT reset-secret NEW_ORDER', 500)
    pantalla = []

    expect(await main(args())).toBe(1)

    expect(dijo()).not.toContain('Sin fallos')
    const falta = pantalla.find(l => /falta/i.test(l) && l.includes('NEW_ORDER'))
    expect(falta).toBeDefined()
    expect(falta).toMatch(/vuelve a correr/i)
    expect(dijo()).not.toMatch(/no está automatizado/)
  })

  it('🔴 #1 una rotación cuya respuesta se pierde se repara rotando otra vez en la corrida siguiente', async () => {
    await main(args())
    const sinPing = archivo()
    delete sinPing.PING
    fs.writeFileSync(salida, JSON.stringify(sinPing))
    rappi.perder.add('PUT reset-secret PING')

    expect(await main(args())).toBe(1)

    rappi.perder.clear()
    expect(await main(args())).toBe(0)
    expect(archivo()).toEqual(secretosDeRappi())
  })

  // ── 1 · Hallazgo #2: el archivo bueno no se destruye ────────────────────────────────
  it('🔴 #2 una corrida sin cambios NO reescribe el archivo (byte por byte igual); sólo le cierra los permisos', async () => {
    await main(args())
    const compacto = JSON.stringify(archivo()) // otro formato que el del script, a propósito
    fs.writeFileSync(salida, compacto)
    fs.chmodSync(salida, 0o644)

    expect(await main(args())).toBe(0)

    expect(fs.readFileSync(salida, 'utf8')).toBe(compacto)
    expect(fs.statSync(salida).mode & 0o777).toBe(0o600)
  })

  it('🔴 #2 con el disco lleno, repetir una corrida buena deja el archivo INTACTO (antes quedaba vacío)', async () => {
    await main(args())
    const bueno = fs.readFileSync(salida, 'utf8')
    // El disco se llena: escribir sobre el archivo lo trunca y falla; reemplazarlo también falla.
    const escribirReal = fs.writeFileSync
    jest.spyOn(fs, 'writeFileSync').mockImplementation(((destino: fs.PathOrFileDescriptor, ...resto: unknown[]) => {
      if (typeof destino === 'string' && destino.startsWith(salida) && !destino.endsWith('.lock')) {
        escribirReal(destino, '')
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return (escribirReal as (...a: unknown[]) => void)(destino, ...resto)
    }) as typeof fs.writeFileSync)
    const renombrarReal = fs.renameSync
    jest.spyOn(fs, 'renameSync').mockImplementation((de, a) => {
      if (a === salida) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return renombrarReal(de, a)
    })

    await main(args()).catch(() => undefined)

    expect(fs.readFileSync(salida, 'utf8')).toBe(bueno)
    expect(fs.readdirSync(dir).sort()).toEqual(['secretos-dev.json'])
  })

  // ── 1 · Hallazgo #3: nunca dos corridas a la vez ────────────────────────────────────
  it('🔴 #3 con el candado tomado no lee ni escribe nada (ni el archivo ni Rappi) y dice qué hacer', async () => {
    await main(args())
    const bueno = fs.readFileSync(salida, 'utf8')
    fs.writeFileSync(candado(), 'pid=999 desde=2026-10-21T10:00:00.000Z\n')
    rappi.llamadas = []

    await expect(main(args())).rejects.toThrow(/otra corrida/i)
    await expect(main(args())).rejects.toThrow(candado())
    await expect(main(args())).rejects.toThrow(/bórralo a mano/i)

    expect(rappi.llamadas).toEqual([])
    expect(fs.readFileSync(salida, 'utf8')).toBe(bueno)
    expect(fs.readFileSync(candado(), 'utf8')).toBe('pid=999 desde=2026-10-21T10:00:00.000Z\n') // no se borra solo
  })

  it('🔴 #3 dos corridas a la vez sin secreto de la integración: una se niega y el archivo coincide con Rappi', async () => {
    const [a, b] = await Promise.allSettled([main(args()), main(args())])

    const resueltas = [a, b].filter(r => r.status === 'fulfilled')
    const negadas = [a, b].filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(resueltas).toEqual([{ status: 'fulfilled', value: 0 }])
    expect(negadas).toHaveLength(1)
    expect(String(negadas[0].reason)).toMatch(/otra corrida/i)
    expect(archivo()[INTEGRACION]).toBe(rappi.integracion?.secreto)
    expect(archivo()).toEqual(secretosDeRappi())
  })

  it('🔴 #3 el candado existe mientras corre (con el pid) y se suelta al terminar, también si algo falla', async () => {
    const vistos: string[] = []
    rappi.espiar = () => void vistos.push(fs.existsSync(candado()) ? fs.readFileSync(candado(), 'utf8') : 'SIN CANDADO')

    expect(await main(args())).toBe(0)
    expect(vistos.length).toBeGreaterThan(0)
    expect(vistos.every(v => v.includes(`pid=${process.pid}`))).toBe(true)
    expect(fs.existsSync(candado())).toBe(false)

    rappi.rechazar.set('GET webhook NEW_ORDER', 500) // falla la lectura: el script lanza
    await expect(main(args())).rejects.toThrow(/GET webhook\/NEW_ORDER/)
    expect(fs.existsSync(candado())).toBe(false)
  })
})
