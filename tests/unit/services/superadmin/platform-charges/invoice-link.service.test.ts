import { prismaMock } from '@tests/__helpers__/setup'

// El PAC (Facturapi) es la frontera: se reemplaza por un proveedor falso. TODO lo demás (invoice-link, invoice.service, occurrences.service,
// el candado y la transacción) es el código real contra un doble en memoria de las tablas, para afirmar el ESTADO final y que nadie timbre encima.
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/superadmin/platform-billing/billingTaxProfile.service', () => ({ getBillingTaxProfileForCustomer: jest.fn() }))

import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { getBillingTaxProfileForCustomer } from '@/services/superadmin/platform-billing/billingTaxProfile.service'
import {
  attachInvoiceInTx,
  conceptsFromInvoice,
  linkInvoice,
  listInvoiceCandidates,
  unlinkInvoice,
} from '@/services/superadmin/platform-charges/invoice-link.service'
import { invoiceOccurrence } from '@/services/superadmin/platform-charges/invoice.service'
import { payOccurrence, reopenOccurrence } from '@/services/superadmin/platform-charges/occurrences.service'
import { calendarDayToDb } from '@/services/superadmin/platform-charges/schedule'

/**
 * «Por cobrar» — anexar a una fecha de cobro una factura que ya existe en «Facturas CFDI» (spec 2026-11-03-por-cobrar-desde-factura-y-filtros,
 * «Anexar»; los huecos que cierra cada regla están en docs/audit/2026-11-03-por-cobrar-anexar/codex-r1.md). Lo que está en juego: timbrar
 * dos veces la misma venta o soltar una factura en silencio.
 *
 * Qué NO prueba un doble en memoria: que la fila del cobro de verdad bloquee a la otra transacción, ni el `updateMany` condicional bajo
 * dos conexiones reales: eso es de la integración contra Postgres. Aquí se prueba el contrato: qué se lee, qué se decide y qué se escribe.
 */

const mockResolve = resolveFiscalProvider as jest.Mock
const mockPerfilPorCliente = getBillingTaxProfileForCustomer as jest.Mock
const mockLogAction = logAction as jest.Mock

type Fila = Record<string, any>

const AHORA = new Date('2026-11-02T18:00:00.000Z')
const hace = (minutos: number) => new Date(AHORA.getTime() - minutos * 60_000)

const SAT = { satProductKey: '81161700', satUnitKey: 'E48' }
/** Lo que trae la fecha antes de anexar: $500 sin IVA → 50000 + 8000 = 58000. */
const CONCEPTOS_DEL_COBRO = [{ description: 'Renta de terminal', amountCents: 50000, ivaMode: 'WITHOUT_IVA', ...SAT }]
const TOTALES_DEL_COBRO = { subtotalCents: 50000, taxCents: 8000, totalCents: 58000 }

/** $1,000 + 2 × $250, los dos sin IVA: A = 150000 → subtotal 150000, IVA 24000, total 174000. */
const LINEAS_A19 = [
  { description: 'Suscripción', quantity: 1, unitPriceCents: 100000, taxRate: 0.16, ...SAT },
  { description: 'Capacitación', quantity: 2, unitPriceCents: 25000, ...SAT },
]
const CONCEPTOS_A19 = [
  { description: 'Suscripción', amountCents: 100000, ivaMode: 'WITHOUT_IVA', ...SAT },
  { description: 'Capacitación', amountCents: 50000, ivaMode: 'WITHOUT_IVA', ...SAT },
]
const TOTALES_A19 = { subtotalCents: 150000, taxCents: 24000, totalCents: 174000 }

function factura(over: Fila = {}): Fila {
  return {
    id: 'cfdi-19',
    platformEmisorId: 'em1',
    billingTaxProfileId: 'perfil-1',
    type: 'INGRESO',
    parentPlatformCfdiId: null,
    platformChargeOccurrenceId: null,
    chargeLinkedAt: null,
    organizationId: 'org-1',
    venueId: null,
    receptorRfc: 'LUN010101AAA',
    receptorNombre: 'ESTETICA LUNA SA DE CV',
    receptorRegimen: '601',
    receptorCp: '06000',
    usoCfdi: 'G03',
    lines: LINEAS_A19,
    formaPago: '03',
    metodoPago: 'PUE',
    ...TOTALES_A19,
    discountCents: 0,
    amountPaidCents: 0,
    status: 'STAMPED',
    facturapiId: 'fa-19',
    uuid: 'UUID-19',
    serie: 'A',
    folio: '19',
    stampedAt: hace(60 * 24),
    idempotencyKey: 'hecha-a-mano-19',
    lastError: null,
    attempts: 0,
    cancelMotivo: null,
    cancelSubstituteUuid: null,
    cancelStatus: null,
    cancelledAt: null,
    emailSentAt: null,
    createdById: 'staff-0',
    createdAt: hace(60 * 24),
    updatedAt: hace(60 * 24),
    ...over,
  }
}

/** Ya anexada a la fecha de siempre. */
const anexada = (over: Fila = {}) => factura({ platformChargeOccurrenceId: 'occ-1', chargeLinkedAt: hace(30), ...over })
/** La que timbró «Por cobrar» para esta fecha: ligada, con la llave del intento y sin marca de anexada. */
const timbradaDeAqui = (over: Fila = {}) =>
  factura({ id: 'cfdi-118', folio: '118', platformChargeOccurrenceId: 'occ-1', idempotencyKey: 'por-cobrar:occ-1:0', ...over })

const PERFIL = {
  id: 'perfil-1',
  customerType: 'ORGANIZATION',
  organizationId: 'org-1',
  venueId: null,
  rfc: 'LUN010101AAA',
  razonSocial: 'ESTETICA LUNA SA DE CV',
  regimenFiscal: '601',
  codigoPostal: '06000',
  defaultUsoCfdi: 'G03',
  email: null,
}
const EN_PANTALLA = {
  rfc: PERFIL.rfc,
  razonSocial: PERFIL.razonSocial,
  regimenFiscal: PERFIL.regimenFiscal,
  codigoPostal: PERFIL.codigoPostal,
}

// ── Doble en memoria ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Mundo {
  occ: Fila
  charge: Fila
  cfdis: Fila[]
  perfiles: Fila[]
}
let mundo: Mundo
/** Otra pestaña actúa en el instante exacto en que se va a escribir la factura. */
const ganchos: { antesDeTomarla?: () => void } = {}

function nuevoMundo(): Mundo {
  return {
    occ: {
      id: 'occ-1',
      chargeId: 'cobro-1',
      dueDate: calendarDayToDb('2026-11-01'),
      concepts: CONCEPTOS_DEL_COBRO.map(c => ({ ...c })),
      ...TOTALES_DEL_COBRO,
      invoiceMode: 'AUTOMATIC',
      status: 'PENDING',
      paidAt: null,
      paidById: null,
      skippedAt: null,
      skippedById: null,
      invoiceSeq: 0,
      createdAt: hace(60 * 24 * 2),
      updatedAt: hace(60 * 24 * 2),
    },
    charge: {
      id: 'cobro-1',
      customerType: 'ORGANIZATION',
      organizationId: 'org-1',
      venueId: null,
      customerName: 'Estética Luna',
      billingTaxProfileId: 'perfil-1',
      frequency: 'MONTHLY',
      concepts: CONCEPTOS_DEL_COBRO,
      invoiceMode: 'AUTOMATIC',
      pausedAt: null,
    },
    cfdis: [],
    perfiles: [{ ...PERFIL }],
  }
}

/** ¿La fila cumple el `where` de Prisma? `undefined` no filtra, igual que en Prisma: una condición que falte aquí se nota en la prueba. */
function cumple(f: Fila, where: Fila = {}): boolean {
  return Object.entries(where).every(([campo, cond]) => {
    if (cond === undefined) return true
    if (campo === 'OR') return (cond as Fila[]).some(rama => cumple(f, rama))
    if (campo === 'AND') return (cond as Fila[]).every(rama => cumple(f, rama))
    const valor = f[campo]
    if (cond === null) return valor === null || valor === undefined
    if (cond instanceof Date) return valor?.getTime() === cond.getTime()
    if (typeof cond !== 'object') return valor === cond
    return Object.entries(cond as Fila).every(([operador, limite]) => {
      const texto = (v: unknown) => (cond.mode === 'insensitive' ? String(v ?? '').toLowerCase() : String(v ?? ''))
      switch (operador) {
        case 'mode':
          return true
        case 'in':
          return limite.includes(valor)
        case 'notIn':
          return !limite.includes(valor)
        case 'not':
          return limite === null ? valor !== null && valor !== undefined : valor !== limite
        case 'equals':
          return texto(valor) === texto(limite)
        case 'contains':
          return texto(valor).includes(texto(limite))
        case 'gt':
          return valor > limite
        case 'lt':
          return valor < (limite?.name ? f[limite.name] : limite)
        default:
          throw new Error(`el doble no conoce el operador ${operador}`)
      }
    })
  })
}

const elegir = (fuente: Fila, select?: Fila): Fila =>
  select ? Object.fromEntries(Object.keys(select).map(k => [k, fuente[k]])) : { ...fuente }

function ordenar(filas: Fila[], orderBy: Fila | Fila[] | undefined): Fila[] {
  const criterios = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : []
  return [...filas].sort((a, b) => {
    for (const criterio of criterios) {
      const [campo, sentido] = Object.entries(criterio)[0] as [string, string]
      if (a[campo] < b[campo]) return sentido === 'asc' ? -1 : 1
      if (a[campo] > b[campo]) return sentido === 'asc' ? 1 : -1
    }
    return 0
  })
}

/** Como Prisma: aplica los campos y sube `updatedAt` (un milisegundo basta para que «la fila cambió» se note). */
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

function buscarVarias({ where, orderBy, distinct, skip, take, select }: Fila): Fila[] {
  let filas = ordenar(
    mundo.cfdis.filter(c => cumple(c, where)),
    orderBy,
  )
  if (distinct) {
    const vistos = new Set<string>()
    filas = filas.filter(c => {
      const llave = distinct.map((campo: string) => c[campo]).join('|')
      if (vistos.has(llave)) return false
      vistos.add(llave)
      return true
    })
  }
  return filas.slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take).map(c => elegir(c, select))
}

let pac: {
  createInvoice: jest.Mock
  getInvoice: jest.Mock
  findByExternalId: jest.Mock
  getCancellationStatus: jest.Mock
  sendInvoiceByEmail: jest.Mock
}

function instalarElDoble() {
  const ocurrencias = prismaMock.platformChargeOccurrence
  ocurrencias.findUnique.mockImplementation(async ({ where, select, include }: Fila) => {
    if (where.id !== mundo.occ.id) return null
    if (select) return elegir(mundo.occ, select)
    const out: Fila = { ...mundo.occ }
    if (include?.charge) out.charge = elegir(mundo.charge, include.charge.select)
    if (include?.invoices) {
      out.invoices = buscarVarias({ ...include.invoices, where: { platformChargeOccurrenceId: mundo.occ.id } })
    }
    return out
  })
  ocurrencias.update.mockImplementation(async ({ data }: Fila) => ({ ...aplicar(mundo.occ, data) }))
  prismaMock.platformCharge.findUnique.mockImplementation(async ({ where, select }: Fila) =>
    where.id === mundo.charge.id ? elegir(mundo.charge, select) : null,
  )
  prismaMock.platformCharge.update.mockImplementation(async ({ data }: Fila) => ({ ...Object.assign(mundo.charge, data) }))

  const cfdis = prismaMock.platformCfdi
  cfdis.findUnique.mockImplementation(async ({ where, select }: Fila) => {
    const row = mundo.cfdis.find(c => (where.id ? c.id === where.id : c.idempotencyKey === where.idempotencyKey))
    return row ? elegir(row, select) : null
  })
  cfdis.findFirst.mockImplementation(async ({ where, orderBy, select }: Fila) => {
    const [row] = ordenar(
      mundo.cfdis.filter(c => cumple(c, where)),
      orderBy,
    )
    return row ? elegir(row, select) : null
  })
  cfdis.findMany.mockImplementation(async (args: Fila) => buscarVarias(args))
  cfdis.count.mockImplementation(async ({ where }: Fila) => mundo.cfdis.filter(c => cumple(c, where)).length)
  cfdis.update.mockImplementation(async ({ where, data }: Fila) => {
    const row = mundo.cfdis.find(c => c.id === where.id)
    if (!row) throw new Error('P2025: la fila ya no existe')
    return { ...aplicar(row, data) }
  })
  cfdis.updateMany.mockImplementation(async ({ where, data }: Fila) => {
    ganchos.antesDeTomarla?.()
    const tocadas = mundo.cfdis.filter(c => cumple(c, where))
    for (const c of tocadas) aplicar(c, data)
    return { count: tocadas.length }
  })
  cfdis.create.mockImplementation(async ({ data }: Fila) => {
    const row = factura({ id: `cfdi-nueva-${mundo.cfdis.length + 1}`, ...data, createdAt: AHORA, updatedAt: AHORA })
    mundo.cfdis.push(row)
    return { ...row }
  })
  cfdis.delete.mockImplementation(async ({ where }: Fila) => {
    const index = mundo.cfdis.findIndex(c => c.id === where.id)
    return mundo.cfdis.splice(index, 1)[0]
  })

  prismaMock.billingTaxProfile.findUnique.mockImplementation(async ({ where, select }: Fila) => {
    const perfil = mundo.perfiles.find(p => cumple(p, where))
    return perfil ? elegir(perfil, select) : null
  })
  const emisor = { id: 'em1', provider: 'FACTURAPI', providerKeyEnc: 'enc-key', csdStatus: 'ACTIVE', serie: 'A', defaultUsoCfdi: null }
  prismaMock.platformEmisor.findFirst.mockResolvedValue(emisor)
  prismaMock.platformEmisor.findUnique.mockResolvedValue(emisor)
  prismaMock.$queryRaw.mockImplementation(async () => [{ id: 'cobro-1' }])
  prismaMock.$transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock))
  mockResolve.mockReturnValue(pac)
  mockPerfilPorCliente.mockImplementation(async (customerType: string, id: string) => {
    const campo = customerType === 'ORGANIZATION' ? 'organizationId' : 'venueId'
    return mundo.perfiles.find(p => p[campo] === id) ?? null
  })
}

beforeEach(() => {
  mundo = nuevoMundo()
  delete ganchos.antesDeTomarla
  pac = {
    createInvoice: jest.fn(),
    getInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    getCancellationStatus: jest.fn(),
    sendInvoiceByEmail: jest.fn().mockResolvedValue(undefined),
  }
  instalarElDoble()
})

/** Anota en orden cada paso que importa, para afirmar qué corre dentro del candado y qué fuera. Se llama DESPUÉS de instalar los dobles. */
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
  anotar(prismaMock.platformCfdi.updateMany, 'tomar la factura')
  anotar(prismaMock.platformCfdi.update, 'soltar la factura')
  anotar(prismaMock.platformChargeOccurrence.update, 'escribir la fecha')
  anotar(prismaMock.platformCharge.update, 'escribir el cobro')
  anotar(pac.findByExternalId, 'preguntar al PAC')
  mockLogAction.mockImplementation(() => {
    eventos.push('bitácora')
  })
  const transaccion = prismaMock.$transaction.getMockImplementation()
  prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    eventos.push('tx:inicio')
    try {
      return await transaccion(callback)
    } finally {
      eventos.push('tx:fin')
    }
  })
  return eventos
}

const nadieEscribio = () => {
  expect(prismaMock.platformCfdi.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.platformCfdi.update).not.toHaveBeenCalled()
  expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
  expect(mockLogAction).not.toHaveBeenCalled()
}
const nadieTimbro = () => {
  expect(pac.createInvoice).not.toHaveBeenCalled()
  expect(prismaMock.platformCfdi.create).not.toHaveBeenCalled()
}

async function rechazo(promesa: Promise<unknown>): Promise<ConflictError> {
  const error = await promesa.then(
    () => {
      throw new Error('se esperaba un rechazo y pasó')
    },
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ConflictError)
  expect((error as ConflictError).statusCode).toBe(409)
  return error as ConflictError
}

const anexar = (cfdiId = 'cfdi-19') => linkInvoice('occ-1', { cfdiId }, 'staff-1', AHORA)
const queNoSeAnexo = (id = 'cfdi-19') => {
  const row = mundo.cfdis.find(c => c.id === id)
  expect(row).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
  expect(mundo.occ).toMatchObject({ ...TOTALES_DEL_COBRO, concepts: CONCEPTOS_DEL_COBRO, invoiceMode: 'AUTOMATIC' })
  expect(mockLogAction).not.toHaveBeenCalled()
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('conceptsFromInvoice — una factura sólo se vuelve conceptos si cabe en el modelo del 16 % de «Por cobrar»', () => {
  it('sin IVA: el monto es cantidad × precio, con sus claves del SAT, y recalcula exactamente sus totales', () => {
    expect(conceptsFromInvoice(factura() as never)).toEqual(CONCEPTOS_A19)
  })

  it('con taxIncluded el concepto es WITH_IVA: $10,000 con IVA recalculan 862069 + 137931', () => {
    const conceptos = conceptsFromInvoice(
      factura({
        lines: [{ description: 'Tableta', quantity: 1, unitPriceCents: 1_000_000, taxRate: 0.16, taxIncluded: true, ...SAT }],
        subtotalCents: 862069,
        taxCents: 137931,
        totalCents: 1_000_000,
      }) as never,
    )

    expect(conceptos).toEqual([{ description: 'Tableta', amountCents: 1_000_000, ivaMode: 'WITH_IVA', ...SAT }])
  })

  it('una cantidad con decimales sirve si da centavos enteros: 1.5 × $10 = $15', () => {
    const conceptos = conceptsFromInvoice(
      factura({
        lines: [{ description: 'Horas', quantity: 1.5, unitPriceCents: 1000, ...SAT }],
        subtotalCents: 1500,
        taxCents: 240,
        totalCents: 1740,
      }) as never,
    )

    expect(conceptos).toEqual([{ description: 'Horas', amountCents: 1500, ivaMode: 'WITHOUT_IVA', ...SAT }])
  })

  // 🔴 Codex r1, hallazgo 3: resumirla la volvería a timbrar mal al quitarla o cancelarla.
  it.each([
    [
      'un renglón exento ($100 exentos no pueden salir como $86.21 + $13.79 de IVA)',
      {
        lines: [{ description: 'Curso', quantity: 1, unitPriceCents: 10000, taxExempt: true, ...SAT }],
        subtotalCents: 10000,
        taxCents: 0,
        totalCents: 10000,
      },
    ],
    [
      'otra tasa de IVA',
      {
        lines: [{ description: 'Frontera', quantity: 1, unitPriceCents: 10000, taxRate: 0.08, ...SAT }],
        subtotalCents: 10000,
        taxCents: 800,
        totalCents: 10800,
      },
    ],
    [
      'tasa 0 %',
      {
        lines: [{ description: 'Exportación', quantity: 1, unitPriceCents: 10000, taxRate: 0, ...SAT }],
        subtotalCents: 10000,
        taxCents: 0,
        totalCents: 10000,
      },
    ],
    [
      'un descuento en un renglón',
      {
        lines: [{ description: 'Promo', quantity: 1, unitPriceCents: 10000, discountCents: 1000, ...SAT }],
        subtotalCents: 10000,
        discountCents: 1000,
        taxCents: 1440,
        totalCents: 10440,
      },
    ],
    ['un descuento sólo en la cabecera', { discountCents: 1000 }],
    // Los tres que siguen cuadrarían si el renglón se leyera al 16 %: lo que los detiene es su propia regla, no los totales.
    [
      'un renglón exento, aunque los totales cuadraran al 16 %',
      { lines: [{ description: 'Curso', quantity: 1, unitPriceCents: 150000, taxExempt: true, ...SAT }] },
    ],
    [
      'otra tasa, aunque los totales cuadraran al 16 %',
      { lines: [{ description: 'Frontera', quantity: 1, unitPriceCents: 150000, taxRate: 0.08, ...SAT }] },
    ],
    [
      'un descuento en el renglón, aunque los totales cuadraran sin él',
      { lines: [{ description: 'Promo', quantity: 1, unitPriceCents: 150000, discountCents: 1000, ...SAT }] },
    ],
    [
      'cantidad × precio que no da centavos enteros (1.5 × $9.99)',
      {
        lines: [{ description: 'Horas', quantity: 1.5, unitPriceCents: 999, ...SAT }],
        subtotalCents: 1499,
        taxCents: 240,
        totalCents: 1739,
      },
    ],
    ['totales que no recalculan: un centavo de más en el total', { totalCents: 174001 }],
    ['totales que no recalculan: un centavo movido del subtotal al IVA', { subtotalCents: 149999, taxCents: 24001 }],
    [
      'IVA redondeado renglón por renglón, como lo hace «Nueva factura»: 2 × 3 centavos dan IVA 0 aquí y 1 en el modelo',
      {
        lines: [
          { description: 'A', quantity: 1, unitPriceCents: 3, ...SAT },
          { description: 'B', quantity: 1, unitPriceCents: 3, ...SAT },
        ],
        subtotalCents: 6,
        taxCents: 0,
        totalCents: 6,
      },
    ],
    ['sin renglones', { lines: [] }],
    ['renglones que no son una lista', { lines: null }],
    [
      'más conceptos de los que acepta un cobro (21)',
      {
        lines: Array.from({ length: 21 }, () => ({ description: 'x', quantity: 1, unitPriceCents: 100, ...SAT })),
        subtotalCents: 2100,
        taxCents: 336,
        totalCents: 2436,
      },
    ],
    [
      'un renglón mayor al tope de un concepto ($9,999,999.99)',
      {
        lines: [{ description: 'x', quantity: 1, unitPriceCents: 1_000_000_000, ...SAT }],
        subtotalCents: 1_000_000_000,
        taxCents: 160_000_000,
        totalCents: 1_160_000_000,
      },
    ],
    [
      'un renglón en cero (un concepto siempre es mayor a $0)',
      { lines: [{ description: 'x', quantity: 1, unitPriceCents: 0, ...SAT }], subtotalCents: 0, taxCents: 0, totalCents: 0 },
    ],
  ])('devuelve null con %s', (_caso, over) => {
    expect(conceptsFromInvoice(factura(over) as never)).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('linkInvoice — anexar a una fecha sin pagar', () => {
  beforeEach(() => {
    mundo.cfdis = [factura()]
  })

  it('la factura queda ligada y marcada; la fecha toma sus conceptos y totales; la vista lo enseña', async () => {
    const vista = await anexar()

    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1', chargeLinkedAt: AHORA, status: 'STAMPED' })
    expect(mundo.occ).toMatchObject({ concepts: CONCEPTOS_A19, ...TOTALES_A19, status: 'PENDING' })
    expect(vista).toMatchObject({
      id: 'occ-1',
      ...TOTALES_A19,
      concepts: CONCEPTOS_A19,
      invoiceMode: 'MANUAL',
      status: 'PENDING',
      invoice: { id: 'cfdi-19', status: 'STAMPED', serie: 'A', folio: '19', linked: true, metodoPago: 'PUE' },
    })
  })

  it.each([
    ['AUTOMATIC', 'MANUAL'],
    ['NONE', 'MANUAL'],
    ['MANUAL', 'MANUAL'],
  ])('modo %s de la fecha queda en %s: deshacer el vínculo no timbra solo ni lo esconde', async (antes, despues) => {
    mundo.occ.invoiceMode = antes

    await anexar()

    expect(mundo.occ.invoiceMode).toBe(despues)
  })

  it('el modo y los conceptos del COBRO recurrente no se tocan: el vínculo es de esta fecha', async () => {
    await anexar()

    expect(mundo.charge).toMatchObject({ invoiceMode: 'AUTOMATIC', concepts: CONCEPTOS_DEL_COBRO })
    expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
  })

  describe('🔴 una sola vez: el cobro se alinea con su única fecha (Codex r2, hallazgo 5)', () => {
    beforeEach(() => {
      mundo.charge.frequency = 'ONE_TIME'
    })

    it('anexar escribe en el cobro los conceptos y el modo que quedaron en la fecha, dentro del candado y antes de la bitácora', async () => {
      const eventos = trazar()

      await anexar()

      expect(prismaMock.platformCharge.update).toHaveBeenCalledTimes(1)
      expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({
        where: { id: 'cobro-1' },
        data: { concepts: CONCEPTOS_A19, invoiceMode: 'MANUAL' },
      })
      expect(mundo.charge).toMatchObject({ concepts: CONCEPTOS_A19, invoiceMode: 'MANUAL' })
      expect(mundo.occ).toMatchObject({ concepts: CONCEPTOS_A19, invoiceMode: 'MANUAL', ...TOTALES_A19 })
      expect(eventos).toEqual(['tx:inicio', 'candado', 'tomar la factura', 'escribir la fecha', 'escribir el cobro', 'tx:fin', 'bitácora'])
    })

    it('quitar no cambia nada más: la fecha y el cobro ya quedaron iguales', async () => {
      await anexar()
      prismaMock.platformCharge.update.mockClear()
      prismaMock.platformChargeOccurrence.update.mockClear()

      await unlinkInvoice('occ-1', { cfdiId: 'cfdi-19' }, 'staff-1', AHORA)

      expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
      expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
      expect(mundo.charge).toMatchObject({ concepts: mundo.occ.concepts, invoiceMode: mundo.occ.invoiceMode })
    })

    it('si el cobro ya dice lo mismo que la fecha, no escribe', async () => {
      Object.assign(mundo.charge, { concepts: CONCEPTOS_A19.map(c => ({ ...c })), invoiceMode: 'MANUAL' })

      await anexar()

      expect(prismaMock.platformChargeOccurrence.update).toHaveBeenCalledTimes(1)
      expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
    })

    it('en una fecha pagada (sus números no cambian) el modo del cobro también pasa a MANUAL, con los conceptos de la fecha', async () => {
      Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), totalCents: TOTALES_A19.totalCents })

      await anexar()

      expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({
        where: { id: 'cobro-1' },
        data: { concepts: CONCEPTOS_DEL_COBRO, invoiceMode: 'MANUAL' },
      })
      expect(mundo.charge.invoiceMode).toBe('MANUAL')
    })

    it('si la fecha no cambió y ya estaba igual (pagada y ya MANUAL), no escribe ni en la fecha ni en el cobro', async () => {
      Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), totalCents: TOTALES_A19.totalCents, invoiceMode: 'MANUAL' })
      mundo.charge.invoiceMode = 'MANUAL'

      await anexar()

      expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
      expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
    })

    it('una anexada que se rechaza no deja el cobro a medias: no se escribe nada', async () => {
      mundo.cfdis = [factura({ discountCents: 100 })]

      await rechazo(anexar())

      expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
      expect(mundo.charge).toMatchObject({ concepts: CONCEPTOS_DEL_COBRO, invoiceMode: 'AUTOMATIC' })
    })

    it('«Deshacer» el vínculo y editar sólo la fecha del cobro: cobro y fecha siguen diciendo lo mismo', async () => {
      await anexar()
      await unlinkInvoice('occ-1', { cfdiId: 'cfdi-19' }, 'staff-1', AHORA)

      expect(mundo.charge.concepts).toEqual(mundo.occ.concepts)
      expect(mundo.charge.invoiceMode).toBe(mundo.occ.invoiceMode)
    })
  })

  it('deja la bitácora PLATFORM_CHARGE_INVOICE_LINKED del cobro, con quién, qué factura y cómo cambió el monto', async () => {
    await anexar()

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-1',
      venueId: null,
      organizationId: 'org-1',
      action: 'PLATFORM_CHARGE_INVOICE_LINKED',
      entity: 'PlatformCharge',
      entityId: 'cobro-1',
      data: {
        occurrenceId: 'occ-1',
        dueDate: '2026-11-01',
        platformCfdiId: 'cfdi-19',
        uuid: 'UUID-19',
        serie: 'A',
        folio: '19',
        previousTotalCents: 58000,
        totalCents: 174000,
        invoiceMode: 'MANUAL',
      },
    })
  })

  it('todo corre bajo el candado del cobro y la bitácora va DESPUÉS, fuera de la transacción', async () => {
    const eventos = trazar()

    await anexar()

    expect(eventos).toEqual(['tx:inicio', 'candado', 'tomar la factura', 'escribir la fecha', 'tx:fin', 'bitácora'])
    expect(prismaMock.$queryRaw.mock.calls[0][1]).toBe('cobro-1')
  })

  it('repetir la misma: éxito sin escribir ni registrar', async () => {
    mundo.cfdis = [anexada()]
    mundo.occ.invoiceMode = 'MANUAL'

    const vista = await anexar()

    nadieEscribio()
    expect(vista).toMatchObject({ invoice: { id: 'cfdi-19', linked: true } })
  })

  it('una factura que no existe es 404; una fecha que no existe también', async () => {
    await expect(anexar('no-existe')).rejects.toBeInstanceOf(NotFoundError)
    await expect(linkInvoice('no-existe', { cfdiId: 'cfdi-19' }, 'staff-1', AHORA)).rejects.toBeInstanceOf(NotFoundError)
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('decide con la fecha RELEÍDA bajo el candado: si otra pestaña la omitió mientras se resolvía el intento, es 409', async () => {
    const original = prismaMock.$queryRaw.getMockImplementation()
    prismaMock.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      mundo.occ.status = 'SKIPPED' // cae justo antes de tomar el candado
      return original(...args)
    })

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_SKIPPED')
  })
})

describe('linkInvoice — el intento de factura se resuelve FUERA del candado, como en invoiceOccurrence', () => {
  /** Un intento viejo de esta fecha que no se sabe en qué quedó: hay que preguntarle al PAC. */
  const enDuda = () =>
    timbradaDeAqui({ status: 'STAMP_FAILED', facturapiId: null, uuid: null, folio: null, createdAt: hace(10), updatedAt: hace(10) })

  beforeEach(() => {
    mundo.occ.status = 'PAID'
    mundo.occ.paidAt = hace(30)
    mundo.occ.totalCents = TOTALES_A19.totalCents
    mundo.cfdis = [factura(), enDuda()]
  })

  it('primero le pregunta al PAC y después toma el candado para anexar; si no hay nada, el intento se cierra y la factura entra', async () => {
    pac.findByExternalId.mockResolvedValue(null)
    const eventos = trazar()

    await anexar()

    expect(eventos.indexOf('preguntar al PAC')).toBeLessThan(eventos.indexOf('candado'))
    expect(eventos.lastIndexOf('tx:fin')).toBeGreaterThan(eventos.indexOf('tomar la factura'))
    expect(mundo.cfdis.find(c => c.id === 'cfdi-19')).toMatchObject({ platformChargeOccurrenceId: 'occ-1', chargeLinkedAt: AHORA })
    expect(mundo.occ.invoiceSeq).toBe(1)
  })

  it('si el PAC dice que SÍ se timbró, la adopta y la fecha ya tiene viva: 409 y no se anexa', async () => {
    pac.findByExternalId.mockResolvedValue({
      providerInvoiceId: 'fa-118',
      uuid: 'UUID-118',
      serie: 'A',
      folio: '118',
      totalCents: 174000,
      stampedAt: AHORA,
      status: 'valid',
    })

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE')
    expect(error.message).toContain('A-118')
    expect(mundo.cfdis.find(c => c.id === 'cfdi-19')).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
  })

  it('si el PAC no contesta, su 409 sale tal cual y no se anexa nada', async () => {
    pac.findByExternalId.mockRejectedValue(new Error('ETIMEDOUT'))

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_UNCONFIRMED')
    expect(mundo.cfdis.find(c => c.id === 'cfdi-19')).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
  })

  it('un timbrado recién empezado es 409 «se está timbrando» sin preguntar al PAC y sin anexar', async () => {
    mundo.cfdis = [
      factura(),
      timbradaDeAqui({ status: 'STAMPING', facturapiId: null, uuid: null, createdAt: new Date(), updatedAt: new Date() }),
    ]

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_STAMPING')
    expect(pac.findByExternalId).not.toHaveBeenCalled()
  })
})

describe('linkInvoice — qué factura se puede anexar', () => {
  it('de otro cobro (ya ligada a otra fecha): PLATFORM_CHARGE_INVOICE_LINK_TAKEN', async () => {
    mundo.cfdis = [factura({ platformChargeOccurrenceId: 'occ-de-otro', chargeLinkedAt: hace(5) })]

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_TAKEN')
    expect(error.message).toContain('A-19')
    expect(mundo.cfdis[0].platformChargeOccurrenceId).toBe('occ-de-otro')
    nadieEscribio()
  })

  it('timbrada desde «Por cobrar» para otra fecha también es de otro cobro', async () => {
    mundo.cfdis = [factura({ platformChargeOccurrenceId: 'occ-de-otro', chargeLinkedAt: null })]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_TAKEN')
  })

  it.each(['CANCELLED', 'CANCEL_REQUESTED', 'STAMPING', 'STAMP_FAILED', 'DRAFT'])(
    'estado %s: PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED',
    async status => {
      mundo.cfdis = [factura({ status })]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED')
      nadieEscribio()
    },
  )

  it('un complemento de pago (type PAGO) no es una factura de ingreso: PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED', async () => {
    mundo.cfdis = [factura({ type: 'PAGO' })]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED')
    nadieEscribio()
  })

  it('una fila vieja «timbrada» sin UUID no está timbrada de verdad, y atada a una fecha ya nadie podría consultarla', async () => {
    mundo.cfdis = [factura({ uuid: null })]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED')
    nadieEscribio()
  })

  it('una anexada a esta fecha que ya se canceló no es «repetir»: NOT_STAMPED, no un éxito falso', async () => {
    mundo.cfdis = [anexada({ status: 'CANCELLED' })]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED')
  })

  it('la timbrada desde aquí para esta misma fecha no se puede «anexar»: HAS_LIVE, nunca la marca de anexada', async () => {
    mundo.occ.status = 'PAID'
    mundo.occ.totalCents = TOTALES_A19.totalCents
    mundo.occ.invoiceSeq = 7 // su llave ya no es la del intento actual: la encuentra la lectura bajo el candado, no `resolverIntento`
    mundo.cfdis = [timbradaDeAqui()]

    const error = await rechazo(anexar('cfdi-118'))

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE')
    expect(mundo.cfdis[0].chargeLinkedAt).toBeNull()
    nadieEscribio()
  })
})

describe('linkInvoice — de qué cliente es', () => {
  const OTRO_RFC = 'OTR010101AAA'

  it('org distinta y RFC distinto: PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER, sin escribir nada', async () => {
    mundo.cfdis = [factura({ organizationId: 'org-2', receptorRfc: OTRO_RFC })]

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER')
    expect(error.message).toContain(OTRO_RFC)
    nadieEscribio()
  })

  it('misma organización, aunque el RFC sea otro (cambió de razón social): pasa', async () => {
    mundo.cfdis = [factura({ receptorRfc: OTRO_RFC })]

    await anexar()

    expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
  })

  it('otra organización, con el RFC del perfil del cobro: pasa', async () => {
    mundo.cfdis = [factura({ organizationId: 'org-2' })]

    await anexar()

    expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
  })

  it('sin perfil en el cobro se compara con el perfil del cliente, igual que al facturar', async () => {
    mundo.charge.billingTaxProfileId = null
    mundo.cfdis = [factura({ organizationId: 'org-2' })]

    await anexar()

    expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
  })

  it('una organización sin ningún perfil y una factura de otra: no tiene con qué probarse, OTHER_CUSTOMER', async () => {
    mundo.charge.billingTaxProfileId = null
    mundo.perfiles = []
    mundo.cfdis = [factura({ organizationId: 'org-2' })]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER')
  })

  describe('un negocio', () => {
    beforeEach(() => {
      Object.assign(mundo.charge, { customerType: 'VENUE', organizationId: null, venueId: 'venue-1', billingTaxProfileId: null })
      mundo.perfiles = []
    })

    it('el mismo negocio: pasa', async () => {
      mundo.cfdis = [factura({ organizationId: null, venueId: 'venue-1', receptorRfc: OTRO_RFC })]

      await anexar()

      expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
    })

    it('otro negocio con otro RFC: OTHER_CUSTOMER', async () => {
      mundo.cfdis = [factura({ organizationId: null, venueId: 'venue-2', receptorRfc: OTRO_RFC })]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER')
    })

    it('una factura sin negocio no coincide con el negocio del cobro por tener los dos un id vacío', async () => {
      mundo.cfdis = [factura({ organizationId: null, venueId: null, receptorRfc: OTRO_RFC })]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER')
    })
  })

  describe('un cliente externo', () => {
    beforeEach(() => {
      Object.assign(mundo.charge, { customerType: 'STANDALONE', organizationId: null, venueId: null, billingTaxProfileId: null })
    })

    it('sin perfil no tiene con qué compararse: pasa (la pantalla enseña nombre y RFC antes de confirmar)', async () => {
      mundo.cfdis = [factura({ organizationId: null, receptorRfc: OTRO_RFC })]

      await anexar()

      expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
    })

    it('con perfil y el mismo RFC: pasa', async () => {
      mundo.charge.billingTaxProfileId = 'perfil-1'
      mundo.cfdis = [factura({ organizationId: null })]

      await anexar()

      expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
    })

    it('con perfil y otro RFC: OTHER_CUSTOMER, aunque los dos tengan la organización vacía', async () => {
      mundo.charge.billingTaxProfileId = 'perfil-1'
      mundo.cfdis = [factura({ organizationId: null, receptorRfc: OTRO_RFC })]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER')
    })
  })
})

describe('linkInvoice — a qué fecha', () => {
  it('omitida: PLATFORM_CHARGE_INVOICE_LINK_SKIPPED', async () => {
    mundo.occ.status = 'SKIPPED'
    mundo.cfdis = [factura()]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_SKIPPED')
    nadieEscribio()
  })

  describe('🔴 con una factura viva, ligada o por llave: PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE', () => {
    it.each(['STAMPED', 'CANCEL_REQUESTED'])('la del intento actual, %s (la encuentra resolverIntento)', async status => {
      mundo.cfdis = [factura(), timbradaDeAqui({ status })]

      const error = await rechazo(anexar())

      expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE')
      expect(error.message).toContain('A-118')
      queNoSeAnexo()
    })

    it.each(['STAMPED', 'CANCEL_REQUESTED', 'STAMPING'])('otra anexada a esta fecha, %s', async status => {
      mundo.cfdis = [factura(), anexada({ id: 'cfdi-18', folio: '18', status, idempotencyKey: 'otra' })]

      const error = await rechazo(anexar())

      expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE')
      expect(error.message).toContain('A-18')
      queNoSeAnexo()
    })

    it('una fila viva con la llave del intento que perdió su vínculo también cuenta («ligada o por llave»)', async () => {
      const reservada = timbradaDeAqui({ platformChargeOccurrenceId: null, status: 'STAMPING', createdAt: AHORA, updatedAt: AHORA })
      // La reservan justo después de que `resolverIntento` dijera que no había nada: la encuentra la lectura bajo el candado.
      const original = prismaMock.$queryRaw.getMockImplementation()
      prismaMock.$queryRaw.mockImplementation(async (...args: unknown[]) => {
        if (!mundo.cfdis.includes(reservada)) mundo.cfdis.push(reservada)
        return original(...args)
      })
      mundo.cfdis = [factura()]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE')
      queNoSeAnexo()
    })

    it('Facturar reservó entre resolverIntento y el candado: una sola gana y ésta recibe el 409', async () => {
      const original = prismaMock.$queryRaw.getMockImplementation()
      prismaMock.$queryRaw.mockImplementation(async (...args: unknown[]) => {
        if (mundo.cfdis.length === 1) mundo.cfdis.push(timbradaDeAqui({ status: 'STAMPING', facturapiId: null, uuid: null }))
        return original(...args)
      })
      mundo.cfdis = [factura()]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE')
      queNoSeAnexo()
    })
  })

  it('una anexada cancelada o un intento fallido viejo no estorban: la fecha está libre', async () => {
    mundo.occ.invoiceSeq = 2
    mundo.cfdis = [
      factura(),
      anexada({ id: 'cfdi-18', folio: '18', status: 'CANCELLED', idempotencyKey: 'otra' }),
      timbradaDeAqui({ id: 'cfdi-0', status: 'STAMP_FAILED', uuid: null, idempotencyKey: 'por-cobrar:occ-1:0' }),
    ]

    await anexar()

    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1', chargeLinkedAt: AHORA })
  })

  describe('🔴 ya pagada: lo cobrado no se reescribe', () => {
    beforeEach(() => {
      Object.assign(mundo.occ, {
        status: 'PAID',
        paidAt: hace(30),
        paidById: 'staff-0',
        totalCents: TOTALES_A19.totalCents,
        subtotalCents: 1,
        taxCents: 2,
      })
    })

    it('con el mismo total anexa sin tocar números: conceptos, subtotal, IVA y total son los de la fila; el modo sí pasa a MANUAL', async () => {
      mundo.cfdis = [factura()]

      await anexar()

      expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1', chargeLinkedAt: AHORA })
      expect(mundo.occ).toMatchObject({
        concepts: CONCEPTOS_DEL_COBRO,
        subtotalCents: 1,
        taxCents: 2,
        totalCents: TOTALES_A19.totalCents,
        status: 'PAID',
        invoiceMode: 'MANUAL',
      })
      expect(prismaMock.platformChargeOccurrence.update.mock.calls[0][0].data).toEqual({ invoiceMode: 'MANUAL' })
    })

    it('ya en MANUAL no hay nada que escribir en la fecha', async () => {
      mundo.occ.invoiceMode = 'MANUAL'
      mundo.cfdis = [factura()]

      await anexar()

      expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
      expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
      expect(mockLogAction).toHaveBeenCalledTimes(1)
    })

    it('con otro total: PLATFORM_CHARGE_INVOICE_LINK_PAID_MISMATCH, y dice los dos montos', async () => {
      mundo.occ.totalCents = 58000
      mundo.cfdis = [factura()]

      const error = await rechazo(anexar())

      expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_PAID_MISMATCH')
      expect(error.message).toContain('$580.00')
      expect(error.message).toContain('$1,740.00')
      nadieEscribio()
    })

    it('🔴 una factura que no cabe en el modelo NO se anexa ni con el mismo total (Codex r2, hallazgo 3): quitarla o cancelarla la reemitiría al 16 %', async () => {
      mundo.occ.totalCents = 10000
      mundo.cfdis = [
        factura({
          lines: [{ description: 'Curso', quantity: 1, unitPriceCents: 10000, taxExempt: true, ...SAT }],
          subtotalCents: 10000,
          taxCents: 0,
          totalCents: 10000,
        }),
      ]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE')

      expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
      nadieEscribio()
    })
  })
})

describe('linkInvoice — 🔴 la carrera: la escritura comprueba lo que se validó', () => {
  beforeEach(() => {
    mundo.cfdis = [factura()]
  })

  it('otra pestaña la tomó en otro cobro (otro candado): 0 filas y PLATFORM_CHARGE_INVOICE_LINK_TAKEN, sin tocar la fecha', async () => {
    ganchos.antesDeTomarla = () => {
      Object.assign(mundo.cfdis[0], { platformChargeOccurrenceId: 'occ-de-otro', chargeLinkedAt: hace(1) })
    }

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_TAKEN')
    expect(mundo.cfdis[0].platformChargeOccurrenceId).toBe('occ-de-otro')
    expect(mundo.occ).toMatchObject({ ...TOTALES_DEL_COBRO, invoiceMode: 'AUTOMATIC' })
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('«Facturas CFDI» pidió cancelarla (no toma el candado del cobro): 0 filas y PLATFORM_CHARGE_INVOICE_LINK_CHANGED', async () => {
    ganchos.antesDeTomarla = () => {
      mundo.cfdis[0].status = 'CANCEL_REQUESTED' // cambia el estado y deja `updatedAt` igual: lo que la frena es la condición de estado
    }

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_CHANGED')
    expect(mundo.cfdis[0]).toMatchObject({ status: 'CANCEL_REQUESTED', platformChargeOccurrenceId: null, chargeLinkedAt: null })
    expect(mundo.occ).toMatchObject({ ...TOTALES_DEL_COBRO, invoiceMode: 'AUTOMATIC' })
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('la fila se escribió aunque conserve su estado (se fue a CANCEL_REQUESTED y volvió): por updatedAt, PLATFORM_CHARGE_INVOICE_LINK_CHANGED', async () => {
    ganchos.antesDeTomarla = () => {
      mundo.cfdis[0].updatedAt = new Date(mundo.cfdis[0].updatedAt.getTime() + 5)
    }

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_CHANGED')
    expect(mundo.occ).toMatchObject({ ...TOTALES_DEL_COBRO, invoiceMode: 'AUTOMATIC' })
  })

  it('la factura que desaparece en medio tampoco se da por anexada', async () => {
    ganchos.antesDeTomarla = () => {
      mundo.cfdis = []
    }

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_CHANGED')
  })
})

describe('linkInvoice — 🔴 una factura con pagos no hace nacer una deuda de lo que ya se cobró', () => {
  const complemento = (status: string) =>
    factura({ id: `rep-${status}`, type: 'PAGO', parentPlatformCfdiId: 'cfdi-19', status, totalCents: 0 })

  it('amountPaidCents > 0 a una fecha sin pagar: PLATFORM_CHARGE_INVOICE_LINK_HAS_PAYMENTS', async () => {
    mundo.cfdis = [factura({ metodoPago: 'PPD', amountPaidCents: 1 })]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_HAS_PAYMENTS')
    queNoSeAnexo()
  })

  it.each(['STAMPED', 'STAMPING', 'CANCEL_REQUESTED', 'DRAFT'])(
    'un complemento %s con amountPaidCents en 0 (puede estar en duda): también HAS_PAYMENTS',
    async status => {
      mundo.cfdis = [factura({ metodoPago: 'PPD' }), complemento(status)]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_HAS_PAYMENTS')
      queNoSeAnexo()
    },
  )

  it.each(['CANCELLED', 'STAMP_FAILED'])('un complemento %s no cuenta: se anexa', async status => {
    mundo.cfdis = [factura({ metodoPago: 'PPD' }), complemento(status)]

    await anexar()

    expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
  })

  it('el complemento de OTRA factura no cuenta', async () => {
    mundo.cfdis = [factura(), factura({ id: 'rep-1', type: 'PAGO', parentPlatformCfdiId: 'otra-factura' })]

    await anexar()

    expect(mundo.cfdis[0].chargeLinkedAt).toEqual(AHORA)
  })

  it('a una fecha ya PAGADA con el mismo total sí pasa, con pagos y con complementos', async () => {
    Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), totalCents: TOTALES_A19.totalCents })
    mundo.cfdis = [factura({ metodoPago: 'PPD', amountPaidCents: TOTALES_A19.totalCents }), complemento('STAMPED')]

    await anexar()

    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1', chargeLinkedAt: AHORA })
  })
})

describe('linkInvoice — 🔴 una factura que no cabe en el modelo del 16 % nunca se convierte en renglones', () => {
  /** $100 exentos: convertirlos saldrían $86.21 + $13.79 de IVA al volver a timbrar. */
  const exenta = () =>
    factura({
      lines: [{ description: 'Curso', quantity: 1, unitPriceCents: 10000, taxExempt: true, ...SAT }],
      subtotalCents: 10000,
      taxCents: 0,
      totalCents: 10000,
    })

  it('con otro total: PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE, sin escribir nada', async () => {
    mundo.cfdis = [exenta()]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE')
    queNoSeAnexo()
  })

  const MENSAJE_GENERAL =
    /no cabe en lo que «Por cobrar» sabe calcular \(IVA del 16 %, sin descuentos ni exentos, con los totales al centavo\)/

  it('🔴 el 409 no afirma una causa que puede ser falsa: dice qué sabe calcular «Por cobrar» y nada de totales que coinciden', async () => {
    mundo.cfdis = [exenta()]

    const error = await rechazo(anexar())

    expect(error.message).toMatch(MENSAJE_GENERAL)
    expect(error.message).not.toMatch(/trae un renglón exento/)
    expect(error.message).not.toMatch(/coinciden|no es el de esta fecha/)
  })

  it.each([
    [
      'más renglones que el tope de un cobro',
      () => ({
        lines: Array.from({ length: 21 }, (_, i) => ({ description: `Renglón ${i}`, quantity: 1, unitPriceCents: 100, ...SAT })),
        subtotalCents: 2100,
        taxCents: 336,
        totalCents: 2436,
      }),
    ],
    [
      'un monto fuera de rango',
      () => ({
        lines: [{ description: 'Enorme', quantity: 1, unitPriceCents: 1_000_000_000, ...SAT }],
        subtotalCents: 1_000_000_000,
        taxCents: 160_000_000,
        totalCents: 1_160_000_000,
      }),
    ],
    [
      'totales que no se recalculan',
      () => ({
        lines: [{ description: 'Curso', quantity: 1, unitPriceCents: 10000, ...SAT }],
        subtotalCents: 10000,
        taxCents: 1599, // el 16 % de 10000 es 1600
        totalCents: 11599,
      }),
    ],
  ])('con %s: el mismo código y el mismo texto general', async (_causa, campos) => {
    mundo.cfdis = [factura(campos())]

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE')
    expect(error.message).toMatch(MENSAJE_GENERAL)
    queNoSeAnexo()
  })

  it('🔴 con el mismo total también es NOT_REPRESENTABLE (Codex r2, hallazgo 3): ya no hay camino en el que la fecha conserve sus conceptos', async () => {
    Object.assign(mundo.occ, { subtotalCents: 8621, taxCents: 1379, totalCents: 10000 })
    mundo.cfdis = [exenta()]

    const error = await rechazo(anexar())

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE')
    expect(error.message).toMatch(MENSAJE_GENERAL)
    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
    expect(mundo.occ).toMatchObject({ concepts: CONCEPTOS_DEL_COBRO, invoiceMode: 'AUTOMATIC' })
    nadieEscribio()
  })

  it('con descuento y el mismo total, igual: NOT_REPRESENTABLE y no se escribe nada', async () => {
    Object.assign(mundo.occ, { subtotalCents: 9000, taxCents: 1440, totalCents: 10440 })
    mundo.cfdis = [
      factura({
        lines: [{ description: 'Promo', quantity: 1, unitPriceCents: 10000, discountCents: 1000, ...SAT }],
        subtotalCents: 10000,
        discountCents: 1000,
        taxCents: 1440,
        totalCents: 10440,
      }),
    ]

    expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE')
    nadieEscribio()
  })

  describe('🔴 se comprueba ANTES de las demás reglas de la fecha, también en una fecha pagada', () => {
    it('en una fecha pagada con otro total: NOT_REPRESENTABLE, no PAID_MISMATCH', async () => {
      Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), paidById: 'staff-0', totalCents: 58000 })
      mundo.cfdis = [exenta()]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE')
      nadieEscribio()
    })

    it('con pagos en una fecha sin pagar: NOT_REPRESENTABLE, no HAS_PAYMENTS', async () => {
      mundo.cfdis = [{ ...exenta(), metodoPago: 'PPD', amountPaidCents: 100 }]

      expect((await rechazo(anexar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE')
      nadieEscribio()
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('attachInvoiceInTx — anexar dentro de una transacción ajena (el alta de un cobro desde una factura)', () => {
  it('usa el tx que le dan: no abre otra transacción, no toma el candado y no registra; devuelve la fecha ya con los números', async () => {
    mundo.cfdis = [factura()]

    const fecha = await attachInvoiceInTx(prismaMock, mundo.occ as never, mundo.cfdis[0] as never, AHORA)

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
    expect(fecha).toMatchObject({ id: 'occ-1', concepts: CONCEPTOS_A19, ...TOTALES_A19, invoiceMode: 'MANUAL' })
    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1', chargeLinkedAt: AHORA })
  })

  it('si ya es la anexada de esta fecha devuelve null: no hay nada que escribir', async () => {
    mundo.cfdis = [anexada()]

    await expect(attachInvoiceInTx(prismaMock, mundo.occ as never, mundo.cfdis[0] as never, AHORA)).resolves.toBeNull()

    nadieEscribio()
  })

  it.each([
    ['otro cliente', { organizationId: 'org-2', receptorRfc: 'OTR010101AAA' }, 'PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER'],
    ['con complementos', { amountPaidCents: 5 }, 'PLATFORM_CHARGE_INVOICE_LINK_HAS_PAYMENTS'],
    ['ya tomada', { platformChargeOccurrenceId: 'occ-de-otro' }, 'PLATFORM_CHARGE_INVOICE_LINK_TAKEN'],
    ['sin timbrar', { status: 'STAMPING' }, 'PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED'],
    ['sin conversión', { discountCents: 100 }, 'PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE'],
  ])('%s: el mismo 409, para que quien llama deshaga su transacción', async (_caso, over, codigo) => {
    mundo.cfdis = [factura(over)]

    const error = await rechazo(attachInvoiceInTx(prismaMock, mundo.occ as never, mundo.cfdis[0] as never, AHORA))

    expect(error.code).toBe(codigo)
    nadieEscribio()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('unlinkInvoice — quitar lo anexado', () => {
  /** Siempre con la factura que el operador confirmó (Codex r2, hallazgo 2). */
  const quitar = (cfdiId = 'cfdi-19') => unlinkInvoice('occ-1', { cfdiId }, 'staff-1', AHORA)

  it('suelta el vínculo y la marca; la fecha conserva sus números y su modo', async () => {
    Object.assign(mundo.occ, { concepts: CONCEPTOS_A19, ...TOTALES_A19, invoiceMode: 'MANUAL' })
    mundo.cfdis = [anexada()]

    const vista = await quitar()

    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null, status: 'STAMPED', uuid: 'UUID-19' })
    expect(mundo.occ).toMatchObject({ concepts: CONCEPTOS_A19, ...TOTALES_A19, invoiceMode: 'MANUAL' })
    expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
    expect(vista).toMatchObject({ id: 'occ-1', ...TOTALES_A19, invoice: null })
  })

  it('deja la bitácora PLATFORM_CHARGE_INVOICE_UNLINKED, DESPUÉS y fuera del candado', async () => {
    mundo.cfdis = [anexada()]
    const eventos = trazar()

    await quitar()

    // `updateMany`: quitar es una escritura condicional por estado y versión, la misma que usa anexar.
    expect(eventos).toEqual(['tx:inicio', 'candado', 'tomar la factura', 'tx:fin', 'bitácora'])
    expect(mockLogAction).toHaveBeenCalledWith({
      staffId: 'staff-1',
      venueId: null,
      organizationId: 'org-1',
      action: 'PLATFORM_CHARGE_INVOICE_UNLINKED',
      entity: 'PlatformCharge',
      entityId: 'cobro-1',
      data: {
        occurrenceId: 'occ-1',
        dueDate: '2026-11-01',
        platformCfdiId: 'cfdi-19',
        uuid: 'UUID-19',
        serie: 'A',
        folio: '19',
        status: 'STAMPED',
      },
    })
  })

  it('🔴 una factura timbrada desde «Por cobrar» NUNCA se quita: PLATFORM_CHARGE_INVOICE_NOT_LINKED', async () => {
    mundo.cfdis = [timbradaDeAqui()]

    const error = await rechazo(quitar('cfdi-118'))

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_NOT_LINKED')
    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1', status: 'STAMPED' })
    nadieEscribio()
  })

  it('sin factura también es PLATFORM_CHARGE_INVOICE_NOT_LINKED', async () => {
    expect((await rechazo(quitar())).code).toBe('PLATFORM_CHARGE_INVOICE_NOT_LINKED')
  })

  it('🔴 quita SÓLO la factura confirmada: con otra anexada a la misma fecha (más nueva o viva), la que no se pidió se queda', async () => {
    mundo.cfdis = [
      anexada({ id: 'cfdi-cancelada', status: 'CANCELLED', createdAt: hace(500), idempotencyKey: 'otra' }),
      anexada({ id: 'cfdi-viva', createdAt: hace(5), idempotencyKey: 'otra-2' }),
    ]

    await quitar('cfdi-cancelada')

    expect(mundo.cfdis.find(c => c.id === 'cfdi-cancelada')).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
    expect(mundo.cfdis.find(c => c.id === 'cfdi-viva')).toMatchObject({ platformChargeOccurrenceId: 'occ-1' })
    expect(mundo.cfdis.find(c => c.id === 'cfdi-viva')!.chargeLinkedAt).not.toBeNull()
  })

  it('🔴 la confirmación vieja no suelta la factura nueva: A ya se quitó y se anexó B; confirmar «Quitar A» es 409 NOT_LINKED y B sigue anexada', async () => {
    mundo.cfdis = [factura({ id: 'cfdi-A' }), anexada({ id: 'cfdi-B', folio: '20', idempotencyKey: 'b' })]

    const error = await rechazo(quitar('cfdi-A'))

    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_NOT_LINKED')
    // El texto no dice que la fecha «no tiene» factura (sí tiene: la B): dice que ESA ya no está anexada y qué hacer.
    expect(error.message).toBe(
      'Esa factura ya no está anexada a esta fecha. Recarga para ver cómo quedó. Una factura timbrada desde «Por cobrar» no se quita: se cancela en Facturas CFDI',
    )
    expect(mundo.cfdis.find(c => c.id === 'cfdi-B')).toMatchObject({ platformChargeOccurrenceId: 'occ-1' })
    expect(mundo.cfdis.find(c => c.id === 'cfdi-B')!.chargeLinkedAt).not.toBeNull()
    nadieEscribio()
  })

  it('una factura anexada a OTRA fecha tampoco se quita desde ésta: NOT_LINKED', async () => {
    mundo.cfdis = [anexada({ platformChargeOccurrenceId: 'occ-de-otro' })]

    expect((await rechazo(quitar())).code).toBe('PLATFORM_CHARGE_INVOICE_NOT_LINKED')
    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-de-otro' })
    nadieEscribio()
  })

  it('una factura que no existe: NOT_LINKED, sin escribir', async () => {
    expect((await rechazo(quitar('no-existe'))).code).toBe('PLATFORM_CHARGE_INVOICE_NOT_LINKED')
    nadieEscribio()
  })

  it('una anexada ya cancelada también se puede quitar: la fila enseña «Quitar» mientras la tenga', async () => {
    mundo.cfdis = [anexada({ status: 'CANCELLED' })]

    await quitar()

    expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null, status: 'CANCELLED' })
  })

  it('en una fecha pagada u omitida también: quitar no toca el pago ni la omisión', async () => {
    Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), paidById: 'staff-0' })
    mundo.cfdis = [anexada()]

    await quitar()

    expect(mundo.occ).toMatchObject({ status: 'PAID', paidById: 'staff-0' })
    expect(mundo.cfdis[0].chargeLinkedAt).toBeNull()
  })

  it('una fecha que no existe es 404', async () => {
    await expect(unlinkInvoice('no-existe', { cfdiId: 'cfdi-19' }, 'staff-1', AHORA)).rejects.toBeInstanceOf(NotFoundError)
  })

  describe('🔴 con la cancelación en trámite ante el SAT', () => {
    // Si el SAT la rechaza vuelve a estar vigente, y ya suelta la fecha se podría facturar otra vez: dos facturas de la misma venta.
    it('CANCEL_REQUESTED: 409 PLATFORM_CHARGE_INVOICE_CANCEL_PENDING, no se suelta nada y no se registra', async () => {
      mundo.cfdis = [anexada({ status: 'CANCEL_REQUESTED' })]

      const error = await rechazo(quitar())

      expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_CANCEL_PENDING')
      expect(error.message).toBe('La cancelación de la factura A-19 sigue en trámite ante el SAT; quítala cuando el SAT conteste')
      expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1', status: 'CANCEL_REQUESTED' })
      expect(mundo.cfdis[0].chargeLinkedAt).not.toBeNull()
      nadieEscribio()
      expect(mockLogAction).not.toHaveBeenCalled()
    })

    it('cuando el SAT contesta y la cancelación se acepta (CANCELLED), ya se puede quitar', async () => {
      mundo.cfdis = [anexada({ status: 'CANCELLED' })]

      await quitar()

      expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: null, chargeLinkedAt: null })
    })
  })

  describe('🔴 la escritura de quitar es condicional: cancelar no toma el candado del cobro', () => {
    it('«Facturas CFDI» pidió cancelarla entre la lectura y la escritura: 0 filas, PLATFORM_CHARGE_INVOICE_LINK_CHANGED, sigue anexada y no se registra', async () => {
      mundo.cfdis = [anexada()]
      ganchos.antesDeTomarla = () => {
        mundo.cfdis[0].status = 'CANCEL_REQUESTED' // cambia el estado y deja `updatedAt` igual: la frena la condición de estado
      }

      const error = await rechazo(quitar())

      expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINK_CHANGED')
      expect(error.message).toMatch(/quitar/) // no dice «anexar»: la acción era otra
      expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1', status: 'CANCEL_REQUESTED' })
      expect(mundo.cfdis[0].chargeLinkedAt).not.toBeNull()
      expect(mockLogAction).not.toHaveBeenCalled()
    })

    it('la fila se escribió aunque conserve su estado (se fue a CANCEL_REQUESTED y volvió): por updatedAt, también 0 filas', async () => {
      mundo.cfdis = [anexada()]
      ganchos.antesDeTomarla = () => {
        mundo.cfdis[0].updatedAt = new Date(mundo.cfdis[0].updatedAt.getTime() + 5)
      }

      expect((await rechazo(quitar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_CHANGED')
      expect(mundo.cfdis[0]).toMatchObject({ platformChargeOccurrenceId: 'occ-1' })
      expect(mockLogAction).not.toHaveBeenCalled()
    })

    it('la factura que desaparece en medio tampoco se da por quitada', async () => {
      mundo.cfdis = [anexada()]
      ganchos.antesDeTomarla = () => {
        mundo.cfdis = []
      }

      expect((await rechazo(quitar())).code).toBe('PLATFORM_CHARGE_INVOICE_LINK_CHANGED')
      expect(mockLogAction).not.toHaveBeenCalled()
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('🔴 nadie timbra encima de una factura anexada (con invoiceOccurrence y payOccurrence de verdad)', () => {
  it('«Ya me pagó» con la casilla y anexada: paga, NO timbra y regresa la anexada, aunque traiga otro receptor', async () => {
    Object.assign(mundo.occ, { invoiceMode: 'MANUAL' })
    mundo.cfdis = [anexada()]

    const r = await payOccurrence('occ-1', { invoice: true, receptor: { ...EN_PANTALLA, rfc: 'OTR010101AAA' } }, 'staff-1', AHORA)

    expect(mundo.occ.status).toBe('PAID')
    expect(r.occurrence).toMatchObject({ status: 'PAID', invoice: { id: 'cfdi-19', linked: true } })
    expect(r.invoice).toMatchObject({ ok: true, cfdi: { id: 'cfdi-19', status: 'STAMPED' } })
    nadieTimbro()
  })

  it('anexar a una fecha pagada y pedir «Facturar»: regresa la anexada y no timbra otra', async () => {
    Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), totalCents: TOTALES_A19.totalCents })
    mundo.cfdis = [factura()]
    await anexar()

    const cfdi = await invoiceOccurrence('occ-1', { actorId: 'staff-1', receptor: EN_PANTALLA })

    expect(cfdi).toMatchObject({ id: 'cfdi-19' })
    nadieTimbro()
  })

  it('«Deshacer» con anexada es 409 «Quita primero…»; al quitarla se deshace y la fecha regresa al modo del cobro', async () => {
    Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), totalCents: TOTALES_A19.totalCents })
    mundo.cfdis = [factura()]
    await anexar()
    expect(mundo.occ.invoiceMode).toBe('MANUAL')

    const error = await rechazo(reopenOccurrence('occ-1', 'staff-1', AHORA))
    expect(error.code).toBe('PLATFORM_CHARGE_INVOICE_LINKED')
    expect(error.message).toBe('Quita primero la factura A-19')
    expect(mundo.occ.status).toBe('PAID')

    await unlinkInvoice('occ-1', { cfdiId: 'cfdi-19' }, 'staff-1', AHORA)
    await reopenOccurrence('occ-1', 'staff-1', AHORA)

    expect(mundo.occ).toMatchObject({ status: 'PENDING', paidAt: null, invoiceMode: 'AUTOMATIC' })
  })

  it('tras quitarla, el cobro vuelve a poder facturarse: timbra con la llave de la fecha', async () => {
    Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), concepts: CONCEPTOS_A19, ...TOTALES_A19, invoiceMode: 'MANUAL' })
    mundo.cfdis = [anexada()]
    pac.createInvoice.mockResolvedValue({
      providerInvoiceId: 'fa-nueva',
      uuid: 'UUID-NUEVA',
      serie: 'A',
      folio: '200',
      totalCents: TOTALES_A19.totalCents,
      stampedAt: AHORA,
      status: 'valid',
    })

    await unlinkInvoice('occ-1', { cfdiId: 'cfdi-19' }, 'staff-1', AHORA)
    const cfdi = await invoiceOccurrence('occ-1', { actorId: 'staff-1', receptor: EN_PANTALLA })

    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    expect(pac.createInvoice.mock.calls[0][0].idempotencyKey).toBe('por-cobrar:occ-1:0')
    expect(cfdi).toMatchObject({ platformChargeOccurrenceId: 'occ-1', chargeLinkedAt: null, uuid: 'UUID-NUEVA', ...TOTALES_A19 })
  })

  it('si se canceló la anexada, «Facturar» sí timbra otra, con los conceptos que tomó de ella', async () => {
    Object.assign(mundo.occ, { status: 'PAID', paidAt: hace(30), concepts: CONCEPTOS_A19, ...TOTALES_A19, invoiceMode: 'MANUAL' })
    mundo.cfdis = [anexada({ status: 'CANCELLED' })]
    pac.createInvoice.mockResolvedValue({
      providerInvoiceId: 'fa-nueva',
      uuid: 'UUID-NUEVA',
      serie: 'A',
      folio: '200',
      totalCents: TOTALES_A19.totalCents,
      stampedAt: AHORA,
      status: 'valid',
    })

    await invoiceOccurrence('occ-1', { actorId: 'staff-1', receptor: EN_PANTALLA })

    expect(pac.createInvoice).toHaveBeenCalledTimes(1)
    expect(pac.createInvoice.mock.calls[0][0].items.map((i: Fila) => [i.description, i.unitPriceCents])).toEqual([
      ['Suscripción', 100000],
      ['Capacitación', 50000],
    ])
    // La cancelada se queda con su vínculo: es el rastro de lo que se anexó.
    expect(mundo.cfdis.find(c => c.id === 'cfdi-19')).toMatchObject({ platformChargeOccurrenceId: 'occ-1', status: 'CANCELLED' })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('listInvoiceCandidates — lo que se puede anexar', () => {
  const buscar = (filtros: Fila = {}) =>
    listInvoiceCandidates({ customerType: 'ORGANIZATION', organizationId: 'org-1', ...filtros } as never)
  const ids = (r: { rows: { id: string }[] }) => r.rows.map(c => c.id).sort()

  it('sólo INGRESO, timbradas de verdad y sin cobro', async () => {
    mundo.cfdis = [
      factura({ id: 'buena' }),
      factura({ id: 'pago', type: 'PAGO' }),
      factura({ id: 'cancelada', status: 'CANCELLED' }),
      factura({ id: 'en-tramite', status: 'CANCEL_REQUESTED' }),
      factura({ id: 'timbrandose', status: 'STAMPING' }),
      factura({ id: 'fallida', status: 'STAMP_FAILED' }),
      factura({ id: 'de-un-cobro', platformChargeOccurrenceId: 'occ-9' }),
      factura({ id: 'sin-uuid', uuid: null }),
    ]

    const r = await buscar()

    expect(ids(r)).toEqual(['buena'])
    expect(r.total).toBe(1)
  })

  it('por organización: las suyas y, si se manda su RFC, las de ese RFC', async () => {
    mundo.cfdis = [
      factura({ id: 'suya' }),
      factura({ id: 'de-otra', organizationId: 'org-2', receptorRfc: 'OTR010101AAA' }),
      factura({ id: 'mismo-rfc', organizationId: 'org-2' }),
    ]

    expect(ids(await buscar())).toEqual(['suya'])
    expect(ids(await buscar({ rfc: 'LUN010101AAA' }))).toEqual(['mismo-rfc', 'suya'])
  })

  it('por negocio: las suyas', async () => {
    mundo.cfdis = [
      factura({ id: 'suya', organizationId: null, venueId: 'venue-1' }),
      factura({ id: 'de-otro', organizationId: null, venueId: 'venue-2' }),
    ]

    expect(ids(await listInvoiceCandidates({ customerType: 'VENUE', venueId: 'venue-1' } as never))).toEqual(['suya'])
  })

  it('por RFC, en mayúsculas y sin espacios', async () => {
    mundo.cfdis = [factura({ id: 'suya' }), factura({ id: 'de-otro', receptorRfc: 'OTR010101AAA' })]

    expect(ids(await listInvoiceCandidates({ rfc: ' lun010101aaa ' } as never))).toEqual(['suya'])
  })

  it('un externo con su RFC ve las de ese RFC; sin RFC, las que no son de ninguna organización ni negocio', async () => {
    mundo.cfdis = [
      factura({ id: 'externa', organizationId: null, receptorRfc: 'EXT010101AAA' }),
      factura({ id: 'de-una-org' }),
      factura({ id: 'de-un-negocio', organizationId: null, venueId: 'venue-1' }),
    ]

    expect(ids(await listInvoiceCandidates({ customerType: 'STANDALONE', rfc: 'EXT010101AAA' } as never))).toEqual(['externa'])
    expect(ids(await listInvoiceCandidates({ customerType: 'STANDALONE' } as never))).toEqual(['externa'])
  })

  it('🔴 una organización sin id no trae las de TODOS (un undefined en el filtro de Prisma no filtra): 400', async () => {
    mundo.cfdis = [factura()]

    await expect(listInvoiceCandidates({ customerType: 'ORGANIZATION' } as never)).rejects.toBeInstanceOf(BadRequestError)
    await expect(listInvoiceCandidates({ customerType: 'VENUE' } as never)).rejects.toBeInstanceOf(BadRequestError)
    await expect(listInvoiceCandidates({} as never)).rejects.toBeInstanceOf(BadRequestError)
    expect(prismaMock.platformCfdi.findMany).not.toHaveBeenCalled()
  })

  it('q busca en la base por folio, serie y folio juntos («A19», «A-19»), RFC y razón social, sin importar mayúsculas', async () => {
    mundo.cfdis = [
      factura({ id: 'a19' }),
      factura({ id: 'a18', folio: '18', receptorNombre: 'OTRA RAZON', receptorRfc: 'OTR010101AAA' }),
      factura({ id: 'b19', serie: 'B', folio: '19', receptorNombre: 'OTRA RAZON', receptorRfc: 'OTR010101AAA' }),
    ]

    expect(ids(await buscar({ q: '19' }))).toEqual(['a19', 'b19'])
    expect(ids(await buscar({ q: 'a19' }))).toEqual(['a19'])
    expect(ids(await buscar({ q: 'A-19' }))).toEqual(['a19'])
    expect(ids(await buscar({ q: 'estetica' }))).toEqual(['a19'])
    expect(ids(await buscar({ q: 'otr0101' }))).toEqual(['a18', 'b19'])
    expect(ids(await buscar({ q: '   ' }))).toEqual(['a18', 'a19', 'b19'])
  })

  it('q no se sale del cliente: buscar el folio de otro no lo trae', async () => {
    mundo.cfdis = [factura({ id: 'de-otra', organizationId: 'org-2', receptorRfc: 'OTR010101AAA' })]

    expect(ids(await buscar({ q: '19' }))).toEqual([])
  })

  it('el tope lo impone el servidor: pageSize 500 se recorta a 100 y dice el que usó; el total no sale de la página', async () => {
    mundo.cfdis = Array.from({ length: 120 }, (_, i) => factura({ id: `f-${String(i).padStart(3, '0')}`, createdAt: hace(i) }))

    const r = await buscar({ pageSize: 500 })

    expect(r.rows).toHaveLength(100)
    expect(r).toMatchObject({ total: 120, page: 1, pageSize: 100 })
  })

  it('pagina con orden estable: de la más nueva a la más vieja, con el id de desempate', async () => {
    mundo.cfdis = [factura({ id: 'a' }), factura({ id: 'c' }), factura({ id: 'b' })]

    const r1 = await buscar({ pageSize: 2 })
    const r2 = await buscar({ pageSize: 2, page: 2 })

    expect(r1.rows.map(c => c.id)).toEqual(['c', 'b'])
    expect(r2.rows.map(c => c.id)).toEqual(['a'])
    expect(r2).toMatchObject({ total: 3, page: 2, pageSize: 2 })
    expect(prismaMock.platformCfdi.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('cada candidata trae folio, fecha, total, método, RFC, razón social, sus renglones y los conceptos que tomaría la fecha', async () => {
    const stampedAt = hace(100)
    mundo.cfdis = [factura({ stampedAt })]

    const { rows } = await buscar()

    expect(rows[0]).toEqual({
      id: 'cfdi-19',
      serie: 'A',
      folio: '19',
      uuid: 'UUID-19',
      stampedAt,
      ...TOTALES_A19,
      metodoPago: 'PUE',
      receptorRfc: 'LUN010101AAA',
      receptorNombre: 'ESTETICA LUNA SA DE CV',
      descriptions: ['Suscripción', 'Capacitación'],
      concepts: CONCEPTOS_A19,
      hasPayments: false,
    })
  })

  it('la que no cabe en el modelo sale con concepts null, pero con sus renglones para leerla', async () => {
    mundo.cfdis = [
      factura({ lines: [{ description: 'Curso', quantity: 1, unitPriceCents: 10000, taxExempt: true, ...SAT }], totalCents: 10000 }),
    ]

    const { rows } = await buscar()

    expect(rows[0]).toMatchObject({ concepts: null, descriptions: ['Curso'] })
  })

  it('hasPayments: con amountPaidCents o con un complemento vivo; los complementos se buscan en UNA consulta, no una por factura', async () => {
    mundo.cfdis = [
      factura({ id: 'sin-pagos' }),
      factura({ id: 'pagada', amountPaidCents: 100 }),
      factura({ id: 'con-rep' }),
      factura({ id: 'rep-cancelado' }),
      factura({ id: 'rep-1', type: 'PAGO', parentPlatformCfdiId: 'con-rep', status: 'STAMPING' }),
      factura({ id: 'rep-2', type: 'PAGO', parentPlatformCfdiId: 'rep-cancelado', status: 'CANCELLED' }),
    ]

    const { rows } = await buscar()

    expect(Object.fromEntries(rows.map(c => [c.id, c.hasPayments]))).toEqual({
      'sin-pagos': false,
      pagada: true,
      'con-rep': true,
      'rep-cancelado': false,
    })
    expect(prismaMock.platformCfdi.findMany).toHaveBeenCalledTimes(2) // la página y sus complementos
    expect(prismaMock.platformCfdi.count).toHaveBeenCalledTimes(1)
  })

  it('sin candidatas no pregunta por complementos', async () => {
    const r = await buscar()

    expect(r).toEqual({ rows: [], total: 0, page: 1, pageSize: 50 })
    expect(prismaMock.platformCfdi.findMany).toHaveBeenCalledTimes(1)
  })

  it('una factura recién quitada de un cobro vuelve a ser candidata', async () => {
    mundo.cfdis = [anexada()]
    expect(ids(await buscar())).toEqual([])

    await unlinkInvoice('occ-1', { cfdiId: 'cfdi-19' }, 'staff-1', AHORA)

    expect(ids(await buscar())).toEqual(['cfdi-19'])
  })
})
