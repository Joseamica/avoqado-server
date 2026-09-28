/**
 * IVA por producto, plan 4 · Tarea 1 — con IVA mixto la contabilidad se PAUSA y lo dice, contra Postgres REAL.
 *
 * `Organization.ivaMixtoAlgunaVez` (pegajosa, plan 1) manda: con ella ningún creador de pólizas escribe ni se cierra un
 * periodo, y el motivo sale como 409 `CONTABILIDAD_IVA_MIXTO`. La exigencia vive DENTRO de la transacción de la póliza
 * y del cierre, con candados de fila `Organization` → `Venue` en `FOR SHARE` (Ruling R1): una publicación de catálogo
 * en vuelo, que ya tomó esas filas, hace ESPERAR al posteo; al soltarse, el posteo termina bien.
 *
 * Cada caso usa una organización NUEVA: la marca nunca se apaga (Ruling PF7) y se enciende con SQL directo, de falso a
 * verdadero. Corre sólo en la base H1 desechable (la exige el arnés del catálogo).
 */
import { JournalEntrySource, Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import { ConflictError } from '@/errors/AppError'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { closePeriod } from '@/services/fiscal/accountingPeriodLock.service'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { postExpensePolicy } from '@/services/fiscal/expensePosting.service'
import { registerFixedAsset } from '@/services/fiscal/fixedAsset.service'
import { generateDepreciationForVenue } from '@/services/fiscal/fixedAssetDepreciation.service'
import { createManualEntry, postJournalEntry } from '@/services/fiscal/journalEntry.service'
import { createEmployee, runPayroll } from '@/services/fiscal/nomina.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
import prisma from '@/utils/prismaClient'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from '../master-catalog/catalogPublicationIntegrationHarness'

jest.setTimeout(240_000)

const MOTIVO =
  'La contabilidad de Avoqado todavía no maneja ventas con IVA distinto de 16 %. Como esta organización ya tuvo productos con otra tasa, las pólizas y el cierre de periodo están pausados. Escríbenos a hola@avoqado.io si lo necesitas.'
const PAUSA = { statusCode: 409, code: 'CONTABILIDAD_IVA_MIXTO', message: MOTIVO }

const corrida = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(-6).toUpperCase()
let consecutivo = 0
/** RFC único por corrida y por negocio: el folio y la idempotencia de las pólizas son por (organización, RFC). */
const nuevoRfc = () => `EXC${corrida}${String(++consecutivo).padStart(2, '0')}0`

interface Negocio {
  organizationId: string
  venueId: string
  rfc: string
}
const negocios: Negocio[] = []
const proveedores: string[] = []

async function nuevoNegocio({ contabilidad = true } = {}): Promise<Negocio> {
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
const marcar = (x: Negocio) => prisma.$executeRaw`UPDATE "Organization" SET "ivaMixtoAlgunaVez" = true WHERE id = ${x.organizationId}`

const cuenta = async (organizationId: string, rfc: string, code: string) =>
  (await prisma.ledgerAccount.findFirstOrThrow({ where: { organizationId, rfc, code }, select: { id: true } })).id

/** DEBE caja / HABER ventas por $116. */
async function lineasDeVenta(organizationId: string, rfc: string) {
  const [caja, ventas] = await Promise.all([cuenta(organizationId, rfc, '101.01'), cuenta(organizationId, rfc, '401.01')])
  return [
    { ledgerAccountId: caja, debitCents: 11_600, creditCents: 0 },
    { ledgerAccountId: ventas, debitCents: 0, creditCents: 11_600 },
  ]
}

const polizas = (organizationId: string) => prisma.journalEntry.count({ where: { organizationId } })

/** La operación debe salir con la pausa. Si NO lanza, el fallo muestra lo que sí escribió. */
async function debePausarse(operacion: Promise<unknown>): Promise<void> {
  const resultado = await operacion.then(
    escrito => ({ escrito }),
    (error: unknown) => error,
  )
  expect(resultado).toMatchObject(PAUSA) // primero: si no lanzó, el diff muestra `escrito`
  expect(resultado).toBeInstanceOf(ConflictError)
}

/** Cobro con tarjeta de $116 (sin renglones: la póliza usa el 16 % de siempre). */
async function cobroConTarjeta(x: Negocio, merchantAccountId?: string) {
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

/** Un comercio que sí entra a la contabilidad y otro excluido (`includeInAccounting = false`). */
async function dosComercios(x: Negocio) {
  const proveedor = await prisma.paymentProvider.create({
    data: { code: `EXC_${x.rfc}`, name: 'Procesador de prueba', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  proveedores.push(proveedor.id)
  const emisor = await prisma.fiscalEmisor.create({
    data: { venueId: x.venueId, rfc: x.rfc, legalName: 'Negocio de prueba', regimenFiscal: '601', lugarExpedicion: '01000' },
  })
  const comercio = async (includeInAccounting: boolean) => {
    const cuentaDeComercio = await prisma.merchantAccount.create({
      data: { providerId: proveedor.id, externalMerchantId: `${x.rfc}-${includeInAccounting}`, credentialsEncrypted: {} },
    })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId: cuentaDeComercio.id, fiscalEmisorId: emisor.id, includeInAccounting },
    })
    return cuentaDeComercio.id
  }
  return { incluido: await comercio(true), excluido: await comercio(false) }
}

beforeAll(() => assertDisposableCatalogPublicationDatabase())

afterAll(async () => {
  for (const { organizationId, venueId } of negocios) {
    await prisma.journalEntry.deleteMany({ where: { organizationId } })
    await prisma.accountingPeriodLock.deleteMany({ where: { organizationId } })
    await prisma.fixedAsset.deleteMany({ where: { organizationId } })
    await prisma.$executeRaw`DELETE FROM "PayrollLine" WHERE "payrollRunId" IN (SELECT id FROM "PayrollRun" WHERE "organizationId" = ${organizationId})`
    await prisma.payrollRun.deleteMany({ where: { organizationId } })
    await prisma.employee.deleteMany({ where: { organizationId } })
    await prisma.expense.deleteMany({ where: { organizationId } })
    await prisma.accountMapping.deleteMany({ where: { organizationId } })
    await prisma.ledgerAccount.deleteMany({ where: { organizationId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisor: { venueId } } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  }
  await prisma.merchantAccount.deleteMany({ where: { providerId: { in: proveedores } } })
  await prisma.paymentProvider.deleteMany({ where: { id: { in: proveedores } } })
})

describe('con la marca, ningún creador de pólizas escribe y el periodo no se cierra', () => {
  it('createManualEntry: ConflictError CONTABILIDAD_IVA_MIXTO con el mensaje exacto y cero pólizas', async () => {
    const x = await nuevoNegocio()
    const lines = await lineasDeVenta(x.organizationId, x.rfc)
    await marcar(x)

    await debePausarse(createManualEntry(x.venueId, { date: '2026-06-15', concept: 'Póliza manual', lines }, { staffId: null }))
    expect(await polizas(x.organizationId)).toBe(0)
  })

  it('closePeriod: la misma pausa y cero AccountingPeriodLock', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    await marcar(x)

    await debePausarse(closePeriod(x.venueId, '2026-06', { staffId: null }, 'cierre mensual'))
    expect(await prisma.accountingPeriodLock.count({ where: { organizationId: x.organizationId } })).toBe(0)
  })

  it('generatePoliciesForVenue, sin y con periodo: la misma pausa y cero pólizas', async () => {
    const x = await nuevoNegocio()
    await cobroConTarjeta(x)
    await marcar(x)
    const periodo = formatInTimeZone(new Date(), 'America/Mexico_City', 'yyyy-MM')

    await debePausarse(generatePoliciesForVenue(x.venueId))
    await debePausarse(generatePoliciesForVenue(x.venueId, { period: periodo }))
    expect(await polizas(x.organizationId)).toBe(0)
  })

  it('generateDepreciationForVenue: la misma pausa y cero pólizas; los renglones del ISR quedan sin postear (PF13)', async () => {
    const x = await nuevoNegocio()
    const activo = await prisma.fixedAsset.create({
      data: {
        organizationId: x.organizationId,
        rfc: x.rfc,
        venueId: x.venueId,
        description: 'Laptop de prueba',
        assetType: 'EQUIPO_COMPUTO',
        moiCents: 30_000_00,
        annualRate: new Prisma.Decimal('0.3'),
        acquisitionDate: new Date('2026-01-15T12:00:00Z'),
        inServiceDate: new Date('2026-01-15T12:00:00Z'),
      },
    })
    await marcar(x)

    await debePausarse(generateDepreciationForVenue(x.venueId, '2026-06', null))
    expect(await polizas(x.organizationId)).toBe(0)
    const renglones = await prisma.fixedAssetDepreciation.findMany({ where: { fixedAssetId: activo.id }, take: 5 })
    expect(renglones).toEqual([expect.objectContaining({ period: '2026-06', depreciationCents: 750_00, posted: false })])
  })

  it('el posteo de un gasto: la misma pausa, cero pólizas y el gasto sigue sin postear', async () => {
    const x = await nuevoNegocio()
    const gasto = await prisma.expense.create({
      data: {
        organizationId: x.organizationId,
        rfc: x.rfc,
        venueId: x.venueId,
        proveedorRfc: 'XAXX010101000',
        proveedorNombre: 'Proveedor de prueba',
        fechaEmision: new Date('2026-06-10T18:00:00Z'),
        subtotalCents: 10_000,
        ivaCents: 1_600,
        iva16Cents: 1_600,
        totalCents: 11_600,
        paymentStatus: 'PAID',
        formaPago: '03',
        dedupeKey: `exclusion-${x.rfc}`,
      },
    })
    await marcar(x)

    await debePausarse(postExpensePolicy(x.venueId, gasto.id, { staffId: null }))
    expect(await polizas(x.organizationId)).toBe(0)
    expect(await prisma.expense.findUniqueOrThrow({ where: { id: gasto.id }, select: { posted: true } })).toEqual({ posted: false })
  })

  it('runPayroll: la misma pausa, cero pólizas y la corrida NO queda POSTED', async () => {
    const x = await nuevoNegocio()
    await createEmployee(
      x.venueId,
      { nombre: 'Empleada de prueba', rfcEmpleado: `EMP${x.rfc.slice(3)}`, salarioMensualBrutoCents: 15_000_00 },
      {},
    )
    await marcar(x)

    await debePausarse(runPayroll(x.venueId, '2026-06', 'MENSUAL', '2026-06-30', { staffId: null }))
    expect(await polizas(x.organizationId)).toBe(0)
    const nomina = await prisma.payrollRun.findFirstOrThrow({
      where: { organizationId: x.organizationId },
      select: { status: true, posted: true },
    })
    expect(nomina).toEqual({ status: 'DRAFT', posted: false })
  })

  it('registrar un activo fijo: se crea igual y responde ledgerPosted false, ledgerReason ivaMixto y el motivo', async () => {
    const x = await nuevoNegocio()
    await marcar(x)

    const activo = await registerFixedAsset(
      x.venueId,
      { description: 'Laptop Dell', assetType: 'EQUIPO_COMPUTO', moiCents: 30_000_00, acquisitionDate: '2026-06-15' },
      null,
    )

    expect(activo).toMatchObject({ ledgerPosted: false, ledgerReason: 'ivaMixto', ledgerMessage: MOTIVO })
    expect(await prisma.fixedAsset.count({ where: { id: activo.id } })).toBe(1)
    expect(await polizas(x.organizationId)).toBe(0)
  })
})

describe('lo que la pausa NO cambia', () => {
  it('sin marca se postea con clave; ya marcada, re-postear la MISMA clave devuelve la póliza existente, no 409 (Review Focus 3)', async () => {
    const x = await nuevoNegocio()
    const entrada = {
      date: '2026-06-15',
      concept: 'Venta con clave',
      source: JournalEntrySource.PAYMENT,
      idempotencyKey: `exclusion:${x.rfc}:v1`,
      lines: await lineasDeVenta(x.organizationId, x.rfc),
    }
    const primera = await postJournalEntry(x.venueId, entrada, { staffId: null })
    await marcar(x)

    const segunda = await postJournalEntry(x.venueId, entrada, { staffId: null })

    expect(segunda.id).toBe(primera.id)
    expect(await polizas(x.organizationId)).toBe(1)
  })

  it('sin marca, con dos comercios, sólo se postean los pagos del que entra a la contabilidad (Review Focus 4)', async () => {
    const x = await nuevoNegocio()
    const { incluido, excluido } = await dosComercios(x)
    const pagoIncluido = await cobroConTarjeta(x, incluido)
    await cobroConTarjeta(x, excluido)

    await expect(generatePoliciesForVenue(x.venueId)).resolves.toMatchObject({ posted: 1, skipped: 1 })
    const claves = await prisma.journalEntry.findMany({
      where: { organizationId: x.organizationId },
      select: { idempotencyKey: true },
      take: 5,
    })
    expect(claves).toEqual([{ idempotencyKey: `pay:${pagoIncluido.id}:v1` }])
  })

  it('con marca, la corrida sale 409 aunque TODOS los pagos sean del comercio excluido (Review Focus 4)', async () => {
    const x = await nuevoNegocio()
    const { excluido } = await dosComercios(x)
    await cobroConTarjeta(x, excluido)
    await marcar(x)

    await debePausarse(generatePoliciesForVenue(x.venueId))
    expect(await polizas(x.organizationId)).toBe(0)
  })

  it('exigirContabilidadDisponible con una organización que ya no es la del negocio: 409 IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION', async () => {
    const { exigirContabilidadDisponible } = await import('@/services/fiscal/exclusionContable')
    const negocio = await nuevoNegocio({ contabilidad: false })
    const otra = await nuevoNegocio({ contabilidad: false })

    const error = await prisma
      .$transaction(tx => exigirContabilidadDisponible(tx, { venueId: negocio.venueId, organizationId: otra.organizationId }))
      .then(
        () => null,
        (e: unknown) => e,
      )

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({
      statusCode: 409,
      code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION',
      message: 'Este negocio acaba de cambiar de organización. Vuelve a intentarlo.',
    })
  })
})

describe('una publicación de catálogo en vuelo retiene Organization: el posteo y el cierre ESPERAN y terminan bien', () => {
  let harness: CatalogPublicationIntegrationHarness | null = null
  const fixtures: CatalogPublicationFixture[] = []
  const h = () => {
    if (!harness) throw new Error('El arnés del catálogo no se inició')
    return harness
  }

  beforeAll(async () => {
    harness = await createCatalogPublicationIntegrationHarness('exclusion-contable')
  })

  afterAll(async () => {
    try {
      for (const f of fixtures) {
        await h().primary.journalEntry.deleteMany({ where: { organizationId: f.organizationId } })
        await h().primary.accountingPeriodLock.deleteMany({ where: { organizationId: f.organizationId } })
        await h().primary.ledgerAccount.deleteMany({ where: { organizationId: f.organizationId } })
        await cleanupCatalogPublicationFixture(h().primary, f)
      }
    } finally {
      await harness?.disconnect()
    }
  })

  /** Organización SIN marca (producto local al 16 %), con RFC y catálogo de cuentas, y su publicación lista para confirmar. */
  async function publicacionLista(suite: string) {
    const f = await createCatalogPublicationFixture(h().primary, suite, { productTaxRate: '0.1600' })
    fixtures.push(f)
    const rfc = nuevoRfc()
    await h().primary.venue.update({ where: { id: f.venueId }, data: { rfc } })
    await seedBaseChart(f.venueId, { staffId: null })
    const { createCatalogPublicationPreviewService } = await import('@/services/master-catalog/catalogPublicationPreview.service')
    const { createCatalogPublicationConfirmationService } = await import('@/services/master-catalog/catalogPublicationConfirmation.service')
    const context: CatalogCommandContext = {
      organizationId: f.organizationId,
      actor: { type: 'HUMAN', staffId: f.staffId, impersonating: false },
      orgRole: 'OWNER',
    }
    const idempotencyKey = `exclusion-${f.key}`
    const preview = await createCatalogPublicationPreviewService({ prisma: h().primary as never }).preview(context, {
      operation: 'CATALOG_FIELDS_PUBLISH',
      idempotencyKey,
      targets: [{ catalogItemId: f.catalogItemId, venueId: f.venueId, productId: f.productId }],
    })
    const confirmar = () =>
      createCatalogPublicationConfirmationService({ prisma: h().writerOne as never }).confirm(context, {
        publicationBatchId: preview.publicationBatchId,
        previewToken: preview.previewToken,
        idempotencyKey,
        confirm: true,
      })
    return { f, rfc, confirmar }
  }

  /** Sondea pg_stat_activity (desde la conexión observadora) hasta que la condición se cumpla. */
  async function hastaQue(descripcion: string, plazoMs: number, sql: Prisma.Sql): Promise<void> {
    const limite = Date.now() + plazoMs
    while (Date.now() < limite) {
      const [fila] = await h().observer.$queryRaw<Array<{ n: number }>>(sql)
      if (fila.n > 0) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`Nunca se vio: ${descripcion}`)
  }

  /**
   * Pausa la publicación REAL con un bloqueador sobre el `CatalogItem` que pide DESPUÉS de tomar Organization y Venue,
   * lanza la operación contable, prueba en pg_stat_activity que ESPERA detrás de la publicación y suelta. El catálogo
   * fija `lock_timeout = 5s` al aplicar: desde que espera el `CatalogItem`, el bloqueo se sostiene lo mínimo.
   */
  async function conPublicacionEnVuelo<T>(
    f: CatalogPublicationFixture,
    confirmar: () => Promise<unknown>,
    operacion: () => Promise<T>,
  ): Promise<{ publicacion: unknown; resultado: Awaited<T> }> {
    let retenido!: () => void
    let soltar!: () => void
    const estaRetenido = new Promise<void>(resolve => (retenido = resolve))
    const suelto = new Promise<void>(resolve => (soltar = resolve))
    const bloqueador = h().blocker.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "CatalogItem" WHERE id = ${f.catalogItemId} FOR UPDATE`
        retenido()
        await suelto
      },
      { timeout: 60_000, maxWait: 20_000 },
    )
    await estaRetenido

    const publicacion = confirmar()
    publicacion.catch(() => undefined)
    let resultado: Promise<T> | null = null
    try {
      // La publicación ya tiene Organization y Venue y espera la fila retenida.
      await hastaQue(
        'la publicación esperando la fila retenida del catálogo',
        60_000,
        Prisma.sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = ${h().names.writerOne}
            AND wait_event_type = 'Lock' AND wait_event <> 'advisory'`,
      )
      resultado = operacion()
      resultado.catch(() => undefined)
      // La sentencia FOR SHARE de la contabilidad sobre Organization la bloquea la publicación, no otro.
      await hastaQue(
        'la operación contable esperando detrás de la publicación de catálogo',
        4_000,
        Prisma.sql`SELECT count(*)::int AS n
          FROM pg_stat_activity contable
          JOIN pg_stat_activity catalogo ON catalogo.pid = ANY(pg_blocking_pids(contable.pid))
          WHERE contable.datname = current_database()
            AND contable.wait_event_type = 'Lock'
            AND contable.query LIKE '%FROM "Organization"%FOR SHARE%'
            AND catalogo.application_name = ${h().names.writerOne}`,
      )
    } finally {
      soltar()
      await bloqueador
      // Nada queda en vuelo cuando la prueba (o su limpieza) sigue.
      await Promise.allSettled([publicacion, resultado])
    }
    return { publicacion: await publicacion, resultado: await resultado! }
  }

  it('createManualEntry espera a la publicación (pg_stat_activity) y, al soltarla, postea bien', async () => {
    const { f, rfc, confirmar } = await publicacionLista('exclusion-posteo')
    const lines = await lineasDeVenta(f.organizationId, rfc)

    const { publicacion, resultado } = await conPublicacionEnVuelo(f, confirmar, () =>
      createManualEntry(f.venueId, { date: '2026-06-15', concept: 'Póliza detrás del catálogo', lines }, { staffId: null }),
    )

    expect(publicacion).toMatchObject({ state: 'APPLIED' })
    expect(resultado).toMatchObject({ totalDebitCents: 11_600, totalCreditCents: 11_600 })
    expect(await polizas(f.organizationId)).toBe(1)
  })

  it('closePeriod espera a la publicación (pg_stat_activity) y, al soltarla, cierra bien', async () => {
    const { f, confirmar } = await publicacionLista('exclusion-cierre')

    const { publicacion, resultado } = await conPublicacionEnVuelo(f, confirmar, () =>
      closePeriod(f.venueId, '2026-06', { staffId: null }, 'cierre detrás del catálogo'),
    )

    expect(publicacion).toMatchObject({ state: 'APPLIED' })
    expect(resultado).toMatchObject({ needsFiscalSetup: false, status: 'CLOSED' })
    expect(await prisma.accountingPeriodLock.count({ where: { organizationId: f.organizationId, status: 'CLOSED' } })).toBe(1)
  })
})

// Review Focus 1 / Ruling R11: un candado de más de 5 s también puede vencer en una consulta de MODELO (no cruda) — el INSERT de
// las líneas que espera la FK de LedgerAccount, o el upsert del cierre que espera el índice único. Igual termina en 409
// CONTABILIDAD_OCUPADA tras agotar los reintentos, sin escribir nada; nunca un error crudo.
describe('un candado de más de 5 s en una consulta de modelo termina en 409 CONTABILIDAD_OCUPADA', () => {
  const OCUPADA = {
    statusCode: 409,
    code: 'CONTABILIDAD_OCUPADA',
    message: 'La contabilidad está ocupada en este momento. Vuelve a intentarlo en unos segundos.',
  }

  /** Alguien espera un candado (pg_stat_activity) que retiene el bloqueador. */
  async function hastaQueEspereDetrasDe(pid: number): Promise<void> {
    const limite = Date.now() + 30_000
    while (Date.now() < limite) {
      const [fila] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(a.pid))`
      if (fila.n > 0) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('La operación nunca quedó esperando detrás del bloqueador')
  }

  /**
   * Otra transacción retiene lo que la operación REAL necesita después de tomar sus candados; se prueba la espera y se sostiene
   * hasta que la operación se rinde. Al final el bloqueador se REVIERTE: lo que quede escrito es sólo de la operación.
   */
  async function conBloqueador(retener: (tx: Prisma.TransactionClient) => Promise<unknown>, operacion: () => Promise<unknown>) {
    let listo!: (pid: number) => void
    let soltar!: () => void
    const pidDelBloqueador = new Promise<number>(resolve => (listo = resolve))
    const suelto = new Promise<void>(resolve => (soltar = resolve))
    const REVERTIR = new Error('revertir el bloqueador')
    const bloqueo = prisma
      .$transaction(
        async tx => {
          await retener(tx)
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          listo(pid)
          await suelto
          throw REVERTIR
        },
        { timeout: 180_000, maxWait: 20_000 },
      )
      .catch((e: unknown) => {
        if (e !== REVERTIR) throw e
      })
    const pid = await pidDelBloqueador
    const resultado = operacion().then(
      escrito => ({ escrito }),
      (error: unknown) => error,
    )
    try {
      await hastaQueEspereDetrasDe(pid)
      return await resultado
    } finally {
      soltar()
      await bloqueo
    }
  }

  it('createManualEntry: el INSERT de sus líneas espera una LedgerAccount retenida ⇒ 409 CONTABILIDAD_OCUPADA y cero pólizas', async () => {
    const x = await nuevoNegocio()
    const lines = await lineasDeVenta(x.organizationId, x.rfc)

    const resultado = await conBloqueador(
      tx => tx.$queryRaw`SELECT id FROM "LedgerAccount" WHERE id = ${lines[0].ledgerAccountId} FOR UPDATE`,
      () => createManualEntry(x.venueId, { date: '2026-06-15', concept: 'Póliza detrás de una cuenta retenida', lines }, { staffId: null }),
    )

    expect(resultado).toMatchObject(OCUPADA)
    expect(resultado).toBeInstanceOf(ConflictError)
    expect(await polizas(x.organizationId)).toBe(0)
  })

  it('closePeriod: el upsert espera el mismo periodo insertado sin confirmar ⇒ 409 CONTABILIDAD_OCUPADA y cero candados', async () => {
    const x = await nuevoNegocio({ contabilidad: false })

    const resultado = await conBloqueador(
      tx => tx.accountingPeriodLock.create({ data: { organizationId: x.organizationId, rfc: x.rfc, period: '2026-06' } }),
      () => closePeriod(x.venueId, '2026-06', { staffId: null }, 'cierre detrás de otro cierre'),
    )

    expect(resultado).toMatchObject(OCUPADA)
    expect(resultado).toBeInstanceOf(ConflictError)
    expect(await prisma.accountingPeriodLock.count({ where: { organizationId: x.organizationId } })).toBe(0)
  })
})
