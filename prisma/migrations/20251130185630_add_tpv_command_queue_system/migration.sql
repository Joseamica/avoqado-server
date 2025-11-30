-- CreateEnum
CREATE TYPE "public"."TpvCommandType" AS ENUM ('LOCK', 'UNLOCK', 'MAINTENANCE_MODE', 'EXIT_MAINTENANCE', 'REACTIVATE', 'RESTART', 'SHUTDOWN', 'CLEAR_CACHE', 'FORCE_UPDATE', 'SYNC_DATA', 'FACTORY_RESET', 'EXPORT_LOGS', 'UPDATE_CONFIG', 'REFRESH_MENU', 'UPDATE_MERCHANT', 'SCHEDULE', 'GEOFENCE_TRIGGER', 'TIME_RULE');

-- CreateEnum
CREATE TYPE "public"."TpvCommandPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "public"."TpvCommandStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."TpvCommandResultStatus" AS ENUM ('SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'TIMEOUT', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."TpvCommandHistoryStatus" AS ENUM ('SENT', 'ACK_RECEIVED', 'EXECUTION_STARTED', 'COMPLETED', 'FAILED', 'TIMEOUT', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."TpvCommandSource" AS ENUM ('DASHBOARD', 'API', 'SCHEDULED', 'GEOFENCE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "public"."BulkTargetType" AS ENUM ('ALL_VENUE', 'TERMINAL_GROUP', 'TERMINAL_LIST');

-- CreateEnum
CREATE TYPE "public"."BulkErrorAction" AS ENUM ('CONTINUE', 'STOP', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "public"."BulkOperationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL_FAILURE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ScheduleType" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CRON');

-- AlterTable
ALTER TABLE "public"."Terminal" ADD COLUMN     "isLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastLatitude" DOUBLE PRECISION,
ADD COLUMN     "lastLocationAt" TIMESTAMP(3),
ADD COLUMN     "lastLongitude" DOUBLE PRECISION,
ADD COLUMN     "lockMessage" TEXT,
ADD COLUMN     "lockReason" TEXT,
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedBy" TEXT;

-- CreateTable
CREATE TABLE "public"."TpvCommandQueue" (
    "id" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "commandType" "public"."TpvCommandType" NOT NULL,
    "payload" JSONB,
    "priority" "public"."TpvCommandPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "public"."TpvCommandStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "resultStatus" "public"."TpvCommandResultStatus",
    "resultMessage" TEXT,
    "resultPayload" JSONB,
    "duration" INTEGER,
    "requestedBy" TEXT NOT NULL,
    "requestedByName" TEXT,
    "correlationId" TEXT NOT NULL,
    "requiresPin" BOOLEAN NOT NULL DEFAULT false,
    "pinVerifiedAt" TIMESTAMP(3),
    "pinVerifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bulkOperationId" TEXT,

    CONSTRAINT "TpvCommandQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TpvCommandHistory" (
    "id" TEXT NOT NULL,
    "commandQueueId" TEXT,
    "terminalId" TEXT NOT NULL,
    "terminalSerial" TEXT NOT NULL,
    "terminalName" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "venueName" TEXT NOT NULL,
    "commandType" "public"."TpvCommandType" NOT NULL,
    "payload" JSONB,
    "status" "public"."TpvCommandHistoryStatus" NOT NULL,
    "executedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "resultMessage" TEXT,
    "resultPayload" JSONB,
    "errorCode" TEXT,
    "source" "public"."TpvCommandSource" NOT NULL DEFAULT 'DASHBOARD',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TpvCommandHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BulkCommandOperation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "targetType" "public"."BulkTargetType" NOT NULL,
    "targetIds" TEXT[],
    "totalTargets" INTEGER NOT NULL,
    "commandType" "public"."TpvCommandType" NOT NULL,
    "payload" JSONB,
    "sequential" BOOLEAN NOT NULL DEFAULT false,
    "onErrorAction" "public"."BulkErrorAction" NOT NULL DEFAULT 'CONTINUE',
    "status" "public"."BulkOperationStatus" NOT NULL DEFAULT 'PENDING',
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "requestedBy" TEXT NOT NULL,
    "requestedByName" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkCommandOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScheduledCommand" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "terminalId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "commandType" "public"."TpvCommandType" NOT NULL,
    "payload" JSONB,
    "scheduleType" "public"."ScheduleType" NOT NULL,
    "cronExpression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
    "nextExecution" TIMESTAMP(3) NOT NULL,
    "lastExecution" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "maxExecutions" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GeofenceRule" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "terminalId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "centerLat" DOUBLE PRECISION NOT NULL,
    "centerLng" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL,
    "onEnter" "public"."TpvCommandType",
    "onEnterPayload" JSONB,
    "onExit" "public"."TpvCommandType",
    "onExitPayload" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggered" TIMESTAMP(3),
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeofenceRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TpvCommandQueue_correlationId_key" ON "public"."TpvCommandQueue"("correlationId");

-- CreateIndex
CREATE INDEX "TpvCommandQueue_terminalId_status_idx" ON "public"."TpvCommandQueue"("terminalId", "status");

-- CreateIndex
CREATE INDEX "TpvCommandQueue_venueId_status_idx" ON "public"."TpvCommandQueue"("venueId", "status");

-- CreateIndex
CREATE INDEX "TpvCommandQueue_status_scheduledFor_idx" ON "public"."TpvCommandQueue"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "TpvCommandQueue_correlationId_idx" ON "public"."TpvCommandQueue"("correlationId");

-- CreateIndex
CREATE INDEX "TpvCommandQueue_bulkOperationId_idx" ON "public"."TpvCommandQueue"("bulkOperationId");

-- CreateIndex
CREATE INDEX "TpvCommandHistory_terminalId_createdAt_idx" ON "public"."TpvCommandHistory"("terminalId", "createdAt");

-- CreateIndex
CREATE INDEX "TpvCommandHistory_venueId_createdAt_idx" ON "public"."TpvCommandHistory"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "TpvCommandHistory_commandType_createdAt_idx" ON "public"."TpvCommandHistory"("commandType", "createdAt");

-- CreateIndex
CREATE INDEX "TpvCommandHistory_requestedBy_idx" ON "public"."TpvCommandHistory"("requestedBy");

-- CreateIndex
CREATE INDEX "TpvCommandHistory_correlationId_idx" ON "public"."TpvCommandHistory"("correlationId");

-- CreateIndex
CREATE INDEX "BulkCommandOperation_venueId_status_idx" ON "public"."BulkCommandOperation"("venueId", "status");

-- CreateIndex
CREATE INDEX "BulkCommandOperation_status_createdAt_idx" ON "public"."BulkCommandOperation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduledCommand_venueId_enabled_nextExecution_idx" ON "public"."ScheduledCommand"("venueId", "enabled", "nextExecution");

-- CreateIndex
CREATE INDEX "ScheduledCommand_nextExecution_idx" ON "public"."ScheduledCommand"("nextExecution");

-- CreateIndex
CREATE INDEX "GeofenceRule_venueId_enabled_idx" ON "public"."GeofenceRule"("venueId", "enabled");

-- CreateIndex
CREATE INDEX "Terminal_isLocked_idx" ON "public"."Terminal"("isLocked");

-- AddForeignKey
ALTER TABLE "public"."TpvCommandQueue" ADD CONSTRAINT "TpvCommandQueue_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "public"."Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TpvCommandQueue" ADD CONSTRAINT "TpvCommandQueue_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TpvCommandQueue" ADD CONSTRAINT "TpvCommandQueue_bulkOperationId_fkey" FOREIGN KEY ("bulkOperationId") REFERENCES "public"."BulkCommandOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TpvCommandHistory" ADD CONSTRAINT "TpvCommandHistory_commandQueueId_fkey" FOREIGN KEY ("commandQueueId") REFERENCES "public"."TpvCommandQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BulkCommandOperation" ADD CONSTRAINT "BulkCommandOperation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledCommand" ADD CONSTRAINT "ScheduledCommand_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledCommand" ADD CONSTRAINT "ScheduledCommand_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "public"."Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GeofenceRule" ADD CONSTRAINT "GeofenceRule_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GeofenceRule" ADD CONSTRAINT "GeofenceRule_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "public"."Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
