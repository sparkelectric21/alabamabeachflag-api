

# Alabama Beach Flag API

Backend API for the Alabama Beach Flag ecosystem.

This Cloudflare Worker powers the Alabama Beach Flag iOS app by collecting, normalizing, caching, and serving beach safety data from official and trusted sources.

## Features

- Official beach flag data where available
- Estimated conditions for supported beaches without official feeds
- ADEM water quality integration
- NOAA and marine data integration
- Cloudflare KV caching
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

Deploy:

```sh
npx wrangler deploy
```

## Documentation

See `ARCHITECTURE.md` for a detailed overview of the backend design, scheduled jobs, data providers, future roadmap, and development philosophy.

## Project Status

This backend is under active development and serves as the central data platform for the Alabama Beach Flag application and future clients.