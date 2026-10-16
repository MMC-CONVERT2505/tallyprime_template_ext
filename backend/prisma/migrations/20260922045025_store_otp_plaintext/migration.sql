/*
  Warnings:

  - You are about to drop the column `otpHash` on the `password_reset_otps` table. All the data in the column will be lost.
  - Added the required column `otp` to the `password_reset_otps` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "password_reset_otps" DROP COLUMN "otpHash",
ADD COLUMN     "otp" TEXT NOT NULL;
