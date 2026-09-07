/**
 * Reasignar cobros a la orden que de verdad pagó — corrida A MANO con un plan explícito.
 *
 *   npx tsx scripts/reasignar-cobro-a-su-orden.ts --plan scripts/planes/<plan>.json                 # simulación (sólo lee)
 *   npx tsx scripts/reasignar-cobro-a-su-orden.ts --plan <plan> --base render                        # simulación contra RENDER_DATABASE_URL
 *   npx tsx scripts/reasignar-cobro-a-su-orden.ts --plan <plan> --base render --apply --confirm-host <host>
 *
 * Misma disciplina que `reconciliar-pagadas-pero-abiertas.ts`:
 *   · La simulación es de sólo lectura POR CONSTRUCCIÓN: las únicas escrituras viven en
 *     `aplicarReasignacion` (src/services/shared/reasignarCobro.ts) y sólo se llama con --apply.
 *   · Escribir exige repetir el host exacto de la base en --confirm-host. Ninguna URL se imprime.
 *   · Cada caso se valida con la MISMA aritmética del saldo que usa el cobro (`computeOrderBalance`)
 *     y se cierra por `reconcileOrderFromPayments`, el mismo camino del cobro. Nada duplicado aquí.
 *
 * `--base render` cambia DATABASE_URL por RENDER_DATABASE_URL ANTES de cargar el cliente de Prisma —
 * por eso todo lo que toca la base se importa DINÁMICAMENTE en `main`— para no tener que exportar la
 * URL de producción en la terminal. Sin `--base`, se usa DATABASE_URL tal cual (la base local).
 *
 * Lo que NO hace, y el script lo avisa: no descuenta inventario de la orden restaurada (reconciliar
 * con un cobro que ya cubre la cuenta no dispara la deducción, a propósito).
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { Prisma } from '@prisma/client'
import {
  aplicarReasignacion,
  validarReasignacion,
  type CasoReasignacion,
  type CobroFoto,
  type DepsAplicar,
  type OrdenFoto,
  type Veredicto,
} from '../src/services/shared/reasignarCobro'

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

interface Plan {
  descripcion?: string
  casos: CasoReasignacion[]
}

function leerPlan(): Plan {
  const ruta = leerValor('--plan')
  if (!ruta) {
    console.error('Falta --plan <archivo.json> con los casos a reasignar.')
    throw new Rechazo(2)
  }
  let plan: Plan
  try {
    plan = JSON.parse(readFileSync(ruta, 'utf8')) as Plan
  } catch (e) {
    console.error(`No pude leer el plan «${ruta}»: ${(e as Error).message}`)
    throw new Rechazo(2)
  }
  if (!Array.isArray(plan.casos) || plan.casos.length === 0) {
    console.error('El plan no trae casos.')
    throw new Rechazo(2)
  }
  for (const [i, c] of plan.casos.entries()) {
    for (const campo of ['paymentId', 'deOrden', 'aOrden', 'motivo'] as const) {
      if (typeof c[campo] !== 'string' || c[campo].trim() === '') {
        console.error(`Caso ${i + 1}: falta «${campo}».`)
        throw new Rechazo(2)
      }
    }
  }
  return plan
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
const horaMx = (d: Date): string => new Date(d.getTime() - 6 * 3_600_000).toISOString().slice(5, 19).replace('T', ' ')

const SELECT_ORDEN = {
  id: true,
  venueId: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  shiftId: true,
  completedAt: true,
  subtotal: true,
  discountAmount: true,
  serviceChargeAmount: true,
  total: true,
  tipAmount: true,
  payments: {
    where: { status: 'COMPLETED' as const },
    select: { id: true, status: true, type: true, amount: true, tipAmount: true },
  },
} as const

type OrdenCruda = {
  id: string
  venueId: string
  orderNumber: string
  status: string
  paymentStatus: string
  shiftId: string | null
  completedAt: Date | null
  subtotal: Prisma.Decimal
  discountAmount: Prisma.Decimal | null
  serviceChargeAmount: Prisma.Decimal | null
  total: Prisma.Decimal
  tipAmount: Prisma.Decimal
  payments: Array<{ id: string; status: string; type: string | null; amount: Prisma.Decimal; tipAmount: Prisma.Decimal }>
}

const aFoto = (o: OrdenCruda): OrdenFoto & { total: Prisma.Decimal; tipGuardado: Prisma.Decimal } => ({
  id: o.id,
  venueId: o.venueId,
  orderNumber: o.orderNumber,
  status: o.status,
  paymentStatus: o.paymentStatus,
  shiftId: o.shiftId,
  completedAt: o.completedAt,
  subtotal: o.subtotal,
  discountAmount: o.discountAmount,
  serviceChargeAmount: o.serviceChargeAmount,
  cobros: o.payments,
  total: o.total,
  tipGuardado: o.tipAmount,
})

interface Cargado {
  caso: CasoReasignacion
  cobro?: CobroFoto & { method: string }
  origen?: ReturnType<typeof aFoto>
  destino?: ReturnType<typeof aFoto>
  negocio?: string
  faltante?: string
}

type PrismaCliente = import('@prisma/client').PrismaClient

async function cargarCaso(prisma: PrismaCliente, caso: CasoReasignacion): Promise<Cargado> {
  const cobro = await prisma.payment.findUnique({
    where: { id: caso.paymentId },
    select: {
      id: true,
      venueId: true,
      orderId: true,
      status: true,
      type: true,
      amount: true,
      tipAmount: true,
      shiftId: true,
      createdAt: true,
      method: true,
    },
  })
  if (!cobro) return { caso, faltante: `el cobro ${caso.paymentId} no existe en esta base` }
  const [origen, destino, negocio] = await Promise.all([
    prisma.order.findUnique({ where: { id: cobro.orderId }, select: SELECT_ORDEN }),
    prisma.order.findFirst({ where: { venueId: cobro.venueId, orderNumber: caso.aOrden }, select: SELECT_ORDEN }),
    prisma.venue.findUnique({ where: { id: cobro.venueId }, select: { name: true } }),
  ])
  if (!origen) return { caso, faltante: `la orden de origen del cobro (${cobro.orderId}) no existe` }
  if (!destino) return { caso, faltante: `no hay orden ${caso.aOrden} en el negocio del cobro` }
  return {
    caso,
    cobro: { ...cobro, type: cobro.type as string | null, status: cobro.status as string },
    origen: aFoto(origen as OrdenCruda),
    destino: aFoto(destino as OrdenCruda),
    negocio: negocio?.name ?? cobro.venueId,
  }
}

function imprimirCaso(i: number, c: Cargado, veredicto: Veredicto | undefined): void {
  console.log(`\n── Caso ${i + 1}: ${c.caso.paymentId}`)
  console.log(`   ${c.caso.motivo}`)
  if (c.faltante || !c.cobro || !c.origen || !c.destino) {
    console.log(`   🔴 NO SE PUEDE EVALUAR: ${c.faltante ?? 'datos incompletos'}`)
    return
  }
  console.log(`   negocio: ${c.negocio}`)
  console.log(
    `   cobro:   ${pesos(c.cobro.amount)} + propina ${pesos(c.cobro.tipAmount)} · ${c.cobro.method} · ${horaMx(c.cobro.createdAt)} MX · turno ${c.cobro.shiftId ?? '—'}`,
  )
  const linea = (o: ReturnType<typeof aFoto>) =>
    `${o.orderNumber} ${o.status}/${o.paymentStatus} · total guardado ${pesos(o.total)} (propina ${pesos(o.tipGuardado)}) · ${o.cobros.length} cobro(s)` +
    (o.completedAt ? ` · cerrada ${horaMx(o.completedAt)} MX` : '')
  console.log(`   origen:  ${linea(c.origen)}`)
  console.log(`   destino: ${linea(c.destino)}`)
  if (!veredicto) return
  if (veredicto.ok) {
    const r = veredicto.resumen
    console.log(
      `   ✅ SE PUEDE MOVER — cuenta del destino ${pesos(r.baseDestino)} · cobro+propina ${pesos(r.pagoMasPropina)} · saldo del origen después ${pesos(r.saldoOrigenDespues)}` +
        (r.destinoCambiaEstado ? ' · el destino pasa de CANCELLED a COMPLETED/PAID' : ''),
    )
  } else {
    console.log('   🔴 NO SE MUEVE:')
    for (const m of veredicto.motivos) console.log(`      · ${m}`)
  }
}

async function main(): Promise<void> {
  const plan = leerPlan()
  elegirBase()
  const host = hostDeLaBase()
  const aplicar = process.argv.includes('--apply')
  console.log(`Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}  casos: ${plan.casos.length}`)
  if (plan.descripcion) console.log(plan.descripcion)

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
  const { reconcileOrderFromPayments } = await import('../src/services/tpv/payment.tpv.service')
  const { logAction } = await import('../src/services/dashboard/activity-log.service')

  try {
    const cargados: Cargado[] = []
    for (const caso of plan.casos) cargados.push(await cargarCaso(prisma, caso))

    const veredictos = cargados.map(c =>
      c.cobro && c.origen && c.destino ? validarReasignacion(c.caso, c.cobro, c.origen, c.destino) : undefined,
    )
    cargados.forEach((c, i) => imprimirCaso(i, c, veredictos[i]))
    const aplicables = cargados.filter((_, i) => veredictos[i]?.ok)
    console.log(`\n${aplicables.length} de ${cargados.length} caso(s) se pueden aplicar.`)

    if (!aplicar) {
      console.log('Simulación: no se tocó nada.')
      if (aplicables.length > 0) {
        const base = leerValor('--base')
        console.log(
          `Para aplicarlos:  npx tsx scripts/reasignar-cobro-a-su-orden.ts --plan ${leerValor('--plan')}${base ? ` --base ${base}` : ''} --apply --confirm-host ${host}`,
        )
      }
      return
    }

    const deps: DepsAplicar = {
      enTransaccion: fn =>
        prisma.$transaction(async tx =>
          fn({
            moverCobro: async (paymentId, de, a) =>
              (await tx.payment.updateMany({ where: { id: paymentId, orderId: de, status: 'COMPLETED' }, data: { orderId: a } })).count,
            prepararDestino: async (ordenId, data) => {
              await tx.order.update({ where: { id: ordenId }, data })
            },
          }),
        ),
      reconciliar: id => reconcileOrderFromPayments(id),
      fijarCompletadoEn: async (id, cuando) => {
        await prisma.order.update({ where: { id }, data: { completedAt: cuando } })
      },
      bitacora: async p => {
        await logAction({
          staffId: null,
          venueId: p.venueId,
          action: p.action,
          entity: p.entity,
          entityId: p.entityId,
          data: p.data as Prisma.InputJsonValue,
        })
      },
    }

    let hechos = 0
    let fallidos = 0
    for (const c of aplicables) {
      if (!c.cobro || !c.origen || !c.destino) continue
      try {
        const r = await aplicarReasignacion(deps, c.caso, c.cobro, c.origen, c.destino)
        if (r.ok) {
          hechos++
          console.log(`✅ ${c.caso.paymentId}: movido de ${c.origen.orderNumber} a ${c.destino.orderNumber}`)
        } else {
          fallidos++
          console.log(`🔴 ${c.caso.paymentId}: rechazado al aplicar — ${r.motivos.join(' · ')}`)
        }
      } catch (e) {
        fallidos++
        console.log(`🔴 ${c.caso.paymentId}: falló — ${(e as Error).message}`)
      }
    }
    console.log(`\nAplicados ${hechos} · fallidos ${fallidos}`)

    console.log('\nEstado DESPUÉS:')
    for (const c of cargados) {
      const de = await cargarCaso(prisma, c.caso)
      if (de.cobro && de.origen && de.destino) imprimirCaso(cargados.indexOf(c), de, undefined)
    }
    if (hechos > 0) {
      console.log(
        '\n⚠️  El inventario de las órdenes restauradas NO se descontó (reconciliar con un cobro que ya cubre la cuenta no deduce). Si el negocio lleva inventario de esos productos, ajústalo aparte.',
      )
    }
  } finally {
    await prisma.$disconnect()
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
