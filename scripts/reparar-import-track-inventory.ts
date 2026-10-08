/**
 * REPARACIÓN de los productos que dejó dañados la importación por hoja de cálculo del dashboard (fila de Inventory con
 * existencias, pero sin contarse «por cantidad»). Prende `trackInventory = true` + `inventoryMethod = 'QUANTITY'` SÓLO en los
 * REPARABLE (no toca los que llevan receta, los tipos sin existencias ni los que ya descontaron ventas y alguien apagó);
 * las existencias NO se tocan. Clasificación: `scripts/lib/importTrackInventory.ts`.
 *
 *   npx tsx scripts/reparar-import-track-inventory.ts [--venue <slug o id>] [--base render]          # SIMULACIÓN (default)
 *   npx tsx scripts/reparar-import-track-inventory.ts [--venue …] [--base render] --aplicar --confirmar-host <host> --confirmar-base <base>
 *
 * 🔴 Escribir exige repetir el host Y el nombre de la base: es la defensa contra un DATABASE_URL heredado que apunta a la
 * base que no era. Sin `--aplicar` la transacción que escribe ni se construye. Al aplicar, todo va en UNA transacción con
 * CAS por producto (si uno cambió desde que se listó, no se repara nada) y deja bitácora `PRODUCT_INVENTORY_TRACKING_REPAIRED`.
 * La decisión de correrlo en producción es del founder.
 */
import 'dotenv/config'
import { buscarDanados, clasificar, destino, elegirBase, imprimir, leerValor, reparar } from './lib/importTrackInventory'

async function main(): Promise<number> {
  elegirBase(process.argv)
  const { host, base } = destino()
  const venueRef = leerValor(process.argv, '--venue')
  const aplicar = process.argv.includes('--aplicar')
  console.log(`Base: ${host} / ${base}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}${venueRef ? `  venue: ${venueRef}` : ''}`)

  if (aplicar && (leerValor(process.argv, '--confirmar-host') !== host || leerValor(process.argv, '--confirmar-base') !== base)) {
    console.error('🔴 No se escribió NADA.')
    console.error(
      `Para escribir en esta base hay que repetir su host y su nombre exactos:  --confirmar-host ${host} --confirmar-base ${base}`,
    )
    return 2
  }

  // Import dinámico: el cliente de Prisma lee DATABASE_URL al cargarse, y `elegirBase` ya la eligió.
  const { default: prisma } = await import('../src/utils/prismaClient')
  try {
    const venue = venueRef
      ? await prisma.venue.findFirst({ where: { OR: [{ slug: venueRef }, { id: venueRef }] }, select: { id: true } })
      : null
    if (venueRef && !venue) throw new Error(`No existe un venue con slug o id «${venueRef}».`)
    const { filas, truncado } = await buscarDanados(prisma, venue?.id)
    imprimir(filas, truncado)
    const reparables = filas.filter(f => clasificar(f) === 'REPARABLE').length

    if (!aplicar) {
      console.log(`\nSIMULACIÓN: se repararían ${reparables} producto(s). No se escribió nada.`)
      if (reparables > 0)
        console.log(
          `Para aplicar:  npx tsx scripts/reparar-import-track-inventory.ts${venueRef ? ` --venue ${venueRef}` : ''}${leerValor(process.argv, '--base') ? ` --base ${leerValor(process.argv, '--base')}` : ''} --aplicar --confirmar-host ${host} --confirmar-base ${base}`,
        )
      return 0
    }
    if (truncado) {
      console.error('🔴 Se llegó al tope: repara por negocio con --venue para no dejar a medias. No se escribió nada.')
      return 2
    }
    const n = await reparar(prisma, filas)
    console.log(`\n✅ Reparados ${n} producto(s): ahora se cuentan «por cantidad» y sus ventas descuentan.`)
    return 0
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

// `exitCode` y no `process.exit`: hacia un pipe (macOS) un exit seco se come el renglón con el host que hay que repetir.
main()
  .then(codigo => {
    process.exitCode = codigo
  })
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
