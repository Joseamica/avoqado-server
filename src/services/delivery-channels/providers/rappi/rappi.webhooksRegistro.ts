/**
 * Registro de los avisos (webhooks) de Rappi — la parte PURA: qué hay que crear o cambiar.
 *
 * Lo ejecuta `scripts/rappi-registrar-webhooks.ts`; aquí sólo se decide. Sin red, sin `@/config/env`.
 *
 * 🔴 EL PLAN TIENE QUE SER IDEMPOTENTE: correr el script dos veces deja todo en NADA. Rappi no tiene un
 * «upsert» para los avisos por tienda (`POST webhook` crea, `change-url` cambia, `add-stores` suma), así que
 * elegir mal la llamada duplica o pisa lo registrado.
 *
 * 🔴 NUNCA UN `CREAR` SIN TIENDAS: un webhook sin `stores` aplica a TODAS las tiendas del cliente autenticado
 * (doc de Rappi). Por eso `planDeWebhooks` LANZA si no recibe ninguna, en vez de devolver un plan que el candado
 * de escritura tendría que atajar.
 *
 * 🔴 Un evento que YA tiene algún registro (aunque sea de otra tienda) se completa con `add-stores`, jamás con
 * `POST webhook`: lo que Rappi hace al crear un evento que ya existe no está documentado.
 *
 * 🔴 EL AVISO DE LA INTEGRACIÓN NO SE DA POR BUENO SI EL ARCHIVO NO TIENE SU SECRETO. Ese secreto es NUESTRO (lo inventa el
 * script y Rappi sólo lo usa para firmar) y, a diferencia de los de tienda, no hay forma de pedirle uno nuevo: el
 * `reset-secret` de la doc es sólo de los avisos por tienda. Si el aviso ya está en Rappi con nuestra URL pero el archivo
 * lo perdió (el POST venció a los 10 s después de que Rappi lo guardó, o se corrió con otro `--salida`), cada aviso de
 * aprovisionamiento llegaría firmado con un secreto que nadie conoce y el servidor lo rechazaría con 401 para siempre.
 * Como el POST de integración «crea o actualiza», el remedio es volver a mandarlo con el secreto del archivo.
 *
 * 🔴 UN AVISO DE TIENDA QUE RAPPI TIENE Y EL ARCHIVO NO, SE ROTA (`eventosARotar`). Su secreto lo pone Rappi y sólo lo entrega
 * en la respuesta del CREAR; si esa respuesta se pierde, el plan ve todo bien (NADA) y el archivo se quedaba sin él para siempre.
 * Para que «no está en el archivo» sea cierto, la clave de un aviso que se va a CREAR se quita antes (`clavesQueYaNoVerifican`):
 * si no, la vieja tapaba a la nueva. Y nunca se rota un aviso que también tiene tiendas ajenas (cambiaría también su secreto).
 */
import { RAPPI_EVENTS } from './rappi.adapter'
import { RUTA_POR_EVENTO, secretosDelEvento } from './rappi.webhookIngress'

/** Los 10 avisos POR TIENDA, en el orden de `RUTA_POR_EVENTO` (el de la integración va aparte). */
const EVENTOS_DE_TIENDA = Object.values(RUTA_POR_EVENTO).filter(e => e !== RAPPI_EVENTS.STORE_PROVISIONING_STATUS)

export type AccionWebhook =
  | { tipo: 'CREAR'; evento: string; url: string; tiendas: string[] }
  | { tipo: 'CAMBIAR_URL'; evento: string; url: string; tiendas: string[] }
  | { tipo: 'AGREGAR_TIENDAS'; evento: string; url: string; tiendas: string[] }
  | { tipo: 'CREAR_DE_INTEGRACION'; evento: 'STORE_PROVISIONING_STATUS'; url: string }
  | { tipo: 'NADA'; evento: string }

export interface WebhookRegistrado {
  evento: string
  url: string
  tiendas: string[]
}

/**
 * @param registrados     lo que Rappi tiene hoy por tienda (una fila por evento y URL).
 * @param deIntegracion   lo que Rappi tiene a nivel de la integración (sólo `STORE_PROVISIONING_STATUS`).
 * @param base            la base pública de nuestro servidor (con o sin barra final).
 * @param tiendas         las tiendas donde SÍ se puede escribir (`tiendasEscribiblesRappi()`).
 * @param secretoDeIntegracionGuardado  ¿el archivo de secretos ya tiene, CONFIRMADO, el de `STORE_PROVISIONING_STATUS`
 *                        (`secretoDeLaIntegracion(...).origen === 'ARCHIVO'`)? Si no, el aviso de la integración se manda otra
 *                        vez aunque Rappi ya lo tenga con la misma URL.
 */
export function planDeWebhooks(
  registrados: WebhookRegistrado[],
  deIntegracion: Array<{ evento: string; url: string }>,
  base: string,
  tiendas: string[],
  secretoDeIntegracionGuardado = true,
): AccionWebhook[] {
  if (tiendas.length === 0) {
    throw new Error(
      'No hay tiendas donde escribir (RAPPI_WRITABLE_STORE_IDS_* vacía): un aviso sin tiendas aplicaría a TODAS las de Rappi.',
    )
  }

  const raiz = base.trim().replace(/\/+$/, '')
  const urlDe = (segmento: string) => `${raiz}/api/v1/webhooks/delivery/rappi/${segmento}`
  const acciones: AccionWebhook[] = []

  for (const [segmento, evento] of Object.entries(RUTA_POR_EVENTO)) {
    // El aviso de aprovisionamiento es por INTEGRACIÓN, no por tienda: va aparte, al final.
    if (evento === RAPPI_EVENTS.STORE_PROVISIONING_STATUS) continue

    const url = urlDe(segmento)
    const delEvento = registrados.filter(r => r.evento === evento)
    if (delEvento.length === 0) {
      acciones.push({ tipo: 'CREAR', evento, url, tiendas: [...tiendas] })
      continue
    }

    const urlDeCadaTienda = new Map<string, string>()
    for (const r of delEvento) for (const t of r.tiendas) urlDeCadaTienda.set(t, r.url)

    const cambiar = tiendas.filter(t => urlDeCadaTienda.has(t) && urlDeCadaTienda.get(t) !== url)
    const agregar = tiendas.filter(t => !urlDeCadaTienda.has(t))
    if (cambiar.length) acciones.push({ tipo: 'CAMBIAR_URL', evento, url, tiendas: cambiar })
    if (agregar.length) acciones.push({ tipo: 'AGREGAR_TIENDAS', evento, url, tiendas: agregar })
    if (!cambiar.length && !agregar.length) acciones.push({ tipo: 'NADA', evento })
  }

  const eventoIntegracion = RAPPI_EVENTS.STORE_PROVISIONING_STATUS
  const urlIntegracion = urlDe(Object.entries(RUTA_POR_EVENTO).find(([, e]) => e === eventoIntegracion)![0])
  // El POST de integración «crea o actualiza»: una URL distinta, o un secreto que el archivo perdió, se arreglan con la misma llamada.
  acciones.push(
    secretoDeIntegracionGuardado && deIntegracion.some(w => w.evento === eventoIntegracion && w.url === urlIntegracion)
      ? { tipo: 'NADA', evento: eventoIntegracion }
      : { tipo: 'CREAR_DE_INTEGRACION', evento: eventoIntegracion, url: urlIntegracion },
  )
  return acciones
}

/**
 * Qué avisos POR TIENDA hay que rotar con `PUT webhook/{evento}/reset-secret` después de ejecutar el plan: los que EXISTEN en
 * Rappi, cuyo secreto no está en el archivo y cuyas tiendas son TODAS nuestras.
 *
 * 🔴 Por qué (hallazgo #1 de Codex, bloque 0): Rappi crea el aviso, pero la respuesta que trae su secreto se pierde (vence a los
 * 10 s). Al repetir, el plan ve la tienda y la URL bien ⇒ NADA, y el servidor rechazaría (401) cada aviso de ese evento para
 * siempre. Rappi no vuelve a mostrar un secreto: sólo da uno nuevo.
 *
 * «Existe en Rappi» = estaba en lo leído (`registrados`), o esta corrida lo creó, le cambió la URL o le agregó tiendas y Rappi lo
 * ACEPTÓ (2xx; un CREAR aceptado cuya respuesta no traía el secreto también cuenta). Un CREAR que FALLÓ no cuenta: no se sabe si
 * existe, y si Rappi sí lo guardó, la corrida siguiente lo lee y entonces se rota.
 *
 * 🔴 `reset-secret` cambia el secreto de TODO el aviso, no sólo el de nuestras tiendas (ronda 2, I2). Un aviso LEÍDO con alguna
 * fila de una tienda fuera de `tiendas` NO se rota: se le cambiaría el secreto a quien atiende esa tienda. Sale en
 * `conTiendasAjenas` para que el script lo diga con 🚨 y no dé la corrida por terminada (a propósito: lo decide una persona).
 * Un aviso que esta corrida CREÓ sólo tiene nuestras tiendas (un CREAR sólo sale cuando Rappi no tenía ninguna fila).
 * 🔴 El de la INTEGRACIÓN nunca sale de aquí: no tiene reset-secret (su secreto es nuestro; ver `secretoDeLaIntegracion`).
 *
 * @param registrados  lo leído de Rappi al empezar la corrida.
 * @param resultados   cada acción del plan con su desenlace: `aceptada` = Rappi contestó 2xx.
 * @param secretos     el archivo de secretos TAL COMO QUEDÓ en disco después del plan.
 * @param tiendas      las tiendas donde SÍ se puede escribir (`tiendasEscribiblesRappi()`).
 */
export function eventosARotar(
  registrados: WebhookRegistrado[],
  resultados: Array<{ accion: AccionWebhook; aceptada: boolean }>,
  secretos: Record<string, unknown>,
  tiendas: string[],
): { rotar: string[]; conTiendasAjenas: string[] } {
  const enRappi = new Set(registrados.map(r => r.evento))
  for (const { accion, aceptada } of resultados) {
    if (aceptada && (accion.tipo === 'CREAR' || accion.tipo === 'CAMBIAR_URL' || accion.tipo === 'AGREGAR_TIENDAS')) {
      enRappi.add(accion.evento)
    }
  }
  const nuestras = new Set(tiendas)
  const conAjenas = (evento: string) => registrados.some(r => r.evento === evento && r.tiendas.some(t => !nuestras.has(t)))
  const mapa = JSON.stringify(secretos)
  const sinSecreto = EVENTOS_DE_TIENDA.filter(evento => enRappi.has(evento) && secretosDelEvento(mapa, evento).length === 0)
  return { rotar: sinSecreto.filter(e => !conAjenas(e)), conTiendasAjenas: sinSecreto.filter(conAjenas) }
}

/**
 * Las claves del archivo que hay que QUITAR antes de ejecutar el plan: las de los avisos de tienda que van a CREARSE.
 *
 * 🔴 Por qué (ronda 2, I1): un CREAR sólo sale cuando Rappi no tiene ninguna fila de ese aviso, así que la clave que el archivo
 * conserve de él ya no verifica nada. Si se quedara, TAPARÍA la nueva: con una respuesta sin secreto, perdida, o un guardado
 * fallido, el archivo seguiría «teniendo secreto», `eventosARotar` no rotaría y la corrida siguiente diría «Sin fallos» con una
 * clave que Rappi ya no usa. Se quita (de forma atómica) ANTES de mandar el CREAR; si no se puede quitar, no se manda nada.
 * Se quita aunque el valor esté vacío o no sea texto: nada que parezca su secreto debe quedar.
 * 🔴 La de la INTEGRACIÓN nunca: es nuestra, y su CREAR_DE_INTEGRACION vuelve a mandar ESA misma (ver `secretoDeLaIntegracion`).
 */
export function clavesQueYaNoVerifican(plan: AccionWebhook[], secretos: Record<string, unknown>): string[] {
  const aCrear = new Set(plan.filter(a => a.tipo === 'CREAR').map(a => a.evento))
  return EVENTOS_DE_TIENDA.filter(evento => aCrear.has(evento) && Object.prototype.hasOwnProperty.call(secretos, evento))
}

/**
 * Lee la respuesta de `GET webhook/{evento}` y la deja en la forma del plan (una fila por URL).
 *
 * Tolerante a propósito: sin evento registrado Rappi puede contestar `[]` o `{event, stores: []}`, y con evento una
 * lista o un objeto. Otros eventos dentro de la respuesta se ignoran. Una tienda en `DISABLE` SIGUE registrada
 * (volver a agregarla no es lo que se quiere), pero se cuenta para que el script avise: es un aviso que no llega.
 * 🔴 Nunca lanza con un cuerpo raro (un error de parseo copiaría un pedazo del cuerpo a los logs).
 */
export function registradosDeRespuesta(evento: string, cuerpo: unknown): { registrados: WebhookRegistrado[]; deshabilitadas: number } {
  const filas = Array.isArray(cuerpo) ? cuerpo : [cuerpo]
  const porUrl = new Map<string, string[]>()
  let deshabilitadas = 0

  for (const fila of filas) {
    if (!fila || typeof fila !== 'object') continue
    const { event, stores } = fila as { event?: unknown; stores?: unknown }
    if (event !== undefined && event !== evento) continue
    if (!Array.isArray(stores)) continue
    for (const t of stores) {
      if (!t || typeof t !== 'object') continue
      const { store_id: id, url, state } = t as { store_id?: unknown; url?: unknown; state?: unknown }
      if ((typeof id !== 'string' && typeof id !== 'number') || typeof url !== 'string') continue
      if (state === 'DISABLE') deshabilitadas++
      porUrl.set(url, [...(porUrl.get(url) ?? []), String(id)])
    }
  }
  return { registrados: [...porUrl].map(([url, tiendas]) => ({ evento, url, tiendas })), deshabilitadas }
}

/**
 * El `azp` del JWT del integrador = su `clientId` (la ruta `/clients/{clientId}/webhooks` lo pide). Se decodifica el
 * payload SIN verificar la firma: sólo leemos un dato que Rappi mismo nos acaba de entregar. Los errores no copian el
 * token ni su contenido.
 */
export function azpDelJwt(token: string): string {
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    throw new Error('El token de Rappi no es un JWT legible: no se pudo sacar el `azp` (el clientId de la integración).')
  }
  const azp = (claims as { azp?: unknown } | null)?.azp
  if (typeof azp !== 'string' || !azp.trim()) {
    throw new Error(
      'El token de Rappi no trae el claim `azp` (el clientId de la integración): sin él no se puede registrar el aviso de la integración.',
    )
  }
  return azp.trim()
}

/**
 * El secreto del aviso de la integración, y de dónde sale:
 *  · `ARCHIVO`   — el CONFIRMADO que ya está en el archivo de secretos. Reutilizarlo evita que un túnel nuevo rote en silencio
 *                  un secreto que el env del servidor (`RAPPI_WEBHOOK_SECRETS`) todavía tiene. Si trae una lista (ventana de
 *                  rotación a mano), se usa el primero: el ingreso acepta todos los de la lista.
 *  · `PENDIENTE` — uno que una corrida anterior guardó ANTES de su POST y que Rappi no llegó a confirmar (falló o venció).
 *                  Se reintenta con ESE mismo: si Rappi sí lo había guardado, queda igual; si no, ahora sí.
 *  · `NUEVO`     — no hay ninguno: se genera.
 * 🔴 Sólo `ARCHIVO` cuenta como «guardado» para `planDeWebhooks`. Un pendiente NO: si el POST falló y Rappi todavía tiene el
 * aviso viejo con la misma URL, darlo por bueno dejaría a Rappi firmando con un secreto que nadie conoce.
 */
export function secretoDeLaIntegracion(
  secretos: Record<string, unknown>,
  pendiente: string | undefined,
  generar: () => string,
): { secreto: string; origen: 'ARCHIVO' | 'PENDIENTE' | 'NUEVO' } {
  const confirmado = secretosDelEvento(JSON.stringify(secretos), RAPPI_EVENTS.STORE_PROVISIONING_STATUS)[0]
  if (confirmado) return { secreto: confirmado, origen: 'ARCHIVO' }
  if (pendiente?.trim()) return { secreto: pendiente.trim(), origen: 'PENDIENTE' }
  return { secreto: generar(), origen: 'NUEVO' }
}
