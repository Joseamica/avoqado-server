/** App de campo, bloque 3: el panel de la organización lista versiones para instalar en TERMINALES: nunca las de campo. */
import prisma from '@/utils/prismaClient'
import { listAppVersionsForOrg } from '@/services/organization-dashboard/orgTerminals.service'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { appUpdate: { findMany: jest.fn() } } }))

it('listAppVersionsForOrg sólo lista versiones de la TPV', async () => {
  ;(prisma.appUpdate.findMany as jest.Mock).mockResolvedValue([])
  await listAppVersionsForOrg('PRODUCTION')

  expect((prisma.appUpdate.findMany as jest.Mock).mock.calls[0][0].where).toEqual(
    expect.objectContaining({ environment: 'PRODUCTION', isActive: true, platform: 'ANDROID_TPV' }),
  )
})
