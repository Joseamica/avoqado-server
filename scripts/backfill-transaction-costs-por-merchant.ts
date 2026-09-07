/**
 * Recalcula el `TransactionCost` de los cobros de UN merchant que se quedaron sin él.
 *
 *   npx tsx scripts/backfill-transaction-costs-por-merchant.ts --merchant <id>
 *   npx tsx scripts/backfill-transaction-costs-por-merchant.ts --merchant <id> --apply --confirm-host <host> [--actor <staffId>]
 *
 * EL PROBLEMA
 * -----------
 * `createTransactionCost()` (`src/services/payments/transactionCost.service.ts`) revienta con
 * `BadRequestError` cuando el merchant no tiene una `ProviderCostStructure` vigente A LA FECHA DEL
 * PAGO. Quien lo llama —la TPV, el efectivo móvil, las ligas— lo envuelve en un `try/catch` que NO
 * tumba el cobro, así que el dinero entra y el costo nunca se anota: el `Payment` se queda con
 * `feeAmount = 0` y `netAmount = bruto` mientras el procesador sí nos cobra su comisión. Margen
 * negativo silencioso, igual que el caso de PlayTelecom que motivó `fix-playtelecom-venue-pricing.ts`.
 *
 * Este script es el gemelo de la PARTE B de aquél, sin la parte que crea tarifas: acota por MERCHANT
 * en vez de por organización, porque el hueco que repara es una estructura de COSTO faltante (lo que
 * le pagamos al procesador), no una tarifa de venue faltante.
 *
 * QUÉ HACE
 * --------
 * Recorre los `Payment` COMPLETED del merchant, de origen AVOQADO, no-efectivo y sin
 * `TransactionCost`; llama a `createTransactionCost()` —nunca recalcula por su cuenta— y reescribe
 * `Payment.feeAmount` / `netAmount` y la `VenueTransaction` EXACTAMENTE como lo hace el camino de la
 * TPV (`payment.tpv.service.ts`, «Failed to create TransactionCost»).
 *
 * 🔴 `Payment.feePercentage` NO se toca, a propósito. El camino vivo tampoco lo escribe: nace en 0 y
 * se queda en 0 aunque el costo se calcule bien. Escribirlo aquí dejaría estos cobros distintos de
 * todos los demás del sistema, que es peor que dejarlos consistentes con la (discutible) realidad.
 *
 * SEGURIDAD
 * ---------
 *   · Simulación por default. Escribe SÓLO con `--apply` y repitiendo el host exacto de la base en
 *     `--confirm-host`. Es la defensa contra el error que de verdad pasa: un `DATABASE_URL` heredado
 *     de otra pestaña apuntando a una base que no era. Por eso la PRIMERA línea que imprime es a qué
 *     base se conectó, antes de leer nada.
 *   · A propósito NO importa `scripts/_solo-base-local.ts`: ese cortafuegos rechaza toda base que no
 *     sea local y el trabajo de este script es producción. Su candado es el host, no el entorno.
 *   · La simulación es de sólo lectura POR CONSTRUCCIÓN: la única escritura vive detrás de `if
 *     (aplicar)`, después del candado del host.
 *   · Idempotente: `TransactionCost.paymentId` es `@unique` y el filtro exige que no exista. Volver a
 *     correrlo no duplica nada.
 *   · Un pago que hoy NO se puede recalcular (le falta la estructura vigente a su fecha) se REPORTA y
 *     no se intenta — llamar al servicio sería cosechar el mismo error N veces. Eso es lo que hace
 *     que la simulación conteste de antemano si falta mover `effectiveFrom`.
 *   · Después de escribir, RELEE lo guardado y lo compara contra lo que la simulación prometió. Un
 *     descuadre se grita, no se asume.
 *   · Cada recálculo deja `ActivityLog TRANSACTION_COST_BACKFILLED`.
 *
 * Ninguna URL ni credencial se imprime nunca.
 */
import 'dotenv/config'
import { OriginSystem, PaymentMethod, Prisma } from '@prisma/client'
import prisma from '../src/utils/prismaClient'
import { logAction } from '../src/services/dashboard/activity-log.service'
import { getEffectivePaymentConfig } from '../src/services/organization-payment-config.service'
import {
  createTransactionCost,
  determineTransactionCardType,
  findActiveProviderCostStructure,
  findActiveVenuePricingStructure,
} from '../src/services/payments/transactionCost.service'
import { recomputeEconomics, type RateStructureLike } from '../src/services/superadmin/rateCorrection/rateRecompute'
import { clasificarPago, cuadraRedondeado, resolverRanura, type Clasificacion, type Ranura } from './lib/transactionCostBackfill'

/**
 * Tope de la lectura. La regla de consultas acotadas del workspace prohíbe un `findMany` sin
 * límite; si el merchant tuviera más rezago del que cabe aquí, se DICE y se corre otra vez, nunca
 * se recorta en silencio.
 */
const TOPE = 500

/** Rechazo de seguridad. El motivo se imprime donde se detecta; esto sólo lleva el código de salida
 *  hasta la cadena final, para que la salida alcance a drenarse hacia un pipe. */
class Rechazo extends Error {
  constructor(readonly codigo: number) {
    super(`rechazo (${codigo})`)
    this.name = 'Rechazo'
  }
}

function leerValor(bandera: string): string | undefined {
  const i = process.argv.indexOf(bandera)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  return process.argv.find(a => a.startsWith(`${bandera}=`))?.slice(bandera.length + 1)
}

function hostDeLaBase(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('Falta DATABASE_URL: no hay base a la que conectarse.')
    throw new Rechazo(2)
  }
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    console.error('DATABASE_URL no es una URL válida (su valor no se imprime).')
    throw new Rechazo(2)
  }
  // 🔴 Un DSN por socket unix (`postgres:///base`) deja el host VACÍO, y entonces `--confirm-host ""`
  // satisface la comparación: el candado se abriría solo. Va FUERA del `try` a propósito — dentro, su
  // propio `throw` caería en el `catch` de arriba y se leería «no es una URL válida», que es mentira.
  if (!host) {
    console.error('DATABASE_URL no declara un host (¿conexión por socket?): no hay nada que repetir en --confirm-host.')
    throw new Rechazo(2)
  }
  return host
}

const pesos = (v: number): string => `$${v.toFixed(2)}`
const tasa = (v: number): string => `${(v * 100).toFixed(4)}%`
const num = (v: Prisma.Decimal | number | null | undefined): number => (v == null ? 0 : parseFloat(v.toString()))

/** Lo que la simulación promete para un pago, y lo que la verificación posterior compara. */
interface Fila {
  id: string
  createdAt: Date
  bruto: number
  marca: string
  ranura: Ranura | null
  ranuraDeLaTarifa: Ranura | null
  tipo: string
  estado: Clasificacion
  previo?: ReturnType<typeof recomputeEconomics>
}

async function main(): Promise<void> {
  const aplicar = process.argv.includes('--apply')
  const merchantId = leerValor('--merchant')
  const actor = leerValor('--actor') ?? null
  const host = hostDeLaBase()

  console.log(`Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}\n`)

  if (!merchantId) {
    console.error('Falta --merchant <merchantAccountId>: sin él no hay alcance y no se lee nada.')
    throw new Rechazo(2)
  }

  // El candado del host se comprueba ANTES de tocar la base: si el operador se equivocó de base, no
  // queremos ni haberla leído.
  if (aplicar) {
    const confirmado = leerValor('--confirm-host')
    if (confirmado !== host) {
      console.error('🔴 No se escribió NADA.')
      console.error(`Para escribir en esta base hay que repetir su host exacto:  --confirm-host ${host}`)
      console.error(confirmado === undefined ? 'No recibí --confirm-host.' : `Recibí «${confirmado}».`)
      throw new Rechazo(2)
    }
  }

  const merchant = await prisma.merchantAccount.findUnique({
    where: { id: merchantId },
    select: { id: true, alias: true, displayName: true, active: true, provider: { select: { name: true } } },
  })
  if (!merchant) {
    console.error(`No existe MerchantAccount ${merchantId} en esta base.`)
    throw new Rechazo(2)
  }
  console.log(
    `Merchant: ${merchant.displayName ?? merchant.alias ?? merchant.id} · ${merchant.provider.name}${merchant.active ? '' : ' · INACTIVO'}\n`,
  )

  const pagos = await prisma.payment.findMany({
    where: {
      merchantAccountId: merchantId,
      status: 'COMPLETED',
      originSystem: OriginSystem.AVOQADO,
      method: { not: PaymentMethod.CASH },
      transactionCost: { is: null },
    },
    select: {
      id: true,
      venueId: true,
      amount: true,
      tipAmount: true,
      method: true,
      cardBrand: true,
      type: true,
      processorData: true,
      createdAt: true,
      merchantAccountId: true,
    },
    orderBy: { createdAt: 'asc' },
    take: TOPE + 1,
  })

  const truncado = pagos.length > TOPE
  if (truncado) pagos.length = TOPE

  if (pagos.length === 0) {
    console.log('No hay cobros de este merchant sin TransactionCost. Nada que recalcular.\n')
    return
  }

  // Una consulta de configuración por NEGOCIO, no por pago.
  //
  // 🔴 Un negocio SIN configuración de pagos no aborta la corrida: sus cobros se
  // clasifican como SIN_CONFIG_DE_PAGOS y los de los demás negocios se reparan igual.
  // Abortar era el comportamiento original y lo destapó correrlo contra datos reales:
  // un merchant puede servir a varios negocios y uno mal configurado los tumbaba a todos.
  const ranuraPorVenue = new Map<string, Ranura | null>()
  for (const venueId of new Set(pagos.map(p => p.venueId))) {
    const efectiva = await getEffectivePaymentConfig(venueId)
    if (!efectiva) {
      ranuraPorVenue.set(venueId, null)
      continue
    }
    const c = efectiva.config
    ranuraPorVenue.set(
      venueId,
      resolverRanura(
        { primaryAccountId: c.primaryAccountId, secondaryAccountId: c.secondaryAccountId, tertiaryAccountId: c.tertiaryAccountId },
        merchantId,
      ),
    )
  }

  const filas: Fila[] = []
  for (const p of pagos) {
    const bruto = num(p.amount) + num(p.tipAmount)
    const ranura = ranuraPorVenue.get(p.venueId) ?? null
    const internacional = Boolean((p.processorData as { isInternational?: boolean } | null)?.isInternational)
    const tipo = determineTransactionCardType(p.method, p.cardBrand, internacional)

    const costo = ranura ? await findActiveProviderCostStructure(merchantId, p.createdAt) : null

    // Espejo del respaldo del servicio: una ranura sin tarifa propia cae a PRIMARY antes de rendirse.
    let ranuraDeLaTarifa: Ranura | null = ranura
    let tarifa = ranura ? await findActiveVenuePricingStructure(p.venueId, ranura, p.createdAt) : null
    if (ranura && !tarifa && ranura !== 'PRIMARY') {
      ranuraDeLaTarifa = 'PRIMARY'
      tarifa = await findActiveVenuePricingStructure(p.venueId, 'PRIMARY', p.createdAt)
    }
    if (!tarifa) ranuraDeLaTarifa = null

    const estado = clasificarPago({ bruto, hayConfigDePagos: ranura !== null, costoVigente: costo, tarifaVigente: tarifa })
    filas.push({
      id: p.id,
      createdAt: p.createdAt,
      bruto,
      marca: p.cardBrand ?? p.method,
      ranura,
      ranuraDeLaTarifa,
      tipo,
      estado,
      previo:
        estado === 'LISTO'
          ? recomputeEconomics({
              amount: bruto,
              transactionType: tipo,
              venuePricing: tarifa as unknown as RateStructureLike,
              providerCost: costo as unknown as RateStructureLike,
            })
          : undefined,
    })
  }

  imprimirPlan(filas, truncado)

  const listos = filas.filter(f => f.estado === 'LISTO')

  if (!aplicar) {
    console.log('Simulación: no se tocó nada.')
    if (listos.length > 0) {
      console.log(
        `Para aplicarlo:  npx tsx scripts/backfill-transaction-costs-por-merchant.ts --merchant ${merchantId} --apply --confirm-host ${host}`,
      )
    }
    console.log()
    return
  }

  if (listos.length === 0) {
    console.log('No hay ni un cobro recalculable hoy: no se escribió nada.\n')
    return
  }

  let recalculados = 0
  let fallidos = 0
  const descuadres: string[] = []

  for (const f of listos) {
    try {
      const r = await createTransactionCost(f.id)
      if (!r) {
        fallidos++
        console.log(`  ⏭  ${f.id} — createTransactionCost lo declaró no elegible (devolvió null)`)
        continue
      }

      // Espejo EXACTO de lo que el camino de la TPV persiste tras un cálculo exitoso.
      if (r.feeAmount > 0) {
        await prisma.payment.update({ where: { id: f.id }, data: { feeAmount: r.feeAmount, netAmount: r.netAmount } })
        await prisma.venueTransaction.updateMany({
          where: { paymentId: f.id },
          data: { feeAmount: r.feeAmount, netAmount: r.netAmount, netSettlementAmount: r.netAmount },
        })
      }

      await logAction({
        staffId: actor,
        venueId: pagos.find(p => p.id === f.id)!.venueId,
        action: 'TRANSACTION_COST_BACKFILLED',
        entity: 'TransactionCost',
        entityId: r.transactionCost.id,
        data: {
          source: 'backfill-transaction-costs-por-merchant.ts',
          paymentId: f.id,
          merchantAccountId: merchantId,
          reason: 'El merchant no tenía ProviderCostStructure vigente a la fecha del cobro (Step 3 de createTransactionCost falló)',
          grossAmount: f.bruto,
          feeAmount: r.feeAmount,
          netAmount: r.netAmount,
        },
      })

      recalculados++
      console.log(`  ✅ ${f.id} · ${pesos(f.bruto)} → comisión ${pesos(r.feeAmount)} · neto ${pesos(r.netAmount)}`)
    } catch (err) {
      fallidos++
      console.log(`  ❌ ${f.id} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── verificación: releer lo escrito y compararlo con lo prometido ──────────
  const escritos = await prisma.payment.findMany({
    where: { id: { in: listos.map(f => f.id) } },
    select: {
      id: true,
      feeAmount: true,
      netAmount: true,
      transactionCost: { select: { venueChargeAmount: true, providerCostAmount: true, grossProfit: true } },
    },
  })
  const porId = new Map(escritos.map(e => [e.id, e]))

  for (const f of listos) {
    const e = porId.get(f.id)
    const p = f.previo!
    if (!e?.transactionCost) {
      descuadres.push(`${f.id}: quedó SIN TransactionCost`)
      continue
    }
    if (!cuadraRedondeado(num(e.feeAmount), p.feeAmount, 2))
      descuadres.push(`${f.id}: feeAmount escrito ${num(e.feeAmount)} ≠ previsto ${p.feeAmount}`)
    if (!cuadraRedondeado(num(e.netAmount), p.netAmount, 2))
      descuadres.push(`${f.id}: netAmount escrito ${num(e.netAmount)} ≠ previsto ${p.netAmount}`)
    if (!cuadraRedondeado(num(e.transactionCost.venueChargeAmount), p.venueChargeAmount, 4))
      descuadres.push(`${f.id}: venueChargeAmount escrito ${num(e.transactionCost.venueChargeAmount)} ≠ previsto ${p.venueChargeAmount}`)
    if (!cuadraRedondeado(num(e.transactionCost.providerCostAmount), p.providerCostAmount, 4))
      descuadres.push(`${f.id}: providerCostAmount escrito ${num(e.transactionCost.providerCostAmount)} ≠ previsto ${p.providerCostAmount}`)
  }

  console.log(`\nRecalculados ${recalculados} · fallidos ${fallidos}`)
  if (descuadres.length > 0) {
    console.log(`\n🔴 ${descuadres.length} DESCUADRE(S) entre lo prometido y lo escrito — revísalos antes de dar esto por bueno:`)
    for (const d of descuadres) console.log(`   ${d}`)
  } else {
    console.log('✅ Todo lo escrito cuadra con lo que la simulación prometió.')
  }

  const quedan = await prisma.payment.count({
    where: {
      merchantAccountId: merchantId,
      status: 'COMPLETED',
      originSystem: OriginSystem.AVOQADO,
      method: { not: PaymentMethod.CASH },
      transactionCost: { is: null },
    },
  })
  console.log(`Quedan ${quedan} cobros sin TransactionCost (deben ser sólo los que no eran recalculables o los que fallaron).\n`)
}

function imprimirPlan(filas: Fila[], truncado: boolean): void {
  const listos = filas.filter(f => f.estado === 'LISTO')

  console.table(
    filas.map(f => ({
      fecha: f.createdAt.toISOString().replace('T', ' ').slice(0, 19),
      marca: f.marca,
      tipo: f.tipo,
      bruto: pesos(f.bruto),
      estado: f.estado,
      'tasa negocio': f.previo ? tasa(f.previo.venueRate) : '—',
      comisión: f.previo ? pesos(f.previo.feeAmount) : '—',
      neto: f.previo ? pesos(f.previo.netAmount) : '—',
      'costo proveedor': f.previo ? pesos(f.previo.providerCostAmount + f.previo.providerFixedFee) : '—',
      margen: f.previo ? pesos(f.previo.grossProfit) : '—',
    })),
  )

  const suma = (sel: (f: Fila) => number): number => listos.reduce((a, f) => a + sel(f), 0)
  console.log(`\n${filas.length} cobros sin TransactionCost · ${listos.length} recalculables hoy`)
  for (const estado of ['EN_CERO', 'SIN_CONFIG_DE_PAGOS', 'SIN_COSTO_VIGENTE', 'SIN_TARIFA_VIGENTE'] as const) {
    const n = filas.filter(f => f.estado === estado).length
    if (n > 0) console.log(`   ⏭  ${n} en ${estado}`)
  }
  // Las tarifas que cayeron al respaldo se dicen: significa que la ranura del pago no tiene tarifa
  // propia y se le está cobrando con la de PRIMARY, que es un hueco de configuración.
  const respaldo = listos.filter(f => f.ranura !== null && f.ranura !== 'PRIMARY' && f.ranuraDeLaTarifa === 'PRIMARY').length
  if (respaldo > 0) console.log(`   ⚠️  ${respaldo} usarían la tarifa de PRIMARY porque su ranura no tiene una propia`)

  if (listos.length > 0) {
    console.log(
      `\nBruto ${pesos(suma(f => f.bruto))} · comisión al negocio ${pesos(suma(f => f.previo!.feeAmount))} · costo del proveedor ${pesos(
        suma(f => f.previo!.providerCostAmount + f.previo!.providerFixedFee),
      )} · margen ${pesos(suma(f => f.previo!.grossProfit))}\n`,
    )
  }
  if (truncado) console.log(`⚠️  La lista llegó al tope de ${TOPE}: hay más rezago. Vuelve a correr después de aplicar.\n`)
}

/** Drena la salida antes de salir: hacia un pipe, `process.stderr` es asíncrono y un exit seco se
 *  come justo el renglón que dice qué host hay que repetir. */
function drenar(flujo: NodeJS.WriteStream): Promise<void> {
  return new Promise(resolve => (flujo.write('') ? resolve() : flujo.once('drain', () => resolve())))
}

main()
  .catch(err => {
    if (err instanceof Rechazo) {
      process.exitCode = err.codigo
      return
    }
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    await Promise.all([drenar(process.stdout), drenar(process.stderr)])
  })
