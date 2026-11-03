/**
 * Carga del histórico de números de vinculación de PlayTelecom (spec 2026-10-30 §5.7, plan A10). En seco por defecto.
 *
 *   npx tsx scripts/importar-numeros-de-vinculacion.ts --file=<xlsx> --org-id=<id> [--report=<json>]          # simulación, base local
 *   npx tsx scripts/importar-numeros-de-vinculacion.ts --file=<xlsx> --org-id=<id> --base render                # simulación contra RENDER_DATABASE_URL
 *   npx tsx scripts/importar-numeros-de-vinculacion.ts --file=<xlsx> --org-id=<id> --base render --apply --confirm-host=<host>
 *
 * Por cada fila del Excel del back-office (encabezados en la fila 3), por ICCID dentro de la organización:
 *  - venta sin número → se le pone (`linkingNumberSource = IMPORT`, ActivityLog `SALE_VERIFICATION_NUMBER_IMPORT`);
 *  - venta con otro número → no se pisa: va al reporte como choque;
 *  - sin venta (ventas de antes de Avoqado) → `HistoricalLinkingNumber`, para que los repetidos futuros se detecten;
 *  - número inválido (como `334651O556`) o sin ICCID → no se guarda: va al reporte.
 * Se puede repetir: la venta sólo se llena si sigue sin número (CAS) y el histórico salta lo que ya está (llave única
 * organización + ICCID + número). `importBatch = <fecha>-<8 del sha1 del archivo>`.
 *
 * 🔴 El reporte (`--report`) trae teléfonos de clientes: va fuera del repo. Escribir en producción pide el «sí, en prod» del
 * founder (Parte D del plan).
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import * as XLSX from 'xlsx'

import { correr, elegirBase, exigirHostConfirmado, hostDeLaBase, leerValor, Rechazo } from './lib/linkingNumbers/baseCli'
import { importBatchFor, normalizeIccid, parseHistoricalWorkbook, planHistoricalImport } from './lib/linkingNumbers/historicalImport'

const PAGINA = 5_000
/** Cada tanda de ventas a llenar va en una transacción con su bitácora: ~100 renglones retienen sus candados unos segundos. */
const TANDA_VENTAS = 100
const TANDA_HISTORICO = 1_000

type Venta = { id: string; venueId: string; linkingNumber: string | null; createdAt: Date }

async function main(): Promise<void> {
  const archivo = leerValor('--file')
  const orgId = leerValor('--org-id')
  if (!archivo || !orgId) {
    console.error('Uso: --file=<xlsx> --org-id=<id> [--report=<json>] [--apply --confirm-host=<host>] [--base render]')
    throw new Rechazo(2)
  }
  const reporte = leerValor('--report')
  const contenido = readFileSync(archivo)
  const filas = parseHistoricalWorkbook(XLSX.read(contenido, { type: 'buffer' }))
  const importBatch = importBatchFor(contenido, new Date())

  elegirBase()
  const host = hostDeLaBase()
  const aplicar = process.argv.includes('--apply')
  console.log(
    `Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}  organización: ${orgId}  filas: ${filas.length}  lote: ${importBatch}`,
  )
  if (aplicar) exigirHostConfirmado(host)

  // Import dinámico: el cliente de Prisma lee DATABASE_URL al cargarse, y `elegirBase` ya la eligió.
  const { default: prisma } = await import('../src/utils/prismaClient')
  try {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } })
    if (!org) {
      console.error(`No existe la organización «${orgId}».`)
      throw new Rechazo(2)
    }
    console.log(`Organización: ${org.name}`)

    // Las ventas de la organización por ICCID (todas las SIM de cada venta), por páginas. Si un ICCID quedó en dos ventas
    // (una rechazada y la que se rehízo), manda la más reciente.
    const ventas = new Map<string, Venta>()
    const enVariasVentas = new Set<string>()
    for (let cursor: string | undefined; ; ) {
      const pagina = await prisma.saleVerification.findMany({
        where: { venue: { organizationId: org.id } },
        select: { id: true, venueId: true, serialNumbers: true, linkingNumber: true, createdAt: true },
        orderBy: { id: 'asc' },
        take: PAGINA,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      for (const v of pagina)
        for (const s of v.serialNumbers) {
          const iccid = normalizeIccid(s)
          const previa = ventas.get(iccid)
          if (previa && previa.id !== v.id) enVariasVentas.add(iccid)
          if (!previa || previa.createdAt < v.createdAt) ventas.set(iccid, v)
        }
      if (pagina.length < PAGINA) break
      cursor = pagina[pagina.length - 1].id
    }

    const plan = planHistoricalImport(filas, ventas)
    const resumen = {
      filas: filas.length,
      aLlenar: plan.fillSale.length,
      choques: plan.conflicts.length,
      aHistorico: plan.toHistorical.length,
      invalidos: plan.invalid.length,
      repetidos: plan.repeatedNumbers.length,
      iccidsEnVariasVentas: enVariasVentas.size,
    }
    console.log(
      `Ventas de la organización con ICCID: ${ventas.size}\n` +
        `Filas ${resumen.filas} · a llenar ${resumen.aLlenar} · choques ${resumen.choques} · a histórico ${resumen.aHistorico} · ` +
        `inválidas ${resumen.invalidos} · números repetidos en el archivo ${resumen.repetidos}`,
    )
    if (enVariasVentas.size) console.log(`⚠️  ${enVariasVentas.size} ICCID están en más de una venta: se usó la más reciente.`)
    // Sólo el número de fila: el valor crudo puede ser el teléfono de un cliente (va en el JSON de --report).
    if (plan.invalid.length) console.log(`  inválidas (${plan.invalid.length}), filas: ${plan.invalid.map(i => i.rowIndex).join(', ')}`)
    const guardarReporte = (aplicado?: object) => {
      if (reporte) writeFileSync(reporte, JSON.stringify({ organizationId: org.id, importBatch, resumen, plan, aplicado }, null, 2))
    }
    guardarReporte()
    if (reporte) console.log(`Reporte: ${reporte}`)

    if (!aplicar) {
      console.log('Simulación: no se escribió nada.')
      console.log(
        `Para aplicar:  npx tsx scripts/importar-numeros-de-vinculacion.ts --file=${archivo} --org-id=${orgId}` +
          `${leerValor('--base') ? ` --base ${leerValor('--base')}` : ''} --apply --confirm-host=${host}`,
      )
      return
    }

    // 1) Llenar ventas: cada una sólo si sigue sin número; su bitácora va en la MISMA transacción.
    const venuePorVenta = new Map([...ventas.values()].map(v => [v.id, v.venueId]))
    const llenadas: typeof plan.fillSale = []
    const sinLlenar: typeof plan.fillSale = []
    const ahora = new Date()
    for (let i = 0; i < plan.fillSale.length; i += TANDA_VENTAS) {
      const tanda = plan.fillSale.slice(i, i + TANDA_VENTAS)
      const r = await prisma.$transaction(
        async tx => {
          const ok: typeof tanda = []
          const no: typeof tanda = []
          for (const f of tanda) {
            const u = await tx.saleVerification.updateMany({
              where: { id: f.verificationId, linkingNumber: null },
              data: { linkingNumber: f.number, linkingNumberSource: 'IMPORT', linkingNumberSetAt: ahora },
            })
            ;(u.count === 1 ? ok : no).push(f)
          }
          if (ok.length)
            await tx.activityLog.createMany({
              data: ok.map(f => ({
                venueId: venuePorVenta.get(f.verificationId) ?? null,
                organizationId: org.id,
                action: 'SALE_VERIFICATION_NUMBER_IMPORT',
                entity: 'SaleVerification',
                entityId: f.verificationId,
                data: { field: 'linkingNumber', before: null, after: f.number, source: 'IMPORT', importBatch, rowIndex: f.rowIndex },
              })),
            })
          return { ok, no }
        },
        { timeout: 60_000, maxWait: 10_000 },
      )
      llenadas.push(...r.ok)
      sinLlenar.push(...r.no)
    }
    // Las que alguien llenó entre la lectura y la escritura: si quedó otro número, es un choque más.
    const actuales = sinLlenar.length
      ? await prisma.saleVerification.findMany({
          where: { id: { in: sinLlenar.map(f => f.verificationId) } },
          select: { id: true, linkingNumber: true },
          take: sinLlenar.length,
        })
      : []
    const actualPorId = new Map(actuales.map(v => [v.id, v.linkingNumber]))
    const choquesAlAplicar = sinLlenar
      .filter(f => actualPorId.get(f.verificationId) !== f.number)
      .map(f => ({
        verificationId: f.verificationId,
        current: actualPorId.get(f.verificationId) ?? '',
        excel: f.number,
        rowIndex: f.rowIndex,
      }))

    // 2) Histórico: la llave única salta lo que ya estaba (se puede repetir).
    let historicosNuevos = 0
    for (let i = 0; i < plan.toHistorical.length; i += TANDA_HISTORICO) {
      const r = await prisma.historicalLinkingNumber.createMany({
        data: plan.toHistorical.slice(i, i + TANDA_HISTORICO).map(h => ({
          organizationId: org.id,
          iccid: h.iccid,
          number: h.number,
          saleDate: h.saleDate,
          sourceStatus: h.status,
          importBatch,
        })),
        skipDuplicates: true,
      })
      historicosNuevos += r.count
    }

    const aplicado = {
      ventasLlenadas: llenadas.length,
      choquesAlAplicar,
      historicosNuevos,
      historicosQueYaEstaban: plan.toHistorical.length - historicosNuevos,
    }
    guardarReporte(aplicado)
    console.log(
      `✅ Ventas llenadas ${aplicado.ventasLlenadas} · choques al aplicar ${choquesAlAplicar.length} · ` +
        `histórico nuevo ${historicosNuevos} (ya estaban ${aplicado.historicosQueYaEstaban})`,
    )
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

correr(main)
