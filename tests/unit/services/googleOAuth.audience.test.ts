/** El panel sólo acepta tokens de SU cliente de Google (hz:6bfcd3a1:D1): uno con `aud` del POS no entra. */
const verifyIdToken = jest.fn()
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: (...a: any[]) => verifyIdToken(...a) })),
}))
jest.mock('../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { loginWithGoogle } from '../../../src/services/dashboard/googleOAuth.service'

describe('loginWithGoogle — audiencia', () => {
  it('el panel rechaza un token cuyo aud no es GOOGLE_CLIENT_ID', async () => {
    process.env.GOOGLE_CLIENT_ID = 'cliente-del-panel'
    verifyIdToken.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'))

    await expect(loginWithGoogle('token-con-aud-del-pos', false)).rejects.toThrow()
    expect(verifyIdToken).toHaveBeenCalledWith(expect.objectContaining({ audience: 'cliente-del-panel' }))
  })
})
