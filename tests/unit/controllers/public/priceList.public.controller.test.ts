jest.mock('@/services/launchCampaigns/publicPriceList.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/publicPriceList.service'),
  getPublicPriceList: jest.fn(),
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendPriceSelectionEmail: jest.fn() } }))
import express from 'express'
import request from 'supertest'
import { getPublicPriceList, type PublicPriceList } from '@/services/launchCampaigns/publicPriceList.service'
import emailService from '@/services/email.service'
import publicRoutes from '@/routes/public.routes'

const LIST: PublicPriceList = {
  plans: [{ tier: 'PRO', name: 'Pro', price: 1158.84 }],
  features: [
    { id: 'LOYALTY_PROGRAM', name: 'Programa de lealtad', description: '', category: 'customers', categoryLabel: 'Clientes', requirement: null, requires: [], kind: 'SUELTA', price: 349, includedIn: ['PRO'] },
    { id: 'CFDI', name: 'Facturación CFDI', description: '', category: 'money', categoryLabel: 'Dinero y reportes', requirement: null, requires: [], kind: 'SUELTA', price: 229, includedIn: [] },
  ],
}

const app = express()
app.use(express.json())
app.use('/public', publicRoutes)
app.use((error: { statusCode?: number; message: string; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
})

const send = emailService.sendPriceSelectionEmail as jest.Mock
let ip = 0
// Each case from its own visitor: the 5/min write limit is per real IP.
const post = (body: unknown) => request(app).post('/public/price-list/selection').set('CF-Connecting-IP', `10.0.0.${++ip}`).send(body as object)

beforeEach(() => {
  ;(getPublicPriceList as jest.Mock).mockResolvedValue(LIST)
  send.mockReset().mockResolvedValue(true)
})

describe('Presentación de precios — rutas públicas', () => {
  it('GET entrega la lista viva con caché de 60 s', async () => {
    const res = await request(app).get('/public/price-list').expect(200)
    expect(res.body).toEqual({ success: true, data: LIST })
    expect(res.headers['cache-control']).toBe('public, max-age=60')
  })

  it('sin nombre ni teléfono responde 400 en español y no manda correo', async () => {
    const res = await post({ ids: ['CFDI'] }).expect(400)
    expect(JSON.stringify(res.body)).toContain('Escribe tu nombre o tu teléfono')
    expect(send).not.toHaveBeenCalled()
  })

  it('módulos que no son lista responden 400 en español', async () => {
    expect(JSON.stringify((await post({ nombre: 'Juana', ids: 'CFDI' }).expect(400)).body)).toContain('Elige al menos un módulo')
  })

  it('sin módulos responde 400', async () => {
    expect(JSON.stringify((await post({ nombre: 'Juana', ids: [] }).expect(400)).body)).toContain('Elige al menos un módulo')
  })

  it('un módulo que ya no está a la venta responde PRICE_LIST_CHANGED y no manda correo', async () => {
    const res = await post({ nombre: 'Juana', ids: ['UPSELL'] }).expect(400)
    expect(res.body.code).toBe('PRICE_LIST_CHANGED')
    expect(send).not.toHaveBeenCalled()
  })

  it('manda UN correo a onboarding con la cuenta del servidor, ignorando precios del navegador', async () => {
    const res = await post({ nombre: 'Juana', telefono: '55 1234 5678', ids: ['LOYALTY_PROGRAM', 'CFDI'], price: 1, total: 1 }).expect(200)
    expect(res.body.data).toEqual({ best: { kind: 'SUELTO', totalCents: 57800, extras: [] }, savingsCents: 0, chosen: ['LOYALTY_PROGRAM', 'CFDI'] })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('onboarding@avoqado.io')
    expect(send.mock.calls[0][1]).toMatchObject({ nombre: 'Juana', telefono: '55 1234 5678', whatsappUrl: 'https://wa.me/525512345678' })
  })

  it('si el correo no sale responde 502 para que la página deje reintentar', async () => {
    send.mockResolvedValue(false)
    const res = await post({ telefono: '5512345678', ids: ['CFDI'] })
    expect([res.status, res.body]).toEqual([502, expect.objectContaining({ code: 'PRICE_SELECTION_NOT_SENT' })])
  })
})

describe('Correo de la selección', () => {
  it('escapa el nombre en el cuerpo y lo deja en UNA línea en el asunto', async () => {
    const real = jest.requireActual('@/services/email.service').default
    const spy = jest.spyOn(real, 'sendEmail').mockResolvedValue(true)
    const { priceSelection } = jest.requireActual('@/services/launchCampaigns/publicPriceList.service')
    await real.sendPriceSelectionEmail('onboarding@avoqado.io', {
      nombre: '<b>Juana</b>\nBcc: x@evil.com',
      telefono: null,
      whatsappUrl: null,
      pageUri: null,
      selection: priceSelection(LIST, ['LOYALTY_PROGRAM', 'CFDI']),
    })
    const { subject, html } = spy.mock.calls[0][0] as { subject: string; html: string }
    expect(subject).not.toMatch(/[\r\n]/)
    expect(subject).toContain('2 módulos · $578.00/mes')
    expect(html).toContain('&lt;b&gt;Juana&lt;/b&gt;')
    expect(html).not.toContain('<b>Juana</b>')
  })

  it('el botón nunca apunta a una página que mande el visitante', async () => {
    const real = jest.requireActual('@/services/email.service').default
    const spy = jest.spyOn(real, 'sendEmail').mockResolvedValue(true)
    const { priceSelection } = jest.requireActual('@/services/launchCampaigns/publicPriceList.service')
    await real.sendPriceSelectionEmail('onboarding@avoqado.io', {
      nombre: 'Juana',
      telefono: null,
      whatsappUrl: null,
      pageUri: 'https://captura.example/iniciar-sesion',
      selection: priceSelection(LIST, ['CFDI']),
    })
    const { html, text } = spy.mock.calls[spy.mock.calls.length - 1][0] as { html: string; text: string }
    expect(html).toContain('href="https://dashboard.avoqado.io/presentacion/precios"')
    expect(html + text).not.toContain('captura.example')
  })
})
