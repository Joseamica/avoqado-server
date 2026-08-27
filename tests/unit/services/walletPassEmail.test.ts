jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import emailService from '@/services/email.service'

/**
 * El correo que le lleva su tarjeta al CLIENTE FINAL — no al negocio. Es el primero
 * de su tipo, asi que ademas del checklist de `.claude/rules/email-templates.md`
 * (sin emoji en el asunto, isotipo dos veces, CTA negro, texto plano no vacio) se
 * verifica lo que solo aplica cuando el lector es el cliente: nunca se le habla de
 * planes ni del dashboard, y se le dice que hoy la tarjeta solo abre en iPhone.
 */
const LOGO = 'https://avoqado.io/isotipo.svg'

type Sent = { to: string; subject: string; html?: string; text?: string }

function captureSend(): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = []
  const spy = jest.spyOn(emailService, 'sendEmail').mockImplementation(async (opts: any) => {
    sent.push(opts)
    return true
  })
  return { sent, restore: () => spy.mockRestore() }
}

const BASE = {
  venueName: 'Café Centro',
  customerName: 'Ana',
  passUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/apple/cus_1',
  stampsEarned: 1,
  stampsRequired: 7,
  rewardLabel: 'Un café gratis',
}

describe('sendWalletPassEmail', () => {
  let cap: ReturnType<typeof captureSend>
  beforeEach(() => {
    cap = captureSend()
  })
  afterEach(() => cap.restore())

  it('cumple el checklist de correos del repo', async () => {
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    const [m] = cap.sent
    expect(m).toBeDefined()
    expect(m.subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(m.subject.length).toBeLessThanOrEqual(60)
    expect((m.html!.match(new RegExp(LOGO, 'g')) || []).length).toBeGreaterThanOrEqual(2)
    expect(m.html).toContain('background-color:#000000')
    expect(m.text!.trim().length).toBeGreaterThan(0)
    expect(m.html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
  })

  it('la liga del pase va en el CTA y tambien en el texto plano', async () => {
    // Muchos clientes de correo bloquean el HTML: si la liga solo vive en el boton,
    // ese lector se queda sin forma de obtener su tarjeta.
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    const [m] = cap.sent
    expect(m.html).toContain(BASE.passUrl)
    expect(m.text).toContain(BASE.passUrl)
  })

  it('dice el avance real de la cartilla y cual es el premio', async () => {
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    const [m] = cap.sent
    expect(m.html).toContain('1')
    expect(m.html).toContain('7')
    expect(m.html).toContain('Un caf')
  })

  it('advierte que hoy solo abre en iPhone', async () => {
    // Sin esto, quien tenga Android toca el boton, no le abre nada, y el que queda
    // mal es el negocio que se lo mando.
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    expect(cap.sent[0].html).toMatch(/iPhone/)
    expect(cap.sent[0].text).toMatch(/iPhone/)
  })

  it('nunca le habla al cliente de planes, dashboard ni suscripciones', async () => {
    // El plan es del NEGOCIO, no suyo. Mencionarlo en el correo del cliente final
    // es filtrar la relacion comercial a quien no le corresponde.
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    const todo = (cap.sent[0].html! + cap.sent[0].text!).toLowerCase()
    for (const palabra of ['dashboard', 'suscripción', 'suscripcion', 'plan pro', 'premium', 'mejora tu plan']) {
      expect(todo).not.toContain(palabra)
    }
  })

  it('el asunto nombra al negocio, no a Avoqado', async () => {
    // El cliente tiene relacion con el café, no con nosotros: un asunto que dice
    // "Avoqado" parece publicidad de un remitente que no conoce.
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    expect(cap.sent[0].subject).toContain('Café Centro')
  })

  it('aguanta que el negocio no haya escrito etiqueta de premio', async () => {
    await emailService.sendWalletPassEmail('ana@example.com', { ...BASE, rewardLabel: '' })
    expect(cap.sent[0]).toBeDefined()
    expect(cap.sent[0].html).not.toContain('undefined')
    expect(cap.sent[0].text).not.toContain('undefined')
  })
})
