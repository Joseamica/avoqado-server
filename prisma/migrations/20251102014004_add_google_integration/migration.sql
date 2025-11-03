-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "googleAccessToken" TEXT,
ADD COLUMN     "googleBusinessProfileConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "googleBusinessProfileEmail" TEXT,
ADD COLUMN     "googleLastSyncAt" TIMESTAMP(3),
ADD COLUMN     "googleLocationName" TEXT,
ADD COLUMN     "googlePlaceId" TEXT,
ADD COLUMN     "googleRefreshToken" TEXT,
ADD COLUMN     "googleTokenExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."OAuthState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_state_key" ON "public"."OAuthState"("state");

-- CreateIndex
CREATE INDEX "OAuthState_state_idx" ON "public"."OAuthState"("state");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "public"."OAuthState"("expiresAt");
