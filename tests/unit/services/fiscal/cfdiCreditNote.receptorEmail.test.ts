/**
 * 🔴 Codex (ronda 2 del correo de facturas, 30-sep): la nota de crédito tomaba el correo del perfil fiscal MÁS RECIENTE con ese
 * RFC en el negocio — de otra persona si el RFC se repite (genérico o una empresa con varios empleados). Ahora que la nota se
 * envía sola, iría a quien no es. Se usa el correo que el receptor dio en la factura original; sin él, no se adivina.
 */
import { loadRefundForCreditNoteFromDb } from '@/services/fiscal/cfdiCreditNote.service'

const perfilAjeno = jest.fn().mockResolvedValue({ email: 'otra.persona@cliente.mx' })

function tx(entrada: unknown) {
  return {
    payment: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'r1',
        venueId: 'v1',
        orderId: 'o1',
        type: 'REFUND',
        status: 'COMPLETED',
        amount: -116,
        tipAmount: 0,
        method: 'CREDIT_CARD',
        tenderSatFormaPago: null,
      }),
    },
    order: { findUnique: jest.fn().mockResolvedValue({ venue: { slug: 'demo' } }) },
    cfdi: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', receptorRfc: 'XAXX010101000', entrada }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 } }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    customerTaxProfile: { findFirst: perfilAjeno },
  } as any
}

beforeEach(() => perfilAjeno.mockClear())

it('usa el correo congelado de la factura original, nunca el de otro perfil con el mismo RFC', async () => {
  const loaded = await loadRefundForCreditNoteFromDb('v1', 'r1', tx({ params: { receptor: { email: 'capturado@cliente.mx' } } }))

  expect(loaded?.original?.receptorEmail).toBe('capturado@cliente.mx')
  expect(perfilAjeno).not.toHaveBeenCalled()
})

it('factura original sin correo capturado: la nota va sin correo (se reenvía a mano), no se adivina por RFC', async () => {
  const loaded = await loadRefundForCreditNoteFromDb('v1', 'r1', tx(null))

  expect(loaded?.original?.receptorEmail).toBeNull()
  expect(perfilAjeno).not.toHaveBeenCalled()
})
