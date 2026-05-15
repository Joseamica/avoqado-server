/**
 * Google Calendar push-notification channels.
 *
 * `events.watch` subscribes a webhook URL to a calendar's change feed; Google
 * pings the URL whenever events change. Channels expire after at most 7 days,
 * which is why we set `params.ttl = '604800'` (seconds) explicitly: it lets the
 * renewal cron predict when to renew without having to parse Google's response.
 *
 * Important Google quirks the tests pin:
 *   - The `expiration` field in the response is what we MUST persist as
 *     `expiresAt`. Never store our own TTL — Google can shorten the window
 *     unilaterally (e.g. rate-limit driven), and renewing on the wrong clock
 *     leaves us with a dead subscription.
 *   - The request body must NOT include `expiration` — that field is
 *     response-only. Sending it makes Google reject with "Unknown parameter".
 */
import crypto from 'crypto'
import { google } from 'googleapis'

import { buildOAuthClient } from './oauth.service'

export interface SubscribeArgs {
  accessToken: string
  refreshToken: string
  calendarId: string
  webhookUrl: string
}

export interface SubscribeResult {
  channelId: string
  resourceId: string
  token: string
  expiresAt: Date
}

export async function subscribeToCalendar(args: SubscribeArgs): Promise<SubscribeResult> {
  const auth = buildOAuthClient()
  auth.setCredentials({ access_token: args.accessToken, refresh_token: args.refreshToken })
  const calendar = google.calendar({ version: 'v3', auth })

  const channelId = crypto.randomUUID()
  const token = crypto.randomBytes(32).toString('hex')

  const res = await calendar.events.watch({
    calendarId: args.calendarId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: args.webhookUrl,
      token,
      // 7 days = max channel lifetime Google currently supports.
      params: { ttl: '604800' },
    },
  })

  return {
    channelId,
    resourceId: res.data.resourceId!,
    token,
    expiresAt: new Date(Number(res.data.expiration!)),
  }
}

export async function stopChannel(args: {
  accessToken: string
  refreshToken: string
  channelId: string
  resourceId: string
}): Promise<void> {
  const auth = buildOAuthClient()
  auth.setCredentials({ access_token: args.accessToken, refresh_token: args.refreshToken })
  const calendar = google.calendar({ version: 'v3', auth })
  await calendar.channels.stop({
    requestBody: { id: args.channelId, resourceId: args.resourceId },
  })
}
