-- CreateEnum
CREATE TYPE "public"."NotificationType" AS ENUM ('NEW_ORDER', 'ORDER_UPDATED', 'ORDER_READY', 'ORDER_CANCELLED', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'REFUND_PROCESSED', 'NEW_REVIEW', 'BAD_REVIEW', 'REVIEW_RESPONSE_NEEDED', 'SHIFT_REMINDER', 'SHIFT_ENDED', 'NEW_STAFF_JOINED', 'POS_DISCONNECTED', 'POS_RECONNECTED', 'LOW_INVENTORY', 'SYSTEM_MAINTENANCE', 'FEATURE_UPDATED', 'VENUE_APPROVAL_NEEDED', 'VENUE_SUSPENDED', 'HIGH_COMMISSION_ALERT', 'REVENUE_MILESTONE', 'ANNOUNCEMENT', 'REMINDER', 'ALERT');

-- CreateEnum
CREATE TYPE "public"."NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "public"."NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK');

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "venueId" TEXT,
    "type" "public"."NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actionUrl" TEXT,
    "actionLabel" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "priority" "public"."NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "channels" "public"."NotificationChannel"[] DEFAULT ARRAY['IN_APP']::"public"."NotificationChannel"[],
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMsg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotificationPreference" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT,
    "type" "public"."NotificationType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channels" "public"."NotificationChannel"[] DEFAULT ARRAY['IN_APP']::"public"."NotificationChannel"[],
    "priority" "public"."NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "quietStart" TEXT,
    "quietEnd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotificationTemplate" (
    "id" TEXT NOT NULL,
    "type" "public"."NotificationType" NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'es',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actionLabel" TEXT,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_recipientId_idx" ON "public"."Notification"("recipientId");

-- CreateIndex
CREATE INDEX "Notification_venueId_idx" ON "public"."Notification"("venueId");

-- CreateIndex
CREATE INDEX "Notification_type_idx" ON "public"."Notification"("type");

-- CreateIndex
CREATE INDEX "Notification_isRead_idx" ON "public"."Notification"("isRead");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "public"."Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_entityType_entityId_idx" ON "public"."Notification"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "NotificationPreference_staffId_idx" ON "public"."NotificationPreference"("staffId");

-- CreateIndex
CREATE INDEX "NotificationPreference_type_idx" ON "public"."NotificationPreference"("type");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_staffId_venueId_type_key" ON "public"."NotificationPreference"("staffId", "venueId", "type");

-- CreateIndex
CREATE INDEX "NotificationTemplate_type_idx" ON "public"."NotificationTemplate"("type");

-- CreateIndex
CREATE INDEX "NotificationTemplate_active_idx" ON "public"."NotificationTemplate"("active");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_type_language_key" ON "public"."NotificationTemplate"("type", "language");

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotificationPreference" ADD CONSTRAINT "NotificationPreference_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotificationPreference" ADD CONSTRAINT "NotificationPreference_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
