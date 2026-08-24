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

/*
 * Sirve los archivos de SentinelB:
 * index.html
 * login.html
 * styles.css
 * app.js
 * manifest.json
 * service-worker.js
 * assets/
 */

app.use(express.static(path.join(__dirname)));


/* ============================================================
   CONFIGURACIÓN POSTGRESQL
   ============================================================

   En Render:
   DATABASE_URL será proporcionada mediante
   Environment Variables.

   En local:
   Puedes definir DATABASE_URL manualmente.

   Ejemplo local:

   DATABASE_URL=postgresql://postgres:TU_PASSWORD@localhost:5432/sentinelb

   ============================================================ */

if (!process.env.DATABASE_URL) {
    console.warn("⚠️ DATABASE_URL no está configurada.");
    console.warn("⚠️ El servidor necesitará DATABASE_URL para conectarse a PostgreSQL.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    /*
     * Render trabaja con PostgreSQL mediante conexión SSL.
     * En local se puede trabajar sin SSL.
     */
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

        client.release();

    } catch (error) {

        console.error("======================================");
        console.error("❌ ERROR CONECTANDO A POSTGRESQL");
        console.error("======================================");
        console.error(error.message);

        /*
         * No cerramos inmediatamente el proceso.
         * Esto permite que Render pueda mostrar el error
         * y que podamos diagnosticar la configuración.
         */
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

    /*
     * ALERTA ROJA:
     * Bajo consumo de sal + temperatura elevada.
     */

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


    /*
     * ALERTA ROJA:
     * Temperatura muy elevada.
     */

    if (tempCorp > 40.0) {

        return {

            tipo: "ROJA",

            mensaje:
                `🌡️ FIEBRE SEVERA — Animal ${rfid}: ` +
                `TC ${tempCorp}°C. ` +
                `Requiere evaluación veterinaria.`

        };

    }


    /*
     * ALERTA AMARILLA:
     * Bajo consumo de sal.
     */

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

        /*
         * Registrar automáticamente el RFID
         * si todavía no existe.
         */

        await pool.query(
            `
            INSERT INTO animales (rfid)
            VALUES ($1)
            ON CONFLICT (rfid) DO NOTHING
            `,
            [rfid]
        );


        /*
         * Determinar estado.
         */

        const alerta =
            await clasificarAlerta(
                rfid,
                Number(sal),
                Number(temp_corp)
            );


        /*
         * Guardar lectura.
         */

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


        /*
         * Crear alerta si corresponde.
         */

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
            (rfid, nombre, raza, descripcion)
            VALUES ($1, $2, $3, $4)
            `,
            [
                rfidLimpio,
                nombre?.trim() || "",
                raza?.trim() || "",
                descripcion?.trim() || ""
            ]
        );


        console.log(
            `➕ Animal registrado: ` +
            `RFID=${rfidLimpio} ` +
            `Nombre=${nombre || "-"} ` +
            `Raza=${raza || "-"}`
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
        descripcion
    } = req.body;


    try {

        await pool.query(
            `
            UPDATE animales
            SET
                nombre = $1,
                raza = $2,
                descripcion = $3
            WHERE rfid = $4
            `,
            [
                nombre?.trim() || "",
                raza?.trim() || "",
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
