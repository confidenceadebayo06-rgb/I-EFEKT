-- Additive Human Potential Profile migration.
-- Apply only after backup and staging verification; do not use db push.
CREATE TABLE `UserSkill` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `experienceLevel` VARCHAR(20) NOT NULL DEFAULT 'BEGINNER',
  `visibility` VARCHAR(16) NOT NULL DEFAULT 'PRIVATE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `UserSkill_userId_name_key`(`userId`, `name`),
  INDEX `UserSkill_userId_visibility_idx`(`userId`, `visibility`),
  PRIMARY KEY (`id`),
  CONSTRAINT `UserSkill_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `UserGoal` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(120) NOT NULL,
  `description` VARCHAR(1000) NOT NULL DEFAULT '',
  `category` VARCHAR(40) NOT NULL DEFAULT 'PERSONAL',
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `targetDate` DATETIME(3) NULL,
  `visibility` VARCHAR(16) NOT NULL DEFAULT 'PRIVATE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `UserGoal_userId_status_idx`(`userId`, `status`),
  INDEX `UserGoal_userId_visibility_idx`(`userId`, `visibility`),
  PRIMARY KEY (`id`),
  CONSTRAINT `UserGoal_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `UserInterest` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `category` VARCHAR(40) NOT NULL DEFAULT 'GENERAL',
  `visibility` VARCHAR(16) NOT NULL DEFAULT 'PRIVATE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `UserInterest_userId_name_key`(`userId`, `name`),
  INDEX `UserInterest_userId_visibility_idx`(`userId`, `visibility`),
  PRIMARY KEY (`id`),
  CONSTRAINT `UserInterest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ProfileIntent` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `type` VARCHAR(8) NOT NULL,
  `title` VARCHAR(120) NOT NULL,
  `description` VARCHAR(1000) NOT NULL DEFAULT '',
  `category` VARCHAR(40) NOT NULL DEFAULT 'GENERAL',
  `visibility` VARCHAR(16) NOT NULL DEFAULT 'PRIVATE',
  `active` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `ProfileIntent_userId_type_active_idx`(`userId`, `type`, `active`),
  INDEX `ProfileIntent_userId_visibility_idx`(`userId`, `visibility`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ProfileIntent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
