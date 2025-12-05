# xMarket

## Overview

xMarket lets you practise trading stocks and FX pairs without risking real money. The app combines a clean React interface with Firebase authentication and Firestore storage so every user keeps a persistent paper account that mirrors a broker experience.

Key areas of the product:

- **Trade** – Submit instant spot orders or create scheduled/program orders that trigger when price thresholds are reached.
- **Portfolio** – Visualise cash vs. positions, review FIFO lots, and inspect historical wealth snapshots.
- **Explore** – Browse tickers with fundamentals, performance ranges, and price charts backed by a custom worker that proxies Yahoo Finance.

## Tech Stack

- [React 18](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vitejs.dev/)
- [Firebase Authentication](https://firebase.google.com/docs/auth) and [Cloud Firestore](https://firebase.google.com/docs/firestore) for persistence
- [Supabase](https://supabase.com/) and a Cloudflare Worker for market data ingestion
- Recharts + CSS custom layouts for charts and dashboards

## Getting Started

```bash
git clone https://github.com/loic-marigny/xMarket.git
cd xMarket
npm install
```

Create a `.env` file (see `.env.example`) and fill in:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
YAHOO_WORKER_URL=...
YAHOO_WORKER_TOKEN=...
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Then start the dev server:

```bash
npm run dev
```

Useful scripts:

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build locally |

## Scripts

All scripts of the project are explained in SCRIPTS.md file. Most are not used anymore.


## License

MIT © Omar Alshbli, Tom Delalande, Siako Mamoond, Loïc Marigny, Sarvar Tulkunov – see [`LICENSE`](LICENSE).
