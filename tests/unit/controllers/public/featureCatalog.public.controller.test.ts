import express from 'express'
import request from 'supertest'
import { z } from 'zod'
import { validateRequest } from '@/middlewares/validation'
import { getFeatureCatalog } from '@/controllers/public/featureCatalog.public.controller'
import { featureCatalogQuery, listFeatureCatalog } from '@/services/launchCampaigns/featureCatalog.service'
import { registerFeatureTools } from '@/mcp/tools/features'

const app = express()
app.get('/catalog', validateRequest(z.object({ query: featureCatalogQuery })), getFeatureCatalog)
app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.statusCode ?? 500).json({ message: error.message })
})

describe('Catálogo público y MCP', () => {
  it('entrega el mismo catálogo paginado sin autenticación ni datos internos', async () => {
    const res = await request(app).get('/catalog?page=2&pageSize=12').expect(200)
    expect(res.body).toEqual({ success: true, data: listFeatureCatalog({ page: 2, pageSize: 12 }) })
    expect(res.body.data.total).toBe(41)
    expect(JSON.stringify(res.body)).not.toMatch(/stripe|venueId|customerId|PriceCents/)
  })

  it('rechaza páginas manipuladas con un 400 explicado en español', async () => {
    const res = await request(app).get('/catalog?pageSize=10000').expect(400)
    expect(res.body.message).toContain('máximo es 100')
  })

  it('permite buscar en inglés y francés con el mismo contrato', async () => {
    expect((await request(app).get('/catalog?q=invoicing').expect(200)).body.data.items[0].featureCode).toBe('CFDI')
    expect((await request(app).get('/catalog?q=fid%C3%A9lit%C3%A9').expect(200)).body.data.items[0].featureCode).toBe('LOYALTY_PROGRAM')
  })

  it('MCP consulta exactamente el mismo inventario sin presentarlo como una cotización', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }> }>>()
    registerFeatureTools(
      { tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as never) } as never,
      {} as never,
    )
    const out = await handlers.get('feature_catalog')!({ q: 'INVENTORY', pageSize: 1 })
    expect(JSON.parse(out.content[0].text)).toEqual(listFeatureCatalog({ q: 'INVENTORY', pageSize: 1 }))
  })
})
