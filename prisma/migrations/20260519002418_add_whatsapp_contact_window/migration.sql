-- CreateTable
CREATE TABLE "public"."WhatsappContactWindow" (
    "phone" TEXT NOT NULL,
    "lastInboundAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappContactWindow_pkey" PRIMARY KEY ("phone")
);
