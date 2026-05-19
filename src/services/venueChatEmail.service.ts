import logger from '@/config/logger'
import emailService from '@/services/email.service'
import prisma from '@/utils/prismaClient'

const HOSTED_BOOKING_BASE = process.env.PUBLIC_BOOKING_BASE_URL ?? 'https://book.avoqado.io'

// Customer is considered "present" if they polled with visible=true within the
// last 90s — no need to wake them up with an email. Re-tested per call.
const RECENTLY_SEEN_MS = 90_000

// Throttle email notifications per session: at most one every 4 hours, no
// matter how many venue replies arrive. Prevents notification spam if the
// venue sends a flurry of short replies.
const EMAIL_THROTTLE_MS = 4 * 3600 * 1000

// Decide whether to send a "you have a reply" email after an
// INBOUND_FROM_VENUE message has been persisted (Phase 7 spec). Per design:
//   • customerEmail must be set
//   • lastCustomerSeenAt must be older than 90s (or NULL)
//   • lastEmailNotifiedAt must be older than 4h (or NULL)
//
// Email link uses URL FRAGMENT (#chat-resume=<sessionId>) — the widget reads
// it client-side and calls POST /resume with the customer's email to mint a
// fresh accessToken. We never put the raw token in the email because the DB
// only stores its hash (cannot be reconstructed).
export async function maybeSendVenueReplyEmail(sessionId: string): Promise<void> {
  const session = await prisma.venueChatSession.findUnique({
    where: { id: sessionId },
    include: { venue: { select: { name: true, slug: true } } },
  })
  if (!session || !session.customerEmail) return

  const now = Date.now()
  if (session.lastCustomerSeenAt && now - session.lastCustomerSeenAt.getTime() < RECENTLY_SEEN_MS) {
    return
  }
  if (session.lastEmailNotifiedAt && now - session.lastEmailNotifiedAt.getTime() < EMAIL_THROTTLE_MS) {
    return
  }

  const url = `${HOSTED_BOOKING_BASE}/${session.venue.slug}/appointments#chat-resume=${sessionId}`
  const venueName = session.venue.name
  const customerName = session.customerName

  const subject = `Tienes una respuesta de ${venueName}`
  const html = buildHtml({ customerName, venueName, url })
  const text = buildText({ customerName, venueName, url })

  try {
    const ok = await emailService.sendEmail({ to: session.customerEmail, subject, html, text })
    if (!ok) {
      logger.warn('[VenueChatEmail] emailService.sendEmail returned false', { sessionId, to: session.customerEmail })
      return
    }
  } catch (err) {
    logger.error('[VenueChatEmail] sendEmail threw', { sessionId, to: session.customerEmail, err })
    return
  }

  await prisma.venueChatSession.update({
    where: { id: sessionId },
    data: { lastEmailNotifiedAt: new Date() },
  })
  logger.info('[VenueChatEmail] Venue reply email sent', { sessionId, to: session.customerEmail })
}

function buildHtml(p: { customerName: string; venueName: string; url: string }): string {
  return `<!doctype html>
<html lang="es"><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;">Hola ${escapeHtml(p.customerName)},</h2>
  <p style="margin:0 0 16px;">${escapeHtml(p.venueName)} respondió a tu conversación.</p>
  <p style="margin:0 0 24px;">
    <a href="${p.url}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:8px;">Ver respuesta</a>
  </p>
  <p style="margin:0 0 8px;color:#555;font-size:13px;">Si el botón no abre, copia y pega este enlace en tu navegador:</p>
  <p style="margin:0;color:#555;font-size:13px;word-break:break-all;">${p.url}</p>
</body></html>`
}

function buildText(p: { customerName: string; venueName: string; url: string }): string {
  return `Hola ${p.customerName},

${p.venueName} respondió a tu conversación.

Ver respuesta: ${p.url}
`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}
