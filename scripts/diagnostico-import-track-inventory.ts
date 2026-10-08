/**
 * DIAGNÓSTICO (sólo lectura) de los productos que dejó dañados la importación por hoja de cálculo del dashboard: tienen fila
 * de Inventory (con existencias) pero no se cuentan «por cantidad» (`trackInventory = false` o `inventoryMethod` nulo), así
 * que sus ventas NO descuentan. Cuenta y lista por negocio, con nombre, y clasifica cada uno (ver `scripts/lib/importTrackInventory.ts`).
 *
 *   npx tsx scripts/diagnostico-import-track-inventory.ts                       # base local (DATABASE_URL)
 *   npx tsx scripts/diagnostico-import-track-inventory.ts --base render         # RENDER_DATABASE_URL
 *   npx tsx scripts/diagnostico-import-track-inventory.ts --venue <slug o id>   # un solo negocio
 *   npx tsx scripts/diagnostico-import-track-inventory.ts --salida ids.txt      # + la lista de REPARABLE para revisar
 *
 * No escribe en la base. `--salida` escribe un ARCHIVO local con los ids REPARABLE (uno por renglón, con nombre para leerlo):
 * es la lista que se revisa y se le pasa a `reparar-import-track-inventory.ts --ids`. Reparar lo decide el founder.
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { buscarDanados, clasificar, destino, elegirBase, escribirIds, imprimir, leerValor } from './lib/importTrackInventory'

async function main(): Promise<void> {
  elegirBase(process.argv)
  const { host, base } = destino()
  const venueRef = leerValor(process.argv, '--venue')
  console.log(`Base: ${host} / ${base}  modo: DIAGNÓSTICO (sólo lectura)${venueRef ? `  venue: ${venueRef}` : ''}`)

  // Import dinámico: el cliente de Prisma lee DATABASE_URL al cargarse, y `elegirBase` ya la eligió.
  const { default: prisma } = await import('../src/utils/prismaClient')
  try {
    const venue = venueRef
      ? await prisma.venue.findFirst({ where: { OR: [{ slug: venueRef }, { id: venueRef }] }, select: { id: true } })
      : null
    if (venueRef && !venue) throw new Error(`No existe un venue con slug o id «${venueRef}».`)
    const { filas, truncado } = await buscarDanados(prisma, { venueId: venue?.id })
    imprimir(filas, truncado)
    const salida = leerValor(process.argv, '--salida')
    if (salida) {
      writeFileSync(salida, escribirIds(filas))
      console.log(`\nLista para revisar: ${salida} (${filas.filter(f => clasificar(f) === 'REPARABLE').length} id(s) REPARABLE)`)
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

// `exitCode` y no `process.exit`: hacia un pipe (macOS) un exit seco se come las últimas líneas del listado.
main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
