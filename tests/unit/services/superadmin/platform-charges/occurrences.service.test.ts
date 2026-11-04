import { prismaMock } from '@tests/__helpers__/setup'

// La factura es la frontera de otro módulo (invoice.service, ya probado a fondo): aquí se reemplaza por dobles que dicen qué contestó.
// El candado (`withChargeLock`), la transacción y los helpers de fecha son el código real contra un doble en memoria de las tablas.
jest.mock('@/services/superadmin/platform-charges/invoice.service', () => ({
  invoiceOccurrence: jest.fn(),
  resolverIntento: jest.fn(),
  findProfileId: jest.fn(),
  intentKey: (o: { id: string; invoiceSeq: number }) => `por-cobrar:${o.id}:${o.invoiceSeq}`,
}))

import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'
import { findProfileId, invoiceOccurrence, resolverIntento } from '@/services/superadmin/platform-charges/invoice.service'
import {
  groupOccurrences,
  invoiceCategoryWhere,
  invoiceOccurrenceView,
  listOccurrences,
  MAX_GROUP_ROWS,
  occurrenceWhere,
  payOccurrence,
  payPreview,
  reopenOccurrence,
  skipOccurrence,
  summarizeOccurrences,
} from '@/services/superadmin/platform-charges/occurrences.service'
import { calendarDayToDb } from '@/services/superadmin/platform-charges/schedule'

/**
 * «Por cobrar» — pagar, omitir, deshacer y las lecturas de la pantalla (spec 2026-11-02-por-cobrar-superadmin §3.4, §3.5 y §5).
 *
 * Es dinero, fechas y permisos: esta suite se corre también con `TZ=UTC` y con otras zonas (la zona se fija ANTES de que arranque
 * Jest). Qué NO prueba un doble en memoria: que la fila del cobro de verdad bloquee a la otra transacción, ni que los filtros de una
 * columna `@db.Date` o el orden de una consulta funcionen en Postgres bajo una sesión en America/Mexico_City: eso lo prueba la
 * integración contra Postgres (`tests/integration/superadmin/platform-charges.integration.test.ts`). Aquí se prueba el contrato:
 * qué se lee, qué se decide, en qué orden y qué se escribe.
 */

const mockLogAction = logAction as jest.Mock
const mockLoggerError = (logger as unknown as { error: jest.Mock }).error
const mockInvoice = invoiceOccurrence as jest.Mock
const mockResolver = resolverIntento as jest.Mock
const mockFindProfileId = findProfileId as jest.Mock

const AHORA = new Date('2026-11-02T18:00:00.000Z') // 12:00 en CDMX · lunes 2-nov-2026
const AHORA_TARDE = new Date('2026-11-03T05:30:00.000Z') // 23:30 del 2-nov en CDMX, pero en UTC ya es 3-nov

type Fila = Record<string, any>

const CONCEPTOS = [
  { description: 'Renta de terminal', amountCents: 50000, ivaMode: 'WITHOUT_IVA', satProductKey: '81112401', satUnitKey: 'E48' },
  { description: 'Licencia', amountCents: 49900, ivaMode: 'WITH_IVA', satProductKey: '43232611', satUnitKey: 'E48' },
]
/** $500 sin IVA + $499 con IVA, a mano: A=50000, B=49900 → subtotal 93017, IVA 14883, total 107900 (= 58000 + 49900). */
const TOTALES = { subtotalCents: 93017, taxCents: 14883, totalCents: 107900 }

/** Como queda guardado un cobro sin factura (NONE): las claves del SAT vacías. */
const SIN_CLAVES = [{ description: 'Venta de equipo', amountCents: 1000000, ivaMode: 'WITH_IVA', satProductKey: '', satUnitKey: '' }]

const hace = (minutos: number) => new Date(AHORA.getTime() - minutos * 60_000)

function ocurrencia(over: Fila = {}): Fila {
  return {
    id: 'occ-1',
    chargeId: 'cobro-1',
    dueDate: calendarDayToDb('2026-11-01'),
    concepts: CONCEPTOS.map(c => ({ ...c })),
    ...TOTALES,
    invoiceMode: 'AUTOMATIC',
    status: 'PENDING',
    paidAt: null,
    paidById: null,
    skippedAt: null,
    skippedById: null,
    invoiceSeq: 0,
    createdAt: hace(60 * 24),
    updatedAt: hace(60 * 24),
    ...over,
  }
}

function cobro(over: Fila = {}): Fila {
  return {
    id: 'cobro-1',
    customerType: 'ORGANIZATION',
    organizationId: 'org-1',
    venueId: null,
    customerName: 'Estética Luna',
    billingTaxProfileId: 'perfil-1',
    frequency: 'MONTHLY',
    concepts: CONCEPTOS,
    invoiceMode: 'AUTOMATIC',
    ...over,
  }
}

function factura(over: Fila = {}): Fila {
  return {
    id: 'cfdi-1',
    platformChargeOccurrenceId: 'occ-1',
    idempotencyKey: 'por-cobrar:occ-1:0',
    status: 'STAMPED',
    serie: 'A',
    folio: '118',
    uuid: 'UUID-1',
    metodoPago: 'PUE',
    chargeLinkedAt: null,
    ...TOTALES,
    lastError: null,
    emailSentAt: hace(10),
    createdAt: hace(20),
    ...over,
  }
}

const PERFIL = { id: 'perfil-1', rfc: 'LUN010101AAA', razonSocial: 'ESTETICA LUNA SA DE CV', regimenFiscal: '601', codigoPostal: '06000' }

// ── Doble en memoria ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Mundo {
  occ: Fila
  charge: Fila
  cfdis: Fila[]
  /** Cuántas facturas PPD STAMPED sin liquidar contesta el conteo crudo. */
  ppd: number
}
let mundo: Mundo

const elegir = (fuente: Fila, select: Fila): Fila => Object.fromEntries(Object.keys(select).map(k => [k, fuente[k]]))

/** `include` de Prisma: el cobro (con su select) y las facturas de la ocurrencia, de la más nueva a la más vieja, con su `take`. */
function conRelaciones(fila: Fila, include: Fila | undefined): Fila {
  const out: Fila = { ...fila }
  if (include?.charge) out.charge = include.charge.select ? elegir(mundo.charge, include.charge.select) : { ...mundo.charge }
  if (include?.invoices) {
    out.invoices = mundo.cfdis
      .filter(c => c.platformChargeOccurrenceId === fila.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, include.invoices.take ?? Number.MAX_SAFE_INTEGER)
      .map(c => ({ ...c }))
  }
  return out
}

function instalar() {
  const ocurrencias = prismaMock.platformChargeOccurrence
  ocurrencias.findUnique.mockImplementation(async ({ where, select, include }: any) => {
    if (where.id !== mundo.occ.id) return null
    return select ? elegir(mundo.occ, select) : conRelaciones(mundo.occ, include)
  })
  ocurrencias.update.mockImplementation(async ({ data }: any) => Object.assign(mundo.occ, data) && { ...mundo.occ })
  prismaMock.$queryRaw.mockImplementation(async (partes: TemplateStringsArray, ...valores: unknown[]) => {
    const sql = partes.join('?')
    if (sql.includes('FOR UPDATE')) return [{ id: valores[0] }]
    throw new Error(`consulta cruda inesperada: ${sql}`)
  })
  prismaMock.platformCfdi.findUnique.mockImplementation(
    async ({ where }: any) => mundo.cfdis.find(c => c.idempotencyKey === where.idempotencyKey) ?? null,
  )
  // De la más nueva a la más vieja, con `id` de desempate, como el `orderBy` de la vista.
  const nuevasPrimero = (filas: Fila[]) =>
    [...filas].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || String(b.id).localeCompare(String(a.id)))
  // La anexada viva de una fecha: se niega a contestar sin la fecha, y sólo entiende lo que el servicio pregunta.
  prismaMock.platformCfdi.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.platformChargeOccurrenceId === undefined) throw new Error('el doble exige la fecha')
    const halladas = mundo.cfdis.filter(
      c =>
        c.platformChargeOccurrenceId === where.platformChargeOccurrenceId &&
        (where.chargeLinkedAt === undefined || c.chargeLinkedAt) &&
        where.status.in.includes(c.status),
    )
    return nuevasPrimero(halladas)[0] ?? null
  })
  // Las vivas de una página: una por fecha (`distinct`) y con su tope, igual que en la base.
  prismaMock.platformCfdi.findMany.mockImplementation(async ({ where, distinct, take }: any) => {
    const halladas = nuevasPrimero(
      mundo.cfdis.filter(
        c => where.platformChargeOccurrenceId.in.includes(c.platformChargeOccurrenceId) && where.status.in.includes(c.status),
      ),
    )
    const vistas = new Set<string>()
    const unaPorFecha = distinct
      ? halladas.filter(c => !vistas.has(c.platformChargeOccurrenceId) && Boolean(vistas.add(c.platformChargeOccurrenceId)))
      : halladas
    return unaPorFecha.slice(0, take)
  })
  prismaMock.platformCfdi.count.mockImplementation(async () => mundo.ppd)
  prismaMock.billingTaxProfile.findUnique.mockImplementation(async ({ where, select }: any) => {
    if (where.id !== PERFIL.id) return null
    return select ? Object.fromEntries(Object.keys(select).map(campo => [campo, (PERFIL as any)[campo]])) : { ...PERFIL }
  })
  mockFindProfileId.mockResolvedValue(PERFIL.id)
  mockResolver.mockResolvedValue({ kind: 'NONE' })
}

beforeEach(() => {
  for (const fn of [
    prismaMock.$queryRaw,
    prismaMock.platformChargeOccurrence.findUnique,
    prismaMock.platformChargeOccurrence.findMany,
    prismaMock.platformChargeOccurrence.count,
    prismaMock.platformChargeOccurrence.aggregate,
    prismaMock.platformChargeOccurrence.update,
    prismaMock.platformCfdi.findUnique,
    prismaMock.platformCfdi.findFirst,
    prismaMock.platformCfdi.findMany,
    prismaMock.platformCfdi.count,
    prismaMock.billingTaxProfile.findUnique,
    mockLogAction,
    mockLoggerError,
    mockInvoice,
    mockResolver,
    mockFindProfileId,
    prismaMock.$transaction,
  ]) {
    fn.mockReset()
  }
  // La transacción de prueba corre el cuerpo con el mismo doble como `tx` (la de verdad la prueba la integración).
  prismaMock.$transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock))
  mundo = { occ: ocurrencia(), charge: cobro(), cfdis: [], ppd: 0 }
  instalar()
})

/** Anota en orden cada paso que importa. Se llama DESPUÉS de instalar los dobles: envuelve lo que haya. */
function trazar(): string[] {
  const eventos: string[] = []
  const anotar = (mock: jest.Mock, nombre: string) => {
    const original = mock.getMockImplementation()
    mock.mockImplementation(async (...args: unknown[]) => {
      eventos.push(nombre)
      return original?.(...args)
    })
  }
  anotar(prismaMock.$queryRaw, 'candado')
  anotar(prismaMock.platformChargeOccurrence.update, 'actualizar')
  anotar(prismaMock.platformCfdi.findUnique, 'buscar factura')
  mockResolver.mockImplementation(async () => {
    eventos.push('resolver intento')
    return { kind: 'NONE' }
  })
  mockInvoice.mockImplementation(async () => {
    eventos.push('facturar')
    return factura()
  })
  mockLogAction.mockImplementation(() => {
    eventos.push('bitácora')
  })
  prismaMock.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
    eventos.push('tx:inicio')
    try {
      return await callback(prismaMock)
    } finally {
      eventos.push('tx:fin')
    }
  })
  return eventos
}

const sinEscrituras = () => {
  expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
  expect(mockLogAction).not.toHaveBeenCalled()
}
const PAGADA = (over: Fila = {}) => ({ status: 'PAID', paidAt: hace(30), paidById: 'staff-0', ...over })
const OMITIDA = (over: Fila = {}) => ({ status: 'SKIPPED', skippedAt: hace(30), skippedById: 'staff-0', ...over })

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/occurrences — payOccurrence', () => {
  it('PENDING → PAID bajo el candado del cobro: toma el candado, relee, escribe, y la bitácora va DESPUÉS y fuera de la transacción', async () => {
    const eventos = trazar()

    const r = await payOccurrence('occ-1', { invoice: false }, 'staff-1', AHORA)

    expect(eventos).toEqual(['tx:inicio', 'candado', 'actualizar', 'tx:fin', 'bitácora'])
    expect(mundo.occ).toMatchObject({ status: 'PAID', paidAt: AHORA, paidById: 'staff-1' })
    expect(r.occurrence).toMatchObject({ id: 'occ-1', chargeId: 'cobro-1', status: 'PAID', dueDate: '2026-11-01', bucket: null })
    expect(r.invoice).toBeNull()
    expect(mockInvoice).not.toHaveBeenCalled()
  })

  it('deja la bitácora PLATFORM_CHARGE_PAID con quien lo pidió, el negocio, la organización y la ocurrencia', async () => {
    await payOccurrence('occ-1', { invoice: false }, 'staff-1', AHORA)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-1',
      venueId: null,
      organizationId: 'org-1',
      action: 'PLATFORM_CHARGE_PAID',
      entity: 'PlatformCharge',
      entityId: 'cobro-1',
      data: { occurrenceId: 'occ-1', dueDate: '2026-11-01', totalCents: 107900, invoice: false, invoiceMode: 'MANUAL' },
    })
  })

  it('con factura: marca PAID y DESPUÉS llama a invoiceOccurrence con la ocurrencia y quien lo pidió', async () => {
    const eventos = trazar()

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(eventos).toEqual(['tx:inicio', 'candado', 'actualizar', 'tx:fin', 'bitácora', 'facturar'])
    expect(mockInvoice).toHaveBeenCalledWith('occ-1', { actorId: 'staff-1' })
    expect(r.invoice).toMatchObject({ ok: true, cfdi: { id: 'cfdi-1', status: 'STAMPED' } })
    expect(mundo.occ.invoiceMode).toBe('AUTOMATIC') // se timbró: sigue siendo automática
  })

  it('🔴 lo que el diálogo enseñó viaja hasta el timbrado: si ya es otra cosa, no se le factura a quien no se vio', async () => {
    const VISTO = { rfc: 'LUN010101AAA', razonSocial: 'ESTETICA LUNA SA DE CV', regimenFiscal: '601', codigoPostal: '06000' }
    mockInvoice.mockResolvedValue(factura())

    await payOccurrence('occ-1', { invoice: true, receptor: VISTO }, 'staff-1', AHORA)

    expect(mockInvoice).toHaveBeenCalledWith('occ-1', { actorId: 'staff-1', receptor: VISTO })
  })

  it('pay NO repite PLATFORM_CFDI_ISSUED: ya la escribe invoiceOccurrence al timbrar', async () => {
    mockInvoice.mockResolvedValue(factura())

    await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PLATFORM_CFDI_ISSUED' }))
  })

  it('si el PAC contesta sin timbre, invoiceOccurrence regresa la fila STAMPING y pay la devuelve tal cual (ok: true)', async () => {
    mockInvoice.mockResolvedValue(factura({ status: 'STAMPING', uuid: null, folio: null, facturapiId: 'fa-1' }))

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(r.invoice).toMatchObject({ ok: true, cfdi: { status: 'STAMPING' } })
  })

  it('repetir sobre una ya PAGADA contesta éxito: no escribe, no factura y no repite la bitácora', async () => {
    Object.assign(mundo.occ, PAGADA())
    const pagadaEn = mundo.occ.paidAt

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-2', AHORA)

    expect(r.occurrence).toMatchObject({ id: 'occ-1', status: 'PAID' })
    expect(r.invoice).toBeNull()
    expect(mockInvoice).not.toHaveBeenCalled()
    expect(mundo.occ.paidAt).toBe(pagadaEn)
    expect(mundo.occ.paidById).toBe('staff-0')
    sinEscrituras()
  })

  it('con factura que FALLA: la ocurrencia SIGUE pagada y la respuesta trae el mensaje, el código y el campo', async () => {
    mockInvoice.mockRejectedValue(
      new PlatformBillingError('Error al timbrar el CFDI: El RFC del receptor no está registrado en el SAT.', 'VALIDATION', 'rfc'),
    )

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(mundo.occ.status).toBe('PAID')
    expect(r.occurrence.status).toBe('PAID')
    expect(r.invoice).toEqual({
      ok: false,
      message: 'Error al timbrar el CFDI: El RFC del receptor no está registrado en el SAT.',
      code: 'VALIDATION',
      field: 'rfc',
    })
  })

  it('un 409 de la factura (la anterior sigue en trámite) también queda como ok: false, con el código del conflicto y sin campo', async () => {
    mockInvoice.mockRejectedValue(
      new ConflictError('El SAT la sigue procesando; consulta el estado en unos minutos', 'PLATFORM_CHARGE_INVOICE_PROCESSING'),
    )

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(r.invoice).toStrictEqual({
      ok: false,
      message: 'El SAT la sigue procesando; consulta el estado en unos minutos',
      code: 'PLATFORM_CHARGE_INVOICE_PROCESSING',
    })
    expect(r.occurrence.status).toBe('PAID')
  })

  it('sin datos fiscales: ok: false con NEEDS_FISCAL_DATA (la pantalla abre el diálogo para capturarlos) y sigue pagada', async () => {
    mockInvoice.mockRejectedValue(
      new PlatformBillingError('Captura los datos fiscales del cliente para poder facturarle', 'NEEDS_FISCAL_DATA'),
    )

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(r.invoice).toMatchObject({ ok: false, code: 'NEEDS_FISCAL_DATA' })
    expect(r.occurrence.status).toBe('PAID')
  })

  it('un error que no es de negocio (se cayó algo) no se cuela al operador: mensaje genérico, UNEXPECTED, queda en el log y sigue pagada', async () => {
    mockInvoice.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'))

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(r.invoice).toMatchObject({ ok: false, code: 'UNEXPECTED', message: expect.stringContaining('Facturar') })
    expect((r.invoice as { message: string }).message).not.toContain('ECONNREFUSED')
    expect(mockLoggerError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ platformChargeOccurrenceId: 'occ-1' }))
    expect(r.occurrence.status).toBe('PAID')
  })

  it('sin la casilla («Timbrar factura ahora») sobre una AUTOMÁTICA: la ocurrencia queda MANUAL y no se factura', async () => {
    const r = await payOccurrence('occ-1', { invoice: false }, 'staff-1', AHORA)

    expect(prismaMock.platformChargeOccurrence.update).toHaveBeenCalledWith({
      where: { id: 'occ-1' },
      data: { status: 'PAID', paidAt: AHORA, paidById: 'staff-1', invoiceMode: 'MANUAL' },
    })
    expect(r.occurrence.invoiceMode).toBe('MANUAL')
    expect(mockInvoice).not.toHaveBeenCalled()
  })

  it('sin la casilla sobre una MANUAL: sigue MANUAL y no escribe el modo (sólo estado, momento y quién)', async () => {
    Object.assign(mundo.occ, { invoiceMode: 'MANUAL' })

    await payOccurrence('occ-1', { invoice: false }, 'staff-1', AHORA)

    expect(prismaMock.platformChargeOccurrence.update).toHaveBeenCalledWith({
      where: { id: 'occ-1' },
      data: { status: 'PAID', paidAt: AHORA, paidById: 'staff-1' },
    })
  })

  it('sin la casilla sobre una SIN FACTURA (NONE): sigue NONE, no se convierte en MANUAL y no se factura', async () => {
    Object.assign(mundo.occ, { invoiceMode: 'NONE', concepts: SIN_CLAVES })

    const r = await payOccurrence('occ-1', { invoice: false }, 'staff-1', AHORA)

    expect(prismaMock.platformChargeOccurrence.update).toHaveBeenCalledWith({
      where: { id: 'occ-1' },
      data: { status: 'PAID', paidAt: AHORA, paidById: 'staff-1' }, // el modo no se toca
    })
    expect(r.occurrence.invoiceMode).toBe('NONE')
    expect(r.invoice).toBeNull()
    expect(mockInvoice).not.toHaveBeenCalled()
  })

  it('con la casilla sobre una MANUAL: también factura (el modo no cambia)', async () => {
    Object.assign(mundo.occ, { invoiceMode: 'MANUAL' })
    mockInvoice.mockResolvedValue(factura())

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(mockInvoice).toHaveBeenCalledTimes(1)
    expect(r.occurrence.invoiceMode).toBe('MANUAL')
    expect(r.invoice).toMatchObject({ ok: true })
  })

  it('una OMITIDA es 409 «deshazlo primero»: no se escribe nada y no se factura', async () => {
    Object.assign(mundo.occ, OMITIDA())

    const error = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).statusCode).toBe(409)
    expect((error as ConflictError).message).toMatch(/omitido/i)
    expect(mundo.occ.status).toBe('SKIPPED')
    expect(mockInvoice).not.toHaveBeenCalled()
    sinEscrituras()
  })

  it('una ocurrencia que no existe es 404 (y nunca llega a tomar el candado)', async () => {
    await expect(payOccurrence('no-existe', { invoice: true }, 'staff-1', AHORA)).rejects.toBeInstanceOf(NotFoundError)

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    sinEscrituras()
  })

  it('si la ocurrencia desapareció entre la lectura y el candado (otra pestaña regeneró las fechas): 404, no se escribe nada', async () => {
    // El candado se toma, y al releer la ocurrencia ya no está.
    prismaMock.platformChargeOccurrence.findUnique.mockResolvedValueOnce({ chargeId: 'cobro-1' }).mockResolvedValueOnce(null)

    await expect(payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)).rejects.toBeInstanceOf(NotFoundError)

    sinEscrituras()
    expect(mockInvoice).not.toHaveBeenCalled()
  })

  describe('🔴 «Ya me pagó» confirma un importe (Codex r2, hallazgo 1)', () => {
    it('si el total que se confirmó ya no es el de la fecha: 409 PLATFORM_CHARGE_OCCURRENCE_TOTAL_CHANGED con el monto nuevo, y no se marca nada', async () => {
      // El operador abrió el diálogo por $580.00; otra pestaña anexó una factura y la fecha ahora es de $1,079.00.
      const error = await payOccurrence('occ-1', { invoice: true, expectedTotalCents: 58000 }, 'staff-1', AHORA).then(
        () => {
          throw new Error('se esperaba un rechazo y pasó')
        },
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).statusCode).toBe(409)
      expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_OCCURRENCE_TOTAL_CHANGED')
      expect((error as ConflictError).message).toBe('El monto de este cobro cambió a $1,079.00; revísalo y confirma otra vez')
      expect(mundo.occ).toMatchObject({ status: 'PENDING', paidAt: null, paidById: null, invoiceMode: 'AUTOMATIC' })
      expect(mockInvoice).not.toHaveBeenCalled()
      sinEscrituras()
    })

    it('con el total que sí es: paga como siempre', async () => {
      const r = await payOccurrence('occ-1', { invoice: false, expectedTotalCents: 107900 }, 'staff-1', AHORA)

      expect(mundo.occ).toMatchObject({ status: 'PAID', paidAt: AHORA, paidById: 'staff-1' })
      expect(r.occurrence).toMatchObject({ status: 'PAID', totalCents: 107900 })
    })

    it('un total confirmado de cero también se compara (0 no es «sin campo»)', async () => {
      await expect(payOccurrence('occ-1', { invoice: false, expectedTotalCents: 0 }, 'staff-1', AHORA)).rejects.toMatchObject({
        code: 'PLATFORM_CHARGE_OCCURRENCE_TOTAL_CHANGED',
      })
      sinEscrituras()
    })

    it('sin el campo, igual que hoy: paga el importe que haya', async () => {
      await payOccurrence('occ-1', { invoice: false }, 'staff-1', AHORA)

      expect(mundo.occ.status).toBe('PAID')
    })

    it('se compara con lo RELEÍDO bajo el candado: si el monto cambió entre la lectura y el candado, también es 409', async () => {
      prismaMock.platformChargeOccurrence.findUnique
        .mockImplementationOnce(async () => ({ chargeId: 'cobro-1' }))
        .mockImplementationOnce(async () => {
          mundo.occ.totalCents = 20000
          return { ...mundo.occ, charge: { venueId: null, organizationId: 'org-1', invoiceMode: 'AUTOMATIC' } }
        })

      await expect(payOccurrence('occ-1', { invoice: false, expectedTotalCents: 107900 }, 'staff-1', AHORA)).rejects.toMatchObject({
        code: 'PLATFORM_CHARGE_OCCURRENCE_TOTAL_CHANGED',
      })
      sinEscrituras()
    })

    it('repetir sobre una ya PAGADA sigue siendo éxito aunque el total confirmado no coincida (la comparación va después de «pagada»)', async () => {
      Object.assign(mundo.occ, PAGADA())

      const r = await payOccurrence('occ-1', { invoice: true, expectedTotalCents: 1 }, 'staff-2', AHORA)

      expect(r.occurrence).toMatchObject({ status: 'PAID' })
      expect(r.invoice).toBeNull()
      expect(mockInvoice).not.toHaveBeenCalled()
      sinEscrituras()
    })

    it('una OMITIDA conserva su 409 «deshazlo primero» (la comparación va después de «omitida»)', async () => {
      Object.assign(mundo.occ, OMITIDA())

      await expect(payOccurrence('occ-1', { invoice: false, expectedTotalCents: 1 }, 'staff-1', AHORA)).rejects.toMatchObject({
        code: 'PLATFORM_CHARGE_OCCURRENCE_SKIPPED',
      })
      sinEscrituras()
    })
  })

  it('el estado que se decide es el RELEÍDO bajo el candado: si otra pestaña la pagó mientras tanto, esta ve «ya pagada» y no factura', async () => {
    // Lectura previa (sin candado): PENDING. Bajo el candado, otra pestaña ya la había pagado.
    prismaMock.platformChargeOccurrence.findUnique
      .mockImplementationOnce(async () => ({ chargeId: 'cobro-1' }))
      .mockImplementationOnce(async () => {
        Object.assign(mundo.occ, PAGADA({ paidById: 'staff-otra' }))
        return { ...mundo.occ, charge: { venueId: null, organizationId: 'org-1' } }
      })

    const r = await payOccurrence('occ-1', { invoice: true }, 'staff-1', AHORA)

    expect(r.occurrence).toMatchObject({ status: 'PAID' })
    expect(mundo.occ.paidById).toBe('staff-otra') // no se le escribió encima
    expect(r.invoice).toBeNull()
    expect(mockInvoice).not.toHaveBeenCalled()
    sinEscrituras()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/occurrences — skipOccurrence', () => {
  it('PENDING → SKIPPED bajo el candado, con el momento y quien la omitió; la bitácora va después', async () => {
    const eventos = trazar()

    const view = await skipOccurrence('occ-1', 'staff-1', AHORA)

    expect(eventos).toEqual(['tx:inicio', 'candado', 'actualizar', 'tx:fin', 'bitácora'])
    expect(prismaMock.platformChargeOccurrence.update).toHaveBeenCalledWith({
      where: { id: 'occ-1' },
      data: { status: 'SKIPPED', skippedAt: AHORA, skippedById: 'staff-1' },
    })
    expect(view).toMatchObject({ id: 'occ-1', status: 'SKIPPED', skippedAt: AHORA, bucket: null })
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-1',
      venueId: null,
      organizationId: 'org-1',
      action: 'PLATFORM_CHARGE_SKIPPED',
      entity: 'PlatformCharge',
      entityId: 'cobro-1',
      data: { occurrenceId: 'occ-1', dueDate: '2026-11-01', totalCents: 107900 },
    })
  })

  it('una PAGADA no se omite: 409 y no se toca', async () => {
    Object.assign(mundo.occ, PAGADA())

    const error = await skipOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/pagado/i)
    sinEscrituras()
  })

  it('repetir sobre una ya OMITIDA contesta éxito sin escribir ni repetir la bitácora', async () => {
    Object.assign(mundo.occ, OMITIDA())

    const view = await skipOccurrence('occ-1', 'staff-2', AHORA)

    expect(view.status).toBe('SKIPPED')
    expect(mundo.occ.skippedById).toBe('staff-0')
    sinEscrituras()
  })

  it('una ocurrencia que no existe es 404', async () => {
    await expect(skipOccurrence('no-existe', 'staff-1', AHORA)).rejects.toBeInstanceOf(NotFoundError)
    sinEscrituras()
  })

  it('decide con lo RELEÍDO bajo el candado: si otra pestaña la pagó mientras tanto, es 409 y no se escribe nada', async () => {
    prismaMock.platformChargeOccurrence.findUnique
      .mockImplementationOnce(async () => ({ chargeId: 'cobro-1' }))
      .mockImplementationOnce(async () => {
        Object.assign(mundo.occ, PAGADA())
        return { ...mundo.occ, charge: { venueId: null, organizationId: 'org-1' } }
      })

    await expect(skipOccurrence('occ-1', 'staff-1', AHORA)).rejects.toBeInstanceOf(ConflictError)

    sinEscrituras()
  })

  describe('🔴 con una factura ANEXADA viva: omitirla escondería de la lista una factura real que alguien debe', () => {
    const anexada = (over: Fila = {}) =>
      factura({ id: 'cfdi-19', folio: '19', idempotencyKey: 'hecha-a-mano-19', chargeLinkedAt: hace(5), ...over })

    it.each(['STAMPED', 'CANCEL_REQUESTED', 'STAMPING'])(
      '%s: 409 «Esta fecha tiene anexada la factura A-19; quítala antes de omitirla» y no se escribe nada',
      async status => {
        mundo.cfdis = [anexada({ status, serie: 'A' })]
        const eventos = trazar()

        const error = await skipOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(ConflictError)
        expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_INVOICE_LINKED')
        expect((error as ConflictError).message).toBe('Esta fecha tiene anexada la factura A-19; quítala antes de omitirla')
        expect(eventos).toContain('candado') // se decide bajo el candado, con lo releído
        expect(mundo.occ.status).toBe('PENDING')
        sinEscrituras()
      },
    )

    it('la que se anexó entre la lectura y el candado también la frena: se busca DENTRO del candado', async () => {
      prismaMock.platformChargeOccurrence.findUnique
        .mockImplementationOnce(async () => ({ chargeId: 'cobro-1' }))
        .mockImplementationOnce(async () => {
          mundo.cfdis = [anexada()]
          return { ...mundo.occ, charge: { venueId: null, organizationId: 'org-1' } }
        })

      await expect(skipOccurrence('occ-1', 'staff-1', AHORA)).rejects.toThrow('quítala antes de omitirla')
      sinEscrituras()
    })

    it('una anexada sin serie ni folio dice «la factura», sin inventar el nombre', async () => {
      mundo.cfdis = [anexada({ serie: null, folio: null })]

      await expect(skipOccurrence('occ-1', 'staff-1', AHORA)).rejects.toThrow(
        'Esta fecha tiene anexada la factura; quítala antes de omitirla',
      )
    })

    it('una anexada ya CANCELADA no frena: se omite', async () => {
      mundo.cfdis = [anexada({ status: 'CANCELLED' })]

      const view = await skipOccurrence('occ-1', 'staff-1', AHORA)

      expect(view.status).toBe('SKIPPED')
      expect(mundo.occ).toMatchObject({ status: 'SKIPPED', skippedById: 'staff-1' })
    })

    it('una timbrada desde «Por cobrar» (sin marca de anexada) se comporta como hoy: se omite', async () => {
      mundo.cfdis = [factura()]

      const view = await skipOccurrence('occ-1', 'staff-1', AHORA)

      expect(view.status).toBe('SKIPPED')
    })

    it('una PAGADA con anexada conserva su 409 de «deshazlo antes de omitirlo»', async () => {
      Object.assign(mundo.occ, PAGADA())
      mundo.cfdis = [anexada()]

      const error = await skipOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

      expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_OCCURRENCE_PAID')
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/occurrences — reopenOccurrence («Deshacer»)', () => {
  it('llama a resolverIntento con la ocurrencia Y quien lo pidió (para atribuir la bitácora si adopta una factura)', async () => {
    Object.assign(mundo.occ, PAGADA())

    await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(mockResolver).toHaveBeenCalledWith('occ-1', 'staff-1')
  })

  it('sin intento de factura (NONE): PAID → PENDING y limpia paidAt, paidById, skippedAt y skippedById', async () => {
    Object.assign(mundo.occ, PAGADA(), { skippedAt: hace(5), skippedById: 'staff-9' })
    const eventos = trazar()

    const view = await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(eventos).toEqual(['resolver intento', 'tx:inicio', 'candado', 'buscar factura', 'actualizar', 'tx:fin', 'bitácora'])
    expect(prismaMock.platformChargeOccurrence.update).toHaveBeenCalledWith({
      where: { id: 'occ-1' },
      data: { status: 'PENDING', paidAt: null, paidById: null, skippedAt: null, skippedById: null, invoiceMode: 'AUTOMATIC' },
    })
    expect(mundo.occ).toMatchObject({ status: 'PENDING', paidAt: null, paidById: null, skippedAt: null, skippedById: null })
    expect(view).toMatchObject({ id: 'occ-1', status: 'PENDING', paidAt: null, skippedAt: null, bucket: 'OVERDUE' })
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-1',
      venueId: null,
      organizationId: 'org-1',
      action: 'PLATFORM_CHARGE_REOPENED',
      entity: 'PlatformCharge',
      entityId: 'cobro-1',
      data: { occurrenceId: 'occ-1', dueDate: '2026-11-01', previousStatus: 'PAID' },
    })
  })

  it('«Ya me pagó» sin la casilla la volvió manual: «Deshacer» la regresa al modo del cobro', async () => {
    Object.assign(mundo.occ, PAGADA(), { invoiceMode: 'MANUAL' })

    const view = await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(view.invoiceMode).toBe('AUTOMATIC')
  })

  it('en un cobro manual, «Deshacer» la deja manual', async () => {
    Object.assign(mundo.occ, PAGADA(), { invoiceMode: 'MANUAL' })
    mundo.charge.invoiceMode = 'MANUAL'

    const view = await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(view.invoiceMode).toBe('MANUAL')
  })

  it('una OMITIDA también regresa a PENDING', async () => {
    Object.assign(mundo.occ, OMITIDA())

    const view = await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(view.status).toBe('PENDING')
    expect(mundo.occ).toMatchObject({ status: 'PENDING', skippedAt: null, skippedById: null })
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PLATFORM_CHARGE_REOPENED', data: expect.objectContaining({ previousStatus: 'SKIPPED' }) }),
    )
  })

  it('con factura VIVA: 409 «Cancela primero la factura A-118 en Facturas CFDI» y no se toca nada', async () => {
    Object.assign(mundo.occ, PAGADA())
    mockResolver.mockResolvedValue({ kind: 'LIVE', cfdi: factura({ status: 'STAMPED', serie: 'A', folio: '118' }) })

    const error = await reopenOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).statusCode).toBe(409)
    expect((error as ConflictError).message).toBe('Cancela primero la factura A-118 en Facturas CFDI')
    expect(mundo.occ.status).toBe('PAID')
    sinEscrituras()
  })

  it('una factura viva sin serie ni folio dice «la factura», sin inventar el nombre', async () => {
    Object.assign(mundo.occ, PAGADA())
    mockResolver.mockResolvedValue({ kind: 'LIVE', cfdi: factura({ status: 'STAMPED', serie: null, folio: null }) })

    await expect(reopenOccurrence('occ-1', 'staff-1', AHORA)).rejects.toThrow('Cancela primero la factura en Facturas CFDI')
  })

  it('con la cancelación ya pedida (CANCEL_REQUESTED) no manda a cancelar otra vez: dice que sigue en trámite', async () => {
    Object.assign(mundo.occ, PAGADA())
    mockResolver.mockResolvedValue({ kind: 'LIVE', cfdi: factura({ status: 'CANCEL_REQUESTED' }) })

    const error = await reopenOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/trámite/)
    expect((error as ConflictError).message).toContain('A-118')
    sinEscrituras()
  })

  it('si resolverIntento no puede decidir (el PAC no contesta, se está timbrando…): su 409 sale tal cual y no se toca nada', async () => {
    Object.assign(mundo.occ, PAGADA())
    mockResolver.mockRejectedValue(
      new ConflictError('La factura se está timbrando; espera un par de minutos y consulta de nuevo', 'PLATFORM_CHARGE_INVOICE_STAMPING'),
    )

    const error = await reopenOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/se está timbrando/)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    sinEscrituras()
  })

  it('una fila con la llave ACTUAL que aparece bajo el candado (otra pestaña reservó la factura): 409 y no se deshace', async () => {
    Object.assign(mundo.occ, PAGADA())
    // resolverIntento no vio nada; entre eso y el candado, «Facturar» reservó la llave :0.
    mundo.cfdis = [factura({ status: 'STAMPING', uuid: null, folio: null })]

    const error = await reopenOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).statusCode).toBe(409)
    expect((error as ConflictError).message).toMatch(/intento de factura/)
    expect(mundo.occ.status).toBe('PAID')
    sinEscrituras()
  })

  it('una factura ya timbrada que aparece bajo el candado dice «Cancela primero la factura A-118…»', async () => {
    Object.assign(mundo.occ, PAGADA())
    mundo.cfdis = [factura({ status: 'STAMPED' })]

    await expect(reopenOccurrence('occ-1', 'staff-1', AHORA)).rejects.toThrow('Cancela primero la factura A-118 en Facturas CFDI')
    sinEscrituras()
  })

  it('la llave que se busca bajo el candado sale del invoiceSeq RELEÍDO: si resolverIntento cerró un intento (subió el seq), busca la nueva', async () => {
    Object.assign(mundo.occ, PAGADA())
    // La fila vieja (:0) ya no cuenta; la llave actual es :1 y está libre.
    mundo.cfdis = [factura({ idempotencyKey: 'por-cobrar:occ-1:0', status: 'CANCELLED' })]
    mockResolver.mockImplementation(async () => {
      mundo.occ.invoiceSeq = 1 // closeAttempt subió invoiceSeq
      return { kind: 'NONE' }
    })

    const view = await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(prismaMock.platformCfdi.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { idempotencyKey: 'por-cobrar:occ-1:1' } }),
    )
    expect(view.status).toBe('PENDING')
  })

  describe('🔴 con una factura ANEXADA (Codex r1, hallazgo 1)', () => {
    const anexada = (over: Fila = {}) =>
      factura({ id: 'cfdi-19', folio: '19', idempotencyKey: 'hecha-a-mano-19', chargeLinkedAt: hace(5), ...over })

    it.each(['STAMPED', 'CANCEL_REQUESTED', 'STAMPING'])(
      '%s, dentro del candado: 409 «Quita primero la factura A-19» y no se deshace',
      async status => {
        Object.assign(mundo.occ, PAGADA())
        mundo.cfdis = [anexada({ status })]
        const eventos = trazar()

        const error = await reopenOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(ConflictError)
        expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_INVOICE_LINKED')
        expect((error as ConflictError).message).toBe('Quita primero la factura A-19')
        expect(eventos).toContain('candado')
        expect(mundo.occ.status).toBe('PAID')
        sinEscrituras()
      },
    )

    it('la que se anexa mientras se le pregunta al PAC también la frena: la búsqueda es dentro del candado', async () => {
      Object.assign(mundo.occ, PAGADA())
      mockResolver.mockImplementation(async () => {
        mundo.cfdis = [anexada()]
        return { kind: 'NONE' }
      })

      await expect(reopenOccurrence('occ-1', 'staff-1', AHORA)).rejects.toThrow('Quita primero la factura A-19')
      sinEscrituras()
    })

    it('una omitida con anexada tampoco se deshace', async () => {
      Object.assign(mundo.occ, OMITIDA())
      mundo.cfdis = [anexada()]

      await expect(reopenOccurrence('occ-1', 'staff-1', AHORA)).rejects.toThrow('Quita primero la factura A-19')
      expect(mundo.occ.status).toBe('SKIPPED')
    })

    it('una anexada sin serie ni folio dice «la factura», sin inventar el nombre', async () => {
      Object.assign(mundo.occ, PAGADA())
      mundo.cfdis = [anexada({ serie: null, folio: null })]

      await expect(reopenOccurrence('occ-1', 'staff-1', AHORA)).rejects.toThrow('Quita primero la factura')
    })

    it('con la timbrada desde aquí, el mensaje de hoy: esa no se quita, se cancela', async () => {
      Object.assign(mundo.occ, PAGADA())
      mundo.cfdis = [factura()]

      const error = await reopenOccurrence('occ-1', 'staff-1', AHORA).catch((e: unknown) => e)

      expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_HAS_INVOICE')
      expect((error as ConflictError).message).toBe('Cancela primero la factura A-118 en Facturas CFDI')
    })

    it('una anexada cancelada ya no frena: se deshace y la fecha regresa al modo del cobro', async () => {
      Object.assign(mundo.occ, PAGADA({ invoiceMode: 'MANUAL' }))
      mundo.cfdis = [anexada({ status: 'CANCELLED' })]

      await reopenOccurrence('occ-1', 'staff-1', AHORA)

      expect(mundo.occ).toMatchObject({ status: 'PENDING', paidAt: null, invoiceMode: 'AUTOMATIC' })
    })

    it.each(['AUTOMATIC', 'NONE', 'MANUAL'])(
      'tras quitarla, «Deshacer» restaura el modo del cobro (%s): anexar la había dejado en MANUAL sólo mientras estuvo anexada',
      async modo => {
        Object.assign(mundo.occ, PAGADA({ invoiceMode: 'MANUAL' }))
        mundo.charge.invoiceMode = modo
        mundo.cfdis = [] // ya se quitó: la factura no tiene vínculo con la fecha

        await reopenOccurrence('occ-1', 'staff-1', AHORA)

        expect(mundo.occ).toMatchObject({ status: 'PENDING', invoiceMode: modo })
      },
    )
  })

  it('repetir sobre una ya PENDIENTE contesta éxito sin consultar al PAC ni escribir', async () => {
    const view = await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(view.status).toBe('PENDING')
    expect(mockResolver).not.toHaveBeenCalled()
    sinEscrituras()
  })

  it('si otra pestaña la deshizo mientras se consultaba al PAC, bajo el candado se ve PENDING y no se escribe ni se repite la bitácora', async () => {
    Object.assign(mundo.occ, PAGADA())
    prismaMock.platformChargeOccurrence.findUnique
      .mockImplementationOnce(async () => ({ chargeId: 'cobro-1', status: 'PAID' }))
      .mockImplementationOnce(async () => {
        Object.assign(mundo.occ, { status: 'PENDING', paidAt: null, paidById: null }) // la otra pestaña la deshizo
        return { ...mundo.occ, charge: { venueId: null, organizationId: 'org-1' } }
      })

    const view = await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(view.status).toBe('PENDING')
    sinEscrituras()
  })

  it('una ocurrencia que no existe es 404', async () => {
    await expect(reopenOccurrence('no-existe', 'staff-1', AHORA)).rejects.toBeInstanceOf(NotFoundError)
    expect(mockResolver).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/occurrences — payPreview', () => {
  it('AUTOMÁTICA con receptor y sin PPD pendientes: timbraría, a quién, y los conceptos con su total', async () => {
    const preview = await payPreview('occ-1')

    expect(preview).toEqual({
      customerName: 'Estética Luna',
      customerType: 'ORGANIZATION',
      organizationId: 'org-1',
      venueId: null,
      billingTaxProfileId: 'perfil-1',
      concepts: CONCEPTOS,
      ...TOTALES,
      willInvoice: true,
      receptor: { rfc: 'LUN010101AAA', razonSocial: 'ESTETICA LUNA SA DE CV', regimenFiscal: '601', codigoPostal: '06000' },
      pendingPpdCount: 0,
      linkedInvoice: null,
    })
  })

  it('pendingPpdCount cuenta las PPD vigentes (timbradas o con la cancelación en trámite) del perfil con amountPaidCents < totalCents (en la base, no en memoria)', async () => {
    mundo.ppd = 2

    const preview = await payPreview('occ-1')

    expect(preview.pendingPpdCount).toBe(2)
    expect(prismaMock.platformCfdi.count).toHaveBeenCalledWith({
      where: {
        billingTaxProfileId: 'perfil-1',
        type: 'INGRESO',
        metodoPago: 'PPD',
        status: { in: ['STAMPED', 'CANCEL_REQUESTED'] },
        amountPaidCents: { lt: prismaMock.platformCfdi.fields.totalCents },
      },
    })
  })

  it('con PPD sin liquidar NO timbra aunque sea AUTOMÁTICA (la casilla se desmarca y el diálogo avisa)', async () => {
    mundo.ppd = 1

    const preview = await payPreview('occ-1')

    expect(mundo.occ.invoiceMode).toBe('AUTOMATIC')
    expect(preview).toMatchObject({ willInvoice: false, pendingPpdCount: 1, receptor: { rfc: 'LUN010101AAA' } })
  })

  describe('🔴 con una factura anexada', () => {
    const anexada = (over: Fila = {}) =>
      factura({ id: 'cfdi-19', folio: '19', idempotencyKey: 'hecha-a-mano-19', chargeLinkedAt: hace(5), metodoPago: 'PPD', ...over })

    it('trae linkedInvoice y willInvoice es false, aunque la fecha siga AUTOMÁTICA y haya receptor', async () => {
      const a = anexada()
      mundo.cfdis = [a]

      const r = await payPreview('occ-1')

      expect(r.willInvoice).toBe(false)
      expect(r.linkedInvoice).toEqual({
        id: 'cfdi-19',
        status: 'STAMPED',
        serie: 'A',
        folio: '19',
        uuid: 'UUID-1',
        totalCents: 107900,
        metodoPago: 'PPD',
        linked: true,
        lastError: null,
        emailSentAt: a.emailSentAt,
        createdAt: a.createdAt,
      })
    })

    it('sin anexada, linkedInvoice es null y lo demás no cambia', async () => {
      const r = await payPreview('occ-1')

      expect(r.linkedInvoice).toBeNull()
      expect(r.willInvoice).toBe(true)
    })

    it('la anexada cancelada ya no cuenta: vuelve a poder timbrar', async () => {
      mundo.cfdis = [anexada({ status: 'CANCELLED' })]

      const r = await payPreview('occ-1')

      expect(r.linkedInvoice).toBeNull()
      expect(r.willInvoice).toBe(true)
    })

    it('una timbrada desde aquí no es anexada: linkedInvoice sigue en null', async () => {
      mundo.cfdis = [factura()]

      expect((await payPreview('occ-1')).linkedInvoice).toBeNull()
    })
  })

  it('una MANUAL no timbra por default, con o sin PPD', async () => {
    Object.assign(mundo.occ, { invoiceMode: 'MANUAL' })

    expect(await payPreview('occ-1')).toMatchObject({ willInvoice: false, pendingPpdCount: 0 })
  })

  it('un cobro SIN FACTURA (NONE) nunca timbra: willInvoice es false aunque tenga perfil y ningún PPD pendiente', async () => {
    Object.assign(mundo.occ, { invoiceMode: 'NONE', concepts: SIN_CLAVES, subtotalCents: 862069, taxCents: 137931, totalCents: 1000000 })

    const preview = await payPreview('occ-1')

    expect(preview).toMatchObject({
      willInvoice: false,
      pendingPpdCount: 0,
      concepts: SIN_CLAVES,
      totalCents: 1000000,
      receptor: { rfc: 'LUN010101AAA' }, // el perfil sigue ahí: la fila pagada aún puede facturarse con «Facturar»
    })
  })

  it('sin perfil fiscal (nada con qué facturar): receptor null, no timbra y ni siquiera cuenta PPD', async () => {
    mockFindProfileId.mockResolvedValue(null)

    const preview = await payPreview('occ-1')

    expect(preview).toMatchObject({ receptor: null, billingTaxProfileId: null, willInvoice: false, pendingPpdCount: 0 })
    expect(prismaMock.platformCfdi.count).not.toHaveBeenCalled()
  })

  it('el perfil se busca como lo hace facturar (el del cobro, o el del cliente para una organización o un negocio)', async () => {
    await payPreview('occ-1')

    expect(mockFindProfileId).toHaveBeenCalledWith(expect.objectContaining({ id: 'cobro-1', billingTaxProfileId: 'perfil-1' }))
  })

  it('el desglose es el de la FOTO de la ocurrencia, no el del cobro de hoy', async () => {
    mundo.charge.concepts = [{ ...CONCEPTOS[0], amountCents: 99900 }]

    const preview = await payPreview('occ-1')

    expect(preview.concepts).toEqual(CONCEPTOS)
    expect(preview.totalCents).toBe(107900)
  })

  it('una ocurrencia que no existe es 404', async () => {
    await expect(payPreview('no-existe')).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/occurrences — summarizeOccurrences', () => {
  /** Responde cada `aggregate` según lo que filtra, y apunta qué contestó a quién. */
  function instalarAgregados() {
    prismaMock.platformChargeOccurrence.aggregate.mockImplementation(async ({ where }: any) => {
      const [conteo, total] =
        where.status === 'PAID' ? [4, 40000] : where.dueDate instanceof Date ? [2, 20000] : where.dueDate.lt ? [3, 30000] : [5, 50000]
      return { _count: { _all: conteo }, _sum: { totalCents: total } }
    })
  }

  it('vencido, hoy, próximos 7 días y pagado este mes: cada uno con su conteo y su total, sumados en la base', async () => {
    instalarAgregados()

    const resumen = await summarizeOccurrences(AHORA)

    expect(resumen).toEqual({
      today: '2026-11-02',
      overdue: { count: 3, totalCents: 30000 },
      dueToday: { count: 2, totalCents: 20000 },
      upcoming: { count: 5, totalCents: 50000 },
      paidThisMonth: { count: 4, totalCents: 40000 },
    })
    expect(prismaMock.platformChargeOccurrence.findMany).not.toHaveBeenCalled() // jamás hidrata filas para sumar
    for (const llamada of prismaMock.platformChargeOccurrence.aggregate.mock.calls) {
      expect(llamada[0]).toMatchObject({ _count: { _all: true }, _sum: { totalCents: true } })
    }
  })

  it('el corte es el día de CDMX: vencido < hoy, hoy = hoy, próximos = (hoy, hoy+7], todo PENDING', async () => {
    instalarAgregados()

    await summarizeOccurrences(AHORA)

    const filtros = prismaMock.platformChargeOccurrence.aggregate.mock.calls.map(([args]: any) => args.where)
    expect(filtros).toContainEqual({ status: 'PENDING', dueDate: { lt: calendarDayToDb('2026-11-02') } })
    expect(filtros).toContainEqual({ status: 'PENDING', dueDate: calendarDayToDb('2026-11-02') })
    expect(filtros).toContainEqual({
      status: 'PENDING',
      dueDate: { gt: calendarDayToDb('2026-11-02'), lte: calendarDayToDb('2026-11-09') },
    })
  })

  it('a las 23:30 de CDMX (ya es 3-nov en UTC) «hoy» sigue siendo el 2-nov: el corte no se corre un día', async () => {
    instalarAgregados()

    const resumen = await summarizeOccurrences(AHORA_TARDE)

    expect(resumen.today).toBe('2026-11-02')
    const filtros = prismaMock.platformChargeOccurrence.aggregate.mock.calls.map(([args]: any) => args.where)
    expect(filtros).toContainEqual({ status: 'PENDING', dueDate: { lt: calendarDayToDb('2026-11-02') } })
    expect(filtros).toContainEqual({ status: 'PENDING', dueDate: calendarDayToDb('2026-11-02') })
    expect(filtros).toContainEqual({
      status: 'PENDING',
      dueDate: { gt: calendarDayToDb('2026-11-02'), lte: calendarDayToDb('2026-11-09') },
    })
  })

  it('«pagado este mes» es por paidAt dentro del mes de CDMX (medianoche de CDMX a medianoche de CDMX), no por la fecha de cobro', async () => {
    instalarAgregados()

    await summarizeOccurrences(AHORA)

    const filtros = prismaMock.platformChargeOccurrence.aggregate.mock.calls.map(([args]: any) => args.where)
    expect(filtros).toContainEqual({
      status: 'PAID',
      paidAt: { gte: new Date('2026-11-01T06:00:00.000Z'), lt: new Date('2026-12-01T06:00:00.000Z') },
    })
  })

  it('el 30-nov a las 23:30 de CDMX (ya es 1-dic en UTC) el mes sigue siendo noviembre', async () => {
    instalarAgregados()

    const resumen = await summarizeOccurrences(new Date('2026-12-01T05:30:00.000Z'))

    expect(resumen.today).toBe('2026-11-30')
    const filtros = prismaMock.platformChargeOccurrence.aggregate.mock.calls.map(([args]: any) => args.where)
    expect(filtros).toContainEqual({
      status: 'PAID',
      paidAt: { gte: new Date('2026-11-01T06:00:00.000Z'), lt: new Date('2026-12-01T06:00:00.000Z') },
    })
  })

  it('sin filas la suma es null y se reporta 0 (nunca null ni NaN)', async () => {
    prismaMock.platformChargeOccurrence.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { totalCents: null } })

    const resumen = await summarizeOccurrences(AHORA)

    expect(resumen).toEqual({
      today: '2026-11-02',
      overdue: { count: 0, totalCents: 0 },
      dueToday: { count: 0, totalCents: 0 },
      upcoming: { count: 0, totalCents: 0 },
      paidThisMonth: { count: 0, totalCents: 0 },
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/occurrences — listOccurrences', () => {
  /** Una fila como la entrega Prisma con el include de la lista. */
  function fila(dueDate: string, over: Fila = {}): Fila {
    return {
      ...ocurrencia({ id: `occ-${dueDate}`, dueDate: calendarDayToDb(dueDate) }),
      charge: { customerName: 'Estética Luna', frequency: 'MONTHLY' },
      invoices: [],
      ...over,
    }
  }
  const findMany = () => prismaMock.platformChargeOccurrence.findMany
  const llamada = () => findMany().mock.calls[0][0]

  beforeEach(() => {
    findMany().mockResolvedValue([])
    prismaMock.platformChargeOccurrence.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { totalCents: null } })
  })

  it('«open»: sólo las PENDING, de la más próxima a la más lejana con el id de desempate, y cada fila con su bucket del día de CDMX', async () => {
    findMany().mockResolvedValue([fila('2026-10-30'), fila('2026-11-02'), fila('2026-11-05')])
    prismaMock.platformChargeOccurrence.aggregate.mockResolvedValue({ _count: { _all: 3 }, _sum: { totalCents: null } })

    const r = await listOccurrences({ view: 'open' }, AHORA)

    expect(llamada()).toMatchObject({ where: { status: 'PENDING' }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], skip: 0, take: 50 })
    expect(r.rows.map(row => [row.dueDate, row.bucket])).toEqual([
      ['2026-10-30', 'OVERDUE'],
      ['2026-11-02', 'TODAY'],
      ['2026-11-05', 'UPCOMING'],
    ])
    expect(r).toMatchObject({ total: 3, page: 1, pageSize: 50 })
  })

  it('a las 23:30 de CDMX lo de hoy sigue siendo TODAY (no vencido)', async () => {
    findMany().mockResolvedValue([fila('2026-11-02')])

    const r = await listOccurrences({ view: 'open' }, AHORA_TARDE)

    expect(r.rows[0].bucket).toBe('TODAY')
  })

  it('«paid»: las PAID, de la más recién pagada a la más vieja con el id de desempate, y sin bucket', async () => {
    findMany().mockResolvedValue([fila('2026-10-30', PAGADA())])

    const r = await listOccurrences({ view: 'paid' }, AHORA)

    expect(llamada()).toMatchObject({ where: { status: 'PAID' }, orderBy: [{ paidAt: 'desc' }, { id: 'desc' }] })
    expect(r.rows[0]).toMatchObject({ status: 'PAID', bucket: null })
  })

  it('«skipped»: las SKIPPED por fecha de cobro con el id de desempate, y sin bucket', async () => {
    findMany().mockResolvedValue([fila('2026-10-30', OMITIDA())])

    const r = await listOccurrences({ view: 'skipped' }, AHORA)

    expect(llamada()).toMatchObject({ where: { status: 'SKIPPED' }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] })
    expect(r.rows[0]).toMatchObject({ status: 'SKIPPED', bucket: null })
  })

  it('sin vista pide las pendientes', async () => {
    await listOccurrences({}, AHORA)

    expect(llamada().where).toEqual({ status: 'PENDING' })
  })

  it('una vista que no existe es 400, no «todo»', async () => {
    await expect(listOccurrences({ view: 'todo' as never }, AHORA)).rejects.toBeInstanceOf(BadRequestError)
    expect(findMany()).not.toHaveBeenCalled()
  })

  it('el tope de página lo impone el servidor: pageSize 500 se recorta a 100, y devuelve el que usó', async () => {
    const r = await listOccurrences({ view: 'open', pageSize: 500 }, AHORA)

    expect(llamada()).toMatchObject({ take: 100, skip: 0 })
    expect(r.pageSize).toBe(100)
  })

  it.each([
    [undefined, 50],
    [0, 1],
    [-5, 1],
    [Number.NaN, 50],
    [20, 20],
  ])('pageSize %s → %s', async (pedido, usado) => {
    const r = await listOccurrences({ view: 'open', pageSize: pedido as number | undefined }, AHORA)

    expect(llamada().take).toBe(usado)
    expect(r.pageSize).toBe(usado)
  })

  it('página 3 de 20: salta 40 y la página nunca baja de 1', async () => {
    await listOccurrences({ view: 'open', page: 3, pageSize: 20 }, AHORA)
    expect(llamada()).toMatchObject({ skip: 40, take: 20 })

    findMany().mockClear()
    const r = await listOccurrences({ view: 'open', page: 0 }, AHORA)
    expect(llamada().skip).toBe(0)
    expect(r.page).toBe(1)
  })

  it('el total sale de un aggregate con EL MISMO filtro (el de la búsqueda también), no del largo de la página', async () => {
    findMany().mockResolvedValue([fila('2026-11-05')])
    prismaMock.platformChargeOccurrence.aggregate.mockResolvedValue({ _count: { _all: 137 }, _sum: { totalCents: 1 } })

    const r = await listOccurrences({ view: 'open', q: 'luna', page: 2, pageSize: 1 }, AHORA)

    expect(r.rows).toHaveLength(1)
    expect(r.total).toBe(137)
    expect(prismaMock.platformChargeOccurrence.aggregate).toHaveBeenCalledWith({
      where: llamada().where,
      _count: { _all: true },
      _sum: { totalCents: true },
    })
  })

  it('«q» filtra por el nombre del cliente en la base (sin importar mayúsculas), con el texto recortado', async () => {
    await listOccurrences({ view: 'open', q: '  luna  ' }, AHORA)

    expect(llamada().where).toEqual({
      status: 'PENDING',
      charge: { customerName: { contains: 'luna', mode: 'insensitive' } },
    })
  })

  it('una búsqueda vacía o de puros espacios no filtra', async () => {
    await listOccurrences({ view: 'open', q: '   ' }, AHORA)

    expect(llamada().where).toEqual({ status: 'PENDING' })
  })

  it('la factura de cada fila es la MÁS RECIENTE: se pide una sola por ocurrencia, de la más nueva a la más vieja', async () => {
    await listOccurrences({ view: 'open' }, AHORA)

    expect(llamada().include.invoices).toMatchObject({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 })
  })

  it('cada fila trae la foto de la ocurrencia, el cliente, la periodicidad y la factura (con su error y si el cliente la recibió)', async () => {
    const f = factura({ status: 'STAMPING', uuid: null, folio: null, serie: 'A', lastError: 'ETIMEDOUT', emailSentAt: null })
    findMany().mockResolvedValue([fila('2026-10-30', { invoices: [f] })])

    const { rows } = await listOccurrences({ view: 'open' }, AHORA)

    expect(rows[0]).toEqual({
      id: 'occ-2026-10-30',
      chargeId: 'cobro-1',
      customerName: 'Estética Luna',
      frequency: 'MONTHLY',
      dueDate: '2026-10-30',
      concepts: CONCEPTOS,
      ...TOTALES,
      invoiceMode: 'AUTOMATIC',
      status: 'PENDING',
      paidAt: null,
      skippedAt: null,
      bucket: 'OVERDUE',
      invoice: {
        id: 'cfdi-1',
        status: 'STAMPING',
        serie: 'A',
        folio: null,
        uuid: null,
        totalCents: 107900,
        metodoPago: 'PUE',
        linked: false,
        lastError: 'ETIMEDOUT',
        emailSentAt: null,
        createdAt: f.createdAt,
      },
    })
  })

  describe('🔴 la factura que enseña la fila: la viva y, si no hay, la más nueva (Review Focus 3, Codex r1 hallazgo 6)', () => {
    const OCC = 'occ-2026-10-30'
    const viejaViva = (over: Fila = {}) =>
      factura({
        id: 'viva',
        platformChargeOccurrenceId: OCC,
        idempotencyKey: 'hecha-a-mano',
        chargeLinkedAt: hace(10),
        serie: 'A',
        folio: '19',
        createdAt: hace(60 * 24 * 30),
        ...over,
      })
    const cancelada = (i: number) =>
      factura({
        id: `cancelada-${i}`,
        platformChargeOccurrenceId: OCC,
        idempotencyKey: `por-cobrar:${OCC}:${i}`,
        status: 'CANCELLED',
        createdAt: hace(i + 1),
      })
    /** Como en la base: la relación `invoices` de la lista sólo trae la más nueva (`take: 1`). */
    const filaConLaMasNueva = (id: string, cfdis: Fila[]) => {
      const [masNueva] = cfdis
        .filter(c => c.platformChargeOccurrenceId === id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return fila(id.replace('occ-', ''), { id, invoices: masNueva ? [masNueva] : [] })
    }

    it.each([
      ['anexada STAMPED', { status: 'STAMPED' }],
      ['anexada con la cancelación en trámite', { status: 'CANCEL_REQUESTED' }],
      ['timbrándose', { status: 'STAMPING', chargeLinkedAt: null }],
    ])('la viva (%s) aunque haya once canceladas más nuevas', async (_caso, over) => {
      mundo.cfdis = [viejaViva(over), ...Array.from({ length: 11 }, (_, i) => cancelada(i))]
      findMany().mockResolvedValue([filaConLaMasNueva(OCC, mundo.cfdis)])

      const { rows } = await listOccurrences({ view: 'open' }, AHORA)

      expect(rows[0].invoice).toMatchObject({ id: 'viva', status: over.status })
    })

    it('la anexada sale marcada, con su método de pago; una timbrada desde aquí, sin marca', async () => {
      mundo.cfdis = [viejaViva({ metodoPago: 'PPD' }), cancelada(0)]
      findMany().mockResolvedValue([filaConLaMasNueva(OCC, mundo.cfdis)])

      const anexada = await listOccurrences({ view: 'open' }, AHORA)
      expect(anexada.rows[0].invoice).toMatchObject({ id: 'viva', linked: true, metodoPago: 'PPD' })

      mundo.cfdis = [viejaViva({ chargeLinkedAt: null })]
      findMany().mockResolvedValue([filaConLaMasNueva(OCC, mundo.cfdis)])

      const timbrada = await listOccurrences({ view: 'open' }, AHORA)
      expect(timbrada.rows[0].invoice).toMatchObject({ id: 'viva', linked: false })
    })

    it('sin viva, la más nueva', async () => {
      mundo.cfdis = [cancelada(5), cancelada(0), cancelada(3)]
      findMany().mockResolvedValue([filaConLaMasNueva(OCC, mundo.cfdis)])

      const { rows } = await listOccurrences({ view: 'open' }, AHORA)

      expect(rows[0].invoice).toMatchObject({ id: 'cancelada-0', status: 'CANCELLED' })
    })

    it('una fecha con varias vivas no debería existir; si existe, gana la más nueva', async () => {
      mundo.cfdis = [viejaViva(), viejaViva({ id: 'viva-nueva', createdAt: hace(5) }), cancelada(0)]
      findMany().mockResolvedValue([filaConLaMasNueva(OCC, mundo.cfdis)])

      const { rows } = await listOccurrences({ view: 'open' }, AHORA)

      expect(rows[0].invoice?.id).toBe('viva-nueva')
    })

    it('las vivas de la página salen de UNA sola consulta aparte, acotada a sus filas, no una por fila', async () => {
      const fechas = ['occ-2026-10-28', 'occ-2026-10-29', 'occ-2026-10-30']
      mundo.cfdis = fechas.map((id, i) => viejaViva({ id: `viva-${i}`, platformChargeOccurrenceId: id }))
      findMany().mockResolvedValue(fechas.map(id => fila(id.replace('occ-', ''), { id, invoices: [] })))

      const { rows } = await listOccurrences({ view: 'open' }, AHORA)

      expect(rows.map(r => r.invoice?.id)).toEqual(['viva-0', 'viva-1', 'viva-2'])
      expect(prismaMock.platformCfdi.findMany).toHaveBeenCalledTimes(1)
      const consulta = prismaMock.platformCfdi.findMany.mock.calls[0][0]
      expect(consulta.where).toEqual({
        platformChargeOccurrenceId: { in: fechas },
        status: { in: ['STAMPED', 'CANCEL_REQUESTED', 'STAMPING'] },
      })
      expect(consulta.take).toBe(3)
      expect(consulta.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    })

    it('el `take` de la lista no se agranda: la relación sigue trayendo una sola', async () => {
      await listOccurrences({ view: 'open' }, AHORA)

      expect(llamada().include.invoices.take).toBe(1)
    })

    it('dos vivas en una fecha no le quitan su factura a otra fecha de la página: el tope es por fecha', async () => {
      const [a, b] = ['occ-2026-10-29', 'occ-2026-10-30']
      mundo.cfdis = [
        viejaViva({ id: 'a-nueva', platformChargeOccurrenceId: a, createdAt: hace(1) }),
        viejaViva({ id: 'a-otra', platformChargeOccurrenceId: a, createdAt: hace(2) }),
        viejaViva({ id: 'b-vieja', platformChargeOccurrenceId: b, createdAt: hace(3) }),
      ]
      findMany().mockResolvedValue([a, b].map(id => fila(id.replace('occ-', ''), { id, invoices: [] })))

      const { rows } = await listOccurrences({ view: 'open' }, AHORA)

      expect(rows.map(r => r.invoice?.id)).toEqual(['a-nueva', 'b-vieja'])
    })

    it('sin filas en la página no hace la consulta de las vivas', async () => {
      await listOccurrences({ view: 'open' }, AHORA)

      expect(prismaMock.platformCfdi.findMany).not.toHaveBeenCalled()
    })

    it('la vista de UNA fecha (la que regresan pagar, omitir y deshacer) sigue la misma regla', async () => {
      mundo.occ.id = OCC
      mundo.cfdis = [viejaViva(), ...Array.from({ length: 11 }, (_, i) => cancelada(i))]

      // «Ya me pagó» sin timbrar: omitir y deshacer se niegan con una anexada viva, pero las tres regresan la misma vista de la fecha.
      const { occurrence: vista } = await payOccurrence(OCC, { invoice: false }, 'staff-1', AHORA)

      expect(vista.invoice).toMatchObject({ id: 'viva', linked: true })
    })
  })

  it('sin facturas, invoice es null', async () => {
    findMany().mockResolvedValue([fila('2026-10-30')])

    const { rows } = await listOccurrences({ view: 'open' }, AHORA)

    expect(rows[0].invoice).toBeNull()
  })

  it('dueDate sale como TEXTO YYYY-MM-DD (nunca un instante que se pinte un día antes en CDMX)', async () => {
    findMany().mockResolvedValue([fila('2026-11-01')])

    const { rows } = await listOccurrences({ view: 'open' }, AHORA)

    expect(rows[0].dueDate).toBe('2026-11-01')
    expect(typeof rows[0].dueDate).toBe('string')
  })

  it('no expone nada de más de la factura (sólo lo que la pantalla pinta)', async () => {
    findMany().mockResolvedValue([
      fila('2026-10-30', { invoices: [factura({ lines: [{ x: 1 }], receptorRfc: 'LUN010101AAA', xmlUrl: 'u' })] }),
    ])

    const { rows } = await listOccurrences({ view: 'open' }, AHORA)

    expect(Object.keys(rows[0].invoice!).sort()).toEqual(
      ['createdAt', 'emailSentAt', 'folio', 'id', 'lastError', 'linked', 'metodoPago', 'serie', 'status', 'totalCents', 'uuid'].sort(),
    )
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/occurrences — invoiceOccurrenceView (POST /occurrences/:id/invoice)', () => {
  it('factura con lo que mandó la pantalla y devuelve la ocurrencia ya con su factura', async () => {
    Object.assign(mundo.occ, PAGADA())
    const f = factura({ status: 'STAMPED' })
    mundo.cfdis = [f]
    mockInvoice.mockResolvedValue(f)
    const entrada = {
      billingTaxProfileId: 'perfil-2',
      conceptKeys: [
        { satProductKey: '1', satUnitKey: 'E48' },
        { satProductKey: '2', satUnitKey: 'E48' },
      ],
      actorId: 'staff-1',
    }

    const r = await invoiceOccurrenceView('occ-1', entrada, AHORA)

    expect(mockInvoice).toHaveBeenCalledWith('occ-1', entrada)
    expect(r.cfdi).toMatchObject({ id: 'cfdi-1', status: 'STAMPED' })
    expect(r.occurrence).toMatchObject({
      id: 'occ-1',
      status: 'PAID',
      invoice: { id: 'cfdi-1', status: 'STAMPED', serie: 'A', folio: '118' },
    })
  })

  it('los errores de la factura salen tal cual (el controlador los traduce a 409/422/502)', async () => {
    Object.assign(mundo.occ, PAGADA())
    mockInvoice.mockRejectedValue(new ConflictError('El SAT la sigue procesando; consulta el estado en unos minutos'))

    await expect(invoiceOccurrenceView('occ-1', { actorId: 'staff-1' }, AHORA)).rejects.toBeInstanceOf(ConflictError)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/occurrences — 🔴 filtros: UN armador de where para la lista, la suma y los grupos (NEW)', () => {
  // Qué NO prueba un doble en memoria: que Prisma y Postgres entiendan estos filtros de relación (`some`/`none`) ni que el plan de consulta sea bueno
  // con muchos datos (eso es de la integración contra Postgres y de EXPLAIN). Aquí se prueba la lógica: qué `where` se arma y que las cuatro
  // categorías de factura no se traslapen ni dejen a nadie fuera, evaluando el `where` contra filas en memoria.
  const dia = calendarDayToDb

  describe('cada filtro arma su where', () => {
    it('sin filtros: sólo el estado de la vista (como siempre)', () => {
      expect(occurrenceWhere({})).toEqual({ status: 'PENDING' })
      expect(occurrenceWhere({ view: 'paid' })).toEqual({ status: 'PAID' })
    })

    it('periodicidad y tipo de cliente: varios valores con `in`, sobre el cobro; un arreglo vacío no filtra', () => {
      expect(occurrenceWhere({ frequency: ['WEEKLY', 'MONTHLY'] })).toEqual({
        status: 'PENDING',
        charge: { frequency: { in: ['WEEKLY', 'MONTHLY'] } },
      })
      expect(occurrenceWhere({ customerType: ['VENUE'] })).toEqual({ status: 'PENDING', charge: { customerType: { in: ['VENUE'] } } })
      expect(occurrenceWhere({ frequency: [], customerType: [], invoice: [] })).toEqual({ status: 'PENDING' })
    })

    it('«q» (contiene, sin mayúsculas), periodicidad y tipo de cliente comparten el mismo filtro del cobro', () => {
      expect(occurrenceWhere({ q: ' luna ', frequency: ['ONE_TIME'], customerType: ['ORGANIZATION'] })).toEqual({
        status: 'PENDING',
        charge: {
          customerName: { contains: 'luna', mode: 'insensitive' },
          frequency: { in: ['ONE_TIME'] },
          customerType: { in: ['ORGANIZATION'] },
        },
      })
    })

    it('«customer» es el nombre EXACTO (sin «contiene» ni mayúsculas distintas) y se suma a «q» sin pisarla', () => {
      expect(occurrenceWhere({ customer: 'Café Ana' })).toEqual({ status: 'PENDING', AND: [{ charge: { customerName: 'Café Ana' } }] })
      expect(occurrenceWhere({ q: 'caf', customer: 'Café Ana' })).toEqual({
        status: 'PENDING',
        charge: { customerName: { contains: 'caf', mode: 'insensitive' } },
        AND: [{ charge: { customerName: 'Café Ana' } }],
      })
      expect(occurrenceWhere({ customer: '   ' })).toEqual({ status: 'PENDING' })
    })

    it('fechas: días de calendario sobre la fecha de cobro, los dos extremos incluidos (columna @db.Date, sin zona)', () => {
      expect(occurrenceWhere({ from: '2026-11-01', to: '2026-11-30' })).toEqual({
        status: 'PENDING',
        dueDate: { gte: dia('2026-11-01'), lte: dia('2026-11-30') },
      })
      expect(occurrenceWhere({ from: '2026-11-01' })).toEqual({ status: 'PENDING', dueDate: { gte: dia('2026-11-01') } })
      expect(occurrenceWhere({ to: '2026-11-30' })).toEqual({ status: 'PENDING', dueDate: { lte: dia('2026-11-30') } })
      expect(occurrenceWhere({ from: '2026-11-05', to: '2026-11-05' })).toEqual({
        status: 'PENDING',
        dueDate: { gte: dia('2026-11-05'), lte: dia('2026-11-05') },
      })
    })

    it.each([
      ['«from» después de «to»', { from: '2026-11-10', to: '2026-11-09' }, 'PLATFORM_CHARGE_INVALID_DATE_RANGE'],
      ['un día que no existe', { from: '2026-02-30' }, 'PLATFORM_CHARGE_INVALID_DATE'],
      ['un instante en vez de un día', { to: '2026-11-01T00:00:00Z' }, 'PLATFORM_CHARGE_INVALID_DATE'],
    ])('%s: 400 y sin tocar la base', async (_caso, filtros, codigo) => {
      const error = (await listOccurrences(filtros, AHORA).catch((e: unknown) => e)) as BadRequestError

      expect(error).toBeInstanceOf(BadRequestError)
      expect(error.statusCode).toBe(400)
      expect(error.code).toBe(codigo)
      expect(prismaMock.platformChargeOccurrence.findMany).not.toHaveBeenCalled()
      expect(prismaMock.platformChargeOccurrence.aggregate).not.toHaveBeenCalled()
      expect(() => occurrenceWhere(filtros)).toThrow(BadRequestError)
    })

    it('una vista que no existe es 400 también aquí (los grupos usan el mismo armador)', () => {
      expect(() => occurrenceWhere({ view: 'todo' as never })).toThrow(BadRequestError)
    })

    it('«factura» con varios valores se une con OR de las categorías', () => {
      expect(occurrenceWhere({ invoice: ['STAMPED', 'PROBLEM'] })).toEqual({
        status: 'PENDING',
        AND: [{ OR: [invoiceCategoryWhere('STAMPED'), invoiceCategoryWhere('PROBLEM')] }],
      })
      expect(occurrenceWhere({ invoice: ['NONE'] })).toEqual({ status: 'PENDING', AND: [{ OR: [invoiceCategoryWhere('NONE')] }] })
    })
  })

  describe('🔴 las cuatro categorías de factura no se traslapan y no dejan fuera a nadie', () => {
    type Modo = 'AUTOMATIC' | 'MANUAL' | 'NONE'
    type Fila = { invoiceMode: Modo; invoices: { status: string }[] }

    /** Un intérprete del subconjunto de Prisma que usan estos filtros: AND, OR, `invoiceMode` y `invoices: { some | none: { status: { in } } }`. Lo demás lanza. */
    function cumple(fila: Fila, donde: Record<string, any>): boolean {
      return Object.entries(donde).every(([campo, cond]) => {
        if (campo === 'AND') return (cond as Record<string, any>[]).every(c => cumple(fila, c))
        if (campo === 'OR') return (cond as Record<string, any>[]).some(c => cumple(fila, c))
        if (campo === 'invoiceMode') {
          if (typeof cond === 'string') return fila.invoiceMode === cond
          if (Object.keys(cond).join() === 'not') return fila.invoiceMode !== cond.not
          throw new Error('el intérprete no entiende este filtro de invoiceMode')
        }
        if (campo === 'invoices') {
          const operador = Object.keys(cond).join()
          if (operador !== 'some' && operador !== 'none') throw new Error('el intérprete sólo entiende invoices some y none')
          const alguna = fila.invoices.some(f => (cond[operador].status.in as string[]).includes(f.status))
          return operador === 'some' ? alguna : !alguna
        }
        throw new Error(`el intérprete no entiende el campo ${campo}`)
      })
    }
    const CATEGORIAS = ['STAMPED', 'PROBLEM', 'PENDING', 'NONE'] as const
    const categoriasDe = (fila: Fila) => CATEGORIAS.filter(categoria => cumple(fila, invoiceCategoryWhere(categoria)))

    const modos: Modo[] = ['AUTOMATIC', 'MANUAL', 'NONE']
    const conFactura = (estados: string[]) => modos.map(invoiceMode => [invoiceMode, estados] as const)
    // Cada combinación de modo y estado de factura, con lo que debe salir.
    const TABLA: ReadonlyArray<readonly [Modo, string[], (typeof CATEGORIAS)[number]]> = [
      ['AUTOMATIC', [], 'PENDING'],
      ['MANUAL', [], 'PENDING'],
      ['NONE', [], 'NONE'],
      ...conFactura(['STAMPED']).map(([m, e]) => [m, e, 'STAMPED'] as const),
      ...conFactura(['CANCEL_REQUESTED']).map(([m, e]) => [m, e, 'STAMPED'] as const), // sigue vigente mientras el SAT no la acepte
      ...conFactura(['STAMPING']).map(([m, e]) => [m, e, 'PROBLEM'] as const),
      ...conFactura(['STAMP_FAILED']).map(([m, e]) => [m, e, 'PROBLEM'] as const),
      ['AUTOMATIC', ['CANCELLED'], 'PENDING'], // una cancelada ya no es factura
      ['MANUAL', ['CANCELLED'], 'PENDING'],
      ['NONE', ['CANCELLED'], 'NONE'],
      ['AUTOMATIC', ['DRAFT'], 'PENDING'],
      ['NONE', ['DRAFT'], 'NONE'],
      // Varias facturas en una fecha: gana la de arriba (STAMPED > PROBLEM > NONE > PENDING).
      ['AUTOMATIC', ['STAMP_FAILED', 'STAMPED'], 'STAMPED'],
      ['MANUAL', ['CANCELLED', 'STAMPED'], 'STAMPED'],
      ['AUTOMATIC', ['STAMPING', 'CANCEL_REQUESTED'], 'STAMPED'],
      ['AUTOMATIC', ['CANCELLED', 'STAMP_FAILED'], 'PROBLEM'],
      ['NONE', ['CANCELLED', 'STAMPING'], 'PROBLEM'], // un intento en camino pesa más que el modo «sin factura»
      ['NONE', ['STAMPED'], 'STAMPED'], // se timbró aunque no debía: es una factura
    ]

    it.each(TABLA.map(([modo, estados, esperada]) => [modo, estados.join('+') || 'sin factura', esperada, { modo, estados }] as const))(
      '%s con %s cae sólo en %s',
      (_modo, _estados, esperada, { modo, estados }) => {
        const fila: Fila = { invoiceMode: modo, invoices: estados.map(status => ({ status })) }

        expect(categoriasDe(fila)).toEqual([esperada])
      },
    )

    it('el producto completo de modos × estados (y pares de estados): cada fila cae en EXACTAMENTE una categoría', () => {
      const estados = ['STAMPED', 'CANCEL_REQUESTED', 'STAMPING', 'STAMP_FAILED', 'CANCELLED', 'DRAFT']
      const combinaciones: string[][] = [[], ...estados.map(e => [e]), ...estados.flatMap(a => estados.map(b => [a, b]))]
      let revisadas = 0

      for (const invoiceMode of modos) {
        for (const combo of combinaciones) {
          const fila: Fila = { invoiceMode, invoices: combo.map(status => ({ status })) }
          expect({ invoiceMode, combo, categorias: categoriasDe(fila).length }).toEqual({ invoiceMode, combo, categorias: 1 })
          revisadas++
        }
      }
      expect(revisadas).toBe(3 * (1 + 6 + 36))
    })

    it('el armador de categorías es UNO: el filtro de la lista y los grupos usan la misma función', () => {
      // El filtro con varios valores se arma con las mismas categorías, no con una copia.
      const donde = occurrenceWhere({ invoice: ['PENDING'] }) as { AND: { OR: unknown[] }[] }
      expect(donde.AND[0].OR[0]).toEqual(invoiceCategoryWhere('PENDING'))
    })
  })

  describe('listOccurrences: el total y sumCents salen de UNA pasada con el mismo where', () => {
    const filtros = { view: 'open' as const, frequency: ['MONTHLY' as const], invoice: ['PENDING' as const], from: '2026-11-01' }

    beforeEach(() => {
      prismaMock.platformChargeOccurrence.findMany.mockResolvedValue([])
      prismaMock.platformChargeOccurrence.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { totalCents: null } })
    })

    it('la lista y UN aggregate (conteo y suma) usan el mismo where; no hay un count aparte, y la suma es de TODO el filtro, no de la página', async () => {
      prismaMock.platformChargeOccurrence.aggregate.mockResolvedValue({ _count: { _all: 137 }, _sum: { totalCents: 98765432 } })

      const r = await listOccurrences({ ...filtros, page: 2, pageSize: 10 }, AHORA)

      const donde = occurrenceWhere(filtros)
      expect(prismaMock.platformChargeOccurrence.findMany.mock.calls[0][0].where).toEqual(donde)
      expect(prismaMock.platformChargeOccurrence.aggregate).toHaveBeenCalledTimes(1)
      expect(prismaMock.platformChargeOccurrence.aggregate).toHaveBeenCalledWith({
        where: donde,
        _count: { _all: true },
        _sum: { totalCents: true },
      })
      expect(prismaMock.platformChargeOccurrence.count).not.toHaveBeenCalled()
      expect(r).toMatchObject({ total: 137, sumCents: 98765432, page: 2, pageSize: 10 })
    })

    it('sin cobros la suma es 0 (un entero, nunca null) y el total, 0', async () => {
      expect(await listOccurrences(filtros, AHORA)).toMatchObject({ total: 0, sumCents: 0 })
    })

    it('el tope de página no recorta la suma: con pageSize 1 sigue siendo la del filtro completo', async () => {
      prismaMock.platformChargeOccurrence.aggregate.mockResolvedValue({ _count: { _all: 9 }, _sum: { totalCents: 500 } })

      const r = await listOccurrences({ ...filtros, pageSize: 1 }, AHORA)

      expect(r).toMatchObject({ total: 9, sumCents: 500 })
      expect(prismaMock.platformChargeOccurrence.aggregate.mock.calls[0][0]).not.toHaveProperty('take')
    })
  })

  describe('groupOccurrences: se agrupa en la base, nunca sobre un recorte ni trayendo las fechas', () => {
    const groupBy = () => prismaMock.platformChargeOccurrence.groupBy
    const aggregate = () => prismaMock.platformChargeOccurrence.aggregate
    const sinFilas = () => expect(prismaMock.platformChargeOccurrence.findMany).not.toHaveBeenCalled()

    beforeEach(() => {
      prismaMock.platformChargeOccurrence.findMany.mockReset()
      groupBy().mockReset().mockResolvedValue([])
      aggregate()
        .mockReset()
        .mockResolvedValue({ _count: { _all: 0 }, _sum: { totalCents: null } })
      prismaMock.platformCharge.findMany.mockReset().mockResolvedValue([])
    })

    describe('por cliente', () => {
      const porCobro = (chargeId: string, count: number, totalCents: number) => ({
        chargeId,
        _count: { _all: count },
        _sum: { totalCents },
      })
      const cobroDe = (id: string, customerName = 'Café Ana') => ({ id, customerName })

      it('un groupBy por cobro con EL MISMO where y el nombre de esos cobros en UNA lectura aparte, acotada a ellos', async () => {
        groupBy().mockResolvedValue([porCobro('c1', 2, 300), porCobro('c2', 1, 50)])
        prismaMock.platformCharge.findMany.mockResolvedValue([cobroDe('c1'), cobroDe('c2', 'Luna')])
        const filtros = { frequency: ['MONTHLY' as const], from: '2026-11-01' }

        await groupOccurrences(filtros, 'customer')

        expect(groupBy()).toHaveBeenCalledTimes(1)
        expect(groupBy().mock.calls[0][0]).toMatchObject({
          by: ['chargeId'],
          where: occurrenceWhere(filtros),
          _count: { _all: true },
          _sum: { totalCents: true },
          orderBy: { chargeId: 'asc' },
          take: MAX_GROUP_ROWS + 1,
        })
        expect(prismaMock.platformCharge.findMany).toHaveBeenCalledTimes(1)
        expect(prismaMock.platformCharge.findMany.mock.calls[0][0]).toMatchObject({
          where: { id: { in: ['c1', 'c2'] } },
          select: { id: true, customerName: true },
          take: 2,
        })
        sinFilas()
      })

      it('🔴 dos cobros con el mismo nombre se suman en UN grupo: la llave y la etiqueta son el nombre', async () => {
        groupBy().mockResolvedValue([porCobro('c1', 2, 300), porCobro('c2', 1, 50), porCobro('c3', 4, 1000)])
        prismaMock.platformCharge.findMany.mockResolvedValue([cobroDe('c1'), cobroDe('c2'), cobroDe('c3', 'Luna')])

        const { groups, truncated } = await groupOccurrences({}, 'customer')

        expect(groups).toEqual([
          { key: 'Café Ana', label: 'Café Ana', count: 3, totalCents: 350 },
          { key: 'Luna', label: 'Luna', count: 4, totalCents: 1000 },
        ])
        expect(truncated).toBe(false)
      })

      it('el criterio es el nombre exacto, el mismo del filtro «customer»: nombres distintos son grupos distintos y el mismo nombre se funde', async () => {
        groupBy().mockResolvedValue([porCobro('c1', 1, 100), porCobro('c2', 1, 200), porCobro('c3', 1, 400)])
        prismaMock.platformCharge.findMany.mockResolvedValue([
          cobroDe('c1', 'Panadería Aurora'),
          cobroDe('c2', 'Panadería La Aurora'), // otra forma de escribir el nombre: otro grupo, como lo filtra «customer»
          cobroDe('c3', 'Panadería Aurora'),
        ])

        const { groups } = await groupOccurrences({}, 'customer')

        expect(groups).toEqual([
          { key: 'Panadería Aurora', label: 'Panadería Aurora', count: 2, totalCents: 500 },
          { key: 'Panadería La Aurora', label: 'Panadería La Aurora', count: 1, totalCents: 200 },
        ])
      })

      it('🔴 el clic en un grupo cuadra: filtrar por «customer» con la llave del grupo da la misma cuenta y la misma suma que el grupo', async () => {
        // Un mundo en memoria: los cobros con su nombre y las fechas de cada uno.
        const nombres: Record<string, string> = {
          c1: 'Panadería Aurora',
          c2: 'Panadería La Aurora',
          c3: 'Panadería Aurora',
          c4: 'Tienda Brisa',
        }
        const fechas = [
          { chargeId: 'c1', totalCents: 100 },
          { chargeId: 'c1', totalCents: 50 },
          { chargeId: 'c2', totalCents: 30 },
          { chargeId: 'c3', totalCents: 7 },
          { chargeId: 'c4', totalCents: 1000 },
          { chargeId: 'c4', totalCents: 5 },
        ]
        groupBy().mockImplementation(async () =>
          Object.keys(nombres).map(id => {
            const propias = fechas.filter(f => f.chargeId === id)
            return porCobro(
              id,
              propias.length,
              propias.reduce((suma, f) => suma + f.totalCents, 0),
            )
          }),
        )
        prismaMock.platformCharge.findMany.mockImplementation(async ({ where }: any) =>
          where.id.in.map((id: string) => cobroDe(id, nombres[id])),
        )

        const { groups } = await groupOccurrences({}, 'customer')

        expect(groups.map(g => g.key)).toEqual(['Panadería Aurora', 'Panadería La Aurora', 'Tienda Brisa'])
        for (const group of groups) {
          // Lo que filtra la base con esa llave: el nombre exacto del cobro.
          const filtrado = (occurrenceWhere({ customer: group.key }).AND as any[])[0].charge.customerName
          const delFiltro = fechas.filter(f => nombres[f.chargeId] === filtrado)
          expect({ key: group.key, count: delFiltro.length, totalCents: delFiltro.reduce((suma, f) => suma + f.totalCents, 0) }).toEqual({
            key: group.key,
            count: group.count,
            totalCents: group.totalCents,
          })
        }
        expect(groups.reduce((suma, g) => suma + g.count, 0)).toBe(fechas.length) // y los grupos suman todo
      })

      it('de la A a la Z por etiqueta, con acentos en su lugar', async () => {
        groupBy().mockResolvedValue([porCobro('c1', 1, 1), porCobro('c2', 1, 1), porCobro('c3', 1, 1)])
        prismaMock.platformCharge.findMany.mockResolvedValue([cobroDe('c1', 'Zeta'), cobroDe('c2', 'Ángel'), cobroDe('c3', 'Ana')])

        const { groups } = await groupOccurrences({}, 'customer')

        expect(groups.map(g => g.key)).toEqual(['Ana', 'Ángel', 'Zeta'])
      })

      it('sin cobros no lee los cobros: grupos vacíos', async () => {
        const r = await groupOccurrences({}, 'customer')

        expect(r).toEqual({ groups: [], truncated: false })
        expect(prismaMock.platformCharge.findMany).not.toHaveBeenCalled()
      })

      it('🔴 con más cobros que el tope no suma sobre un recorte: grupos vacíos y truncated, sin leer siquiera los nombres', async () => {
        // 5,001 cobros del MISMO cliente: recortar a 5,000 antes de juntarlos por nombre daría un grupo de 5,000 cuando el clic traería 5,001.
        const filas = Array.from({ length: MAX_GROUP_ROWS + 1 }, (_, i) => porCobro(`c${String(i).padStart(6, '0')}`, 1, 100))
        groupBy().mockResolvedValue(filas)
        prismaMock.platformCharge.findMany.mockImplementation(async ({ where }: any) => where.id.in.map((id: string) => cobroDe(id)))

        const r = await groupOccurrences({}, 'customer')

        expect(r).toEqual({ groups: [], truncated: true })
        expect(prismaMock.platformCharge.findMany).not.toHaveBeenCalled()
      })

      it('justo en el tope sí agrupa: el recorte sólo se declara con un renglón de más', async () => {
        const filas = Array.from({ length: MAX_GROUP_ROWS }, (_, i) => porCobro(`c${String(i).padStart(6, '0')}`, 1, 100))
        groupBy().mockResolvedValue(filas)
        prismaMock.platformCharge.findMany.mockImplementation(async ({ where }: any) => where.id.in.map((id: string) => cobroDe(id, id)))

        const { groups, truncated } = await groupOccurrences({}, 'customer')

        expect(truncated).toBe(false)
        expect(groups).toHaveLength(MAX_GROUP_ROWS)
        expect(prismaMock.platformCharge.findMany.mock.calls[0][0].take).toBe(MAX_GROUP_ROWS)
      })

      it('un cobro que ya no está (se borró entre las dos lecturas) no tumba la lista ni se pierde su dinero: va como «Cobro que ya no existe»', async () => {
        groupBy().mockResolvedValue([porCobro('c1', 1, 100), porCobro('c-borrado', 2, 500)])
        prismaMock.platformCharge.findMany.mockResolvedValue([cobroDe('c1')])

        const { groups } = await groupOccurrences({}, 'customer')

        expect(groups.reduce((suma, g) => suma + g.totalCents, 0)).toBe(600)
        expect(groups.reduce((suma, g) => suma + g.count, 0)).toBe(3)
      })
    })

    describe('por mes', () => {
      const porDia = (day: string, count: number, totalCents: number) => ({
        dueDate: calendarDayToDb(day),
        _count: { _all: count },
        _sum: { totalCents },
      })

      it('un groupBy por fecha de cobro con EL MISMO where; los días se juntan por mes en el servidor, de más viejo a más nuevo', async () => {
        groupBy().mockResolvedValue([
          porDia('2026-10-30', 1, 100),
          porDia('2026-11-02', 2, 200),
          porDia('2026-11-30', 1, 50),
          porDia('2026-12-01', 3, 1000),
          porDia('2027-01-15', 1, 7),
        ])
        const filtros = { invoice: ['PENDING' as const] }

        const { groups, truncated } = await groupOccurrences(filtros, 'month')

        expect(groupBy().mock.calls[0][0]).toMatchObject({
          by: ['dueDate'],
          where: occurrenceWhere(filtros),
          _count: { _all: true },
          _sum: { totalCents: true },
          orderBy: { dueDate: 'asc' },
          take: MAX_GROUP_ROWS + 1,
        })
        expect(groups).toEqual([
          { key: '2026-10', label: 'octubre 2026', count: 1, totalCents: 100 },
          { key: '2026-11', label: 'noviembre 2026', count: 3, totalCents: 250 },
          { key: '2026-12', label: 'diciembre 2026', count: 3, totalCents: 1000 },
          { key: '2027-01', label: 'enero 2027', count: 1, totalCents: 7 },
        ])
        expect(truncated).toBe(false)
        sinFilas()
      })

      it('el último y el primer día del mes caen en SU mes (columna sin zona: sin corrimientos)', async () => {
        groupBy().mockResolvedValue([porDia('2026-11-01', 1, 1), porDia('2026-11-30', 1, 1), porDia('2026-12-01', 1, 1)])

        const { groups } = await groupOccurrences({}, 'month')

        expect(groups.map(g => [g.key, g.count])).toEqual([
          ['2026-11', 2],
          ['2026-12', 1],
        ])
      })

      it('🔴 con más días que el tope no suma sobre un recorte: grupos vacíos y truncated', async () => {
        groupBy().mockResolvedValue(
          Array.from({ length: MAX_GROUP_ROWS + 1 }, (_, i) => ({
            dueDate: new Date(Date.UTC(2020, 0, 1 + i)),
            _count: { _all: 1 },
            _sum: { totalCents: 1 },
          })),
        )

        expect(await groupOccurrences({}, 'month')).toEqual({ groups: [], truncated: true })
      })

      it('justo en el tope sí agrupa todos los días', async () => {
        groupBy().mockResolvedValue(
          Array.from({ length: MAX_GROUP_ROWS }, (_, i) => ({
            dueDate: new Date(Date.UTC(2020, 0, 1 + i)),
            _count: { _all: 1 },
            _sum: { totalCents: 1 },
          })),
        )

        const { groups, truncated } = await groupOccurrences({}, 'month')

        expect(truncated).toBe(false)
        expect(groups.reduce((suma, g) => suma + g.count, 0)).toBe(MAX_GROUP_ROWS)
      })

      it('sin cobros: grupos vacíos', async () => {
        expect(await groupOccurrences({}, 'month')).toEqual({ groups: [], truncated: false })
      })
    })

    describe('por periodicidad y por factura: un aggregate por categoría', () => {
      /** Contesta cada aggregate según LA categoría que filtra (la reconoce en el where) y apunta con qué se le preguntó. */
      function responder(porCategoria: Record<string, [number, number]>, reconocer: (donde: any) => string) {
        aggregate().mockImplementation(async ({ where }: any) => {
          const [count, totalCents] = porCategoria[reconocer(where)] ?? [0, 0]
          return { _count: { _all: count }, _sum: { totalCents: count === 0 ? null : totalCents } }
        })
      }

      it('periodicidad: cuatro aggregates con el where del filtro Y la periodicidad; sólo salen los grupos con cobros, en orden fijo', async () => {
        const filtros = { from: '2026-11-01' }
        responder({ MONTHLY: [3, 900], ONE_TIME: [1, 100], WEEKLY: [0, 0] }, donde => donde.AND[1].charge.frequency)

        const { groups, truncated } = await groupOccurrences(filtros, 'frequency')

        expect(aggregate()).toHaveBeenCalledTimes(4)
        for (const [{ where }] of aggregate().mock.calls) {
          expect(where.AND[0]).toEqual(occurrenceWhere(filtros))
          expect(Object.keys(where.AND[1])).toEqual(['charge'])
        }
        expect(groups).toEqual([
          { key: 'MONTHLY', label: 'Mensual', count: 3, totalCents: 900 },
          { key: 'ONE_TIME', label: 'Una sola vez', count: 1, totalCents: 100 },
        ])
        expect(truncated).toBe(false)
        expect(groupBy()).not.toHaveBeenCalled()
        sinFilas()
      })

      it('factura: un aggregate por categoría con el where del filtro Y la categoría (la MISMA función del filtro), en el orden STAMPED, PROBLEM, PENDING, NONE', async () => {
        const filtros = { frequency: ['MONTHLY' as const] }
        const categoria = (donde: any) =>
          (['STAMPED', 'PROBLEM', 'PENDING', 'NONE'] as const).find(
            c => JSON.stringify(donde.AND[1]) === JSON.stringify(invoiceCategoryWhere(c)),
          )!
        responder({ STAMPED: [5, 5000], PENDING: [2, 200], NONE: [1, 10] }, categoria)

        const { groups } = await groupOccurrences(filtros, 'invoice')

        expect(aggregate()).toHaveBeenCalledTimes(4)
        for (const [{ where }] of aggregate().mock.calls) expect(where.AND[0]).toEqual(occurrenceWhere(filtros))
        expect(groups).toEqual([
          { key: 'STAMPED', label: 'Facturado', count: 5, totalCents: 5000 },
          { key: 'PENDING', label: 'Por facturar', count: 2, totalCents: 200 },
          { key: 'NONE', label: 'Sin factura', count: 1, totalCents: 10 },
        ])
        sinFilas()
      })

      it('sin cobros: grupos vacíos', async () => {
        expect(await groupOccurrences({}, 'invoice')).toEqual({ groups: [], truncated: false })
        expect(await groupOccurrences({}, 'frequency')).toEqual({ groups: [], truncated: false })
      })
    })

    describe('lo que comparten', () => {
      it('«groupBy» que no existe: 400, sin tocar la base', async () => {
        const error = (await groupOccurrences({}, 'cliente' as never).catch((e: unknown) => e)) as BadRequestError

        expect(error).toBeInstanceOf(BadRequestError)
        expect(error.code).toBe('PLATFORM_CHARGE_INVALID_GROUP_BY')
        expect(groupBy()).not.toHaveBeenCalled()
        expect(aggregate()).not.toHaveBeenCalled()
      })

      it.each(['customer', 'month', 'frequency', 'invoice'] as const)(
        '«from» después de «to» es 400 también al agrupar por %s',
        async dimension => {
          await expect(groupOccurrences({ from: '2026-11-10', to: '2026-11-09' }, dimension)).rejects.toBeInstanceOf(BadRequestError)

          expect(groupBy()).not.toHaveBeenCalled()
          expect(aggregate()).not.toHaveBeenCalled()
        },
      )

      it.each(['customer', 'month', 'frequency', 'invoice'] as const)(
        'por %s respeta la vista pedida (los grupos son de las pagadas, no de las pendientes)',
        async dimension => {
          await groupOccurrences({ view: 'paid' }, dimension)

          const [llamada] = [...groupBy().mock.calls, ...aggregate().mock.calls].map(([args]: any) => args)
          expect(JSON.stringify(llamada.where)).toContain('"status":"PAID"')
        },
      )
    })
  })
})
