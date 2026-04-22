# 🍱 FoodDelivery Backend API

Express + MySQL2 REST API with built-in Dashboard UI.

## Requirements
- Node.js
- XAMPP (MySQL running)
- Database: `localdelivery_db` must exist

## Setup

```bash
npm install
npm start
```

## Access
- **Dashboard UI** → http://localhost:3000
- **Products API** → http://localhost:3000/products
- **Cart API** → http://localhost:3000/cart
- **Health Check** → http://localhost:3000/health

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /products | Get all products |
| GET | /cart | Get cart contents |
| POST | /cart | Add item to cart |
| DELETE | /cart | Clear cart |
| GET | /health | Server health check |
