import express from 'express'
import request from 'supertest'
const mockRouting = jest.fn()
jest.mock('@/services/dashboard/printStation.dashboard.service', () => ({ getRouting: (...args: unknown[]) => mockRouting(...args) }))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
import routes from '@/routes/dashboard/printStation.routes'
const app = express()
app.use('/venues/:venueId/print-stations', routes)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message }))
beforeEach(() => mockRouting.mockReset().mockResolvedValue({ categories: [], products: [], hasDefault: false, unroutedCategories: 0 }))
it('canonical middleware parses routing query before controller and retains legacy defaults', async () => {
  expect(
    (await request(app).get('/venues/v1/print-stations/routing?section=products&page=2&pageSize=10&search=caf&categoryId=c1')).status,
  ).toBe(200)
  expect(mockRouting).toHaveBeenCalledWith('v1', { section: 'products', page: 2, pageSize: 10, search: 'caf', categoryId: 'c1' })
  expect((await request(app).get('/venues/v2/print-stations/routing')).status).toBe(200)
  expect(mockRouting).toHaveBeenLastCalledWith('v2', { page: 1, pageSize: 50 })
})
it.each(['page=NaN', 'page=1.5', 'page=-1', 'pageSize=101', 'pageSize=0', 'section=bad', `search=${'x'.repeat(101)}`])(
  'rejects %s with Spanish validation before querying',
  async query => {
    const response = await request(app).get(`/venues/v1/print-stations/routing?${query}`)
    expect(response.status).toBe(400)
    expect(response.body.message).toContain('Error de validación')
    expect(mockRouting).not.toHaveBeenCalled()
  },
)
