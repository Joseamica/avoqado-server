/**
 * Registra en Rappi los avisos (webhooks) que recibe nuestro servidor, y deja sus secretos en un archivo.
 *
 *   npx tsx scripts/rappi-registrar-webhooks.ts --base https://<dominio o túnel público> --salida <ruta> [--produccion]
 *
 * Qué registra (el plan completo y su porqué viven en `rappi.webhooksRegistro.ts`):
 *   · los 10 avisos POR TIENDA, hacia `{base}/api/v1/webhooks/delivery/rappi/{evento}`, para las tiendas de
 *     `RAPPI_WRITABLE_STORE_IDS_<AMBIENTE>` (y sólo ésas);
 *   · el aviso de la INTEGRACIÓN (`STORE_PROVISIONING_STATUS`), con un secreto NUESTRO (se reutiliza el del archivo; sólo se
 *     inventa uno si no hay).
 * Es IDEMPOTENTE: lo que ya está bien se queda en NADA; una URL vieja (túnel nuevo) se cambia; una tienda que falta se agrega.
 *
 * 🔴 SECRETOS: sólo van al archivo `--salida` (modo 600), con la forma de `RAPPI_WEBHOOK_SECRETS`
 * (`{"NEW_ORDER":"…","PING":"…"}`). Si el archivo ya existe se CONSERVAN sus secretos y se suman los nuevos; se guarda tras
 * cada aviso creado, para que un fallo más adelante no pierda el que Rappi ya entregó. A la pantalla sólo van nombres de
 * eventos y la acción: nunca un secreto, un token ni el cuerpo de una respuesta de Rappi. El archivo va FUERA del repo.
 *  · Toda escritura es ATÓMICA (temporal 600 en la misma carpeta + rename, `_archivo-de-secretos.ts`): un disco lleno deja el
 *    archivo anterior intacto, nunca vacío. Y una corrida que no cambia nada no lo reescribe.
 *  · 🔴 Un aviso de tienda que Rappi YA tiene y el archivo no (la respuesta del CREAR se perdió, aquí o en otra corrida) se
 *    ROTA con `reset-secret` al terminar el plan: Rappi no vuelve a mostrar un secreto, sólo da uno nuevo. Mientras falte el
 *    secreto de algún aviso, el script sale con 1 y dice cuál falta.
 *  · 🔴 Una sola corrida a la vez por archivo: `<salida>.lock` se toma ANTES de leer nada y se suelta al terminar. Si ya existe,
 *    no se toca nada; un candado de una corrida que murió lo borra una persona, a mano.
 *
 * 🔴 EL SECRETO DE LA INTEGRACIÓN ES NUESTRO Y NO TIENE `reset-secret` (el de la doc es sólo de los avisos por tienda): si se
 * pierde, sólo se recupera volviendo a mandarlo. Por eso (1) se guarda en `<salida>.pendiente` (modo 600) ANTES del POST y sólo
 * pasa al archivo principal cuando Rappi lo confirma; (2) mientras no esté confirmado en el principal, cada corrida vuelve a
 * mandar el aviso con ESE secreto aunque Rappi ya muestre la misma URL (el POST «crea o actualiza»). Si fallara o venciera, basta
 * volver a correr el script. Nunca se da por bueno un secreto que Rappi no confirmó: el aviso viejo seguiría firmando con otro.
 *
 * Las escrituras pasan por el candado de tiendas de `rappi.http.ts` (lista vacía = no sale ninguna). Se niega a correr con
 * `RAPPI_ENVIRONMENT=PRODUCTION` sin `--produccion`. Contra Rappi se corre a mano (Tarea 7 del plan de Rappi); las pruebas
 * (`tests/unit/scripts/rappiRegistrarWebhooks.test.ts`) llaman a `main` contra un Rappi simulado en memoria, sin red.
 */
import crypto from 'crypto'
import fs from 'fs'
import { parseArgs } from 'util'

import { RAPPI_EVENTS } from '../src/services/delivery-channels/providers/rappi/rappi.adapter'
import {
  apiBaseSelfOnboarding,
  getRappiEnvironment,
  rappiApi,
  tiendasEscribiblesRappi,
} from '../src/services/delivery-channels/providers/rappi/rappi.client'
import { getRappiToken } from '../src/services/delivery-channels/providers/rappi/rappi.token'
import { RUTA_POR_EVENTO, secretosDelEvento } from '../src/services/delivery-channels/providers/rappi/rappi.webhookIngress'
import {
  azpDelJwt,
  eventosARotar,
  planDeWebhooks,
  registradosDeRespuesta,
  secretoDeLaIntegracion,
  type AccionWebhook,
  type WebhookRegistrado,
} from '../src/services/delivery-channels/providers/rappi/rappi.webhooksRegistro'
import { conCandado, escribirAtomico600 } from './_archivo-de-secretos'

const API = '/api/v2/restaurants-integrations-public-api'

const EVENTOS_DE_TIENDA = Object.values(RUTA_POR_EVENTO).filter(e => e !== RAPPI_EVENTS.STORE_PROVISIONING_STATUS)

/** `JSON.parse` que nunca lanza: su mensaje de error copia un pedazo del texto, y ese texto es de Rappi. */
function leerJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Qué decir del secreto de la integración al terminar su POST (nunca el secreto). */
function notaDeSecreto(accion: AccionWebhook, origen: 'ARCHIVO' | 'PENDIENTE' | 'NUEVO'): string {
  if (accion.tipo !== 'CREAR_DE_INTEGRACION') return ''
  if (origen === 'NUEVO')
    return ' (secreto NUEVO: copia el del archivo a RAPPI_WEBHOOK_SECRETS, el servidor aún tiene el viejo si lo había)'
  return origen === 'PENDIENTE' ? ' (con el secreto pendiente de la corrida anterior)' : ' (con el secreto que ya tenía el archivo)'
}

function decir(evento: string, texto: string): void {
  console.log(`${evento.padEnd(32)} ${texto}`)
}

// ── El archivo de secretos ──────────────────────────────────────────────────────────────

function leerSecretos(salida: string): Record<string, unknown> {
  if (!fs.existsSync(salida)) return {}
  const texto = fs.readFileSync(salida, 'utf8')
  if (!texto.trim()) return {}
  const json = leerJson(texto)
  // Un archivo que no entendemos NO se sobrescribe: puede tener los únicos secretos que existen.
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${salida} existe pero no es un objeto JSON {"EVENTO":"secreto"}: no se sobrescribe, revísalo a mano.`)
  }
  return json as Record<string, unknown>
}

/** Cierra a 600 un archivo de secretos que ya existía, SIN tocar su contenido (no existe todavía = nada que cerrar). */
function cerrarPermisos600(ruta: string): void {
  try {
    fs.chmodSync(ruta, 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/** 🔴 Atómico: o queda el archivo anterior o el nuevo, nunca uno vacío ni a medias (ver `_archivo-de-secretos.ts`). */
function escribirSecretos(salida: string, secretos: Record<string, unknown>): void {
  escribirAtomico600(salida, `${JSON.stringify(secretos, null, 2)}\n`)
}

/** El `secret` de una respuesta de Rappi (CREAR o reset-secret), o `undefined`. Nunca lanza ni copia el cuerpo. */
function secretoDeLaRespuesta(raw: string): string | undefined {
  const secreto = (leerJson(raw) as { secret?: unknown } | null | undefined)?.secret
  return typeof secreto === 'string' && secreto.trim() ? secreto.trim() : undefined
}

/** El secreto de la integración que una corrida anterior guardó ANTES de su POST (ver la cabecera). */
function leerPendiente(ruta: string): string | undefined {
  try {
    return fs.readFileSync(ruta, 'utf8').trim() || undefined
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

// ── Lecturas ────────────────────────────────────────────────────────────────────────────

/** 🔴 por medir en la Tarea 7: qué contesta `GET webhook/{evento}` con un evento SIN registros (`[]`, `{event, stores: []}` u otro código). */
async function leerRegistrados(): Promise<{ registrados: WebhookRegistrado[]; deshabilitadas: Record<string, number> }> {
  const registrados: WebhookRegistrado[] = []
  const deshabilitadas: Record<string, number> = {}
  for (const evento of EVENTOS_DE_TIENDA) {
    const r = await rappiApi({ metodo: 'GET', ruta: `${API}/webhook/${evento}` })
    if (!r.ok) throw new Error(`GET webhook/${evento} respondió ${r.status}: no se escribe nada hasta poder leer lo registrado.`)
    const cuerpo = r.raw.trim() === '' ? [] : leerJson(r.raw)
    if (cuerpo === undefined) throw new Error(`GET webhook/${evento} no devolvió un JSON legible: no se escribe nada.`)
    const leido = registradosDeRespuesta(evento, cuerpo)
    registrados.push(...leido.registrados)
    if (leido.deshabilitadas) deshabilitadas[evento] = leido.deshabilitadas
  }
  return { registrados, deshabilitadas }
}

async function leerDeIntegracion(azp: string): Promise<Array<{ evento: string; url: string }>> {
  // 🔴 por medir en la Tarea 7: el host. Es un endpoint de self-onboarding, así que va al dominio de `apiBaseSelfOnboarding()`
  // (la doc lo ejemplifica en api.dev.rappi.com); los avisos por tienda van al host clásico, como `suscribirTiendaAEventos`.
  const r = await rappiApi({ metodo: 'GET', ruta: `${API}/clients/${encodeURIComponent(azp)}/webhooks`, host: apiBaseSelfOnboarding() })
  if (!r.ok) throw new Error(`GET clients/{azp}/webhooks respondió ${r.status}: no se escribe nada hasta poder leer lo registrado.`)
  const cuerpo = r.raw.trim() === '' ? [] : leerJson(r.raw)
  if (!Array.isArray(cuerpo)) throw new Error('GET clients/{azp}/webhooks no devolvió una lista legible: no se escribe nada.')
  return cuerpo
    .filter((w): w is { event: string; url: string; state?: unknown } => !!w && typeof w.event === 'string' && typeof w.url === 'string')
    .filter(w => w.state !== false) // un aviso inactivo se vuelve a crear: el POST de Rappi «crea o actualiza»
    .map(w => ({ evento: w.event, url: w.url }))
}

// ── Escrituras ──────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta UNA acción. Devuelve el secreto que Rappi dejó confirmado (`CREAR` lo recibe de Rappi; `CREAR_DE_INTEGRACION` es el
 * nuestro, ya guardado como pendiente por quien llama), `null` si salió bien sin secreto (un CREAR cuya respuesta no lo trae
 * también: el aviso ya existe y `eventosARotar` lo rota al terminar el plan), y lanza si Rappi la rechazó o no contestó.
 * `storeIds: tiendas` en TODAS: es lo que el candado de `rappi.http.ts` revisa (la de integración no es de una tienda, pero
 * sin ninguna tienda autorizada tampoco debe salir).
 */
async function ejecutar(accion: AccionWebhook, tiendas: string[], azp: string, secretoDeIntegracion: string): Promise<string | null> {
  if (accion.tipo === 'NADA') return null

  if (accion.tipo === 'CREAR') {
    const r = await rappiApi({
      metodo: 'POST',
      ruta: `${API}/webhook`,
      cuerpo: { event: accion.evento, data: [{ url: accion.url, stores: accion.tiendas }] },
      storeIds: accion.tiendas,
    })
    if (!r.ok) throw new Error(`Rappi respondió ${r.status}`)
    // 🔴 por medir en la Tarea 7: que el secreto venga en `secret` de esta respuesta (la doc lo ejemplifica así) y que sea
    // por evento (la doc no lo aclara; el ingreso lo asume así). Si no viene, el aviso YA quedó creado: se rota después.
    return secretoDeLaRespuesta(r.raw) ?? null
  }

  if (accion.tipo === 'CAMBIAR_URL') {
    // La doc pide `{url, stores}` los dos requeridos.
    const r = await rappiApi({
      metodo: 'PUT',
      ruta: `${API}/webhook/${accion.evento}/change-url`,
      cuerpo: { url: accion.url, stores: accion.tiendas },
      storeIds: accion.tiendas,
    })
    if (!r.ok) throw new Error(`Rappi respondió ${r.status}`)
    return null
  }

  if (accion.tipo === 'AGREGAR_TIENDAS') {
    // 🔴 por medir en la Tarea 7: la doc muestra el cuerpo como una LISTA `[{url, stores}]` (igual que `suscribirTiendaAEventos`).
    const r = await rappiApi({
      metodo: 'PUT',
      ruta: `${API}/webhook/${accion.evento}/add-stores`,
      cuerpo: [{ url: accion.url, stores: accion.tiendas }],
      storeIds: accion.tiendas,
    })
    if (!r.ok) throw new Error(`Rappi respondió ${r.status}`)
    return null
  }

  // CREAR_DE_INTEGRACION: el secreto lo ponemos nosotros (la respuesta de Rappi no trae ninguno).
  const r = await rappiApi({
    metodo: 'POST',
    ruta: `${API}/clients/${encodeURIComponent(azp)}/webhooks`,
    host: apiBaseSelfOnboarding(),
    cuerpo: { event: accion.evento, url: accion.url, secret: secretoDeIntegracion },
    storeIds: tiendas,
  })
  if (!r.ok) throw new Error(`Rappi respondió ${r.status}`)
  return secretoDeIntegracion
}

/**
 * Pide a Rappi un secreto NUEVO para un aviso de tienda que ya existe allá: `PUT webhook/{evento}/reset-secret`, sin cuerpo.
 * 🔴 por medir en la Tarea 7: (1) la forma de la respuesta (la doc la ejemplifica con `secret`, igual que el CREAR); (2) si el
 * secreto es POR EVENTO (la ruta lo es, pero el texto de la doc dice «genera uno nuevo al cliente autenticado»). Si fuera uno
 * solo por cliente, rotar un evento dejaría viejos los secretos guardados de los demás.
 * `storeIds: tiendas`, como toda escritura, para que el candado de `rappi.http.ts` la revise.
 */
async function rotarSecreto(evento: string, tiendas: string[]): Promise<string> {
  const r = await rappiApi({ metodo: 'PUT', ruta: `${API}/webhook/${evento}/reset-secret`, storeIds: tiendas })
  if (!r.ok) throw new Error(`Rappi respondió ${r.status}`)
  const secreto = secretoDeLaRespuesta(r.raw)
  // Rappi pudo haberlo rotado igual: el archivo sigue sin él y la corrida siguiente rota otra vez.
  if (!secreto) throw new Error('la respuesta de reset-secret no trae el secreto')
  return secreto
}

// ── Principal ───────────────────────────────────────────────────────────────────────────

export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { base: { type: 'string' }, salida: { type: 'string' }, produccion: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  })
  const uso =
    'Uso: npx tsx scripts/rappi-registrar-webhooks.ts --base <https://dominio-publico> --salida <ruta del archivo de secretos> [--produccion]'
  if (!values.base || !values.salida) throw new Error(`Faltan --base y/o --salida.\n${uso}`)
  const salida = values.salida
  const base = values.base

  let url: URL | undefined
  try {
    url = new URL(base)
  } catch {
    // cae abajo: el mensaje es el mismo para «no es una URL» y «no es http(s)»
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`--base no es una URL http(s) válida (se pasó ${JSON.stringify(base)}); ej. https://abc.ngrok.app`)
  }

  const ambiente = getRappiEnvironment()
  if (ambiente === 'PRODUCTION' && !values.produccion) {
    throw new Error('RAPPI_ENVIRONMENT=PRODUCTION: este script no corre en producción sin --produccion (decisión explícita del founder).')
  }
  const tiendas = tiendasEscribiblesRappi()
  if (tiendas.length === 0) {
    throw new Error(
      `RAPPI_WRITABLE_STORE_IDS_${ambiente} está vacía: sin tiendas autorizadas no se registra nada (un aviso sin tiendas aplicaría a todas).`,
    )
  }

  // 🔴 Una sola corrida a la vez por archivo (hallazgo #3 de Codex): el candado va ANTES de leer el archivo o Rappi.
  return conCandado(`${salida}.lock`, () => registrar(salida, base, ambiente, tiendas))
}

async function registrar(salida: string, base: string, ambiente: string, tiendas: string[]): Promise<number> {
  // 🔴 El archivo bueno NO se reescribe al empezar (hallazgo #2 de Codex: con el disco lleno, esa reescritura lo dejaba vacío).
  // Lo que comprobaba ya está comprobado sin tocarlo: el candado acaba de crear un archivo junto a `--salida` (la carpeta existe
  // y se puede escribir, que es lo que piden el temporal y el rename) y `leerSecretos` falla si no se puede leer o no es un
  // objeto JSON. Una ruta mala falla aquí, sin haber escrito nada en Rappi. Sólo se le cierran los permisos si ya existía.
  let secretos = leerSecretos(salida)
  cerrarPermisos600(salida)
  /** Guarda un secreto AL INSTANTE (Rappi no vuelve a mostrarlo). En memoria cuenta sólo lo que ya llegó a disco. */
  const guardar = (evento: string, secreto: string) => {
    const nuevos = { ...secretos, [evento]: secreto }
    escribirSecretos(salida, nuevos)
    secretos = nuevos
  }
  const rutaPendiente = `${salida}.pendiente`
  // Qué secreto lleva el aviso de la integración y de dónde sale (reutiliza el confirmado; si no, el pendiente; si no, uno nuevo).
  const integracion = secretoDeLaIntegracion(secretos, leerPendiente(rutaPendiente), () => crypto.randomBytes(32).toString('hex'))
  if (integracion.origen === 'ARCHIVO') fs.rmSync(rutaPendiente, { force: true }) // un pendiente viejo ya no sirve

  console.log(`Ambiente de Rappi: ${ambiente} · tiendas autorizadas: ${tiendas.length}`)

  // 1) Leer lo registrado (nada se escribe hasta tenerlo completo).
  const { registrados, deshabilitadas } = await leerRegistrados()
  // El token ya quedó en la caché de `rappi.token` con la primera lectura; de ahí sale el `azp`. Si no estuviera, falla AQUÍ,
  // antes de la primera escritura.
  const token = await getRappiToken('integrations', {
    fetchToken: () => Promise.reject(new Error('el token de Rappi no quedó en caché tras la primera lectura: no se pudo sacar el `azp`')),
  })
  const azp = azpDelJwt(token)
  const deIntegracion = await leerDeIntegracion(azp)

  // 2) El plan y su ejecución.
  // 🔴 Sin el secreto CONFIRMADO en el archivo, el aviso de la integración se vuelve a mandar aunque Rappi ya lo tenga con la misma URL.
  const plan = planDeWebhooks(registrados, deIntegracion, base, tiendas, integracion.origen === 'ARCHIVO')
  const resultados: Array<{ accion: AccionWebhook; aceptada: boolean }> = []
  let fallos = 0
  for (const accion of plan) {
    let aceptada = false
    try {
      // 🔴 Antes del POST, a disco: si venciera después de que Rappi lo guardó, la siguiente corrida manda el MISMO.
      if (accion.tipo === 'CREAR_DE_INTEGRACION' && integracion.origen !== 'PENDIENTE')
        escribirAtomico600(rutaPendiente, `${integracion.secreto}\n`)
      const secreto = await ejecutar(accion, tiendas, azp, integracion.secreto)
      aceptada = true // Rappi contestó 2xx: el aviso existe allá, aunque guardar su secreto falle abajo
      if (secreto) guardar(accion.evento, secreto)
      if (accion.tipo === 'CREAR_DE_INTEGRACION') fs.rmSync(rutaPendiente, { force: true }) // ya está confirmado en el principal
      const nota =
        accion.tipo === 'CREAR' && !secreto
          ? ' (la respuesta no trajo el secreto: se rota abajo)'
          : notaDeSecreto(accion, integracion.origen)
      decir(accion.evento, accion.tipo === 'NADA' ? 'NADA (ya estaba bien)' : `${accion.tipo} · listo${nota}`)
    } catch (e) {
      fallos++
      // Los mensajes que llegan aquí son nuestros (estado HTTP, candado, red, disco): nunca el cuerpo de Rappi.
      const remedio =
        accion.tipo === 'CREAR_DE_INTEGRACION'
          ? ` · el secreto quedó guardado en ${rutaPendiente}: vuelve a correr el script y reintenta con el MISMO`
          : ''
      decir(accion.evento, `${accion.tipo} · FALLÓ: ${e instanceof Error ? e.message : 'error desconocido'}${remedio}`)
    }
    resultados.push({ accion, aceptada })
  }

  // 3) 🔴 Los avisos de tienda que Rappi tiene y el archivo no (una respuesta perdida, en ésta o en otra corrida) se rotan: Rappi
  // no vuelve a mostrar un secreto, sólo da uno nuevo. Nunca el de la integración (no tiene reset-secret; ver la cabecera).
  for (const evento of eventosARotar(registrados, resultados, secretos)) {
    try {
      guardar(evento, await rotarSecreto(evento, tiendas))
      decir(evento, 'ROTAR_SECRETO · listo (secreto NUEVO: copia el del archivo a RAPPI_WEBHOOK_SECRETS)')
    } catch (e) {
      fallos++
      decir(evento, `ROTAR_SECRETO · FALLÓ: ${e instanceof Error ? e.message : 'error desconocido'}`)
    }
  }

  // 4) Avisos para el que corre el script.
  for (const [evento, n] of Object.entries(deshabilitadas)) {
    decir(evento, `AVISO: ${n} tienda(s) en DISABLE en Rappi (siguen registradas, pero no reciben avisos)`)
  }
  // 🔴 Mientras falte un secreto, la corrida NO terminó: el servidor rechazaría (401) cada aviso de ese evento.
  const mapa = JSON.stringify(secretos)
  const faltanDeTienda = EVENTOS_DE_TIENDA.filter(ev => secretosDelEvento(mapa, ev).length === 0)
  const faltaIntegracion = secretosDelEvento(mapa, RAPPI_EVENTS.STORE_PROVISIONING_STATUS).length === 0
  if (faltanDeTienda.length) {
    console.log(
      `FALTA en ${salida} el secreto de: ${faltanDeTienda.join(', ')}. Sin él, el servidor rechaza (401) esos avisos. ` +
        'Vuelve a correr este script: crea en Rappi los que no existen y rota (reset-secret) los que ya existen.',
    )
  }
  // El de la integración NO se rota con reset-secret (no existe para ese aviso): se recupera volviendo a correr este script.
  if (faltaIntegracion) {
    console.log(
      `FALTA: el aviso de la INTEGRACIÓN (${RAPPI_EVENTS.STORE_PROVISIONING_STATUS}) NO quedó confirmado en ${salida}. ` +
        `No hay reset-secret para ese aviso: vuelve a correr este script (reintenta con el secreto de ${rutaPendiente}).`,
    )
  }
  const faltan = faltanDeTienda.length + (faltaIntegracion ? 1 : 0)
  const incompleto = fallos > 0 || faltan > 0
  console.log(
    `Secretos en ${salida} (permisos 600). ${
      incompleto
        ? `NO TERMINÓ: ${fallos} acción(es) fallaron y faltan ${faltan} secreto(s); revisa arriba y vuelve a correr (es idempotente).`
        : 'Sin fallos.'
    }`,
  )
  return incompleto ? 1 : 0
}

// Sólo corre como programa: las pruebas importan `main` y la llaman con sus propios argumentos.
if (require.main === module) {
  main(process.argv.slice(2))
    .then(codigo => {
      process.exitCode = codigo
    })
    .catch(e => {
      console.error('💥', e instanceof Error ? e.message : 'error desconocido')
      process.exitCode = 1
    })
}
