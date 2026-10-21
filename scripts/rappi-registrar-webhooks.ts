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
 *
 * 🔴 EL SECRETO DE LA INTEGRACIÓN ES NUESTRO Y NO TIENE `reset-secret` (el de la doc es sólo de los avisos por tienda): si se
 * pierde, sólo se recupera volviendo a mandarlo. Por eso (1) se guarda en `<salida>.pendiente` (modo 600) ANTES del POST y sólo
 * pasa al archivo principal cuando Rappi lo confirma; (2) mientras no esté confirmado en el principal, cada corrida vuelve a
 * mandar el aviso con ESE secreto aunque Rappi ya muestre la misma URL (el POST «crea o actualiza»). Si fallara o venciera, basta
 * volver a correr el script. Nunca se da por bueno un secreto que Rappi no confirmó: el aviso viejo seguiría firmando con otro.
 *
 * Las escrituras pasan por el candado de tiendas de `rappi.http.ts` (lista vacía = no sale ninguna). Se niega a correr con
 * `RAPPI_ENVIRONMENT=PRODUCTION` sin `--produccion`. No se ejecuta en pruebas: se corre a mano (Tarea 7 del plan de Rappi).
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
  planDeWebhooks,
  registradosDeRespuesta,
  secretoDeLaIntegracion,
  type AccionWebhook,
  type WebhookRegistrado,
} from '../src/services/delivery-channels/providers/rappi/rappi.webhooksRegistro'

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

function escribir600(ruta: string, texto: string): void {
  try {
    fs.chmodSync(ruta, 0o600) // si ya existía con otros permisos, se cierra ANTES de escribir
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  fs.writeFileSync(ruta, texto, { mode: 0o600 })
}

function escribirSecretos(salida: string, secretos: Record<string, unknown>): void {
  escribir600(salida, `${JSON.stringify(secretos, null, 2)}\n`)
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
 * nuestro, ya guardado como pendiente por quien llama), `null` si salió bien sin secreto, y lanza si Rappi la rechazó.
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
    // por evento (la doc no lo aclara; el ingreso lo asume así).
    const secreto = (leerJson(r.raw) as { secret?: unknown } | undefined)?.secret
    if (typeof secreto !== 'string' || !secreto.trim()) {
      throw new Error('el aviso quedó creado pero la respuesta de Rappi no trae el secreto (hay que rotarlo con reset-secret)')
    }
    return secreto.trim()
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

// ── Principal ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, salida: { type: 'string' }, produccion: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  })
  const uso =
    'Uso: npx tsx scripts/rappi-registrar-webhooks.ts --base <https://dominio-publico> --salida <ruta del archivo de secretos> [--produccion]'
  if (!values.base || !values.salida) throw new Error(`Faltan --base y/o --salida.\n${uso}`)
  const salida = values.salida

  let url: URL | undefined
  try {
    url = new URL(values.base)
  } catch {
    // cae abajo: el mensaje es el mismo para «no es una URL» y «no es http(s)»
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`--base no es una URL http(s) válida (se pasó ${JSON.stringify(values.base)}); ej. https://abc.ngrok.app`)
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

  // El archivo se prepara ANTES de tocar Rappi: una ruta mala o un archivo ilegible deben fallar sin haber escrito nada allá.
  const secretos = leerSecretos(salida)
  escribirSecretos(salida, secretos)
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
  const plan = planDeWebhooks(registrados, deIntegracion, values.base, tiendas, integracion.origen === 'ARCHIVO')
  let fallos = 0
  for (const accion of plan) {
    try {
      // 🔴 Antes del POST, a disco: si venciera después de que Rappi lo guardó, la siguiente corrida manda el MISMO.
      if (accion.tipo === 'CREAR_DE_INTEGRACION' && integracion.origen !== 'PENDIENTE')
        escribir600(rutaPendiente, `${integracion.secreto}\n`)
      const secreto = await ejecutar(accion, tiendas, azp, integracion.secreto)
      if (secreto) {
        secretos[accion.evento] = secreto
        escribirSecretos(salida, secretos) // al instante: Rappi no vuelve a mostrar el de un aviso ya creado
      }
      if (accion.tipo === 'CREAR_DE_INTEGRACION') fs.rmSync(rutaPendiente, { force: true }) // ya está confirmado en el principal
      decir(
        accion.evento,
        accion.tipo === 'NADA' ? 'NADA (ya estaba bien)' : `${accion.tipo} · listo${notaDeSecreto(accion, integracion.origen)}`,
      )
    } catch (e) {
      fallos++
      // Los mensajes que llegan aquí son nuestros (estado HTTP, candado, red): nunca el cuerpo de Rappi.
      const remedio =
        accion.tipo === 'CREAR_DE_INTEGRACION'
          ? ` · el secreto quedó guardado en ${rutaPendiente}: vuelve a correr el script y reintenta con el MISMO`
          : ''
      decir(accion.evento, `${accion.tipo} · FALLÓ: ${e instanceof Error ? e.message : 'error desconocido'}${remedio}`)
    }
  }

  // 3) Avisos para el que corre el script.
  for (const [evento, n] of Object.entries(deshabilitadas)) {
    decir(evento, `AVISO: ${n} tienda(s) en DISABLE en Rappi (siguen registradas, pero no reciben avisos)`)
  }
  const sinSecreto = EVENTOS_DE_TIENDA.filter(ev => secretosDelEvento(JSON.stringify(secretos), ev).length === 0)
  if (sinSecreto.length) {
    console.log(
      `AVISO: ${salida} no tiene el secreto de: ${sinSecreto.join(', ')}. Ya existían en Rappi antes de este script; ` +
        'hay que rotarlos con PUT webhook/{evento}/reset-secret (no está automatizado).',
    )
  }
  // El de la integración NO se rota con reset-secret (no existe para ese aviso): se recupera volviendo a correr este script.
  if (secretosDelEvento(JSON.stringify(secretos), RAPPI_EVENTS.STORE_PROVISIONING_STATUS).length === 0) {
    console.log(
      `AVISO: el aviso de la INTEGRACIÓN (${RAPPI_EVENTS.STORE_PROVISIONING_STATUS}) NO quedó confirmado en ${salida}. ` +
        `No hay reset-secret para ese aviso: vuelve a correr este script (reintenta con el secreto de ${rutaPendiente}).`,
    )
  }
  console.log(
    `Secretos en ${salida} (permisos 600). ${fallos ? `FALLARON ${fallos} acción(es): revisa arriba y vuelve a correr (es idempotente).` : 'Sin fallos.'}`,
  )
  return fallos ? 1 : 0
}

main()
  .then(codigo => {
    process.exitCode = codigo
  })
  .catch(e => {
    console.error('💥', e instanceof Error ? e.message : 'error desconocido')
    process.exitCode = 1
  })
