/**
 * IVA por producto, plan 4 — fixtures compartidas por las suites de exclusión contable y de traslado (Tareas 1 a 3), contra
 * Postgres REAL.
 *
 * Cada negocio es una organización NUEVA con su venue y un RFC único por corrida: la marca pegajosa nunca se apaga (Ruling
 * PF7) y el folio y la idempotencia de las pólizas son por (organización, RFC). `limpiarNegocios` borra todo lo que las
 * suites siembran, acotado a sus organizaciones y venues.
 */
import { Prisma, type PrismaClient } from '@prisma/client'

import { ConflictError } from '@/errors/AppError'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

export const MOTIVO =
  'La contabilidad de Avoqado todavía no maneja ventas con IVA distinto de 16 %. Como esta organización ya tuvo productos con otra tasa, las pólizas y el cierre de periodo están pausados. Escríbenos a hola@avoqado.io si lo necesitas.'
export const PAUSA = { statusCode: 409, code: 'CONTABILIDAD_IVA_MIXTO', message: MOTIVO }

const corrida = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(-6).toUpperCase()
let consecutivo = 0
/** RFC único por corrida y por negocio: el folio y la idempotencia de las pólizas son por (organización, RFC). */
export const nuevoRfc = () => `EXC${corrida}${String(++consecutivo).padStart(2, '0')}0`

export interface Negocio {
  organizationId: string
  venueId: string
  rfc: string
}
const negocios: Negocio[] = []

export async function nuevoNegocio({ contabilidad = true } = {}): Promise<Negocio> {
  const rfc = nuevoRfc()
  const etiqueta = rfc.toLowerCase()
  const org = await prisma.organization.create({
    data: { name: `Exclusión contable ${etiqueta}`, email: `${etiqueta}@example.test`, phone: '5555555555' },
  })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: `Exclusión ${etiqueta}`, slug: `exclusion-${etiqueta}`, rfc, seatCapExempt: true },
  })
  const negocio = { organizationId: org.id, venueId: venue.id, rfc }
  negocios.push(negocio)
  if (contabilidad) {
    await seedBaseChart(venue.id, { staffId: null })
    await seedDefaultMappings(venue.id, { staffId: null })
  }
  return negocio
}

/** La marca pegajosa: de falso a verdadero siempre se puede; nunca se regresa. */
export const marcar = (x: Negocio) =>
  prisma.$executeRaw`UPDATE "Organization" SET "ivaMixtoAlgunaVez" = true WHERE id = ${x.organizationId}`

export const cuenta = async (organizationId: string, rfc: string, code: string) =>
  (await prisma.ledgerAccount.findFirstOrThrow({ where: { organizationId, rfc, code }, select: { id: true } })).id

/** DEBE caja / HABER ventas por $116. */
export async function lineasDeVenta(organizationId: string, rfc: string) {
  const [caja, ventas] = await Promise.all([cuenta(organizationId, rfc, '101.01'), cuenta(organizationId, rfc, '401.01')])
  return [
    { ledgerAccountId: caja, debitCents: 11_600, creditCents: 0 },
    { ledgerAccountId: ventas, debitCents: 0, creditCents: 11_600 },
  ]
}

export const polizas = (organizationId: string) => prisma.journalEntry.count({ where: { organizationId } })

/** El desenlace sin lanzar: `{ ok }` o el error tal cual. */
export const desenlace = <T>(p: Promise<T>) =>
  p.then(
    ok => ({ ok }),
    (error: unknown) => error,
  )

/** Estado viejo: escribe con los triggers apagados SÓLO dentro de esta transacción (Ruling PF7). */
export const sinTriggers = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`
    return fn(tx)
  })

/** Categoría, IVA por producto encendido (sólo este negocio) y un producto IVA_16. */
export async function conProducto(x: Negocio) {
  const categoryId = (await prisma.menuCategory.create({ data: { venueId: x.venueId, name: 'IVA', slug: `iva-${x.rfc}`.toLowerCase() } }))
    .id
  await encenderIvaPorProducto(x.venueId)
  const productId = (await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `P-${x.rfc}`, name: 'Café', price: 100 } }))
    .id
  return { categoryId, productId }
}

export const marcada = async (organizationId: string) =>
  (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { ivaMixtoAlgunaVez: true } })).ivaMixtoAlgunaVez

/** Una póliza escrita directo (sin catálogo de cuentas): basta para que exista historia contable. */
export const polizaSuelta = (organizationId: string, rfc: string, venueId: string | null) =>
  prisma.journalEntry.create({
    data: {
      organizationId,
      rfc,
      venueId,
      date: new Date('2026-06-15T12:00:00Z'),
      period: '2026-06',
      folio: 1,
      concept: 'Historia',
      totalDebitCents: 100,
      totalCreditCents: 100,
    },
  })

/** Una orden con un renglón sin sellar y un CFDI en el que sellarlo. */
export async function ordenConCfdi(x: Negocio, productId: string, etiqueta: string) {
  const orden = await prisma.order.create({
    data: { venueId: x.venueId, orderNumber: `T2-${etiqueta}-${x.rfc}`, subtotal: 100, taxAmount: 0, total: 100 },
  })
  const item = await prisma.orderItem.create({
    data: { orderId: orden.id, productId, productName: 'Grano', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
  })
  const emisor =
    (await prisma.fiscalEmisor.findFirst({ where: { venueId: x.venueId }, select: { id: true } })) ??
    (await prisma.fiscalEmisor.create({
      data: { venueId: x.venueId, rfc: x.rfc, legalName: 'Negocio de prueba', regimenFiscal: '601', lugarExpedicion: '01000' },
    }))
  const cfdi = await prisma.cfdi.create({
    data: {
      venueId: x.venueId,
      fiscalEmisorId: emisor.id,
      flow: 'STAFF_B',
      orderId: orden.id,
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'PÚBLICO EN GENERAL',
      receptorRegimen: '616',
      receptorCp: '01000',
      usoCfdi: 'S01',
      formaPago: '01',
      metodoPago: 'PUE',
      subtotalCents: 10000,
      taxCents: 0,
      totalCents: 10000,
    } as Prisma.CfdiUncheckedCreateInput,
  })
  return { orderId: orden.id, orderItemId: item.id, cfdiId: cfdi.id }
}

/** Cobro con tarjeta de $116 (sin renglones: la póliza usa el 16 % de siempre). */
export async function cobroConTarjeta(x: Negocio, merchantAccountId?: string) {
  const monto = new Prisma.Decimal('116.00')
  const orden = await prisma.order.create({
    data: {
      venueId: x.venueId,
      orderNumber: `EXC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'COMPLETED',
      completedAt: new Date(),
      subtotal: monto,
      taxAmount: new Prisma.Decimal(0),
      tipAmount: new Prisma.Decimal(0),
      total: monto,
      paidAmount: monto,
      remainingBalance: new Prisma.Decimal(0),
      paymentStatus: 'PAID',
    },
  })
  return prisma.payment.create({
    data: {
      venueId: x.venueId,
      orderId: orden.id,
      amount: monto,
      tipAmount: new Prisma.Decimal(0),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      type: 'FAST',
      splitType: 'FULLPAYMENT',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: new Prisma.Decimal(0),
      netAmount: monto,
      merchantAccountId,
    },
  })
}

/** La operación debe salir con la pausa. Si NO lanza, el fallo muestra lo que sí escribió. */
export async function debePausarse(operacion: Promise<unknown>): Promise<void> {
  const resultado = await operacion.then(
    escrito => ({ escrito }),
    (error: unknown) => error,
  )
  expect(resultado).toMatchObject(PAUSA) // primero: si no lanzó, el diff muestra `escrito`
  expect(resultado).toBeInstanceOf(ConflictError)
}

/** Sondea pg_stat_activity (desde una conexión observadora) hasta que la consulta devuelva un pid; lo devuelve. */
export async function hastaQue(observador: PrismaClient, descripcion: string, plazoMs: number, sql: Prisma.Sql): Promise<number> {
  const limite = Date.now() + plazoMs
  while (Date.now() < limite) {
    const [fila] = await observador.$queryRaw<Array<{ pid: number }>>(sql)
    if (fila) return fila.pid
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Nunca se vio: ${descripcion}`)
}

/**
 * Un bloqueador: otra transacción toma lo que `tomar` pida y lo retiene hasta `soltar()`. Por defecto se REVIERTE (sólo
 * retenía); con `confirmar` se confirma, para cuando lo retenido es la operación bajo prueba (p. ej. un sello en vuelo).
 */
export async function retener(
  cliente: PrismaClient,
  tomar: (tx: Prisma.TransactionClient) => Promise<unknown>,
  { confirmar = false } = {},
): Promise<{ pid: number; soltar: () => Promise<void> }> {
  let listo!: (pid: number) => void
  let suelta!: () => void
  const pidListo = new Promise<number>(resolve => (listo = resolve))
  const suelto = new Promise<void>(resolve => (suelta = resolve))
  const REVERTIR = new Error('revertir el bloqueador')
  const fin = cliente
    .$transaction(
      async tx => {
        await tomar(tx)
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        listo(pid)
        await suelto
        if (!confirmar) throw REVERTIR
      },
      { timeout: 120_000, maxWait: 20_000 },
    )
    .then(
      () => undefined,
      (e: unknown) => {
        if (e !== REVERTIR) throw e
      },
    )
  const pid = await Promise.race([
    pidListo,
    fin.then(() => {
      throw new Error('El bloqueador terminó antes de retener')
    }),
  ])
  return {
    pid,
    soltar: async () => {
      suelta()
      await fin
    },
  }
}

export async function limpiarNegocios(): Promise<void> {
  // Un traslado (Tarea 3) deja negocios en organizaciones ajenas: cada uno vuelve a la suya antes de borrar, sin la barrera.
  await sinTriggers(async tx => {
    for (const n of negocios) await tx.$executeRaw`UPDATE "Venue" SET "organizationId" = ${n.organizationId} WHERE id = ${n.venueId}`
  })
  for (const { organizationId, venueId } of negocios) {
    await prisma.journalEntry.deleteMany({ where: { OR: [{ organizationId }, { venueId }] } })
    await prisma.accountingPeriodLock.deleteMany({ where: { organizationId } })
    await prisma.fixedAsset.deleteMany({ where: { organizationId } })
    await prisma.$executeRaw`DELETE FROM "PayrollLine" WHERE "payrollRunId" IN (SELECT id FROM "PayrollRun" WHERE "organizationId" = ${organizationId})`
    await prisma.payrollRun.deleteMany({ where: { organizationId } })
    await prisma.employee.deleteMany({ where: { organizationId } })
    await prisma.expense.deleteMany({ where: { organizationId } })
    await prisma.accountMapping.deleteMany({ where: { organizationId } })
    await prisma.ledgerAccount.deleteMany({ where: { organizationId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisor: { venueId } } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { OR: [{ venueId }, { organizationId }] } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  }
}
