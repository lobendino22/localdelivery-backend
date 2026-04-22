// server.js
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

// ── PORT (Railway / Local safe) ─────────────────────────────
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Image cache folder ───────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, "public", "img-cache");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── MYSQL CONNECTION (RAILWAY / PRODUCTION SAFE) ─────────────
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ── IMAGE CACHE FUNCTION ─────────────────────────────────────
async function downloadAndCacheImage(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("http")) return imageUrl;

  const hash = crypto.createHash("md5").update(imageUrl).digest("hex");
  const ext =
    (imageUrl.split("?")[0].match(/\.(jpg|jpeg|png|webp|gif)$/i) || [".jpg"])[0];

  const filename = hash + ext;
  const filepath = path.join(UPLOADS_DIR, filename);
  const localUrl = `/img-cache/${filename}`;

  if (fs.existsSync(filepath)) return localUrl;

  return new Promise((resolve) => {
    const client = imageUrl.startsWith("https://") ? https : http;
    const file = fs.createWriteStream(filepath);

    const req = client.get(imageUrl, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(filepath, () => {});
        return resolve(imageUrl);
      }

      res.pipe(file);

      file.on("finish", () => {
        file.close();
        resolve(localUrl);
      });
    });

    req.on("error", () => {
      file.close();
      fs.unlink(filepath, () => {});
      resolve(imageUrl);
    });
  });
}

// ── DB INIT ───────────────────────────────────────────────────
async function initDB() {
  const conn = await pool.getConnection();

  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100),
        description TEXT,
        price DECIMAL(10,2),
        category VARCHAR(50),
        image VARCHAR(1000),
        stock INT DEFAULT 10,
        is_available TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cart (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT,
        name VARCHAR(100),
        price DECIMAL(10,2),
        quantity INT DEFAULT 1,
        image VARCHAR(1000),
        category VARCHAR(50),
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        user_id VARCHAR(100),
        total DECIMAL(10,2),
        status VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("✅ Database ready");
  } finally {
    conn.release();
  }
}

// ── MAP PRODUCT ──────────────────────────────────────────────
function mapProduct(r) {
  return {
    id: String(r.id),
    name: r.name,
    description: r.description,
    price: parseFloat(r.price),
    category: r.category,
    image: r.image,
    stock: r.stock,
    isAvailable: r.is_available === 1,
  };
}

// ── ROUTES ───────────────────────────────────────────────────

// Health
app.get("/health", async (req, res) => {
  try {
    await pool.execute("SELECT 1");
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Products
app.get("/products", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT * FROM products");
    res.json(rows.map(mapProduct));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add product
app.post("/products", async (req, res) => {
  const { name, price, description, category, image, stock } = req.body;

  try {
    const img = await downloadAndCacheImage(image);

    const [result] = await pool.execute(
      `INSERT INTO products (name, price, description, category, image, stock)
       VALUES (?,?,?,?,?,?)`,
      [name, price, description, category, img, stock || 10]
    );

    res.json({ id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cart
app.get("/cart", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT * FROM cart");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add to cart
app.post("/cart", async (req, res) => {
  const { productId, name, price, quantity } = req.body;

  try {
    const [result] = await pool.execute(
      "INSERT INTO cart (product_id, name, price, quantity) VALUES (?,?,?,?)",
      [productId, name, price, quantity]
    );

    res.json({ id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Orders
app.post("/orders", async (req, res) => {
  const { id, user_id, total } = req.body;

  try {
    await pool.execute(
      "INSERT INTO orders (id, user_id, total) VALUES (?,?,?)",
      [id, user_id, total]
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START SERVER ─────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB Error:", err.message);
  });
