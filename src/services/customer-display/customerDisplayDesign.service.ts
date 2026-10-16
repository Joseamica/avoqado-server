// src/services/customer-display/customerDisplayDesign.service.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { lockTerminalRow } from '@/services/shared/terminalScopedWrites'
import { esEsperaVencida, esInterbloqueo, esperaCortaAleatoria } from '@/services/shared/lockWait'
import { resolveEffectiveDeviceCapabilities } from '@/services/device-capabilities.service'
import { cache, congelar, enVuelo, invalidateCustomerDisplayCache, purgar, TTL_MS, vuelosPorLlave } from './customerDisplayCache'
import { buildEffectiveDesign, type AssetRow, type FichaEfectiva } from './customerDisplayDesign.effective'
import {
  DEVICES_PAGE_MAX,
  FACTORY_DESIGN,
  MAX_COPY_TARGETS,
  MAX_SLIDES,
  validateDesignDraft,
  type DesignDraft,
  type DesignValues,
} from './customerDisplayDesign.validation'
import { PollWorkSaturated, type PollWorkLimiter } from './pollWork'
import { configuredStorageBucket } from './storageOrigins'
import { entitlementsFrom, PLAN_SNAPSHOT_TTL_MS, readPlanGrants, readVenuePlanSnapshot, type Entitlements } from './venuePlanSnapshot'
// M5 (revisión final): re-exportado, no redefinido — el tope de destinos vive en el módulo PURO (mismo patrón que
// `MAX_ASSET_BYTES` en `customerDisplayAsset.service.ts`, 949bf907), para que la ruta HTTP y el MCP lean el MISMO
// número que este servicio en vez de arrastrar una segunda copia hardcodeada.
export { MAX_COPY_TARGETS }

/**
 * Leer el diseño de la pantalla del cliente de UNA terminal (spec §5.2, §5.3).
 *
 * 🔴 Toda lectura se acota con `{ id, venueId }`. Una terminal de otro negocio tiene que ser
 * INDISTINGUIBLE de una que no existe: si contestáramos 403 «no es tuya», habríamos confirmado que
 * ese id existe en otra parte.
 */

// La regla vive en `venuePlanSnapshot` (Task 3 de F0-B); el tipo se re-exporta para que los importadores de F0-A no cambien.
export type { Entitlements }

/** Todo lo que la ficha necesita además de la terminal. Se lee UNA vez por operación y viaja como parámetro. */
export interface FichaContext {
  entitlements: Entitlements
  bucket: string | null
  /** Hasta cuándo vale el plan con que se armó (sólo el contexto cacheado lo trae; DD4). */
  vigenteHasta?: number
}

const TERMINAL_SELECT = {
  id: true,
  venueId: true,
  name: true,
  type: true,
  customerDisplayDesignVersion: true,
  customerDisplayPresent: true,
  customerDisplayInvertible: true,
  displayModeProtocolVersion: true,
  capabilitiesObservedAt: true,
  customerDisplayInverted: true,
  customerDisplayRequest: true,
  customerDisplayRequestVersion: true,
  customerDisplayAck: true,
  customerDisplayInstallationId: true,
  customerDisplayInstallationSwitches: true,
  lastHeartbeat: true,
  venue: { select: { logo: true, updatedAt: true } },
  customerDisplayDesign: true,
} satisfies Prisma.TerminalSelect

export type TerminalRow = Prisma.TerminalGetPayload<{ select: typeof TERMINAL_SELECT }>
export type DesignRow = NonNullable<TerminalRow['customerDisplayDesign']>

/**
 * 🔴 UN solo 404 para «no existe» y «no es de este negocio», antes del candado Y bajo él: si difirieran en el texto o en
 * el código, le dirían a quien pregunta que la terminal existía y se acaba de mudar.
 */
function dispositivoNoEncontrado(): NotFoundError {
  return new NotFoundError('Dispositivo no encontrado')
}

export async function loadTerminalForCustomerDisplay(venueId: string, terminalId: string): Promise<TerminalRow> {
  const terminal = await prisma.terminal.findFirst({ where: { id: terminalId, venueId }, select: TERMINAL_SELECT })
  if (!terminal) throw dispositivoNoEncontrado()
  if (terminal.type !== 'POS_ANDROID') {
    // 422 y no 404: la terminal SÍ es de este negocio, sólo que no tiene pantalla del cliente.
    throw new ValidationError('Este dispositivo no tiene pantalla del cliente', 'CUSTOMER_DISPLAY_NOT_SUPPORTED')
  }
  return terminal
}

export function editTokenOf(design: { id: string; revision: number } | null): string {
  return design ? `${design.id}:${design.revision}` : 'factory'
}

export function designValuesOf(row: DesignRow | null): DesignValues {
  // Arreglo PROPIO: el de fábrica está congelado y es de todos; quien reciba estos valores puede editarlos.
  if (!row) return { ...FACTORY_DESIGN, slides: [] }
  const slides = Array.isArray(row.slides) ? (row.slides as { assetId?: unknown }[]) : []
  return {
    theme: row.theme,
    accentColor: row.accentColor,
    logoAssetId: row.logoAssetId,
    welcomeText: row.welcomeText,
    thanksText: row.thanksText,
    // Acotado aunque el JSON guardado traiga de más: la lectura nunca depende de que la escritura haya sido correcta.
    slides: slides
      .filter(s => typeof s?.assetId === 'string')
      .slice(0, MAX_SLIDES)
      .map(s => ({ assetId: s.assetId as string })),
    slideSeconds: row.slideSeconds,
    showPromotions: row.showPromotions,
  }
}

export async function readEntitlements(venueId: string): Promise<Entitlements> {
  // UNA regla para toda la pantalla del cliente: la del snapshot del plan (Task 3 de F0-B).
  return entitlementsFrom(await readPlanGrants(venueId))
}

let bucketAvisado = false
function bucketConAviso(): string | null {
  const bucket = configuredStorageBucket()
  if (!bucket && !bucketAvisado) {
    bucketAvisado = true
    logger.error('[pantalla-del-cliente] Firebase Storage no está configurado: la ficha sale sin imágenes')
  }
  return bucket
}

export async function readFichaContext(venueId: string): Promise<FichaContext> {
  return { entitlements: await readEntitlements(venueId), bucket: bucketConAviso() }
}

/** El contexto del POLL: el plan sale de la caché por venue (Task 3) y el contexto dice hasta cuándo vale. */
export async function readFichaContextCached(venueId: string, o: { limiter?: PollWorkLimiter } = {}): Promise<FichaContext> {
  const plan = await readVenuePlanSnapshot(venueId, o)
  return { entitlements: plan.entitlements, bucket: bucketConAviso(), vigenteHasta: plan.calculadoEn + PLAN_SNAPSHOT_TTL_MS }
}

async function cargarActivos(values: DesignValues, venueId: string): Promise<Map<string, AssetRow>> {
  const ids = [...values.slides.map(s => s.assetId), ...(values.logoAssetId ? [values.logoAssetId] : [])]
  if (ids.length === 0) return new Map()
  // Acotada al venue de la terminal, como toda lectura. No se pierde nada: un activo ajeno que no llega queda
  // «inexistente», y `buildEffectiveDesign` lo omite y lo reporta en `assetRejected` igual. La revalidación de
  // propiedad y `kind` se queda allá de todos modos: el filtro es la primera capa, no la única.
  const filas = await prisma.customerDisplayAsset.findMany({
    where: { id: { in: ids }, venueId },
    select: { id: true, venueId: true, kind: true, objectPath: true, sha256: true },
    take: MAX_SLIDES + 1,
  })
  return new Map(filas.map(f => [f.id, f as AssetRow]))
}

export async function armarFicha(
  terminal: TerminalRow,
  values: DesignValues,
  ctx: FichaContext,
): Promise<{ ficha: FichaEfectiva; assetRejected: string[] }> {
  const assets = await cargarActivos(values, terminal.venueId)
  return buildEffectiveDesign({
    design: values,
    terminal: { venueId: terminal.venueId, designVersion: terminal.customerDisplayDesignVersion },
    venue: terminal.venue,
    assets,
    entitlements: ctx.entitlements,
    bucket: ctx.bucket,
  })
}

// La caché de la ficha vive en su propio módulo, sin dependencias en tiempo de ejecución, para que quien cambia una
// terminal de negocio la invalide sin importar este servicio. Se re-exporta lo que ya se importaba desde aquí.
export { CACHE_MAX_ENTRIES, cacheSizeForTests, invalidateCustomerDisplayCache, peekEffectiveFingerprint } from './customerDisplayCache'

export type ModoDeCache = boolean | 'refresh'
type ValorEnCache = { ficha: FichaEfectiva; assetRejected: string[] }

/**
 * El cálculo de una ficha para la caché (poll y 'refresh'). 🔴 Nunca un lugar dentro de otro (Codex r1 #2): el plan va
 * PRIMERO y fuera de todo lugar —su caché toma el suyo sólo si tiene que calcular—, y después la terminal y sus activos
 * ocupan UN lugar, sólo en el poll, hasta que las dos lecturas (seguidas, no en paralelo) se asientan.
 */
async function calcularParaLaCache(
  venueId: string,
  terminalId: string,
  modo: true | 'refresh',
  limiter: PollWorkLimiter | undefined,
): Promise<{ valor: ValorEnCache; vigenteHasta?: number }> {
  const ctx = modo === true ? await readFichaContextCached(venueId, { limiter }) : await readFichaContext(venueId)
  const leer = async () => {
    const terminal = await loadTerminalForCustomerDisplay(venueId, terminalId)
    return armarFicha(terminal, designValuesOf(terminal.customerDisplayDesign), ctx)
  }
  // El tope SÓLO para el poll: 'refresh' lo pide una persona (o su aparato), no el trabajo de fondo.
  const enSuLugar = modo === true && limiter ? limiter.intentar(leer) : leer()
  if (enSuLugar === null) throw new PollWorkSaturated()
  return { valor: await enSuLugar, vigenteHasta: ctx.vigenteHasta }
}

export async function getEffectiveDesign(
  venueId: string,
  terminalId: string,
  opciones: { cache?: ModoDeCache; limiter?: PollWorkLimiter } = {},
): Promise<ValorEnCache> {
  const modo = opciones.cache ?? false
  if (modo === false) {
    // El dashboard: fresco y sin tocar la caché, IGUAL que F0-A.
    const terminal = await loadTerminalForCustomerDisplay(venueId, terminalId)
    return armarFicha(terminal, designValuesOf(terminal.customerDisplayDesign), await readFichaContext(venueId))
  }

  const llave = `${terminalId}:${venueId}`
  if (modo === true) {
    const guardado = cache.get(llave)
    if (guardado && guardado.hasta > Date.now()) return guardado.valor
    // 🔴 Un solo cálculo por llave (spec §5.7.4) — pero NUNCA unirse a uno que empezó antes de una invalidación: la
    // generación de la terminal lo distingue (la misma marca que ya impide que ese cálculo se guarde).
    const vueloDeLaTerminal = enVuelo.get(terminalId)
    const compartido = vuelosPorLlave.get(llave)
    if (vueloDeLaTerminal && compartido && compartido.generacion === vueloDeLaTerminal.generacion) return compartido.promesa
  } else {
    // 'refresh': lo de antes (guardado o en vuelo) ya no vale para NADIE; lo que calculemos aquí lo reemplaza.
    invalidateCustomerDisplayCache(terminalId)
  }

  // Todo esto ANTES del primer `await`: un segundo pedido de la misma llave ya encuentra el vuelo y se une.
  const vuelo = enVuelo.get(terminalId) ?? { generacion: 0, calculos: 0 }
  enVuelo.set(terminalId, vuelo)
  const generacionAlEmpezar = vuelo.generacion
  vuelo.calculos += 1

  // 🔴 Codex r1 #1: `.then().finally()` sobre el cálculo ya arrancado. El `finally` corre DESPUÉS, cuando `promesa` ya
  // existe; una función async inmediata que se nombrara a sí misma en su `finally` no compila (TS2454).
  const promesa: Promise<ValorEnCache> = calcularParaLaCache(venueId, terminalId, modo, opciones.limiter)
    .then(({ valor: crudo, vigenteHasta }) => {
      const valor = congelar(crudo)
      if (vuelo.generacion === generacionAlEmpezar) {
        const ahora = Date.now()
        // `set` sobre una llave que ya existe conserva su lugar en la fila: el `delete` va ANTES de purgar (F0-A).
        cache.delete(llave)
        purgar(ahora)
        // DD4: nunca más que el plan con que se armó (60 s de plan + 60 s de ficha serían hasta 120 s de retraso).
        cache.set(llave, { hasta: Math.min(ahora + TTL_MS, vigenteHasta ?? Number.POSITIVE_INFINITY), valor })
      }
      return valor
    })
    .finally(() => {
      vuelo.calculos -= 1
      if (vuelo.calculos === 0) enVuelo.delete(terminalId)
      if (vuelosPorLlave.get(llave)?.promesa === promesa) vuelosPorLlave.delete(llave)
    })
  vuelosPorLlave.set(llave, { promesa, generacion: generacionAlEmpezar })
  return promesa
}

export interface DashboardView {
  terminal: { id: string; name: string }
  editToken: string
  design: DesignValues
  ficha: FichaEfectiva
  entitlements: Entitlements
  assetRejected: string[]
  device: {
    presence: string
    stale: boolean
    capabilitiesObservedAt: string | null
    lastHeartbeat: string | null
    designVersion: number | null
    ack: unknown
    installationWarning: boolean
  }
}

/** Cambios de instalación que encienden el aviso «¿Copiaste la app a otra tablet?» (spec §5.7.2, §6.1). */
const INSTALLATION_SWITCHES_FOR_WARNING = 3
const INSTALLATION_WARNING_WINDOW_MS = 24 * 60 * 60 * 1000

export async function getCustomerDisplayForDashboard(venueId: string, terminalId: string): Promise<DashboardView> {
  const terminal = await loadTerminalForCustomerDisplay(venueId, terminalId)
  const design = designValuesOf(terminal.customerDisplayDesign)
  const ctx = await readFichaContext(venueId) // UNA vez: la vista y la ficha no pueden contestar distinto
  const { ficha, assetRejected } = await armarFicha(terminal, design, ctx)

  // La presencia sale del MISMO resolvedor que el resto del dashboard (regla de 7 días incluida):
  // una segunda regla aquí divergiría de la pantalla de dispositivos sin que nadie lo note.
  const capacidades = resolveEffectiveDeviceCapabilities(terminal, { now: new Date() })

  const switches: unknown[] = Array.isArray(terminal.customerDisplayInstallationSwitches)
    ? terminal.customerDisplayInstallationSwitches
    : []
  const desde = Date.now() - INSTALLATION_WARNING_WINDOW_MS
  const installationWarning =
    switches.filter(s => typeof s === 'string' && new Date(s).getTime() > desde).length >= INSTALLATION_SWITCHES_FOR_WARNING

  return {
    terminal: { id: terminal.id, name: terminal.name },
    editToken: editTokenOf(terminal.customerDisplayDesign),
    design,
    ficha,
    entitlements: ctx.entitlements,
    assetRejected,
    device: {
      presence: capacidades.customerDisplay.presence,
      stale: capacidades.customerDisplay.stale,
      capabilitiesObservedAt: capacidades.customerDisplay.observedAt,
      lastHeartbeat: terminal.lastHeartbeat?.toISOString() ?? null,
      designVersion: terminal.customerDisplayDesignVersion,
      ack: terminal.customerDisplayAck,
      installationWarning,
    },
  }
}

/** Re-exportado para quien ya importa el servicio (el MCP): el valor vive en el módulo PURO de validación. */
export { DEVICES_PAGE_MAX }

export interface CustomerDisplayDeviceItem {
  id: string
  name: string
  editToken: string
  designVersion: number | null
  presence: string
  stale: boolean
  capabilitiesObservedAt: string | null
  lastHeartbeat: string | null
}

export interface CustomerDisplayDeviceList {
  total: number
  nextCursor: string | null
  devices: CustomerDisplayDeviceItem[]
}

/**
 * La lista de dispositivos con pantalla del cliente de UN negocio (spec §5.5): paginada, con el total y el `editToken`
 * de cada uno, que es lo que «Copiar a otros dispositivos» necesita.
 *
 * 🔴 Tres cosas que no se negocian (regla «bounded queries»):
 * - el tope se aplica AQUÍ también, no sólo en la forma HTTP: el MCP no pasa por Zod;
 * - el orden es ESTABLE (nombre, id): sin el segundo criterio, dos terminales con el mismo nombre pueden intercambiarse
 *   entre páginas y una se pierde para siempre;
 * - el cursor tiene que ser una terminal de ESTA lista: uno de otro negocio no sirve de punto de partida.
 */
export async function listCustomerDisplayDevices(input: {
  venueId: string
  cursor?: string
  take: number
}): Promise<CustomerDisplayDeviceList> {
  const pedido = Number.isFinite(input.take) ? Math.trunc(input.take) : DEVICES_PAGE_MAX
  const take = Math.min(Math.max(pedido, 1), DEVICES_PAGE_MAX)
  const where = { venueId: input.venueId, type: 'POS_ANDROID' as const }

  if (input.cursor) {
    const valido = await prisma.terminal.findFirst({ where: { ...where, id: input.cursor }, select: { id: true } })
    if (!valido) throw new BadRequestError('El cursor no es válido', 'INVALID_CURSOR')
  }

  const [total, filas] = await Promise.all([
    prisma.terminal.count({ where }),
    prisma.terminal.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      take: take + 1, // uno de más para saber si hay otra página, sin contar dos veces
      select: {
        id: true,
        name: true,
        type: true,
        lastHeartbeat: true,
        customerDisplayDesignVersion: true,
        customerDisplayPresent: true,
        customerDisplayInvertible: true,
        displayModeProtocolVersion: true,
        capabilitiesObservedAt: true,
        customerDisplayDesign: { select: { id: true, revision: true } },
      },
    }),
  ])
  const hayMas = filas.length > take
  const pagina = hayMas ? filas.slice(0, take) : filas
  const ahora = new Date()
  return {
    total,
    nextCursor: hayMas ? pagina[pagina.length - 1].id : null,
    devices: pagina.map(t => {
      // La MISMA regla que el detalle (§5.5): una presencia vieja sale «desconocida», nunca «presente».
      const pantalla = resolveEffectiveDeviceCapabilities(t, { now: ahora }).customerDisplay
      return {
        id: t.id,
        name: t.name,
        editToken: editTokenOf(t.customerDisplayDesign),
        designVersion: t.customerDisplayDesignVersion,
        presence: pantalla.presence,
        stale: pantalla.stale,
        capabilitiesObservedAt: pantalla.observedAt,
        lastHeartbeat: t.lastHeartbeat?.toISOString() ?? null,
      }
    }),
  }
}

/** Traduce el resultado de la validación a la excepción HTTP que le toca. */
export function aplicarValidacion(draft: DesignDraft, actual: DesignValues, entitlements: Entitlements): DesignValues {
  const r = validateDesignDraft(draft, actual, { puedeUsarPromos: entitlements.slides })
  if (r.ok) return r.value
  if (r.code === 'FEATURE_REQUIRES_PRO') throw new ForbiddenError(r.message, r.code)
  throw new BadRequestError(r.message, r.code)
}

export async function previewCustomerDisplay(
  venueId: string,
  terminalId: string,
  draft: DesignDraft,
  previewSeq: number,
): Promise<{ ficha: FichaEfectiva; assetRejected: string[]; previewSeq: number }> {
  const terminal = await loadTerminalForCustomerDisplay(venueId, terminalId)
  const ctx = await readFichaContext(venueId)
  const values = aplicarValidacion(draft, designValuesOf(terminal.customerDisplayDesign), ctx.entitlements)
  const resultado = await armarFicha(terminal, values, ctx)
  // 🔴 El número es el de la PETICIÓN, puesto por el editor: el servidor no lo inventa ni lo reordena.
  return { ...resultado, previewSeq }
}

/**
 * 🔴 La regla de ESCRITURA de los activos (spec §5.2): el logo es un activo `LOGO` del mismo venue y cada slide un
 * activo `SLIDE` del mismo venue. Se corre con el cliente de la transacción, ya con el candado, justo antes de
 * escribir. Un activo de otro negocio y uno inexistente dan el MISMO error: distinguirlos confirmaría que el id
 * existe en otra parte.
 */
export async function assertAssetsUsable(tx: Prisma.TransactionClient, venueId: string, values: DesignValues): Promise<void> {
  revisarActivos(await leerTiposDeActivos(tx, venueId, [values]), values)
}

type TipoDeActivo = 'SLIDE' | 'LOGO'

function activosPedidos(values: DesignValues): { id: string; kind: TipoDeActivo }[] {
  return [
    ...values.slides.map(s => ({ id: s.assetId, kind: 'SLIDE' as const })),
    ...(values.logoAssetId !== null ? [{ id: values.logoAssetId, kind: 'LOGO' as const }] : []),
  ]
}

/**
 * El tipo de cada activo que piden estos diseños, en UNA consulta acotada al venue. Varios diseños a la vez (la copia):
 * con el plan todos los destinos reciben los mismos activos del origen, y sin el plan cada uno trae los suyos; en los
 * dos casos se pregunta una sola vez por el conjunto sin repetidos (≤ 20 destinos × 5 activos).
 */
async function leerTiposDeActivos(
  tx: Prisma.TransactionClient,
  venueId: string,
  disenos: DesignValues[],
): Promise<Map<string, TipoDeActivo>> {
  const ids = [...new Set(disenos.flatMap(d => activosPedidos(d).map(p => p.id)))]
  if (ids.length === 0) return new Map()
  const filas = await tx.customerDisplayAsset.findMany({
    where: { id: { in: ids }, venueId },
    select: { id: true, kind: true },
    take: ids.length,
  })
  return new Map(filas.map(f => [f.id, f.kind]))
}

/** La regla, sin consultar nada. `extra` agrega contexto al error (la copia dice en QUÉ dispositivo está la imagen). */
function revisarActivos(porId: Map<string, TipoDeActivo>, values: DesignValues, extra: Record<string, unknown> = {}): void {
  for (const p of activosPedidos(values)) {
    if (porId.get(p.id) !== p.kind) {
      throw new BadRequestError('Esa imagen no existe en este negocio o no sirve para ese lugar. Vuelve a subirla.', 'ASSET_NOT_USABLE', {
        assetId: p.id,
        ...extra,
      })
    }
  }
}

/**
 * 🔴 Cuánto espera una escritura del diseño el candado de su terminal. Quien lo retiene de verdad —otro guardado, una
 * copia, el gancho `borrarDisenoAlCambiarDeNegocio` (customerDisplayVenueChange.ts)— lo suelta en milisegundos, así que
 * 5 s ya significa «algo se cruzó»: mejor un 409 claro que un editor congelado. Es la espera que usa la confirmación
 * del catálogo (`catalogPublicationConfirmation.service.ts`), la otra escritura con candado que un humano espera frente
 * al dashboard.
 */
export const ESPERA_DEL_CANDADO_MS = 5_000

/**
 * La transacción entera, holgada sobre la espera del candado: así vence PRIMERO el candado —un 55P03 limpio, sin nada
 * escrito— y no la transacción de Prisma a media escritura. Quince segundos y cinco de espera por conexión, como la
 * admisión del cobro remoto (`ADMISSION_TX_TIMEOUT_MS` / `ADMISSION_TX_MAX_WAIT_MS` en `terminal-payment.service.ts`):
 * copiar a 20 dispositivos escribe 20 diseños DESPUÉS de tomar los candados.
 */
const OPCIONES_DE_TRANSACCION = { timeout: 15_000, maxWait: 5_000 } as const

function esperaDelCandadoMs(): number {
  // SÓLO en pruebas (lista blanca, no lista negra): las pruebas la acortan para no esperar el tope real. Staging corre
  // con NODE_ENV=staging (render.yaml) y dev con development; ahí una variable olvidada no puede cambiar cuánto espera un
  // guardado real. Siempre un entero positivo por debajo del tope de la transacción.
  if (process.env.NODE_ENV !== 'test') return ESPERA_DEL_CANDADO_MS
  const n = Number.parseInt(process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < OPCIONES_DE_TRANSACCION.timeout ? n : ESPERA_DEL_CANDADO_MS
}

/**
 * La PRIMERA sentencia de toda transacción de este módulo que toma candados de terminal. La pone cada llamador y nunca
 * `lockTerminalRow`: el gancho `borrarDisenoAlCambiarDeNegocio` (customerDisplayVenueChange.ts) comparte esa función, toma
 * el mismo candado de la terminal y la espera la decide la transacción de su llamador.
 */
async function acotarEsperaDelCandado(tx: Prisma.TransactionClient): Promise<void> {
  // `SET` no acepta parámetros; el valor es un entero que calculamos aquí, no texto de fuera.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${esperaDelCandadoMs()}ms'`)
}

/**
 * 🔴 LA traducción de toda espera vencida del módulo —el candado (55P03), la transacción (P2028) y el interbloqueo
 * (40P01)—: las tres son «otro cambio se cruzó», un 409 con código y nunca un 500 genérico. Pedir que se reintente es
 * seguro: ninguna de las tres deja nada escrito, y si aun así la transacción alcanzó a confirmar, el reintento con el
 * mismo token choca con el CAS en vez de escribir dos veces. Cualquier otro error sale tal cual.
 */
function traducirEspera(error: unknown): never {
  if (esEsperaVencida(error) || esInterbloqueo(error)) {
    throw new ConflictError('Otro cambio se cruzó; vuelve a intentarlo.', 'CUSTOMER_DISPLAY_BUSY')
  }
  throw error
}

/** Qué CAMPOS cambiaron, en el orden del diseño. Nunca sus valores: la bitácora no copia los textos del negocio. */
const CLAVES_DEL_DISENO = Object.keys(FACTORY_DESIGN) as (keyof DesignValues)[]
function clavesCambiadas(antes: DesignValues, despues: DesignValues): string[] {
  return CLAVES_DEL_DISENO.filter(k => JSON.stringify(antes[k]) !== JSON.stringify(despues[k]))
}

function conflicto(actual: { updatedById: string | null } | null): never {
  throw new ConflictError(
    'Alguien más guardó este diseño mientras lo editabas.',
    'CUSTOMER_DISPLAY_CONFLICT',
    actual ? { updatedById: actual.updatedById } : undefined,
  )
}

async function escribirDiseno(
  tx: Prisma.TransactionClient,
  terminalId: string,
  actual: { id: string; revision: number; updatedById: string | null } | null,
  values: DesignValues,
  staffId: string,
): Promise<{ id: string; revision: number }> {
  const data = {
    theme: values.theme,
    accentColor: values.accentColor,
    logoAssetId: values.logoAssetId,
    welcomeText: values.welcomeText,
    thanksText: values.thanksText,
    slides: values.slides as unknown as Prisma.InputJsonValue,
    slideSeconds: values.slideSeconds,
    showPromotions: values.showPromotions,
    updatedById: staffId,
  }

  if (!actual) {
    try {
      const creado = await tx.customerDisplayDesign.create({ data: { terminalId, ...data }, select: { id: true, revision: true } })
      return creado
    } catch (error) {
      // El índice único es el árbitro: dos «primeros guardados» a la vez y sólo uno crea.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') conflicto(null)
      throw error
    }
  }

  // 🔴 El `where` lleva el ID del diseño ADEMÁS de la revisión. Con sólo `terminalId + revision`, un
  // diseño recreado tras un traslado (revisión 1 otra vez) aceptaría un token de antes del traslado.
  const { count } = await tx.customerDisplayDesign.updateMany({
    where: { id: actual.id, terminalId, revision: actual.revision },
    data: { ...data, revision: { increment: 1 } },
  })
  if (count !== 1) conflicto(actual)
  return { id: actual.id, revision: actual.revision + 1 }
}

const DESIGN_SELECT = {
  id: true,
  terminalId: true,
  revision: true,
  updatedById: true,
  theme: true,
  accentColor: true,
  logoAssetId: true,
  welcomeText: true,
  thanksText: true,
  slides: true,
  slideSeconds: true,
  showPromotions: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerDisplayDesignSelect

async function escribirConCandado(
  venueId: string,
  terminalId: string,
  expectedEditToken: string,
  staffId: string,
  entitlements: Entitlements,
  decidir: (actual: DesignValues) => DesignValues,
  accionBitacora: string,
): Promise<{ editToken: string; design: DesignValues }> {
  const resultado = await prisma
    .$transaction(async tx => {
      await acotarEsperaDelCandado(tx)
      const bloqueada = await lockTerminalRow(tx, terminalId)
      // 🔴 Revalidación BAJO el candado. El candado serializa, no reautoriza: sin esta línea, una edición que pasó la
      // autorización antes de un cambio de negocio escribiría después de él. El gancho `borrarDisenoAlCambiarDeNegocio`
      // (customerDisplayVenueChange.ts) toma este mismo candado de la terminal: cuando esta lectura entra, ya se confirmó.
      if (!bloqueada || bloqueada.venueId !== venueId) throw dispositivoNoEncontrado()

      const actualRow = await tx.customerDisplayDesign.findUnique({ where: { terminalId }, select: DESIGN_SELECT })
      if (editTokenOf(actualRow) !== expectedEditToken) conflicto(actualRow)

      const antes = designValuesOf(actualRow)
      const values = decidir(antes)
      await assertAssetsUsable(tx, venueId, values)
      const escrito = await escribirDiseno(tx, terminalId, actualRow, values, staffId)
      return { editToken: editTokenOf(escrito), design: values, changedKeys: clavesCambiadas(antes, values) }
    }, OPCIONES_DE_TRANSACCION)
    .catch(traducirEspera)

  // La caché es de este proceso; se invalida DESPUÉS del commit para no publicar algo que se
  // deshizo. Las demás instancias la vencen solas en 60 s.
  invalidateCustomerDisplayCache(terminalId)

  // Bitácora FUERA de la transacción: que la auditoría falle no puede tumbar un guardado ya confirmado
  // (`logAction` nunca lanza). (El gancho `borrarDisenoAlCambiarDeNegocio` sí escribe la suya dentro de la transacción del
  // cambio de negocio: ahí es parte del movimiento, §5.1.)
  await logAction({
    staffId,
    venueId,
    action: accionBitacora,
    entity: 'CustomerDisplayDesign',
    entityId: terminalId,
    // Copia en objeto literal: una `interface` no tiene firma de índice implícita y no cabe en `InputJsonValue`.
    data: { editToken: resultado.editToken, entitlements: { ...entitlements }, changedKeys: resultado.changedKeys },
  })

  return { editToken: resultado.editToken, design: resultado.design }
}

export async function saveCustomerDisplayDesign(input: {
  venueId: string
  terminalId: string
  draft: DesignDraft
  expectedEditToken: string
  staffId: string
}): Promise<{ editToken: string; design: DesignValues; ficha: FichaEfectiva; assetRejected: string[] }> {
  // Acota y comprueba el tipo ANTES de abrir la transacción: 404 y 422 no necesitan candado.
  const terminal = await loadTerminalForCustomerDisplay(input.venueId, input.terminalId)
  // El plan y el bucket se leen UNA vez: la validación y la ficha que se devuelve usan los mismos.
  const ctx = await readFichaContext(input.venueId)

  const { editToken, design } = await escribirConCandado(
    input.venueId,
    input.terminalId,
    input.expectedEditToken,
    input.staffId,
    ctx.entitlements,
    actual => aplicarValidacion(input.draft, actual, ctx.entitlements),
    'CUSTOMER_DISPLAY_DESIGN_UPDATED',
  )

  const { ficha, assetRejected } = await armarFicha(terminal, design, ctx)
  return { editToken, design, ficha, assetRejected }
}

export async function resetCustomerDisplayDesign(input: {
  venueId: string
  terminalId: string
  expectedEditToken: string
  staffId: string
}): Promise<{ editToken: string; design: DesignValues; ficha: FichaEfectiva }> {
  const terminal = await loadTerminalForCustomerDisplay(input.venueId, input.terminalId)
  const ctx = await readFichaContext(input.venueId)

  // 🔴 Restablecer se puede SIEMPRE, con plan o sin él: es la salida de un venue que bajó de plan.
  // Y NO borra la fila ni reinicia la revisión — es otra escritura más, para que el token siga
  // avanzando y una edición vieja nunca pase por buena.
  const { editToken, design } = await escribirConCandado(
    input.venueId,
    input.terminalId,
    input.expectedEditToken,
    input.staffId,
    ctx.entitlements,
    () => ({ ...FACTORY_DESIGN, slides: [] }),
    'CUSTOMER_DISPLAY_DESIGN_RESET',
  )

  const { ficha } = await armarFicha(terminal, design, ctx)
  return { editToken, design, ficha }
}

/**
 * Copiar el diseño de UN dispositivo a otros del MISMO negocio (spec §5.2), todo o nada.
 *
 * 🔴 Los candados se toman con UNA sentencia ordenada por id (`WHERE id = ANY(…) ORDER BY id FOR UPDATE`) y no uno por
 * terminal: copiar A→B mientras alguien copia B→A tomaría los mismos dos candados en orden contrario, y eso es un
 * interbloqueo. Con el orden fijo, Postgres los toma siempre igual y el interbloqueo desaparece en vez de gestionarse. El
 * único reintento de abajo es el cinturón, no el mecanismo.
 */

type Destino = { terminalId: string; editToken: string }
type FilaDeDiseno = Prisma.CustomerDisplayDesignGetPayload<{ select: typeof DESIGN_SELECT }>

const esDestino = (d: unknown): d is Destino =>
  typeof d === 'object' &&
  d !== null &&
  typeof (d as Destino).terminalId === 'string' &&
  (d as Destino).terminalId !== '' &&
  typeof (d as Destino).editToken === 'string'

/**
 * Lo que se revisa ANTES de tocar nada, idéntico para la copia y su vista previa. El tope de destinos y la forma se
 * deciden aquí, sin consultar la base: una lista hostil de miles no cuesta ni una consulta. Devuelve los ids (origen
 * primero) y los nombres, que la vista previa enseña.
 */
async function validarCopia(
  venueId: string,
  source: Destino,
  targets: Destino[],
): Promise<{ todos: string[]; nombres: Map<string, string> }> {
  if (!esDestino(source)) throw new BadRequestError('El dispositivo de origen no es válido', 'INVALID_SOURCE')
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_COPY_TARGETS || !targets.every(esDestino)) {
    throw new BadRequestError(`Elige entre 1 y ${MAX_COPY_TARGETS} dispositivos`, 'INVALID_TARGETS')
  }
  const ids = targets.map(t => t.terminalId)
  if (new Set(ids).size !== ids.length) throw new BadRequestError('Hay un dispositivo repetido', 'DUPLICATE_TARGET')
  if (ids.includes(source.terminalId)) {
    throw new BadRequestError('El dispositivo de origen no puede ser su propio destino', 'SOURCE_IN_TARGETS')
  }

  // 🔴 Pertenencia y compatibilidad son preguntas DISTINTAS (P3-19): una terminal de otro negocio es 404 —igual que una
  // inexistente—; una PROPIA que no es POS_ANDROID es 422, como al guardar.
  const todos = [source.terminalId, ...ids]
  const encontradas = await prisma.terminal.findMany({
    where: { id: { in: todos }, venueId },
    select: { id: true, type: true, name: true },
    take: todos.length,
  })
  if (encontradas.length !== todos.length) throw dispositivoNoEncontrado()
  if (encontradas.some(t => t.type !== 'POS_ANDROID')) {
    throw new ValidationError('Uno de los dispositivos no tiene pantalla del cliente', 'CUSTOMER_DISPLAY_NOT_SUPPORTED')
  }
  return { todos, nombres: new Map(encontradas.map(t => [t.id, t.name])) }
}

/**
 * Los diseños de las terminales de la copia. Acotado dos veces: por la lista (≤ 21 filas, `terminalId` es único) y por
 * el negocio a través de la terminal, aunque ya se haya revisado: la base no entrega el diseño de una terminal ajena.
 */
async function leerDisenos(cliente: Prisma.TransactionClient, venueId: string, todos: string[]): Promise<Map<string, FilaDeDiseno>> {
  const disenos = await cliente.customerDisplayDesign.findMany({
    where: { terminalId: { in: todos }, terminal: { venueId } },
    select: DESIGN_SELECT,
    take: todos.length,
  })
  return new Map(disenos.map(d => [d.terminalId, d]))
}

/**
 * Qué queda en UN destino. 🔴 Sin plan se copian marca, textos y logo; las imágenes y el interruptor del DESTINO se
 * quedan como estaban: copiar «vacío» encima sería borrarle sus promos a quien sí las tenía.
 */
function valoresCopiados(origen: DesignValues, destino: DesignValues, conSlides: boolean): DesignValues {
  return conSlides
    ? { ...origen, slides: [...origen.slides] }
    : { ...origen, slides: [...destino.slides], showPromotions: destino.showPromotions }
}

/** Los tokens, revisados TODOS antes de escribir nada. Mismo 409 en la copia y en su vista previa. */
function revisarTokens(porTerminal: Map<string, FilaDeDiseno>, source: Destino, targets: Destino[]): void {
  const origen = porTerminal.get(source.terminalId) ?? null
  if (editTokenOf(origen) !== source.editToken) {
    // Se dice que es el ORIGEN: se arregla distinto que un destino (hay que volver a leer lo que se quiere copiar).
    throw new ConflictError('El diseño del dispositivo de origen cambió mientras copiabas.', 'CUSTOMER_DISPLAY_CONFLICT', {
      source: true,
      terminalId: source.terminalId,
      ...(origen ? { updatedById: origen.updatedById } : {}),
    })
  }
  const conflicts = targets.filter(t => editTokenOf(porTerminal.get(t.terminalId) ?? null) !== t.editToken).map(t => t.terminalId)
  if (conflicts.length > 0) {
    throw new ConflictError('Alguien más cambió el diseño de algún dispositivo mientras copiabas.', 'CUSTOMER_DISPLAY_CONFLICT', {
      conflicts,
    })
  }
}

export interface CopyPreview {
  promosOmitted: boolean
  /** El diseño de origen EXACTO que se revisó (el del token que se pidió): el MCP enseña éste, no una relectura. */
  origen: { editToken: string; diseno: DesignValues }
  destinos: { terminalId: string; nombre: string; conservaSusImagenes: boolean; imagenes: number }[]
}

/**
 * La MISMA revisión que la copia, sin escribir ni tomar candados: lo que el MCP enseña antes de confirmar (Codex r8,
 * remanente de P2-9). Comparte con la copia las piezas que deciden el resultado —`validarCopia`, `revisarTokens`,
 * `valoresCopiados` y la regla de activos (`revisarActivos`, la misma de `assertAssetsUsable`)—; la copia las repite
 * con los candados puestos.
 */
export async function previewCopyCustomerDisplay(input: { venueId: string; source: Destino; targets: Destino[] }): Promise<CopyPreview> {
  const { venueId, source, targets } = input
  const { todos, nombres } = await validarCopia(venueId, source, targets)
  const entitlements = await readEntitlements(venueId)
  const porTerminal = await leerDisenos(prisma, venueId, todos)
  revisarTokens(porTerminal, source, targets)

  const valoresOrigen = designValuesOf(porTerminal.get(source.terminalId) ?? null)
  const plan = targets.map(t => ({
    t,
    values: valoresCopiados(valoresOrigen, designValuesOf(porTerminal.get(t.terminalId) ?? null), entitlements.slides),
  }))
  const tipos = await leerTiposDeActivos(
    prisma,
    venueId,
    plan.map(p => p.values),
  )
  const destinos: CopyPreview['destinos'] = []
  for (const { t, values } of plan) {
    revisarActivos(tipos, values, { terminalId: t.terminalId }) // el MISMO 400 que daría la copia, pero ANTES de confirmar
    destinos.push({
      terminalId: t.terminalId,
      nombre: nombres.get(t.terminalId) ?? '',
      conservaSusImagenes: !entitlements.slides,
      imagenes: values.slides.length,
    })
  }
  return { promosOmitted: !entitlements.slides, origen: { editToken: source.editToken, diseno: valoresOrigen }, destinos }
}

export async function copyCustomerDisplayDesign(input: {
  venueId: string
  staffId: string
  source: Destino
  targets: Destino[]
}): Promise<{ copied: string[]; promosOmitted: boolean }> {
  const { venueId, source, targets, staffId } = input
  const { todos } = await validarCopia(venueId, source, targets)
  const entitlements = await readEntitlements(venueId)

  type Escrita = { escritos: { terminalId: string; changedKeys: string[] }[]; promosOmitted: boolean }
  const copiar = (): Promise<Escrita> =>
    prisma.$transaction(async tx => {
      await acotarEsperaDelCandado(tx)
      // 🔴 UNA sentencia, ORDENADA por id: así dos copias cruzadas toman los candados en el mismo orden y el
      // interbloqueo desaparece en vez de gestionarse.
      const bloqueadas = await tx.$queryRaw<{ id: string; venueId: string }[]>`
        SELECT id, "venueId" FROM "Terminal" WHERE id = ANY(${todos}::text[]) ORDER BY id FOR UPDATE
      `
      // Revalidación BAJO el candado: alguna se mudó (o se borró) entre la revisión inicial y aquí.
      if (bloqueadas.length !== todos.length || bloqueadas.some(t => t.venueId !== venueId)) throw dispositivoNoEncontrado()

      const porTerminal = await leerDisenos(tx, venueId, todos)
      // Primero se revisan TODOS los tokens y sólo después se escribe (lo mismo que la vista previa, ya con candados).
      revisarTokens(porTerminal, source, targets)

      const valoresOrigen = designValuesOf(porTerminal.get(source.terminalId) ?? null)
      const plan = targets.map(t => {
        const actual = porTerminal.get(t.terminalId) ?? null
        return {
          t,
          actual,
          antes: designValuesOf(actual),
          values: valoresCopiados(valoresOrigen, designValuesOf(actual), entitlements.slides),
        }
      })
      // Los activos de TODOS los destinos, en una sola consulta dentro de la transacción (con el plan son los mismos).
      const tipos = await leerTiposDeActivos(
        tx,
        venueId,
        plan.map(p => p.values),
      )
      const escritos: { terminalId: string; changedKeys: string[] }[] = []
      for (const { t, actual, antes, values } of plan) {
        // Cada destino se revisa con la regla de ESCRITURA, igual que un guardado, justo antes de SU escritura: un fallo
        // aquí revierte TODO lo ya escrito en esta transacción (P1-5). El error dice en qué dispositivo está la imagen.
        revisarActivos(tipos, values, { terminalId: t.terminalId })
        await escribirDiseno(tx, t.terminalId, actual, values, staffId)
        escritos.push({ terminalId: t.terminalId, changedKeys: clavesCambiadas(antes, values) })
      }

      return { escritos, promosOmitted: !entitlements.slides }
    }, OPCIONES_DE_TRANSACCION)

  // Un solo reintento, y SÓLO ante un interbloqueo (que el orden fijo ya evita). Un candado que venció ya esperó su tope:
  // repetirlo sólo duplicaría la espera del dueño. Todo lo demás pasa por el mismo traductor que guardar.
  let resultado: Escrita
  try {
    resultado = await copiar()
  } catch (error) {
    if (!esInterbloqueo(error)) traducirEspera(error)
    await esperaCortaAleatoria()
    resultado = await copiar().catch(traducirEspera)
  }

  // Después del commit, como al guardar: la caché no publica algo que se deshizo.
  for (const { terminalId } of resultado.escritos) invalidateCustomerDisplayCache(terminalId)
  // UNA entrada por dispositivo ESCRITO (la pantalla de auditoría filtra por dispositivo): quién, desde qué origen y qué
  // CAMPOS cambiaron, nunca sus valores. Acotado por el tope de 20 destinos; en serie para no acaparar el pool.
  for (const { terminalId, changedKeys } of resultado.escritos) {
    await logAction({
      staffId,
      venueId,
      action: 'CUSTOMER_DISPLAY_DESIGN_COPIED',
      entity: 'CustomerDisplayDesign',
      entityId: terminalId,
      data: { sourceTerminalId: source.terminalId, changedKeys },
    })
  }

  return { copied: resultado.escritos.map(e => e.terminalId), promosOmitted: resultado.promosOmitted }
}
