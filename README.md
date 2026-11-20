# AT Legacy Services quote hub

Homeowners describe a job once and get quotes from verified local companies in up to three tiers: Affordable, Mid-range, and Premium. AT Legacy Services (AT Legacy Group LLC) collects the quotes and earns a finder's fee from the company the customer hires.

One Node app serves the public site, the request API, the private customer and partner pages, and the owner's dashboard. Data lives in Postgres. On Slipway the same app runs twice: once as the public site (`hub`) and once as the dashboard (`dashboard`), which sits behind Slipway's sign-in wall.

## How a request moves

1. **Customer** fills in `site/quote.html`. The server turns the answers into a job brief (`POST /api/brief`). With an Anthropic API key, Claude writes the brief and may ask up to three follow-up questions. Without one, the brief is built from the answers.
2. The customer checks the brief and sends it (`POST /api/requests`). They land on a private page, `/r/<token>`, where quotes appear.
3. **Owner** opens the request in `/admin`, picks one verified partner per tier, and gets a private quote link, `/q/<token>`, to send to each partner.
4. **Partner** opens the link, reads the brief, and enters a price. Partners see the job but not the customer's name or contact details.
5. **Customer** compares the quotes and chooses one. Only then does the chosen partner's page show the customer's contact details. The customer hires and pays the partner directly.
6. **Owner** tracks the finder's fee on `/admin/fees`.

Repairs and upkeep go to the in-house "AT Legacy Services" partner record as a single quote with no fee.

## The dashboard

Dashboard pages share one frame (`ownerPage` in `server/lib/html.js`): a gold "Owner dashboard" strip, a compact bar, and four tabs. Pages for customers and companies use `page()` and never show the strip, so the owner can tell at a glance which pages are theirs.

| Tab | What it shows |
| --- | --- |
| Requests | What needs the owner, then every request with its next step. Requests that need a company come first |
| Partners | Companies and their status, applications to review, and the sign-up link to send to a new company |
| Fees | One row per awarded job: the fee, the final total, and whether it's paid |
| Links | Every fixed page of the site with its address, and who each one is for |

On a request, each private link has a Copy button plus one-tap ways to send it: text, email, the phone's share sheet, or open it to see what the other person sees. The text and email links are built only from digits and an encoded address (`textLink` and `emailLink` in `server/routes/admin.js`), so nothing typed into a form can change where they go.

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
| `DATABASE_URL` | Yes | Set in the service spec from the managed database `db` |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` | One sign-in method | Dashboard sign-in through WorkOS AuthKit. Setting both switches the password off |
| `ADMIN_EMAILS` | With WorkOS | Comma-separated emails allowed into the dashboard. Empty means nobody |
| `ADMIN_PASSWORD` | One sign-in method | Single dashboard password, used only when the WorkOS values are not set |
| `ANTHROPIC_API_KEY` | No | Turns on the AI review |
| `AI_MODEL` | No | Defaults to `claude-haiku-5-5` |
| `FEE_PERCENT` | No | Finder's fee on new quote links. Defaults to 5 |
| `PUBLIC_URL` | Recommended | The hub's public address, such as `https://atlegacyservices.com`. Used for the sign-in redirect, for links copied from the dashboard, and to keep sign-in cookies HTTPS-only. Defaults to the address you opened the dashboard on |
| `RESEND_API_KEY`, `NOTIFY_FROM`, `NOTIFY_TO` | No | Emails you when a request or application arrives |
| `SITE_ORIGINS` | With a static copy | Comma-separated addresses whose pages may send forms to this hub, such as `https://atlegacyservices.com` |
| `DASHBOARD_URL` | With a dashboard service | The dashboard service's public address. On the public site, `/admin` redirects there |
| `DASHBOARD_ONLY` | Dashboard service | `1` makes the app serve only `/admin` and the files it loads |
| `ADMIN_SIGNIN` | Dashboard service | `host` means the host's sign-in wall is the login. Honored only with `DASHBOARD_ONLY=1` and an https `DASHBOARD_URL` |

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

The Slipway project runs four services. A push to `main` rebuilds `at-legacy`, `hub`, and `dashboard`.

| Service | What it is | Address |
| --- | --- | --- |
| `at-legacy` | A static copy of the public pages in `site/`, built by `npm run build:site` | `atlegacyservices.com` and `www.atlegacyllc.com` |
| `hub` | The quote hub (this app): the request API and the private quote pages | Its own Slipway address |
| `dashboard` | The owner's dashboard (this app with `DASHBOARD_ONLY=1`) | Its own Slipway address, behind Slipway sign-in |
| `db` | Managed Postgres for the hub, with daily backups | Private |

Slipway deploys from its own stored copy of the service spec, not from the `slipway.yaml` in this repo. The file here mirrors it. To add or change a service, change the stored spec in Slipway and keep `slipway.yaml` in step. The database was created in Slipway as a managed database named `db`, and the hub reads its address from `${service.db.url}`.

Each `hub` deploy installs dependencies, runs `server/migrate.js` (safe to repeat, and it waits for the database on a first deploy), and starts `server/index.js`. The service is healthy when `/healthz` returns `ok`.

### Dashboard sign-in with Slipway

The `dashboard` service has Slipway's sign-in wall switched on (the service's **Auth** tab, **Members**). Slipway stops every visitor until they sign in with the GitHub account the Slipway workspace is connected to, so the app shows no login page of its own.

The app trusts the wall only after checking it. Before it lets anyone in, it requests its own public address the way a stranger would (`server/lib/edge.js`). If that request reaches the app, the wall is off and the dashboard stays locked. It also refuses requests that arrive at any address other than `DASHBOARD_URL`.

Settings on the `dashboard` service: `DASHBOARD_ONLY=1`, `ADMIN_SIGNIN=host`, `DASHBOARD_URL` (its own address), and `PUBLIC_URL` (the public site's address, used in the links you copy for customers and partners). On `hub`, `DASHBOARD_URL` makes `/admin` redirect to the dashboard.

Anyone inside the Slipway workspace's GitHub account can open the dashboard. Requests from other services in the same Slipway project skip the wall, so run only trusted services in this project.

### Dashboard sign-in with WorkOS (alternative)

Without a dashboard service, the dashboard lives at `/admin` on `hub` and stays locked until a sign-in method is set there.

1. Create a WorkOS account and open **Applications**. Under **Redirects**, add `https://<the hub's address>/admin/callback` (add the `atlegacyservices.com` one too before the domain switch).
2. In Slipway, add `WORKOS_API_KEY` as a secret, and `WORKOS_CLIENT_ID`, `ADMIN_EMAILS`, and `PUBLIC_URL` as variables, on the `hub` service. Redeploy `hub` so they take effect.
3. In WorkOS, require multi-factor authentication for sign-in.

WorkOS handles passwords, email verification, and two-factor codes. The app only checks that the signed-in, verified email is listed in `ADMIN_EMAILS`. Until the WorkOS values are set, `ADMIN_PASSWORD` works as a single-password fallback.

### How the domain serves the site today

`atlegacyservices.com` shows the public pages, and the hub does the work behind them:

- The `at-legacy` static service serves a copy of `site/` at the domain. `scripts/build-site.js` writes the hub's address into `config.js`, so the request and partner forms send to the hub.
- The hub lists the domain in `SITE_ORIGINS`, which lets pages at that address call `/api`.
- After a customer sends a request, they land on their private page at the hub's Slipway address.
- `PUBLIC_URL` is the domain, so the links you copy from the dashboard read `https://atlegacyservices.com/r/...` and `/q/...`. The static service forwards those, and `/admin`, to the hub and the dashboard (`redirects:` in the spec). The same links keep working after the hub moves onto the domain.
- The static service sets the security headers the hub would send, plus permission to call the hub (`headers:` in the spec).

To go back to the earlier site, set the `at-legacy` build command to `npm run build` in the Slipway spec and deploy. That serves `legacy-site/`.

### Moving the whole hub onto the domain

Slipway serves static sites and apps from different places. The domain's DNS record currently points at the static one, so the hub itself can't answer at `atlegacyservices.com` yet. Attaching the domain to `hub` before the DNS change takes the site down.

1. In Cloudflare DNS, change the `atlegacyservices.com` record (shown as `@`) to a CNAME for `lb.onslipway.sh`, proxy status **DNS only**. Wait until the site loads without a certificate warning.
2. In Slipway, remove `atlegacyservices.com` from `at-legacy` (**Networking**, **Also served at**) and add it to `hub` the same way.
3. Check the site, a request, and a private link at the domain.

After that the private pages are on the domain too, and the `at-legacy` service, `legacy-site/`, and the build scripts can be removed.

## Files

| Path | Purpose |
| --- | --- |
| `site/` | Public pages, styles, fonts, and browser scripts |
| `site/config.js` | Tells the forms where the API is. Empty on the hub; the static build fills in the hub's address |
| `scripts/build-site.js` | Builds the static copy of `site/` that Slipway serves at the domain |
| `legacy-site/` | The earlier public site, kept as a fallback (`npm run build`) |
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
| `server/lib/workos.js` | WorkOS AuthKit sign-in for the dashboard |
| `server/lib/edge.js` | Checks the host's sign-in wall before the dashboard service opens |
| `server/lib/security.js` | Tokens, sessions, form tokens, rate limits |
| `test/flow.test.js` | End-to-end tests |

## Editing the site

- **Services:** change the list in `server/lib/catalog.js`, then match it in the `<select>` in `site/quote.html` and `site/partners.html` and the links in `site/index.html`.
- **Tier wording:** `site/index.html` and `site/quote.html`.
- **Brand colors:** navy `#13283A`, bay blue `#2F5D7C`, sun gold `#F2B544`, sea glass `#A9D3CB`, shell `#F4F7F5`.

Don't describe AT Legacy Services as a contractor or as licensed. Partner companies are independent, and the customer contracts with them directly.
