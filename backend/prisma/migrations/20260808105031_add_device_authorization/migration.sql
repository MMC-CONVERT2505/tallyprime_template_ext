-- CreateEnum
CREATE TYPE "DeviceAuthorizationStatus" AS ENUM ('PENDING', 'APPROVED', 'CONSUMED', 'EXPIRED');

-- CreateTable
CREATE TABLE "device_authorizations" (
    "id" TEXT NOT NULL,
    "deviceCode" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "status" "DeviceAuthorizationStatus" NOT NULL DEFAULT 'PENDING',
    "orgId" TEXT,
    "label" TEXT,
    "defaultCompany" TEXT,
    "connectionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_authorizations_deviceCode_key" ON "device_authorizations"("deviceCode");

-- CreateIndex
CREATE INDEX "device_authorizations_userCode_idx" ON "device_authorizations"("userCode");

-- AddForeignKey
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
