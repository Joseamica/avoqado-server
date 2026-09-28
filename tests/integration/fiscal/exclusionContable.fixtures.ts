/**
 * IVA por producto, plan 4 — fixtures compartidas por las suites de exclusión contable (Tareas 1 y 2), contra Postgres REAL.
 *
 * Cada negocio es una organización NUEVA con su venue y un RFC único por corrida: la marca pegajosa nunca se apaga (Ruling
 * PF7) y el folio y la idempotencia de las pólizas son por (organización, RFC). `limpiarNegocios` borra todo lo que las dos
 * suites siembran, acotado a sus organizaciones y venues.
 */
import type { Prisma, PrismaClient } from '@prisma/client'

import { ConflictError } from '@/errors/AppError'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import prisma from '@/utils/prismaClient'

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
