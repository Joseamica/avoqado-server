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
 * planes ni del dashboard, y que ofrece la cartera que le toca a cada quien.
 *
 * 🔴 Un correo no puede detectar el telefono de quien lo abre (se lee en cualquier
 * lado, y los clientes de correo no corren JavaScript). Por eso van DOS botones
 * visibles, uno por cartera, en vez de adivinar como hace la pagina publica.
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
  applePassUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/apple/cus_1',
  googlePassUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/google/cus_1',
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

  it('las DOS ligas van en sus CTAs y tambien en el texto plano', async () => {
    // Muchos clientes de correo bloquean el HTML: si la liga solo vive en el boton,
    // ese lector se queda sin forma de obtener su tarjeta.
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    const [m] = cap.sent
    expect(m.html).toContain(BASE.applePassUrl)
    expect(m.html).toContain(BASE.googlePassUrl)
    expect(m.text).toContain(BASE.applePassUrl)
    expect(m.text).toContain(BASE.googlePassUrl)
  })

  it('dice el avance real de la cartilla y cual es el premio', async () => {
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    const [m] = cap.sent
    expect(m.html).toContain('1')
    expect(m.html).toContain('7')
    expect(m.html).toContain('Un caf')
  })

  it('con Google configurado: dos botones visibles, uno por cartera, y cero disculpas de que Android falta', async () => {
    // 🔴 El mercado resuelve esto con dos botones, no adivinando el telefono (que un
    // correo no puede detectar). Y si SI hay liga de Google, decir que "viene en
    // camino" ya seria falso.
    await emailService.sendWalletPassEmail('ana@example.com', BASE)
    const [m] = cap.sent
    expect(m.html).toMatch(/Guardar en iPhone/)
    expect(m.html).toMatch(/Guardar en Android/)
    expect(m.text).toMatch(/Guardar en iPhone/)
    expect(m.text).toMatch(/Guardar en Android/)
    const todo = (m.html! + m.text!).toLowerCase()
    expect(todo).not.toContain('viene en camino')
    expect(todo).not.toContain('solo se guarda en iphone')
  })

  it('sin Google configurado: solo aparece la liga y el boton de Apple', async () => {
    // 🔴 `googlePassUrl` viene null cuando el servidor no tiene Google Wallet
    // configurado — ofrecer un boton que apunta a una liga que va a fallar es peor
    // que no ofrecerlo (ver `googleWalletAvailable()`).
    await emailService.sendWalletPassEmail('ana@example.com', { ...BASE, googlePassUrl: null })
    const [m] = cap.sent
    expect(m.html).toMatch(/Guardar en iPhone/)
    expect(m.html).not.toMatch(/Guardar en Android/)
    expect(m.html).not.toContain(BASE.googlePassUrl)
    expect(m.text).toMatch(/Guardar en iPhone/)
    expect(m.text).not.toMatch(/Guardar en Android/)
    expect(m.text).not.toContain(BASE.googlePassUrl)
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
