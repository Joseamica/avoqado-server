import os from 'node:os'
import { env } from '@/config/env'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { dispatchCurrentStripeWebhookEffects } from '../stripe.webhook.service'
import { createPrismaPlatformWebhookClassificationRepository } from './platformWebhookClassifier.prisma'
import { createPlatformWebhookClassifier } from './platformWebhookClassifier.service'
import { createPlatformWebhookInboxService, createPrismaPlatformWebhookRepository } from './platformWebhookInbox.service'
import { createPlatformWebhookShadowProcessor } from './platformWebhookShadowProcessor.service'

const workerId = `platform-webhook:${env.RENDER_INSTANCE_ID ?? os.hostname()}:${process.pid}`
const inbox = createPlatformWebhookInboxService({
  repository: createPrismaPlatformWebhookRepository(prisma),
  workerId,
})
const classifier = createPlatformWebhookClassifier({
  repository: createPrismaPlatformWebhookClassificationRepository(prisma),
})
const processor = createPlatformWebhookShadowProcessor({
  inbox,
  classifier,
  dispatch: dispatchCurrentStripeWebhookEffects,
  logger,
})

export const platformWebhookRuntime = Object.freeze({
  workerId,
  mode: env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE,
  recoveryEnabled: env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE === 'SHADOW' && env.PLATFORM_WEBHOOK_RECOVERY_ENABLED,
  inbox,
  classifier,
  processor,
})
