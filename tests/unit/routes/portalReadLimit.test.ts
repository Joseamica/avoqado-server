import fs from 'fs'
import path from 'path'

/**
 * D10 (founder 16-nov, «~100 por minuto»): las lecturas del portal de la clienta tienen su propio tope de 300 por minuto por
 * visitante (antes compartían `readLimit` de 60: ~20 alumnas por minuto en el WiFi del estudio). Guarda la elección: que el número
 * y las rutas no regresen sin que nadie lo note.
 */
const fuente = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/public.routes.ts'), 'utf8')

it('portalReadLimit = 300 por minuto, llaveado por visitante', () => {
  expect(fuente).toMatch(/const portalReadLimit = rateLimit\(\{ windowMs: 60_000, max: 300, keyGenerator: porVisitante/)
})

it.each([
  '/venues/:venueSlug/info',
  '/venues/:venueSlug/customer/portal',
  '/venues/:venueSlug/credit-packs',
  '/venues/:venueSlug/credit-packs/balance',
  '/venues/:venueSlug/customer/orders',
  '/venues/:venueSlug/customer/gift-cards',
  '/venues/:venueSlug/customer/discounts',
  '/venues/:venueSlug/customer/class-reservations',
])('%s usa portalReadLimit', ruta => {
  expect(fuente).toMatch(new RegExp(`router\\.get\\(\\s*'${ruta.replace(/[/:]/g, m => `\\${m}`)}',\\s*portalReadLimit,`))
})
