import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { configureToolCatalog } from '@/mcp/catalog'
import type { McpScope } from '@/mcp/scope'
import { text } from '@/mcp/respond'

async function fixture(staffId = 'staff', org = 'org', versioned = false) {
  const server = new McpServer({ name: 'confirmation-test', version: '1' })
  configureToolCatalog(server, { staffId, activeOrg: org, scopes: ['mcp:read', 'mcp:write'] } as McpScope)
  const write = jest.fn()
  server.tool(
    'set_menu_item_price',
    'Cambiar precio',
    {
      venueId: z.string(),
      name: z.string(),
      price: z.number(),
      expectedSourceFingerprint: z.string().optional(),
      expectedUpdatedAt: z.string().optional(),
      confirm: z.boolean().optional(),
    },
    async args => {
      if (!args.confirm)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { ...args, confirm: undefined },
          ...(versioned ? { expectedSourceFingerprint: 'jornada-actual', expectedUpdatedAt: '2026-09-30T12:00:00Z' } : {}),
        })
      write(args)
      return text({ ok: true })
    },
  )
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    write,
    call: async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: 'set_menu_item_price', arguments: args })
      return JSON.parse((r.content as Array<{ text: string }>)[0].text)
    },
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
const args = { venueId: 'centro', name: 'Café', price: 45.5 }

it('confirm:true sin vista previa no ejecuta; preview → mismo contenido sí ejecuta', async () => {
  const f = await fixture()
  try {
    expect(await f.call({ ...args, confirm: true })).toMatchObject({ needsInput: true })
    expect(f.write).not.toHaveBeenCalled()
    const preview = await f.call(args)
    expect(preview.confirmationToken).toEqual(expect.any(String))
    expect(preview.expiresInSeconds).toBe(600)
    expect(await f.call({ ...args, confirm: true, confirmationToken: preview.confirmationToken })).toMatchObject({ ok: true })
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write.mock.calls[0][0]).not.toHaveProperty('confirmationToken')
  } finally {
    await f.close()
  }
})

it('un preview no autoriza otra sucursal, importe, persona ni organización', async () => {
  const f = await fixture()
  const otherStaff = await fixture('other')
  const otherOrg = await fixture('staff', 'other-org')
  try {
    const preview = await f.call(args)
    const confirmation = { ...args, confirm: true, confirmationToken: preview.confirmationToken }
    for (const altered of [
      { ...confirmation, venueId: 'norte' },
      { ...confirmation, price: 1 },
    ])
      expect(await f.call(altered)).toMatchObject({ needsInput: true })
    expect(await otherStaff.call(confirmation)).toMatchObject({ needsInput: true })
    expect(await otherOrg.call(confirmation)).toMatchObject({ needsInput: true })
    expect(f.write).not.toHaveBeenCalled()
    expect(otherStaff.write).not.toHaveBeenCalled()
    expect(otherOrg.write).not.toHaveBeenCalled()
  } finally {
    await f.close()
    await otherStaff.close()
    await otherOrg.close()
  }
})

it('el preview vence a los diez minutos', async () => {
  const f = await fixture()
  try {
    const preview = await f.call(args)
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000)
    try {
      expect(await f.call({ ...args, confirm: true, confirmationToken: preview.confirmationToken })).toMatchObject({ needsInput: true })
    } finally {
      clock.mockRestore()
    }
    expect(f.write).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

it('liga también los campos de versión DEVUELTOS por el preview existente', async () => {
  const f = await fixture('staff', 'org', true)
  try {
    const p = await f.call(args)
    expect(
      await f.call({
        ...args,
        confirm: true,
        confirmationToken: p.confirmationToken,
        expectedSourceFingerprint: p.expectedSourceFingerprint,
        expectedUpdatedAt: p.expectedUpdatedAt,
      }),
    ).toMatchObject({ ok: true })
    expect(f.write).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
})
