import cuid from 'cuid'
import prisma from '../../utils/prismaClient'
import emailService from '../email.service'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'

const escape = (value: string) =>
  value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
type Snapshot = { id: string; version: number; provider: string; entityType: string }
export function notificationEmail(snapshot: Snapshot) {
  const url = `${(process.env.SUPERADMIN_URL || 'https://superadmin.avoqado.io').replace(/\/$/, '')}/document-requests/${encodeURIComponent(snapshot.id)}`
  const title = 'Documentos de afiliación recibidos'
  return {
    subject: title,
    text: `${title}\nProcesador: ${snapshot.provider}\nTipo: ${snapshot.entityType}\nEntrega: ${snapshot.version}\nRevisar en el panel interno: ${url}`,
    html: `<!doctype html><html><body style="background:#ffffff;color:#000000;font-family:Arial,sans-serif;line-height:1.6"><div style="max-width:600px;margin:0 auto;padding:32px 24px"><img src="https://avoqado.io/isotipo.svg" alt="Avoqado" width="32" height="32"><h1 style="font-size:28px;font-weight:400">${title}</h1><h2 style="font-size:13px;font-weight:600;color:#666;letter-spacing:0.5px;text-transform:uppercase">Expediente recibido</h2><table style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden"><tr><td style="width:160px;color:#666;font-size:13px">Procesador</td><td style="font-size:14px;color:#000">${escape(snapshot.provider)}</td></tr><tr><td style="width:160px;color:#666;font-size:13px">Tipo</td><td style="font-size:14px;color:#000">${escape(snapshot.entityType)}</td></tr><tr><td style="width:160px;color:#666;font-size:13px">Entrega</td><td>${snapshot.version}</td></tr></table><p><a href="${escape(url)}" style="display:inline-block;background-color:#000000;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none">Revisar documentos</a></p><p>Los archivos y datos de contacto se consultan únicamente dentro del panel.</p><img src="https://avoqado.io/isotipo.svg" alt="Avoqado" width="24" height="24"><p style="color:#666;font-size:12px">Servicios Tecnologicos Avo S.A. de C.V. · <a href="https://avoqado.io/privacy">Privacidad</a></p></div></body></html>`,
  }
}
export async function deliverNotifications(now = new Date()) {
  const rows = await retry(
    () =>
      prisma.documentRequestDelivery.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        take: 20,
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'document-requests.notifications' },
  )
  for (const row of rows) {
    const lease = cuid()
    const claim = await prisma.documentRequestDelivery.updateMany({
      where: { id: row.id, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      data: {
        leaseToken: lease,
        leaseUntil: new Date(now.getTime() + 5 * 60000),
        attempts: { increment: 1 },
        firstAttemptAt: row.firstAttemptAt || now,
      },
    })
    if (!claim.count) continue
    const fence = { id: row.id, status: 'PENDING', leaseToken: lease }
    let state = 'PENDING',
      nextAttemptAt: Date | null = new Date(now.getTime() + Math.min(3600000, 30000 * 2 ** Math.min(8, row.attempts)))
    const snapshot = row.snapshot as Snapshot | null
    // Resend keys expire after 24h from first attempt, not from creating the submission.
    if (row.firstAttemptAt && now.getTime() - row.firstAttemptAt.getTime() > 23 * 3600000) {
      state = 'UNKNOWN'
      nextAttemptAt = null
    } else if (!snapshot || snapshot.version !== row.submissionVersion || snapshot.id !== row.requestId) {
      state = 'FAILED'
      nextAttemptAt = null
    } else {
      const result = await emailService.sendEmailWithResult({
        ...notificationEmail(snapshot),
        to: row.recipient,
        idempotencyKey: `document-request/${row.requestId}/${row.submissionVersion}/${row.recipient === 'daniel@avoqado.io' ? 'daniel' : 'onboarding'}`,
      })
      if (result.ok || !result.transient) {
        state = result.ok ? 'SENT' : 'FAILED'
        nextAttemptAt = null
      }
    }
    await prisma.$transaction(async tx => {
      const changed = await tx.documentRequestDelivery.updateMany({
        where: fence,
        data: { status: state, nextAttemptAt, leaseToken: null, leaseUntil: null },
      })
      if (changed.count)
        await tx.documentRequest.updateMany({
          where: { id: row.requestId, submissionVersion: row.submissionVersion },
          data: {
            [row.recipient === 'daniel@avoqado.io' ? 'danielNotification' : 'onboardingNotification']: state,
            notificationAttempts: { increment: 1 },
            notificationNextAt: nextAttemptAt,
          },
        })
    })
  }
}
