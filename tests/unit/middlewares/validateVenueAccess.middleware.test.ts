import { validateVenueAccess } from '../../../src/middlewares/validateVenueAccess.middleware'

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
