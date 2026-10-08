/**
 * I2 (revisión final de la fase 3 «Pago al personal»): el asistente del dashboard leía el flujo viejo de pagos de comisiones.
 *
 * Escenario: el dueño pregunta «¿cuáles son los pagos de comisiones?» y el asistente contestaba «Payouts de comisiones: $0
 * pagado, $0 pendiente» aunque sus recibos de Pago al personal dijeran $5,000 pagados (podía volver a pagar a mano). Y «cómo
 * van mis comisiones» decía «$0 aprobado y $0 pendiente»: estados que ya nadie escribe.
 *
 * Ahora lo pagado sale de los recibos (la misma fuente que el KPI «Pagado» de Comisiones) y el historial del flujo anterior
 * sólo aparece como historial, sin «pendiente». Es el hermano de lo que E1c hizo en el MCP (`commission_payouts`).
 */
process.env.OPENAI_API_KEY = 'test-api-key-for-unit-tests'

import OpenAI from 'openai'
import { Prisma, StaffRole } from '@prisma/client'
import { ConversationOrchestratorService } from '@/services/dashboard/chatbot-conversation/conversation-orchestrator.service'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import { ActionEngine } from '@/services/dashboard/chatbot-actions/action-engine.service'
import { UserRole } from '@/services/dashboard/table-access-control.service'
import { getUserAccess } from '@/services/access/access.service'
import * as commissionCalculationService from '@/services/dashboard/commission/commission-calculation.service'
import * as commissionPayoutService from '@/services/dashboard/commission/commission-payout.service'

jest.mock('@/services/access/access.service', () => ({ getUserAccess: jest.fn() }))
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  getVenueCommissionStats: jest.fn(),
  comisionesPagadasEnRecibos: jest.fn(),
}))
jest.mock('@/services/dashboard/commission/commission-payout.service', () => ({ getPayoutStats: jest.fn(), getPayouts: jest.fn() }))

const orchestrator = new ConversationOrchestratorService(
  { chat: { completions: { create: jest.fn() } } } as unknown as OpenAI,
  {
    continueDisambiguation: jest.fn(),
    detectAction: jest.fn(),
    processAction: jest.fn(),
  } as unknown as ActionEngine,
)

const pregunta = (message: string) => orchestrator.process({ message, venueId: 'venue-1', userId: 'user-1', userRole: UserRole.ADMIN })

const stats = (o: { totalPaid: number; staffPayActive: boolean }) => ({
  ...o,
  totalCalculated: 7000,
  totalPending: 250,
  totalApproved: 500,
  staffWithCommissions: 3,
  averageCommission: 125,
  topEarners: [{ staffId: 'staff-1', staffName: 'Ana Admin', totalEarned: 750, calculationCount: 6 }],
})

const pagoViejo = (o: { amount: number; status: string; firstName: string }) => ({
  id: `payout-${o.firstName}`,
  amount: { toNumber: () => o.amount },
  status: o.status,
  paymentMethod: 'BANK_TRANSFER',
  paymentReference: 'secret-bank-ref',
  notes: 'private note',
  createdAt: new Date('2026-05-12T12:00:00.000Z'),
  paidAt: o.status === 'PAID' ? new Date('2026-05-12T18:00:00.000Z') : null,
  staff: { id: `staff-${o.firstName}`, firstName: o.firstName, lastName: 'Admin', email: 'ana@example.com' },
  summary: { periodStart: new Date('2026-05-01T06:00:00.000Z'), periodEnd: new Date('2026-06-01T05:59:59.999Z'), netAmount: 0 },
})

/** Lo que queda en el flujo viejo; `recibos` es lo pagado en recibos de Pago al personal. */
function flujos(o: { recibos: number; activo: boolean; viejos: Array<ReturnType<typeof pagoViejo>>; pendienteViejo?: number }) {
  const pagados = o.viejos.filter(p => p.status === 'PAID')
  const pagadoViejo = pagados.reduce((s, p) => s + p.amount.toNumber(), 0)
  ;(commissionCalculationService.comisionesPagadasEnRecibos as jest.Mock).mockResolvedValue({
    activo: o.activo,
    total: new Prisma.Decimal(o.recibos),
  })
  ;(commissionPayoutService.getPayoutStats as jest.Mock).mockResolvedValue({
    totalPaid: pagadoViejo,
    totalPending: o.pendienteViejo ?? 0,
    payoutCount: pagados.length,
    averagePayout: pagados.length ? pagadoViejo / pagados.length : 0,
  })
  ;(commissionPayoutService.getPayouts as jest.Mock).mockResolvedValue(o.viejos)
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(getUserAccess as jest.Mock).mockResolvedValue({ role: StaffRole.ADMIN, corePermissions: ['commissions:read', 'commissions:payout'] })
})

describe('«cómo van mis comisiones»: lo calculado y lo pagado en recibos, sin estados que nadie escribe', () => {
  it('con Pago al personal: lo pagado sale de los recibos y no dice «aprobado» ni «pendiente»', async () => {
    ;(commissionCalculationService.getVenueCommissionStats as jest.Mock).mockResolvedValue(stats({ totalPaid: 5000, staffPayActive: true }))
    const r = await pregunta('como van mis comisiones')
    expect(r?.metadata.steps).toEqual([expect.objectContaining({ tool: 'commissions.summary', status: 'executed' })])
    expect(r?.response).toContain('Comisiones calculadas: $7,000.00')
    expect(r?.response).toContain('Pagado en los recibos de Pago al personal: $5,000.00')
    expect(r?.response).not.toMatch(/aprobad|pendiente/i)
    expect(r?.response).toContain('Ana Admin')
    expect(JSON.stringify(r?.queryResult)).not.toContain('staff-1')
  })

  it('sin Pago al personal: no dice «$0 pagado», dice dónde se registra el pago', async () => {
    ;(commissionCalculationService.getVenueCommissionStats as jest.Mock).mockResolvedValue(stats({ totalPaid: 0, staffPayActive: false }))
    const r = await pregunta('como van mis comisiones')
    expect(r?.response).not.toMatch(/\$0\.00 pagado|Pagado en los recibos/)
    expect(r?.response).toContain('se registra en el recibo de Pago al personal, que esta sede todavía no usa')
    expect(r?.queryResult).toMatchObject({ staffPayActive: false, totalCalculated: 7000 })
  })
})

describe('«pagos de comisiones»: lo pagado en recibos; el flujo anterior sólo como historial', () => {
  it('el escenario de la revisión: recibos con $5,000 pagados y nada en el flujo viejo', async () => {
    flujos({ recibos: 5000, activo: true, viejos: [], pendienteViejo: 300 })
    const r = await pregunta('resumen de payouts de comisiones')
    expect(commissionCalculationService.comisionesPagadasEnRecibos).toHaveBeenCalledWith('venue-1')
    expect(r?.metadata.steps).toEqual([expect.objectContaining({ tool: 'commissions.payouts', status: 'executed' })])
    expect(r?.response).toContain('Comisiones pagadas en los recibos de Pago al personal: $5,000.00')
    expect(r?.response).not.toMatch(/\$0\.00 pagado|pendiente/i)
    expect(r?.queryResult).toMatchObject({ staffPayActive: true, paidInStaffPay: 5000 })
  })

  it('sin Pago al personal en la sede: dice dónde se registran, nunca «$0 pagado»', async () => {
    flujos({ recibos: 0, activo: false, viejos: [] })
    const r = await pregunta('resumen de payouts de comisiones')
    expect(r?.response).toContain('Desde octubre de 2026 las comisiones se pagan en el recibo de Pago al personal')
    expect(r?.response).toContain('esta sede todavía no lo usa')
    expect(r?.response).not.toMatch(/\$0\.00 pagado/)
  })

  it('el historial del flujo anterior se nombra como tal: sólo lo pagado, sin pendientes, sin datos de contacto ni referencias', async () => {
    flujos({
      recibos: 5000,
      activo: true,
      viejos: [
        pagoViejo({ amount: 700, status: 'PAID', firstName: 'Ana' }),
        pagoViejo({ amount: 300, status: 'PENDING', firstName: 'Beto' }),
      ],
      pendienteViejo: 300,
    })
    const r = await pregunta('resumen de payouts de comisiones')
    expect(r?.response).toContain('Con el flujo anterior se registró 1 pago por $700.00')
    expect(r?.response).toContain('Ana Admin')
    expect(r?.response).not.toContain('Beto')
    expect(r?.response).not.toMatch(/pendiente/i)
    const datos = JSON.stringify(r?.queryResult)
    for (const privado of ['ana@example.com', 'secret-bank-ref', 'private note']) expect(datos).not.toContain(privado)
  })

  it('getCommissionsSummary sigue leyendo el KPI de Comisiones (misma fuente que la pantalla)', async () => {
    ;(commissionCalculationService.getVenueCommissionStats as jest.Mock).mockResolvedValue(stats({ totalPaid: 5000, staffPayActive: true }))
    const r = await SharedQueryService.getCommissionsSummary('venue-test')
    expect(commissionCalculationService.getVenueCommissionStats).toHaveBeenCalledWith('venue-test')
    expect(r).toMatchObject({ totalPaid: 5000, staffPayActive: true, totalCalculated: 7000 })
    expect(r.topEarners).toEqual([{ staffName: 'Ana Admin', totalEarned: 750, calculationCount: 6 }])
  })
})
