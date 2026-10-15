/**
 * Reparar teléfonos sin lada, el duplicado AUTORIZADO de Testarudo y los sellos perdidos de la tarjeta de lealtad
 * (corrección de datos, spec 2026-10-14 §3.6).
 *
 *   npx tsx scripts/lealtad/reparar-telefonos-y-sellos.ts                     # simulación contra DATABASE_URL (la local)
 *   npx tsx scripts/lealtad/reparar-telefonos-y-sellos.ts --base render       # simulación contra RENDER_DATABASE_URL
 *   npx tsx scripts/lealtad/reparar-telefonos-y-sellos.ts --base render --apply --confirm-host <host>
 *
 * Banderas: sólo `--base render|local`, `--apply`, `--dry-run` (lo mismo que no poner `--apply`) y `--confirm-host <host>`.
 * Una desconocida, repetida o sin valor, o `--dry-run` junto con `--apply`, sale con código 2 sin tocar nada.
 *
 * Qué corrige (medido en prod el 14-oct-2026, sólo lectura):
 *   (a) El OTP guardaba «'+' + dígitos» sin lada: 71 clientes y 73 consumidores en 4 negocios con «+» + 10 dígitos. Pasan a
 *       «+52» + 10 (`normalizarTelefonoMx`). Si OTRO registro ya tiene ese «+52…», no se toca y se reporta (en Consumer se
 *       vuelve a preguntar DENTRO de la transacción, porque no hay índice único que lo frene).
 *   (b) 🔴 SÓLO el par autorizado por la spec (Testarudo: se queda `cmv192e9k0968os29qhgyn86h`, se desactiva
 *       `cmttavm9802bjpk2b6asriztj`), REVALIDADO dentro de la transacción y con sus dos filas bloqueadas (`FOR UPDATE`): los dos
 *       sin sellos, ventas, reservas ni paquetes o créditos, y el viejo sin NINGUNA otra historia (`OTRA_HISTORIA`), sin puntos,
 *       sin referidos, sin notas ni etiquetas, y con correo y cumpleaños vacíos o iguales. Si algo no cuadra, no se toca y se
 *       dice por qué. Cualquier otro choque de teléfono SÓLO se reporta (auditoría A #5).
 *   (c) Los 3 sellos perdidos de Testarudo (22-sep, 27-sep y 14-oct): la MISMA regla del sello tardío sin el plazo de 24 h y
 *       el MISMO envoltorio que la liga tardía y el reconciliador (`otorgarLealtadRespetandoReembolsos`, B2: no otorga a una
 *       venta devuelta y revierte el sello si el reembolso entra mientras otorga). Cada venta se REVALIDA justo antes de
 *       otorgarse (saldada, no cancelada, sin reembolso, el cliente sigue primario). Reanudable: si una corrida se corta entre
 *       el sello y los puntos, o entre la lealtad y su renglón de bitácora, la siguiente completa lo que falte sin duplicar
 *       (auditoría A #6, ronda 1 #2c). Sin fechar el sello en el pasado: si alguno sale sin sello por el tope de HOY, se dice y
 *       se vuelve a correr otro día.
 *
 * Bitácora (`ActivityLog`, los mismos campos que escribe el servidor para un actor de sistema): la de (a)+(b) se escribe DENTRO
 * de la misma transacción que los cambios (se confirman juntos o ninguno); la de (c), una por venta en cuanto termina, y sólo si
 * esa venta aún no tiene su renglón `STAMP_REPAIRED_FOR_LATE_CUSTOMER`.
 *
 * 🔴 H7 (15-oct-2026): sellar le manda al cliente el correo del primer sello y actualiza su pase, con la BASE_URL y las
 * credenciales de Wallet de ESTE proceso. Con `--base render --apply`, BASE_URL tiene que ser https://api.avoqado.io (si no,
 * salida 2 sin escribir nada); la simulación imprime el host de BASE_URL y si Apple/Google Wallet están disponibles. Al
 * terminar (c), el script ESPERA los avisos al pase y los correos que dejó corriendo antes de desconectarse, y dice cuántos
 * fueron. Lo más seguro es correrlo desde una shell de Render (ahí el entorno ya es el de producción).
 *
 * 🔴 Escribir exige repetir el host de la base: es la única defensa contra un DATABASE_URL heredado de otra pestaña.
 * `--base render` cambia DATABASE_URL por RENDER_DATABASE_URL ANTES de cargar Prisma; ninguna URL se imprime. Sin
 * `--base render`, la base nunca puede ser producción, y para escribir tiene que ser loopback (localhost, 127.0.0.1, ::1).
 * La simulación es de sólo lectura POR CONSTRUCCIÓN: sin `--apply` no se construye ninguna escritura.
 *
 * Sólo con el «sí, en prod» del founder, justo antes de correrlo.
 */
import 'dotenv/config'
import { Prisma } from '@prisma/client'
import {
  OTRA_HISTORIA,
  PAR_AUTORIZADO,
  aplicarTelefonosYPar,
  completarLealtadDeVentas,
  decidirFusionAutorizada,
  decidirReparacionDeSello,
  filaDeBitacora,
  interpretarBanderas,
  lineaDeEntornoPublico,
  planearTelefonos,
  revalidarVenta,
  revisarBase,
  revisarEntornoPublico,
  type Banderas,
  type ChoqueDeTelefono,
  type DecisionDeFusion,
  type DecisionDeSello,
  type EstadoDeLealtad,
  type FilaTelefono,
  type OtraHistoria,
  type PuertoDeTransaccion,
  type ResumenCliente,
  type RevalidacionDeVenta,
  type VentaPorReparar,
} from '../../src/services/shared/reparacionLealtad'
import { normalizarTelefonoMx } from '../../src/utils/phone'

const TOPE_FILAS = 5000
const SCRIPT = 'scripts/lealtad/reparar-telefonos-y-sellos.ts'
const ACCION_SELLO = 'STAMP_REPAIRED_FOR_LATE_CUSTOMER'
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

const hostDe = (url: string | undefined): string | null => {
  if (!url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/** Elige la base ANTES de que exista el cliente de Prisma. */
function elegirBase(base: Banderas['base']): void {
  if (base !== 'render') return
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

/** `_count` de cada relación de `OTRA_HISTORIA` + las que cuentan para los dos. Un nombre que no exista no compila. */
const CONTEOS_DEL_CLIENTE = {
  ...(Object.fromEntries(Object.keys(OTRA_HISTORIA).map(k => [k, true])) as Record<OtraHistoria, true>),
  orders: true,
  orderAssociations: true,
  reservations: true,
  creditPackPurchases: true,
  creditTransactions: true,
} as const

async function main(): Promise<void> {
  const leidas = interpretarBanderas(process.argv.slice(2))
  if (!leidas.ok) {
    console.error(`🔴 ${leidas.error}. No se leyó ni se escribió nada.`)
    throw new Rechazo(2)
  }
  const { base, aplicar, confirmHost } = leidas.banderas
  elegirBase(base)
  const host = hostDeLaBase()
  const revision = revisarBase({ base, aplicar, host, hostRender: hostDe(process.env.RENDER_DATABASE_URL) })
  if (!revision.ok) {
    console.error(`🔴 ${revision.motivo} No se leyó ni se escribió nada.`)
    throw new Rechazo(2)
  }
  console.log(`Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}`)
  if (aplicar && confirmHost !== host) {
    console.error('🔴 No se escribió NADA.')
    console.error(`Para escribir en esta base hay que repetir su host exacto:  --confirm-host ${host}`)
    console.error(confirmHost === null ? 'No recibí --confirm-host.' : `Recibí «${confirmHost}».`)
    throw new Rechazo(2)
  }
  // 🔴 H7: en producción, los avisos al cliente (correo del primer sello, pases) tienen que salir con la API de producción.
  const entorno = revisarEntornoPublico({ base, aplicar, baseUrl: process.env.BASE_URL })
  if (!entorno.ok) {
    console.error(`🔴 No se escribió NADA. ${entorno.motivo}`)
    throw new Rechazo(2)
  }

  // Imports dinámicos: el cliente de Prisma lee DATABASE_URL al cargarse, y `elegirBase` ya la eligió.
  const { default: prisma } = await import('../../src/utils/prismaClient')
  const { venueHasFeatureAccess } = await import('../../src/services/access/basePlan.service')
  const { decideSaleStamp, esElegibleParaLealtad, fotoDeLaVenta, otorgarLealtadRespetandoReembolsos } = await import(
    '../../src/services/shared/loyaltyOnLateCustomer'
  )
  const { notifyCustomerPassUpdated } = await import('../../src/services/wallet/notifyPassUpdated.service')
  const { esperarEfectosDeSellos } = await import('../../src/services/wallet/stampLedger.service')
  const { apnsAvailable } = await import('../../src/services/wallet/apnsClient')
  const { googleWalletAvailable } = await import('../../src/services/wallet/googleWalletClient')
  const { env } = await import('../../src/config/env')

  // H7: lo que este proceso usaría para avisarle al cliente (sólo el host de BASE_URL; ninguna llave se imprime).
  console.log(
    lineaDeEntornoPublico({
      baseUrl: process.env.BASE_URL,
      apple: apnsAvailable(),
      apnsProduccion: env.NODE_ENV === 'production',
      google: googleWalletAvailable(),
    }),
  )

  /** Todo lo que hace «vacío» o no a un cliente. Se usa al planear y OTRA VEZ dentro de la transacción que aplica. */
  const resumen = async (db: Prisma.TransactionClient, id: string): Promise<ResumenCliente | null> => {
    const c = await db.customer.findUnique({
      where: { id },
      select: {
        id: true,
        venueId: true,
        active: true,
        phone: true,
        email: true,
        birthDate: true,
        loyaltyPoints: true,
        referralCount: true,
        referredByCustomerId: true,
        notes: true,
        tags: true,
        _count: { select: CONTEOS_DEL_CLIENTE },
      },
    })
    if (!c) return null
    const sellos = await db.stampEvent.count({ where: { stampCard: { customerId: id } } })
    const n = c._count
    return {
      id: c.id,
      venueId: c.venueId,
      active: c.active,
      phone: c.phone,
      email: c.email,
      birthDate: c.birthDate ? c.birthDate.toISOString().slice(0, 10) : null,
      loyaltyPoints: c.loyaltyPoints,
      referralCount: c.referralCount,
      referredByCustomerId: c.referredByCustomerId,
      notes: c.notes,
      tags: c.tags,
      sellos,
      ventas: n.orderAssociations + n.orders,
      reservas: n.reservations,
      paquetes: n.creditPackPurchases + n.creditTransactions,
      otros: Object.fromEntries((Object.keys(OTRA_HISTORIA) as OtraHistoria[]).map(k => [k, n[k]])) as Record<OtraHistoria, number>,
    }
  }
  const decidirPar = async (db: Prisma.TransactionClient): Promise<DecisionDeFusion> => {
    const viejo = await resumen(db, PAR_AUTORIZADO.retirar)
    const nuevo = await resumen(db, PAR_AUTORIZADO.conservar)
    return viejo && nuevo ? decidirFusionAutorizada(viejo, nuevo) : { decision: 'SOLO_REPORTAR', motivo: 'uno de los dos ya no existe' }
  }

  /** El cuerpo de la transacción de (a)+(b), atado a su `tx`. La bitácora va por el MISMO `tx`. */
  const puertoDe = (tx: Prisma.TransactionClient): PuertoDeTransaccion => ({
    bloquearPar: async () => {
      await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "Customer" WHERE "id" IN (${PAR_AUTORIZADO.retirar}, ${PAR_AUTORIZADO.conservar})
                   ORDER BY "id" FOR UPDATE`,
      )
    },
    cambiarTelefonoDeCliente: async c => (await tx.customer.updateMany({ where: { id: c.id, phone: c.de }, data: { phone: c.a } })).count,
    consumerConTelefono: async c =>
      (await tx.consumer.findFirst({ where: { phone: c.a, id: { not: c.id } }, select: { id: true }, orderBy: { id: 'asc' } }))?.id ?? null,
    cambiarTelefonoDeConsumer: async c => (await tx.consumer.updateMany({ where: { id: c.id, phone: c.de }, data: { phone: c.a } })).count,
    decidirPar: () => decidirPar(tx),
    pasesDelViejo: async limite =>
      (
        await tx.walletPass.findMany({
          where: { customerId: PAR_AUTORIZADO.retirar, venueId: PAR_AUTORIZADO.venueId },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: limite,
        })
      ).map(p => p.id),
    moverPases: async ids =>
      (
        await tx.walletPass.updateMany({
          where: { customerId: PAR_AUTORIZADO.retirar, venueId: PAR_AUTORIZADO.venueId, id: { in: [...ids] } },
          data: { customerId: PAR_AUTORIZADO.conservar },
        })
      ).count,
    desactivarViejo: async telefonoViejo =>
      (
        await tx.customer.updateMany({
          where: { id: PAR_AUTORIZADO.retirar, venueId: PAR_AUTORIZADO.venueId, phone: telefonoViejo, active: true },
          data: { active: false, phone: null },
        })
      ).count,
    escribirBitacora: async filas => {
      await tx.activityLog.createMany({ data: filas.map(f => ({ ...f, data: f.data as Prisma.InputJsonValue })) })
    },
  })

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
    // La MISMA regla del OTP y de `planearTelefonos` (#3i): nunca una copia a mano de cómo se agrega la lada.
    const objetivos = (filas: FilaTelefono[]) => [...new Set(filas.map(f => normalizarTelefonoMx(f.phone)))]
    const ocupadosCliente = await prisma.customer.findMany({
      where: { phone: { in: objetivos(clientes) } },
      select: { id: true, venueId: true, phone: true },
      orderBy: { id: 'asc' },
      take: TOPE_FILAS,
    })
    const ocupadosConsumer = await prisma.consumer.findMany({
      where: { phone: { in: objetivos(consumidores) } },
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
      const revisada = o && clienteId ? await revalidarEnLaBase(o.id, clienteId) : null
      reparaciones.push({
        orderNumber,
        orderId: o?.id ?? null,
        clienteId,
        base: o ? Math.max(0, Number(o.total) - Number(o.tipAmount ?? 0)) : 0,
        porQueNo: revisada && !revisada.elegible ? revisada.motivo : null,
        decision: decidirReparacionDeSello({
          coincidencias: ordenes.length,
          clienteId,
          programaActivo,
          elegible: revisada?.elegible ?? false,
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
      // H7: en producción, aplicar exige la BASE_URL de la API de producción; si este proceso no la trae, el comando la antepone.
      const conBaseUrl = revisarEntornoPublico({ base, aplicar: true, baseUrl: process.env.BASE_URL }).ok
        ? ''
        : 'BASE_URL=https://api.avoqado.io '
      console.log(`Para aplicar:  ${conBaseUrl}npx tsx ${SCRIPT}${base ? ` --base ${base}` : ''} --apply --confirm-host ${host}`)
      return
    }

    // ── Aplicar (a)+(b): todo o nada, con CAS; el par se BLOQUEA y se REVALIDA aquí dentro; la bitácora va en el MISMO tx ─
    const r = await prisma.$transaction(
      tx =>
        aplicarTelefonosYPar(puertoDe(tx), {
          script: SCRIPT,
          cambiosDeClientes: planClientes.cambios,
          cambiosDeConsumidores: planConsumidores.cambios,
          parPorFusionar: choqueDelPar && planDelPar?.decision === 'FUSIONAR' ? choqueDelPar : null,
        }),
      { timeout: 60_000, maxWait: 10_000 },
    )
    console.log(
      `\n✅ (a)+(b) aplicados en una sola transacción: ${r.clientes.length} clientes y ${r.consumidores.length} consumidores a +52; ` +
        `par autorizado ${r.fusion.aplicada ? `fusionado (${r.fusion.pases.length} pases movidos)` : 'NO fusionado'}; ` +
        `${r.bitacora} renglones de bitácora en la misma transacción.`,
    )
    for (const c of r.consumidoresOmitidos) {
      console.log(`    ⚠️  Consumer ${c.id} NO se cambió: ${c.ocupadoPor} ya tenía ${c.a} al aplicar`)
    }
    if (!r.fusion.aplicada && r.fusion.motivo) console.log(`    ⚠️  El par autorizado NO se fusionó: ${r.fusion.motivo}`)
    if (r.fusion.aplicada && r.fusion.pases.length) {
      const aviso = await notifyCustomerPassUpdated(PAR_AUTORIZADO.venueId, PAR_AUTORIZADO.conservar)
      console.log(`    Pase del cliente conservado: ${aviso.notified} tarjeta(s) avisada(s)${aviso.failed ? ' (🔴 el aviso falló)' : ''}.`)
    }

    // ── Aplicar (c): el envoltorio de lealtad de cada venta, revalidada en su turno; su renglón en cuanto termina ─────────
    const porCompletar: VentaPorReparar[] = reparaciones.flatMap(rep =>
      rep.decision === 'COMPLETAR' && rep.orderId && rep.clienteId
        ? [{ orderNumber: rep.orderNumber, orderId: rep.orderId, clienteId: rep.clienteId, base: rep.base }]
        : [],
    )
    console.log(`\n(c) Sellos: ${porCompletar.length} venta(s) por completar.`)
    await completarLealtadDeVentas(porCompletar, {
      revalidar: v => revalidarEnLaBase(v.orderId, v.clienteId),
      completar: async v => {
        const otorgada = await otorgarLealtadRespetandoReembolsos({
          venueId: venueSellos,
          orderId: v.orderId,
          orderTotal: v.base,
          staffId: null,
          legacyCustomer: null,
        })
        if (!otorgada.complete) console.log(`    ⚠️  ${v.orderNumber}: la lealtad dejó errores: ${otorgada.errors.join(' | ')}`)
        if (otorgada.otroCliente) {
          console.log(`    ⚠️  ${v.orderNumber}: la venta ya le dio sello o puntos a OTRO cliente: no se acreditó a ${v.clienteId}`)
        }
        return { complete: otorgada.complete, reembolsada: otorgada.reembolsada }
      },
      estado: estadoEnLaBase,
      yaAuditada: async v =>
        (await prisma.activityLog.count({ where: { action: ACCION_SELLO, entity: 'Order', entityId: v.orderId, venueId: venueSellos } })) >
        0,
      // 🔴 Directo y sin tragarse el error: si el renglón no se escribe, la corrida se detiene y la siguiente lo recupera.
      auditar: async (v, rep) => {
        const fila = filaDeBitacora(ACCION_SELLO, 'Order', v.orderId, venueSellos, {
          orderNumber: v.orderNumber,
          customerId: v.clienteId,
          conSello: rep.conSello,
          lealtadCompleta: rep.completa,
          reembolsada: rep.reembolsada,
          cambioEnEstaCorrida: rep.cambio,
          script: SCRIPT,
        })
        await prisma.activityLog.create({ data: { ...fila, data: fila.data as Prisma.InputJsonValue } })
      },
      informar: (v, rep) => {
        if (rep.omitida) {
          console.log(`    ${v.orderNumber}: ⏭️  NO se tocó — ${rep.omitida}`)
          return
        }
        const sello = rep.reembolsada
          ? '↩️  se reembolsó mientras se otorgaba: sin sello'
          : rep.conSello
            ? '✅ con sello'
            : '⚠️  sin sello (¿ya tuvo su sello de HOY? vuelve a correr mañana)'
        const bitacora = rep.auditoria === 'ESCRITA' ? 'bitácora escrita' : 'bitácora ya existía (no se duplica)'
        console.log(
          `    ${v.orderNumber}: ${sello} · lealtad ${rep.completa ? 'completa' : 'con errores: vuelve a correr (es idempotente)'}` +
            ` · ${rep.cambio ? 'cambió en esta corrida' : 'sin cambios en esta corrida'} · ${bitacora}`,
        )
      },
    })
  } finally {
    if (aplicar) {
      // 🔴 H7: los avisos al pase y los correos del primer sello salen en segundo plano desde `grantStamp`; si el proceso se
      // desconecta y sale antes, quedan a medias. Se esperan aquí (también si (c) se cortó con un error), con tope.
      const efectos = await esperarEfectosDeSellos({ maxMs: 120_000 }).catch(() => null)
      if (efectos) {
        console.log(
          `\nAvisos de esta corrida, esperados antes de salir: ${efectos.avisosAlPase} al pase ` +
            `(${efectos.tarjetasAvisadas} tarjeta(s) actualizada(s)${efectos.avisosFallidos ? `, 🔴 ${efectos.avisosFallidos} fallaron` : ''}) · ` +
            `${efectos.correosDePrimerSello} correo(s) de primer sello revisado(s)` +
            (efectos.pendientes ? ` · 🔴 ${efectos.pendientes} seguían en vuelo a los 2 min` : ''),
        )
      }
    }
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
