# @bbm/web

Next.js frontend. API calls go to `/api/*`, which `src/proxy.ts` forwards to
`API_INTERNAL_URL` when it is set (read per request). With
`NEXT_PUBLIC_API_MOCKING=enabled`, MSW mocks the API in the browser instead.

## Pages and mocks

- Routes: `/submit` and `/contracts` (developer), `/auditor` (queue, claim,
  stake gate, PoC), `/arbiter` (disputes), plus `/healthz` for the container
  probe. A header role switcher (zustand, persisted) picks the role; the
  wallet is a mock (`src/lib/wallet`).
- API clients live in `src/lib/api/{developer,auditor,arbiter}.ts` and parse
  responses with the `@bbm/shared` schemas.
- Mocks: `src/mocks/handlers/{developer,auditor,arbiter}.ts`, composed in
  `handlers/index.ts`, backed by an in-memory mock DB split the same way
  (`src/mocks/db/`). `browser.ts` starts the worker in the app; `server.ts`
  runs the same handlers under vitest.
- Without mocking, only `/api/contracts` exists on the real API today, so
  most pages need the mocks.

## Sign-in

Against a real chain the API wants Sign-In with Ethereum (see
[api.md](api.md#sign-in-sign-in-with-ethereum)). `src/lib/api/auth.ts`
(`signIn`, `ensureSignedIn`) takes any `MessageSigner`
(`{ address, signMessage({ message }) }`), so an anvil `PrivateKeyAccount`
and an injected wallet account both work. Before it asks the signer, it
checks that the API's message is SIWE, for that address and for the page's
own domain (`window.location.host`). The anvil keys sign without a prompt, so
this check is the only one they get. Sign-ins run one at a time, because the
session is one cookie. Leave `AUTH_ORIGIN` unset on the API for
`pnpm --filter @bbm/web dev` (the messages then name `localhost:3000`, which
the browser's `Origin` header gives), or set it to the URL you browse.

## Scripts

```sh
NEXT_PUBLIC_API_MOCKING=enabled pnpm dev    # or: pnpm --filter @bbm/web dev
pnpm --filter @bbm/web lint
pnpm --filter @bbm/web typecheck
pnpm --filter @bbm/web test                 # vitest + MSW, no network
pnpm --filter @bbm/web build
```

## Container image

`apps/web/Dockerfile` builds the `output: "standalone"` server. Build it from
the repo root with BuildKit (it uses a cache mount for the pnpm store):

```sh
docker build -f apps/web/Dockerfile -t bbm-web .
docker run -p 3000:3000 -e API_INTERNAL_URL=http://api:3001 bbm-web
```

- `NEXT_PUBLIC_API_MOCKING` is a build arg (default `disabled`). Next inlines
  it into the client bundle, so changing it means rebuilding the image
  (`--build-arg NEXT_PUBLIC_API_MOCKING=enabled`).
- `API_INTERNAL_URL` is a runtime env var, so one image can target any API.
- The server runs as `node` with `node apps/web/server.js` from `/app`, on
  `HOSTNAME=0.0.0.0` and `PORT=3000`. The healthcheck calls `GET /healthz`.
