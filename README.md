# ZARSEV — Global Agro-Export & Maritime Cold-Chain Platform

**ZARSEV** is a sovereign digital export infrastructure and trade management platform designed to streamline, verify, and secure Egyptian agricultural exports from farm packhouses to destination seaports worldwide.

---

## Key Features

- **Public Export Catalog:** Interactive produce catalog featuring citrus (Valencia oranges), IQF frozen produce, tubers, and premium dates with live search and category filtering.
- **Request for Quotation (RFQ) Engine:** Public buyer RFQ submission with rate-limiting, reference code generation (`RFQ-2026-XXXXX`), and secure token-based quotation tracking.
- **Role-Based Sovereign Portals:**
  - **HQ Admin Console (`/portal/admin`):** RFQ queue management, factory assignment, audit logs, and team permissions.
  - **Manufacturer Portal (`/portal/manufacturer`):** Strict multi-tenant isolation, structured Incoterms quotation drafting (FOB, CIF, CFR), batch allocations, and document repository.
  - **Buyer Portal (`/portal/buyer`):** Real-time quote tracking, Proforma Invoice inspection, counter-offers, and commercial acceptance.
  - **Logistics & Reefer Hub (`/portal/logistics`):** Packhouse registry, vessel tracking, and IoT reefer container cold-chain telemetry monitoring (defrost mode, setpoint, temperature breaches).
- **Smart Catalog Ingestion (`/importer`):** Automated product extraction from supplier price lists (PDF/Excel) with administrative review and approvals (`/admin/approvals`).

---

## Tech Stack

- **Runtime & Server:** Node.js, Express.js
- **Database Support:** SQLite (default/demo) & PostgreSQL (production dual-engine)
- **Frontend:** Semantic HTML5, TailwindCSS, IBM Plex Sans Arabic / English
- **Security:** HMAC-SHA256 sensor ingress validation, cookie/token CSRF defense, strict tenant isolation, and cryptographic token comparison.

---

## Quick Start (Run Locally)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```

3. **Start the application:**
   ```bash
   npm start
   ```

4. **Access in browser:**
   - Public Website: `http://localhost:3000` or `http://localhost:3001`
   - Catalog: `http://localhost:3001/catalog`
   - Admin Portal: `http://localhost:3001/portal/admin`
   - Manufacturer Portal: `http://localhost:3001/portal/manufacturer`
   - Buyer Console: `http://localhost:3001/portal/buyer`
   - Logistics Hub: `http://localhost:3001/portal/logistics`

---

## Deployment (Free Cloud Hosting)

### Render.com
1. Create a new **Web Service** on [Render](https://render.com).
2. Connect this repository: `bassiony58-ux/zarsev`.
3. Configure:
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Set Environment Variables:
   - `NODE_ENV` = `development` *(or set `JWT_SECRET` for production)*
   - `ALLOWED_ORIGINS` = `*`

---

## License

ISC License — Developed for ZARSEV Global Trade Platform.
