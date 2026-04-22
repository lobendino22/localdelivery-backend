const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ── Serve the dashboard UI ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Local image cache folder ───────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'public', 'img-cache');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Database connection pool (XAMPP defaults) ──────────────────────────────
const pool = mysql.createPool({
  host:     'localhost',
  user:     'root',
  password: '',
  database: 'localdelivery_db',
  waitForConnections: true,
  connectionLimit: 10,
});


// ── Download external image → save locally → return local URL ─────────────
// This avoids CORS and hotlink-protection issues permanently.
async function downloadAndCacheImage(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('http')) return imageUrl;

  // Use a hash of the URL as filename to avoid duplicates
  const hash    = crypto.createHash('md5').update(imageUrl).digest('hex');
  const ext     = (imageUrl.split('?')[0].match(/\.(jpg|jpeg|png|webp|gif|svg)$/i) || ['.jpg'])[0] || '.jpg';
  const filename = hash + ext;
  const filepath = path.join(UPLOADS_DIR, filename);
  const localUrl = `/img-cache/${filename}`;

  // If already cached, return immediately
  if (fs.existsSync(filepath)) return localUrl;

  return new Promise((resolve) => {
    const client = imageUrl.startsWith('https://') ? https : http;
    const file   = fs.createWriteStream(filepath);

    const req = client.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept':     'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer':    new URL(imageUrl).origin,
      },
      timeout: 10000,
    }, (response) => {
      // Follow redirects (301, 302, 303, 307, 308)
      if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location) {
        file.close();
        fs.unlink(filepath, () => {});
        downloadAndCacheImage(response.headers.location).then(resolve);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(filepath, () => {});
        console.warn(`⚠  Image download failed (${response.statusCode}): ${imageUrl}`);
        resolve(imageUrl); // fall back to original URL
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`✅  Cached image: ${localUrl}`);
        resolve(localUrl);
      });
    });

    req.on('error', (err) => {
      file.close();
      fs.unlink(filepath, () => {});
      console.warn(`⚠  Image download error: ${err.message}`);
      resolve(imageUrl); // fall back
    });

    req.on('timeout', () => {
      req.destroy();
      file.close();
      fs.unlink(filepath, () => {});
      console.warn(`⚠  Image download timeout: ${imageUrl}`);
      resolve(imageUrl);
    });
  });
}

// ── Auto-create tables and seed products ───────────────────────────────────
async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        name         VARCHAR(100)  NOT NULL,
        description  TEXT,
        price        DECIMAL(10,2) NOT NULL,
        category     VARCHAR(50)   NOT NULL DEFAULT 'General',
        image        VARCHAR(1000),
        stock        INT           NOT NULL DEFAULT 10,
        is_available TINYINT(1)   NOT NULL DEFAULT 1,
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cart (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT           NOT NULL,
        name       VARCHAR(100)  NOT NULL,
        price      DECIMAL(10,2) NOT NULL,
        quantity   INT           NOT NULL DEFAULT 1,
        image      VARCHAR(1000),
        category   VARCHAR(50),
        added_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);

    // Extend image column if it exists but is too short
    try {
      await conn.execute(`ALTER TABLE products MODIFY COLUMN image VARCHAR(1000)`);
    } catch (e) { /* already correct size */ }
    try {
      await conn.execute(`ALTER TABLE cart MODIFY COLUMN image VARCHAR(1000)`);
    } catch (e) { /* already correct size */ }

    const [rows] = await conn.execute('SELECT COUNT(*) AS cnt FROM products');
    if (rows[0].cnt === 0) {
      // Download and cache all seed images locally at startup
      const seedData = [
        { name: 'Adobo Rice Bowl',   desc: 'Classic Filipino adobo over steamed white rice',        price: 75.00,  cat: 'Viand',   img: 'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=400&auto=format&fit=crop', stock: 20 },
        { name: 'Sinigang na Baboy', desc: 'Sour tamarind broth with tender pork ribs',             price: 120.00, cat: 'Soup',    img: 'https://images.unsplash.com/photo-1547592180-85f173990554?w=400&auto=format&fit=crop', stock: 15 },
        { name: 'Pancit Canton',     desc: 'Stir-fried egg noodles with mixed vegetables',          price: 85.00,  cat: 'Noodles', img: 'https://images.unsplash.com/photo-1555126634-323283e090fa?w=400&auto=format&fit=crop', stock: 18 },
        { name: 'Lechon Kawali',     desc: 'Deep-fried crispy pork belly with liver sauce',         price: 110.00, cat: 'Viand',   img: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=400&auto=format&fit=crop', stock: 12 },
        { name: 'Halo-Halo Special', desc: 'Shaved ice dessert with mixed fruits and leche flan',   price: 95.00,  cat: 'Dessert', img: 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=400&auto=format&fit=crop', stock: 25 },
        { name: 'Garlic Fried Rice', desc: 'Fluffy sinangag with fried garlic and sunny-side egg',  price: 55.00,  cat: 'Rice',    img: 'https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=400&auto=format&fit=crop', stock: 30 },
        { name: 'Calamansi Juice',   desc: 'Freshly squeezed Philippine citrus juice',              price: 40.00,  cat: 'Drinks',  img: 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=400&auto=format&fit=crop', stock: 50 },
        { name: 'Mami Soup',         desc: 'Egg noodle soup with chicken and spring onions',        price: 90.00,  cat: 'Noodles', img: 'https://images.unsplash.com/photo-1569050467447-ce54b3bbc37d?w=400&auto=format&fit=crop', stock: 14 },
        { name: 'Leche Flan',        desc: 'Silky caramel custard — the Filipino favourite',        price: 65.00,  cat: 'Dessert', img: 'https://images.unsplash.com/photo-1551024601-bec78aea704b?w=400&auto=format&fit=crop', stock: 20 },
        { name: 'Buko Pandan',       desc: 'Young coconut strips with pandan jelly in cream',       price: 70.00,  cat: 'Dessert', img: 'https://images.unsplash.com/photo-1563805042-7684c019e1cb?w=400&auto=format&fit=crop', stock: 16 },
      ];

      for (const p of seedData) {
        const cachedImg = await downloadAndCacheImage(p.img);
        await conn.execute(
          `INSERT INTO products (name, description, price, category, image, stock) VALUES (?,?,?,?,?,?)`,
          [p.name, p.desc, p.price, p.cat, cachedImg, p.stock]
        );
      }
      console.log('✅  Seeded 10 products.');
    }
    console.log('✅  Database ready.');
  } finally {
    conn.release();
  }
}

// ── Helper: map DB row → Product object ────────────────────────────────────
function mapProduct(r) {
  return {
    id:           String(r.id),
    name:         r.name,
    description:  r.description,
    price:        parseFloat(r.price),
    category:     r.category,
    image:        r.image,
    stock:        r.stock,
    isAvailable:  r.is_available === 1,
    restaurantId: 'local-store',
  };
}

// ── GET /health ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.execute('SELECT 1');
    const [[{ products }]] = await pool.execute('SELECT COUNT(*) AS products FROM products');
    const [[{ cart }]]     = await pool.execute('SELECT COUNT(*) AS cart FROM cart');
    res.json({
      status:    'ok',
      database:  'connected',
      uptime:    process.uptime().toFixed(1) + 's',
      tables:    { products, cart },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── GET /products ──────────────────────────────────────────────────────────
app.get('/products', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM products ORDER BY category, name');
    res.json(rows.map(mapProduct));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /products/:id ──────────────────────────────────────────────────────
app.get('/products/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
    res.json(mapProduct(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /products — Admin: Add new product ────────────────────────────────
app.post('/products', async (req, res) => {
  const { name, description, price, category, image, stock, isAvailable } = req.body;

  if (!name?.trim() || !price) {
    return res.status(400).json({ error: 'name and price are required.' });
  }

  // Reject base64 images (they are too large for MySQL VARCHAR and should not be stored)
  if (image && (image.startsWith('data:') || (!image.startsWith('http') && image.length > 300))) {
    return res.status(400).json({
      error: 'Hindi pwede ang base64 image. Gamitin ang image URL (http/https) galing sa internet.'
    });
  }

  try {
    // Download and cache the image locally to avoid CORS/hotlink issues
    const cachedImage = image ? await downloadAndCacheImage(image) : null;

    const [result] = await pool.execute(
      `INSERT INTO products (name, description, price, category, image, stock, is_available)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        description || '',
        parseFloat(price),
        category || 'General',
        cachedImage || null,
        parseInt(stock) || 10,
        isAvailable !== false ? 1 : 0
      ]
    );
    const [rows] = await pool.execute('SELECT * FROM products WHERE id = ?', [result.insertId]);
    res.status(201).json(mapProduct(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /products/:id — Admin: Update product (name, price, image, stock, etc.) ─
app.patch('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, price, category, image, stock, isAvailable } = req.body;

  // Check product exists
  try {
    const [existing] = await pool.execute('SELECT id FROM products WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Product not found.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Reject base64 images
  if (image && (image.startsWith('data:') || (!image.startsWith('http') && image.length > 300))) {
    return res.status(400).json({
      error: 'Hindi pwede ang base64 image. Gamitin ang image URL (http/https) galing sa internet.'
    });
  }

  // Build dynamic SET clause — only update fields that were sent
  const fields = [];
  const values = [];

  if (name        !== undefined) { fields.push('name = ?');         values.push(name.trim()); }
  if (description !== undefined) { fields.push('description = ?');  values.push(description); }
  if (price       !== undefined) { fields.push('price = ?');        values.push(parseFloat(price)); }
  if (category    !== undefined) { fields.push('category = ?');     values.push(category); }
  let resolvedImage = image;
  if (image !== undefined && image && image.startsWith('http')) {
    // Download and cache externally-hosted images locally
    resolvedImage = await downloadAndCacheImage(image);
  }
  if (image       !== undefined) { fields.push('image = ?');        values.push(resolvedImage || null); }
  if (stock       !== undefined) { fields.push('stock = ?');        values.push(parseInt(stock)); }
  if (isAvailable !== undefined) { fields.push('is_available = ?'); values.push(isAvailable ? 1 : 0); }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'Walang fields na binago.' });
  }

  values.push(id); // for WHERE clause

  try {
    await pool.execute(
      `UPDATE products SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    const [rows] = await pool.execute('SELECT * FROM products WHERE id = ?', [id]);
    res.json(mapProduct(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /products/:id — Admin: Remove product ───────────────────────────
app.delete('/products/:id', async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT id FROM products WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Product not found.' });

    await pool.execute('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ message: 'Product deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /cart ──────────────────────────────────────────────────────────────
app.get('/cart', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM cart ORDER BY added_at DESC');
    const items = rows.map(r => ({
      id:        r.id,
      productId: r.product_id,
      name:      r.name,
      price:     parseFloat(r.price),
      quantity:  r.quantity,
      image:     r.image,
      category:  r.category,
      subtotal:  parseFloat(r.price) * r.quantity,
    }));
    const total = items.reduce((s, i) => s + i.subtotal, 0);
    res.json({ items, total: parseFloat(total.toFixed(2)), count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /cart ─────────────────────────────────────────────────────────────
app.post('/cart', async (req, res) => {
  const { productId, name, price, quantity = 1, image, category } = req.body;
  if (!productId || !name || !price)
    return res.status(400).json({ error: 'productId, name, and price are required.' });

  try {
    const [prod] = await pool.execute('SELECT id FROM products WHERE id = ?', [productId]);
    if (!prod.length) return res.status(404).json({ error: 'Product not found.' });

    const [existing] = await pool.execute('SELECT id, quantity FROM cart WHERE product_id = ?', [productId]);
    let row;

    if (existing.length) {
      const newQty = existing[0].quantity + Number(quantity);
      await pool.execute('UPDATE cart SET quantity = ? WHERE id = ?', [newQty, existing[0].id]);
      const [u] = await pool.execute('SELECT * FROM cart WHERE id = ?', [existing[0].id]);
      row = u[0];
    } else {
      const [result] = await pool.execute(
        'INSERT INTO cart (product_id, name, price, quantity, image, category) VALUES (?,?,?,?,?,?)',
        [productId, name, price, quantity, image || null, category || null]
      );
      const [i] = await pool.execute('SELECT * FROM cart WHERE id = ?', [result.insertId]);
      row = i[0];
    }

    res.status(201).json({
      message: 'Item added to cart successfully.',
      cartItem: {
        id: row.id, productId: row.product_id, name: row.name,
        price: parseFloat(row.price), quantity: row.quantity,
        subtotal: parseFloat(row.price) * row.quantity
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /cart ───────────────────────────────────────────────────────────
app.delete('/cart', async (req, res) => {
  try {
    await pool.execute('DELETE FROM cart');
    res.json({ message: 'Cart cleared.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── GET /image-proxy?url=... — Proxy external images to avoid CORS ─────────
// Use this when browser blocks direct image loads from other domains.
// In Angular: [src]="'http://localhost:3000/image-proxy?url=' + encodeURIComponent(product.image)"
app.get('/image-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  // Only allow http/https URLs
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return res.status(400).send('Only http/https URLs allowed');
  }

  try {
    const client = url.startsWith('https://') ? https : http;
    const request = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': url,
      }
    }, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          res.redirect(`/image-proxy?url=${encodeURIComponent(redirectUrl)}`);
          return;
        }
      }

      if (response.statusCode !== 200) {
        return res.status(response.statusCode || 500).send('Failed to fetch image');
      }

      const contentType = response.headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 1 day
      res.setHeader('Access-Control-Allow-Origin', '*');
      response.pipe(res);
    });

    request.on('error', (err) => {
      console.error('Image proxy error:', err.message);
      res.status(500).send('Image fetch failed');
    });

    request.setTimeout(8000, () => {
      request.destroy();
      res.status(504).send('Image fetch timeout');
    });

  } catch (err) {
    console.error('Image proxy exception:', err.message);
    res.status(500).send('Image proxy error');
  }
});


// ── POST /admin/reseed-images — Re-download & cache ALL product images ──────
// Hit this once after deploying to fix existing products with external URLs.
// No auth needed since this is a local dev tool.
app.post('/admin/reseed-images', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, image FROM products');
    let updated = 0;
    const results = [];

    for (const row of rows) {
      const img = row.image;
      // Skip if already a local cached image or null
      if (!img || img.startsWith('/img-cache/') || img.startsWith('/public/')) {
        results.push({ id: row.id, status: 'skipped', image: img });
        continue;
      }

      // Download and cache it
      const localUrl = await downloadAndCacheImage(img);
      if (localUrl !== img) {
        await pool.execute('UPDATE products SET image = ? WHERE id = ?', [localUrl, row.id]);
        updated++;
        results.push({ id: row.id, status: 'cached', original: img, cached: localUrl });
      } else {
        results.push({ id: row.id, status: 'failed', image: img });
      }
    }

    res.json({
      message: `Done. ${updated} of ${rows.length} product images cached locally.`,
      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀  API running on http://localhost:${PORT}`);
    console.log(`\n🎨  Dashboard UI → http://localhost:${PORT}\n`);
    console.log(`    GET    http://localhost:${PORT}/products`);
    console.log(`    POST   http://localhost:${PORT}/products       ← Admin: add product`);
    console.log(`    PATCH  http://localhost:${PORT}/products/:id   ← Admin: update (image, price, etc.)`);
    console.log(`    DELETE http://localhost:${PORT}/products/:id   ← Admin: delete product`);
    console.log(`    GET    http://localhost:${PORT}/cart`);
    console.log(`    POST   http://localhost:${PORT}/cart`);
    console.log(`    DELETE http://localhost:${PORT}/cart`);
    console.log(`    GET    http://localhost:${PORT}/health\n`);
  });
}).catch(err => {
  console.error('❌  DB init failed:', err.message);
  console.error('    Make sure XAMPP MySQL is running and localdelivery_db exists.');
  process.exit(1);
});