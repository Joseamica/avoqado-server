/**
 * Cancelar las órdenes FANTASMA que deja un cobro fallido a la terminal (corrección de datos).
 *
 *   npx tsx scripts/cancelar-ordenes-fantasma.ts --venue testarudo-cafe                        # simulación contra la base local
 *   npx tsx scripts/cancelar-ordenes-fantasma.ts --venue testarudo-cafe --base render          # simulación contra RENDER_DATABASE_URL
 *   npx tsx scripts/cancelar-ordenes-fantasma.ts --venue testarudo-cafe --base render --apply --confirm-host <host>
 *
 * Opcionales: `--desde YYYY-MM-DD` (default: 30 días atrás) · `--edad-min <minutos>` (default 180).
 *
 * Qué corrige y por qué (medido en producción el 15-sep-2026, Asana «DASHBOARD y APP - Diferencias
 * en ventas»): el POS crea la orden en el servidor al entrar a «Cobrar»; si el cobro a la terminal
 * falla (422 / 409 «terminal busy» / DELETE rechazado con 409 «hay un cobro en curso»), la orden se
 * queda CONFIRMED sin un solo pago y el cajero rehace la venta como orden nueva. El dinero entró UNA
 * vez; la orden abandonada infla «Ventas brutas» de la app y de Reportes → Resumen de ventas, que
 * suman `Order.subtotal` de toda orden no cancelada. Testarudo: 42 desde el 2-sep ($7,015), 35 con
 * su gemela pagada en menos de 5 minutos. La fuente está corregida en `main` de Android/iOS
 * (cancelación durable, 12-sep) pero sin publicar: mientras, esto limpia lo que ya quedó.
 *
 * Cómo decide: `clasificarOrdenFantasma` (`src/services/shared/ordenesFantasma.ts`, con pruebas) —
 * estricta a propósito: CONFIRMED + PENDING + CERO filas de Payment + sin cobro a terminal vivo +
 * sin mesa + nunca tocada después de crearse + más vieja que la edad mínima. La gemela es sólo
 * informativa para la lista que aprueba el founder. Espeja lo que escribe `cancelOrder`
 * (`order.mobile.service.ts`): `status = CANCELLED`, `specialRequests = "Cancelled: <motivo>"` y
 * bitácora `ORDER_CANCELLED`; no hay mesa que liberar ni inventario que devolver (nunca se dedujo:
 * la deducción es al pagar).
 *
 * 🔴 Escribir exige repetir el host de la base en la línea de comandos: es la única defensa contra
 * un `DATABASE_URL` heredado de otra pestaña apuntando a la base que no era. `--base render` cambia
 * DATABASE_URL por RENDER_DATABASE_URL ANTES de cargar el cliente de Prisma; ninguna URL se imprime.
 * A propósito NO importa `scripts/_solo-base-local.ts`: el trabajo de este script incluye producción.
 *
 * La simulación es de sólo lectura POR CONSTRUCCIÓN: sin `--apply` la transacción que escribe ni
 * siquiera se construye. Al aplicar, TODO va en UNA transacción con `updateMany` condicionado a que la
 * orden siga exactamente en el estado que se listó (CAS): si una sola cambió por debajo, se aborta
 * entera y no se cancela nada. La bitácora se escribe DESPUÉS del commit con `logAction`, que usa el
 * cliente global y nunca lanza (una bitácora que falla no puede deshacer una cancelación buena).
 *
 * Autorizado por el founder el 15-sep-2026 («Sí, las dos cosas») para Testarudo.
 */
import 'dotenv/config'
import { Prisma } from '@prisma/client'
import {
  clasificarOrdenFantasma,
  emparejarGemela,
  EDAD_MINIMA_MIN,
  SOLICITUDES_VIVAS,
  VENTANA_GEMELA_SEG,
  type Gemela,
  type OrdenFoto,
  type PagoFoto,
  type Veredicto,
} from '../src/services/shared/ordenesFantasma'

/** Tope de candidatas por corrida: la clase medida es de decenas; si se llega al tope se avisa. */
const TOPE_CANDIDATAS = 500
/** Tope de cobros que se leen para emparejar gemelas (Testarudo: ~120 por día). */
const TOPE_PAGOS = 20_000
const RE_FECHA_CIVIL = /^\d{4}-\d{2}-\d{2}$/
const MOTIVO = 'Orden abandonada tras un cobro fallido a la terminal; la venta se cobró como orden nueva (limpieza 2026-09-15)'

/**
 * Rechazo de seguridad. El motivo se imprime donde se detecta; esto sólo lleva el código de salida
 * hasta la cadena final, que drena stdout/stderr antes de salir (un `process.exit` seco hacia un pipe
 * se come el renglón con el host que hay que repetir).
 */
class Rechazo extends Error {
  constructor(readonly codigo: number) {
    super(`rechazo (${codigo})`)
    this.name = 'Rechazo'
  }
}

function leerValor(bandera: string): string | undefined {
  const i = process.argv.indexOf(bandera)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function leerDesde(): Date {
  const crudo = leerValor('--desde')
  if (crudo === undefined) return new Date(Date.now() - 30 * 24 * 3_600_000)
  if (!RE_FECHA_CIVIL.test(crudo)) {
    console.error(`--desde espera una fecha YYYY-MM-DD (recibí «${crudo}»). No se leyó nada.`)
    throw new Rechazo(2)
  }
  // Medianoche de México del día civil pedido: la clase es de mostrador mexicano y el rango es sólo
  // una ventana de búsqueda, no un cierre contable.
  return new Date(`${crudo}T00:00:00.000-06:00`)
}

function leerEdadMinima(): number {
  const crudo = leerValor('--edad-min')
  if (crudo === undefined) return EDAD_MINIMA_MIN
  const n = Number(crudo)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--edad-min espera un entero de minutos ≥ 1 (recibí «${crudo}»).`)
    throw new Rechazo(2)
  }
  return n
}

/** Elige la base ANTES de que exista el cliente de Prisma. */
function elegirBase(): void {
  const base = leerValor('--base')
  if (base === undefined || base === 'local') return
  if (base !== 'render') {
    console.error(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
    throw new Rechazo(2)
  }
  const url = process.env.RENDER_DATABASE_URL
  if (!url) {
    console.error('--base render: falta RENDER_DATABASE_URL en el entorno.')
    throw new Rechazo(2)
  }
  process.env.DATABASE_URL = url
}

/** Host de la base a la que ESTA corrida se va a conectar. Nunca se imprime la cadena completa. */
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
  if (!host) {
    console.error('DATABASE_URL no declara un host (¿conexión por socket?): no hay nada que repetir en --confirm-host.')
    throw new Rechazo(2)
  }
  return host
}

const pesos = (v: Prisma.Decimal | number | string | null | undefined): string => `$${new Prisma.Decimal((v ?? 0).toString()).toFixed(2)}`
const horaMx = (d: Date): string => new Date(d.getTime() - 6 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ')

type Candidata = OrdenFoto & { tipAmount: Prisma.Decimal; source: string; veredicto: Veredicto; gemela: Gemela | null }

async function main(): Promise<void> {
  const venueRef = leerValor('--venue')
  if (!venueRef) {
    console.error('Falta --venue <slug o id>.')
    throw new Rechazo(2)
  }
  const desde = leerDesde()
  const edadMinima = leerEdadMinima()
  elegirBase()
  const host = hostDeLaBase()
  const aplicar = process.argv.includes('--apply')
  console.log(
    `Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}  venue: ${venueRef}  desde: ${desde.toISOString()}  edad mínima: ${edadMinima} min`,
  )

  if (aplicar) {
    const confirmado = leerValor('--confirm-host')
    if (confirmado !== host) {
      console.error('🔴 No se escribió NADA.')
      console.error(`Para escribir en esta base hay que repetir su host exacto:  --confirm-host ${host}`)
      console.error(confirmado === undefined ? 'No recibí --confirm-host.' : `Recibí «${confirmado}».`)
      throw new Rechazo(2)
    }
  }

  // Imports dinámicos: el cliente de Prisma lee DATABASE_URL al cargarse, y `elegirBase` ya la eligió.
  const { default: prisma } = await import('../src/utils/prismaClient')
  const { logAction } = await import('../src/services/dashboard/activity-log.service')

  try {
    const venue = await prisma.venue.findFirst({
      where: { OR: [{ slug: venueRef }, { id: venueRef }] },
      select: { id: true, name: true, slug: true },
    })
    if (!venue) {
      console.error(`No existe un venue con slug o id «${venueRef}».`)
      throw new Rechazo(2)
    }
    console.log(`Venue: ${venue.name} (${venue.slug}, ${venue.id})`)

    const ahora = new Date()
    // Selects explícitos a propósito: el árbol puede llevar columnas que la base destino aún no tiene.
    const crudas = await prisma.order.findMany({
      where: {
        venueId: venue.id,
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        tableId: null,
        createdAt: { gte: desde },
        payments: { none: {} },
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        subtotal: true,
        tipAmount: true,
        tableId: true,
        source: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { payments: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: TOPE_CANDIDATAS,
    })
    if (crudas.length === TOPE_CANDIDATAS)
      console.log(`⚠️  Se llegó al tope de ${TOPE_CANDIDATAS} candidatas: puede haber más; repite después de aplicar.`)
    if (crudas.length === 0) {
      console.log('No hay órdenes CONFIRMED/PENDING sin pago en la ventana. Nada que hacer.')
      return
    }

    const ids = crudas.map(o => o.id)
    const vivas = await prisma.terminalPaymentRequest.groupBy({
      by: ['orderId'],
      where: { orderId: { in: ids }, status: { in: [...SOLICITUDES_VIVAS] } },
      _count: { _all: true },
    })
    const vivasPorOrden = new Map(vivas.map(v => [v.orderId as string, v._count._all]))

    const primera = crudas[0].createdAt
    const ultima = crudas[crudas.length - 1].createdAt
    const pagos = await prisma.payment.findMany({
      where: {
        venueId: venue.id,
        status: 'COMPLETED',
        type: { not: 'REFUND' },
        createdAt: { gte: primera, lte: new Date(ultima.getTime() + VENTANA_GEMELA_SEG * 1_000) },
      },
      select: {
        id: true,
        orderId: true,
        status: true,
        type: true,
        method: true,
        createdAt: true,
        order: { select: { orderNumber: true, source: true, subtotal: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: TOPE_PAGOS,
    })
    if (pagos.length === TOPE_PAGOS)
      console.log(
        `⚠️  Se llegó al tope de ${TOPE_PAGOS} cobros al buscar gemelas: alguna gemela puede no aparecer (sólo afecta la lectura, no la decisión).`,
      )
    const pagosFoto: PagoFoto[] = pagos
      .filter(p => p.orderId && p.order)
      .map(p => ({
        id: p.id,
        orderId: p.orderId as string,
        orderNumber: p.order!.orderNumber,
        orderSource: String(p.order!.source),
        orderSubtotal: p.order!.subtotal,
        status: String(p.status),
        type: String(p.type),
        method: String(p.method),
        createdAt: p.createdAt,
      }))

    const candidatas: Candidata[] = crudas.map(o => {
      const foto: OrdenFoto = {
        id: o.id,
        orderNumber: o.orderNumber,
        status: String(o.status),
        paymentStatus: String(o.paymentStatus),
        subtotal: o.subtotal,
        tableId: o.tableId,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        pagos: o._count.payments,
        solicitudesVivas: vivasPorOrden.get(o.id) ?? 0,
      }
      return {
        ...foto,
        tipAmount: o.tipAmount,
        source: String(o.source),
        veredicto: clasificarOrdenFantasma(foto, ahora, edadMinima),
        gemela: emparejarGemela(foto, pagosFoto),
      }
    })

    console.log(
      `\n${'#'.padStart(3)}  ${'orden'.padEnd(20)} ${'creada (MX)'.padEnd(12)} ${'subtotal'.padStart(10)} ${'propina'.padStart(8)}  ${'origen'.padEnd(16)} veredicto`,
    )
    candidatas.forEach((c, i) => {
      const v = c.veredicto.fantasma ? 'FANTASMA' : `no: ${c.veredicto.motivo}`
      const g = c.gemela ? `gemela ${c.gemela.orderNumber} (${c.gemela.method}, ${c.gemela.source}, +${c.gemela.segundos}s)` : 'sin gemela'
      console.log(
        `${String(i + 1).padStart(3)}  ${c.orderNumber.padEnd(20)} ${horaMx(c.createdAt).padEnd(12)} ${pesos(c.subtotal).padStart(10)} ${pesos(c.tipAmount).padStart(8)}  ${c.source.padEnd(16)} ${v} · ${g}`,
      )
    })

    const fantasmas = candidatas.filter(c => c.veredicto.fantasma)
    const conGemela = fantasmas.filter(c => c.gemela).length
    const subtotal = fantasmas.reduce((acc, c) => acc.plus(c.subtotal), new Prisma.Decimal(0))
    console.log(
      `\n${fantasmas.length} de ${candidatas.length} candidata(s) son fantasma · subtotal ${pesos(subtotal)} · con gemela ${conGemela} · sin gemela ${fantasmas.length - conGemela}`,
    )

    if (!aplicar) {
      console.log('Simulación: no se tocó nada.')
      if (fantasmas.length > 0) {
        const base = leerValor('--base')
        const extra = `${leerValor('--desde') ? ` --desde ${leerValor('--desde')}` : ''}${leerValor('--edad-min') ? ` --edad-min ${leerValor('--edad-min')}` : ''}`
        console.log(
          `Para cancelarlas:  npx tsx scripts/cancelar-ordenes-fantasma.ts --venue ${venueRef}${base ? ` --base ${base}` : ''}${extra} --apply --confirm-host ${host}`,
        )
      }
      return
    }
    if (fantasmas.length === 0) {
      console.log('Nada que aplicar.')
      return
    }

    // 🔴 Todo o nada: cada updateMany exige que la orden siga EXACTAMENTE como se listó. Una sola
    // que haya cambiado por debajo (un pago que aterrizó, otra sesión que la tocó) aborta la
    // transacción entera: es preferible no cancelar ninguna a cancelar una con dinero encima.
    await prisma.$transaction(
      async tx => {
        for (const c of fantasmas) {
          const motivo = c.gemela ? `${MOTIVO}; gemela ${c.gemela.orderNumber}` : `${MOTIVO}; sin gemela detectada`
          const r = await tx.order.updateMany({
            where: {
              id: c.id,
              venueId: venue.id,
              status: 'CONFIRMED',
              paymentStatus: 'PENDING',
              updatedAt: c.updatedAt,
              payments: { none: {} },
            },
            data: { status: 'CANCELLED', specialRequests: `Cancelled: ${motivo}` },
          })
          if (r.count !== 1) {
            throw new Error(
              `La orden ${c.orderNumber} (${c.id}) cambió por debajo (updateMany=${r.count}): se aborta TODO, no se canceló ninguna.`,
            )
          }
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    )
    console.log(`\n✅ ${fantasmas.length} orden(es) canceladas en una sola transacción.`)

    // Bitácora DESPUÉS del commit: `logAction` usa el cliente global y nunca lanza.
    for (const c of fantasmas) {
      await logAction({
        action: 'ORDER_CANCELLED',
        entity: 'Order',
        entityId: c.id,
        venueId: venue.id,
        data: {
          reason: MOTIVO,
          script: 'scripts/cancelar-ordenes-fantasma.ts',
          orderNumber: c.orderNumber,
          subtotal: c.subtotal.toString(),
          tipAmount: c.tipAmount.toString(),
          gemela: c.gemela,
        },
      })
    }
    console.log(`Bitácora: ${fantasmas.length} ORDER_CANCELLED.`)

    console.log('\nEstado DESPUÉS:')
    const despues = await prisma.order.findMany({
      where: { id: { in: fantasmas.map(c => c.id) } },
      select: { orderNumber: true, status: true, paymentStatus: true, specialRequests: true },
      orderBy: { createdAt: 'asc' },
    })
    for (const o of despues)
      console.log(`  ${o.orderNumber.padEnd(20)} ${String(o.status)}/${String(o.paymentStatus)}  ${o.specialRequests ?? ''}`)
    const sinCancelar = despues.filter(o => String(o.status) !== 'CANCELLED').length
    if (sinCancelar > 0) console.log(`🔴 ${sinCancelar} orden(es) NO quedaron canceladas: revisa a mano.`)
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

function drenarFlujo(flujo: NodeJS.WriteStream): Promise<void> {
  if (flujo.writableLength === 0) return Promise.resolve()
  return new Promise(resolve => flujo.write('', () => resolve()))
}

main()
  .then(() => Promise.all([drenarFlujo(process.stdout), drenarFlujo(process.stderr)]))
  .then(() => process.exit(0))
  .catch(async e => {
    const codigo = e instanceof Rechazo ? e.codigo : 1
    if (!(e instanceof Rechazo)) console.error(e)
    await Promise.all([drenarFlujo(process.stdout), drenarFlujo(process.stderr)])
    process.exit(codigo)
  })
