# AT Legacy Services quote hub

Homeowners describe a job once and get quotes from verified local companies in up to three tiers: Affordable, Mid-range, and Premium. AT Legacy Services (AT Legacy Group LLC) collects the quotes and earns a finder's fee from the company the customer hires.

One Node app serves the public site, the request API, the private customer and partner pages, and the owner's dashboard. Data lives in Postgres. On Slipway the same app runs twice: once as the public site (`hub`) and once as the dashboard (`dashboard`), which sits behind Slipway's sign-in wall.

## How a request moves

1. **Customer** fills in `site/quote.html`. The server turns the answers into a job brief (`POST /api/brief`). With an Anthropic API key, Claude writes the brief and may ask up to three follow-up questions. Without one, the brief is built from the answers.
2. The customer checks the brief and sends it (`POST /api/requests`). They land on a private page, `/r/<token>`, where quotes appear.
3. **Owner** opens the request in `/admin`, picks one approved partner per tier, and gets a private quote link, `/q/<token>`, to send to each partner.
4. **Partner** opens the link, reads the brief, and enters a price. Partners see the job but not the customer's name or contact details.
5. **Customer** compares the quotes and chooses one. Only then does the chosen partner's page show the customer's contact details. The customer hires and pays the partner directly.
6. **Owner** tracks the finder's fee on `/admin/fees`.

Repairs and upkeep go to the in-house "AT Legacy Services" partner record as a single quote with no fee.

## The dashboard

Dashboard pages share one frame (`ownerPage` in `server/lib/html.js`): a gold "Owner dashboard" strip, a compact bar, and four tabs. Pages for customers and companies use `page()` and never show the strip, so the owner can tell at a glance which pages are theirs.

| Tab | What it shows |
| --- | --- |
| Requests | What needs the owner, then every request with its next step. Requests that need a company come first |
| Partners | The approved vendor list, the companies working toward it, the standard, and the sign-up link to send to a new company |
| Fees | One row per awarded job: the fee, the final total, and whether it's paid |
| Links | Every fixed page of the site with its address, and who each one is for |

On a request, each private link has a Copy button plus one-tap ways to send it: text, email, the phone's share sheet, or open it to see what the other person sees. The text and email links are built only from digits and an encoded address (`textLink` and `emailLink` in `server/routes/admin.js`), so nothing typed into a form can change where they go.

### Private links: names and history

Every request has a reference, such as R1003. A private link is the secret that opens the page, then a name for people to read:

| Link | Looks like | The name says |
| --- | --- | --- |
| Customer's page | `/r/<secret>/r1003-dana` | The reference and the customer's first name |
| Company's quote page | `/q/<secret>/r1003-affordable-budget-fence` | The reference, the tier, and the company. Never the customer |

The name is a label, not a lock: the secret alone still opens the page, so links sent before this change keep working. The dashboard shows each link's ending, and each page says who it is for, so a wrong link is easy to catch.

The `link_events` table records when the owner copies, texts, emails, or shares a link from the dashboard, and when the person opens it. Reloads within two minutes count once. A message app drawing a preview of the link is not counted, and neither is the owner opening the page from the dashboard (those links carry `?owner=1`). Only the time is stored: no address, device, or location. The code is in `server/lib/links.js`.

### The spreadsheet of open requests

**Open the spreadsheet view** on the Requests tab shows every open request in one sheet, read from the database when the page loads. The page reloads itself every minute. **Download for Excel** builds a real `.xlsx` file at that moment with three sheets: open requests, every company quote on them, and all requests including closed ones. Dates and money are real numbers, the header row is frozen with filters on, and each reference opens that request in the dashboard. The file names each private link (`r1003-dana`) but leaves out its address, so a copy that gets passed along can't open anyone's page. It does hold customers' names and phone numbers, so treat it like the dashboard.

`server/lib/xlsx.js` writes the workbook with no outside packages. Everything a person typed is written as text, never as a formula.

### Pictures and files

On the request form a customer can add up to 10 files in three groups: **The area today**, **Ideas you like**, and **Plans or documents**. They can add or remove files later on their private page, until the request is closed. The owner can use that same page to add pictures a customer sent some other way.

- **Pictures** are redrawn in the customer's browser as JPEGs no larger than 1600 pixels on the long side (`site/uploads.js`). That makes them small enough to send from a phone, and it leaves the camera's notes behind, including the GPS position. The server removes those notes again from whatever arrives (`server/lib/files.js`), so nothing depends on the browser doing it.
- **Documents** are PDFs of up to 3 MB, or pictures of pages.
- **Who sees what.** The customer and the owner see every file. A company sees a file only while it can still quote, or after it is chosen, and only if the file is shared. Pictures are shared as soon as they are added. A document waits for the owner, because surveys and plans often show a name or an address: the request's page in the dashboard has **Share with companies** and **Keep private** under each one, and the Requests tab says when one is waiting. Companies get plain names such as "Picture 2", never the file's own name.
- **Where they are kept.** In the database (`request_files`). Its disk is 1 GB and the database's own log takes about half of that, so files are held to 200 MB in all, 60 MB a day, and 15 MB a request. The Requests tab shows how much is used and warns at 80%. At 100% the form still sends requests, but tells customers their files didn't go with them. To hold more, give the database a larger disk in Slipway and raise `LIMITS.totalBytes`, or move files to a storage bucket.
- A PDF from a customer is a file from a stranger. It downloads instead of opening inside the site. Treat it like an email attachment.

### Certification: the approved vendor list

A company gets onto the approved vendor list in three steps, all on the Partners tab.

1. **Paperwork.** On the company's page the owner ticks the checks that apply: registration, license, insurance, references.
2. **Site visit.** The owner visits a job site or the company's shop and fills in the scorecard on the same page. Each item comes from the standard and is either a must-meet item or worth points.
3. **Approval.** A visit that meets every must-meet item, plus finished paperwork, lets the owner approve the company. The points suggest its tier, and the owner can give a different one.

**Your standard** (`/admin/standard`) is the owner's own list: each item's wording, whether it is a must-meet item or how many points it is worth, how many points Mid-range and Premium need, and how many months an approval lasts. It starts from a draft in `server/lib/standard.js` and is stored in the `settings` table. A visit keeps the wording it was scored against, so changing the standard later doesn't rewrite old visits.

What the Partners tab shows for each company:

| It says | It means |
| --- | --- |
| Check their paperwork and visit a job | A new application |
| Visit again when they've fixed what was missed | The last visit missed a must-meet item |
| Finish their paperwork checks | The visit met the standard, but a check isn't ticked yet |
| Ready to approve | One button on the company's page approves it |
| Another visit is due | The approval has run its months. The company stays approved until the owner pauses it |

An approved company has a certificate number, such as AV-1004, and a printable certificate at `/admin/partners/<id>/certificate`. **Download the approved list for Excel** builds the list as an `.xlsx` file, with each company's dates, score, and contact details. It holds phone numbers and the owner's visit notes, so treat it like the dashboard.

A later visit that meets the standard renews the approval and sets the tier again. Pausing a company takes it off the list and keeps its dates. Moving it back to Applied withdraws the certification.

The certification is AT Legacy Services' own. The certificate and the For companies page both say it is not a state license. Florida uses "certified contractor" for a state license class, so don't call an approved company "certified" on its own.

## Rules the code enforces

- A customer's files are served only to the customer (by their private link), the owner, and a company quoting that request, and to a company only when the file is shared. A company's link never opens another request's files.
- An upload must be a JPEG or a PDF by its own first bytes, whatever its name says. Anything else is refused.
- A partner can be sent a brief only when their status is Approved. The database calls this status `verified`, and the public site calls these companies verified.
- A partner can be approved only after the registration, insurance, and references checks are ticked, plus the license check when the trade needs one (`server/lib/catalog.js`), and after a site visit that meets every must-meet item of the standard. The owner's own crew is exempt.
- A scorecard's boxes are named after each item's wording, not its place in the list, so a scorecard opened before the standard changed can't tick the wrong item.
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
| `site/index.html`, `site/home.js` | Home page, with its site plan drawing and service pictograms |
| `site/quote.html`, `site/quote.js` | Request form and brief review |
| `site/uploads.js` | The "add" buttons for pictures and files: shrinks each picture, shows what was added, and sends it |
| `site/partners.html`, `site/partners.js` | Partner application |
| `server/index.js`, `server/app.js` | Server start-up and routing |
| `server/schema.sql`, `server/migrate.js`, `server/db.js` | Database tables and migration |
| `server/routes/public.js` | Request, brief, and application API |
| `server/routes/customer.js` | Customer's private quotes page |
| `server/routes/partner.js` | Partner's private quote page |
| `server/routes/admin.js` | Dashboard: requests, partners, site visits, the standard, fees |
| `server/lib/brief.js` | Plain and AI job briefs |
| `server/lib/catalog.js` | Services, tiers, and which license each service needs |
| `server/lib/workos.js` | WorkOS AuthKit sign-in for the dashboard |
| `server/lib/edge.js` | Checks the host's sign-in wall before the dashboard service opens |
| `server/lib/links.js` | Names for private links, and the record of when each was sent and opened |
| `server/lib/files.js` | Pictures and files: the limits, what may be stored, cleaning a picture, and who may see each file |
| `server/lib/standard.js` | The certification standard: its starting draft, how a site visit is scored, and the tier the points suggest |
| `server/lib/xlsx.js` | Writes the Excel downloads |
| `server/lib/stamp.js` | Adds a fingerprint to each page's links to the stylesheet and scripts |
| `server/lib/security.js` | Tokens, sessions, form tokens, rate limits |
| `test/flow.test.js` | End-to-end tests |

## Editing the site

- **Services:** change the list in `server/lib/catalog.js`, then match it in the `<select>` in `site/quote.html` and `site/partners.html` and the links in `site/index.html`.
- **What a service can include:** when a customer picks a service on the request form, a short list of examples appears under it. Each list is a `service-info` block in `site/quote.html`. Keep one block for every service except Something else; the tests check this.
- **Approval and tiers for companies:** `site/partners.html` says how a company gets approved and how its tier is set. It names a few things the visit looks at, in general words. The real list is the standard in the dashboard, so if the standard changes a lot, reread this page. Keep the tiers in step with what the home page tells customers about each tier.
- **What verified means:** the list on `site/index.html` tells customers what every company passes, including the site visit. The dashboard enforces each line, so change the two together.
- **Tier wording:** `site/index.html` and `site/quote.html`.
- **Home page drawing:** the site plan at the top of `site/index.html` is drawn in the page itself, 5 units to the foot. The gold fence measures 200 ft. The label on the drawing and the quote sheet beside it give the same figure, so change all three together.
- **Service pictograms:** each service link in `site/index.html` has a small drawing before it, on a 48-unit grid. To add a service, copy one and redraw it.
- **Styling drawings:** the pages' security header blocks styles written inside the HTML. Give a shape a class and style it in `site/styles.css`.
- **Changes show up at once:** every page loads `styles.css` and its scripts by fingerprint, such as `styles.css?v=1a2b3c4d5e`. The hub adds it as it serves a page, and `scripts/build-site.js` adds it to the static copy. When a file changes, its address changes, so a browser never shows a new page with an old stylesheet. Write plain `href="styles.css"` in the pages; the fingerprint is added for you.
- **Brand colors:** navy `#13283A`, bay blue `#2F5D7C`, sun gold `#F2B544`, sea glass `#A9D3CB`, shell `#F4F7F5`.

Don't describe AT Legacy Services as a contractor or as licensed. Partner companies are independent, and the customer contracts with them directly.
