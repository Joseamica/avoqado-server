/**
 * Loads a Shopify product CSV (Shopify admin → Products → Export → CSV) into ONE Avoqado venue. Operator tool, run by us
 * (IQ Collection, Lomas): each collection is loaded on top of the previous ones and nothing the file does not bring is
 * archived. The conversion lives in `src/services/dashboard/shopifyCatalogImport.ts`.
 *
 * 🔴 By default ONLY NEW SKUs are loaded: a SKU the venue already has is reported as YA_EXISTE and not sent, because
 * importMenu's merge resets its cost, description, tags, allergens, type, order and category. `--actualizar-existentes`
 * sends them anyway (it prints what gets reset first). Same result whether Spain exports one collection or the catalog.
 *
 *   export DATABASE_URL=<target>   # REQUIRED for production: dotenv never overrides an exported value; without it the run uses .env
 *
 *   # 1) Simulation (default): reads the database, writes NOTHING but the report next to the file (<archivo>.reporte.csv)
 *   npx ts-node -T -r tsconfig-paths/register scripts/importar-catalogo-shopify.ts \
 *     --archivo products_export.csv --venue <venueId> --factor 21.5        # or: --precios precios.csv (columns sku,precio)
 *
 *   # 2) Apply: the same command plus
 *     --aplicar --staff <staffId> --confirm-host <host> --confirm-db <name>
 *
 * `-T` (transpile-only) is required: a type-checking ts-node runs out of memory on the Prisma types.
 *
 * 🔴 It prints the host and database name of DATABASE_URL first, and writing requires repeating BOTH in --confirm-host and
 * --confirm-db (the `seed-plan-list-prices.ts` pattern): the only defense against an inherited DATABASE_URL pointing
 * elsewhere. The Prisma client is loaded only after that check, from that same DATABASE_URL.
 *
 * Applying runs `importMenu` in chunks of CHUNK_SIZE products (one transaction each): re-running the same command after
 * a failure is safe — what was already loaded is reported as YA_EXISTE, the rest is loaded, nothing is duplicated.
 */
import fs from 'node:fs'
import Papa from 'papaparse'

import {
  chunkImportMenuData,
  convertShopifyCsv,
  parsePriceListCsv,
  type ShopifyPricing,
  type ShopifyProblemCode,
} from '../src/services/dashboard/shopifyCatalogImport'

const CHUNK_SIZE = 50

/** A refusal: nothing was written. The script exits 2 with the message already printed. */
class Refusal extends Error {}

const PROBLEMS: Record<ShopifyProblemCode, string> = {
  NO_ACTIVO: 'omitido: el producto no está activo en Shopify (borrador o archivado)',
  PACK: 'omitido: parece un pack/kit/lote (se decidirá si se arma como combo)',
  SIN_SKU: 'omitido: la variante no tiene SKU',
  SKU_FORMATO: 'omitido: el SKU trae caracteres que la plataforma no acepta (sólo letras sin acento, números, - y _)',
  SKU_REPETIDO: 'omitido: el SKU se repite en el archivo',
  YA_EXISTE: 'omitido: el SKU ya existe en el negocio y no se toca (--actualizar-existentes para actualizarlo)',
  SIN_PRECIO: 'omitido: el SKU no está en la lista de precios',
  PRECIO_INVALIDO: 'omitido: precio ilegible',
  PRECIO_CERO: 'omitido: el precio en pesos es 0 o menos',
  CODIGO_REPETIDO: 'se importa SIN código de barras: varias variantes comparten el mismo',
  CODIGO_EN_OTRO_PRODUCTO: 'se importa SIN código de barras: otro producto del negocio ya lo tiene',
  CODIGO_INVALIDO: 'se importa SIN código de barras: notación científica (lo dañó una hoja de cálculo) o más de 14 caracteres',
  VARIOS_CODIGOS: 'se importa con el PRIMER código de barras: traía varios',
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** Host and database name of the DATABASE_URL this run connects to. The full URL (with its password) is never printed. */
function database(): { host: string; name: string } {
  const url = process.env.DATABASE_URL
  if (!url) throw new Refusal('Falta DATABASE_URL: no hay base a la que conectarse.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Refusal('DATABASE_URL no es una URL válida (su valor no se imprime).')
  }
  if (!parsed.hostname) throw new Refusal('DATABASE_URL no declara un host: no hay nada que repetir en --confirm-host.')
  return { host: parsed.hostname, name: parsed.pathname.replace(/^\//, '') }
}

async function main() {
  await import('dotenv/config')
  const apply = process.argv.includes('--aplicar')
  const updateExisting = process.argv.includes('--actualizar-existentes')
  const file = flag('--archivo')
  const venueId = flag('--venue')
  const factor = flag('--factor')
  const priceFile = flag('--precios')
  const staffId = flag('--staff')
  if (!file || !venueId)
    throw new Refusal('Uso: --archivo <export.csv> --venue <venueId> (--factor N | --precios precios.csv) [--aplicar …]')
  if (Boolean(factor) === Boolean(priceFile))
    throw new Refusal('Elige UN modo de precio: --factor N (precio de Shopify × N, a pesos enteros) o --precios <archivo sku,precio>.')
  if (apply && !staffId) throw new Refusal('--aplicar necesita --staff <staffId>: quién queda como autor de los productos.')

  const { host, name } = database()
  console.log(`Base: ${host}  base de datos: ${name}  modo: ${apply ? 'APLICAR' : 'SIMULACIÓN'}`)
  if (apply && (flag('--confirm-host') !== host || flag('--confirm-db') !== name))
    throw new Refusal(
      `🔴 No se escribió NADA. Para escribir en esta base repite su host y su nombre exactos:  --confirm-host ${host} --confirm-db ${name}`,
    )

  let csv: string, pricing: ShopifyPricing, firstPass: ReturnType<typeof convertShopifyCsv>
  try {
    csv = fs.readFileSync(file, 'utf8')
    pricing = factor ? { factor } : { priceList: parsePriceListCsv(fs.readFileSync(priceFile!, 'utf8')) }
    firstPass = convertShopifyCsv(csv, pricing) // a file that is not a Shopify export fails here, before any query
  } catch (error) {
    throw new Refusal(`🔴 No se escribió NADA. ${(error as Error).message}`)
  }

  // Loaded after the host and name check: the client reads DATABASE_URL when it loads.
  const { default: prisma } = await import('../src/utils/prismaClient')
  try {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, slug: true } })
    if (!venue) throw new Refusal(`No existe el negocio ${venueId} en esta base.`)
    console.log(`Negocio: ${venue.name} (${venue.slug})`)
    if (apply && !(await prisma.staffVenue.findFirst({ where: { staffId: staffId!, venueId, active: true }, select: { id: true } })))
      throw new Refusal(`🔴 No se escribió NADA. El staff ${staffId} no existe o no está activo en el negocio ${venue.name}.`)

    // gtin is unique per venue (archived products included): a barcode another SKU holds would abort the import.
    const barcodes = [...new Set(firstPass.variants.map(variant => variant.barcode).filter((code): code is string => Boolean(code)))]
    const holders = await prisma.product.findMany({ where: { venueId, gtin: { in: barcodes } }, select: { sku: true, gtin: true } })
    // Archived ones too: importMenu would restore them (same product), so they are not new either.
    const skus = [...new Set(firstPass.variants.map(variant => variant.sku).filter(Boolean))]
    const known = new Map(
      (await prisma.product.findMany({ where: { venueId, sku: { in: skus } }, select: { sku: true, deletedAt: true } })).map(p => [
        p.sku,
        { archived: p.deletedAt !== null },
      ]),
    )
    const { data, variants } = convertShopifyCsv(csv, pricing, {
      barcodeOwners: new Map(holders.map(holder => [holder.gtin!, holder.sku])),
      existingSkus: known,
      updateExisting,
    })
    const outcome = (sku: string, omitted: boolean) =>
      omitted ? 'OMITIDO' : !known.has(sku) ? 'CREAR' : known.get(sku)!.archived ? 'RESTAURAR' : 'ACTUALIZAR'

    const reportPath = `${file.replace(/\.csv$/i, '')}.reporte.csv`
    fs.writeFileSync(
      reportPath,
      Papa.unparse(
        variants.map(variant => ({
          estado: outcome(variant.sku, variant.omitted),
          motivos: variant.problems.map(problem => problem.code).join(' '),
          handle: variant.handle,
          sku: variant.sku,
          nombre: variant.name,
          categoria: variant.category,
          precio_shopify: variant.sourcePrice,
          precio_mxn: variant.price ?? '',
          codigo_barras: variant.barcode ?? '',
          imagen: variant.imageUrl ?? '',
          detalle: variant.problems.map(problem => problem.detail).join(' | '),
        })),
      ),
    )

    const count = (state: string) => variants.filter(variant => outcome(variant.sku, variant.omitted) === state).length
    console.log(`\nVariantes en el archivo: ${variants.length}`)
    console.log(`  a crear:      ${count('CREAR')}`)
    console.log(`  a actualizar: ${count('ACTUALIZAR')}`)
    if (count('RESTAURAR')) console.log(`  a restaurar:  ${count('RESTAURAR')} (estaban archivados: vuelven a la venta)`)
    console.log(`  omitidas:     ${count('OMITIDO')}`)
    const byCode = new Map<ShopifyProblemCode, number>()
    for (const problem of variants.flatMap(variant => variant.problems)) byCode.set(problem.code, (byCode.get(problem.code) ?? 0) + 1)
    if (byCode.size) console.log('\nProblemas:')
    for (const [code, total] of byCode) console.log(`  ${code.padEnd(24)} ${String(total).padStart(5)}  ${PROBLEMS[code]}`)
    console.log(`\nReporte (una fila por variante): ${reportPath}`)

    if (updateExisting && count('ACTUALIZAR') + count('RESTAURAR') > 0) {
      console.log(`\n⚠️  --actualizar-existentes: ${count('ACTUALIZAR') + count('RESTAURAR')} producto(s) que YA existen se sobrescriben.`)
      console.log('   Toman nombre, precio, categoría y tipo (REGULAR) del archivo, y se REINICIAN:')
      console.log('   costo y descripción → vacíos · etiquetas y alérgenos → vacíos · orden en su categoría → el del archivo.')
      console.log('   La imagen y el código de barras se reemplazan cuando el archivo los trae. El inventario queda por pieza;')
      console.log('   su stock no se toca.')
      console.log('   Los que se descuentan por receta y los que se apagaron a mano (con su inventario) se quedan como están.')
    }

    if (!apply) {
      console.log('\nSIMULACIÓN: no se escribió nada. Revisa el reporte y, para aplicar, repite el comando con:')
      console.log(`  --aplicar --staff <staffId> --confirm-host ${host} --confirm-db ${name}`)
      return
    }

    const chunks = chunkImportMenuData(data, CHUNK_SIZE)
    if (chunks.length === 0) {
      console.log('\nNada que importar.')
      return
    }
    const { importMenu } = await import('../src/services/dashboard/menu.dashboard.service')
    const { resolveLegacyCatalogActor } = await import('../src/services/master-catalog/catalogGovernance.service')
    const actor = resolveLegacyCatalogActor(staffId!, false)
    const startedAt = new Date()
    for (const [index, chunk] of chunks.entries()) {
      try {
        const result = await importMenu(venueId, chunk, actor)
        const kept = result.stats.productsKeptOnRecipe + result.stats.productsKeptUntracked
        console.log(
          `  lote ${index + 1}/${chunks.length}: ${result.stats.products} productos` +
            (kept ? ` (${kept} se quedaron como estaban: receta o apagado a mano)` : ''),
        )
      } catch (error) {
        console.error(`\n🔴 Falló el lote ${index + 1}/${chunks.length}; los ${index} anteriores sí quedaron cargados.`)
        console.error('   Corre de nuevo el MISMO comando: lo ya cargado sale como YA_EXISTE y se carga lo que faltó.')
        throw error
      }
    }

    // importMenu does not await its ActivityLog write; wait for it before the process exits, so the audit trail is complete.
    const logged = () => prisma.activityLog.count({ where: { venueId, action: 'MENU_IMPORTED', createdAt: { gte: startedAt } } })
    for (let attempt = 0; attempt < 50 && (await logged()) < chunks.length; attempt++)
      await new Promise(resolve => setTimeout(resolve, 100))
    console.log(`\n✅ Aplicado: ${chunks.length} lote(s); bitácora: ${await logged()} registro(s) MENU_IMPORTED.`)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module)
  main()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error instanceof Refusal || error?.isOperational ? error.message : error)
      process.exit(error instanceof Refusal ? 2 : 1)
    })
