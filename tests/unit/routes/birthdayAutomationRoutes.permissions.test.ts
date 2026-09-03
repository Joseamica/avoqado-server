/**
 * El permiso del PUT depende del CUERPO, y ésa es toda la sustancia de este archivo.
 *
 * 🔴 Editar el texto de la felicitación es `marketing:manage`. **Encenderla es autorizar
 * envíos recurrentes a los clientes del negocio**, así que pide `marketing:send` — el mismo
 * permiso que publicar una campaña. Con un permiso genérico, quien sólo puede redactar
 * podría poner a mandar correos todos los días.
 *
 * **Apagarla se queda en `:manage`**, a propósito: parar nunca puede ser más difícil que
 * arrancar. Si apagar exigiera el permiso alto, un negocio con el encargado de marketing de
 * vacaciones no podría detener un envío que está haciendo daño.
 *
 * Monta el router REAL con el `checkPermission` REAL detrás de un authContext inyectado.
 */
import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

// `checkPermission` resuelve el rol EFECTIVO contra la base (no confía en el del token) y
// mira si el venue tiene permisos personalizados. Aquí se le da un staffVenue activo con el
// rol bajo prueba y sin overrides: así lo que decide es el catálogo de permisos real, que
// es justo lo que estas pruebas quieren ejercitar.
const rolEnLaBase = { valor: 'OWNER' }
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: {
      findUnique: jest.fn(async () => ({ role: rolEnLaBase.valor, active: true, permissionSetId: null, permissionSet: null })),
      findFirst: jest.fn(async () => null),
    },
    venue: { findUnique: jest.fn(async () => ({ id: 'clv1000000000000000000000', organizationId: 'org_1' })) },
    staffOrganization: { findUnique: jest.fn(async () => null) },
    venueRolePermission: { findUnique: jest.fn(async () => null) },
  },
}))

// El servicio no es el sujeto: cualquier handler contesta 200.
jest.mock('@/controllers/dashboard/birthdayAutomation.dashboard.controller', () => ({
  getBirthdayAutomation: (_req: any, res: any) => res.json({ ok: true }),
  putBirthdayAutomation: (_req: any, res: any) => res.json({ ok: true }),
}))

import birthdayAutomationRoutes from '@/routes/dashboard/birthdayAutomation.routes'



const VENUE = 'clv1000000000000000000000'
const URL = `/api/v1/dashboard/venues/${VENUE}/birthday-automation`

/** Monta la app con un rol concreto: `checkPermission` resuelve contra los defaults reales. */
function app(role: string) {
  const a = express()
  a.use(express.json())
  a.use((req: any, _res, next) => {
    req.authContext = { userId: 'user_1', venueId: VENUE, orgId: 'org_1', role }
    next()
  })
  a.use('/api/v1/dashboard/venues/:venueId/birthday-automation', birthdayAutomationRoutes)
  return a
}

const cuerpo = (activa: boolean) => ({
  subject: '¡Feliz cumpleaños!',
  bloques: [{ type: 'paragraph', text: 'Que lo pases increíble.' }],
  daysBefore: 7,
  activa,
})

let servers: Server[] = []
function servidor(role: string) {
  rolEnLaBase.valor = role
  const s = app(role).listen(0)
  servers.push(s)
  return s
}
afterAll(() => {
  servers.forEach(s => s.close())
})

describe('felicitación de cumpleaños — el permiso depende de si se ENCIENDE', () => {
  it('un OWNER puede encenderla', async () => {
    const res = await request(servidor('OWNER')).put(URL).send(cuerpo(true))
    expect(res.status).toBe(200)
  })

  it('🔴 un rol de PISO no puede encenderla', async () => {
    // Un cajero tiene `marketing:read` (para ver el aviso de privacidad). Eso no puede
    // convertirse en «puede poner a mandar correos todos los días».
    const res = await request(servidor('CASHIER')).put(URL).send(cuerpo(true))
    expect(res.status).toBe(403)
  })

  it('🔴 un rol de piso tampoco puede EDITARLA', async () => {
    const res = await request(servidor('CASHIER')).put(URL).send(cuerpo(false))
    expect(res.status).toBe(403)
  })

  it('un rol de piso tampoco puede LEER la configuración', async () => {
    const res = await request(servidor('WAITER')).get(URL)
    expect(res.status).toBe(403)
  })

  it('un OWNER sí la lee', async () => {
    const res = await request(servidor('OWNER')).get(URL)
    expect(res.status).toBe(200)
  })

  it('🔴 un cuerpo inválido se rechaza ANTES de decidir el permiso', async () => {
    // El orden importa: el permiso se decide leyendo `activa`, así que el cuerpo tiene que
    // estar validado antes. Sin eso, un `activa: "true"` de TEXTO no sería `=== true` y
    // bajaría el candado al permiso menor.
    const res = await request(servidor('OWNER')).put(URL).send({ subject: '', bloques: [], daysBefore: 999, activa: 'true' })
    expect(res.status).toBe(400)
  })
})
