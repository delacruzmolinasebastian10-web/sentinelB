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

        // Crear tabla de animales (necesaria antes que las demás por las FK)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS animales (
                rfid VARCHAR(50) PRIMARY KEY,
                nombre VARCHAR(120),
                raza VARCHAR(80),
                categoria VARCHAR(20),
                fecha_nac DATE,
                descripcion TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log("✅ Tabla 'animales' verificada");

        // Crear tabla de lecturas
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lecturas (
                id SERIAL PRIMARY KEY,
                rfid VARCHAR(50) NOT NULL REFERENCES animales(rfid),
                sal NUMERIC,
                temp_corp NUMERIC,
                temp_amb NUMERIC,
                alerta VARCHAR(20),
                timestamp TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log("✅ Tabla 'lecturas' verificada");

        // Crear tabla de alertas
        await pool.query(`
            CREATE TABLE IF NOT EXISTS alertas (
                id SERIAL PRIMARY KEY,
                rfid VARCHAR(50) REFERENCES animales(rfid),
                tipo VARCHAR(20),
                mensaje TEXT,
                leida BOOLEAN DEFAULT FALSE,
                timestamp TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log("✅ Tabla 'alertas' verificada");

        // Crear tabla de usuarios
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                usuario VARCHAR(80) UNIQUE NOT NULL,
                password VARCHAR(120) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log("✅ Tabla 'usuarios' verificada");

        // Crear un usuario admin por defecto (solo si no existe ya)
        await pool.query(`
            INSERT INTO usuarios (usuario, password)
            VALUES ('admin', 'admin123')
            ON CONFLICT (usuario) DO NOTHING
        `);
        console.log("✅ Usuario admin verificado (admin / admin123)");

        // Crear tabla de vacunas si no existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS vacunas (
                id SERIAL PRIMARY KEY,
                rfid VARCHAR(50) NOT NULL REFERENCES animales(rfid),
                categoria VARCHAR(20) NOT NULL,
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
        `);

        console.log("✅ Columna 'categoria' verificada en animales");

        // Actualizar categorías permitidas para incluir "novilla"
        await pool.query(`
            ALTER TABLE animales DROP CONSTRAINT IF EXISTS animales_categoria_check
        `);
        await pool.query(`
            ALTER TABLE animales
            ADD CONSTRAINT animales_categoria_check
            CHECK (categoria IN ('becerro','vaca','torete','toro','novilla'))
        `);

        await pool.query(`
            ALTER TABLE vacunas DROP CONSTRAINT IF EXISTS vacunas_categoria_check
        `);
        await pool.query(`
            ALTER TABLE vacunas
            ADD CONSTRAINT vacunas_categoria_check
            CHECK (categoria IN ('becerro','vaca','torete','toro','novilla'))
        `);

        console.log("✅ Categorías actualizadas (incluye 'novilla')");

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
   MARCAR ALERTA COMO LEÍDA
   ============================================================ */

app.put("/api/alertas/:id/leer", async (req, res) => {

    try {

        await pool.query(
            `
            UPDATE alertas
            SET leida = TRUE
            WHERE id = $1
            `,
            [req.params.id]
        );


        res.json({
            ok: true
        });


    } catch (error) {

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   MARCAR TODAS LAS ALERTAS COMO LEÍDAS
   ============================================================ */

app.put("/api/alertas/leer-todas", async (req, res) => {

    try {

        await pool.query(
            `
            UPDATE alertas
            SET leida = TRUE
            `
        );


        res.json({
            ok: true
        });


    } catch (error) {

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   API — ANIMALES
   ============================================================ */

app.get("/api/animales", async (req, res) => {

    try {

        const result =
            await pool.query(
                `
                SELECT
                    a.rfid,
                    a.nombre,
                    a.raza,
                    a.categoria,
                    a.descripcion,
                    COUNT(l.id) AS total_lecturas,
                    MAX(l.timestamp) AS ultima_lectura,
                    AVG(l.temp_corp) AS avg_tc
                FROM animales a
                LEFT JOIN lecturas l
                    ON a.rfid = l.rfid
                GROUP BY
                    a.rfid,
                    a.nombre,
                    a.raza,
                    a.categoria,
                    a.descripcion
                ORDER BY
                    ultima_lectura DESC NULLS LAST
                `
            );


        res.json(result.rows);


    } catch (error) {

        console.error(
            "❌ Error /api/animales:",
            error.message
        );

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   CREAR ANIMAL
   ============================================================ */

app.post("/api/animales", async (req, res) => {

    const {
        rfid,
        nombre,
        raza,
        categoria,
        descripcion
    } = req.body;


    if (!rfid || !rfid.trim()) {

        return res.status(400).json({

            ok: false,

            error: "El RFID es obligatorio"

        });

    }


    const rfidLimpio =
        rfid.trim().toUpperCase();


    try {

        const existe =
            await pool.query(
                `
                SELECT rfid
                FROM animales
                WHERE rfid = $1
                `,
                [rfidLimpio]
            );


        if (existe.rows.length > 0) {

            return res.status(409).json({

                ok: false,

                error:
                    "Ya existe un animal con ese RFID"

            });

        }


        await pool.query(
            `
            INSERT INTO animales
            (rfid, nombre, raza, categoria, descripcion)
            VALUES ($1, $2, $3, $4, $5)
            `,
            [
                rfidLimpio,
                nombre?.trim() || "",
                raza?.trim() || "",
                categoria || null,
                descripcion?.trim() || ""
            ]
        );


        console.log(
            `➕ Animal registrado: ` +
            `RFID=${rfidLimpio} ` +
            `Nombre=${nombre || "-"} ` +
            `Categoría=${categoria || "-"}`
        );


        res.json({

            ok: true,

            rfid: rfidLimpio

        });


    } catch (error) {

        console.error(
            "❌ Error creando animal:",
            error.message
        );

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   EDITAR ANIMAL
   ============================================================ */

app.put("/api/animales/:rfid", async (req, res) => {

    const {
        nombre,
        raza,
        categoria,
        descripcion
    } = req.body;


    try {

        await pool.query(
            `
            UPDATE animales
            SET
                nombre = $1,
                raza = $2,
                categoria = $3,
                descripcion = $4
            WHERE rfid = $5
            `,
            [
                nombre?.trim() || "",
                raza?.trim() || "",
                categoria || null,
                descripcion?.trim() || "",
                req.params.rfid
            ]
        );


        res.json({
            ok: true
        });


    } catch (error) {

        console.error(
            "❌ Error editando animal:",
            error.message
        );

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   HISTORIAL DE ANIMAL
   ============================================================ */

app.get(
    "/api/animales/:rfid/historial",
    async (req, res) => {

        const { rfid } = req.params;

        const dias =
            Math.max(
                1,
                parseInt(req.query.dias) || 7
            );


        try {

            const historial =
                await pool.query(
                    `
                    SELECT *
                    FROM lecturas
                    WHERE rfid = $1
                      AND timestamp >=
                          NOW() - ($2 * INTERVAL '1 day')
                    ORDER BY timestamp ASC
                    `,
                    [
                        rfid,
                        dias
                    ]
                );


            const animal =
                await pool.query(
                    `
                    SELECT *
                    FROM animales
                    WHERE rfid = $1
                    `,
                    [rfid]
                );


            res.json({

                animal:
                    animal.rows[0] || null,

                historial:
                    historial.rows

            });


        } catch (error) {

            console.error(
                "❌ Error historial:",
                error.message
            );

            res.status(500).json({

                ok: false,

                error: error.message

            });

        }

    }
);


/* ============================================================
   API — VACUNAS
   ============================================================ */

app.get("/api/vacunas", async (req, res) => {
    try {
        const { rfid } = req.query;
        let query = `
            SELECT v.*, a.nombre
            FROM vacunas v
            LEFT JOIN animales a ON v.rfid = a.rfid
        `;
        const params = [];
        if (rfid) {
            params.push(rfid);
            query += ` WHERE v.rfid = $1`;
        }
        query += ` ORDER BY v.fecha_aplicacion DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error("❌ Error /api/vacunas:", error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/vacunas", async (req, res) => {
    const {
        rfid, categoria, nombre_vacuna, lote,
        fecha_aplicacion, proxima_dosis, responsable, observaciones
    } = req.body;

    if (!rfid || !categoria || !nombre_vacuna || !fecha_aplicacion) {
        return res.status(400).json({ ok: false, error: "Faltan campos obligatorios" });
    }

    try {
        await pool.query(
            `INSERT INTO vacunas
             (rfid, categoria, nombre_vacuna, lote, fecha_aplicacion, proxima_dosis, responsable, observaciones)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [rfid, categoria, nombre_vacuna, lote || null, fecha_aplicacion,
             proxima_dosis || null, responsable || null, observaciones || null]
        );

        console.log(`💉 Vacuna registrada: ${rfid} — ${nombre_vacuna}`);
        res.json({ ok: true });

    } catch (error) {
        console.error("❌ Error creando vacuna:", error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.put("/api/vacunas/:id", async (req, res) => {
    const {
        categoria, nombre_vacuna, lote,
        fecha_aplicacion, proxima_dosis, responsable, observaciones
    } = req.body;

    try {
        await pool.query(
            `UPDATE vacunas SET
                categoria=$1, nombre_vacuna=$2, lote=$3, fecha_aplicacion=$4,
                proxima_dosis=$5, responsable=$6, observaciones=$7,
                alerta_generada = CASE WHEN proxima_dosis IS DISTINCT FROM $5 THEN FALSE ELSE alerta_generada END
             WHERE id=$8`,
            [categoria, nombre_vacuna, lote || null, fecha_aplicacion,
             proxima_dosis || null, responsable || null, observaciones || null, req.params.id]
        );
        res.json({ ok: true });

    } catch (error) {
        console.error("❌ Error editando vacuna:", error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.delete("/api/vacunas/:id", async (req, res) => {
    try {
        await pool.query(`DELETE FROM vacunas WHERE id=$1`, [req.params.id]);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});


/* ============================================================
   REPORTE CSV
   ============================================================ */

app.get("/api/reporte", async (req, res) => {

    const {
        desde,
        hasta,
        rfid
    } = req.query;


    let query = `
        SELECT
            l.*,
            a.nombre
        FROM lecturas l
        LEFT JOIN animales a
            ON l.rfid = a.rfid
        WHERE 1 = 1
    `;


    const params = [];


    if (desde) {

        params.push(desde);

        query +=
            ` AND l.timestamp::date >= $${params.length}`;

    }


    if (hasta) {

        params.push(hasta);

        query +=
            ` AND l.timestamp::date <= $${params.length}`;

    }


    if (rfid) {

        params.push(rfid);

        query +=
            ` AND l.rfid = $${params.length}`;

    }


    query +=
        " ORDER BY l.timestamp DESC";


    try {

        const result =
            await pool.query(
                query,
                params
            );


        const filas = result.rows.map(r => {

            const nombre =
                String(r.nombre || "")
                    .replace(/"/g, '""');

            const rfidSeguro =
                String(r.rfid || "")
                    .replace(/"/g, '""');

            return (
                `${r.id},` +
                `"${rfidSeguro}",` +
                `"${nombre}",` +
                `${r.sal},` +
                `${r.temp_corp},` +
                `${r.temp_amb},` +
                `${r.alerta},` +
                `"${r.timestamp}"`
            );

        });


        const csv = [

            "ID,RFID,Nombre,Sal(g),Temp_Corp(°C),Temp_Amb(°C),Alerta,Timestamp",

            ...filas

        ].join("\n");


        res.setHeader(
            "Content-Type",
            "text/csv; charset=utf-8"
        );


        res.setHeader(
            "Content-Disposition",
            `attachment; filename="sentinelb_reporte_${Date.now()}.csv"`
        );


        res.send("\uFEFF" + csv);


    } catch (error) {

        console.error(
            "❌ Error /api/reporte:",
            error.message
        );

        res.status(500).json({

            ok: false,

            error: error.message

        });

    }

});


/* ============================================================
   RUTA PRINCIPAL
   ============================================================ */

app.get("/", (req, res) => {

    res.sendFile(
        path.join(__dirname, "login.html")
    );

});


/* ============================================================
   MANEJO DE RUTA NO ENCONTRADA
   ============================================================ */

app.use((req, res) => {

    if (req.path.startsWith("/api/")) {

        return res.status(404).json({

            ok: false,

            error: "Endpoint no encontrado"

        });

    }

    res.status(404).send("Página no encontrada");

});


/* ============================================================
   INICIAR SERVIDOR
   ============================================================ */

async function startServer() {

    await initDB();

    await verificarVacunasProximas();
    setInterval(verificarVacunasProximas, 6 * 60 * 60 * 1000); // cada 6 horas

    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log("");
            console.log("======================================");
            console.log("🐄 SENTINELB — MONITOR BOVINO");
            console.log("======================================");

            console.log(
                `🌐 Servidor escuchando en puerto ${PORT}`
            );

            console.log(
                `📱 Aplicación: http://localhost:${PORT}`
            );

            console.log(
                `❤️ Health Check: http://localhost:${PORT}/healthz`
            );

            console.log(
                `📡 API ESP32: /api/datos`
            );

            console.log("======================================");
            console.log("");

        }
    );

}


startServer();
