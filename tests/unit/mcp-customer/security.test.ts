import express from 'express'
import request from 'supertest'
import { mountMcpSecurity } from '@/mcp/security'

function app() {
  const a = express()
  mountMcpSecurity(a)
  a.post('/mcp', (_q, r) => r.json({ ok: true }))
  a.post('/mcp-oauth/approve', (_q, r) => r.sendStatus(200))
  a.get('/authorize', (_q, r) => r.send('login'))
  return a
}

it('bloquea Origin ajeno y null, sin bloquear clientes nativos ni los hosts oficiales', async () => {
  const a = app()
  await request(a).post('/mcp').set('Origin', 'https://attacker.example').expect(403)
  await request(a).post('/mcp').set('Origin', 'null').expect(403)
  await request(a).post('/mcp').expect(200)
  await request(a).post('/mcp').set('Origin', 'https://chatgpt.com').expect(200)
  await request(a).post('/mcp').set('Origin', 'https://claude.ai').expect(200)
})

it('aplica headers antes de autenticación, también en el consentimiento OAuth', async () => {
  const a = app()
  const result = await request(a).get('/authorize').expect(200)
  expect(result.headers['cache-control']).toBe('no-store')
  expect(result.headers['referrer-policy']).toBe('no-referrer')
  expect(result.headers['x-content-type-options']).toBe('nosniff')
  expect(result.headers['content-security-policy']).toMatch(/script-src 'sha256-/)
  expect((await request(a).post('/mcp')).headers['cache-control']).toBe('no-store')
})

it('limita los intentos de consentimiento antes de verificar contraseñas', async () => {
  const a = app()
  for (let i = 0; i < 30; i++) await request(a).post('/mcp-oauth/approve').expect(200)
  const blocked = await request(a).post('/mcp-oauth/approve').expect(429)
  expect(blocked.headers['retry-after']).toBeDefined()
})
