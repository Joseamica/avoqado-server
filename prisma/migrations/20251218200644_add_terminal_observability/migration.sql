-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "TerminalLog" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "tag" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "error" TEXT,
    "metadata" JSONB,
    "timestamp" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminalHealth" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "healthScore" INTEGER NOT NULL,
    "memoryTotalMB" INTEGER NOT NULL,
    "memoryAvailableMB" INTEGER NOT NULL,
    "memoryUsagePercent" INTEGER NOT NULL,
    "lowMemory" BOOLEAN NOT NULL DEFAULT false,
    "storageTotalMB" INTEGER NOT NULL,
    "storageAvailableMB" INTEGER NOT NULL,
    "storageUsagePercent" INTEGER NOT NULL,
    "lowStorage" BOOLEAN NOT NULL DEFAULT false,
    "batteryLevel" INTEGER,
    "batteryCharging" BOOLEAN NOT NULL DEFAULT false,
    "batteryTemperature" DOUBLE PRECISION,
    "lowBattery" BOOLEAN NOT NULL DEFAULT false,
    "socketConnected" BOOLEAN NOT NULL,
    "online" BOOLEAN NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "osVersion" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "appVersionCode" INTEGER NOT NULL,
    "blumonEnv" TEXT NOT NULL,
    "uptimeMinutes" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalHealth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TerminalLog_venueId_terminalId_createdAt_idx" ON "TerminalLog"("venueId", "terminalId", "createdAt");

-- CreateIndex
CREATE INDEX "TerminalLog_level_createdAt_idx" ON "TerminalLog"("level", "createdAt");

-- CreateIndex
CREATE INDEX "TerminalLog_tag_createdAt_idx" ON "TerminalLog"("tag", "createdAt");

-- CreateIndex
CREATE INDEX "TerminalHealth_venueId_terminalId_createdAt_idx" ON "TerminalHealth"("venueId", "terminalId", "createdAt");

-- CreateIndex
CREATE INDEX "TerminalHealth_healthScore_createdAt_idx" ON "TerminalHealth"("healthScore", "createdAt");

-- CreateIndex
CREATE INDEX "TerminalHealth_lowMemory_idx" ON "TerminalHealth"("lowMemory");

-- CreateIndex
CREATE INDEX "TerminalHealth_lowBattery_idx" ON "TerminalHealth"("lowBattery");

-- AddForeignKey
ALTER TABLE "TerminalLog" ADD CONSTRAINT "TerminalLog_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalLog" ADD CONSTRAINT "TerminalLog_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalHealth" ADD CONSTRAINT "TerminalHealth_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalHealth" ADD CONSTRAINT "TerminalHealth_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
