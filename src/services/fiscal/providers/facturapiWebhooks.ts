import Facturapi from 'facturapi'

/** Un webhook tal como lo lista Facturapi. El secreto NO viene aquí: sólo se entrega al crearlo. */
export interface WebhookDeFacturapi {
  id: string
  url: string
  status: string
  enabledEvents: string[]
}

/** Lo que el servicio necesita de Facturapi para administrar el webhook de UNA organización. */
export interface ClienteDeWebhooks {
  listar: () => Promise<WebhookDeFacturapi[]>
  /** Devuelve el secreto, que Facturapi entrega una sola vez (medido en su sandbox el 24-sep-2026). */
  crear: (url: string, eventos: readonly string[]) => Promise<{ id: string; secret: string | null }>
  borrar: (id: string) => Promise<void>
}

/** Cliente de webhooks con la llave de la ORGANIZACIÓN (live o test). La de cuenta (`sk_user_`) no sirve aquí. */
export function clienteDeWebhooksDeFacturapi(apiKey: string): ClienteDeWebhooks {
  const client = new Facturapi(apiKey)
  return {
    listar: async () => {
      const res: any = await client.webhooks.list({ limit: 50 })
      return (res?.data ?? []).map((w: any) => ({
        id: String(w.id),
        url: String(w.url),
        status: String(w.status),
        enabledEvents: Array.isArray(w.enabled_events) ? w.enabled_events.map(String) : [],
      }))
    },
    crear: async (url, eventos) => {
      const w: any = await client.webhooks.create({ url, enabled_events: [...eventos] })
      return { id: String(w.id), secret: typeof w.secret === 'string' && w.secret.length > 0 ? w.secret : null }
    },
    borrar: async id => {
      await client.webhooks.del(id)
    },
  }
}
