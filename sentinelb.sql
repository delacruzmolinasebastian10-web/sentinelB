-- ============================================================
-- SentinelB — Script MySQL generado desde sentinelb.db (SQLite)
-- Importar en phpMyAdmin: selecciona tu base de datos y usa
-- la pestaña Importar → elige este archivo .sql
-- ============================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET foreign_key_checks = 0;
SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';

-- ------------------------------------------------------------
-- Tabla: animales
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `animales` (
  `rfid`        VARCHAR(50)   NOT NULL,
  `nombre`      VARCHAR(100)  DEFAULT '',
  `descripcion` TEXT          DEFAULT NULL,
  `raza`        VARCHAR(100)  DEFAULT '',
  PRIMARY KEY (`rfid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Tabla: lecturas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `lecturas` (
  `id`        INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `rfid`      VARCHAR(50)   NOT NULL,
  `sal`     DOUBLE        NOT NULL,
  `temp_corp` DOUBLE        NOT NULL,
  `temp_amb`  DOUBLE        NOT NULL,
  `alerta`    VARCHAR(20)   DEFAULT 'NORMAL',
  `timestamp` DATETIME      DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_rfid` (`rfid`),
  KEY `idx_timestamp` (`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Tabla: alertas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `alertas` (
  `id`        INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `rfid`      VARCHAR(50)   NOT NULL,
  `tipo`      VARCHAR(20)   NOT NULL,
  `mensaje`   TEXT          NOT NULL,
  `leida`     TINYINT(1)    DEFAULT 0,
  `timestamp` DATETIME      DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_leida` (`leida`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Tabla: usuarios
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `usuarios` (
  `id`       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `usuario`  VARCHAR(100) NOT NULL,
  `password` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_usuario` (`usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Datos: animales
-- ------------------------------------------------------------
INSERT INTO `animales` (`rfid`, `nombre`, `descripcion`, `raza`) VALUES ('001', 'pinta', 'becerro prematuro', 'brahman');

-- ------------------------------------------------------------
-- Datos: lecturas
-- ------------------------------------------------------------
-- (sin registros)

-- ------------------------------------------------------------
-- Datos: alertas
-- ------------------------------------------------------------
-- (sin registros)

-- ------------------------------------------------------------
-- Datos: usuarios
-- ------------------------------------------------------------
INSERT INTO `usuarios` (`id`, `usuario`, `password`) VALUES (1, 'admin', 'sentinel2026');

SET foreign_key_checks = 1;

-- Fin del script SentinelB