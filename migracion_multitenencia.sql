
BEGIN;

CREATE TABLE IF NOT EXISTS clientes (
    id BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    api_key VARCHAR(128) NOT NULL UNIQUE,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO clientes (nombre, api_key)
SELECT 'Cliente principal', md5(random()::text || clock_timestamp()::text)
WHERE NOT EXISTS (SELECT 1 FROM clientes);

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cliente_id BIGINT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash VARCHAR(100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rol VARCHAR(20) NOT NULL DEFAULT 'admin';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE animales ADD COLUMN IF NOT EXISTS cliente_id BIGINT;
ALTER TABLE lecturas ADD COLUMN IF NOT EXISTS cliente_id BIGINT;
ALTER TABLE alertas ADD COLUMN IF NOT EXISTS cliente_id BIGINT;
ALTER TABLE vacunas ADD COLUMN IF NOT EXISTS cliente_id BIGINT;

UPDATE usuarios
SET cliente_id = (SELECT id FROM clientes ORDER BY id LIMIT 1)
WHERE cliente_id IS NULL;

UPDATE animales
SET cliente_id = (SELECT id FROM clientes ORDER BY id LIMIT 1)
WHERE cliente_id IS NULL;

UPDATE lecturas
SET cliente_id = (SELECT id FROM clientes ORDER BY id LIMIT 1)
WHERE cliente_id IS NULL;

UPDATE alertas
SET cliente_id = (SELECT id FROM clientes ORDER BY id LIMIT 1)
WHERE cliente_id IS NULL;

UPDATE vacunas
SET cliente_id = (SELECT id FROM clientes ORDER BY id LIMIT 1)
WHERE cliente_id IS NULL;

ALTER TABLE lecturas DROP CONSTRAINT IF EXISTS lecturas_rfid_fkey;
ALTER TABLE alertas DROP CONSTRAINT IF EXISTS alertas_rfid_fkey;
ALTER TABLE vacunas DROP CONSTRAINT IF EXISTS vacunas_rfid_fkey;

ALTER TABLE animales DROP CONSTRAINT IF EXISTS animales_pkey;
ALTER TABLE animales ADD CONSTRAINT animales_pkey
    PRIMARY KEY (cliente_id, rfid);

ALTER TABLE usuarios
    ADD CONSTRAINT usuarios_cliente_fk
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE;

ALTER TABLE animales
    ADD CONSTRAINT animales_cliente_fk
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE;

ALTER TABLE lecturas
    ADD CONSTRAINT lecturas_cliente_fk
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE;

ALTER TABLE alertas
    ADD CONSTRAINT alertas_cliente_fk
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE;

ALTER TABLE vacunas
    ADD CONSTRAINT vacunas_cliente_fk
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE;

ALTER TABLE lecturas
    ADD CONSTRAINT lecturas_animal_fk
    FOREIGN KEY (cliente_id, rfid)
    REFERENCES animales(cliente_id, rfid) ON DELETE CASCADE;

ALTER TABLE alertas
    ADD CONSTRAINT alertas_animal_fk
    FOREIGN KEY (cliente_id, rfid)
    REFERENCES animales(cliente_id, rfid) ON DELETE CASCADE;

ALTER TABLE vacunas
    ADD CONSTRAINT vacunas_animal_fk
    FOREIGN KEY (cliente_id, rfid)
    REFERENCES animales(cliente_id, rfid) ON DELETE CASCADE;

ALTER TABLE usuarios ALTER COLUMN cliente_id SET NOT NULL;
ALTER TABLE animales ALTER COLUMN cliente_id SET NOT NULL;
ALTER TABLE lecturas ALTER COLUMN cliente_id SET NOT NULL;
ALTER TABLE alertas ALTER COLUMN cliente_id SET NOT NULL;
ALTER TABLE vacunas ALTER COLUMN cliente_id SET NOT NULL;

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_usuario_key;

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_cliente_usuario_uq
    ON usuarios(cliente_id, usuario);

CREATE INDEX IF NOT EXISTS idx_animales_cliente
    ON animales(cliente_id);

CREATE INDEX IF NOT EXISTS idx_lecturas_cliente_timestamp
    ON lecturas(cliente_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_alertas_cliente_timestamp
    ON alertas(cliente_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_vacunas_cliente_fecha
    ON vacunas(cliente_id, fecha_aplicacion);

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;

ALTER TABLE usuarios
    ADD CONSTRAINT usuarios_rol_check
    CHECK (rol IN ('superadmin','admin','empleado','veterinario'));

UPDATE usuarios
SET rol='superadmin'
WHERE id=(SELECT id FROM usuarios ORDER BY id LIMIT 1);

COMMIT;
