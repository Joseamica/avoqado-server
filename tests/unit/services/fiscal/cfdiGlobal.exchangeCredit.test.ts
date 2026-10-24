import { formaPagoDelTicket } from '@/services/fiscal/cfdiGlobal.service'
import { pertenenciaAlEmisor } from '@/services/fiscal/globalPorTratamiento'
const emisor = { id: 'caaaaaaaaaaaaaaaaaaaaaaaa', invoiceCashSales: false, includeOffTerminalSalesInGlobal: true }
describe('exchange credit global eligibility', () => {
  it('excludes root cash when cash is excluded, without the gift-card exception', () => {
    expect(
      pertenenciaAlEmisor(
        [
          {
            method: 'OTHER',
            conComercio: false,
            config: null,
            systemKind: 'EXCHANGE_CREDIT',
            origenDelCredito: { method: 'CASH', conComercio: false, config: null },
          },
        ],
        emisor,
        true,
      ),
    ).toBe('EFECTIVO')
  })
  it('includes the root card as card even with off-terminal sales disabled', () => {
    expect(
      pertenenciaAlEmisor(
        [
          {
            method: 'OTHER',
            conComercio: false,
            config: null,
            systemKind: 'EXCHANGE_CREDIT',
            origenDelCredito: {
              method: 'CREDIT_CARD',
              conComercio: true,
              config: { fiscalEmisorId: emisor.id, facturacionEnabled: true, includeInGlobal: true },
            },
          },
        ],
        { ...emisor, includeOffTerminalSalesInGlobal: false },
        false,
      ),
    ).toBe('CANDIDATA')
  })
  it('invoices compensation as form 17, while the root governs eligibility', () => {
    expect(
      formaPagoDelTicket([
        {
          id: 'cbbbbbbbbbbbbbbbbbbbbbbbb',
          createdAt: new Date(),
          method: 'OTHER',
          amount: 500,
          type: 'REGULAR',
          tenderSatFormaPago: '17',
          tenderTypeId: null,
        },
      ]),
    ).toBe('17')
  })
})

it('does not borrow the gift-card redemption exception for an exchange credit root', () => {
  expect(
    pertenenciaAlEmisor(
      [
        {
          method: 'OTHER',
          conComercio: false,
          config: null,
          systemKind: 'EXCHANGE_CREDIT',
          origenDelCredito: { method: 'OTHER', conComercio: false, config: null, saldoDeRegalo: true },
        },
      ],
      { ...emisor, includeOffTerminalSalesInGlobal: false, comercioEnLaGlobal: true },
      true,
    ),
  ).toBe('SIN_TERMINAL')
})
