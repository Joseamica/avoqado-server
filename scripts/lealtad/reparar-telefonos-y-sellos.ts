/**
 * Reparar teléfonos sin lada, el duplicado AUTORIZADO de Testarudo y los sellos perdidos de la tarjeta de lealtad
 * (corrección de datos, spec 2026-10-14 §3.6).
 *
 *   npx tsx scripts/lealtad/reparar-telefonos-y-sellos.ts                     # simulación contra DATABASE_URL (la local)
 *   npx tsx scripts/lealtad/reparar-telefonos-y-sellos.ts --base render       # simulación contra RENDER_DATABASE_URL
 *   npx tsx scripts/lealtad/reparar-telefonos-y-sellos.ts --base render --apply --confirm-host <host>
 *
 * Qué corrige (medido en prod el 14-oct-2026, sólo lectura):
 *   (a) El OTP guardaba «'+' + dígitos» sin lada: 71 clientes y 73 consumidores en 4 negocios con «+» + 10 dígitos. Pasan a
 *       «+52» + 10 (`normalizarTelefonoMx`). Si OTRO registro ya tiene ese «+52…», no se toca y se reporta.
 *   (b) 🔴 SÓLO el par autorizado por la spec (Testarudo: se queda `cmv192e9k0968os29qhgyn86h`, se desactiva
 *       `cmttavm9802bjpk2b6asriztj`), REVALIDADO dentro de la transacción: los dos sin sellos, ventas, reservas ni paquetes o
 *       créditos. Si algo no cuadra, no se toca y se dice por qué. Cualquier otro choque de teléfono SÓLO se reporta
 *       (auditoría A #5).
 *   (c) Los 3 sellos perdidos de Testarudo (22-sep, 27-sep y 14-oct): la MISMA regla del sello tardío sin el plazo de 24 h y
 *       el MISMO envoltorio que la liga tardía y el reconciliador (`otorgarLealtadRespetandoReembolsos`, B2: no otorga a una
 *       venta devuelta y revierte el sello si el reembolso entra mientras otorga). Cada venta se REVALIDA justo antes de
 *       otorgarse (saldada, no cancelada, sin reembolso, el cliente sigue primario). Reanudable: si una corrida se corta entre
 *       el sello y los puntos, la siguiente completa lo que falte (auditoría A #6). Sin fechar el sello en el pasado: si alguno
 *       sale sin sello por el tope de HOY, se dice y se vuelve a correr otro día.
 *
 * 🔴 Escribir exige repetir el host de la base: es la única defensa contra un DATABASE_URL heredado de otra pestaña.
 * `--base render` cambia DATABASE_URL por RENDER_DATABASE_URL ANTES de cargar Prisma; ninguna URL se imprime. Sin
 * `--base render`, el script se niega a correr si DATABASE_URL apunta a producción (producción sólo se pide explícita).
 * La simulación es de sólo lectura POR CONSTRUCCIÓN: sin `--apply` no se construye ninguna escritura.
 *
 * Sólo con el «sí, en prod» del founder, justo antes de correrlo.
 */
import 'dotenv/config'
import { Prisma } from '@prisma/client'
import {
  PAR_AUTORIZADO,
  completarLealtadDeVentas,
  decidirFusionAutorizada,
  decidirReparacionDeSello,
  planearTelefonos,
  revalidarVenta,
  type ChoqueDeTelefono,
  type DecisionDeFusion,
  type DecisionDeSello,
  type EstadoDeLealtad,
  type FilaTelefono,
  type ResumenCliente,
  type RevalidacionDeVenta,
  type VentaPorReparar,
} from '../../src/services/shared/reparacionLealtad'

const TOPE_FILAS = 5000
const SCRIPT = 'scripts/lealtad/reparar-telefonos-y-sellos.ts'
/** (c) Medido el 14-oct: ventas de Testarudo con cliente agregado 1.5-22 min después del cobro y sin sello. */
const SELLOS_PERDIDOS = {
  venueId: PAR_AUTORIZADO.venueId,
  ordenes: ['ORD-1790121567183', 'ORD-1790521271907', 'ORD-1792015738782'],
}

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

const hostDe = (url: string | undefined): string | null => {
  if (!url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/** Elige la base ANTES de que exista el cliente de Prisma. */
function elegirBase(): void {
  const base = leerValor('--base')
  if (base === undefined || base === 'local') {
    // 🔴 La base por defecto NUNCA es producción: producción se pide explícita con `--base render`.
    const host = hostDe(process.env.DATABASE_URL)
    const hostRender = hostDe(process.env.RENDER_DATABASE_URL)
    if (host && (host === hostRender || host.endsWith('.render.com'))) {
      console.error('🔴 DATABASE_URL apunta a producción y no pediste `--base render`. No se leyó ni se escribió nada.')
      throw new Rechazo(2)
    }
    return
  }
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

interface ReparacionDeSello {
  orderNumber: string
  orderId: string | null
  clienteId: string | null
  decision: DecisionDeSello
  /** Si no es elegible, por qué (la revalidación sin plazo). */
  porQueNo: string | null
  base: number
}

async function main(): Promise<void> {
  elegirBase()
  const host = hostDeLaBase()
  const aplicar = process.argv.includes('--apply')
  console.log(`Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}`)
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
  const { default: prisma } = await import('../../src/utils/prismaClient')
  const { logAction } = await import('../../src/services/dashboard/activity-log.service')
  const { venueHasFeatureAccess } = await import('../../src/services/access/basePlan.service')
  const { decideSaleStamp, esElegibleParaLealtad, fotoDeLaVenta, otorgarLealtadRespetandoReembolsos } = await import(
    '../../src/services/shared/loyaltyOnLateCustomer'
  )
  const { notifyCustomerPassUpdated } = await import('../../src/services/wallet/notifyPassUpdated.service')

  /** Todo lo que hace «vacío» o no a un cliente. Se usa al planear y OTRA VEZ dentro de la transacción que aplica. */
  const resumen = async (db: Prisma.TransactionClient, id: string): Promise<ResumenCliente | null> => {
    const c = await db.customer.findUnique({ where: { id }, select: { id: true, venueId: true, active: true, phone: true } })
    if (!c) return null
    // En serie a propósito: dentro de una transacción interactiva las consultas comparten UNA conexión.
    const sellos = await db.stampEvent.count({ where: { stampCard: { customerId: id } } })
    const ligas = await db.orderCustomer.count({ where: { customerId: id } })
    const heredadas = await db.order.count({ where: { customerId: id } })
    const reservas = await db.reservation.count({ where: { customerId: id } })
    const compras = await db.creditPackPurchase.count({ where: { customerId: id } })
    const movimientos = await db.creditTransaction.count({ where: { customerId: id } })
    return {
      id: c.id,
      venueId: c.venueId,
      active: c.active,
      phone: c.phone,
      sellos,
      ventas: ligas + heredadas,
      reservas,
      paquetes: compras + movimientos,
    }
  }
  const decidirPar = async (db: Prisma.TransactionClient): Promise<DecisionDeFusion> => {
    const viejo = await resumen(db, PAR_AUTORIZADO.retirar)
    const nuevo = await resumen(db, PAR_AUTORIZADO.conservar)
    return viejo && nuevo ? decidirFusionAutorizada(viejo, nuevo) : { decision: 'SOLO_REPORTAR', motivo: 'uno de los dos ya no existe' }
  }

  const venueSellos = SELLOS_PERDIDOS.venueId
  /** 🔴 B2: la elegibilidad completa salvo el plazo, leída AHORA. La usa el plan y otra vez cada venta al aplicar. */
  const revalidarEnLaBase = async (orderId: string, clienteId: string): Promise<RevalidacionDeVenta> => {
    const ahora = Date.now()
    const foto = await fotoDeLaVenta(prisma, { venueId: venueSellos, orderId, customerId: clienteId })
    return revalidarVenta({
      existe: foto !== null,
      clienteId,
      primarioActual: foto?.primaryCustomerId ?? null,
      elegible: foto ? esElegibleParaLealtad(foto, ahora, { ignorarPlazo: true }) : false,
      decision: foto ? decideSaleStamp(foto, ahora, { ignorarPlazo: true }) : null,
    })
  }
  const estadoEnLaBase = async (v: VentaPorReparar): Promise<EstadoDeLealtad> => {
    const sellos = await prisma.stampEvent.count({
      where: { venueId: venueSellos, orderId: v.orderId, type: 'EARN', stampCard: { customerId: v.clienteId } },
    })
    const reversas = await prisma.stampEvent.count({ where: { venueId: venueSellos, orderId: v.orderId, type: 'REVERSAL' } })
    const puntos = await prisma.loyaltyTransaction.count({ where: { orderId: v.orderId, customerId: v.clienteId, type: 'EARN' } })
    const visitas = await prisma.customerOrderMetric.count({ where: { orderId: v.orderId, customerId: v.clienteId, venueId: venueSellos } })
    return { conSello: sellos > 0 && reversas === 0, conPuntos: puntos > 0, conVisita: visitas > 0 }
  }

  try {
    // ── (a) Teléfonos ────────────────────────────────────────────────────────────────────────────────────────────────
    const clientes = await prisma.$queryRaw<FilaTelefono[]>(
      Prisma.sql`SELECT "id", "venueId", "phone" FROM "Customer" WHERE "phone" ~ '^[+][0-9]{10}$'
                 ORDER BY "createdAt" ASC, "id" ASC LIMIT ${TOPE_FILAS + 1}`,
    )
    const consumidores = await prisma.$queryRaw<FilaTelefono[]>(
      Prisma.sql`SELECT "id", NULL::text AS "venueId", "phone" FROM "Consumer" WHERE "phone" ~ '^[+][0-9]{10}$'
                 ORDER BY "createdAt" ASC, "id" ASC LIMIT ${TOPE_FILAS + 1}`,
    )
    if (clientes.length > TOPE_FILAS || consumidores.length > TOPE_FILAS) {
      console.error(`🔴 Más de ${TOPE_FILAS} filas: esto no es la clase medida (71/73). No se hace nada; revisa a mano.`)
      throw new Rechazo(3)
    }
    const objetivo = (f: FilaTelefono) => `+52${f.phone.slice(1)}`
    const ocupadosCliente = await prisma.customer.findMany({
      where: { phone: { in: [...new Set(clientes.map(objetivo))] } },
      select: { id: true, venueId: true, phone: true },
      orderBy: { id: 'asc' },
      take: TOPE_FILAS,
    })
    const ocupadosConsumer = await prisma.consumer.findMany({
      where: { phone: { in: [...new Set(consumidores.map(objetivo))] } },
      select: { id: true, phone: true },
      orderBy: { id: 'asc' },
      take: TOPE_FILAS,
    })
    if (ocupadosCliente.length === TOPE_FILAS || ocupadosConsumer.length === TOPE_FILAS) {
      // Una lista de ocupados truncada escondería un choque (y en Consumer no hay índice único que lo detenga).
      console.error(`🔴 ${TOPE_FILAS} o más registros ya usan esos teléfonos con +52: no es la clase medida. No se hace nada.`)
      throw new Rechazo(3)
    }
    const planClientes = planearTelefonos(
      clientes,
      ocupadosCliente.map(o => ({ id: o.id, venueId: o.venueId, phone: o.phone ?? '' })),
      true,
    )
    const planConsumidores = planearTelefonos(
      consumidores,
      ocupadosConsumer.map(o => ({ id: o.id, venueId: null, phone: o.phone ?? '' })),
      false,
    )
    console.log(`\n(a) Clientes: ${planClientes.cambios.length} a +52 · ${planClientes.choques.length} chocan (no se cambian)`)
    for (const c of planClientes.cambios) console.log(`    ${c.id}  ${c.de} → ${c.a}  (venue ${c.venueId})`)
    console.log(`    Consumidores: ${planConsumidores.cambios.length} a +52 · ${planConsumidores.choques.length} chocan (sólo se reportan)`)
    for (const c of planConsumidores.cambios) console.log(`    Consumer ${c.id}  ${c.de} → ${c.a}`)
    for (const c of planConsumidores.choques) console.log(`    ⚠️  Consumer ${c.id} ${c.de} → ${c.a} ya lo tiene ${c.ocupadoPor}`)

    // ── (b) Duplicados: SÓLO el par autorizado ───────────────────────────────────────────────────────────────────────
    const esElPar = (c: ChoqueDeTelefono) => c.id === PAR_AUTORIZADO.retirar && c.ocupadoPor === PAR_AUTORIZADO.conservar
    const choqueDelPar = planClientes.choques.find(esElPar) ?? null
    console.log(`\n(b) Choques de clientes: ${planClientes.choques.length} — sólo el par autorizado de la spec puede fusionarse`)
    for (const c of planClientes.choques.filter(c => !esElPar(c))) {
      console.log(`    SOLO_REPORTAR  ${c.id} ${c.de} → ${c.a} ya lo tiene ${c.ocupadoPor} (venue ${c.venueId})`)
    }
    let planDelPar: DecisionDeFusion | null = null
    if (choqueDelPar) {
      planDelPar = await decidirPar(prisma)
      const pases = await prisma.walletPass.count({ where: { customerId: PAR_AUTORIZADO.retirar, venueId: PAR_AUTORIZADO.venueId } })
      console.log(
        planDelPar.decision === 'FUSIONAR'
          ? `    ✓ FUSIONAR par autorizado: se desactiva ${PAR_AUTORIZADO.retirar} (${choqueDelPar.de}), se queda ` +
              `${PAR_AUTORIZADO.conservar} (${choqueDelPar.a}) · pases a mover: ${pases}`
          : `    ⚠️  par autorizado SOLO_REPORTAR: ${planDelPar.motivo}`,
      )
    } else {
      console.log('    ⚠️  El par autorizado de Testarudo no está entre los choques (en una base local sin él es normal).')
    }

    // ── (c) Sellos perdidos ──────────────────────────────────────────────────────────────────────────────────────────
    const config = await prisma.loyaltyConfig.findUnique({ where: { venueId: venueSellos }, select: { active: true, stampsEnabled: true } })
    const conPlan = await venueHasFeatureAccess(venueSellos, 'LOYALTY_PROGRAM')
    const programaActivo = Boolean(conPlan && config?.active && config?.stampsEnabled)
    const reparaciones: ReparacionDeSello[] = []
    for (const orderNumber of SELLOS_PERDIDOS.ordenes) {
      const ordenes = await prisma.order.findMany({
        where: { venueId: venueSellos, orderNumber },
        select: {
          id: true,
          total: true,
          tipAmount: true,
          orderCustomers: { where: { isPrimary: true }, select: { customerId: true }, take: 1 },
        },
        orderBy: { id: 'asc' },
        take: 2,
      })
      const o = ordenes.length === 1 ? ordenes[0] : null
      const clienteId = o?.orderCustomers[0]?.customerId ?? null
      // 🔴 La MISMA regla del sello tardío (saldada, no cancelada, reembolso contado exacto, sin otro dueño), sin el plazo.
      const revision = o && clienteId ? await revalidarEnLaBase(o.id, clienteId) : null
      reparaciones.push({
        orderNumber,
        orderId: o?.id ?? null,
        clienteId,
        base: o ? Math.max(0, Number(o.total) - Number(o.tipAmount ?? 0)) : 0,
        porQueNo: revision && !revision.elegible ? revision.motivo : null,
        decision: decidirReparacionDeSello({
          coincidencias: ordenes.length,
          clienteId,
          programaActivo,
          elegible: revision?.elegible ?? false,
        }),
      })
    }
    console.log(`\n(c) Sellos perdidos (venue ${venueSellos}, programa de sellos ${programaActivo ? 'activo' : 'APAGADO o sin plan'}):`)
    for (const r of reparaciones) {
      console.log(`    ${r.orderNumber}  ${r.decision}${r.porQueNo ? ` (${r.porQueNo})` : ''}  cliente ${r.clienteId ?? '—'}`)
    }
    if (reparaciones.some(r => r.decision === 'COMPLETAR')) {
      console.log('    Nota: sellar avisa al pase del cliente y, si es su primer sello, le manda el correo de «guarda tu tarjeta».')
      console.log('    Una venta YA sellada sigue en COMPLETAR a propósito: la lealtad es idempotente y completa lo que falte.')
      console.log('    Al aplicar, cada venta se vuelve a revisar justo antes de otorgarse (un reembolso de último momento la saca).')
    }

    if (!aplicar) {
      console.log('\nSimulación: no se tocó nada.')
      console.log(
        `Para aplicar:  npx tsx ${SCRIPT}${leerValor('--base') ? ` --base ${leerValor('--base')}` : ''} --apply --confirm-host ${host}`,
      )
      return
    }

    // ── Aplicar (a)+(b): todo o nada, con CAS sobre lo listado; el par se REVALIDA aquí dentro ─────────────────────────
    const fusion = await prisma.$transaction(
      async tx => {
        for (const c of planClientes.cambios) {
          const r = await tx.customer.updateMany({ where: { id: c.id, phone: c.de }, data: { phone: c.a } })
          if (r.count !== 1) throw new Error(`Cliente ${c.id} cambió por debajo: se aborta TODO.`)
        }
        for (const c of planConsumidores.cambios) {
          const r = await tx.consumer.updateMany({ where: { id: c.id, phone: c.de }, data: { phone: c.a } })
          if (r.count !== 1) throw new Error(`Consumer ${c.id} cambió por debajo: se aborta TODO.`)
        }
        if (!choqueDelPar || planDelPar?.decision !== 'FUSIONAR')
          return { aplicada: false, omitida: null as string | null, pases: [] as string[] }
        // 🔴 Auditoría A #5: entre la simulación y este momento pudo llegar una venta, una reserva o un paquete.
        const otraVez = await decidirPar(tx)
        if (otraVez.decision !== 'FUSIONAR') return { aplicada: false, omitida: otraVez.motivo, pases: [] as string[] }
        // Los pases se leen AQUÍ dentro: uno creado después del plan también se mueve (si no, quedaría colgado del desactivado).
        const pases = (
          await tx.walletPass.findMany({
            where: { customerId: PAR_AUTORIZADO.retirar, venueId: PAR_AUTORIZADO.venueId },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 50,
          })
        ).map(p => p.id)
        if (pases.length) {
          await tx.walletPass.updateMany({
            where: { customerId: PAR_AUTORIZADO.retirar, venueId: PAR_AUTORIZADO.venueId, id: { in: pases } },
            data: { customerId: PAR_AUTORIZADO.conservar },
          })
        }
        const r = await tx.customer.updateMany({
          where: { id: PAR_AUTORIZADO.retirar, venueId: PAR_AUTORIZADO.venueId, phone: choqueDelPar.de, active: true },
          data: { active: false, phone: null },
        })
        if (r.count !== 1) throw new Error(`Cliente duplicado ${PAR_AUTORIZADO.retirar} cambió por debajo: se aborta TODO.`)
        return { aplicada: true, omitida: null as string | null, pases }
      },
      { timeout: 60_000, maxWait: 10_000 },
    )
    console.log(
      `\n✅ (a)+(b) aplicados en una sola transacción: ${planClientes.cambios.length} clientes y ${planConsumidores.cambios.length} ` +
        `consumidores a +52; par autorizado ${fusion.aplicada ? `fusionado (${fusion.pases.length} pases movidos)` : 'NO fusionado'}.`,
    )
    if (fusion.omitida) console.log(`    ⚠️  El par autorizado NO se fusionó: ${fusion.omitida}`)

    // Bitácora DESPUÉS del commit: `logAction` usa el cliente global y nunca lanza.
    for (const c of planClientes.cambios)
      await logAction({
        action: 'CUSTOMER_PHONE_NORMALIZED',
        entity: 'Customer',
        entityId: c.id,
        venueId: c.venueId,
        data: { de: c.de, a: c.a, script: SCRIPT },
      })
    for (const c of planConsumidores.cambios)
      await logAction({
        action: 'CONSUMER_PHONE_NORMALIZED',
        entity: 'Consumer',
        entityId: c.id,
        venueId: null,
        data: { de: c.de, a: c.a, script: SCRIPT },
      })
    if (fusion.aplicada && choqueDelPar) {
      await logAction({
        action: 'CUSTOMER_MERGED_DUPLICATE',
        entity: 'Customer',
        entityId: PAR_AUTORIZADO.retirar,
        venueId: PAR_AUTORIZADO.venueId,
        data: { conservado: PAR_AUTORIZADO.conservar, telefonoViejo: choqueDelPar.de, pasesMovidos: fusion.pases, script: SCRIPT },
      })
      if (fusion.pases.length) await notifyCustomerPassUpdated(PAR_AUTORIZADO.venueId, PAR_AUTORIZADO.conservar)
    }

    // ── Aplicar (c): el envoltorio de lealtad de cada venta, revalidada en su turno; cada una deja su bitácora al terminar ─
    const porCompletar: VentaPorReparar[] = reparaciones.flatMap(r =>
      r.decision === 'COMPLETAR' && r.orderId && r.clienteId
        ? [{ orderNumber: r.orderNumber, orderId: r.orderId, clienteId: r.clienteId, base: r.base }]
        : [],
    )
    console.log(`\n(c) Sellos: ${porCompletar.length} venta(s) por completar.`)
    await completarLealtadDeVentas(porCompletar, {
      revalidar: v => revalidarEnLaBase(v.orderId, v.clienteId),
      completar: async v => {
        const r = await otorgarLealtadRespetandoReembolsos({
          venueId: venueSellos,
          orderId: v.orderId,
          orderTotal: v.base,
          staffId: null,
          legacyCustomer: null,
        })
        if (!r.complete) console.log(`    ⚠️  ${v.orderNumber}: la lealtad dejó errores: ${r.errors.join(' | ')}`)
        return { complete: r.complete, reembolsada: r.reembolsada }
      },
      estado: estadoEnLaBase,
      registrar: async (v, r) => {
        if (r.omitida) {
          console.log(`    ${v.orderNumber}: ⏭️  NO se tocó — ${r.omitida}`)
          return
        }
        if (r.cambio) {
          await logAction({
            action: 'STAMP_REPAIRED_FOR_LATE_CUSTOMER',
            entity: 'Order',
            entityId: v.orderId,
            venueId: venueSellos,
            data: {
              orderNumber: v.orderNumber,
              customerId: v.clienteId,
              conSello: r.conSello,
              lealtadCompleta: r.completa,
              reembolsada: r.reembolsada,
              script: SCRIPT,
            },
          })
        }
        const sello = r.reembolsada
          ? '↩️  se reembolsó mientras se otorgaba: sin sello'
          : r.conSello
            ? '✅ con sello'
            : '⚠️  sin sello (¿ya tuvo su sello de HOY? vuelve a correr mañana)'
        console.log(
          `    ${v.orderNumber}: ${sello} · lealtad ${r.completa ? 'completa' : 'con errores: vuelve a correr (es idempotente)'}` +
            (r.cambio ? '' : ' · sin cambios (ya estaba completa; no se escribe bitácora)'),
        )
      },
    })
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
