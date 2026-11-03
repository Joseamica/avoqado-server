/**
 * El trabajo del Gmail del vendedor (fase 2, plan tarea 7): cableado puro — el negocio vive probado en los servicios. Lo
 * que fija: las dos mitades corren aunque una truene, una vuelta lenta no se encima con la siguiente, y nada tumba el proceso.
 */
jest.mock('@/services/crm/email/gmailSend.service', () => ({ reconciliarDesconocidos: jest.fn() }))
jest.mock('@/services/crm/email/gmailReplies.service', () => ({ sincronizarRespuestas: jest.fn() }))

import logger from '@/config/logger'
import { CrmGmailRepliesJob } from '@/jobs/crm-gmail-replies.job'
import { DATABASE_JOB_SCHEDULES } from '@/jobs/jobSchedules'
import { reconciliarDesconocidos } from '@/services/crm/email/gmailSend.service'
import { sincronizarRespuestas } from '@/services/crm/email/gmailReplies.service'

const reconciliar = reconciliarDesconocidos as jest.Mock
const sincronizar = sincronizarRespuestas as jest.Mock
const AHORA = new Date('2026-11-03T18:00:00.000Z')

beforeEach(() => {
  reconciliar.mockReset().mockResolvedValue(undefined)
  sincronizar.mockReset().mockResolvedValue(undefined)
})

it('cada 5 min en el segundo :42, que no usa ningún otro job de la base', () => {
  expect(DATABASE_JOB_SCHEDULES.crmGmailReplies).toBe('42 */5 * * * *')
  const otros = Object.entries(DATABASE_JOB_SCHEDULES)
    .filter(([nombre]) => nombre !== 'crmGmailReplies')
    .flatMap(([, patron]) => patron.split(' ')[0].split(','))
  expect(otros).not.toContain('42')
})

it('reconcilia y luego lee respuestas, con la misma hora', async () => {
  await new CrmGmailRepliesJob().run(AHORA)
  expect(reconciliar).toHaveBeenCalledWith(AHORA)
  expect(sincronizar).toHaveBeenCalledWith(AHORA)
  expect(reconciliar.mock.invocationCallOrder[0]).toBeLessThan(sincronizar.mock.invocationCallOrder[0])
})

it('si la reconciliación truena, las respuestas se leen igual, y la vuelta no lanza', async () => {
  reconciliar.mockRejectedValue(new Error('P1001'))
  await expect(new CrmGmailRepliesJob().run(AHORA)).resolves.toBeUndefined()
  expect(sincronizar).toHaveBeenCalled()
  expect(logger.error).toHaveBeenCalledWith('[CRM] The Gmail reconciliation tick failed', { error: 'P1001' })
})

it('una vuelta lenta no se encima con la siguiente', async () => {
  let soltar!: () => void
  reconciliar.mockImplementation(() => new Promise<void>(r => (soltar = r)))
  const job = new CrmGmailRepliesJob()
  const primera = job.run(AHORA)
  await job.run(AHORA)
  expect(reconciliar).toHaveBeenCalledTimes(1)
  soltar()
  await primera
  expect(sincronizar).toHaveBeenCalledTimes(1)
})
