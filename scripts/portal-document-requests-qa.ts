/** Local-only QA harness: real disposable Postgres; Storage/email never leave this process. */
import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import { PrismaClient } from '@prisma/client'
import { writeFileSync } from 'fs'

const databaseUrl = process.env.PORTAL_DOCUMENTS_DATABASE_URL
if (
  !databaseUrl ||
  new URL(databaseUrl).pathname !== '/avoqado_portaldocs_test_20261017' ||
  !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)
)
  throw new Error('Set PORTAL_DOCUMENTS_DATABASE_URL to the disposable portal database')
const db = new PrismaClient({ datasourceUrl: databaseUrl })
const objects = new Map<string, { buffer: Buffer; type: string }>()
let failNextStorage = false
const base = 'http://127.0.0.1:4117'
const stub = (modulePath: string, exports: unknown) => {
  require.cache[require.resolve(modulePath)] = { exports } as NodeModule
}
stub('../src/config/env', { FRONTEND_URL: process.env.PORTAL_DOCUMENTS_FRONTEND_URL || 'http://localhost:5173' })
stub('../src/utils/prismaClient', { __esModule: true, default: db })
stub('../src/services/privateStorage.service', {
  buildPrivateFilePath: (scope: string, name: string) => `private/dev/${scope}/${name}`,
  savePrivateFileAtPath: async (path: string, buffer: Buffer, type: string) => {
    if (failNextStorage) {
      failNextStorage = false
      throw new Error('QA Storage unavailable')
    }
    if (objects.has(path)) throw Object.assign(new Error('Already stored'), { code: 412 })
    objects.set(path, { buffer, type })
  },
  deletePrivateFile: async (path: string) => {
    objects.delete(path)
  },
  signPrivateAttachmentUrl: async (path: string) => `${base}/__qa/download?path=${encodeURIComponent(path)}`,
})
stub('../src/services/email.service', {
  __esModule: true,
  default: { sendEmailWithResult: async () => ({ ok: true, transient: false, resendId: 'qa-local' }) },
})
// No actual sockets/jobs are started by this harness.
stub('../src/communication/sockets/managers/socketManager', { socketManager: { broadcastToRole: () => {} } })
const service =
  require('../src/services/document-requests/documentRequests.service') as typeof import('../src/services/document-requests/documentRequests.service')
const app = express()
app.use(require('../src/middlewares/requestLogger').requestLoggerMiddleware)
app.use(cors({ origin: true, credentials: true, allowedHeaders: ['Content-Type', 'X-Document-Token', 'Authorization'] }))
app.use(express.json())
app.post('/__qa/fail-next-storage', (_req, res) => {
  failNextStorage = true
  res.json({ success: true })
})
app.use('/api/v1/public/document-requests', require('../src/routes/public/documentRequests.routes').default)
app.use('/api/v1/superadmin/document-requests', require('../src/routes/superadmin/documentRequests.routes').default)
app.get('/__qa/download', (req, res) => {
  const object = objects.get(String(req.query.path))
  if (!object) {
    res.sendStatus(404)
    return
  }
  res
    .set({ 'Content-Type': object.type, 'Content-Disposition': 'attachment; filename="document.pdf"', 'Cache-Control': 'no-store' })
    .send(object.buffer)
})
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.statusCode || (error.name === 'ZodError' ? 400 : 500)).json({ message: error.message })
})
async function start() {
  const fixtures = []
  for (const provider of ['ANGELPAY', 'BLUMON'] as const)
    for (const entityType of ['PERSONA_FISICA', 'PERSONA_MORAL'] as const)
      fixtures.push(await service.createRequest({ provider, entityType, businessName: `QA ${provider} ${entityType}` }))
  const fixturePath = process.env.PORTAL_DOCUMENTS_QA_FIXTURES || '/tmp/portal-document-requests-qa-fixtures.json'
  writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2), { mode: 0o600 })
  const server = app.listen(4117, '127.0.0.1', () => {
    process.stdout.write(`Portal QA API: ${base}\nFixtures: ${fixturePath}\nStorage and email are fake; no jobs started.\n`)
  })
  process.once('SIGTERM', () => {
    server.close()
    void db.$disconnect().then(() => process.exit(0))
  })
}
void start().catch(() => {
  process.stderr.write('Portal QA failed to start\n')
  process.exit(1)
})
