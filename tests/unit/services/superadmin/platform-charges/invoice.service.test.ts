import { prismaMock } from '@tests/__helpers__/setup'

// El PAC (Facturapi) es la frontera: se reemplaza por un proveedor falso. TODO lo demás (platformCfdi.service, el candado, la
// transacción de la reserva) es el código real, contra un doble en memoria de las tablas, para afirmar el ESTADO final.
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/superadmin/platform-billing/billingTaxProfile.service', () => ({ getBillingTaxProfileForCustomer: jest.fn() }))

import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import { getBillingTaxProfileForCustomer } from '@/services/superadmin/platform-billing/billingTaxProfile.service'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'
import { chargesSandbox, invoiceOccurrence, resolverIntento } from '@/services/superadmin/platform-charges/invoice.service'

/**
 * «Por cobrar» — factura de una ocurrencia (spec 2026-11-02-por-cobrar-superadmin §6). Es el núcleo fiscal: NUNCA timbra dos
 * facturas por un mismo pago y NUNCA decide sin preguntarle a Facturapi. Cada renglón de `resolverIntento` del §6 es una prueba.
 *
 * Qué NO prueba un doble en memoria: que la fila del cobro de verdad bloquee a la otra transacción (lo prueba la integración
 * contra Postgres, en una tarea posterior). Aquí se prueba el contrato: qué se lee, qué se decide, en qué orden y qué se escribe.
 */

const mockResolve = resolveFiscalProvider as jest.Mock

const mockPerfilPorCliente = getBillingTaxProfileForCustomer as jest.Mock
const mockLogAction = logAction as jest.Mock
const mockLogger = logger as unknown as { error: jest.Mock; warn: jest.Mock }

type Fila = Record<string, any>

/** Guarda PLATFORM_CHARGES_SANDBOX y NODE_ENV y devuelve la función que los restaura (una asignación de undefined escribiría "undefined"). */
function guardarEntorno(): () => void {
  const guardado = { sandbox: process.env.PLATFORM_CHARGES_SANDBOX, nodeEnv: process.env.NODE_ENV }
  const poner = (nombre: 'PLATFORM_CHARGES_SANDBOX' | 'NODE_ENV', valor: string | undefined) => {
    if (valor === undefined) delete process.env[nombre]
    else process.env[nombre] = valor
  }
  return () => {
    poner('PLATFORM_CHARGES_SANDBOX', guardado.sandbox)
    poner('NODE_ENV', guardado.nodeEnv)
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const LLAVE = 'por-cobrar:occ-1:0'
const hace = (minutos: number) => new Date(Date.now() - minutos * 60_000)
const vaciarPendientes = () => new Promise(resolve => setImmediate(resolve))

const CONCEPTOS = [
  { description: 'Renta de terminal', amountCents: 50000, ivaMode: 'WITHOUT_IVA', satProductKey: '81112401', satUnitKey: 'E48' },
  { description: 'Licencia', amountCents: 49900, ivaMode: 'WITH_IVA', satProductKey: '43232611', satUnitKey: 'E48' },
]
/** $500 sin IVA + $499 con IVA, a mano: A=50000, B=49900 → subtotal 93017, IVA 14883, total 107900 (= 58000 + 49900). */
const TOTALES = { subtotalCents: 93017, taxCents: 14883, totalCents: 107900 }

const PAC_VALIDO = {
  providerInvoiceId: 'fa-1',
  uuid: 'UUID-1',
  serie: 'A',
  folio: '118',
  totalCents: 107900,
  stampedAt: new Date('2026-11-02T18:00:00.000Z'),
  status: 'valid' as const,
}
const PAC_PENDIENTE = { ...PAC_VALIDO, uuid: null, status: 'pending' as const }
/** Lo que contesta `findByExternalId`: el resumen del documento. */
const resumen = (over: Fila = {}) => ({ ...PAC_VALIDO, customerTaxId: 'LUN010101AAA', isGlobal: false, ...over })

function fila(over: Fila = {}): Fila {
  return {
    id: 'cfdi-1',
    platformEmisorId: 'em1',
    billingTaxProfileId: 'perfil-1',
    platformChargeOccurrenceId: 'occ-1',
    type: 'INGRESO',
    organizationId: 'org-1',
    venueId: null,
    status: 'STAMPING',
    facturapiId: null,
    uuid: null,
    serie: 'A',
    folio: null,
    stampedAt: null,
    idempotencyKey: LLAVE,
    receptorRfc: 'LUN010101AAA',
    receptorNombre: 'ESTETICA LUNA SA DE CV',
    formaPago: '03',
    metodoPago: 'PUE',
    ...TOTALES,
    discountCents: 0,
    lines: [],
    lastError: null,
    attempts: 0,
    cancelMotivo: null,
    cancelSubstituteUuid: null,
    cancelStatus: null,
    cancelledAt: null,
    emailSentAt: null,
    createdById: 'staff-1',
    createdAt: hace(10),
    updatedAt: hace(10),
    ...over,
  }
}

/** Una factura que Facturapi ya timbró y que quedó anotada como cancelada en trámite. */
const filaCancelada = (over: Fila = {}) =>
  fila({
    status: 'CANCELLED',
    facturapiId: 'fa-1',
    uuid: 'UUID-1',
    folio: '118',
    cancelMotivo: '02',
    cancelStatus: 'pending',
    cancelledAt: hace(5),
    ...over,
  })

// ── Doble en memoria ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Mundo {
  occurrence: Fila
  charge: Fila
  rows: Fila[]
  emisor: Fila
  profile: Fila | null
  /** Otros perfiles fiscales que existen (de otros clientes). */
  extraProfiles: Fila[]
}

function nuevoMundo(): Mundo {
  return {
    occurrence: {
      id: 'occ-1',
      chargeId: 'cobro-1',
      dueDate: new Date('2026-11-01T00:00:00.000Z'),
      concepts: CONCEPTOS.map(c => ({ ...c })),
      ...TOTALES,
      invoiceMode: 'AUTOMATIC',
      status: 'PAID',
      paidAt: hace(30),
      paidById: 'staff-1',
      skippedAt: null,
      skippedById: null,
      invoiceSeq: 0,
      createdAt: hace(60 * 24),
      updatedAt: hace(30),
    },
    charge: {
      id: 'cobro-1',
      customerType: 'ORGANIZATION',
      organizationId: 'org-1',
      venueId: null,
      customerName: 'Estética Luna',
      billingTaxProfileId: 'perfil-1',
      frequency: 'MONTHLY',
      concepts: CONCEPTOS,
      invoiceMode: 'AUTOMATIC',
      pausedAt: null,
      createdById: 'staff-0',
      createdAt: hace(60 * 24 * 30),
      updatedAt: hace(60 * 24 * 30),
    },
    rows: [],
    emisor: { id: 'em1', provider: 'FACTURAPI', providerKeyEnc: 'enc-key', csdStatus: 'ACTIVE', serie: 'A', defaultUsoCfdi: null },
    extraProfiles: [],
    profile: {
      id: 'perfil-1',
      customerType: 'ORGANIZATION',
      rfc: 'LUN010101AAA',
      razonSocial: 'ESTETICA LUNA SA DE CV',
      regimenFiscal: '601',
      codigoPostal: '06000',
      defaultUsoCfdi: 'G03',
      email: 'luna@demo.mx',
      organizationId: 'org-1',
      venueId: null,
    },
  }
}

/** Como Prisma: aplica `{ increment }` y sube `updatedAt` (un milisegundo basta para que "la fila cambió" se note). */
function aplicar(target: Fila, data: Fila): Fila {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    const esIncremento =
      value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value) && 'increment' in value
    target[key] = esIncremento ? (target[key] ?? 0) + value.increment : value
  }
  target.updatedAt = new Date((target.updatedAt as Date).getTime() + 1)
  return target
}

function proveedorFalso() {
  return {
    createInvoice: jest.fn(),
    getInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    getCancellationStatus: jest.fn(),
    sendInvoiceByEmail: jest.fn().mockResolvedValue(undefined),
  }
}

let mundo: Mundo
let pac: ReturnType<typeof proveedorFalso>
/** Para inyectar "otra pestaña actuó justo ahora" en el instante exacto que cada prueba necesite. */
const ganchos: { alBuscarPerfil?: () => void } = {}

function instalarElDoble() {
  prismaMock.platformChargeOccurrence.findUnique.mockImplementation(async ({ where, include }: any) => {
    if (where.id !== mundo.occurrence.id) return null
    return { ...mundo.occurrence, ...(include?.charge ? { charge: { ...mundo.charge } } : {}) }
  })
  prismaMock.platformChargeOccurrence.update.mockImplementation(async ({ data }: any) => ({ ...aplicar(mundo.occurrence, data) }))
  prismaMock.platformCharge.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === mundo.charge.id ? { ...mundo.charge } : null,
  )
  prismaMock.platformCharge.update.mockImplementation(async ({ data }: any) => ({ ...aplicar(mundo.charge, data) }))

  prismaMock.platformCfdi.findUnique.mockImplementation(async ({ where }: any) => {
    const row = mundo.rows.find(r => (where.id ? r.id === where.id : r.idempotencyKey === where.idempotencyKey))
    return row ? { ...row } : null
  })
  prismaMock.platformCfdi.create.mockImplementation(async ({ data }: any) => {
    // Como la llave única de Postgres: dos filas con la misma llave no caben.
    if (mundo.rows.some(r => r.idempotencyKey === data.idempotencyKey)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on idempotencyKey', { code: 'P2002', clientVersion: 'test' })
    }
    const ahora = new Date()
    const row = fila({ id: `cfdi-${mundo.rows.length + 1}`, createdAt: ahora, updatedAt: ahora, ...data })
    mundo.rows.push(row)
    return { ...row }
  })
  prismaMock.platformCfdi.update.mockImplementation(async ({ where, data }: any) => {
    const row = mundo.rows.find(r => r.id === where.id)
    if (!row) throw new Error('P2025: la fila ya no existe')
    return { ...aplicar(row, data) }
  })
  prismaMock.platformCfdi.delete.mockImplementation(async ({ where }: any) => {
    const index = mundo.rows.findIndex(r => r.id === where.id)
    if (index < 0) throw new Error('P2025: la fila ya no existe')
    return mundo.rows.splice(index, 1)[0]
  })

  prismaMock.platformEmisor.findFirst.mockImplementation(async () => ({ ...mundo.emisor }))
  prismaMock.platformEmisor.findUnique.mockImplementation(async () => ({ ...mundo.emisor }))
  prismaMock.billingTaxProfile.findUnique.mockImplementation(async ({ where }: any) => {
    ganchos.alBuscarPerfil?.()
    const perfil = [mundo.profile, ...mundo.extraProfiles].find(p => p !== null && p.id === where.id)
    return perfil ? { ...perfil } : null
  })
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'cobro-1' }])
  mockResolve.mockReturnValue(pac)
}

beforeEach(() => {
  mundo = nuevoMundo()
  pac = proveedorFalso()
  delete ganchos.alBuscarPerfil
  mockPerfilPorCliente.mockReset()
  mockPerfilPorCliente.mockResolvedValue(null)
  instalarElDoble()
})

const sinEscrituras = () => {
  expect(prismaMock.platformCfdi.create).not.toHaveBeenCalled()
  expect(prismaMock.platformCfdi.update).not.toHaveBeenCalled()
  expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled()
  expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
}
const elPacNoFueConsultado = () => {
  expect(pac.getInvoice).not.toHaveBeenCalled()
  expect(pac.findByExternalId).not.toHaveBeenCalled()
  expect(pac.getCancellationStatus).not.toHaveBeenCalled()
  expect(pac.createInvoice).not.toHaveBeenCalled()
}
const ISSUED = expect.objectContaining({ action: 'PLATFORM_CFDI_ISSUED' })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// chargesSandbox
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('chargesSandbox — el modo de prueba del flujo (spec §6, «Modo de prueba»)', () => {
  const SIN_LLAVE = { providerKeyEnc: null }
  const CON_LLAVE = { providerKeyEnc: 'enc-key' }
  let restaurarEntorno: () => void
  beforeEach(() => {
    restaurarEntorno = guardarEntorno()
  })
  afterEach(() => restaurarEntorno())

  it('sin la variable es false —sin mirar la llave del emisor ni el entorno—: el flujo es siempre real', () => {
    delete process.env.PLATFORM_CHARGES_SANDBOX
    process.env.NODE_ENV = 'production'

    expect(chargesSandbox(CON_LLAVE)).toBe(false)
    expect(chargesSandbox(SIN_LLAVE)).toBe(false)
  })

  it.each(['1', 'TRUE', 'yes', 'false', ''])('sólo vale exactamente "true": "%s" no enciende nada', valor => {
    process.env.PLATFORM_CHARGES_SANDBOX = valor

    expect(chargesSandbox(SIN_LLAVE)).toBe(false)
  })

  it('con PLATFORM_CHARGES_SANDBOX=true, fuera de producción y con un emisor SIN llave guardada es true', () => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    process.env.NODE_ENV = 'test'

    expect(chargesSandbox(SIN_LLAVE)).toBe(true)
  })

  it('con la variable en un servidor de PRODUCCIÓN se niega (lanza), no finge una prueba', () => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    process.env.NODE_ENV = 'production'

    expect(() => chargesSandbox(SIN_LLAVE)).toThrow(PlatformBillingError)
    expect(() => chargesSandbox(SIN_LLAVE)).toThrow(/producción/)
  })

  it('con la variable y un emisor que TRAE su llave guardada se niega: sandbox:true no la reemplaza y se timbraría de verdad', () => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    process.env.NODE_ENV = 'test'

    expect(() => chargesSandbox(CON_LLAVE)).toThrow(PlatformBillingError)
    expect(() => chargesSandbox(CON_LLAVE)).toThrow(/llave/)
  })

  it('con la variable y una llave de PRODUCCIÓN en FACTURAPI_TEST_KEY se niega: la llave decide el ambiente, no el nombre de la variable', () => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    process.env.NODE_ENV = 'test'
    const antes = process.env.FACTURAPI_TEST_KEY
    process.env.FACTURAPI_TEST_KEY = 'sk_live_de_verdad'
    try {
      expect(() => chargesSandbox(SIN_LLAVE)).toThrow(PlatformBillingError)
      expect(() => chargesSandbox(SIN_LLAVE)).toThrow(/llave de producción/)
    } finally {
      if (antes === undefined) delete process.env.FACTURAPI_TEST_KEY
      else process.env.FACTURAPI_TEST_KEY = antes
    }
  })

  it('una llave de pruebas en FACTURAPI_TEST_KEY no estorba', () => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    process.env.NODE_ENV = 'test'
    const antes = process.env.FACTURAPI_TEST_KEY
    process.env.FACTURAPI_TEST_KEY = 'sk_test_x'
    try {
      expect(chargesSandbox(SIN_LLAVE)).toBe(true)
    } finally {
      if (antes === undefined) delete process.env.FACTURAPI_TEST_KEY
      else process.env.FACTURAPI_TEST_KEY = antes
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// resolverIntento: UNA prueba por renglón del §6
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('resolverIntento — sin fila y con factura viva', () => {
  it('sin fila con la llave actual: NONE, sin preguntarle nada al PAC', async () => {
    await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })

    elPacNoFueConsultado()
    sinEscrituras()
  })

  it('la llave es por-cobrar:<id>:<invoiceSeq>: con otro invoiceSeq la fila de la llave vieja no cuenta', async () => {
    mundo.rows = [fila({ status: 'STAMPED', uuid: 'UUID-VIEJO' })] // llave :0
    mundo.occurrence.invoiceSeq = 1 // ya se cerró aquel intento

    await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })
  })

  it.each(['STAMPED', 'CANCEL_REQUESTED'])('%s: VIVA (la regresa) sin preguntarle al PAC ni escribir nada', async status => {
    mundo.rows = [fila({ status, facturapiId: 'fa-1', uuid: 'UUID-1', folio: '118' })]

    const intento = await resolverIntento('occ-1')

    expect(intento).toMatchObject({ kind: 'LIVE', cfdi: { id: 'cfdi-1', status, uuid: 'UUID-1' } })
    elPacNoFueConsultado()
    sinEscrituras()
  })

  it('una ocurrencia que no existe es un 404, no un NONE que invite a timbrar', async () => {
    await expect(resolverIntento('no-existe')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('resolverIntento — CANCELLED: se pregunta por la cancelación', () => {
  it.each(['canceled', 'accepted'] as const)(
    'getCancellationStatus %s: cierra (la fila CANCELLED se queda, sube invoiceSeq) y da NONE',
    async estado => {
      mundo.rows = [filaCancelada()]
      pac.getCancellationStatus.mockResolvedValue({ status: estado, cancelledAt: new Date() })

      await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })

      expect(pac.getCancellationStatus).toHaveBeenCalledWith('fa-1')
      expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled() // la cancelada se conserva: es el rastro fiscal
      expect(mundo.rows).toHaveLength(1)
      expect(mundo.rows[0]).toMatchObject({ status: 'CANCELLED', cancelStatus: 'pending' })
      expect(mundo.occurrence.invoiceSeq).toBe(1)
    },
  )

  it('pending: 409 «la cancelación sigue en trámite» y NO cambia nada', async () => {
    mundo.rows = [filaCancelada()]
    pac.getCancellationStatus.mockResolvedValue({ status: 'pending', cancelledAt: null })

    const error = await resolverIntento('occ-1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).statusCode).toBe(409)
    expect((error as ConflictError).message).toMatch(/trámite/)
    sinEscrituras()
    expect(mundo.occurrence.invoiceSeq).toBe(0)
  })

  it.each(['rejected', 'expired', 'none'] as const)(
    '%s: la fila regresa a STAMPED sin datos de cancelación (para cancelarla otra vez) y 409 «no procedió; A-118 sigue vigente»',
    async estado => {
      mundo.rows = [filaCancelada({ cancelSubstituteUuid: 'UUID-SUST' })]
      pac.getCancellationStatus.mockResolvedValue({ status: estado, cancelledAt: null })

      const error = await resolverIntento('occ-1').catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).message).toMatch(/no procedió/)
      expect((error as ConflictError).message).toMatch(/A-118 sigue vigente/)
      expect(mundo.rows[0]).toMatchObject({
        status: 'STAMPED',
        cancelMotivo: null,
        cancelSubstituteUuid: null,
        cancelStatus: null,
        cancelledAt: null,
        uuid: 'UUID-1', // la factura sigue siendo la misma
      })
      expect(mundo.occurrence.invoiceSeq).toBe(0) // NO se libera la llave: la factura sigue vigente
    },
  )

  it('un proveedor sin getCancellationStatus: 409 y no se toca nada (jamás se supone que se canceló)', async () => {
    mundo.rows = [filaCancelada()]
    mockResolve.mockReturnValue({ ...pac, getCancellationStatus: undefined })

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    sinEscrituras()
  })

  it('si el PAC no contesta: 409 «no pude confirmar» y no se toca nada', async () => {
    mundo.rows = [filaCancelada()]
    pac.getCancellationStatus.mockRejectedValue(new Error('socket hang up'))

    const error = await resolverIntento('occ-1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/no pude confirmar/i)
    sinEscrituras()
  })

  it('una fila CANCELLED sin facturapiId no se puede consultar: 409 sin tocar nada (no hay a quién preguntarle)', async () => {
    mundo.rows = [filaCancelada({ facturapiId: null })]

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    expect(pac.getCancellationStatus).not.toHaveBeenCalled()
    sinEscrituras()
  })

  it('una respuesta que no es ninguna de las conocidas tampoco decide: 409 sin tocar nada', async () => {
    mundo.rows = [filaCancelada()]
    pac.getCancellationStatus.mockResolvedValue({ status: 'verifying', cancelledAt: null })

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    sinEscrituras()
  })
})

describe('resolverIntento — con facturapiId (el PAC aceptó pero no timbró)', () => {
  const enVuelo = (over: Fila = {}) => fila({ status: 'STAMPING', facturapiId: 'fa-1', lastError: 'respuesta tardía', ...over })

  it('getInvoice valid con UUID: la adopta (STAMPED con los datos del PAC) y es VIVA', async () => {
    mundo.rows = [enVuelo()]
    pac.getInvoice.mockResolvedValue(PAC_VALIDO)

    const intento = await resolverIntento('occ-1')

    expect(pac.getInvoice).toHaveBeenCalledWith('fa-1')
    expect(intento).toMatchObject({ kind: 'LIVE', cfdi: { id: 'cfdi-1', status: 'STAMPED', uuid: 'UUID-1', folio: '118' } })
    expect(mundo.rows[0]).toMatchObject({
      status: 'STAMPED',
      facturapiId: 'fa-1',
      uuid: 'UUID-1',
      serie: 'A',
      folio: '118',
      stampedAt: PAC_VALIDO.stampedAt,
      totalCents: 107900,
      lastError: null, // una factura STAMPED no puede seguir mostrando un error viejo
    })
    expect(mundo.occurrence.invoiceSeq).toBe(0) // adoptar no libera la llave
  })

  it('adoptar deja la bitácora PLATFORM_CFDI_ISSUED, con la ocurrencia y quien lo pidió', async () => {
    mundo.rows = [enVuelo()]
    pac.getInvoice.mockResolvedValue(PAC_VALIDO)

    await resolverIntento('occ-1', 'staff-9')

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-9',
        organizationId: 'org-1',
        action: 'PLATFORM_CFDI_ISSUED',
        entity: 'PlatformCfdi',
        entityId: 'cfdi-1',
        data: expect.objectContaining({
          uuid: 'UUID-1',
          totalCents: 107900,
          metodoPago: 'PUE',
          formaPago: '03',
          platformChargeOccurrenceId: 'occ-1',
        }),
      }),
    )
  })

  it('pending: 409 «el SAT la sigue procesando» y no cambia nada', async () => {
    mundo.rows = [enVuelo()]
    pac.getInvoice.mockResolvedValue(PAC_PENDIENTE)

    const error = await resolverIntento('occ-1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/SAT la sigue procesando/)
    sinEscrituras()
  })

  it('valid pero SIN UUID tampoco se adopta: sigue siendo "el SAT la sigue procesando"', async () => {
    mundo.rows = [enVuelo()]
    pac.getInvoice.mockResolvedValue({ ...PAC_VALIDO, uuid: null })

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    sinEscrituras()
  })

  it('canceled: marca la fila CANCELLED (se queda), sube invoiceSeq y da NONE', async () => {
    mundo.rows = [enVuelo()]
    pac.getInvoice.mockResolvedValue({ ...PAC_VALIDO, status: 'canceled' })

    await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })

    expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled()
    expect(mundo.rows[0]).toMatchObject({ status: 'CANCELLED', cancelStatus: 'canceled' })
    expect(mundo.rows[0].cancelledAt).toBeInstanceOf(Date)
    expect(mundo.occurrence.invoiceSeq).toBe(1)
  })

  it('canceled: la fila CANCELLED conserva el UUID, la serie y el folio del documento (es el rastro fiscal)', async () => {
    mundo.rows = [enVuelo()] // STAMPING con facturapiId, sin UUID ni folio todavía
    pac.getInvoice.mockResolvedValue({ ...PAC_VALIDO, status: 'canceled', uuid: 'UUID-1', serie: 'B', folio: '118' })

    await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })

    expect(mundo.rows[0]).toMatchObject({ status: 'CANCELLED', facturapiId: 'fa-1', uuid: 'UUID-1', serie: 'B', folio: '118' })
  })

  it('canceled sin serie en el documento: conserva la serie de la fila; sin UUID no inventa uno', async () => {
    mundo.rows = [enVuelo()]
    pac.getInvoice.mockResolvedValue({ ...PAC_VALIDO, status: 'canceled', uuid: null, serie: null, folio: '118' })

    await resolverIntento('occ-1')

    expect(mundo.rows[0]).toMatchObject({ status: 'CANCELLED', uuid: null, serie: 'A', folio: '118' })
  })

  it('si el PAC no contesta: 409 «no pude confirmar» y no se toca nada', async () => {
    mundo.rows = [enVuelo()]
    pac.getInvoice.mockRejectedValue(new Error('ETIMEDOUT'))

    const error = await resolverIntento('occ-1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/no pude confirmar/i)
    sinEscrituras()
  })

  it('una STAMP_FAILED que ya tenía facturapiId también se pregunta por su id (no por la llave)', async () => {
    mundo.rows = [enVuelo({ status: 'STAMP_FAILED' })]
    pac.getInvoice.mockResolvedValue(PAC_VALIDO)

    await expect(resolverIntento('occ-1')).resolves.toMatchObject({ kind: 'LIVE' })

    expect(pac.findByExternalId).not.toHaveBeenCalled()
  })
})

describe('resolverIntento — adoptar manda el correo al receptor, sin que su falla cuente', () => {
  const porAdoptar = () => {
    mundo.rows = [fila({ status: 'STAMPING', facturapiId: 'fa-1' })]
    pac.getInvoice.mockResolvedValue(PAC_VALIDO)
  }

  it('con perfil con correo: llama a sendPlatformCfdiEmail (PDF y XML por el PAC) con ese correo', async () => {
    porAdoptar()

    await resolverIntento('occ-1')
    await vaciarPendientes()

    expect(pac.sendInvoiceByEmail).toHaveBeenCalledTimes(1)
    expect(pac.sendInvoiceByEmail).toHaveBeenCalledWith('fa-1', 'luna@demo.mx')
    expect(mundo.rows[0].emailSentAt).toBeInstanceOf(Date)
  })

  it('si el correo falla: la factura sigue VIVA (la falla se registra, no cuenta)', async () => {
    porAdoptar()
    pac.sendInvoiceByEmail.mockRejectedValue(new Error('smtp caído'))

    const intento = await resolverIntento('occ-1')
    await vaciarPendientes()

    expect(intento).toMatchObject({ kind: 'LIVE', cfdi: { status: 'STAMPED' } })
    expect(pac.sendInvoiceByEmail).toHaveBeenCalledTimes(1)
    expect(mockLogger.warn).toHaveBeenCalled()
    expect(mundo.rows[0].status).toBe('STAMPED')
  })

  it('sin correo en el perfil: no lo llama', async () => {
    porAdoptar()
    mundo.profile = { ...(mundo.profile as Fila), email: null }

    await expect(resolverIntento('occ-1')).resolves.toMatchObject({ kind: 'LIVE' })
    await vaciarPendientes()

    expect(pac.sendInvoiceByEmail).not.toHaveBeenCalled()
  })
})

describe('resolverIntento — STAMPING sin facturapiId', () => {
  const FALLA_DE_TRANSPORTE = 'The operation was aborted due to timeout'

  it('de 1 minuto: 409 «se está timbrando», sin consultar al PAC (el POST de timbrado puede seguir en vuelo)', async () => {
    mundo.rows = [fila({ status: 'STAMPING', createdAt: hace(1), updatedAt: hace(1) })]

    const error = await resolverIntento('occ-1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/se está timbrando/)
    elPacNoFueConsultado()
    sinEscrituras()
  })

  // Una falla de transporte deja la fila STAMPING (con su lastError): el documento pudo quedar en camino, así que NO es una
  // STAMP_FAILED que se reintenta al momento. La espera de 2 min cuenta desde que nació el intento (`createdAt`): una llave se
  // intenta UNA sola vez (el reintento cierra la fila y nace otra con otra llave), así que no hay "último intento" que la mueva.
  it('una falla de transporte recién ocurrida (STAMPING con lastError y un intento) sigue siendo joven: 409 sin consultar al PAC', async () => {
    mundo.rows = [fila({ status: 'STAMPING', createdAt: hace(0.5), updatedAt: hace(0), lastError: FALLA_DE_TRANSPORTE, attempts: 1 })]

    await expect(resolverIntento('occ-1')).rejects.toThrow(/se está timbrando/)

    elPacNoFueConsultado()
    sinEscrituras()
  })

  it('justo antes de los 2 min (1 min 54 s) todavía no se le pregunta a Facturapi; pasados los 2 min (2 min 6 s) sí', async () => {
    mundo.rows = [fila({ status: 'STAMPING', createdAt: hace(1.9), updatedAt: hace(1.4), lastError: FALLA_DE_TRANSPORTE, attempts: 1 })]
    await expect(resolverIntento('occ-1')).rejects.toThrow(/se está timbrando/)
    expect(pac.findByExternalId).not.toHaveBeenCalled()

    mundo.rows[0].createdAt = hace(2.1)
    pac.findByExternalId.mockResolvedValue(null)
    await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })

    expect(pac.findByExternalId).toHaveBeenCalledWith(LLAVE)
  })

  describe.each([
    ['STAMPING de 3 minutos', { status: 'STAMPING', createdAt: hace(3), updatedAt: hace(3) }],
    [
      'STAMPING de 3 minutos tras una falla de transporte',
      { status: 'STAMPING', createdAt: hace(3), updatedAt: hace(2.5), lastError: FALLA_DE_TRANSPORTE, attempts: 1 },
    ],
    [
      'STAMP_FAILED por un rechazo confirmado del PAC (se reintenta al momento, aunque tenga segundos)',
      {
        status: 'STAMP_FAILED',
        createdAt: hace(0.1),
        updatedAt: hace(0.1),
        lastError: 'El campo Rfc del receptor no se encuentra en el listado del SAT.',
        attempts: 1,
      },
    ],
  ])('%s: se pregunta por la llave (findByExternalId)', (_nombre, campos) => {
    beforeEach(() => {
      mundo.rows = [fila(campos)]
    })

    it('error de red o del PAC: 409 «no pude confirmar; reintenta» y NO se borra nada (jamás se timbra a ciegas)', async () => {
      pac.findByExternalId.mockRejectedValue(new Error('Facturapi 502'))

      const error = await resolverIntento('occ-1').catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).message).toMatch(/no pude confirmar/i)
      expect(pac.findByExternalId).toHaveBeenCalledWith(LLAVE)
      sinEscrituras()
      expect(mundo.rows).toHaveLength(1)
      expect(mundo.occurrence.invoiceSeq).toBe(0)
    })

    it('null (el PAC no tiene nada con esa llave): cierra — borra la fila y sube invoiceSeq — y da NONE', async () => {
      pac.findByExternalId.mockResolvedValue(null)

      await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })

      expect(mundo.rows).toHaveLength(0)
      expect(mundo.occurrence.invoiceSeq).toBe(1)
    })

    it('canceled: cierra, y la fila se queda CANCELLED con su UUID: ese documento existe ante el SAT y el contador tiene que verlo', async () => {
      pac.findByExternalId.mockResolvedValue(resumen({ status: 'canceled', uuid: 'UUID-1', serie: 'B', folio: '118' }))

      await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })

      expect(mundo.rows).toHaveLength(1)
      expect(mundo.rows[0]).toMatchObject({ status: 'CANCELLED', uuid: 'UUID-1', serie: 'B', folio: '118' })
      expect(mundo.occurrence.invoiceSeq).toBe(1)
    })

    it('valid con UUID: la adopta (el timbre sí ocurrió aunque la respuesta se perdió) y es VIVA', async () => {
      pac.findByExternalId.mockResolvedValue(resumen())

      const intento = await resolverIntento('occ-1')

      expect(intento).toMatchObject({ kind: 'LIVE', cfdi: { id: 'cfdi-1', status: 'STAMPED', uuid: 'UUID-1' } })
      expect(mundo.rows[0]).toMatchObject({ status: 'STAMPED', facturapiId: 'fa-1', uuid: 'UUID-1', folio: '118', lastError: null })
      expect(mundo.occurrence.invoiceSeq).toBe(0)
    })

    it('pending: guarda el facturapiId y 409 «el SAT la sigue procesando»; la fila NO se borra', async () => {
      pac.findByExternalId.mockResolvedValue(resumen({ providerInvoiceId: 'fa-9', uuid: null, status: 'pending' }))

      const error = await resolverIntento('occ-1').catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).message).toMatch(/SAT la sigue procesando/)
      expect(mundo.rows).toHaveLength(1)
      expect(mundo.rows[0].facturapiId).toBe('fa-9') // la próxima consulta ya no necesita la llave: pregunta por el id
      expect(mundo.occurrence.invoiceSeq).toBe(0)
    })
  })

  it('tras guardar el facturapiId, la siguiente consulta pregunta por el id y termina la factura', async () => {
    mundo.rows = [fila({ status: 'STAMPING', createdAt: hace(3), updatedAt: hace(3) })]
    pac.findByExternalId.mockResolvedValue(resumen({ providerInvoiceId: 'fa-9', uuid: null, status: 'pending' }))
    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    pac.getInvoice.mockResolvedValue({ ...PAC_VALIDO, providerInvoiceId: 'fa-9' })
    const intento = await resolverIntento('occ-1')

    expect(pac.getInvoice).toHaveBeenCalledWith('fa-9')
    expect(intento).toMatchObject({ kind: 'LIVE', cfdi: { status: 'STAMPED', facturapiId: 'fa-9' } })
  })

  it('valid pero sin UUID se trata como en proceso: guarda el id y 409 (ni se adopta ni se borra)', async () => {
    mundo.rows = [fila({ status: 'STAMP_FAILED' })]
    pac.findByExternalId.mockResolvedValue(resumen({ uuid: null }))

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    expect(mundo.rows).toHaveLength(1)
    expect(mundo.rows[0]).toMatchObject({ status: 'STAMP_FAILED', facturapiId: 'fa-1' })
  })
})

describe('resolverIntento — bajo el candado se vuelve a leer lo que se va a decidir', () => {
  const vieja = () => fila({ status: 'STAMPING', createdAt: hace(5), updatedAt: hace(5) })

  it('cerrar con la FILA cambiada (otro proceso la timbró mientras se preguntaba): 409 y NO se borra', async () => {
    mundo.rows = [vieja()]
    pac.findByExternalId.mockImplementation(async () => {
      aplicar(mundo.rows[0], { status: 'STAMPED', facturapiId: 'fa-x', uuid: 'UUID-X' }) // se timbró justo ahora
      return null // y lo que alcanzó a ver el PAC cuando se le preguntó fue "nada"
    })

    const error = await resolverIntento('occ-1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(1)
    expect(mundo.rows[0]).toMatchObject({ status: 'STAMPED', uuid: 'UUID-X' }) // la factura viva sobrevive
    expect(mundo.occurrence.invoiceSeq).toBe(0)
  })

  it('cerrar con la fila tocada por otro proceso aunque conserve su estado (cambió updatedAt): 409 y NO se borra', async () => {
    mundo.rows = [vieja()]
    pac.findByExternalId.mockImplementation(async () => {
      aplicar(mundo.rows[0], { lastError: 'otro intento escribió aquí' })
      return null
    })

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    expect(mundo.rows).toHaveLength(1)
    expect(mundo.occurrence.invoiceSeq).toBe(0)
  })

  it('cerrar con invoiceSeq cambiado (otro cerró el intento primero): 409 y NO se borra ni se sube otra vez', async () => {
    mundo.rows = [vieja()]
    pac.findByExternalId.mockImplementation(async () => {
      mundo.occurrence.invoiceSeq = 1
      return null
    })

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(1)
    expect(mundo.occurrence.invoiceSeq).toBe(1) // no es 2
  })

  it('cerrar una CANCELLED con la fila cambiada: 409 y no sube invoiceSeq', async () => {
    mundo.rows = [filaCancelada()]
    pac.getCancellationStatus.mockImplementation(async () => {
      aplicar(mundo.rows[0], { cancelStatus: 'accepted' })
      return { status: 'accepted', cancelledAt: new Date() }
    })

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    expect(mundo.occurrence.invoiceSeq).toBe(0)
  })

  it('adoptar con la fila cambiada: 409 y no se pisa lo que escribió el otro proceso', async () => {
    mundo.rows = [fila({ status: 'STAMPING', facturapiId: 'fa-1' })]
    pac.getInvoice.mockImplementation(async () => {
      aplicar(mundo.rows[0], { lastError: 'otro proceso' })
      return PAC_VALIDO
    })

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    expect(mundo.rows[0]).toMatchObject({ status: 'STAMPING', uuid: null, lastError: 'otro proceso' })
    expect(mockLogAction).not.toHaveBeenCalled() // y no se anuncia una emisión que no se escribió
  })

  it('toda decisión corre bajo el candado del cobro (SELECT … FOR UPDATE) y las llamadas al PAC, afuera de él', async () => {
    mundo.rows = [vieja()]
    const orden: string[] = []
    prismaMock.$queryRaw.mockImplementation(async () => {
      orden.push('candado')
      return [{ id: 'cobro-1' }]
    })
    pac.findByExternalId.mockImplementation(async () => {
      orden.push('pac')
      return null
    })

    await resolverIntento('occ-1')

    expect(orden).toEqual(['pac', 'candado']) // se pregunta primero y se decide después, ya con el candado
    expect(prismaMock.$queryRaw.mock.calls[0][1]).toBe('cobro-1')
  })
})

describe('resolverIntento — el total del PAC manda al adoptar', () => {
  it('si el documento que se adopta tiene otro total que la fila: guarda el del PAC y lo registra con logger.error', async () => {
    mundo.rows = [fila({ status: 'STAMPING', facturapiId: 'fa-1' })]
    pac.getInvoice.mockResolvedValue({ ...PAC_VALIDO, totalCents: 107901 })

    await resolverIntento('occ-1')

    expect(mundo.rows[0].totalCents).toBe(107901)
    expect(mockLogger.error).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mockLogger.error.mock.calls[0])).toMatch(/107900.*107901|107901.*107900/)
  })

  it('si coincide no registra nada', async () => {
    mundo.rows = [fila({ status: 'STAMPING', facturapiId: 'fa-1' })]
    pac.getInvoice.mockResolvedValue(PAC_VALIDO)

    await resolverIntento('occ-1')

    expect(mockLogger.error).not.toHaveBeenCalled()
  })
})

describe('resolverIntento — un PAC que no contesta no deja la petición colgada (límite de 30 s)', () => {
  afterEach(() => {
    jest.useRealTimers()
  })
  const falsos = () => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })

  // Las tres consultas pasan por askPac; el SDK de Facturapi no trae tiempo límite en `getInvoice` ni en `findByExternalId`.
  const CONSULTAS: Array<[string, () => jest.Mock]> = [
    [
      'findByExternalId (STAMPING de 5 min, sin id)',
      () => {
        mundo.rows = [fila({ status: 'STAMPING', createdAt: hace(5), updatedAt: hace(5) })]
        return pac.findByExternalId
      },
    ],
    [
      'getInvoice (fila con facturapiId)',
      () => {
        mundo.rows = [fila({ status: 'STAMPING', facturapiId: 'fa-1' })]
        return pac.getInvoice
      },
    ],
    [
      'getCancellationStatus (fila CANCELLED)',
      () => {
        mundo.rows = [filaCancelada()]
        return pac.getCancellationStatus
      },
    ],
  ]

  it.each(CONSULTAS)(
    '%s que nunca contesta: a los 30 s es el 409 «no pude confirmar; reintenta» y no se toca nada',
    async (_nombre, preparar) => {
      falsos()
      preparar().mockReturnValue(new Promise(() => undefined)) // jamás contesta
      let terminada = false
      const resultado = resolverIntento('occ-1')
        .catch((e: unknown) => e)
        .finally(() => {
          terminada = true
        })

      await jest.advanceTimersByTimeAsync(29_999)
      expect(terminada).toBe(false) // todavía espera
      await jest.advanceTimersByTimeAsync(1)
      expect(terminada).toBe(true) // el límite de 30 s la soltó
      const error = await resultado

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).statusCode).toBe(409)
      expect((error as ConflictError).message).toMatch(/no pude confirmar/i)
      sinEscrituras()
      expect(mundo.occurrence.invoiceSeq).toBe(0)
    },
  )

  it('una respuesta a tiempo no deja ningún temporizador pendiente (el límite se cancela)', async () => {
    falsos()
    mundo.rows = [fila({ status: 'STAMP_FAILED' })]
    pac.findByExternalId.mockResolvedValue(null)

    await expect(resolverIntento('occ-1')).resolves.toEqual({ kind: 'NONE' })

    expect(jest.getTimerCount()).toBe(0)
  })

  it('una consulta que falla pronto tampoco deja temporizador pendiente', async () => {
    falsos()
    mundo.rows = [fila({ status: 'STAMP_FAILED' })]
    pac.findByExternalId.mockRejectedValue(new Error('Facturapi 503'))

    await expect(resolverIntento('occ-1')).rejects.toBeInstanceOf(ConflictError)

    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('resolverIntento — la bitácora de lo que borra, cancela o devuelve a vigente (ActivityLog, fuera del candado)', () => {
  /** Anota en qué orden ocurren el borrado/escritura, el commit del candado y la bitácora. */
  function anotarOrden(): string[] {
    const orden: string[] = []
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const resultado = await callback(prismaMock)
      orden.push('commit')
      return resultado
    })
    prismaMock.platformCfdi.delete.mockImplementation(async ({ where }: any) => {
      orden.push('borrar')
      return mundo.rows.splice(
        mundo.rows.findIndex(r => r.id === where.id),
        1,
      )[0]
    })
    mockLogAction.mockImplementation(() => {
      orden.push('bitácora')
    })
    return orden
  }

  it('cerrar un intento BORRA su fila: PLATFORM_CFDI_DISCARDED con quien lo pidió, el negocio y la organización, ya fuera del candado', async () => {
    mundo.rows = [
      fila({
        status: 'STAMP_FAILED',
        venueId: 'venue-1',
        lastError: 'El campo Rfc del receptor no se encuentra en el listado del SAT.',
        attempts: 1,
      }),
    ]
    pac.findByExternalId.mockResolvedValue(null)
    const orden = anotarOrden()

    await resolverIntento('occ-1', 'staff-9')

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-9',
      venueId: 'venue-1',
      organizationId: 'org-1',
      action: 'PLATFORM_CFDI_DISCARDED',
      entity: 'PlatformCfdi',
      entityId: 'cfdi-1',
      data: {
        priorStatus: 'STAMP_FAILED',
        receptorRfc: 'LUN010101AAA',
        totalCents: 107900,
        platformChargeOccurrenceId: 'occ-1',
        idempotencyKey: LLAVE,
        lastError: 'El campo Rfc del receptor no se encuentra en el listado del SAT.',
      },
    })
    expect(orden).toEqual(['borrar', 'commit', 'bitácora']) // la bitácora va DESPUÉS de que el candado terminó
  })

  it('sin quien lo pidió, la bitácora igual se escribe (staffId null)', async () => {
    mundo.rows = [fila({ status: 'STAMPING', createdAt: hace(5), updatedAt: hace(5) })]
    pac.findByExternalId.mockResolvedValue(null)

    await resolverIntento('occ-1')

    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PLATFORM_CFDI_DISCARDED', staffId: null }))
  })

  it('un cierre que NO borra (la CANCELLED se queda) no escribe PLATFORM_CFDI_DISCARDED', async () => {
    mundo.rows = [filaCancelada()]
    pac.getCancellationStatus.mockResolvedValue({ status: 'accepted', cancelledAt: new Date() })

    await resolverIntento('occ-1', 'staff-9')

    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('si la fila cambió bajo el candado (409) no se borra nada y no se escribe bitácora de un borrado que no ocurrió', async () => {
    mundo.rows = [fila({ status: 'STAMPING', createdAt: hace(5), updatedAt: hace(5) })]
    pac.findByExternalId.mockImplementation(async () => {
      aplicar(mundo.rows[0], { lastError: 'otro proceso' })
      return null
    })

    await expect(resolverIntento('occ-1', 'staff-9')).rejects.toBeInstanceOf(ConflictError)

    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('la CANCELLED que vuelve a STAMPED (el SAT no la procesó): PLATFORM_CFDI_CANCEL_NOT_APPLIED, fuera del candado', async () => {
    mundo.rows = [filaCancelada({ venueId: 'venue-1', cancelSubstituteUuid: null })]
    pac.getCancellationStatus.mockResolvedValue({ status: 'rejected', cancelledAt: null })
    const orden = anotarOrden()

    await expect(resolverIntento('occ-1', 'staff-9')).rejects.toThrow(/no procedió/)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-9',
      venueId: 'venue-1',
      organizationId: 'org-1',
      action: 'PLATFORM_CFDI_CANCEL_NOT_APPLIED',
      entity: 'PlatformCfdi',
      entityId: 'cfdi-1',
      data: {
        pacStatus: 'rejected',
        previousCancelStatus: 'pending',
        previousCancelMotivo: '02',
        uuid: 'UUID-1',
        platformChargeOccurrenceId: 'occ-1',
      },
    })
    expect(orden).toEqual(['commit', 'bitácora'])
  })

  it.each(['expired', 'none'] as const)('también con %s: queda la bitácora de que la cancelación no se aplicó', async estado => {
    mundo.rows = [filaCancelada()]
    pac.getCancellationStatus.mockResolvedValue({ status: estado, cancelledAt: null })

    await expect(resolverIntento('occ-1', 'staff-9')).rejects.toBeInstanceOf(ConflictError)

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PLATFORM_CFDI_CANCEL_NOT_APPLIED', data: expect.objectContaining({ pacStatus: estado }) }),
    )
  })

  it('una cancelación todavía en trámite no cambia nada y no escribe bitácora', async () => {
    mundo.rows = [filaCancelada()]
    pac.getCancellationStatus.mockResolvedValue({ status: 'pending', cancelledAt: null })

    await expect(resolverIntento('occ-1', 'staff-9')).rejects.toBeInstanceOf(ConflictError)

    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('el documento que el PAC ya tiene cancelado: la fila pasa a CANCELLED y queda PLATFORM_CFDI_CANCELLED (cambio de estado fiscal)', async () => {
    mundo.rows = [fila({ status: 'STAMPING', facturapiId: 'fa-1' })]
    pac.getInvoice.mockResolvedValue({ ...PAC_VALIDO, status: 'canceled' })

    await resolverIntento('occ-1', 'staff-9')

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-9',
      venueId: null,
      organizationId: 'org-1',
      action: 'PLATFORM_CFDI_CANCELLED',
      entity: 'PlatformCfdi',
      entityId: 'cfdi-1',
      data: { source: 'PAC', priorStatus: 'STAMPING', uuid: 'UUID-1', platformChargeOccurrenceId: 'occ-1' },
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// invoiceOccurrence
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('invoiceOccurrence — qué se exige antes de facturar', () => {
  const input = { actorId: 'staff-1' }

  it('exige que esté PAID: una PENDING es 409 ANTES de consultar al PAC o cerrar intentos (aunque haya un fallido esperando)', async () => {
    mundo.occurrence.status = 'PENDING'
    mundo.rows = [fila({ status: 'STAMP_FAILED' })] // si no se exigiera PAID primero, resolverIntento lo consultaría y lo cerraría
    pac.findByExternalId.mockResolvedValue(null)

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/pagado/)
    elPacNoFueConsultado()
    sinEscrituras()
    expect(mundo.rows).toHaveLength(1)
    expect(mundo.occurrence.invoiceSeq).toBe(0)
  })

  it('una SKIPPED tampoco se factura', async () => {
    mundo.occurrence.status = 'SKIPPED'

    await expect(invoiceOccurrence('occ-1', input)).rejects.toBeInstanceOf(ConflictError)

    elPacNoFueConsultado()
  })

  it('una ocurrencia que no existe es 404', async () => {
    await expect(invoiceOccurrence('no-existe', input)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('sin perfil fiscal (ni en la llamada, ni en el cobro, ni por cliente): PlatformBillingError NEEDS_FISCAL_DATA y no se timbra nada', async () => {
    mundo.charge.billingTaxProfileId = null
    mockPerfilPorCliente.mockResolvedValue(null)

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PlatformBillingError)
    expect((error as PlatformBillingError).code).toBe('NEEDS_FISCAL_DATA')
    elPacNoFueConsultado()
    sinEscrituras()
  })

  it('un cliente externo (STANDALONE) sin perfil en el cobro no tiene dónde buscarlo: NEEDS_FISCAL_DATA', async () => {
    mundo.charge = { ...mundo.charge, customerType: 'STANDALONE', organizationId: null, billingTaxProfileId: null }

    await expect(invoiceOccurrence('occ-1', input)).rejects.toMatchObject({ code: 'NEEDS_FISCAL_DATA' })

    expect(mockPerfilPorCliente).not.toHaveBeenCalled()
  })

  it('sin perfil en el cobro, para una organización lo busca por cliente (spec §5) y factura con ése', async () => {
    mundo.charge.billingTaxProfileId = null
    mundo.profile = { ...(mundo.profile as Fila), id: 'perfil-de-la-org' }
    mockPerfilPorCliente.mockResolvedValue({ id: 'perfil-de-la-org' })
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)

    expect(mockPerfilPorCliente).toHaveBeenCalledWith('ORGANIZATION', 'org-1')
    expect(mundo.rows[0].billingTaxProfileId).toBe('perfil-de-la-org')
  })

  it('para un negocio (VENUE) lo busca con el id del negocio', async () => {
    mundo.charge = { ...mundo.charge, customerType: 'VENUE', organizationId: null, venueId: 'venue-1', billingTaxProfileId: null }
    mundo.profile = {
      ...(mundo.profile as Fila),
      id: 'perfil-del-negocio',
      customerType: 'VENUE',
      organizationId: null,
      venueId: 'venue-1',
    }
    mockPerfilPorCliente.mockResolvedValue({ id: 'perfil-del-negocio' })
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)

    expect(mockPerfilPorCliente).toHaveBeenCalledWith('VENUE', 'venue-1')
  })

  it('el perfil por cliente se busca ANTES de tomar el candado (usa el Prisma global: nunca adentro de la transacción)', async () => {
    mundo.charge.billingTaxProfileId = null
    mundo.profile = { ...(mundo.profile as Fila), id: 'perfil-de-la-org' }
    const orden: string[] = []
    mockPerfilPorCliente.mockImplementation(async () => {
      orden.push('perfil')
      return { id: 'perfil-de-la-org' }
    })
    prismaMock.$queryRaw.mockImplementation(async () => {
      orden.push('candado')
      return [{ id: 'cobro-1' }]
    })
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)

    expect(orden.indexOf('perfil')).toBeLessThan(orden.indexOf('candado'))
    expect(orden.filter(paso => paso === 'perfil')).toHaveLength(1)
  })
})

describe('invoiceOccurrence — timbrar', () => {
  const input = { actorId: 'staff-1' }

  it('con una factura ya VIVA la regresa sin timbrar, sin crear fila y sin bitácora', async () => {
    mundo.rows = [fila({ status: 'STAMPED', facturapiId: 'fa-1', uuid: 'UUID-1', folio: '118' })]

    const cfdi = await invoiceOccurrence('occ-1', input)

    expect(cfdi).toMatchObject({ id: 'cfdi-1', status: 'STAMPED', uuid: 'UUID-1' })
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(prismaMock.platformCfdi.create).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('manda la llave por-cobrar:<id>:<seq>, PUE, forma de pago 03, los conceptos de la foto (con su taxIncluded) y el receptor del perfil', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    const cfdi = await invoiceOccurrence('occ-1', input)

    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    const params = pac.createInvoice.mock.calls[0][0]
    expect(params).toMatchObject({
      idempotencyKey: LLAVE,
      externalId: LLAVE,
      metodoPago: 'PUE',
      formaPago: '03',
      serie: 'A',
      receptor: { rfc: 'LUN010101AAA', regimenFiscal: '601', codigoPostal: '06000', usoCfdi: 'G03', email: 'luna@demo.mx' },
    })
    expect(params.items).toEqual([
      expect.objectContaining({
        description: 'Renta de terminal',
        satProductKey: '81112401',
        satUnitKey: 'E48',
        quantity: 1,
        unitPriceCents: 50000,
        taxIncluded: false,
        objetoImp: '02',
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
      }),
      expect.objectContaining({ description: 'Licencia', satProductKey: '43232611', unitPriceCents: 49900, taxIncluded: true }),
    ])
    expect(cfdi).toMatchObject({ status: 'STAMPED', uuid: 'UUID-1' })
  })

  it('la fila nace ligada a la ocurrencia, con los totales y las líneas de la FOTO (no los recalculados como precio neto)', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)

    expect(mundo.rows).toHaveLength(1)
    expect(mundo.rows[0]).toMatchObject({
      platformChargeOccurrenceId: 'occ-1',
      idempotencyKey: LLAVE,
      billingTaxProfileId: 'perfil-1',
      metodoPago: 'PUE',
      formaPago: '03',
      subtotalCents: 93017,
      discountCents: 0,
      taxCents: 14883,
      totalCents: 107900, // como neto serían 99900 + 15984 = 115884
      createdById: 'staff-1',
    })
    expect(mundo.rows[0].lines).toEqual([
      {
        description: 'Renta de terminal',
        satProductKey: '81112401',
        satUnitKey: 'E48',
        quantity: 1,
        unitPriceCents: 50000,
        taxRate: 0.16,
        taxIncluded: false,
      },
      {
        description: 'Licencia',
        satProductKey: '43232611',
        satUnitKey: 'E48',
        quantity: 1,
        unitPriceCents: 49900,
        taxRate: 0.16,
        taxIncluded: true,
      },
    ])
  })

  it('escribe la bitácora PLATFORM_CFDI_ISSUED (con el id de la ocurrencia) cuando timbra, y Task 4 no la repite', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-1',
      venueId: null,
      organizationId: 'org-1',
      action: 'PLATFORM_CFDI_ISSUED',
      entity: 'PlatformCfdi',
      entityId: 'cfdi-1',
      data: { uuid: 'UUID-1', totalCents: 107900, metodoPago: 'PUE', formaPago: '03', platformChargeOccurrenceId: 'occ-1' },
    })
  })

  it('la reserva de la fila toma el candado del cobro (SELECT … FOR UPDATE) dentro de la transacción que la crea', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)

    const candados = prismaMock.$queryRaw.mock.calls
    expect(candados.length).toBeGreaterThanOrEqual(2) // el de preparar la foto y el de la reserva
    expect(candados.every((llamada: unknown[]) => llamada[1] === 'cobro-1')).toBe(true)
  })

  it('el correo al cliente lo manda la emisión (issuePlatformCfdi) cuando el perfil trae correo', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)
    await vaciarPendientes()

    expect(pac.sendInvoiceByEmail).toHaveBeenCalledWith('fa-1', 'luna@demo.mx')
  })
})

describe('invoiceOccurrence — conceptKeys y perfil (la foto se corrige sin tocar los montos)', () => {
  const claves = [
    { satProductKey: '81112402', satUnitKey: 'H87' },
    { satProductKey: '43232612', satUnitKey: 'E48' },
  ]

  it('conceptKeys reescribe la foto de la ocurrencia, conserva los montos, y el PAC recibe las claves nuevas', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', { actorId: 'staff-1', conceptKeys: claves })

    expect(mundo.occurrence.concepts).toEqual([
      { description: 'Renta de terminal', amountCents: 50000, ivaMode: 'WITHOUT_IVA', satProductKey: '81112402', satUnitKey: 'H87' },
      { description: 'Licencia', amountCents: 49900, ivaMode: 'WITH_IVA', satProductKey: '43232612', satUnitKey: 'E48' },
    ])
    expect(mundo.occurrence).toMatchObject(TOTALES)
    const items = pac.createInvoice.mock.calls[0][0].items
    expect(items.map((i: Fila) => [i.satProductKey, i.satUnitKey, i.unitPriceCents])).toEqual([
      ['81112402', 'H87', 50000],
      ['43232612', 'E48', 49900],
    ])
    expect(mundo.rows[0]).toMatchObject(TOTALES)
  })

  it('la corrección de claves deja rastro: PLATFORM_CHARGE_UPDATED con la ocurrencia', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', { actorId: 'staff-1', conceptKeys: claves })

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-1',
        action: 'PLATFORM_CHARGE_UPDATED',
        entity: 'PlatformCharge',
        entityId: 'cobro-1',
        data: expect.objectContaining({ occurrenceId: 'occ-1', conceptKeys: claves }),
      }),
    )
  })

  it('un conceptKeys de largo distinto al de los conceptos es 422 y no se escribe ni se timbra nada', async () => {
    const error = await invoiceOccurrence('occ-1', { actorId: 'staff-1', conceptKeys: [claves[0]] }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PlatformBillingError)
    expect((error as PlatformBillingError).code).toBe('VALIDATION') // el controlador lo manda como 422
    expect((error as PlatformBillingError).message).toMatch(/claves/)
    expect(mundo.occurrence.concepts).toEqual(CONCEPTOS)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(prismaMock.platformCfdi.create).not.toHaveBeenCalled()
    expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
  })

  it('con la factura ya VIVA y otras claves: 409, y no se reescribe una foto que ya se timbró', async () => {
    mundo.rows = [fila({ status: 'STAMPED', facturapiId: 'fa-1', uuid: 'UUID-1' })]

    await expect(invoiceOccurrence('occ-1', { actorId: 'staff-1', conceptKeys: claves })).rejects.toBeInstanceOf(ConflictError)

    expect(mundo.occurrence.concepts).toEqual(CONCEPTOS)
    expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
  })

  it('billingTaxProfileId se guarda en el cobro, y con ése se factura', async () => {
    mundo.profile = { ...(mundo.profile as Fila), id: 'perfil-2', rfc: 'NVO010101BBB' }
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', { actorId: 'staff-1', billingTaxProfileId: 'perfil-2' })

    expect(mundo.charge.billingTaxProfileId).toBe('perfil-2')
    expect(pac.createInvoice.mock.calls[0][0].receptor).toMatchObject({ rfc: 'NVO010101BBB' })
    expect(mundo.rows[0].billingTaxProfileId).toBe('perfil-2')
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PLATFORM_CHARGE_UPDATED', data: expect.objectContaining({ billingTaxProfileId: 'perfil-2' }) }),
    )
  })

  it('un perfil que no existe NO se guarda en el cobro: NO_PROFILE y nada se timbra', async () => {
    const error = await invoiceOccurrence('occ-1', { actorId: 'staff-1', billingTaxProfileId: 'perfil-fantasma' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PlatformBillingError)
    expect((error as PlatformBillingError).code).toBe('NO_PROFILE')
    expect(mundo.charge.billingTaxProfileId).toBe('perfil-1')
    expect(pac.createInvoice).not.toHaveBeenCalled()
  })

  it('el mismo perfil que ya tiene el cobro no reescribe nada ni ensucia la bitácora', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', { actorId: 'staff-1', billingTaxProfileId: 'perfil-1' })

    expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PLATFORM_CHARGE_UPDATED' }))
  })
})

describe('invoiceOccurrence — el perfil fiscal debe ser del cliente del cobro (spec §6, «Cambios mínimos»)', () => {
  const input = { actorId: 'staff-1' }
  const claves = [
    { satProductKey: '81112402', satUnitKey: 'H87' },
    { satProductKey: '43232612', satUnitKey: 'E48' },
  ]
  /** El perfil de OTRO cliente; `campos` lo vuelve de otro tipo, otra organización, etc. */
  const perfilAjeno = (campos: Fila = {}): Fila => ({
    id: 'perfil-ajeno',
    customerType: 'ORGANIZATION',
    rfc: 'AJE010101CCC',
    razonSocial: 'AJENO SA DE CV',
    regimenFiscal: '601',
    codigoPostal: '01000',
    defaultUsoCfdi: 'G03',
    email: null,
    organizationId: 'org-2',
    venueId: null,
    ...campos,
  })

  const nadaSeGuardaNiSeTimbra = () => {
    expect(mundo.charge.billingTaxProfileId).toBe('perfil-1') // el cobro conserva su perfil
    expect(mundo.occurrence.concepts).toEqual(CONCEPTOS) // ni siquiera se reescribieron las claves
    expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
    expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(0)
    expect(mockLogAction).not.toHaveBeenCalled()
  }

  it.each([
    ['de otra organización', { organizationId: 'org-2' }],
    ['de un negocio (VENUE), aunque traiga la misma organización', { customerType: 'VENUE', organizationId: 'org-1', venueId: 'venue-9' }],
    ['de un cliente externo (STANDALONE)', { customerType: 'STANDALONE', organizationId: null }],
    ['de otro TIPO de cliente aunque traiga los mismos ids (dato inconsistente)', { customerType: 'STANDALONE', organizationId: 'org-1' }],
  ])(
    'un billingTaxProfileId %s: 400 PLATFORM_CHARGE_TAX_PROFILE_MISMATCH, no se guarda en el cobro y no se llama al PAC',
    async (_nombre, campos) => {
      mundo.extraProfiles = [perfilAjeno(campos)]

      const error = await invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: 'perfil-ajeno', conceptKeys: claves }).catch(
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).code).toBe('PLATFORM_CHARGE_TAX_PROFILE_MISMATCH')
      nadaSeGuardaNiSeTimbra()
    },
  )

  it('el perfil de un cobro de un NEGOCIO tiene que ser de ese negocio', async () => {
    mundo.charge = { ...mundo.charge, customerType: 'VENUE', organizationId: null, venueId: 'venue-1', billingTaxProfileId: 'perfil-1' }
    mundo.profile = { ...(mundo.profile as Fila), customerType: 'VENUE', organizationId: null, venueId: 'venue-1' }
    mundo.extraProfiles = [perfilAjeno({ customerType: 'VENUE', organizationId: null, venueId: 'venue-2' })]

    await expect(invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: 'perfil-ajeno' })).rejects.toMatchObject({
      code: 'PLATFORM_CHARGE_TAX_PROFILE_MISMATCH',
    })

    expect(pac.createInvoice).not.toHaveBeenCalled()
  })

  it('el perfil que YA trae el cobro, si resulta no ser del cliente (dato viejo), tampoco se timbra', async () => {
    mundo.charge.billingTaxProfileId = 'perfil-ajeno'
    mundo.extraProfiles = [perfilAjeno()]

    await expect(invoiceOccurrence('occ-1', input)).rejects.toMatchObject({ code: 'PLATFORM_CHARGE_TAX_PROFILE_MISMATCH' })

    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(0)
  })

  it('un perfil del propio cliente (misma organización) sí pasa y se guarda en el cobro', async () => {
    mundo.extraProfiles = [perfilAjeno({ id: 'perfil-nuevo', rfc: 'NVO010101BBB', organizationId: 'org-1' })]
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: 'perfil-nuevo' })

    expect(mundo.charge.billingTaxProfileId).toBe('perfil-nuevo')
    expect(pac.createInvoice.mock.calls[0][0].receptor).toMatchObject({ rfc: 'NVO010101BBB' })
  })

  it('un cliente externo (STANDALONE) factura con un perfil externo', async () => {
    mundo.charge = { ...mundo.charge, customerType: 'STANDALONE', organizationId: null, venueId: null, billingTaxProfileId: null }
    mundo.extraProfiles = [perfilAjeno({ id: 'perfil-externo', customerType: 'STANDALONE', organizationId: null })]
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: 'perfil-externo' })

    expect(mundo.charge.billingTaxProfileId).toBe('perfil-externo')
    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('la comprobación y la decisión de guardar usan el cobro RELEÍDO bajo el candado, no el leído antes', async () => {
    // La pantalla leyó el cobro con perfil-2; otra pestaña lo cambió a perfil-3 antes del candado; esta llamada trae perfil-2.
    mundo.charge.billingTaxProfileId = 'perfil-2'
    mundo.extraProfiles = [
      perfilAjeno({ id: 'perfil-2', organizationId: 'org-1' }),
      perfilAjeno({ id: 'perfil-3', organizationId: 'org-1' }),
    ]
    let candados = 0
    prismaMock.$queryRaw.mockImplementation(async () => {
      candados += 1
      if (candados === 1) mundo.charge.billingTaxProfileId = 'perfil-3' // el primer candado es el de preparar la foto
      return [{ id: 'cobro-1' }]
    })
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: 'perfil-2' })

    expect(mundo.charge.billingTaxProfileId).toBe('perfil-2') // se guardó lo que se pidió, no se dio por ya guardado
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PLATFORM_CHARGE_UPDATED', data: expect.objectContaining({ billingTaxProfileId: 'perfil-2' }) }),
    )
  })
})

describe('invoiceOccurrence — lo que cambia a media operación y no debe timbrarse a ciegas', () => {
  const input = { actorId: 'staff-1' }

  it('🔴 si otra pestaña corrige el RFC (el cobro pasa a otro perfil) después de elegir el perfil: 409, la fila no nace y NO se llama al PAC', async () => {
    ganchos.alBuscarPerfil = () => {
      mundo.charge.billingTaxProfileId = 'perfil-2'
    }

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/datos fiscales/)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(0)
  })

  it('🔴 si otra pestaña corrige el RFC en la MISMA fila del perfil justo antes de reservar: 409, la fila no nace y NO se llama al PAC', async () => {
    // Organización o negocio: corregir sobrescribe la misma fila, así que el id no cambia. Lecturas del perfil: preparar la foto, timbrar y reservar.
    let lecturas = 0
    ganchos.alBuscarPerfil = () => {
      lecturas += 1
      if (lecturas === 3) (mundo.profile as Fila).rfc = 'BBB010101BBB'
    }

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/datos fiscales/)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(0)
  })

  describe('🔴 lo que el founder vio en pantalla (`receptor`) es lo único que se puede timbrar', () => {
    const EN_PANTALLA = { rfc: 'LUN010101AAA', razonSocial: 'ESTETICA LUNA SA DE CV', regimenFiscal: '601', codigoPostal: '06000' }

    it('si coincide con lo que se va a timbrar: timbra', async () => {
      pac.createInvoice.mockResolvedValue(PAC_VALIDO)

      await expect(invoiceOccurrence('occ-1', { ...input, receptor: EN_PANTALLA })).resolves.toMatchObject({ status: 'STAMPED' })

      expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    })

    it('si otra pestaña guardó otro RFC en la misma fila antes de leer el perfil: 409, la fila no nace y NO se llama al PAC', async () => {
      ;(mundo.profile as Fila).rfc = 'BBB010101BBB'

      const error = await invoiceOccurrence('occ-1', { ...input, receptor: EN_PANTALLA }).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).message).toMatch(/datos fiscales/)
      expect(pac.createInvoice).not.toHaveBeenCalled()
      expect(mundo.rows).toHaveLength(0)
    })

    it('con una factura viva con los mismos datos, la regresa sin timbrar', async () => {
      mundo.rows.push(
        fila({ status: 'STAMPED', facturapiId: 'fa-1', uuid: 'UUID-1', receptorRegimen: '601', receptorCp: '06000', usoCfdi: 'G03' }),
      )

      await expect(invoiceOccurrence('occ-1', { ...input, receptor: EN_PANTALLA })).resolves.toMatchObject({ id: 'cfdi-1' })

      expect(pac.createInvoice).not.toHaveBeenCalled()
    })

    it('con una factura viva a otro contribuyente: 409, aunque el perfil de hoy coincida con esa factura', async () => {
      mundo.rows.push(
        fila({
          status: 'STAMPED',
          facturapiId: 'fa-1',
          uuid: 'UUID-1',
          folio: '118',
          receptorRegimen: '601',
          receptorCp: '06000',
          usoCfdi: 'G03',
        }),
      )

      const error = await invoiceOccurrence('occ-1', { ...input, receptor: { ...EN_PANTALLA, rfc: 'AAA010101AAA' } }).catch(
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).message).toMatch(/otros datos/)
    })
  })

  it('🔴 dos correcciones a la vez: la que encuentra la factura de la otra con otros datos recibe 409, no un éxito falso', async () => {
    const otras = [
      { satProductKey: '81112402', satUnitKey: 'H87' },
      { satProductKey: '43232612', satUnitKey: 'E48' },
    ]
    // La otra pestaña timbra después de que ésta pasó por «¿ya hay fila?» bajo el candado, y antes de que entre a timbrar.
    ganchos.alBuscarPerfil = () => {
      if (mundo.rows.length === 0) {
        mundo.rows.push(
          fila({
            status: 'STAMPED',
            facturapiId: 'fa-1',
            uuid: 'UUID-1',
            serie: 'A',
            folio: '118',
            receptorRegimen: '601',
            receptorCp: '06000',
            usoCfdi: 'G03',
            lines: [
              { description: 'Renta de terminal', satProductKey: '81112401', satUnitKey: 'E48', quantity: 1, unitPriceCents: 50000 },
              { description: 'Licencia', satProductKey: '43232611', satUnitKey: 'E48', quantity: 1, unitPriceCents: 99900 },
            ],
          }),
        )
      }
    }

    const error = await invoiceOccurrence('occ-1', { ...input, conceptKeys: otras }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/otros datos/)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(1)
  })

  it('🔴 si en modo de prueba alguien guarda una llave real después de decidir el modo: se niega, la fila no nace y NO se llama al PAC', async () => {
    const restaurar = guardarEntorno()
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    process.env.NODE_ENV = 'test'
    let lecturas = 0
    prismaMock.platformEmisor.findFirst.mockImplementation(async () => {
      lecturas += 1
      return { ...mundo.emisor, providerKeyEnc: lecturas > 1 ? 'enc-llave-real' : null }
    })
    try {
      const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(PlatformBillingError)
      expect((error as PlatformBillingError).message).toMatch(/llave/)
      expect(pac.createInvoice).not.toHaveBeenCalled()
      expect(mundo.rows).toHaveLength(0)
    } finally {
      restaurar()
    }
  })
})

describe('invoiceOccurrence — una corrección que llega con la factura ya viva', () => {
  const input = { actorId: 'staff-1' }
  const VIVA = () =>
    fila({
      status: 'STAMPED',
      facturapiId: 'fa-1',
      uuid: 'UUID-1',
      serie: 'A',
      folio: '118',
      receptorRegimen: '601',
      receptorCp: '06000',
      usoCfdi: 'G03',
      lines: [
        { description: 'Renta de terminal', satProductKey: '81112401', satUnitKey: 'E48', quantity: 1, unitPriceCents: 50000 },
        { description: 'Licencia', satProductKey: '43232611', satUnitKey: 'E48', quantity: 1, unitPriceCents: 99900 },
      ],
    })
  const CLAVES = [
    { satProductKey: '81112401', satUnitKey: 'E48' },
    { satProductKey: '43232611', satUnitKey: 'E48' },
  ]
  const OTRO_PERFIL = {
    id: 'perfil-2',
    customerType: 'ORGANIZATION',
    organizationId: 'org-1',
    venueId: null,
    rfc: 'OTR010101AAA',
    razonSocial: 'OTRA RAZON SOCIAL',
  }

  beforeEach(() => {
    mundo.rows.push(VIVA())
  })

  it('🔴 con otro RFC: 409 que dice cuál factura, en vez de regresarla como si la corrección hubiera entrado', async () => {
    mundo.extraProfiles.push(OTRO_PERFIL as any)

    const error = await invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: 'perfil-2' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toBe(
      'La factura A-118 ya está timbrada con otros datos: cancélala en Facturas CFDI para corregirla',
    )
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(1)
  })

  it('🔴 mismo perfil pero con la razón social corregida (organización o negocio guardan en la misma fila): también es 409', async () => {
    ;(mundo.profile as Fila).razonSocial = 'RAZON CORREGIDA'

    await expect(invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: (mundo.profile as Fila).id })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it.each([
    ['el código postal', { codigoPostal: '07000' }],
    ['el régimen', { regimenFiscal: '612' }],
    ['el uso del CFDI', { defaultUsoCfdi: 'S01' }],
    ['el RFC', { rfc: 'OTR010101AAA' }],
  ])('🔴 corregir sólo %s, en la misma fila del perfil: también es 409', async (_n, cambio) => {
    Object.assign(mundo.profile as Fila, cambio)

    const error = await invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: (mundo.profile as Fila).id }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/otros datos/)
  })

  it('🔴 con otra clave del SAT: 409', async () => {
    const error = await invoiceOccurrence('occ-1', {
      ...input,
      conceptKeys: [{ satProductKey: '81112402', satUnitKey: 'H87' }, CLAVES[1]],
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/otros datos/)
  })

  it('con los mismos datos (un reintento) la regresa sin timbrar', async () => {
    const cfdi = await invoiceOccurrence('occ-1', { ...input, billingTaxProfileId: (mundo.profile as Fila).id, conceptKeys: CLAVES })

    expect(cfdi).toMatchObject({ id: 'cfdi-1', status: 'STAMPED' })
    expect(pac.createInvoice).not.toHaveBeenCalled()
  })

  it('«Consultar estado» (sin corrección) la regresa aunque el perfil haya cambiado después', async () => {
    ;(mundo.profile as Fila).razonSocial = 'RAZON CORREGIDA'

    await expect(invoiceOccurrence('occ-1', input)).resolves.toMatchObject({ id: 'cfdi-1', status: 'STAMPED' })
  })
})

describe('invoiceOccurrence — la carrera «Facturar» contra «Deshacer» (reserveCheck)', () => {
  const input = { actorId: 'staff-1' }

  it('si entre preparar y reservar la ocurrencia vuelve a PENDING: 409, la fila no nace y NO se llama al PAC', async () => {
    ganchos.alBuscarPerfil = () => {
      mundo.occurrence.status = 'PENDING' // "Deshacer" cae JUSTO antes de la reserva
    }

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/pagado/)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(0)
  })

  it('si entre preparar y reservar cambia el invoiceSeq (otro cerró un intento): 409, la fila no nace y NO se llama al PAC', async () => {
    ganchos.alBuscarPerfil = () => {
      mundo.occurrence.invoiceSeq = 5
    }

    await expect(invoiceOccurrence('occ-1', input)).rejects.toBeInstanceOf(ConflictError)

    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(0)
  })

  it('si "Deshacer" cae entre resolverIntento y el candado: 409, y no se reescriben las claves ni el perfil', async () => {
    let candados = 0
    prismaMock.$queryRaw.mockImplementation(async () => {
      candados += 1
      if (candados === 1) mundo.occurrence.status = 'PENDING' // el primer candado del flujo es el de preparar la foto
      return [{ id: 'cobro-1' }]
    })
    const claves = [
      { satProductKey: '81112402', satUnitKey: 'H87' },
      { satProductKey: '43232612', satUnitKey: 'E48' },
    ]

    const error = await invoiceOccurrence('occ-1', { ...input, conceptKeys: claves }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/pagado/)
    expect(mundo.occurrence.concepts).toEqual(CONCEPTOS)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(0)
  })

  it('si otra pestaña reserva la llave entre resolverIntento y el candado: 409 «ya hay un intento en proceso» y NO se timbra', async () => {
    let candados = 0
    prismaMock.$queryRaw.mockImplementation(async () => {
      candados += 1
      if (candados === 1) mundo.rows.push(fila({ status: 'STAMPING', createdAt: new Date(), updatedAt: new Date() })) // la otra pestaña reservó
      return [{ id: 'cobro-1' }]
    })

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/en proceso/)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(1)
  })

  it('dos solicitudes a la vez (doble clic, dos pestañas): el PAC recibe UNA sola petición y existe UNA sola fila', async () => {
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    const resultados = await Promise.allSettled([invoiceOccurrence('occ-1', input), invoiceOccurrence('occ-1', input)])

    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    expect(mundo.rows).toHaveLength(1)
    expect(resultados.some(r => r.status === 'fulfilled')).toBe(true)
    for (const resultado of resultados) {
      // La que pierde la carrera recibe la fila de la otra o un 409 «ya hay un intento en proceso»; nunca otro timbrado.
      if (resultado.status === 'rejected') expect(resultado.reason).toBeInstanceOf(ConflictError)
    }
  })
})

describe('invoiceOccurrence — jamás dos facturas por un pago', () => {
  const input = { actorId: 'staff-1' }

  it('si el PAC contesta SIN timbre: devuelve la fila STAMPING (no lanza), y las consultas siguientes la terminan sin timbrar otra', async () => {
    pac.createInvoice.mockResolvedValue(PAC_PENDIENTE)

    const primera = await invoiceOccurrence('occ-1', input)

    expect(primera).toMatchObject({ status: 'STAMPING', facturapiId: 'fa-1' })
    expect(mockLogAction).not.toHaveBeenCalledWith(ISSUED) // todavía no hay timbre que anunciar

    pac.getInvoice.mockResolvedValue(PAC_PENDIENTE)
    await expect(invoiceOccurrence('occ-1', input)).rejects.toThrow(/SAT la sigue procesando/)

    pac.getInvoice.mockResolvedValue(PAC_VALIDO)
    const tercera = await invoiceOccurrence('occ-1', input)

    expect(tercera).toMatchObject({ status: 'STAMPED', uuid: 'UUID-1' })
    expect(pac.createInvoice).toHaveBeenCalledTimes(1) // UN solo timbrado en toda la historia
    expect(mundo.rows).toHaveLength(1)
    expect(mockLogAction).toHaveBeenCalledWith(ISSUED) // se anuncia al adoptarla
    expect(mundo.occurrence.invoiceSeq).toBe(0)
  })

  it('una falla de transporte NO libera la llave: el reintento inmediato es 409 «se está timbrando» y sólo a los 2 min se le pregunta al PAC', async () => {
    pac.createInvoice.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue(PAC_VALIDO)

    await expect(invoiceOccurrence('occ-1', input)).rejects.toBeInstanceOf(PlatformBillingError)
    // El documento pudo quedar en camino: la fila sigue siendo el reclamo (STAMPING), no un fallido que se descarta.
    expect(mundo.rows[0]).toMatchObject({ status: 'STAMPING', idempotencyKey: LLAVE, lastError: 'ECONNRESET', attempts: 1 })

    await expect(invoiceOccurrence('occ-1', input)).rejects.toThrow(/se está timbrando/)
    expect(pac.findByExternalId).not.toHaveBeenCalled()
    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    expect(mundo.rows).toHaveLength(1)
    expect(mundo.occurrence.invoiceSeq).toBe(0)

    // Pasan 2 minutos y Facturapi no tiene nada con la llave :0: ahora sí se cierra y se timbra con :1.
    mundo.rows[0].createdAt = hace(3)
    pac.findByExternalId.mockResolvedValue(null)
    const cfdi = await invoiceOccurrence('occ-1', input)

    expect(pac.findByExternalId).toHaveBeenCalledWith(LLAVE)
    expect(cfdi).toMatchObject({ status: 'STAMPED', idempotencyKey: 'por-cobrar:occ-1:1' })
    expect(pac.createInvoice).toHaveBeenCalledTimes(2)
    expect(pac.createInvoice.mock.calls[1][0].idempotencyKey).toBe('por-cobrar:occ-1:1')
    expect(mundo.rows).toHaveLength(1) // el reclamo viejo se cerró (se borró)
    expect(mundo.occurrence.invoiceSeq).toBe(1)
  })

  it('un rechazo CONFIRMADO del PAC (RFC malo) no espera: el reintento inmediato cierra el fallido y timbra con la llave :1', async () => {
    const rechazo = new ProviderHttpError(
      400,
      'invoice_stamping_validation_error',
      'El campo Rfc del receptor no se encuentra en el listado del SAT.',
    )
    pac.createInvoice.mockRejectedValueOnce(rechazo).mockResolvedValue(PAC_VALIDO)

    await expect(invoiceOccurrence('occ-1', input)).rejects.toMatchObject({ code: 'VALIDATION', field: 'rfc' })
    expect(mundo.rows[0]).toMatchObject({ status: 'STAMP_FAILED', idempotencyKey: LLAVE })

    pac.findByExternalId.mockResolvedValue(null) // se le preguntó al PAC y no hay nada con la llave :0
    const cfdi = await invoiceOccurrence('occ-1', input) // sin esperar los 2 min

    expect(pac.findByExternalId).toHaveBeenCalledWith(LLAVE)
    expect(cfdi).toMatchObject({ status: 'STAMPED', idempotencyKey: 'por-cobrar:occ-1:1' })
    expect(pac.createInvoice).toHaveBeenCalledTimes(2)
    expect(mundo.rows).toHaveLength(1)
    expect(mundo.occurrence.invoiceSeq).toBe(1)
  })

  it('si el timbrado "falló" por transporte pero el PAC SÍ timbró (se perdió la respuesta): a los 2 min la ADOPTA y no timbra otra', async () => {
    pac.createInvoice.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    await expect(invoiceOccurrence('occ-1', input)).rejects.toBeInstanceOf(PlatformBillingError)
    await expect(invoiceOccurrence('occ-1', input)).rejects.toThrow(/se está timbrando/) // dentro de la espera no se decide nada

    mundo.rows[0].createdAt = hace(3)
    pac.findByExternalId.mockResolvedValue(resumen())
    const cfdi = await invoiceOccurrence('occ-1', input)

    expect(cfdi).toMatchObject({ status: 'STAMPED', uuid: 'UUID-1', idempotencyKey: LLAVE })
    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    expect(mundo.rows).toHaveLength(1)
    expect(mundo.occurrence.invoiceSeq).toBe(0)
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(ISSUED)
  })

  it('si el PAC no contesta cuando se le pregunta, NO se timbra a ciegas: 409 y createInvoice no vuelve a llamarse', async () => {
    pac.createInvoice.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    await expect(invoiceOccurrence('occ-1', input)).rejects.toBeInstanceOf(PlatformBillingError)

    mundo.rows[0].createdAt = hace(3)
    pac.findByExternalId.mockRejectedValue(new Error('Facturapi 503'))
    await expect(invoiceOccurrence('occ-1', input)).rejects.toBeInstanceOf(ConflictError)

    expect(pac.findByExternalId).toHaveBeenCalledTimes(1)
    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    expect(mundo.rows).toHaveLength(1) // el reclamo sigue en pie
    expect(mundo.occurrence.invoiceSeq).toBe(0)
  })

  it('tras una cancelación confirmada se factura de nuevo con otra llave (la CANCELLED se queda como rastro)', async () => {
    mundo.rows = [filaCancelada({ idempotencyKey: LLAVE })]
    pac.getCancellationStatus.mockResolvedValue({ status: 'accepted', cancelledAt: new Date() })
    pac.createInvoice.mockResolvedValue({ ...PAC_VALIDO, providerInvoiceId: 'fa-2', uuid: 'UUID-2', folio: '119' })

    const cfdi = await invoiceOccurrence('occ-1', input)

    expect(cfdi).toMatchObject({ status: 'STAMPED', uuid: 'UUID-2', idempotencyKey: 'por-cobrar:occ-1:1' })
    expect(mundo.rows.map(r => [r.idempotencyKey, r.status])).toEqual([
      [LLAVE, 'CANCELLED'],
      ['por-cobrar:occ-1:1', 'STAMPED'],
    ])
    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('una cancelación que NO procedió no deja facturar otra vez: 409 y createInvoice no se llama', async () => {
    mundo.rows = [filaCancelada()]
    pac.getCancellationStatus.mockResolvedValue({ status: 'rejected', cancelledAt: null })

    await expect(invoiceOccurrence('occ-1', input)).rejects.toThrow(/no procedió/)

    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(1)
    expect(mundo.rows[0].status).toBe('STAMPED')
  })

  it('si el PAC rechaza los datos del receptor (422): el error sale tal cual, el fallido queda para cerrarse y no hay bitácora de emisión', async () => {
    pac.createInvoice.mockRejectedValue(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'El campo Rfc del receptor no se encuentra en el listado del SAT.'),
    )

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'VALIDATION', field: 'rfc' })
    expect(mundo.rows[0].status).toBe('STAMP_FAILED')
    expect(mockLogAction).not.toHaveBeenCalledWith(ISSUED)
  })
})

describe('invoiceOccurrence — una falla del PAC que deja la factura «en camino» se lo dice así al operador (spec §6, «Por qué así»)', () => {
  const input = { actorId: 'staff-1' }
  const EN_CAMINO = 'La factura pudo quedar en camino: consulta su estado en 2 minutos y no la timbres otra vez.'

  it('un corte de red: el mensaje empieza con el aviso y SIGUE con el detalle del proveedor; el código sigue siendo PROVIDER (502)', async () => {
    pac.createInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PlatformBillingError)
    expect(error).toMatchObject({ code: 'PROVIDER' })
    expect((error as PlatformBillingError).message).toBe(`${EN_CAMINO} Error al timbrar el CFDI: ECONNRESET`)
    expect(mundo.rows[0]).toMatchObject({ status: 'STAMPING', lastError: 'ECONNRESET' }) // la fila sigue siendo el reclamo
  })

  it('un 5xx del PAC (tampoco es un rechazo confirmado) se traduce igual', async () => {
    pac.createInvoice.mockRejectedValueOnce(new ProviderHttpError(503, null, 'Service Unavailable'))

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'PROVIDER' })
    expect((error as PlatformBillingError).message).toMatch(new RegExp(`^${EN_CAMINO}`))
    expect((error as PlatformBillingError).message).toContain('Service Unavailable')
    expect(mundo.rows[0].status).toBe('STAMPING')
  })

  it('un rechazo CONFIRMADO del PAC con código PROVIDER (la fila queda STAMP_FAILED) NO se traduce: ahí no quedó nada en camino', async () => {
    pac.createInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'Petición inválida'))

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(mundo.rows[0].status).toBe('STAMP_FAILED')
    expect(error).toBeInstanceOf(PlatformBillingError)
    expect(error).toMatchObject({ code: 'PROVIDER' })
    expect((error as PlatformBillingError).message).toBe('Error al timbrar el CFDI: Petición inválida')
    expect((error as PlatformBillingError).message).not.toContain('en camino')
  })

  it('un dato corregible (RFC malo, VALIDATION) sale tal cual, con su campo: nada que esperar', async () => {
    pac.createInvoice.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'El campo Rfc del receptor no se encuentra en el listado del SAT.'),
    )

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'VALIDATION', field: 'rfc' })
    expect((error as PlatformBillingError).message).not.toContain('en camino')
  })

  it('un error que NO es un rechazo confirmado pero donde el SAT sí nombró el campo (VALIDATION) sale con su mensaje y su campo, no con el aviso, aunque la fila quede STAMPING', async () => {
    // Un 503 no es un rechazo confirmado (la fila sigue siendo el reclamo), pero el mensaje dice qué dato corregir: eso es lo que se lee.
    pac.createInvoice.mockRejectedValueOnce(
      new ProviderHttpError(503, null, 'El campo Rfc del receptor no se encuentra en el listado del SAT.'),
    )

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(mundo.rows[0].status).toBe('STAMPING')
    expect(error).toMatchObject({ code: 'VALIDATION', field: 'rfc' })
    expect((error as PlatformBillingError).message).not.toContain('en camino')
  })

  it('un 409 «se está timbrando» (el reintento inmediato) no se vuelve a traducir: ya es el aviso correcto', async () => {
    pac.createInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))
    await invoiceOccurrence('occ-1', input).catch(() => undefined)

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toMatch(/se está timbrando/)
    expect((error as ConflictError).message).not.toContain('en camino')
  })

  it('si la lectura de la fila falla justo ahora, se queda con el aviso conservador (el documento pudo quedar en camino)', async () => {
    pac.createInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))
    const lectura = prismaMock.platformCfdi.findUnique.getMockImplementation()!
    // Sólo la lectura del estado de la fila, la de DESPUÉS del fallo, se cae; todas las demás pasan.
    prismaMock.platformCfdi.findUnique.mockImplementation(async (args: any) => {
      if (args?.select?.status) throw new Error('la base no contestó')
      return lectura(args)
    })

    const error = await invoiceOccurrence('occ-1', input).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'PROVIDER' })
    expect((error as PlatformBillingError).message).toMatch(new RegExp(`^${EN_CAMINO}`))
  })
})

describe('invoiceOccurrence — modo de prueba de QA (PLATFORM_CHARGES_SANDBOX)', () => {
  const input = { actorId: 'staff-1' }
  let restaurarEntorno: () => void
  beforeEach(() => {
    restaurarEntorno = guardarEntorno()
  })
  afterEach(() => restaurarEntorno())

  it('con la variable y un emisor sin llave: TODA llamada al proveedor del flujo va con sandbox:true (y no exige CSD activo)', async () => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    mundo.emisor = { ...mundo.emisor, providerKeyEnc: null, csdStatus: 'NONE' }
    mundo.rows = [fila({ status: 'STAMP_FAILED' })] // obliga a preguntar por la llave antes de timbrar
    pac.findByExternalId.mockResolvedValue(null)
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)

    expect(mockResolve.mock.calls.length).toBeGreaterThanOrEqual(2) // la consulta y el timbrado
    expect(mockResolve.mock.calls.every((llamada: any[]) => llamada[1].sandbox === true)).toBe(true)
  })

  it('con la variable y el emisor CON llave guardada se niega ANTES de escribir o hablar con Facturapi (ni siquiera reescribe las claves)', async () => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true' // y el emisor del mundo trae providerKeyEnc
    const claves = [
      { satProductKey: '81112402', satUnitKey: 'H87' },
      { satProductKey: '43232612', satUnitKey: 'E48' },
    ]

    await expect(invoiceOccurrence('occ-1', { ...input, conceptKeys: claves })).rejects.toThrow(/PLATFORM_CHARGES_SANDBOX/)

    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(mundo.rows).toHaveLength(0)
    expect(mundo.occurrence.concepts).toEqual(CONCEPTOS)
    expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
  })

  it('sin la variable todo va real (sandbox:false) y exige CSD activo, como siempre', async () => {
    delete process.env.PLATFORM_CHARGES_SANDBOX
    pac.createInvoice.mockResolvedValue(PAC_VALIDO)

    await invoiceOccurrence('occ-1', input)

    expect(mockResolve.mock.calls.every((llamada: any[]) => llamada[1].sandbox === false)).toBe(true)

    mundo = nuevoMundo()
    mundo.emisor = { ...mundo.emisor, csdStatus: 'NONE' }
    await expect(invoiceOccurrence('occ-1', input)).rejects.toMatchObject({ code: 'CSD_INACTIVE' })
  })

  it('sin emisor configurado: NO_EMISOR, sin escribir nada', async () => {
    prismaMock.platformEmisor.findFirst.mockResolvedValue(null)

    await expect(invoiceOccurrence('occ-1', input)).rejects.toMatchObject({ code: 'NO_EMISOR' })

    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
  })
})
