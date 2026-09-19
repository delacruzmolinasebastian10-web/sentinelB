/**
 * ============================================================
 * SentinelB — Monitor Bovino
 * Backend Node.js + Express + PostgreSQL
 *
 * Preparado para:
 * - Desarrollo local
 * - Render
 * - PostgreSQL
 * - PWA
 * - ESP32
 * ============================================================
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const app = express();

/* ============================================================
   CONFIGURACIÓN DEL SERVIDOR
   ============================================================ */

const PORT = process.env.PORT || 4000;

/* ============================================================
   MIDDLEWARE
   ============================================================ */

app.use(cors());

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname)));


/* ============================================================
   CONFIGURACIÓN POSTGRESQL
   ============================================================ */

if (!process.env.DATABASE_URL) {
    console.warn("⚠️ DATABASE_URL no está configurada.");
    console.warn("⚠️ El servidor necesitará DATABASE_URL para conectarse a PostgreSQL.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    ssl:
        process.env.NODE_ENV === "production"
            ? { rejectUnauthorized: false }
            : false,

    max: 10,

    idleTimeoutMillis: 30000,

    connectionTimeoutMillis: 10000
});


/* ============================================================
   INICIALIZAR BASE DE DATOS
   ============================================================ */

async function initDB() {

    try {

        const client = await pool.connect();

        console.log("======================================");
        console.log("🐄 SentinelB — Monitor Bovino");
        console.log("======================================");
        console.log("✅ Conectado a PostgreSQL correctamente");
        console.log(`🌐 Puerto: ${PORT}`);

        // Crear tabla de vacunas si no existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS vacunas (
                id SERIAL PRIMARY KEY,
                rfid VARCHAR(50) NOT NULL REFERENCES animales(rfid),
                categoria VARCHAR(20) NOT NULL CHECK (categoria IN ('becerro','vaca','torete','toro')),
                nombre_vacuna VARCHAR(150) NOT NULL,
                lote VARCHAR(80),
                fecha_aplicacion DATE NOT NULL,
                proxima_dosis DATE,
                responsable VARCHAR(120),
                observaciones TEXT,
                alerta_generada BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        console.log("✅ Tabla 'vacunas' verificada");

        // Agregar columna de categoría a animales si no existe
        await pool.query(`
            ALTER TABLE animales
            ADD COLUMN IF NOT EXISTS categoria VARCHAR(20)
            CHECK (categoria IN ('becerro','vaca','torete','toro'))
        `);

        console.log("✅ Columna 'categoria' verificada en animales");

        client.release();

    } catch (error) {

        console.error("======================================");
        console.error("❌ ERROR CONECTANDO A POSTGRESQL");
        console.error("======================================");
        console.error(error.message);

    }
}


/* ============================================================
   HEALTH CHECK PARA RENDER
   ============================================================ */

app.get("/healthz", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.status(200).json({
            ok: true,
            servicio: "SentinelB",
            database: "PostgreSQL"
        });

    } catch (error) {

        res.status(500).json({
            ok: false,
            error: "Base de datos no disponible"
        });

    }

});


/* ============================================================
   LÓGICA DE ALERTAS
   ============================================================ */

async function clasificarAlerta(rfid, sal, tempCorp) {

    const result = await pool.query(
        `
        SELECT AVG(sal) AS avg_sal
        FROM lecturas
        WHERE rfid = $1
          AND timestamp >= NOW() - INTERVAL '7 days'
        `,
        [rfid]
    );

    const avgSal =
        Number(result.rows[0]?.avg_sal) || Number(sal);

    if (sal < avgSal * 0.6 && tempCorp > 39.5) {

        return {

            tipo: "ROJA",

            mensaje:
                `⚠️ RIESGO SANITARIO — Animal ${rfid}: ` +
                `Sal caída ${Math.round((1 - sal / avgSal) * 100)}% ` +
                `bajo lo normal + TC ${tempCorp}°C. ` +
                `Requiere evaluación veterinaria.`

        };

    }

    if (tempCorp > 40.0) {

        return {

            tipo: "ROJA",

            mensaje:
                `🌡️ FIEBRE SEVERA — Animal ${rfid}: ` +
                `TC ${tempCorp}°C. ` +
                `Requiere evaluación veterinaria.`

        };

    }

    if (sal < avgSal * 0.7) {

        return {

            tipo: "AMARILLA",

            mensaje:
                `🟡 BAJO CONSUMO DE SAL — Animal ${rfid}: ` +
                `Sal ${Math.round(sal)}g ` +
                `(${Math.round((1 - sal / avgSal) * 100)}% ` +
                `bajo lo normal). Verificar comedero.`

        };

    }

    return {
        tipo: "NORMAL",
        mensaje: ""
    };

}


/* ============================================================
   VERIFICAR VACUNAS PRÓXIMAS A VENCER / VENCIDAS
   ============================================================ */

async function verificarVacunasProximas() {

    try {

        const proximas = await pool.query(`
            SELECT v.*, a.nombre
            FROM vacunas v
            LEFT JOIN animales a ON v.rfid = a.rfid
            WHERE v.proxima_dosis IS NOT NULL
              AND v.alerta_generada = FALSE
              AND v.proxima_dosis <= CURRENT_DATE + INTERVAL '7 days'
        `);

        for (const v of proximas.rows) {

            const vencida = new Date(v.proxima_dosis) < new Date();

            const tipo = vencida ? "ROJA" : "AMARILLA";

            const mensaje = vencida
                ? `💉 REFUERZO VENCIDO — ${v.nombre || v.rfid}: ${v.nombre_vacuna} venció el ${new Date(v.proxima_dosis).toLocaleDateString('es-MX')}.`
                : `💉 PRÓXIMO REFUERZO — ${v.nombre || v.rfid}: ${v.nombre_vacuna} programado para el ${new Date(v.proxima_dosis).toLocaleDateString('es-MX')}.`;

            await pool.query(
                `INSERT INTO alertas (rfid, tipo, mensaje) VALUES ($1, $2, $3)`,
                [v.rfid, tipo, mensaje]
            );

            await pool.query(
                `UPDATE vacunas SET alerta_generada = TRUE WHERE id = $1`,
                [v.id]
            );

        }

        if (proximas.rows.length > 0) {
            console.log(`💉 ${proximas.rows.length} alerta(s) de vacunación generada(s)`);
        }

    } catch (error) {
        console.error("❌ Error verificarVacunasProximas:", error.message);
    }

}


/* ============================================================
   API — ESP32
   ============================================================ */

app.post("/api/datos", async (req, res) => {

    const {
        rfid,
        sal,
        temp_corp,
        temp_amb
    } = req.body;


    if (
        !rfid ||
        sal === undefined ||
        temp_corp === undefined ||
        temp_amb === undefined
    ) {

        return res.status(400).json({

            ok: false,

            error: "Faltan campos"

        });

    }


    try {

        await pool.query(
            `
            INSERT INTO animales (rfid)
            VALUES ($1)
            ON CONFLICT (rfid) DO NOTHING
            `,
            [rfid]
        );

        const alerta =
            await clasificarAlerta(
                rfid,
                Number(sal),
                Number(temp_corp)
            );

        await pool.query(
            `
            INSERT INTO lecturas
            (rfid, sal, temp_corp, temp_amb, alerta)
            VALUES ($1, $2, $3, $4, $5)
            `,
            [
                rfid,
                Number(sal),
                Number(temp_corp),
                Number(temp_amb),
                alerta.tipo
            ]
        );

        if (alerta.tipo !== "NORMAL") {

            await pool.query(
                `
                INSERT INTO alertas
                (rfid, tipo, mensaje)
                VALUES ($1, $2, $3)
                `,
                [
                    rfid,
                    alerta.tipo,
                    alerta.mensaje
                ]
            );

        }

        console.log(
            `[${new Date().toLocaleString()}] ` +
            `ESP32 → RFID:${rfid} ` +
            `Sal:${sal}g ` +
            `TC:${temp_corp}°C ` +
            `TA:${temp_amb}°C ` +
            `→ ${alerta.tipo}`
        );

        res.json({

            ok: true,

            alerta: alerta.tipo

        });


    } catch (error) {

        console.error(
            "❌ Error /api/datos:",
            error.message
        );

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   API — LOGIN
   ============================================================ */

app.post("/api/login", async (req, res) => {

    const {
        usuario,
        password
    } = req.body;


    try {

        const result = await pool.query(
            `
            SELECT *
            FROM usuarios
            WHERE usuario = $1
              AND password = $2
            `,
            [
                usuario,
                password
            ]
        );


        if (result.rows.length > 0) {

            return res.json({

                ok: true,

                usuario: result.rows[0].usuario

            });

        }


        res.status(401).json({

            ok: false,

            error: "Credenciales incorrectas"

        });


    } catch (error) {

        console.error(
            "❌ Error /api/login:",
            error.message
        );

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   API — DASHBOARD
   ============================================================ */

app.get("/api/dashboard", async (req, res) => {

    try {

        const totalAnimales =
            await pool.query(
                `
                SELECT COUNT(*) AS "totalAnimales"
                FROM animales
                `
            );


        const lecturasHoy =
            await pool.query(
                `
                SELECT COUNT(*) AS "lecturasHoy"
                FROM lecturas
                WHERE timestamp::date = CURRENT_DATE
                `
            );


        const alertasNoLeidas =
            await pool.query(
                `
                SELECT COUNT(*) AS "alertasNoLeidas"
                FROM alertas
                WHERE leida = FALSE
                `
            );


        const alertasRojas =
            await pool.query(
                `
                SELECT COUNT(*) AS "alertasRojas"
                FROM alertas
                WHERE tipo = 'ROJA'
                  AND leida = FALSE
                `
            );


        const ultimas =
            await pool.query(
                `
                SELECT
                    l.*,
                    a.nombre
                FROM lecturas l
                LEFT JOIN animales a
                    ON l.rfid = a.rfid
                ORDER BY l.timestamp DESC
                LIMIT 20
                `
            );


        const promediosDia =
            await pool.query(
                `
                SELECT
                    rfid,
                    AVG(sal) AS avg_sal,
                    AVG(temp_corp) AS avg_tc,
                    AVG(temp_amb) AS avg_ta,
                    MAX(timestamp) AS ultima
                FROM lecturas
                WHERE timestamp::date = CURRENT_DATE
                GROUP BY rfid
                `
            );


        res.json({

            totalAnimales:
                Number(
                    totalAnimales.rows[0].totalAnimales
                ),

            lecturasHoy:
                Number(
                    lecturasHoy.rows[0].lecturasHoy
                ),

            alertasNoLeidas:
                Number(
                    alertasNoLeidas.rows[0].alertasNoLeidas
                ),

            alertasRojas:
                Number(
                    alertasRojas.rows[0].alertasRojas
                ),

            ultimas:
                ultimas.rows,

            promediosDia:
                promediosDia.rows

        });


    } catch (error) {

        console.error(
            "❌ Error /api/dashboard:",
            error.message
        );

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   API — ALERTAS
   ============================================================ */

app.get("/api/alertas", async (req, res) => {

    try {

        const result =
            await pool.query(
                `
                SELECT
                    al.*,
                    an.nombre
                FROM alertas al
                LEFT JOIN animales an
                    ON al.rfid = an.rfid
                ORDER BY al.timestamp DESC
                LIMIT 100
                `
            );


        res.json(result.rows);


    } catch (error) {

        console.error(
            "❌ Error /api/alertas:",
            error.message
        );

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   MARCAR ALERTA COMO
