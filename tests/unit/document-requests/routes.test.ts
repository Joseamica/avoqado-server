import 'express-async-errors'
import express from 'express'
import request from 'supertest'
import cors from 'cors'
import { getCorsConfig } from '../../../src/config/corsOptions'
jest.mock('../../../src/services/document-requests/documentRequests.service', () => ({
  admitUpload: jest.fn(),
  releaseUpload: jest.fn(),
  getPublicRequest: jest.fn(),
  uploadDocument: jest.fn(),
  deleteDocument: jest.fn(),
  submitRequest: jest.fn(),
}))
import * as service from '../../../src/services/document-requests/documentRequests.service'
import router from '../../../src/routes/public/documentRequests.routes'
const app = express()
app.use(cors(getCorsConfig('development')))
app.use(express.json())
app.use('/document-requests', router)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }))
describe('public upload boundary', () => {
  test('real OPTIONS permits document token', async () => {
    const response = await request(app)
      .options('/document-requests/c1234567890123456789012345')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-Document-Token,Content-Type')
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-headers'].toLowerCase()).toContain('x-document-token')
  })
  test('invalid token fails before multer inspects oversized multipart', async () => {
    ;(service.admitUpload as jest.Mock).mockRejectedValue(Object.assign(new Error('Enlace no disponible'), { statusCode: 404 }))
    const response = await request(app)
      .post('/document-requests/c1234567890123456789012345/documents/identification')
      .set('X-Document-Token', 'bad')
      .attach('file', Buffer.from('bad'), 'a.pdf')
    expect(response.status).toBe(404)
    expect(service.uploadDocument).not.toHaveBeenCalled()
  })
})

test('aborted request while admission waits releases the eventual durable lease', async () => {
  const http = require('http') as typeof import('http')
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let admitted!: (value: any) => void, entered!: () => void
  const signal = new Promise<void>(resolve => {
    entered = resolve
  })
  ;(service.admitUpload as jest.Mock).mockImplementationOnce(() => {
    entered()
    return new Promise(resolve => {
      admitted = resolve
    })
  })
  ;(service.releaseUpload as jest.Mock).mockResolvedValue(undefined)
  const address = server.address() as import('net').AddressInfo
  const incoming = http.request({
    host: '127.0.0.1',
    port: address.port,
    path: '/document-requests/c1234567890123456789012345/documents/identification',
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=qa', 'Content-Length': '1024', 'X-Document-Token': 'ab'.repeat(32) },
  })
  incoming.on('error', () => {})
  incoming.write('--qa\r\n')
  await signal
  incoming.destroy()
  await new Promise(resolve => setTimeout(resolve, 10))
  const lease = { lease: 'qa-lease', tokenVersion: 1 }
  admitted(lease)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(service.releaseUpload).toHaveBeenCalledWith('c1234567890123456789012345', lease)
  await new Promise<void>(resolve => server.close(() => resolve()))
})

test('201 waits for durable lease release so the next file can start immediately', async () => {
  let finishRelease!: () => void, started!: () => void
  const signal = new Promise<void>(resolve => {
    started = resolve
  })
  ;(service.admitUpload as jest.Mock).mockResolvedValueOnce({ lease: 'lease', tokenVersion: 1 })
  ;(service.uploadDocument as jest.Mock).mockResolvedValueOnce({ document: { id: 'file' } })
  ;(service.releaseUpload as jest.Mock).mockImplementationOnce(() => {
    started()
    return new Promise<void>(resolve => {
      finishRelease = resolve
    })
  })
  let answered = false
  const pending = request(app)
    .post('/document-requests/c1234567890123456789012345/documents/identification')
    .set('X-Document-Token', 'ab'.repeat(32))
    .field('uploadId', 'c1234567890123456789012345')
    .attach('file', Buffer.from('test'), 'a.pdf')
    .then(response => {
      answered = true
      return response
    })
  await signal
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(answered).toBe(false)
  finishRelease()
  expect((await pending).status).toBe(201)
})
