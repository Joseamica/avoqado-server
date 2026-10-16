// H2 (r2): la bandeja del panel manda `x-online-orders-tray: 1`; si CORS no la permite, el navegador la bloquea en el preflight.
import { getCorsConfig } from '@/config/corsOptions'
import { ONLINE_ORDERS_TRAY_HEADER } from '@/services/online-ordering/constants'

it.each(['development', 'staging', 'production'] as const)('CORS (%s) permite la cabecera de la bandeja abierta', env => {
  expect(getCorsConfig(env).allowedHeaders).toContain(ONLINE_ORDERS_TRAY_HEADER)
})
