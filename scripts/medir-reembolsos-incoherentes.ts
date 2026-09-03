/**
 * Task 5k — MEDICIÓN, no reparación. ¿Salió dinero de más por la carrera de los reembolsos?
 *
 *   npx tsx scripts/medir-reembolsos-incoherentes.ts
 *   npx tsx scripts/medir-reembolsos-incoherentes.ts --venue <venueId>
 *   npx tsx scripts/medir-reembolsos-incoherentes.ts --detalle 40
 *
 * 🔴 ES DE SÓLO LECTURA POR CONSTRUCCIÓN, no por disciplina: lo único que emite son `SELECT`
 * (`prisma.$queryRaw`). No hay `--apply` porque no hay nada que aplicar — cualquier reparación
 * sobre datos reales la autoriza el founder y va en su propio trabajo, con su propia prueba.
 *
 * 🔴 A propósito NO importa `scripts/_solo-base-local.ts`: ese cortafuegos rechaza toda base que
 * no sea local, y esta medición existe justamente para correrse contra producción. Como no
 * escribe, su seguridad no depende de un candado de host — pero la PRIMERA línea que imprime es
 * a qué base se conectó, para que nadie confunda de dónde salieron los números.
 *
 * Qué mide, y por qué son TRES preguntas y no una:
 *
 *   A) 🔴 DINERO DE MÁS — se devolvió más de lo que se cobró. Es el daño real de la carrera de
 *      la Task 5k y NO depende del acumulado: se compara la suma de los `Payment type=REFUND`
 *      contra el cobro. Si esto sale > 0, salió dinero por la puerta.
 *
 *   B) El ACUMULADO (`processorData.refundedAmount`) no cuadra con sus reembolsos. Es la huella
 *      que deja la carrera: el ganador queda borrado y el pago vuelve a ofrecer saldo que ya se
 *      devolvió. Un pago puede estar aquí sin estar en (A) — todavía.
 *
 *   ⚠️ Por qué se comparan DOS sumas y no una: los dos rieles escriben el acumulado con
 *   semántica DISTINTA. `refund.tpv.service` guarda venta + propina; `refund.dashboard.service`
 *   suma sólo `Math.abs(amount)` de los reembolsos previos (`:302`), o sea SIN la propina ya
 *   devuelta. Un acumulado que cuadra con cualquiera de las dos NO se reporta como incoherente:
 *   sería acusar en falso a la mitad del parque.
 *
 *   C) Cuántos pagos tienen MÁS DE UN reembolso — el universo donde la carrera es posible.
 *      Sirve de denominador: 0 aquí significa que el defecto nunca se disparó en esta base.
 */
import 'dotenv/config'
import { Prisma } from '@prisma/client'
import prisma from '../src/utils/prismaClient'

const TOLERANCIA = 0.011 // centavo y pico: absorbe el redondeo del split venta/propina

function leerValor(bandera: string): string | undefined {
  const i = process.argv.indexOf(bandera)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function pesos(v: unknown): string {
  return `$${Number(v ?? 0).toFixed(2)}`
}

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  let host = '(DATABASE_URL ilegible)'
  try {
    host = new URL(url).host
  } catch {
    /* se imprime tal cual abajo */
  }
  console.log(`🔌 base: ${host}`)
  console.log('👁️  SÓLO LECTURA — este script no escribe nada.\n')

  const venueId = leerValor('--venue') ?? null
  const detalle = Number(leerValor('--detalle') ?? 20)
  const filtroVenue = venueId ? Prisma.sql`AND p."venueId" = ${venueId}` : Prisma.empty

  // Un solo recorrido: por cada cobro con reembolsos, su acumulado declarado y las dos sumas
  // reales. `originalPaymentId` vive en el `processorData` del REEMBOLSO — es la única liga
  // entre los dos rieles (el del dashboard y el de la TPV escriben la misma llave).
  const filas = await prisma.$queryRaw<
    Array<{
      id: string
      venueId: string
      venueName: string | null
      createdAt: Date
      cobrado: unknown
      declarado: unknown
      sumaVenta: unknown
      sumaTotal: unknown
      nReembolsos: bigint
    }>
  >(Prisma.sql`
    SELECT
      p.id,
      p."venueId",
      v.name                                        AS "venueName",
      p."createdAt",
      (p.amount + COALESCE(p."tipAmount", 0))       AS "cobrado",
      (p."processorData"->>'refundedAmount')::numeric AS "declarado",
      r."sumaVenta",
      r."sumaTotal",
      r."nReembolsos"
    FROM "Payment" p
    JOIN LATERAL (
      SELECT
        COALESCE(SUM(ABS(x.amount)), 0)                                AS "sumaVenta",
        COALESCE(SUM(ABS(x.amount) + ABS(COALESCE(x."tipAmount", 0))), 0) AS "sumaTotal",
        COUNT(*)                                                       AS "nReembolsos"
      FROM "Payment" x
      WHERE x.type = 'REFUND'
        AND x."venueId" = p."venueId"
        AND x."processorData"->>'originalPaymentId' = p.id
    ) r ON TRUE
    LEFT JOIN "Venue" v ON v.id = p."venueId"
    WHERE p.type <> 'REFUND'
      AND r."nReembolsos" > 0
      ${filtroVenue}
    ORDER BY p."createdAt" DESC
  `)

  const cobradoDe = (f: (typeof filas)[number]) => Number(f.cobrado ?? 0)
  const totalDe = (f: (typeof filas)[number]) => Number(f.sumaTotal ?? 0)

  // (A) dinero de más — no depende del acumulado
  const deMas = filas.filter(f => totalDe(f) > cobradoDe(f) + TOLERANCIA)

  // (B) acumulado incoherente — no cuadra con NINGUNA de las dos semánticas
  const incoherentes = filas.filter(f => {
    if (f.declarado === null || f.declarado === undefined) return false // nunca se escribió: no es incoherencia
    const d = Number(f.declarado)
    return Math.abs(d - Number(f.sumaTotal ?? 0)) > TOLERANCIA && Math.abs(d - Number(f.sumaVenta ?? 0)) > TOLERANCIA
  })

  // (C) universo donde la carrera es posible
  const multiples = filas.filter(f => Number(f.nReembolsos) > 1)

  console.log(`Cobros con al menos un reembolso: ${filas.length}`)
  console.log(`  C) con MÁS DE UNO (donde la carrera es posible): ${multiples.length}`)
  console.log(`  B) acumulado que no cuadra con ninguna semántica: ${incoherentes.length}`)
  console.log(`  A) 🔴 DINERO DE MÁS (devuelto > cobrado): ${deMas.length}`)

  const dineroDeMas = deMas.reduce((s, f) => s + (totalDe(f) - cobradoDe(f)), 0)
  console.log(`     importe devuelto de más, en total: ${pesos(dineroDeMas)}\n`)

  const imprimir = (titulo: string, lista: typeof filas) => {
    if (!lista.length) return
    console.log(`── ${titulo} (primeros ${Math.min(detalle, lista.length)} de ${lista.length})`)
    for (const f of lista.slice(0, detalle)) {
      console.log(
        `   ${f.id}  ${f.venueName ?? f.venueId}  ${f.createdAt.toISOString().slice(0, 10)}` +
          `  cobrado ${pesos(f.cobrado)}  devuelto ${pesos(f.sumaTotal)} (venta ${pesos(f.sumaVenta)})` +
          `  declarado ${f.declarado === null ? '—' : pesos(f.declarado)}  n=${f.nReembolsos}`,
      )
    }
    console.log('')
  }

  imprimir('🔴 A) DINERO DE MÁS', deMas)
  imprimir('B) acumulado incoherente', incoherentes)
  imprimir('C) cobros con más de un reembolso', multiples)

  if (!deMas.length && !incoherentes.length) {
    console.log('✅ Sin daño medible en esta base. (Que no haya daño no significa que el defecto no exista:')
    console.log('   la carrera necesita dos reembolsos SIMULTÁNEOS sobre el MISMO cobro.)')
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async e => {
    console.error(e)
    await prisma.$disconnect()
    process.exitCode = 1
  })
