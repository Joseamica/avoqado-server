import { validateVenueAccess, requireVenueMembership } from '../../../src/middlewares/validateVenueAccess.middleware'
import { resolveUserRoleForVenue } from '../../../src/middlewares/checkPermission.middleware'

jest.mock('../../../src/middlewares/checkPermission.middleware', () => ({
  resolveUserRoleForVenue: jest.fn(),
}))

const mockResolve = resolveUserRoleForVenue as jest.MockedFunction<typeof resolveUserRoleForVenue>

describe('validateVenueAccess', () => {
  const res = () => {
    const r: any = {}
    r.status = jest.fn().mockReturnValue(r)
    r.json = jest.fn().mockReturnValue(r)
    return r
  }

  it('deja pasar cuando el venueId de la URL es el del token', () => {
    const req: any = { params: { venueId: 'venue-a' }, authContext: { venueId: 'venue-a' } }
    const next = jest.fn()

    validateVenueAccess(req, res(), next)

    expect(next).toHaveBeenCalled()
  })

  it('rechaza con 403 cuando el venueId de la URL es de OTRO venue', () => {
    // 🔴 El bug: con un token del venue A se podia operar sobre el venue B.
    const req: any = { params: { venueId: 'venue-b' }, authContext: { venueId: 'venue-a' } }
    const next = jest.fn()
    const r = res()

    validateVenueAccess(req, r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(403)
  })

  it('rechaza con 403 cuando el venueId de la URL EXTIENDE al del token (pin de igualdad estricta, no prefijo)', () => {
    // Blinda contra un futuro refactor a startsWith/includes/comparación normalizada:
    // 'venue-a' y 'venue-a-2' comparten prefijo pero son tenants distintos.
    const req: any = { params: { venueId: 'venue-a-2' }, authContext: { venueId: 'venue-a' } }
    const next = jest.fn()
    const r = res()

    validateVenueAccess(req, r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(403)
  })

  it('rechaza con 401 cuando no hay authContext', () => {
    const req: any = { params: { venueId: 'venue-a' } }
    const next = jest.fn()
    const r = res()

    validateVenueAccess(req, r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(401)
  })
})

/**
 * La variante laxa, para las rutas mobile que no exigen un permiso concreto.
 *
 * Existían sin NINGUNA defensa de venue: `authenticateTokenMiddleware` valida
 * QUIÉN eres, no DÓNDE, y el venueId de la URL llegaba intacto al servicio. Con
 * un token válido de cualquier negocio se leían descuentos, cupones,
 * proveedores, ajustes y comandas de KDS de otro — incluido uno de OTRA
 * organización. Comprobado contra el server real: un staff de la org A recibió
 * íntegra una promoción de un venue de la org B.
 */
describe('requireVenueMembership', () => {
  const res = () => {
    const r: any = {}
    r.status = jest.fn().mockReturnValue(r)
    r.json = jest.fn().mockReturnValue(r)
    return r
  }

  beforeEach(() => mockResolve.mockReset())

  it('deja pasar cuando el staff SÍ trabaja en el venue de la URL', async () => {
    mockResolve.mockResolvedValue({ role: 'WAITER', source: 'staffVenue' } as any)
    const req: any = { params: { venueId: 'venue-b' }, authContext: { userId: 'u1', venueId: 'venue-a' } }
    const next = jest.fn()

    await requireVenueMembership(req, res(), next)

    expect(next).toHaveBeenCalledWith()
  })

  it('rechaza con 403 cuando el staff NO pertenece al venue (fuga entre negocios)', async () => {
    mockResolve.mockResolvedValue({ role: null, source: 'none' } as any)
    const req: any = { params: { venueId: 'venue-de-otra-empresa' }, authContext: { userId: 'u1', venueId: 'venue-a' } }
    const next = jest.fn()
    const r = res()

    await requireVenueMembership(req, r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(403)
  })

  /**
   * A propósito MÁS laxo que `validateVenueAccess`. Un POS cuyo token quedó
   * apuntando a otro local PROPIO (pasaba antes de que el refresh conservara el
   * venue) tiene que seguir vendiendo, no quedarse muerto hasta que alguien
   * vuelva a entrar. Lo que se cierra es ver datos de un negocio ajeno.
   */
  it('NO exige que el venue de la URL sea el del token, sólo pertenencia', async () => {
    mockResolve.mockResolvedValue({ role: 'MANAGER', source: 'staffVenue' } as any)
    const req: any = { params: { venueId: 'otro-local-propio' }, authContext: { userId: 'u1', venueId: 'local-viejo' } }
    const next = jest.fn()
    const r = res()

    await requireVenueMembership(req, r, next)

    expect(next).toHaveBeenCalledWith()
    expect(r.status).not.toHaveBeenCalled()
  })

  it('rechaza con 401 cuando no hay authContext', async () => {
    const req: any = { params: { venueId: 'venue-a' } }
    const next = jest.fn()
    const r = res()

    await requireVenueMembership(req, r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(401)
  })

  it('propaga el error al handler global si la consulta truena (no lo traga como 403)', async () => {
    // Un fallo transitorio de DB no puede leerse como "no tienes acceso": eso
    // sacaría al mesero de una pantalla legítima con un mensaje falso.
    const boom = new Error('P2024 pool timeout')
    mockResolve.mockRejectedValue(boom)
    const req: any = { params: { venueId: 'venue-a' }, authContext: { userId: 'u1', venueId: 'venue-a' } }
    const next = jest.fn()
    const r = res()

    await requireVenueMembership(req, r, next)

    expect(next).toHaveBeenCalledWith(boom)
    expect(r.status).not.toHaveBeenCalled()
  })
})
