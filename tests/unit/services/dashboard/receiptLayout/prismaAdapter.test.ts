import { Prisma } from '@prisma/client'
import { buildReceiptInput, buildVenueInfo, pesosACentavos } from '@/services/shared/receiptLayout/prismaAdapter'
import { SAMPLE_SALES } from '@/services/shared/receiptLayout/sampleSales'
import { CANONICAL_LAYOUT, interpret } from '@/services/shared/receiptLayout'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const D = (v: string) => new Prisma.Decimal(v)

describe('pesosACentavos — el ÚNICO sitio donde el dinero cambia de unidad', () => {
  it('convierte sin perder centavos', () => {
    expect(pesosACentavos(D('1234.50'))).toBe(123450)
    expect(pesosACentavos(D('0.05'))).toBe(5)
    expect(pesosACentavos(D('0'))).toBe(0)
  })

  it('🔴 el caso que el flotante rompe: 19.99', () => {
    // Number('19.99') * 100 = 1998.9999999999998 -> 1998 al truncar: un centavo por ticket.
    expect(pesosACentavos(D('19.99'))).toBe(1999)
  })

  it('🔴 redondeo HALF_UP declarado, no el del flotante', () => {
    expect(pesosACentavos(D('0.005'))).toBe(1)
    expect(pesosACentavos(D('0.004'))).toBe(0)
  })

  it('null y undefined son 0, no NaN (un NaN imprimiría "$NaN" en el papel)', () => {
    expect(pesosACentavos(null)).toBe(0)
    expect(pesosACentavos(undefined)).toBe(0)
  })
})

const venue = {
  name: 'Testarudo Cafe',
  address: 'Nápoles 47',
  city: 'Cuauhtémoc',
  state: 'Ciudad de México',
  zipCode: '06600',
  phone: '55 1234 5678',
  logo: 'https://x/logo.jpg',
  rfc: null,
  legalName: null,
  timezone: 'America/Mexico_City',
  fiscalEmisors: [
    {
      id: 'emA',
      legalName: 'TESTARUDO CAFE S.A.P.I. DE C.V.',
      rfc: 'TCA2501231A6',
      lugarExpedicion: '06600',
      merchantConfigs: [{ merchantAccountId: 'maA' }, { merchantAccountId: null }],
    },
  ],
}
const order = {
  orderNumber: '1042',
  type: 'TAKEOUT',
  subtotal: D('120.00'),
  taxAmount: D('0'),
  discountAmount: D('0'),
  total: D('120.00'),
  items: [
    {
      productName: 'Café americano',
      quantity: 1,
      unitPrice: D('120.00'),
      total: D('120.00'),
      notes: null,
      isCortesia: false,
      weightQuantity: null,
      weightUnit: null,
      modifiers: [{ name: 'Sin azúcar', quantity: 1 }],
    },
  ],
}
const payment = {
  amount: D('120.00'),
  tipAmount: D('0'),
  method: 'CASH',
  createdAt: new Date('2026-09-02T18:05:00.000Z'),
  merchantAccountId: null,
  cardBrand: null,
  maskedPan: null,
  authorizationNumber: null,
  referenceNumber: null,
  receiptUrl: null,
  processedBy: { firstName: 'Ana', lastName: null },
}

describe('buildReceiptInput', () => {
  it('🔴 el dinero llega al intérprete en CENTAVOS ENTEROS', () => {
    const input = buildReceiptInput({ order: order as never, payment: payment as never, venue: venue as never })
    expect(input.sale.totalCents).toBe(12000)
    expect(input.sale.subtotalCents).toBe(12000)
    expect(input.sale.items[0].totalPriceCents).toBe(12000)
    expect(Number.isInteger(input.sale.totalCents)).toBe(true)
  })

  it('🔴 la FECHA es la del pago, y la zona la del venue — nunca la del servidor', () => {
    const input = buildReceiptInput({ order: order as never, payment: payment as never, venue: venue as never })
    expect(input.sale.occurredAt).toBe('2026-09-02T18:05:00.000Z')
    expect(input.sale.timezone).toBe('America/Mexico_City')
  })

  it('🔴 el merchantAccountId del PAGO viaja al tender: es lo que elige el emisor', () => {
    const conTarjeta = { ...payment, method: 'CREDIT_CARD', merchantAccountId: 'maA', maskedPan: '411111******1234', cardBrand: 'VISA' }
    const input = buildReceiptInput({ order: order as never, payment: conTarjeta as never, venue: venue as never })
    expect(input.sale.tender?.merchantAccountId).toBe('maA')
    expect(input.sale.tender?.cardLastFour).toBe('1234')
    expect(input.sale.tender?.kind).toBe('CARD')
  })

  it('🔴 las cuentas de cobro NULAS se filtran (merchantAccountId es nulable en el schema)', () => {
    const input = buildReceiptInput({ order: order as never, payment: payment as never, venue: venue as never })
    expect(input.venue.fiscalEmisors[0].merchantAccountIds).toEqual(['maA'])
  })

  it('el artículo lleva su nombre denormalizado, sus modificadores y su cortesía', () => {
    const input = buildReceiptInput({ order: order as never, payment: payment as never, venue: venue as never })
    expect(input.sale.items[0]).toMatchObject({ name: 'Café americano', modifiers: ['Sin azúcar'], isCortesia: false })
  })

  it('🔴 un artículo sin productName no imprime "undefined"', () => {
    const sinNombre = { ...order, items: [{ ...order.items[0], productName: null }] }
    const input = buildReceiptInput({ order: sinNombre as never, payment: payment as never, venue: venue as never })
    expect(input.sale.items[0].name).toBe('Artículo')
  })

  it('la venta por peso arma su renglón de resumen', () => {
    const porPeso = {
      ...order,
      items: [{ ...order.items[0], weightQuantity: D('0.435'), weightUnit: 'KG', unitPrice: D('420.00'), total: D('182.70') }],
    }
    const input = buildReceiptInput({ order: porPeso as never, payment: payment as never, venue: venue as never })
    expect(input.sale.items[0].weightSummary).toBe('0.435 KG × $420.00/KG')
  })

  it('lo que produce el adaptador ENTRA al intérprete y sale un ticket', () => {
    const input = buildReceiptInput({ order: order as never, payment: payment as never, venue: venue as never })
    const lines = interpret(CANONICAL_LAYOUT, input, 48)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) if (l.kind === 'text') expect(l.double ? l.text.length * 2 : l.text.length).toBeLessThanOrEqual(48)
  })

  it('buildVenueInfo es el MISMO mapeo que usa buildReceiptInput (no se duplica)', () => {
    const input = buildReceiptInput({ order: order as never, payment: payment as never, venue: venue as never })
    expect(buildVenueInfo(venue as never)).toEqual(input.venue)
  })
})

describe('SAMPLE_SALES — las ventas de ejemplo de la vista previa', () => {
  it('las tres existen y todas traen centavos enteros', () => {
    const ids = Object.keys(SAMPLE_SALES)
    expect(ids).toEqual(['retail', 'restaurant', 'appointments'])
    for (const venta of Object.values(SAMPLE_SALES)) {
      expect(Number.isInteger(venta.totalCents)).toBe(true)
      expect(venta.items.every(i => Number.isInteger(i.totalPriceCents))).toBe(true)
    }
  })
})

describe('🔴 guardia: el dinero cruza de unidad en UN solo archivo', () => {
  const dir = resolve(__dirname, '../../../../../src/services/shared/receiptLayout')
  const archivos = () => readdirSync(dir).filter(f => f.endsWith('.ts'))

  it('🔴 sólo el adaptador toca Prisma.Decimal — es la frontera real del dinero', () => {
    const culpables = archivos().filter(
      f => f !== 'prismaAdapter.ts' && /Prisma\.Decimal|from '@prisma\/client'/.test(readFileSync(resolve(dir, f), 'utf8')),
    )
    expect(culpables).toEqual([])
  })

  it('la aritmética con 100 sólo existe donde se FORMATEA, y la lista de excepciones está cerrada', () => {
    // format.ts parte centavos para pintarlos (123450 -> "1,234" y "50"): eso NO es convertir
    // unidades. Cualquier OTRO archivo que multiplique o divida por 100 sí lo sería.
    const PERMITIDOS = ['prismaAdapter.ts', 'format.ts']
    const conAritmetica = archivos().filter(f => /[*/]\s*100\b/.test(readFileSync(resolve(dir, f), 'utf8')))
    expect(conAritmetica.filter(f => !PERMITIDOS.includes(f))).toEqual([])
    // La lista no puede crecer en silencio: si alguien añade un archivo aquí, esta prueba lo dice.
    expect(conAritmetica.sort()).toEqual(['format.ts', 'prismaAdapter.ts'])
  })
})
