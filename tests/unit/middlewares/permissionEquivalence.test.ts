/**
 * El conteo ciego del cajón necesita saber si el llamante puede ver el efectivo esperado
 * SIN cortarle la petición, y `checkPermission` no sirve para eso: su única salida es un
 * 403. Por eso existe `tienePermisoEnVenue`.
 *
 * 🔴 Y por eso existe ESTE archivo. Dos funciones que contestan "¿puede este usuario?" son
 * dos definiciones de permisos, y en este repo así nacieron los permisos que responden
 * distinto según la puerta por la que entres. Estas pruebas corren AMBAS sobre la misma
 * matriz de casos y fallan en cuanto una diga algo distinto de la otra.
 *
 * La única divergencia aceptada, y es deliberada: el override por PIN de gerente
 * (`x-permission-override`). Ese PIN autoriza UNA acción; revelar el esperado no es una
 * acción, es un dato que se quedaría a la vista el resto del turno. Aquí no se manda ese
 * header, así que no interviene en ninguno de los dos lados.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { PERMISO_VER_ESPERADO, tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { prismaMock } from '../../__helpers__/setup'

const VENUE = 'venue-1'
const STAFF = 'staff-1'

interface Caso {
  nombre: string
  rol: string | null
  esSuperadmin?: boolean
  custom?: string[] | null
  denegados?: string[] | null
  esperado: boolean
}

function armar(caso: Caso) {
  ;(prismaMock as any).staffVenue = {
    // `findFirst` es la detección de SUPERADMIN; `findUnique` resuelve el rol en el venue.
    findFirst: jest.fn(async () => (caso.esSuperadmin ? { id: 'sv-superadmin' } : null)),
    findUnique: jest.fn(async () => (caso.rol ? { role: caso.rol, active: true, permissionSetId: null, permissionSet: null } : null)),
  }
  ;(prismaMock as any).venueRolePermission = {
    findUnique: jest.fn(async () =>
      caso.custom || caso.denegados ? { permissions: caso.custom ?? [], deniedPermissions: caso.denegados ?? [] } : null,
    ),
  }
  ;(prismaMock as any).venue = { findUnique: jest.fn(async () => ({ organizationId: 'org-1' })) }
  ;(prismaMock as any).staffOrganization = { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) }
}

function pedido() {
  return {
    authContext: { userId: STAFF, venueId: VENUE, role: 'CASHIER', orgId: 'org-1' },
    params: { venueId: VENUE },
    headers: {},
    query: {},
    method: 'GET',
    originalUrl: `/api/v1/dashboard/venues/${VENUE}/cash-drawer/status`,
    ip: '127.0.0.1',
    get: () => undefined,
  } as any
}

/** Corre el middleware real y traduce su efecto a un booleano. */
async function autorizaElMiddleware(permiso: string): Promise<boolean> {
  const req = pedido()
  let permitido = false
  const res: any = { status: () => ({ json: () => undefined }), json: () => undefined }
  await checkPermission(permiso)(req, res, () => {
    permitido = true
  })
  return permitido
}

const CASOS: Caso[] = [
  { nombre: 'CASHIER no puede ver el esperado', rol: 'CASHIER', esperado: false },
  { nombre: 'WAITER tampoco', rol: 'WAITER', esperado: false },
  { nombre: 'MANAGER sí puede', rol: 'MANAGER', esperado: true },
  { nombre: 'OWNER sí puede', rol: 'OWNER', esperado: true },
  { nombre: 'SUPERADMIN sí puede', rol: 'CASHIER', esManager: false, esSuperadmin: true, esperado: true } as Caso,
  { nombre: 'sin acceso al venue, no', rol: null, esperado: false },
  {
    nombre: 'a un MANAGER se le puede DENEGAR explícitamente',
    rol: 'MANAGER',
    custom: [PERMISO_VER_ESPERADO],
    denegados: [PERMISO_VER_ESPERADO],
    esperado: false,
  },
  {
    nombre: 'a un CASHIER se le puede CONCEDER a mano',
    rol: 'CASHIER',
    custom: [PERMISO_VER_ESPERADO],
    esperado: true,
  },
]

beforeEach(() => jest.clearAllMocks())

describe('tienePermisoEnVenue responde lo mismo que checkPermission', () => {
  for (const caso of CASOS) {
    it(`${caso.nombre} — y las dos implementaciones coinciden`, async () => {
      armar(caso)
      const porLaBandera = await tienePermisoEnVenue(pedido(), PERMISO_VER_ESPERADO)

      armar(caso)
      const porElMiddleware = await autorizaElMiddleware(PERMISO_VER_ESPERADO)

      // Lo que de verdad protege este archivo: que no puedan divergir.
      expect(porLaBandera).toBe(porElMiddleware)
      // Y que además acierten, para que un mock mal armado no las haga coincidir en falso.
      expect(porLaBandera).toBe(caso.esperado)
    })
  }

  // 🔴 Falla CERRADO: si la base truena, se OCULTA el dato. Es el lado seguro aquí,
  // al revés que en un gate de acceso, donde ocultar dejaría a alguien sin trabajar.
  it('un fallo de base oculta el dato en vez de revelarlo', async () => {
    ;(prismaMock as any).staffVenue = {
      findFirst: jest.fn(async () => {
        throw new Error('P2024: pool agotado')
      }),
    }
    await expect(tienePermisoEnVenue(pedido(), PERMISO_VER_ESPERADO)).rejects.toThrow()
  })

  it('sin authContext no revela nada', async () => {
    const req = pedido()
    req.authContext = undefined
    await expect(tienePermisoEnVenue(req, PERMISO_VER_ESPERADO)).resolves.toBe(false)
  })
})
