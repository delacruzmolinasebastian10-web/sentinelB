const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("❌ Falta JWT_SECRET en las variables de entorno.");
  process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      cliente_id: user.cliente_id,
      usuario: user.usuario,
      rol: user.rol
    },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map(x => x.trim());
  const item = parts.find(x => x.startsWith(name + "="));

  return item
    ? decodeURIComponent(item.slice(name.length + 1))
    : null;
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  const bearer = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  const token = bearer || getCookie(req, "sb_token");

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "Token requerido"
    });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Token inválido o expirado"
    });
  }
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({
        ok: false,
        error: "No tienes permisos para esta operación"
      });
    }

    next();
  };
}

async function clienteActivo(clienteId) {
  const r = await pool.query(
    "SELECT id FROM clientes WHERE id=$1 AND activo=TRUE",
    [clienteId]
  );

  return r.rows.length > 0;
}

async function getAnimal(clienteId, rfid) {
  const r = await pool.query(
    "SELECT * FROM animales WHERE cliente_id=$1 AND rfid=$2",
    [clienteId, rfid]
  );

  return r.rows[0] || null;
}

async function clasificarAlerta(clienteId, rfid, sal, tempCorp) {
  const result = await pool.query(
    `SELECT AVG(sal) AS avg_sal
     FROM lecturas
     WHERE cliente_id=$1
       AND rfid=$2
       AND timestamp >= NOW() - INTERVAL '7 days'`,
    [clienteId, rfid]
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

  if (tempCorp > 40) {
    return {
      tipo: "ROJA",
      mensaje:
        `🌡️ FIEBRE SEVERA — Animal ${rfid}: ` +
        `TC ${tempCorp}°C. Requiere evaluación veterinaria.`
    };
  }

  if (sal < avgSal * 0.7) {
    return {
      tipo: "AMARILLA",
      mensaje:
        `🟡 BAJO CONSUMO DE SAL — Animal ${rfid}: ` +
        `Sal ${Math.round(sal)}g ` +
        `(${Math.round((1 - sal / avgSal) * 100)}% bajo lo normal). ` +
        `Verificar comedero.`
    };
  }

  return {
    tipo: "NORMAL",
    mensaje: ""
  };
}

async function verificarVacunasProximas() {
  try {
    const proximas = await pool.query(`
      SELECT v.*, a.nombre
      FROM vacunas v
      LEFT JOIN animales a
        ON v.cliente_id=a.cliente_id
       AND v.rfid=a.rfid
      WHERE v.proxima_dosis IS NOT NULL
        AND v.alerta_generada=FALSE
        AND v.proxima_dosis <= CURRENT_DATE + INTERVAL '7 days'
    `);

    for (const v of proximas.rows) {
      const vencida =
        new Date(v.proxima_dosis) < new Date();

      const tipo = vencida
        ? "ROJA"
        : "AMARILLA";

      const fecha =
        new Date(v.proxima_dosis)
          .toLocaleDateString("es-MX");

      const mensaje = vencida
        ? `💉 REFUERZO VENCIDO — ${
            v.nombre || v.rfid
          }: ${v.nombre_vacuna} venció el ${fecha}.`
        : `💉 PRÓXIMO REFUERZO — ${
            v.nombre || v.rfid
          }: ${v.nombre_vacuna} programado para el ${fecha}.`;

      await pool.query(
        `INSERT INTO alertas
         (cliente_id, rfid, tipo, mensaje)
         VALUES ($1,$2,$3,$4)`,
        [
          v.cliente_id,
          v.rfid,
          tipo,
          mensaje
        ]
      );

      await pool.query(
        `UPDATE vacunas
         SET alerta_generada=TRUE
         WHERE cliente_id=$1
           AND id=$2`,
        [
          v.cliente_id,
          v.id
        ]
      );
    }
  } catch (e) {
    console.error(
      "❌ Error verificarVacunasProximas:",
      e.message
    );
  }
}


/* =========================================================
   HEALTH
========================================================= */

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      servicio: "SentinelB",
      database: "PostgreSQL"
    });
  } catch {
    res.status(500).json({
      ok: false,
      error: "Base de datos no disponible"
    });
  }
});


/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({
      ok: false,
      error: "Usuario y contraseña son obligatorios"
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.usuario,
        u.password_hash,
        u.rol,
        u.cliente_id,
        c.nombre AS cliente_nombre
      FROM usuarios u
      JOIN clientes c
        ON c.id=u.cliente_id
      WHERE u.usuario=$1
        AND u.activo=TRUE
        AND c.activo=TRUE
    `, [usuario.trim()]);

    if (!result.rows.length) {
      return res.status(401).json({
        ok: false,
        error: "Credenciales incorrectas"
      });
    }

    const user = result.rows[0];

    const valid =
      await bcrypt.compare(
        password,
        user.password_hash
      );

    if (!valid) {
      return res.status(401).json({
        ok: false,
        error: "Credenciales incorrectas"
      });
    }

    const token = signToken(user);

    const secure =
      process.env.NODE_ENV === "production"
        ? " Secure;"
        : "";

    res.setHeader(
      "Set-Cookie",
      `sb_token=${encodeURIComponent(token)}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=43200`
    );

    res.json({
      ok: true,
      token,
      usuario: user.usuario,
      rol: user.rol,
      cliente_id: user.cliente_id,
      cliente: user.cliente_nombre
    });

  } catch (e) {
    console.error(
      "❌ Error /api/login:",
      e.message
    );

    res.status(500).json({
      ok: false,
      error: "Error interno del servidor"
    });
  }
});


/* =========================================================
   LOGOUT
========================================================= */

app.post("/api/logout", (req, res) => {
  const secure =
    process.env.NODE_ENV === "production"
      ? " Secure;"
      : "";

  res.setHeader(
    "Set-Cookie",
    `sb_token=; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=0`
  );

  res.json({
    ok: true
  });
});


/* =========================================================
   USUARIO ACTUAL
========================================================= */

app.get("/api/me", auth, async (req, res) => {
  const r = await pool.query(`
    SELECT
      u.id,
      u.usuario,
      u.rol,
      u.cliente_id,
      c.nombre AS cliente
    FROM usuarios u
    JOIN clientes c
      ON c.id=u.cliente_id
    WHERE u.id=$1
      AND u.cliente_id=$2
      AND u.activo=TRUE
      AND c.activo=TRUE
  `, [
    req.user.sub,
    req.user.cliente_id
  ]);

  if (!r.rows.length) {
    return res.status(401).json({
      ok: false,
      error: "Usuario no disponible"
    });
  }

  res.json({
    ok: true,
    user: r.rows[0]
  });
});


/* =========================================================
   DATOS DEL ESP32
========================================================= */

app.post("/api/datos", async (req, res) => {
  const apiKey =
    req.headers["x-api-key"];

  const {
    rfid,
    sal,
    temp_corp,
    temp_amb
  } = req.body;

  if (!apiKey) {
    return res.status(401).json({
      ok: false,
      error: "API key requerida"
    });
  }

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
    const c = await pool.query(
      `SELECT id
       FROM clientes
       WHERE api_key=$1
         AND activo=TRUE`,
      [apiKey]
    );

    if (!c.rows.length) {
      return res.status(401).json({
        ok: false,
        error: "API key inválida"
      });
    }

    const clienteId = c.rows[0].id;

    const r =
      rfid.trim().toUpperCase();

    await pool.query(`
      INSERT INTO animales
        (cliente_id,rfid)
      VALUES ($1,$2)
      ON CONFLICT
        (cliente_id,rfid)
      DO NOTHING
    `, [
      clienteId,
      r
    ]);

    const alerta =
      await clasificarAlerta(
        clienteId,
        r,
        Number(sal),
        Number(temp_corp)
      );

    await pool.query(`
      INSERT INTO lecturas
        (
          cliente_id,
          rfid,
          sal,
          temp_corp,
          temp_amb,
          alerta
        )
      VALUES
        ($1,$2,$3,$4,$5,$6)
    `, [
      clienteId,
      r,
      Number(sal),
      Number(temp_corp),
      Number(temp_amb),
      alerta.tipo
    ]);

    if (alerta.tipo !== "NORMAL") {
      await pool.query(`
        INSERT INTO alertas
          (cliente_id,rfid,tipo,mensaje)
        VALUES
          ($1,$2,$3,$4)
      `, [
        clienteId,
        r,
        alerta.tipo,
        alerta.mensaje
      ]);
    }

    res.json({
      ok: true,
      alerta: alerta.tipo
    });

  } catch (e) {
    console.error(
      "❌ Error /api/datos:",
      e.message
    );

    res.status(500).json({
      ok: false,
      error: "Error interno del servidor"
    });
  }
});


/* =========================================================
   DASHBOARD
========================================================= */

app.get("/api/dashboard", auth, async (req, res) => {
  const c =
    req.user.cliente_id;

  try {
    const [
      a,
      l,
      n,
      r,
      u,
      p
    ] = await Promise.all([

      pool.query(
        `SELECT COUNT(*) AS total
         FROM animales
         WHERE cliente_id=$1`,
        [c]
      ),

      pool.query(
        `SELECT COUNT(*) AS total
         FROM lecturas
         WHERE cliente_id=$1
           AND timestamp::date=CURRENT_DATE`,
        [c]
      ),

      pool.query(
        `SELECT COUNT(*) AS total
         FROM alertas
         WHERE cliente_id=$1
           AND leida=FALSE`,
        [c]
      ),

      pool.query(
        `SELECT COUNT(*) AS total
         FROM alertas
         WHERE cliente_id=$1
           AND tipo='ROJA'
           AND leida=FALSE`,
        [c]
      ),

      pool.query(`
        SELECT
          l.*,
          a.nombre
        FROM lecturas l
        LEFT JOIN animales a
          ON a.cliente_id=l.cliente_id
         AND a.rfid=l.rfid
        WHERE l.cliente_id=$1
        ORDER BY l.timestamp DESC
        LIMIT 20
      `, [c]),

      pool.query(`
        SELECT
          rfid,
          AVG(sal) avg_sal,
          AVG(temp_corp) avg_tc,
          AVG(temp_amb) avg_ta,
          MAX(timestamp) ultima
        FROM lecturas
        WHERE cliente_id=$1
          AND timestamp::date=CURRENT_DATE
        GROUP BY rfid
      `, [c])
    ]);

    res.json({
      totalAnimales:
        Number(a.rows[0].total),

      lecturasHoy:
        Number(l.rows[0].total),

      alertasNoLeidas:
        Number(n.rows[0].total),

      alertasRojas:
        Number(r.rows[0].total),

      ultimas:
        u.rows,

      promediosDia:
        p.rows
    });

  } catch (e) {
    console.error(
      "❌ Error /api/dashboard:",
      e.message
    );

    res.status(500).json({
      ok: false,
      error: "Error interno del servidor"
    });
  }
});


/* =========================================================
   ALERTAS
========================================================= */

app.get("/api/alertas", auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        al.*,
        an.nombre
      FROM alertas al
      LEFT JOIN animales an
        ON an.cliente_id=al.cliente_id
       AND an.rfid=al.rfid
      WHERE al.cliente_id=$1
      ORDER BY al.timestamp DESC
      LIMIT 100
    `, [
      req.user.cliente_id
    ]);

    res.json(r.rows);

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Error interno del servidor"
    });
  }
});

app.put(
  "/api/alertas/:id/leer",
  auth,
  async (req, res) => {
    try {
      await pool.query(
        `UPDATE alertas
         SET leida=TRUE
         WHERE id=$1
           AND cliente_id=$2`,
        [
          req.params.id,
          req.user.cliente_id
        ]
      );

      res.json({
        ok: true
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);

app.put(
  "/api/alertas/leer-todas",
  auth,
  async (req, res) => {
    try {
      await pool.query(
        `UPDATE alertas
         SET leida=TRUE
         WHERE cliente_id=$1`,
        [
          req.user.cliente_id
        ]
      );

      res.json({
        ok: true
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);


/* =========================================================
   ANIMALES
========================================================= */

app.get("/api/animales", auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        a.rfid,
        a.nombre,
        a.raza,
        a.categoria,
        a.descripcion,
        COUNT(l.id) total_lecturas,
        MAX(l.timestamp) ultima_lectura,
        AVG(l.temp_corp) avg_tc
      FROM animales a
      LEFT JOIN lecturas l
        ON l.cliente_id=a.cliente_id
       AND l.rfid=a.rfid
      WHERE a.cliente_id=$1
      GROUP BY
        a.rfid,
        a.nombre,
        a.raza,
        a.categoria,
        a.descripcion
      ORDER BY
        ultima_lectura DESC NULLS LAST
    `, [
      req.user.cliente_id
    ]);

    res.json(r.rows);

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Error interno del servidor"
    });
  }
});

app.post(
  "/api/animales",
  auth,
  role("admin", "empleado"),
  async (req, res) => {

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

    const r =
      rfid.trim().toUpperCase();

    try {
      await pool.query(`
        INSERT INTO animales
          (
            cliente_id,
            rfid,
            nombre,
            raza,
            categoria,
            descripcion
          )
        VALUES
          ($1,$2,$3,$4,$5,$6)
      `, [
        req.user.cliente_id,
        r,
        nombre?.trim() || "",
        raza?.trim() || "",
        categoria || null,
        descripcion?.trim() || ""
      ]);

      res.json({
        ok: true,
        rfid: r
      });

    } catch (e) {

      if (e.code === "23505") {
        return res.status(409).json({
          ok: false,
          error:
            "Ya existe un animal con ese RFID en este cliente"
        });
      }

      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);

app.put(
  "/api/animales/:rfid",
  auth,
  role("admin", "empleado"),
  async (req, res) => {

    const {
      nombre,
      raza,
      categoria,
      descripcion
    } = req.body;

    try {
      await pool.query(`
        UPDATE animales
        SET
          nombre=$1,
          raza=$2,
          categoria=$3,
          descripcion=$4
        WHERE cliente_id=$5
          AND rfid=$6
      `, [
        nombre?.trim() || "",
        raza?.trim() || "",
        categoria || null,
        descripcion?.trim() || "",
        req.user.cliente_id,
        req.params.rfid
      ]);

      res.json({
        ok: true
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);


/* =========================================================
   HISTORIAL
========================================================= */

app.get(
  "/api/animales/:rfid/historial",
  auth,
  async (req, res) => {

    const dias =
      Math.max(
        1,
        parseInt(req.query.dias) || 7
      );

    try {
      const [h, a] =
        await Promise.all([

          pool.query(
            `SELECT *
             FROM lecturas
             WHERE cliente_id=$1
               AND rfid=$2
               AND timestamp >=
                   NOW()-($3*INTERVAL '1 day')
             ORDER BY timestamp ASC`,
            [
              req.user.cliente_id,
              req.params.rfid,
              dias
            ]
          ),

          pool.query(
            `SELECT *
             FROM animales
             WHERE cliente_id=$1
               AND rfid=$2`,
            [
              req.user.cliente_id,
              req.params.rfid
            ]
          )
        ]);

      res.json({
        animal: a.rows[0] || null,
        historial: h.rows
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);


/* =========================================================
   VACUNAS
========================================================= */

app.get("/api/vacunas", auth, async (req, res) => {
  try {
    const {
      rfid
    } = req.query;

    let q = `
      SELECT
        v.*,
        a.nombre
      FROM vacunas v
      LEFT JOIN animales a
        ON a.cliente_id=v.cliente_id
       AND a.rfid=v.rfid
      WHERE v.cliente_id=$1
    `;

    const p = [
      req.user.cliente_id
    ];

    if (rfid) {
      p.push(rfid);

      q +=
        ` AND v.rfid=$${p.length}`;
    }

    q +=
      ` ORDER BY v.fecha_aplicacion DESC`;

    const r =
      await pool.query(q, p);

    res.json(r.rows);

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Error interno del servidor"
    });
  }
});

app.post(
  "/api/vacunas",
  auth,
  role(
    "admin",
    "empleado",
    "veterinario"
  ),
  async (req, res) => {

    const {
      rfid,
      categoria,
      nombre_vacuna,
      lote,
      fecha_aplicacion,
      proxima_dosis,
      responsable,
      observaciones
    } = req.body;

    if (
      !rfid ||
      !categoria ||
      !nombre_vacuna ||
      !fecha_aplicacion
    ) {
      return res.status(400).json({
        ok: false,
        error: "Faltan campos obligatorios"
      });
    }

    try {
      await pool.query(`
        INSERT INTO vacunas
          (
            cliente_id,
            rfid,
            categoria,
            nombre_vacuna,
            lote,
            fecha_aplicacion,
            proxima_dosis,
            responsable,
            observaciones
          )
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        req.user.cliente_id,
        rfid,
        categoria,
        nombre_vacuna,
        lote || null,
        fecha_aplicacion,
        proxima_dosis || null,
        responsable || null,
        observaciones || null
      ]);

      res.json({
        ok: true
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);

app.put(
  "/api/vacunas/:id",
  auth,
  role(
    "admin",
    "empleado",
    "veterinario"
  ),
  async (req, res) => {

    const {
      categoria,
      nombre_vacuna,
      lote,
      fecha_aplicacion,
      proxima_dosis,
      responsable,
      observaciones
    } = req.body;

    try {
      await pool.query(`
        UPDATE vacunas
        SET
          categoria=$1,
          nombre_vacuna=$2,
          lote=$3,
          fecha_aplicacion=$4,
          proxima_dosis=$5,
          responsable=$6,
          observaciones=$7,
          alerta_generada=
            CASE
              WHEN proxima_dosis IS DISTINCT FROM $5
              THEN FALSE
              ELSE alerta_generada
            END
        WHERE id=$8
          AND cliente_id=$9
      `, [
        categoria,
        nombre_vacuna,
        lote || null,
        fecha_aplicacion,
        proxima_dosis || null,
        responsable || null,
        observaciones || null,
        req.params.id,
        req.user.cliente_id
      ]);

      res.json({
        ok: true
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);

app.delete(
  "/api/vacunas/:id",
  auth,
  role("admin"),
  async (req, res) => {

    try {
      await pool.query(
        `DELETE FROM vacunas
         WHERE id=$1
           AND cliente_id=$2`,
        [
          req.params.id,
          req.user.cliente_id
        ]
      );

      res.json({
        ok: true
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);


/* =========================================================
   REPORTE
========================================================= */

app.get("/api/reporte", auth, async (req, res) => {

  const {
    desde,
    hasta,
    rfid
  } = req.query;

  const p = [
    req.user.cliente_id
  ];

  let q = `
    SELECT
      l.*,
      a.nombre
    FROM lecturas l
    LEFT JOIN animales a
      ON a.cliente_id=l.cliente_id
     AND a.rfid=l.rfid
    WHERE l.cliente_id=$1
  `;

  if (desde) {
    p.push(desde);

    q +=
      ` AND l.timestamp::date >= $${p.length}`;
  }

  if (hasta) {
    p.push(hasta);

    q +=
      ` AND l.timestamp::date <= $${p.length}`;
  }

  if (rfid) {
    p.push(rfid);

    q +=
      ` AND l.rfid=$${p.length}`;
  }

  q +=
    ` ORDER BY l.timestamp DESC`;

  try {

    const r =
      await pool.query(q, p);

    const filas =
      r.rows.map(x =>
        `${x.id},"${String(x.rfid || "")
          .replace(/"/g, '""')}","${String(x.nombre || "")
          .replace(/"/g, '""')}",${x.sal},${x.temp_corp},${x.temp_amb},${x.alerta},"${x.timestamp}"`
      );

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

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: "Error interno del servidor"
    });
  }
});


/* =========================================================
   CLIENTES / MULTITENENCIA
========================================================= */

app.post(
  "/api/clientes",
  auth,
  role("superadmin"),
  async (req, res) => {

    const {
      nombre
    } = req.body;

    if (!nombre?.trim()) {
      return res.status(400).json({
        ok: false,
        error: "Nombre requerido"
      });
    }

    const apiKey =
      crypto.randomBytes(32)
        .toString("hex");

    const r =
      await pool.query(
        `INSERT INTO clientes
          (nombre,api_key)
         VALUES
          ($1,$2)
         RETURNING id,nombre,api_key`,
        [
          nombre.trim(),
          apiKey
        ]
      );

    res.status(201).json({
      ok: true,
      cliente: r.rows[0]
    });
  }
);


/* =========================================================
   USUARIOS
========================================================= */

app.post(
  "/api/usuarios",
  auth,
  role("superadmin", "admin"),
  async (req, res) => {

    const {
      usuario,
      password,
      rol,
      cliente_id
    } = req.body;

    const clienteId =
      req.user.rol === "superadmin"
        ? cliente_id
        : req.user.cliente_id;

    if (
      !usuario ||
      !password ||
      !rol ||
      !clienteId
    ) {
      return res.status(400).json({
        ok: false,
        error: "Faltan campos"
      });
    }

    if (
      ![
        "admin",
        "empleado",
        "veterinario"
      ].includes(rol)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Rol inválido"
      });
    }

    const hash =
      await bcrypt.hash(
        password,
        12
      );

    try {

      const r =
        await pool.query(`
          INSERT INTO usuarios
            (
              cliente_id,
              usuario,
              password_hash,
              rol
            )
          VALUES
            ($1,$2,$3,$4)
          RETURNING
            id,
            cliente_id,
            usuario,
            rol
        `, [
          clienteId,
          usuario.trim(),
          hash,
          rol
        ]);

      res.status(201).json({
        ok: true,
        usuario: r.rows[0]
      });

    } catch (e) {

      if (e.code === "23505") {
        return res.status(409).json({
          ok: false,
          error:
            "Ese usuario ya existe en el cliente"
        });
      }

      res.status(500).json({
        ok: false,
        error: "Error interno del servidor"
      });
    }
  }
);


/* =========================================================
   ARCHIVO PRINCIPAL
========================================================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "login.html")
  );
});

app.use((req, res) => {

  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      ok: false,
      error: "Endpoint no encontrado"
    });
  }

  res.status(404).send(
    "Página no encontrada"
  );
});


/* =========================================================
   INICIALIZACIÓN DE BASE DE DATOS
========================================================= */

async function initDB() {

  const client =
    await pool.connect();

  try {

    await client.query("SELECT 1");

    const column =
      await client.query(`
        SELECT 1
        FROM information_schema.columns
        WHERE table_name='usuarios'
          AND column_name='password'
      `);

    if (column.rows.length) {

      const legacy =
        await client.query(`
          SELECT
            id,
            password
          FROM usuarios
          WHERE password_hash IS NULL
            AND password IS NOT NULL
        `);

      for (const u of legacy.rows) {

        const hash =
          await bcrypt.hash(
            String(u.password),
            12
          );

        await client.query(
          `UPDATE usuarios
           SET password_hash=$1
           WHERE id=$2`,
          [
            hash,
            u.id
          ]
        );
      }

      await client.query(
        "ALTER TABLE usuarios DROP COLUMN password"
      );

      console.log(
        `🔐 ${legacy.rows.length} contraseña(s) migrada(s) a bcrypt`
      );
    }

    const superadmin =
      await client.query(`
        SELECT id
        FROM usuarios
        WHERE rol='superadmin'
          AND activo=TRUE
        LIMIT 1
      `);

    if (!superadmin.rows.length) {

      await client.query(`
        UPDATE usuarios
        SET rol='superadmin'
        WHERE id=(
          SELECT id
          FROM usuarios
          ORDER BY id
          LIMIT 1
        )
      `);
    }

    console.log(
      "✅ PostgreSQL conectado"
    );

  } finally {

    client.release();
  }
}


/* =========================================================
   INICIAR SERVIDOR
========================================================= */

async function startServer() {

  await initDB();

  await verificarVacunasProximas();

  setInterval(
    verificarVacunasProximas,
    6 * 60 * 60 * 1000
  );

  app.listen(
    PORT,
    "0.0.0.0",
    () =>
      console.log(
        `🐄 SentinelB escuchando en ${PORT}`
      )
  );
}

startServer().catch(e => {

  console.error(
    "❌ Error iniciando SentinelB:",
    e
  );

  process.exit(1);
});
