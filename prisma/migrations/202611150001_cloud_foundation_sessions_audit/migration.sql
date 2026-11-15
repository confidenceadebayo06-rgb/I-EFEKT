-- I-EFEKT Phase 0-1 additive migration.
-- Apply only after the existing Prisma schema has been baselined and backed up.
CREATE TABLE `DeviceSession` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `tokenHash` CHAR(64) NOT NULL,
  `deviceName` VARCHAR(120) NULL,
  `userAgent` VARCHAR(512) NULL,
  `ipHash` CHAR(64) NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `DeviceSession_tokenHash_key`(`tokenHash`),
  INDEX `DeviceSession_userId_revokedAt_expiresAt_idx`(`userId`, `revokedAt`, `expiresAt`),
  INDEX `DeviceSession_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `DeviceSession_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AuditLog` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NULL,
  `action` VARCHAR(80) NOT NULL,
  `targetId` VARCHAR(191) NULL,
  `ipHash` CHAR(64) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AuditLog_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `AuditLog_action_createdAt_idx`(`action`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AuditLog_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
