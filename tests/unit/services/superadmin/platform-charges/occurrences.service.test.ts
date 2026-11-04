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
  invoiceOccurrenceView,
  listOccurrences,
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
    prismaMock.platformChargeOccurrence.count.mockResolvedValue(0)
  })

  it('«open»: sólo las PENDING, de la más próxima a la más lejana con el id de desempate, y cada fila con su bucket del día de CDMX', async () => {
    findMany().mockResolvedValue([fila('2026-10-30'), fila('2026-11-02'), fila('2026-11-05')])
    prismaMock.platformChargeOccurrence.count.mockResolvedValue(3)

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

  it('el total sale de un count con EL MISMO filtro (el de la búsqueda también), no del largo de la página', async () => {
    findMany().mockResolvedValue([fila('2026-11-05')])
    prismaMock.platformChargeOccurrence.count.mockResolvedValue(137)

    const r = await listOccurrences({ view: 'open', q: 'luna', page: 2, pageSize: 1 }, AHORA)

    expect(r.rows).toHaveLength(1)
    expect(r.total).toBe(137)
    expect(prismaMock.platformChargeOccurrence.count).toHaveBeenCalledWith({ where: llamada().where })
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

      const vista = await skipOccurrence(OCC, 'staff-1', AHORA)

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
