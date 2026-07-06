

# Alabama Beach Flag API

Backend API for the Alabama Beach Flag ecosystem.

This Cloudflare Worker powers the Alabama Beach Flag iOS app by collecting, normalizing, caching, and serving beach safety data from official and trusted sources.

## Features

- Official beach flag data where available
- Estimated conditions for supported beaches without official feeds
- ADEM water quality integration
- NOAA and marine data integration
- Cloudflare KV caching
- Shared HTTP client with retry and timeout handling
- Structured logging for scheduled refresh jobs
- Scheduled background refresh jobs
- App-ready JSON API

## Tech Stack

- Cloudflare Workers
- TypeScript
- Cloudflare KV
- Wrangler
- Vitest

## Project Structure

```text
src/
  index.ts
  registry/
  services/
  types/
  utils/

test/
wrangler.jsonc
ARCHITECTURE.md
README.md
```

## Local Development

Install dependencies:

```sh
npm install
```

Start the local Worker:

```sh
npx wrangler dev
```

Run tests:

```sh
npm test
```

Run a TypeScript type check:

```sh
npm run typecheck
```

Deploy:

```sh
npx wrangler deploy
```

## Documentation

See `ARCHITECTURE.md` for a detailed overview of the backend architecture, scheduled jobs, provider design, shared networking layer, logging strategy, deployment workflow, and future roadmap.

## Project Status

The backend is production deployed and actively maintained. It serves as the central data platform for the Alabama Beach Flag iOS app and is designed to support future clients including widgets, the website, Android, and push notification services.