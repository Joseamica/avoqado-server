/**
 * Conector Shopify — función SHOPIFY_INTEGRATION (Premium por regla; Fase 1: piloto por invitación, no se vende).
 *
 * 8 tools, una por ruta del dashboard (C2), con su mismo permiso y candado: estado, «Por revisar», sin pareja y vista
 * previa de la conexión (read); resolver, cuadrar, aplicar y desconectar (WRITE). Las escrituras van en dos pasos con el
 * catálogo (`catalog.ts`): la primera llamada devuelve `requiresConfirmation` y el catálogo firma la operación; la de
 * resolver FIJA las cantidades que se vieron y el servicio responde 409 si ya cambiaron. Leer y desconectar no llevan
 * candado (la pausa se ve y siempre se puede salir); lo demás sí. Conectar no está aquí: el permiso de Shopify sólo se da
 * en el navegador. Nunca devuelven el token de la tienda ni los resultados internos del espejo (`RowOutcome` y compañía).
 *
 * El candado NO es `planGateMessage` (L2): ese texto manda al dueño a «subir de plan», y en la Fase 1 comprar un plan no da
 * Shopify. Se pregunta por la función y, si falta, se dice que es un piloto por invitación.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma, ShopifyIssueReason } from '@prisma/client'
import { z } from 'zod'
import AppError from '@/errors/AppError'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { SHOPIFY_FEATURE } from '@/services/commerce-channels/shopify/shopify.constants'
import {
  getShopifyOverview,
  listShopifyIssues,
  listShopifyReviews,
  type ShopifyEstado,
} from '@/services/commerce-channels/shopify/shopify.overview.service'
import { resolveShopifyReview } from '@/services/commerce-channels/shopify/shopify.reconcile.service'
import {
  disconnectShopify,
  getConnectReview,
  requestApplyShopifyConnect,
  saveConnectChoices,
} from '@/services/commerce-channels/shopify/shopify.connect.service'
import { getShopifyReviewPreview, requestShopifyResync } from '@/services/commerce-channels/shopify/shopify.dashboard.service'
import { connectChoicesBodySchema, listaDeElecciones } from '@/schemas/dashboard/shopify.schema'
import { auditMcpWrite } from '../audit'
import { createGuard } from '../guard'
import { text } from '../respond'
import type { McpScope } from '../scope'

/** L2: ni «plan» ni «Premium» (el conector no se vende en la Fase 1). Una prueba lo fija. */
const SOLO_PILOTO = 'El conector con Shopify está en piloto por invitación y este local no lo tiene activo; escríbenos para sumarte.'
const NO_ACTIVA =
  'La conexión con Shopify de este local no está activa (se está conectando, está en pausa o le falta un permiso), así que no hay nada que cuadrar todavía. El cuadre corre solo cuando vuelva a estar activa; revisa en qué va con shopify_status.'
const NO_CONECTADA = 'Este local no tiene una tienda Shopify conectada.'
/** Qué decir cuando la conexión no está en «por aplicar» (la única fase en que se puede aplicar). */
const NO_LISTA_PARA_APLICAR: Record<ShopifyEstado, string> = {
  IMPORTANDO: 'Todavía se está trayendo el catálogo de Shopify: espera a que termine y revisa el avance con shopify_status.',
  POR_APLICAR: '',
  APLICANDO: 'Ya se pidió aplicar: el stock de Shopify se está aplicando por partes. Revisa el avance con shopify_status.',
  ACTIVA: 'Esta conexión ya está activa: no hay nada que aplicar.',
  PAUSADA: 'La conexión está en pausa: reanúdala o reconéctala desde Integraciones › Shopify en el dashboard antes de aplicar.',
  REVOCADA: 'Shopify quitó el permiso de la app: reconéctala desde Integraciones › Shopify en el dashboard antes de aplicar.',
}
const OFFSET_MAX = 100_000
const FECHAS = 'Respuesta con fechas en UTC, ISO con Z.'

const venueIdField = () =>
  z.string({ required_error: 'Falta el local' }).min(1, 'Falta el local').describe('Local (debe estar en tu alcance)')
const paginaSola = {
  offset: z
    .number()
    .int('El desplazamiento debe ser entero')
    .min(0, 'El desplazamiento mínimo es 0')
    .max(OFFSET_MAX, `El desplazamiento máximo es ${OFFSET_MAX}`)
    .optional(),
  limit: z.number().int('El límite debe ser entero').min(1, 'El límite mínimo es 1').max(50, 'El límite máximo es 50').optional(),
}
const pagina = {
  ...paginaSola,
  q: z.string().max(80, 'La búsqueda es demasiado larga').optional().describe('Busca por nombre o SKU del producto'),
}
const confirmField = () =>
  z
    .boolean({ invalid_type_error: 'confirm va como true o false' })
    .optional()
    .describe('true para aplicar; sin esto sólo muestra el cambio')

const soloPiloto = () => text({ ok: false, planRequired: true, error: SOLO_PILOTO })
const CONEXION_CAMBIO = 'La conexión con Shopify de este local cambió desde la vista previa; pide la vista previa otra vez'
/**
 * P2-4: lo que la confirmación ata. Tienda y ubicación no bastan: desconectar y reconectar la MISMA tienda y ubicación da la
 * misma huella, y un confirm viejo actuaba sobre la conexión nueva (aplicar B sin haber visto su vista previa). El enlace y su
 * generación cambian con cada conexión; el servicio los vuelve a comparar dentro de su escritura.
 */
// D1: también la credencial; reautorizar no cambia la generación y una elección vista con la credencial vieja no debe guardarse.
const huellaDe = (c: { shopDomain: string; locationName: string; linkId: string; generation: number; tokenVersion: number }) =>
  `${c.shopDomain}|${c.locationName}|${c.linkId}|${c.generation}|${c.tokenVersion}`
const huellaField = () =>
  // 1024: la huella lleva el nombre de la ubicación, que no tiene tope en Shopify (con 300 una sucursal con nombre largo no
  // se podía confirmar por MCP).
  z.string().max(1024).optional().describe('La llena la vista previa; no la cambies')

/**
 * D1: los campos de las elecciones salen del MISMO cuerpo que la ruta del dashboard (`connectChoicesBodySchema`, una sola
 * fuente de la forma y de sus mensajes): `todos` tal cual; `expectedElecciones` es su lista con las cantidades vistas (la
 * llena la vista previa); `elecciones`, la misma lista con el renglón recortado al producto y la opción (la pone el modelo).
 * Antes de guardar, el cuerpo completo pasa por `safeParse`: es lo que mantiene «exactamente una de las dos» en un solo lugar.
 */
const CUERPO_ELECCIONES = connectChoicesBodySchema.innerType().shape
const eleccionesField = () =>
  listaDeElecciones(CUERPO_ELECCIONES.elecciones.unwrap().element.pick({ variantLinkId: true, choice: true }))
    .optional()
    .describe('Qué número se queda en cada producto que pide elegir (requiereDecision en shopify_connect_preview), por variantLinkId')
const firmaDe = (xs: Array<{ variantLinkId: string; choice: string }>) =>
  xs
    .map(x => `${x.variantLinkId}:${x.choice}`)
    .sort()
    .join(',')
/** «actual → nuevo» de un producto con una elección (L18). */
const cambioDe = (f: { avoqadoQty: string; shopifyQty: number | null; quedara: string | null }, choice: 'AVOQADO' | 'SHOPIFY') =>
  choice === 'AVOQADO'
    ? `Shopify ${f.shopifyQty} → ${f.avoqadoQty} (Avoqado se queda en ${f.avoqadoQty})`
    : `Avoqado ${f.avoqadoQty} → ${f.quedara}`
const VUELVE_A_VER = 'Algún producto ya no pide elegir o sus números cambiaron: pide shopify_connect_preview otra vez'

/** Candado de las escrituras: la función (no el plan). null = adelante. */
async function sinConector(venueId: string) {
  return (await venueHasFeatureAccess(venueId, SHOPIFY_FEATURE)) ? null : soloPiloto()
}

/**
 * Un rechazo de negocio de Shopify (código `SHOPIFY_*`) vuelve como `ok:false` con su texto en español, para que el modelo lo
 * lea y decida en vez de reintentar a ciegas; cualquier otro error se lanza igual que siempre (L18).
 */
function rechazo(err: unknown) {
  if (!(err instanceof AppError) || !err.code?.startsWith('SHOPIFY_')) throw err
  if (err.code === 'SHOPIFY_REVISION_CAMBIO') {
    return text({ ok: false, needsInput: true, question: 'Las cantidades cambiaron; pide la vista previa otra vez' })
  }
  // L2: el MCP dice su propio texto de piloto (el servicio ya no habla de «plan» ni de «actívalo» desde M2, y aun así el
  // código manda: un mensaje de servicio nunca sale tal cual con este código).
  if (err.code === 'SHOPIFY_SIN_PLAN') return soloPiloto()
  if (err.code === 'SHOPIFY_CONEXION_CAMBIO') return text({ ok: false, needsInput: true, question: CONEXION_CAMBIO })
  return text({ ok: false, codigo: err.code, error: err.code === 'SHOPIFY_NO_ACTIVA' ? NO_ACTIVA : err.message })
}

export function registerShopifyTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'shopify_status',
    `Estado del conector con Shopify del local: tienda y ubicación ligadas, en qué va (trayendo catálogo, lista para revisar, aplicando, activa, pausada o sin permiso de Shopify), productos emparejados, cambios en camino, atorados o sin confirmar, retraso y el cuadre (si hay uno en curso y cuándo fue el último). Un local que perdió el acceso ve la pausa. ${FECHAS}`,
    { venueId: venueIdField() },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      return text({ ok: true, venueId, ...(await getShopifyOverview(venueId)) })
    },
  )

  server.tool(
    'shopify_review_list',
    `Productos cuyo stock no cuadra entre Avoqado y Shopify y que el cuadre no pudo explicar («Por revisar»): las dos cantidades, el motivo y cuál se sugiere usar (primeraVez: el producto ya existía en Avoqado y acaba de aparecer en Shopify con el mismo SKU, no que se volvió a emparejar); también las elecciones ya hechas cuyo envío a Shopify sigue en camino, se atoró o acaba de llegar. Paginado (máximo 50) y con búsqueda por nombre o SKU. ${FECHAS}`,
    { venueId: venueIdField(), ...pagina },
    async ({ venueId, offset, limit, q }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      return text({ ok: true, venueId, ...(await listShopifyReviews(venueId, { offset: offset ?? 0, limit: limit ?? 20, q })) })
    },
  )

  server.tool(
    'shopify_unmatched_list',
    `Variantes de Shopify que no se pudieron ligar a un producto del local («Productos sin pareja») y parejas suspendidas, cada una con su motivo (sin SKU, SKU repetido, se mide en otra unidad, sin precio en pesos, sin stock en la ubicación…). Paginado (máximo 50), con búsqueda y filtro por motivo. ${FECHAS}`,
    {
      venueId: venueIdField(),
      ...pagina,
      reason: z.nativeEnum(ShopifyIssueReason, { errorMap: () => ({ message: 'Motivo no reconocido' }) }).optional(),
    },
    async ({ venueId, offset, limit, q, reason }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      return text({ ok: true, venueId, ...(await listShopifyIssues(venueId, { offset: offset ?? 0, limit: limit ?? 20, q, reason })) })
    },
  )

  server.tool(
    'shopify_connect_preview',
    'Vista previa de una conexión con Shopify que ya trajo su catálogo y espera aplicarse («así quedará tu stock»): por producto, lo que tiene Avoqado hoy, lo que tenía Shopify al importar, cómo quedará si se usa el número de Shopify (quedara: lo de Shopify al importar con lo que la caja cambió mientras se conectaba), si hay que elegir (requiereDecision: el producto ya existía en Avoqado y su número no coincide) y la elección guardada (eleccion, AVOQADO o SHOPIFY; vacía si falta), y el resumen (emparejados, cambian, nuevos, sin pareja y porDecidir: cuántos faltan por elegir en todas las páginas). Paginado (máximo 50), con filtro CAMBIAN, NUEVOS o TODOS; los que piden elegir están en CAMBIAN. Sólo lee.',
    {
      venueId: venueIdField(),
      ...paginaSola,
      filtro: z
        .enum(['CAMBIAN', 'NUEVOS', 'TODOS'], { errorMap: () => ({ message: 'El filtro debe ser CAMBIAN, NUEVOS o TODOS' }) })
        .optional(),
    },
    async ({ venueId, offset, limit, filtro }) => {
      guard.venueFilter(venueId)
      // Mismo permiso que la ruta (settings:manage), como LECTURA: no exige el scope de escritura.
      guard.requirePermission('settings:manage', venueId, 'read')
      return text({
        ok: true,
        venueId,
        ...(await getConnectReview({ venueId, offset: offset ?? 0, limit: limit ?? 20, filtro: filtro ?? 'CAMBIAN' })),
      })
    },
  )

  server.tool(
    'shopify_review_resolve',
    'Resuelve una diferencia de «Por revisar» eligiendo el número de Avoqado o el de Shopify. Primero muestra las dos cantidades y en qué quedará (si elige AVOQADO y la diferencia no es de piezas enteras, lo dice y no se puede aplicar); se aplica al llamar de nuevo con confirm:true y los argumentos de la vista previa. Si las cantidades cambiaron mientras tanto, no aplica y pide revisar otra vez. Requiere ajustar inventario y acceso al conector con Shopify.',
    {
      venueId: venueIdField(),
      reviewId: z
        .string({ required_error: 'Falta la diferencia' })
        .min(1, 'Falta la diferencia')
        .describe('Diferencia (de shopify_review_list)'),
      choice: z.enum(['AVOQADO', 'SHOPIFY'], { errorMap: () => ({ message: 'Elige AVOQADO o SHOPIFY' }) }),
      expectedAvoqadoQty: z
        .string()
        .regex(/^-?\d{1,9}(\.\d{1,3})?$/, 'Cantidad de Avoqado no válida')
        .optional()
        .describe('La llena la vista previa; no la cambies'),
      expectedShopifyQty: z.number().int('Cantidad de Shopify no válida').optional().describe('La llena la vista previa; no la cambies'),
      confirm: confirmField(),
    },
    async ({ venueId, reviewId, choice, expectedAvoqadoQty, expectedShopifyQty, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:adjust', venueId)
      const sin = await sinConector(venueId)
      if (sin) return sin
      try {
        if (confirm !== true || expectedAvoqadoQty === undefined || expectedShopifyQty === undefined) {
          const v = await getShopifyReviewPreview(venueId, reviewId)
          const quedara = choice === 'SHOPIFY' ? String(v.shopifyQty) : v.avoqadoQty
          const diferencia = new Prisma.Decimal(v.avoqadoQty).minus(v.shopifyQty)
          // Lo mismo que el 422 del servicio al confirmar, dicho de entrada y sin token: a Shopify sólo viajan piezas enteras.
          if (choice === 'AVOQADO' && !diferencia.isInteger()) {
            return text({
              ok: false,
              codigo: 'SHOPIFY_DIFERENCIA_NO_ENTERA',
              error: `La diferencia (Avoqado ${v.avoqadoQty} − Shopify ${v.shopifyQty} = ${diferencia}) no es de piezas enteras y no se puede enviar a Shopify. Corrige el stock de Avoqado a piezas enteras y pide la vista previa otra vez, o elige SHOPIFY.`,
            })
          }
          return text({
            ok: false,
            requiresConfirmation: true,
            venueId,
            reviewId,
            choice,
            producto: v.producto,
            sku: v.sku,
            avoqado: v.avoqadoQty,
            shopify: v.shopifyQty,
            sugerencia: v.suggestion,
            quedara,
            // L18: qué número se mueve y cuánto, con las cantidades reales de la vista previa.
            cambio:
              choice === 'SHOPIFY'
                ? `Avoqado ${v.avoqadoQty} → ${v.shopifyQty}`
                : `Shopify ${v.shopifyQty} → ${v.avoqadoQty}, se envía ${diferencia}`,
            // El catálogo fija estos dos en la confirmación (catalog.ts): si alguien los cambia, el token deja de servir.
            expectedAvoqadoQty: v.avoqadoQty,
            expectedShopifyQty: v.shopifyQty,
            explicacion:
              choice === 'SHOPIFY'
                ? `Avoqado quedará en ${quedara}, lo que dice Shopify.`
                : `Se mandará a Shopify la diferencia para que quede en ${quedara}, lo que dice Avoqado. El envío tarda unos segundos.`,
          })
        }
        const r = await resolveShopifyReview({ venueId, reviewId, choice, expectedAvoqadoQty, expectedShopifyQty, staffId: scope.staffId })
        await auditMcpWrite(scope, {
          action: 'MCP_SHOPIFY_REVIEW_RESOLVED',
          entity: 'ShopifyReviewItem',
          entityId: reviewId,
          venueId,
          data: { choice, expectedAvoqadoQty, expectedShopifyQty, estado: r.estado },
        })
        return text({
          ok: true,
          reviewId,
          eleccion: choice,
          estado: r.estado,
          mensaje:
            r.estado === 'ENVIO_PENDIENTE'
              ? 'Elección guardada; se enviará a Shopify en unos segundos.'
              : 'Listo: quedó igual en los dos lados.',
        })
      } catch (e) {
        return rechazo(e)
      }
    },
  )

  server.tool(
    'shopify_resync',
    'Pide un cuadre de stock con Shopify para el local. El pedido queda guardado y el cuadre corre cuando la conexión es elegible (acceso al conector activo, tienda activa y sin un error terminal como falta de permiso o catálogo maestro); entonces se comparan los dos lados, lo que cambió en Shopify se aplica en Avoqado y lo que nadie explica queda en «Por revisar». No borra nada. Primero explica qué hará; se pide al llamar de nuevo con confirm:true. Requiere administrar la configuración y acceso al conector con Shopify.',
    { venueId: venueIdField(), confirm: confirmField() },
    async ({ venueId, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('settings:manage', venueId)
      const sin = await sinConector(venueId)
      if (sin) return sin
      if (confirm !== true) {
        return text({
          ok: false,
          requiresConfirmation: true,
          venueId,
          explicacion:
            'El pedido de cuadre queda guardado y corre cuando la conexión es elegible (acceso al conector activo, tienda activa y sin un error terminal como falta de permiso o catálogo maestro): no necesariamente en el siguiente minuto. Entonces se comparará el stock de cada producto ligado con Shopify; lo que cambió en Shopify se aplica en Avoqado y lo que no se pueda explicar queda en «Por revisar». No borra nada.',
        })
      }
      try {
        const r = await requestShopifyResync({ venueId, staffId: scope.staffId })
        await auditMcpWrite(scope, { action: 'MCP_SHOPIFY_RESYNC', entity: 'Venue', entityId: venueId, venueId, data: {} })
        return text({ ok: true, venueId, ...r })
      } catch (e) {
        return rechazo(e)
      }
    },
  )

  server.tool(
    'shopify_connect_apply',
    'Aplica una conexión con Shopify que ya está lista para revisar y empieza a sincronizar. Los productos nuevos y los que ya coinciden toman el número que tenga Shopify al aplicarse; en los que ya existían en Avoqado con otro número hay que elegir, sin preselección: en elecciones, por producto, AVOQADO (se queda el número de Avoqado y se manda a Shopify la diferencia) o SHOPIFY (Avoqado toma el de Shopify con lo vendido mientras se conectaba), máximo 50 por llamada; o en todos, la misma opción para todos los que faltan en todas las páginas. No se aplica mientras falte alguno (porDecidir en shopify_connect_preview). Primero muestra los cambios (actual → nuevo) y cuántos faltan; se guarda y se aplica al llamar de nuevo con confirm:true y los argumentos de la vista previa. Si un número cambió mientras tanto, pide revisar otra vez. Requiere administrar la configuración y acceso al conector con Shopify.',
    {
      venueId: venueIdField(),
      elecciones: eleccionesField(),
      todos: CUERPO_ELECCIONES.todos.describe('La misma opción para TODOS los productos que faltan por elegir, en todas las páginas'),
      expectedElecciones: CUERPO_ELECCIONES.elecciones.describe('La llena la vista previa; no la cambies'),
      expectedSourceFingerprint: huellaField(),
      confirm: confirmField(),
    },
    async ({ venueId, elecciones, todos, expectedElecciones, expectedSourceFingerprint, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('settings:manage', venueId)
      const sin = await sinConector(venueId)
      if (sin) return sin
      const pedidas = elecciones ?? []
      if (pedidas.length > 0 && todos) {
        return text({
          ok: false,
          needsInput: true,
          question: 'Usa elecciones (por producto) o todos (una opción para los que faltan), no los dos.',
        })
      }
      if (new Set(pedidas.map(x => x.variantLinkId)).size !== pedidas.length) {
        return text({ ok: false, needsInput: true, question: 'Un producto viene dos veces en elecciones: manda cada uno una sola vez.' })
      }
      try {
        const { connection } = await getShopifyOverview(venueId)
        if (!connection) return text({ ok: false, error: NO_CONECTADA })
        if (confirm !== true || expectedSourceFingerprint === undefined || (pedidas.length > 0 && expectedElecciones === undefined)) {
          if (connection.estado !== 'POR_APLICAR')
            return text({ ok: false, estado: connection.estado, error: NO_LISTA_PARA_APLICAR[connection.estado] })
          const comun = {
            ok: false,
            requiresConfirmation: true,
            venueId,
            // P2-4 + D1: el catálogo fija esta huella (con la credencial): si la conexión cambia, el confirm no guarda ni aplica.
            expectedSourceFingerprint: huellaDe(connection),
          }
          if (pedidas.length > 0) {
            const v = await getConnectReview({ venueId, offset: 0, limit: 50, filtro: 'TODOS', ids: pedidas.map(x => x.variantLinkId) })
            const filas = pedidas.map(x => ({ x, f: v.items.find(i => i.variantLinkId === x.variantLinkId) }))
            if (filas.some(({ f }) => !f?.requiereDecision || f.shopifyQty === null || f.quedara === null)) {
              return text({ ok: false, needsInput: true, question: VUELVE_A_VER })
            }
            const noEntera = filas.find(
              ({ x, f }) => x.choice === 'AVOQADO' && !new Prisma.Decimal(f!.avoqadoQty).minus(f!.quedara!).isInteger(),
            )
            if (noEntera) {
              return text({
                ok: false,
                codigo: 'SHOPIFY_DIFERENCIA_NO_ENTERA',
                error: `${noEntera.f!.name}: la diferencia con Shopify no es de piezas enteras (Avoqado ${noEntera.f!.avoqadoQty}), así que no se puede enviar a Shopify. Corrige su stock a piezas enteras o elige SHOPIFY.`,
              })
            }
            // El resumen es GLOBAL: lo que falta después = lo que falta hoy menos las que esta llamada elige por primera vez.
            const faltan = Math.max(0, (v.resumen.porDecidir ?? 0) - filas.filter(({ f }) => !f!.eleccion).length)
            return text({
              ...comun,
              resumen: v.resumen,
              cambios: filas.map(({ x, f }) => ({
                producto: f!.name,
                sku: f!.sku,
                eleccion: x.choice,
                avoqado: f!.avoqadoQty,
                shopify: f!.shopifyQty,
                cambio: cambioDe(f!, x.choice),
              })),
              faltanPorDecidir: faltan,
              // El catálogo fija estas cantidades en la confirmación (catalog.ts): si cambian, el token deja de servir.
              expectedElecciones: filas.map(({ x, f }) => ({
                variantLinkId: x.variantLinkId,
                choice: x.choice,
                expectedAvoqadoQty: f!.avoqadoQty,
                expectedShopifyQty: f!.shopifyQty!,
              })),
              explicacion:
                faltan > 0
                  ? `Se guardarán ${pedidas.length} elecciones, pero todavía faltarán ${faltan} productos por decidir, así que NO se aplicará: pide shopify_connect_preview (filtro CAMBIAN) y vuelve con las que faltan, o usa todos.`
                  : 'Se guardarán las elecciones y se aplicará: los productos nuevos y los que no piden elegir toman el número que tenga Shopify al aplicarse; en los elegidos se queda la elección. Las ventas hechas mientras se conectaba se respetan. Si un número elegido cambia antes de aplicarse, la conexión regresa a la vista previa para volver a elegir.',
            })
          }
          const v = await getConnectReview({ venueId, offset: 0, limit: todos ? 50 : 1, filtro: 'CAMBIAN' })
          const porDecidir = v.resumen.porDecidir ?? 0
          if (todos && porDecidir > 0) {
            const ejemplos = v.items.filter(i => i.requiereDecision && !i.eleccion).slice(0, 10)
            return text({
              ...comun,
              todos,
              resumen: v.resumen,
              faltanPorDecidir: porDecidir,
              cambios: ejemplos.map(f => ({
                producto: f.name,
                sku: f.sku,
                avoqado: f.avoqadoQty,
                shopify: f.shopifyQty,
                cambio: cambioDe(f, todos),
              })),
              explicacion: `Se elegirá ${todos} en los ${porDecidir} productos que faltan (todas las páginas; los ya elegidos se quedan) y se aplicará. Arriba, hasta 10 ejemplos.${todos === 'AVOQADO' ? ' Los que tengan decimales en Avoqado se quedan por elegir y entonces no se aplicará todavía.' : ''}`,
            })
          }
          if (porDecidir > 0) {
            return text({
              ok: false,
              needsInput: true,
              faltanPorDecidir: porDecidir,
              question: `Faltan ${porDecidir} productos por decidir (requiereDecision en shopify_connect_preview, filtro CAMBIAN). Pregúntale al usuario, uno por uno o para todos, si se queda el número de Avoqado o el de Shopify, y pásalo en elecciones o en todos.`,
            })
          }
          return text({
            ...comun,
            resumen: v.resumen,
            // Aquí ya no falta nada por elegir: con «todos» se firma igual (no cambia nada), pero se dice con todas sus letras.
            explicacion:
              (todos ? 'No falta ningún producto por elegir; «todos» no cambia nada. ' : '') +
              'Cada producto emparejado tomará el número que tenga Shopify al aplicarse (puede no ser el de la vista previa si alguien vende mientras tanto). Las ventas hechas mientras se conectaba se respetan. Después, cada venta, devolución o pedido en línea se refleja en los dos lados.',
          })
        }
        if (huellaDe(connection) !== expectedSourceFingerprint) return text({ ok: false, needsInput: true, question: CONEXION_CAMBIO })
        if (pedidas.length > 0 || todos) {
          if (pedidas.length > 0 && firmaDe(pedidas) !== firmaDe(expectedElecciones ?? [])) {
            return text({ ok: false, needsInput: true, question: VUELVE_A_VER })
          }
          const vista = { linkId: connection.linkId, generation: connection.generation, tokenVersion: connection.tokenVersion }
          // La forma (y «exactamente una de las dos») es la del cuerpo de la ruta: nunca se guarda sin pasar por ella.
          const cuerpo = connectChoicesBodySchema.safeParse(todos ? { vista, todos } : { vista, elecciones: expectedElecciones })
          if (!cuerpo.success) {
            return text({ ok: false, needsInput: true, question: cuerpo.error.issues[0]?.message ?? VUELVE_A_VER })
          }
          const g = await saveConnectChoices({ venueId, staffId: scope.staffId, ...cuerpo.data })
          // Como el servicio: un «en todos» que no encontró a nadie no cambió nada, y un no-op no se audita.
          if (g.guardadas > 0) {
            await auditMcpWrite(scope, {
              action: 'MCP_SHOPIFY_CONNECT_CHOICES_SAVED',
              entity: 'Venue',
              entityId: venueId,
              venueId,
              data: { guardadas: g.guardadas, porDecidir: g.porDecidir, ...(todos ? { todos } : {}) },
            })
          }
          if (g.porDecidir > 0) {
            return text({
              ok: true,
              venueId,
              guardadas: g.guardadas,
              aplicado: false,
              faltanPorDecidir: g.porDecidir,
              mensaje: `Elecciones guardadas. Todavía faltan ${g.porDecidir} productos por decidir: revísalos con shopify_connect_preview y vuelve a llamar con sus elecciones.`,
            })
          }
        }
        await requestApplyShopifyConnect({
          venueId,
          staffId: scope.staffId,
          expected: { linkId: connection.linkId, generation: connection.generation },
        })
        await auditMcpWrite(scope, { action: 'MCP_SHOPIFY_CONNECT_APPLIED', entity: 'Venue', entityId: venueId, venueId, data: {} })
        return text({ ok: true, venueId, solicitado: true, mensaje: 'Aplicando: el stock se aplica por partes en los próximos minutos.' })
      } catch (e) {
        return rechazo(e)
      }
    },
  )

  server.tool(
    'shopify_disconnect',
    'Desconecta la tienda Shopify del local: Avoqado sigue vendiendo normal, pero el stock deja de actualizarse en los dos lados; los cambios que no alcanzaron a salir se descartan (un envío que ya iba en camino termina solo) y las diferencias abiertas de «Por revisar» se cierran. No requiere acceso al conector: quien lo perdió siempre puede salir. Primero muestra qué se desconecta; se aplica al llamar de nuevo con confirm:true. Requiere administrar la configuración.',
    { venueId: venueIdField(), expectedSourceFingerprint: huellaField(), confirm: confirmField() },
    async ({ venueId, expectedSourceFingerprint, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('settings:manage', venueId)
      try {
        const { connection } = await getShopifyOverview(venueId)
        if (!connection) return text({ ok: false, error: NO_CONECTADA })
        // La confirmación queda atada a la tienda, la ubicación, el enlace y la generación que se VIERON (P2-4: el catálogo
        // fija esta huella en el token, y el servicio vuelve a comparar enlace y generación bajo el candado de la sucursal).
        const huella = huellaDe(connection)
        if (confirm !== true || expectedSourceFingerprint === undefined) {
          return text({
            ok: false,
            requiresConfirmation: true,
            venueId,
            tienda: connection.shopDomain,
            ubicacion: connection.locationName,
            cambiosEnCamino: connection.conteos.pendientes,
            porRevisar: connection.conteos.porRevisar,
            expectedSourceFingerprint: huella,
            explicacion:
              'Avoqado seguirá vendiendo normal; el stock deja de sincronizarse con Shopify. Los cambios que no alcanzaron a salir se descartan, y las diferencias que sigan abiertas en «Por revisar» se cierran sin cambiar el stock de ningún producto.',
          })
        }
        if (huella !== expectedSourceFingerprint) return text({ ok: false, needsInput: true, question: CONEXION_CAMBIO })
        const r = await disconnectShopify({
          venueId,
          staffId: scope.staffId,
          expected: { linkId: connection.linkId, generation: connection.generation },
        })
        // Si otra persona se adelantó no hubo cambio: no se audita un hecho que no ocurrió.
        if (r.desconectada) {
          await auditMcpWrite(scope, { action: 'MCP_SHOPIFY_DISCONNECTED', entity: 'Venue', entityId: venueId, venueId, data: {} })
        }
        return text({ ok: true, venueId, desconectada: r.desconectada })
      } catch (e) {
        return rechazo(e)
      }
    },
  )
}
