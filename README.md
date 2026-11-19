# AT Legacy Services quote hub

Homeowners describe a job once and get quotes from verified local companies in up to three tiers: Affordable, Mid-range, and Premium. AT Legacy Services (AT Legacy Group LLC) collects the quotes and earns a finder's fee from the company the customer hires.

One Node service serves the public site, the request API, the private customer and partner pages, and the owner's dashboard. Data lives in Postgres.

## How a request moves

1. **Customer** fills in `site/quote.html`. The server turns the answers into a job brief (`POST /api/brief`). With an Anthropic API key, Claude writes the brief and may ask up to three follow-up questions. Without one, the brief is built from the answers.
2. The customer checks the brief and sends it (`POST /api/requests`). They land on a private page, `/r/<token>`, where quotes appear.
3. **Owner** opens the request in `/admin`, picks one verified partner per tier, and gets a private quote link, `/q/<token>`, to send to each partner.
4. **Partner** opens the link, reads the brief, and enters a price. Partners see the job but not the customer's name or contact details.
5. **Customer** compares the quotes and chooses one. Only then does the chosen partner's page show the customer's contact details. The customer hires and pays the partner directly.
6. **Owner** tracks the finder's fee on `/admin/fees`.

Repairs and upkeep go to the in-house "AT Legacy Services" partner record as a single quote with no fee.

## Rules the code enforces

- A partner can be sent a brief only when their status is Verified.
- A partner can be marked Verified only after the registration, insurance, and references checks are ticked, plus the license check when the trade needs one (`server/lib/catalog.js`).
- Each quote is in the partner's name. The site never sets a price.
- The AI sees the job description only, never the customer's name, phone, or email. Any AI failure falls back to the plain brief.
- AI briefs are capped at 300 a day across all visitors.

## Settings

Set these on the service's **Environment** tab in Slipway (see `.env.example`).

| Name | Needed | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Set by `slipway.yaml` from the managed database |
| `ADMIN_PASSWORD` | Yes | Dashboard password. The dashboard stays locked until this is set |
| `ANTHROPIC_API_KEY` | No | Turns on the AI review |
| `AI_MODEL` | No | Defaults to `claude-haiku-5-5` |
| `FEE_PERCENT` | No | Finder's fee on new quote links. Defaults to 5 |
| `PUBLIC_URL` | No | Address used in links copied from the dashboard. Defaults to the address you opened the dashboard on |
| `RESEND_API_KEY`, `NOTIFY_FROM`, `NOTIFY_TO` | No | Emails you when a request or application arrives |

## Run it locally

```
npm install
export DATABASE_URL=postgres://user:password@localhost:5432/atlegacy
export ADMIN_PASSWORD=something-long
npm run migrate
npm start
```

Open `http://localhost:3000`. The dashboard is at `/admin`.

`npm test` runs the end-to-end tests. They wipe the database named in `TEST_DATABASE_URL`, so point it at a scratch database.

## Deploy on Slipway

A push to `main` deploys everything in `slipway.yaml`:

| Service | What it is | Address |
| --- | --- | --- |
| `at-legacy` | The earlier public site, static files in `legacy-site/` | `atlegacyservices.com` until the switch below |
| `hub` | The quote hub (this app) | Its own Slipway address until the switch below |
| `db` | Postgres for the hub | Private |

Each `hub` deploy installs dependencies, runs `server/migrate.js` (safe to repeat, and it waits for the database on a first deploy), and starts `server/index.js`. The service is healthy when `/healthz` returns `ok`.

After the first deploy, add `ADMIN_PASSWORD` as a secret on the `hub` service's **Environment** tab. The dashboard at `/admin` stays locked until it is set.

### Switching the domain

`atlegacyservices.com` can serve only one service at a time. When the hub is ready to replace the earlier site, in the Slipway console:

1. Open `at-legacy`, go to **Networking**, change its address to the Slipway domain, and save. This frees `atlegacyservices.com`.
2. Open `hub`, go to **Networking**, pick `atlegacyservices.com` in the **Address** row, and save.

No DNS change is needed. Afterwards, `legacy-site/`, the `at-legacy` service, and the `build` script can be removed.

## Files

| Path | Purpose |
| --- | --- |
| `site/` | Public pages, styles, fonts, and browser scripts |
| `legacy-site/` | The earlier public site, served by the `at-legacy` service until the domain switch |
| `site/quote.html`, `site/quote.js` | Request form and brief review |
| `site/partners.html`, `site/partners.js` | Partner application |
| `server/index.js`, `server/app.js` | Server start-up and routing |
| `server/schema.sql`, `server/migrate.js`, `server/db.js` | Database tables and migration |
| `server/routes/public.js` | Request, brief, and application API |
| `server/routes/customer.js` | Customer's private quotes page |
| `server/routes/partner.js` | Partner's private quote page |
| `server/routes/admin.js` | Dashboard: requests, partners, fees |
| `server/lib/brief.js` | Plain and AI job briefs |
| `server/lib/catalog.js` | Services, tiers, and which license each service needs |
| `server/lib/security.js` | Tokens, sessions, form tokens, rate limits |
| `test/flow.test.js` | End-to-end tests |

## Editing the site

- **Services:** change the list in `server/lib/catalog.js`, then match it in the `<select>` in `site/quote.html` and `site/partners.html` and the links in `site/index.html`.
- **Tier wording:** `site/index.html` and `site/quote.html`.
- **Brand colors:** navy `#13283A`, bay blue `#2F5D7C`, sun gold `#F2B544`, sea glass `#A9D3CB`, shell `#F4F7F5`.

Don't describe AT Legacy Services as a contractor or as licensed. Partner companies are independent, and the customer contracts with them directly.
