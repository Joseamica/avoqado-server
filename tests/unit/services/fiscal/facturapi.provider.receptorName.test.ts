// Fase 4 — normalización del nombre del receptor en el boundary del PAC.
//
// El SAT rechaza el timbrado si "el nombre del receptor no coincide con el nombre
// registrado en el padrón" — y el padrón guarda los nombres en MAYÚSCULAS. Hoy el
// nombre viaja al PAC exactamente como lo tecleó quien sea (dashboard, autofactura
// del cliente final, una llamada directa a la API). Este archivo cubre:
//   1. El helper puro `normalizeReceptorName` (trim + colapso de espacios + MAYÚSCULAS).
//   2. Que `createInvoice` y `createPaymentComplement` lo apliquen al `legal_name`
//      que reciben del SDK de Facturapi (integración, cliente SDK falso inyectado).

const mockCreate = jest.fn()

jest.mock('facturapi', () => {
  return jest.fn().mockImplementation(() => ({
    invoices: { create: mockCreate },
  }))
})

import { FacturapiProvider } from '@/services/fiscal/providers/facturapi.provider'

/** El helper es un método estático PRIVADO — el cast bypassea la privacidad solo en compile-time,
 *  igual que el patrón ya usado en facturapi.provider.customers.test.ts para el client del SDK. */
const normalizeReceptorName = (nombre: string): string =>
  (FacturapiProvider as unknown as { normalizeReceptorName: (n: string) => string }).normalizeReceptorName(nombre)

describe('FacturapiProvider.normalizeReceptorName', () => {
  it('mayusculiza un nombre en minúsculas', () => {
    expect(normalizeReceptorName('la galeterie')).toBe('LA GALETERIE')
  })

  it('recorta espacios en los extremos y colapsa espacios internos múltiples a uno solo', () => {
    expect(normalizeReceptorName('  LA   GALETERIE  ')).toBe('LA GALETERIE')
  })

  it('mayusculiza correctamente un nombre con acentos y eñe', () => {
    expect(normalizeReceptorName('muñoz hernández')).toBe('MUÑOZ HERNÁNDEZ')
  })

  it('un nombre que ya viene bien queda idéntico', () => {
    expect(normalizeReceptorName('LA GALETERIE')).toBe('LA GALETERIE')
  })

  it('conserva el régimen de capital (SA DE CV) — NO se quita automáticamente', () => {
    expect(normalizeReceptorName('ESCUELA KEMPER URGATE SA DE CV')).toBe('ESCUELA KEMPER URGATE SA DE CV')
  })

  it('conserva el régimen de capital aunque venga en minúsculas y con espacios de más', () => {
    expect(normalizeReceptorName('  escuela kemper urgate   sa de cv  ')).toBe('ESCUELA KEMPER URGATE SA DE CV')
  })
})

// ── Integración: el legal_name que recibe el SDK va normalizado ──────────────

const MOCK_INVOICE_RESPONSE = {
  id: 'fa_inv_1',
  uuid: 'UUID-123',
  series: 'A',
  folio_number: 42,
  total: 116.0,
  stamp: { date: '2026-06-03T10:00:00Z' },
  status: 'valid',
  cancellation_status: 'none',
}

describe('FacturapiProvider — normalización del receptor en el boundary del PAC', () => {
  beforeEach(() => jest.clearAllMocks())

  it('createInvoice envía legal_name normalizado al SDK aunque el receptor venga mal escrito', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')

    await provider.createInvoice({
      receptor: {
        rfc: 'GAL150211KT5',
        razonSocial: '  la   galeterie  ',
        regimenFiscal: '601',
        codigoPostal: '06400',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '90101500',
          satUnitKey: 'E48',
          description: 'Servicio',
          quantity: 1,
          unitPriceCents: 10000,
          discountCents: 0,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
        },
      ],
      formaPago: '01',
      metodoPago: 'PUE',
      idempotencyKey: 'idem-1',
    })

    const body = mockCreate.mock.calls[0][0]
    expect(body.customer.legal_name).toBe('LA GALETERIE')
  })

  it('createPaymentComplement envía legal_name normalizado al SDK aunque el receptor venga mal escrito', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')

    await provider.createPaymentComplement({
      receptor: {
        rfc: 'GAL150211KT5',
        razonSocial: '  la   galeterie  ',
        regimenFiscal: '601',
        codigoPostal: '06400',
      },
      paymentDate: new Date('2026-06-01T00:00:00Z'),
      paymentForm: '01',
      relatedDocuments: [
        {
          uuid: 'UUID-RELATED-1',
          amountCents: 11600,
          installment: 1,
          lastBalanceCents: 11600,
          taxes: [{ baseCents: 10000, rate: 0.16, type: 'IVA', factor: 'Tasa', withholding: false }],
        },
      ],
    })

    const body = mockCreate.mock.calls[0][0]
    expect(body.customer.legal_name).toBe('LA GALETERIE')
  })
})
