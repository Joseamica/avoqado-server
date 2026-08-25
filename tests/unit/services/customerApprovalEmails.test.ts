jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import emailService from '@/services/email.service'

/**
 * Fase 1 — los cuatro correos de la aprobación.
 *
 * Checklist obligatorio de `.claude/rules/email-templates.md`: sin emoji en el asunto,
 * isotipo dos veces (header + footer), CTA negro, y cuerpo de texto plano no vacío. Se
 * verifican interceptando `sendEmail`, sin tocar Resend.
 */
const LOGO = 'https://avoqado.io/isotipo.svg'

type Sent = { to: string; subject: string; html?: string; text?: string; idempotencyKey?: string }

function captureSend(): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = []
  const spy = jest.spyOn(emailService, 'sendEmail').mockImplementation(async (opts: any) => {
    sent.push(opts)
    return true
  })
  return { sent, restore: () => spy.mockRestore() }
}

const BASE = {
  venueName: 'Mindform Estudio',
  customerName: 'Ana López',
  bookingUrl: 'https://book.avoqado.io/mindform',
  dashboardUrl: 'https://dashboard.avoqado.io/venues/mindform/clientes',
}

describe('correos de aprobación de clientes', () => {
  let cap: ReturnType<typeof captureSend>

  beforeEach(() => {
    cap = captureSend()
  })
  afterEach(() => cap.restore())

  const EVENTS = ['REQUESTED_STAFF', 'PENDING_CUSTOMER', 'APPROVED_CUSTOMER', 'REJECTED_CUSTOMER'] as const

  it.each(EVENTS)('🔴 %s cumple el estándar visual (isotipo ×2, CTA negro, texto plano, sin emoji)', async event => {
    await emailService.sendCustomerApprovalEmail(event, 'destino@test.com', BASE)

    expect(cap.sent).toHaveLength(1)
    const mail = cap.sent[0]

    // Sin emoji en el asunto (rango de pictogramas), y corto.
    expect(mail.subject).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    expect(mail.subject.length).toBeLessThanOrEqual(70)
    // Isotipo dos veces: cabecera y pie.
    expect(mail.html!.split(LOGO).length - 1).toBeGreaterThanOrEqual(2)
    // CTA negro, nunca azul ni degradado.
    expect(mail.html).toContain('background-color: #000000')
    // Texto plano no vacío: muchos clientes bloquean el HTML.
    expect(mail.text!.trim().length).toBeGreaterThan(0)
    // Pie legal obligatorio.
    expect(mail.html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
  })

  it('🔴 al staff se le dice QUIÉN espera y se le manda a la bandeja, no a la página de reservas', async () => {
    await emailService.sendCustomerApprovalEmail('REQUESTED_STAFF', 'duena@estudio.mx', BASE)

    const mail = cap.sent[0]
    expect(mail.html).toContain('Ana López')
    expect(mail.html).toContain(BASE.dashboardUrl)
    expect(mail.html).not.toContain(BASE.bookingUrl)
  })

  it('🔴 al aprobado se le manda a reservar; al rechazado NO', async () => {
    await emailService.sendCustomerApprovalEmail('APPROVED_CUSTOMER', 'ana@test.com', BASE)
    expect(cap.sent[0].html).toContain(BASE.bookingUrl)

    cap.sent.length = 0
    await emailService.sendCustomerApprovalEmail('REJECTED_CUSTOMER', 'ana@test.com', { ...BASE, reason: 'No es alumna del estudio' })
    expect(cap.sent[0].html).not.toContain(BASE.bookingUrl)
  })

  it('🔴 el motivo del rechazo se muestra si lo hay, y el correo funciona sin él', async () => {
    await emailService.sendCustomerApprovalEmail('REJECTED_CUSTOMER', 'ana@test.com', { ...BASE, reason: 'Cupo lleno este mes' })
    expect(cap.sent[0].html).toContain('Cupo lleno este mes')

    cap.sent.length = 0
    await emailService.sendCustomerApprovalEmail('REJECTED_CUSTOMER', 'ana@test.com', BASE)
    expect(cap.sent[0].html).toBeTruthy()
  })

  it('🔴 el motivo se escapa: un cliente no puede inyectar HTML en el correo del negocio', async () => {
    await emailService.sendCustomerApprovalEmail('REJECTED_CUSTOMER', 'ana@test.com', {
      ...BASE,
      reason: '<script>alert(1)</script>',
    })

    expect(cap.sent[0].html).not.toContain('<script>')
    expect(cap.sent[0].html).toContain('&lt;script&gt;')
  })

  it('🔴 la clave de idempotencia viaja al proveedor: un reintento no genera un segundo correo', async () => {
    await emailService.sendCustomerApprovalEmail('APPROVED_CUSTOMER', 'ana@test.com', {
      ...BASE,
      idempotencyKey: 'outbox-1:EMAIL:ana@test.com',
    })

    expect(cap.sent[0].idempotencyKey).toBe('outbox-1:EMAIL:ana@test.com')
  })
})
