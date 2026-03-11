-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('DESKTOP', 'MOBILE', 'TABLET', 'UNKNOWN');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "click_events" (
    "id" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "browser" TEXT,
    "os" TEXT,
    "device" "DeviceType" NOT NULL DEFAULT 'UNKNOWN',
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "referer" TEXT,
    "ipHash" TEXT,
    "userId" TEXT,

    CONSTRAINT "click_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "click_events_shortCode_idx" ON "click_events"("shortCode");

-- CreateIndex
CREATE INDEX "click_events_shortCode_clickedAt_idx" ON "click_events"("shortCode", "clickedAt");

-- CreateIndex
CREATE INDEX "click_events_clickedAt_idx" ON "click_events"("clickedAt");

-- AddForeignKey
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
