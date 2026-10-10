/**
 * REPARACIÓN de los productos que dejó dañados la importación por hoja de cálculo del dashboard (fila de Inventory con
 * existencias, pero sin contarse «por cantidad»). Prende `trackInventory = true` + `inventoryMethod = 'QUANTITY'` SÓLO en los
 * ids de la lista REVISADA que sigan siendo REPARABLE (nunca los que llevan receta, los tipos sin existencias ni los que ya
 * descontaron ventas y alguien apagó); las existencias NO se tocan. Clasificación: `scripts/lib/importTrackInventory.ts`.
 *
 *   # 1. La lista: el diagnóstico la escribe; el founder la revisa y borra los renglones que no quiera tocar
 *   npx tsx scripts/diagnostico-import-track-inventory.ts [--venue <slug o id>] [--base render] --salida ids.txt
 *   # 2. Simulación (default) sobre esa lista
 *   npx tsx scripts/reparar-import-track-inventory.ts --ids ids.txt [--base render]
 *   # 3. Escribir
 *   npx tsx scripts/reparar-import-track-inventory.ts --ids ids.txt [--base render] --aplicar --confirmar-host <host> --confirmar-base <base>
 *
 * 🔴 Escribir exige `--ids` (sin lista revisada no se escribe nada) y repetir el host Y el nombre de la base: es la defensa
 * contra un DATABASE_URL heredado que apunta a la base que no era. Sin `--aplicar` la transacción que escribe ni se
 * construye. Al aplicar, todo va en UNA transacción, por lotes con CAS por estado esperado (si uno cambió desde que se
 * listó, no se repara nada), y deja bitácora `PRODUCT_INVENTORY_TRACKING_REPAIRED`. Correrlo en producción lo decide el founder.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { buscarDanados, clasificar, destino, elegirBase, imprimir, leerIds, leerValor, reparar, TOPE } from './lib/importTrackInventory'

async function main(): Promise<number> {
  elegirBase(process.argv)
  const { host, base } = destino()
  const venueRef = leerValor(process.argv, '--venue')
  const archivoIds = leerValor(process.argv, '--ids')
  const aplicar = process.argv.includes('--aplicar')
  console.log(
    `Base: ${host} / ${base}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}${venueRef ? `  venue: ${venueRef}` : ''}${archivoIds ? `  lista: ${archivoIds}` : ''}`,
  )

  if (aplicar && !archivoIds) {
    console.error('🔴 No se escribió NADA. Para aplicar hace falta la lista revisada:  --ids <archivo>')
    console.error('   La escribe el diagnóstico:  npx tsx scripts/diagnostico-import-track-inventory.ts --salida <archivo>')
    return 2
  }
  if (aplicar && (leerValor(process.argv, '--confirmar-host') !== host || leerValor(process.argv, '--confirmar-base') !== base)) {
    console.error('🔴 No se escribió NADA.')
    console.error(
      `Para escribir en esta base hay que repetir su host y su nombre exactos:  --confirmar-host ${host} --confirmar-base ${base}`,
    )
    return 2
  }
  const ids = archivoIds ? leerIds(readFileSync(archivoIds, 'utf8')) : undefined
  if (ids && ids.size > TOPE) {
    console.error(`🔴 La lista trae ${ids.size} ids; el tope por corrida es ${TOPE}. Pártela. No se escribió nada.`)
    return 2
  }

  // Import dinámico: el cliente de Prisma lee DATABASE_URL al cargarse, y `elegirBase` ya la eligió.
  const { default: prisma } = await import('../src/utils/prismaClient')
  try {
    const venue = venueRef
      ? await prisma.venue.findFirst({ where: { OR: [{ slug: venueRef }, { id: venueRef }] }, select: { id: true } })
      : null
    if (venueRef && !venue) throw new Error(`No existe un venue con slug o id «${venueRef}».`)
    const { filas, truncado } = await buscarDanados(prisma, { venueId: venue?.id, ids })
    imprimir(filas, truncado)
    const reparables = filas.filter(f => clasificar(f) === 'REPARABLE' && (!ids || ids.has(f.productId)))
    if (ids) {
      const siguen = new Set(reparables.map(f => f.productId))
      const saltados = [...ids].filter(id => !siguen.has(id))
      if (saltados.length > 0)
        console.log(
          `\n⚠️ ${saltados.length} id(s) de la lista ya no son REPARABLE o no existen; se saltan: ${saltados.slice(0, 50).join(', ')}${saltados.length > 50 ? ' …' : ''}`,
        )
    }

    if (!aplicar) {
      console.log(`\nSIMULACIÓN: se repararían ${reparables.length} producto(s). No se escribió nada.`)
      if (!ids)
        console.log('Para aplicar, primero la lista revisada:  npx tsx scripts/diagnostico-import-track-inventory.ts --salida ids.txt')
      else if (reparables.length > 0)
        console.log(
          `Para aplicar:  npx tsx scripts/reparar-import-track-inventory.ts --ids ${archivoIds}${venueRef ? ` --venue ${venueRef}` : ''}${leerValor(process.argv, '--base') ? ` --base ${leerValor(process.argv, '--base')}` : ''} --aplicar --confirmar-host ${host} --confirmar-base ${base}`,
        )
      return 0
    }
    const n = await reparar(prisma, filas, ids!)
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
