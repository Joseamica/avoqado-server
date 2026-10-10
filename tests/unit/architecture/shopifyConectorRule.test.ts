/**
 * La regla `.claude/rules/shopify-conector.md` es lo que lee la siguiente sesión antes de tocar stock. Si se desalinea de lo
 * ENTREGADO (índice v2 §9-§12 y el código real), alguien «arregla» un estado correcto —una venta con su delta en DEAD_LETTER,
 * un envío en camino— o reintroduce un orden de candados que se traba, y pierde ventas.
 *
 * Esta prueba fija dos cosas: (1) el TEXTO de la regla, literal, en lo que no puede faltar ni quedar con la versión vieja del
 * plan; (2) el CÓDIGO que respalda las afirmaciones clave de comportamiento, para que un cambio en el código sin cambiar la
 * regla también falle aquí. Y que cada función que la regla nombra con paréntesis exista exportada.
 *
 * Prettier re-envuelve la prosa a 140 columnas (`proseWrap: always`): el texto se compara con los espacios colapsados.
 */
import fs from 'fs'
import path from 'path'

const RAIZ = path.join(__dirname, '../../..')
const leer = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), 'utf8')
const regla = leer('.claude/rules/shopify-conector.md').replace(/\s+/g, ' ')
const SHOPIFY = 'src/services/commerce-channels/shopify'
const archivosShopify = fs
  .readdirSync(path.join(RAIZ, SHOPIFY))
  .filter(f => f.endsWith('.ts'))
  .map(f => `${SHOPIFY}/${f}`)
// Los archivos compartidos cuyas funciones nombra la regla (B7, la guarda de «no se vende suelta» y la lectura del conteo, L5)
// también cuentan.
const codigo = [
  ...archivosShopify,
  'src/services/mobile/inventory.mobile.service.ts',
  'src/services/dashboard/productWizard.service.ts',
  'src/services/dashboard/productInventoryIntegration.service.ts',
  'src/services/dashboard/venueFeature.dashboard.service.ts',
  'src/services/stripe.service.ts',
]
  .map(leer)
  .join('\n')
const contieneTodas = (frases: string[]) => frases.forEach(f => expect(regla).toContain(f))

/** Desde la declaración hasta la siguiente de primer nivel: el cuerpo de UNA función. */
function cuerpo(src: string, decl: string): string {
  const i = src.indexOf(decl)
  expect(i).toBeGreaterThanOrEqual(0)
  const resto = src.slice(i + decl.length)
  const fin = resto.search(/\n(export |const |async function |function |type )/)
  return fin === -1 ? resto : resto.slice(0, fin)
}
/** Cada texto aparece en el orden dado (y todos aparecen); si no, el mensaje dice cuál y dónde. */
function enOrden(src: string, textos: string[]) {
  const posiciones = textos.map(t => src.indexOf(t))
  expect(textos.filter((_t, i) => posiciones[i] < 0)).toEqual([]) // los que faltan
  const esperado = [...posiciones].sort((a, b) => a - b)
  expect(textos.map((t, i) => `${posiciones[i]} ${t}`)).toEqual(textos.map(t => `${esperado[textos.indexOf(t)]} ${t}`))
}

/**
 * Glob mínimo (`**`, `*`) a RegExp. Se escribe aquí porque package.json no declara ninguna librería de globs (fast-glob, glob y
 * minimatch sólo están como dependencias de otras) y Node 20, el del CI, no trae `fs.globSync`.
 * `a/**` casa lo que hay DENTRO de `a/`; `a/**\/b` casa `a/b` y `a/x/y/b`; `*` no cruza `/`.
 */
function globARegExp(g: string): RegExp {
  let re = ''
  for (let i = 0; i < g.length; ) {
    if (g.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
    } else if (g.startsWith('/**', i) && i + 3 === g.length) {
      re += '/.+'
      i += 3
    } else if (g.startsWith('**', i)) {
      re += '.*'
      i += 2
    } else if (g[i] === '*') {
      re += '[^/]*'
      i += 1
    } else {
      re += g[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }
  return new RegExp(`^${re}$`)
}
/** Todos los archivos bajo esas carpetas, como rutas relativas a la raíz del repo con `/`. */
function archivosBajo(carpetas: string[]): string[] {
  const salida: string[] = []
  const recorre = (rel: string) => {
    for (const e of fs.readdirSync(path.join(RAIZ, rel), { withFileTypes: true })) {
      const hijo = `${rel}/${e.name}`
      if (e.isDirectory()) recorre(hijo)
      else salida.push(hijo)
    }
  }
  carpetas.forEach(recorre)
  return salida
}

describe('regla del conector Shopify (índice v2 §9-§12, lo entregado)', () => {
  it('🔴 trae el invariante operativo de §9.3, literal', () => {
    expect(regla).toContain('`Inventory = espejo + Σ vivas + Σ DEAD_LETTER sin resolver + offset de la revisión OPEN`')
  })

  it('🔴 trae el orden de candados de §10.3 (Product primero, el evento al final), literal y una sola vez', () => {
    expect(regla).toContain(
      'Product (si se toca) → sucursal (`FOR SHARE`) → tienda (`FOR SHARE`) → pareja (`FOR UPDATE`) → `Inventory` → buzón/revisión → evento (`FOR SHARE`, al final)',
    )
    expect(regla.match(/→ tienda \(`FOR SHARE`\) →/g)).toHaveLength(1)
    // El orden viejo (§9.11, sin Product) no puede quedar como otra regla en el mismo archivo.
    expect(regla).not.toMatch(/§9\.11/)
    contieneTodas([
      'Product se bloquea `FOR NO KEY UPDATE`',
      'sin frenar el `FOR KEY SHARE` de una venta que inserta un renglón con llave foránea al producto',
      'Catálogo y archivo lo piden explícito',
      '`switchInventoryMethod(…)` y `setProductInventoryMethod(…)` lo toman con el `product.update` que ya hacen',
    ])
  })

  it('🔴 el mensajero toma el orden general (con o sin cerco); la versión del plan («sólo pareja → buzón») ya no vale', () => {
    contieneTodas([
      ', con o sin cerco, toma el orden general sin Product: sucursal y tienda `FOR SHARE`, pareja `FOR UPDATE`, la fila del buzón `FOR UPDATE`',
      'Nunca la fila primero, ni con `SKIP LOCKED`',
      'se protegen con el `claimToken` de la fila',
      'Un 401 sólo revoca la tienda si el token sigue siendo el vigente',
    ])
    expect(regla).not.toContain('El mensajero sólo toma')
    expect(regla).not.toContain('El mensajero sin cerco: pareja → buzón')
    expect(regla).not.toContain('Con cerco: sucursal → tienda → pareja → buzón → evento (al final)')
  })

  it('🔴 marcarFaltaPermiso: FOR NO KEY UPDATE y SÓLO la sucursal dada; desconectar bloquea las de la tienda por id antes que las parejas', () => {
    contieneTodas([
      'bloquea `FOR NO KEY UPDATE` SÓLO la sucursal que recibe (`locationLinkId`; sin ella, las de la tienda, por id) y después la tienda `FOR SHARE`',
      'bloquea primero TODAS las sucursales de la tienda por id (la propia `FOR UPDATE`, las hermanas `FOR NO KEY UPDATE`), después las parejas de ESA sucursal, ordenadas por id, y sólo entonces sube la generación',
      '`renovarCredencial` (reconectar o reautorizar) también bloquea todas las sucursales de la tienda por id ANTES de la tienda',
    ])
    expect(regla).not.toContain('las sucursales de la tienda `FOR UPDATE`, por id')
    expect(regla).not.toContain('Desconectar bloquea las parejas del enlace')

    // El código que lo respalda.
    const mirror = leer(`${SHOPIFY}/shopify.mirror.service.ts`)
    const falta = cuerpo(mirror, 'export async function marcarFaltaPermiso(')
    expect(falta).toContain('FOR NO KEY UPDATE')
    expect(falta).not.toMatch(/FOR UPDATE/)
    expect(falta).toContain('WHERE id = ${o.locationLinkId}')
    expect(falta).toContain('FOR SHARE')
    const conexion = leer(`${SHOPIFY}/shopify.connect.service.ts`)
    const desconectar = cuerpo(conexion, 'export async function disconnectShopify(')
    enOrden(desconectar, [
      'AND id < ${yo.id} ORDER BY id LIMIT 1000 FOR NO KEY UPDATE',
      'WHERE id = ${yo.id} FOR UPDATE',
      'AND id > ${yo.id} ORDER BY id LIMIT 1000 FOR NO KEY UPDATE',
      'FROM "ShopifyVariantLink" WHERE "locationLinkId" = ${l.id} ORDER BY id FOR UPDATE',
      'generation: { increment: 1 }',
    ])
    const renovar = cuerpo(conexion, 'async function renovarCredencial(')
    enOrden(renovar, ['ORDER BY id LIMIT 1000 FOR NO KEY UPDATE', 'tx.shopifyStore.update('])
  })

  it('🔴 Product se bloquea FOR NO KEY UPDATE antes de la sucursal (K11) y el mensajero respeta el orden general', () => {
    const catalogo = leer(`${SHOPIFY}/shopify.catalog.service.ts`)
    expect(cuerpo(catalogo, 'async function bloquearProductos(')).toContain('ORDER BY id FOR NO KEY UPDATE')
    const archivar = cuerpo(catalogo, 'export async function archivarPareja(')
    enOrden(archivar, [
      'FROM "Product" WHERE id = ${p.productId} FOR NO KEY UPDATE',
      'exigirCerco(tx',
      'bloquearPareja(tx',
      'verificarEvento(tx',
    ])

    const wizard = leer('src/services/dashboard/productWizard.service.ts')
    enOrden(cuerpo(wizard, 'export async function switchInventoryMethod('), [
      'db.product.update(',
      'suspenderParejaPorReceta(db',
      'db.inventory.deleteMany(',
    ])
    const integracion = leer('src/services/dashboard/productInventoryIntegration.service.ts')
    enOrden(cuerpo(integracion, 'export async function setProductInventoryMethod('), [
      'tx.product.update(',
      'suspenderParejaPorReceta(tx',
      'ensureQuantityInventoryRow(tx',
    ])

    const mensajero = leer(`${SHOPIFY}/shopify.outbox.service.ts`)
    enOrden(cuerpo(mensajero, 'async function conFilaPropia<T>('), [
      'cercoVigente(tx',
      'bloquearContexto(tx',
      'AND "claimToken" = ${claimToken} AND status = \'IN_PROGRESS\'',
      'FOR UPDATE',
      'eventoVigente(tx',
    ])
    enOrden(cuerpo(mensajero, 'async function bloquearContexto('), [
      'WHERE id = ${f.locationLinkId} FOR SHARE',
      'WHERE id = ${link.storeId} FOR SHARE',
      'FROM "ShopifyVariantLink" WHERE "productId" = ${f.productId}',
      'FOR UPDATE',
    ])
  })

  it('🔴 «usar Avoqado» pone el espejo en S en la MISMA tx y encola A − S; no se lo deja al mensajero', () => {
    contieneTodas(['en la misma tx pone el espejo en `S`', 'encola `A − S`', 'contesta 409 `SHOPIFY_CAMBIOS_EN_CAMINO`'])
    expect(regla).not.toContain('el espejo lo mueve el mensajero')
    const reconcile = leer(`${SHOPIFY}/shopify.reconcile.service.ts`)
    const resolver = cuerpo(reconcile, 'async function resolver(')
    enOrden(resolver, ['SHOPIFY_CAMBIOS_EN_CAMINO', 'tx.shopifyStockOutbox.create(', 'mirrorAvailable: S,'])
  })

  it('🔴 separa las dos barreras (iniciar/reactivar una pareja; conectar una generación) y dice qué pasa al religar y al desconectar', () => {
    contieneTodas([
      'Iniciar o reactivar una pareja (`initializePair(…)`, los dos modos) espera (`REINTENTAR`) mientras `productBlocked(…)` no sea `LIBRE`',
      'Conectar una generación nueva',
      'responde 409 `SHOPIFY_ENVIO_EN_CAMINO` mientras haya filas `IN_PROGRESS` o vivas ambiguas',
      'Una DEAD_LETTER ambigua no la frena',
      'Religar la sucursal a OTRA tienda no es un 409',
      '`lastError = RELIGADA_A_OTRA_TIENDA`',
      'Desconectar no espera',
    ])
    expect(regla).not.toContain('la reactivación y el cambio de generación')

    const conexion = leer(`${SHOPIFY}/shopify.connect.service.ts`)
    const confirmar = cuerpo(conexion, 'export async function confirmShopifyConnect(')
    expect(confirmar).toContain("'SHOPIFY_ENVIO_EN_CAMINO'")
    enOrden(confirmar, [
      'const mismaTienda = !!previo && previa?.id === previo.storeId',
      'envioEnCamino(tx',
      "'SHOPIFY_ENVIO_EN_CAMINO'",
      'previo && previo.storeId !== storeId ? await aCuarentenaPorReligar(tx, previo.id)',
    ])
    const religar = cuerpo(conexion, 'async function aCuarentenaPorReligar(')
    expect(religar).toContain("status = 'IN_PROGRESS' OR (status IN ('PENDING', 'FAILED') AND ambiguous)")
    expect(religar).toContain("SET status = 'DEAD_LETTER'")
    expect(conexion).toContain("export const RELIGADA_A_OTRA_TIENDA = 'RELIGADA_A_OTRA_TIENDA'")
    // «Una DEAD_LETTER ambigua no la frena»: la cuenta sólo mira IN_PROGRESS y PENDING/FAILED ambiguas.
    const en = cuerpo(leer(`${SHOPIFY}/shopify.store.service.ts`), 'export async function envioEnCamino(')
    expect(en).toContain("{ status: 'IN_PROGRESS' }, { status: { in: ['PENDING', 'FAILED'] }, ambiguous: true }")
    expect(en).not.toContain('DEAD_LETTER')
  })

  it('🔴 trae las tres excepciones de los userErrors y que cualquier otro no limpia la duda', () => {
    contieneTodas([
      '`IDEMPOTENCY_CONCURRENT_REQUEST`',
      '`SERVICE_UNAVAILABLE`',
      '`ADJUST_QUANTITIES_FAILED`',
      'quedan FAILED hasta agotar los intentos (`SHOPIFY_OUTBOX_MAX_ATTEMPTS`, 6; después DEAD_LETTER) y conservan la duda previa',
      'Cualquier otro `userError` en una fila ambigua',
      'Sólo el éxito validado la limpia',
    ])
    const mensajero = leer(`${SHOPIFY}/shopify.outbox.service.ts`)
    expect(mensajero).toContain("new Set(['SERVICE_UNAVAILABLE', 'ADJUST_QUANTITIES_FAILED'])")
    expect(mensajero).toContain("codigos.includes('IDEMPOTENCY_CONCURRENT_REQUEST')")
    expect(mensajero).toContain('export const SHOPIFY_OUTBOX_MAX_ATTEMPTS = 6')
    expect(cuerpo(mensajero, 'async function reintentar(')).toContain('if (attempts >= SHOPIFY_OUTBOX_MAX_ATTEMPTS) return muerta(')
  })

  it('dice qué se conserva y cómo cierran los envíos de una generación vieja (§9.1-§9.2)', () => {
    contieneTodas([
      'Las filas `IN_PROGRESS` y las ambiguas siguen vivas',
      'con sus parámetros congelados',
      'mueve el espejo sólo si la pareja existe y su generación coincide',
      'La ventana de 23 h sólo pone en cuarentena filas AMBIGUAS',
    ])
    const mensajero = leer(`${SHOPIFY}/shopify.outbox.service.ts`)
    expect(mensajero).toContain('const VENTANA_MS = 23 * 3600_000')
    expect(cuerpo(mensajero, 'async function confirmar(')).toContain('ctx.link?.generation !== row.generation')
  })

  it('🔴 trae el cuadre por versión, el cerco, el conteo con el committed del espejo y los dos motivos de una línea retenida (§12.1)', () => {
    contieneTodas([
      'una vuelta se cierra sólo con CAS sobre `reconcileVersion`',
      'esperar un envío en vuelo deja la tanda pendiente',
      'con una fila VIVA ambigua la vuelta no se da por buena',
      'una DEAD_LETTER no detiene la vuelta',
      '`CONTEXTO_CAMBIO`',
      '`objetivo = contado − pareja.mirrorCommitted`',
      'la línea NO se aplica',
      '`CONTEO_NO_APLICADO`',
      '`marcarFaltaPermiso(…)`',
      'Dos motivos (enmienda §12.1)',
      '`ENVIO_EN_CAMINO`',
      '`DUDA_POR_REVISAR`',
      '`DUDA_POR_REVISAR` (sólo entre los bloqueados: hay una DEAD_LETTER ambigua o una revisión OPEN;',
    ])
    expect(regla).not.toContain('Un resultado no concluyente')

    // El código: la vuelta, el conteo y el servicio compartido de conteos.
    const reconcile = leer(`${SHOPIFY}/shopify.reconcile.service.ts`)
    const cerrar = cuerpo(reconcile, 'async function cerrarVuelta(')
    expect(cerrar).toContain('reconcileVersion: l.reconcileVersion')
    expect(cerrar).toContain('reconcileDoneVersion: l.reconcileVersion')
    const conteo = leer(`${SHOPIFY}/shopify.count.service.ts`)
    expect(conteo).toContain("export const ENVIO_EN_CAMINO = 'ENVIO_EN_CAMINO' as const")
    expect(conteo).toContain("export const DUDA_POR_REVISAR = 'DUDA_POR_REVISAR' as const")
    const apartadas = cuerpo(conteo, 'export async function apartadasBajoCandado(')
    enOrden(apartadas, [
      'productBlocked(tx',
      "AND status = 'DEAD_LETTER' AND ambiguous",
      "status = 'OPEN'",
      'return d?.duda ? DUDA_POR_REVISAR : ENVIO_EN_CAMINO',
    ])
    expect(apartadas).toContain('mirrorCommitted')
    const movil = leer('src/services/mobile/inventory.mobile.service.ts')
    enOrden(movil, ['apartadasBajoCandado(tx', 'shopifyHeldAt: new Date(), shopifyHeldReason: ajuste', '.minus(ajuste?.apartadas ?? 0)'])
  })

  it('🔴 el piloto: lista de tiendas, función sin catálogo, nunca suelta y ningún texto que mande a comprar', () => {
    contieneTodas([
      '`SHOPIFY_PILOTO_SHOPS`',
      'otra tienda ⇒ 409 `SHOPIFY_SOLO_PILOTO`',
      '`PREMIUM_ONLY_SIN_CATALOGO`',
      '400 `FEATURE_NO_SE_VENDE_SUELTA`',
      'Ningún texto (página, avisos, MCP, la razón del movimiento de un conteo) manda a comprar ni a subir de plan para tener Shopify',
    ])
    expect(leer(`${SHOPIFY}/shopify.connect.service.ts`)).toContain("'SHOPIFY_SOLO_PILOTO'")
    // C12 (N2): la razón del movimiento del conteo la ve el cajero en el POS; sin acceso no culpa a «el plan».
    const conteo = leer(`${SHOPIFY}/shopify.count.service.ts`)
    expect(conteo).toContain("? 'el conector con Shopify no está activo en este local'")
    expect(conteo).not.toContain('por el plan')
    expect(leer('src/services/access/basePlan.service.ts')).toContain(
      "export const PREMIUM_ONLY_SIN_CATALOGO = ['SHOPIFY_INTEGRATION'] as const",
    )
    for (const f of ['src/services/dashboard/venueFeature.dashboard.service.ts', 'src/services/stripe.service.ts']) {
      expect(leer(f)).toContain('PREMIUM_ONLY_SIN_CATALOGO')
      expect(leer(f)).toContain("'FEATURE_NO_SE_VENDE_SUELTA'")
    }
    // C4 (ronda de revisión): la huella del desconectar por MCP cabe con nombres de ubicación largos.
    expect(leer('src/mcp/tools/shopify.ts')).toContain('expectedSourceFingerprint: z.string().max(1024)')
  })

  it('🔴 las entradas HTTP: webhook crudo de 1 MB antes del genérico y callback con las dos formas de HMAC', () => {
    contieneTodas([
      '`express.raw` de 1 MB (`SHOPIFY_WEBHOOK_MAX_BYTES`) montado ANTES del router genérico',
      "El del router genérico usa `express.raw({ type: 'application/json' })`: el límite por omisión es de 100 KB",
      'su tipo NO es comodín (cualquier otro Content-Type deja `req.body = {}`)',
      '`handleShopifyCallback(…)` recibe `req.query` INTACTO',
      'se aceptan DOS formas de firma',
      'Un `host` terminado en `==` firmado como la biblioteca oficial sólo cuadra con la forma codificada; con una sola forma (la decodificada), el piloto daría `?error=FIRMA`',
    ])
    const app = leer('src/app.ts')
    enOrden(app, [
      "app.post(SHOPIFY_WEBHOOK_ROUTE, express.raw({ type: '*/*', limit: SHOPIFY_WEBHOOK_MAX_BYTES }), handleShopifyWebhook)",
      "'/api/v1/webhooks',\n  express.raw({ type: 'application/json' })",
    ])
    expect(app).toContain('app.get(SHOPIFY_OAUTH_CALLBACK_PATH, requestLoggerMiddleware, shopifyOAuthCallback)')
    const firma = leer(`${SHOPIFY}/shopify.crypto.ts`)
    expect(firma).toContain("return 'codificada'")
    expect(firma).toContain("return 'decodificada'")
    expect(firma).toContain(".replace(/\\+/g, '%20')")
    // El anclaje de la regla: `formaDeFirmaOAuth` es lo que cuadra las dos formas; `verifyOAuthQueryHmac` sólo la llama.
    expect(firma).toContain('export function formaDeFirmaOAuth(')
    expect(cuerpo(firma, 'export function verifyOAuthQueryHmac(')).toContain('formaDeFirmaOAuth(query, secret)')
    // El montaje genérico no fija `limit` (100 KB por omisión) y su tipo es sólo application/json: por eso el de Shopify va aparte.
    expect(app).not.toMatch(/express\.raw\(\{ type: 'application\/json', limit/)
  })

  it('🔴 la retención de 90 días, la prueba de volumen apagada por defecto y el carril ci/ sin workflow_dispatch', () => {
    contieneTodas([
      '`REVISIONES_RESUELTAS_DIAS`',
      'las revisiones RESUELTAS hace más de 90 días',
      'Nunca se purga una revisión OPEN, ni una resuelta cuyo envío siga PENDING, FAILED, IN_PROGRESS o DEAD_LETTER',
      '`SHOPIFY_VOLUMEN=1` la enciende',
      'catalogo-volumen.integration.test.ts',
      'sube TU commit a una rama `ci/<tema>`',
      'NUNCA `gh workflow run` sobre esta rama',
    ])
    const worker = leer(`${SHOPIFY}/shopify.worker.service.ts`)
    expect(worker).toContain('export const REVISIONES_RESUELTAS_DIAS = 90')
    const limpieza = cuerpo(worker, 'export async function limpiarShopify(')
    expect(limpieza).toContain('DELETE FROM "ShopifyReviewItem"')
    expect(limpieza).toContain('r.status = \'RESOLVED\' AND r."resolvedAt" <')
    expect(limpieza).toContain("o.status IN ('SENT', 'DISCARDED')")
    expect(limpieza).not.toContain("status = 'OPEN'")
    // La prueba de volumen existe y sólo corre con la variable.
    expect(leer('tests/integration/shopify/catalogo-volumen.integration.test.ts')).toContain(
      "const describirSi = process.env.SHOPIFY_VOLUMEN === '1' ? describe : describe.skip",
    )
    // workflow_dispatch con production publica sin importar la rama: la regla no puede dejar de avisarlo.
    expect(leer('.github/workflows/ci-cd.yml')).toContain("github.event.inputs.environment == 'production'")
  })

  it('B7: pasar a receta suspende la pareja y volver a cantidad pide el cuadre, por TODOS los caminos', () => {
    contieneTodas([
      'Pasar un producto a RECETA, por CUALQUIER camino, llama a `suspenderParejaPorReceta(…)` DESPUÉS de escribir el `Product` y ANTES de tocar `Inventory`',
      '`pedirCuadreAlVolverACantidad(…)` pide el cuadre (`pedirCuadre(…)`) SÓLO si la pareja está suspendida por `SIN_INVENTARIO`',
      'un producto que el conector archivó con un envío en camino se queda en `NIVEL_INEXISTENTE`',
    ])
    const store = leer(`${SHOPIFY}/shopify.store.service.ts`)
    expect(cuerpo(store, 'export async function pedirCuadreAlVolverACantidad(')).toContain("pareja?.suspendedReason === 'SIN_INVENTARIO'")
    expect(cuerpo(store, 'export async function suspenderParejaPorReceta(')).toContain("'NIVEL_INEXISTENTE'")
    // Los tres llamadores de los ayudantes: nadie más cambia el método sin pasar por ellos.
    expect(leer('src/services/dashboard/productWizard.service.ts')).toContain('pedirCuadreAlVolverACantidad(db, productId)')
    expect(leer('src/services/dashboard/productInventoryIntegration.service.ts')).toContain('pedirCuadreAlVolverACantidad(tx, productId)')
  })

  it('L5: la línea retenida se lee en el detalle del conteo (móvil, dashboard y MCP) y la regla dice dónde', () => {
    // La viñeta «Pendiente (L5…)» se fue con C9b; si vuelve, o si alguien deja de exponer la retención, esto falla.
    expect(regla).not.toContain('todavía NO muestra `shopifyHeldAt`')
    contieneTodas([
      'la línea retenida se expone como `shopifyHeld` (`{ at, motivo }` o `null`) en `mapCountItem(…)` (GET móvil y detalle del dashboard, que suma `noAplicadas`) y en `stock_counts` del MCP',
      // C12: dónde lo enseña el POS, y por qué el GET manda sobre la respuesta del confirm.
      'En el POS (Android e iOS, C12) lo cuentan la tarjeta «N productos no se aplicaron» que queda arriba de la lista de conteos al confirmar, la insignia «No se aplicó» con su motivo en cada línea del detalle, la fila de la lista y el comprobante impreso',
      'la tarjeta nace de `noAplicados` y se completa releyendo el GET (`shopifyHeld`), porque el reintento `alreadyCompleted` no trae `noAplicados`',
      'el motivo se lee como texto y uno que la app no conoce cae en `DUDA_POR_REVISAR`',
    ])
    expect(regla).not.toContain('las pantallas del POS (Android e iOS) son C12')
    expect(cuerpo(leer('src/services/mobile/inventory.mobile.service.ts'), 'export function mapCountItem(')).toContain(
      'shopifyHeld: retencionShopify(item)',
    )
    expect(leer('src/services/dashboard/stockCountAudit.service.ts')).toContain(
      'noAplicadas: count.items.filter(i => i.shopifyHeldAt).length',
    )
    const mcp = leer('src/mcp/tools/inventory.ts')
    const stockCounts = mcp.slice(mcp.indexOf("'stock_counts',"), mcp.indexOf("'cancel_stock_count',"))
    expect(stockCounts).toContain('shopifyHeld: retencionShopify(i)')
    expect(stockCounts).toContain('noAplicadas: c.items.filter(i => i.shopifyHeldAt).length')
  })

  it('🔴 el invariante: Σ vivas y Σ DEAD_LETTER son de la generación vigente (T3); lo de una generación vieja y las RELIGADA no entran', () => {
    contieneTodas([
      "`LIVE_OUTBOX_STATUSES = ['PENDING', 'IN_PROGRESS', 'FAILED']`",
      'El invariante vale para una pareja iniciada y no suspendida, y TODAS sus sumas son de la generación vigente de la sucursal (T3): Σ vivas y Σ DEAD_LETTER por igual',
      'Las filas de una generación vieja y las `RELIGADA_A_OTRA_TIENDA` (que quedan en la generación anterior) NO entran en la cuenta',
      'Una DEAD_LETTER (de la generación vigente) conserva su delta en la cuenta',
    ])
    expect(leer(`${SHOPIFY}/shopify.constants.ts`)).toContain(
      "export const LIVE_OUTBOX_STATUSES = ['PENDING', 'IN_PROGRESS', 'FAILED'] as const",
    )
    const mirror = leer(`${SHOPIFY}/shopify.mirror.service.ts`)
    expect(mirror).toContain('Invariante operativo (§9.3; pareja iniciada y no suspendida)')
    expect(mirror).toContain('del producto en la generación vigente.')
    // Cada lugar que suma o cuenta filas del buzón lo hace SOLO de la generación vigente.
    expect(cuerpo(mirror, 'export async function liveOutboxSum(')).toContain('generation, status: { in: [...LIVE_OUTBOX_STATUSES] }')
    expect(cuerpo(mirror, 'export async function productBlocked(')).toContain('AND generation = ${generation}')
    expect(cuerpo(mirror, 'async function bloquearFilasDelProducto(')).toContain('generation = ${p.generation}')
    const reconcile = leer(`${SHOPIFY}/shopify.reconcile.service.ts`)
    const revision = cuerpo(reconcile, 'async function abrirRevision(')
    expect(revision).toContain("generation: cerco.generation, status: 'DEAD_LETTER'")
    expect(revision).toContain('liveOutboxSum(tx, productId, link.id, cerco.generation)')
    expect(cuerpo(reconcile, 'export async function leerTandaCuadre(')).toContain(
      "locationLinkId, generation, status: { in: [...VIVAS, 'DEAD_LETTER'] }",
    )
    // Las RELIGADA quedan en la generación anterior: religar las manda a DEAD_LETTER y LUEGO sube la generación.
    const conexion = leer(`${SHOPIFY}/shopify.connect.service.ts`)
    enOrden(cuerpo(conexion, 'export async function confirmShopifyConnect('), [
      'aCuarentenaPorReligar(tx, previo.id)',
      'dejarConectando(tx, previo',
    ])
    expect(cuerpo(conexion, 'async function dejarConectando(')).toContain('generation: previo.generation + 1')
  })

  it('🔴 el cuadre decide en este orden: con DEAD_LETTER (aunque total = 0) ATORADO/INCIERTO y nunca cierra; sin ella, total = 0 cierra, total ≠ offset da DIFERENCIA', () => {
    contieneTodas([
      'con DEAD_LETTER (aunque `total = 0`, que es el caso normal de un ATORADO): abre o actualiza `ATORADO` (`INCIERTO` si alguna es ambigua) con `offset = total`; nunca cierra',
      'sin DEAD_LETTER y `total = 0`: cierra la revisión OPEN (offset 0) o no hace nada',
      'sin DEAD_LETTER y `total ≠ 0`: con un envío en camino sale `EN_CAMINO` sin escribir',
      'una OPEN que ya existía conserva su motivo (sólo ATORADO e INCIERTO se lo pisan)',
    ])
    const revision = cuerpo(leer(`${SHOPIFY}/shopify.reconcile.service.ts`), 'async function abrirRevision(')
    // `nAtoradas > 0` se pregunta ANTES que `total.isZero()`: con DEAD_LETTER y total 0 (el ATORADO normal) no se cierra nada.
    enOrden(revision, [
      'if (nAtoradas > 0)',
      "reason = ambiguas > 0 ? 'INCIERTO' : 'ATORADO'",
      'total.isZero()',
      'reason: abierta.reason, avoqado: A.toString(), shopify: S',
      'if (enCamino > 0) return',
      'total.minus(abierta.offset).isZero()',
      "reason = 'DIFERENCIA'",
    ])
    expect(revision).toContain("const motivo = reason === 'ATORADO' || reason === 'INCIERTO' ? reason : abierta.reason")
  })

  it('🔴 el guardia (trigger) y la marca de origen: lo que la regla dice de la migración y de set_config está en el SQL y en el código', () => {
    contieneTodas([
      'El trigger `"Inventory_guardia_shopify"` (`AFTER INSERT OR UPDATE OF "currentStock"`',
      'si está PAUSED, manda `pausedFrom`',
      "`SELECT set_config('avoqado.stock_origen', 'shopify', true)`",
    ])
    const carpetas = fs.readdirSync(path.join(RAIZ, 'prisma/migrations')).filter(d => d.endsWith('_shopify_conector'))
    expect(carpetas).toHaveLength(1)
    const sql = leer(`prisma/migrations/${carpetas[0]}/migration.sql`)
    enOrden(sql, [
      "IF current_setting('avoqado.stock_origen', true) = 'shopify' THEN",
      'IF v_delta = 0 THEN',
      `WHEN l.status = 'PAUSED' THEN COALESCE(l."pausedFrom"::text, 'ACTIVE')`,
      `IF v_link IS NULL OR v_fase = 'DISCONNECTED' THEN`,
      `IF v_fase = 'ACTIVE' THEN`,
      'v."initializedAt" IS NOT NULL AND v."suspendedReason" IS NULL',
      'INSERT INTO "ShopifyStockOutbox"',
      'AFTER INSERT OR UPDATE OF "currentStock" ON "Inventory"',
    ])
    const mirror = leer(`${SHOPIFY}/shopify.mirror.service.ts`)
    expect(cuerpo(mirror, 'export async function marcarOrigenShopify(')).toContain(
      "SELECT set_config('avoqado.stock_origen', 'shopify', true)",
    )
  })

  it('los globs de `paths:` de la regla apuntan a algo que existe, incluidos los demás escritores de stock', () => {
    const cabecera = leer('.claude/rules/shopify-conector.md').split('---')[1]
    const globs = [...cabecera.matchAll(/- '([^']+)'/g)].map(m => m[1])
    for (const escritor of [
      'src/services/inventory/**',
      'src/services/dashboard/purchaseOrder*',
      'src/services/dashboard/menu.dashboard.service.ts',
      'src/services/mobile/areaTicketV7.mobile.service.ts',
      'src/services/dashboard/chatbot-actions/definitions/product-stock.actions.ts',
    ]) {
      expect(globs).toContain(escritor)
    }
    // Cada glob se EXPANDE y debe casar con al menos un archivo (un `src/services/**/inexistente*.ts` no pasa).
    const archivos = archivosBajo(['src', 'prisma/migrations', 'tests/integration'])
    const huecos = globs.filter(g => {
      const re = globARegExp(g)
      return !archivos.some(f => re.test(f))
    })
    expect(huecos).toEqual([])
  })

  it('no conserva versiones anteriores', () => {
    expect(regla).not.toMatch(/descarta lo viejo/)
    expect(regla).not.toMatch(/mirrorAvailable \+ Σ delta` de las filas vivas/)
    expect(regla).not.toMatch(/la baja al cerrar/)
  })

  it('cada función que la regla nombra existe exportada en el código', () => {
    const nombres = [...new Set([...regla.matchAll(/`([a-zA-Z]+)\(/g)].map(m => m[1]))]
    expect(nombres.length).toBeGreaterThan(20)
    expect(nombres.filter(n => !new RegExp(`export (async )?function ${n}\\b`).test(codigo))).toEqual([])
  })
})
