# AT Legacy Services quote hub

Homeowners describe a job once and get quotes from verified local companies in up to three tiers: Affordable, Mid-range, and Premium. AT Legacy Services (AT Legacy Group LLC) collects the quotes and earns a finder's fee from the company the customer hires.

One Node app serves the public site, the request API, the private customer and partner pages, and the owner's dashboard. Data lives in Postgres. On Slipway the same app runs twice: once as the public site (`hub`) and once as the dashboard (`dashboard`), which sits behind Slipway's sign-in wall.

## How a request moves

1. **Customer** fills in `site/quote.html`. The server turns the answers into a job brief (`POST /api/brief`). With an Anthropic API key, Claude writes the brief and may ask up to three follow-up questions. Without one, the brief is built from the answers.
2. The customer checks the brief and sends it (`POST /api/requests`). They land on a private page, `/r/<token>`, where quotes appear.
3. **Owner** opens the request in `/admin`, picks one approved partner per tier, and gets a private quote link, `/q/<token>`, to send to each partner.
4. **Partner** opens the link, reads the brief, and enters a price. Partners see the job but not the customer's name or contact details.
5. **Customer** compares the quotes and chooses one. Only then does the chosen partner's page show the customer's contact details. The customer hires and pays the partner directly.
6. **The site** issues a numbered invoice for the finder's fee the moment the customer chooses. The fee is a percentage of the quoted price with a smallest and a largest amount (5%, $25, $750 to start), set under Fee settings. Each brief keeps the terms it was sent with.
7. **Owner** sends the invoice from `/admin/fees`. The company opens it at `/q/invoice/<token>` and pays there. With Stripe connected the invoice marks itself paid. See "Invoices and getting paid" below.

Repairs and upkeep go to the in-house "AT Legacy Services" partner record as a single quote with no fee.

## The dashboard

Dashboard pages share one frame (`ownerPage` in `server/lib/html.js`): a gold "Owner dashboard" strip, a compact bar, and the tabs. Pages for customers and companies use `page()` and never show the strip, so the owner can tell at a glance which pages are theirs.

| Tab | What it shows |
| --- | --- |
| Requests | What needs the owner, then every request with its next step. Requests that need a company come first |
| Partners | The approved vendor list, the companies working toward it, the standard, and the sign-up link to send to a new company |
| Services | A switch for each service, beside how many approved companies it has in each tier. Off takes the service off the website |
| Fees | Every invoice, in four parts: overdue, waiting to be paid, paid, and no fee. An unpaid one carries the words and link to copy, text, or email, and a record of when it was sent and opened. Fee settings holds the rule, the payment link, and what Stripe last reported. Books has a month-by-month summary and the Excel files |
| Messages | What people send from the Contact page, newest first, with a tap to call or email back |
| Links | Every fixed page of the site with its address, and who each one is for |

On a request, each private link has a Copy button plus one-tap ways to send it: text, email, the phone's share sheet, or open it to see what the other person sees. The text and email links are built only from digits and an encoded address (`textLink` and `emailLink` in `server/routes/admin.js`), so nothing typed into a form can change where they go.

### Invoices and getting paid

An invoice is issued when a customer chooses a company that owes a fee (`issueMissing` in `server/lib/invoices.js`). It gets the next number, `INV-1001` and up, and a private page of its own. A number is never used twice, and an invoice is never deleted.

| It is | When |
| --- | --- |
| Open | Issued and not paid. It is overdue from the day after its due day, and its row then carries a reminder instead of the first message |
| Paid | The owner ticked **Fee paid**, or Stripe reported the payment |
| Refunded | It was paid and the money went back: the owner ticked **No fee on this job** on a paid invoice, or refunded it in Stripe |
| No fee | The owner ticked **No fee on this job** on an unpaid invoice, or the customer's choice was undone, or the request was deleted |

Each invoice keeps its own copy of what it bills: the company, the job's reference, the service, the quoted price, and the terms. It never holds the customer's name. That is why it can stay in the books after the owner deletes a request at a customer's asking. Undoing a choice or deleting a request cancels an unpaid invoice for good. A paid one stays paid, and the owner decides whether to refund it.

The company's page, `/q/invoice/<token>`, is the invoice while the fee is owed and the receipt once it is paid. It prints on one page. How the company pays from it depends on what is set up:

- **Stripe connected:** a Pay button for the exact amount. It opens a payment page that Stripe hosts, made for that one invoice.
- **Only a payment link saved** (Fee settings): a Pay online button that opens the owner's link, where the company types the amount.
- **Neither:** the page says the payment details will follow, and the owner marks the fee paid by hand.

**Connecting Stripe.** Add one secret, `STRIPE_SECRET_KEY`, to the `hub` service in Slipway and deploy. A restricted key is enough and is what Stripe recommends. Create it in Stripe under API keys with these permissions:

| Permission | Level | What it is for |
| --- | --- | --- |
| Checkout Sessions | Write | Making the payment page and reading how it ended |
| Charges and Refunds | Read | Whether it was a card or a bank payment, and noticing a refund made in Stripe |
| Balance | Read | What Stripe kept from each payment, for the books |

The last two are optional: without them a payment is still marked paid. The key is read from the environment only. It is never written to the database, a page, or a log, and the dashboard service never uses it. Fee settings shows what the hub last reported: connected or not, test or live, what the key may do, and the last problem in plain words.

No address has to be registered with Stripe. The hub asks Stripe how each payment page ended: when the company comes back from paying, and once a minute for every invoice with a payment page out (`server/lib/payments.js`, started in `server/index.js`). A bank payment takes a few business days, so the invoice says it is on its way until the money lands. A payment for any amount other than the invoice's is never accepted as payment of it. A payment page is closed once its invoice is marked paid by hand or marked no fee, so the same invoice can't be paid twice. A card or bank number never reaches this app.

**Books.** `/admin/fees/books` lists each month with what was billed, collected, and kept by the payment service, and offers an Excel file for a month, a year, or everything. Each file has three sheets: a summary, every payment and refund, and every invoice. Money counts in the month it moved.

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

### Services: on and off

The Services tab decides which services the website offers. Each row shows the approved companies the service has, tier by tier, and how many more are working toward approval. Saving takes effect on the next page view: the home page and the request form ask the hub which services are off (`/api/services`) and take those away, and a link that asked for one says the service isn't being taken right now.

- Every service is on until it is turned off. At least one has to stay on.
- Requests already in are not touched.
- The For companies page still lists every service, so a company can apply for one that is off. That is how a service gets its three tiers before it goes live.
- The home page's top drawing uses a fence job as its example whichever services are on.

### Pages that read without JavaScript

A search engine, an AI assistant, or a browser with JavaScript off reads a page's own HTML, so the pages people judge the business by say what they mean there.

- **Our standard** carries every item in its HTML. The build asks the hub for the owner's current list (`/api/standard`, 4 seconds at most) and writes it into the page; if the hub can't be reached it writes the list this code ships with. The page's script then swaps in the current list for each visitor, so an edit in the dashboard shows at once for them and after the next deploy for everyone else.
- **For companies** and **Terms** carry the fee rule in their HTML the same way (`/api/fee`), and `fee.js` swaps in the current rule when the page opens. The owner's payment link is never part of that answer; it appears only on a bill and on the page of a company that won a job.
- **Approved companies** is live by design, so its HTML holds no list, no counts, and no empty headings. Without JavaScript it says so and points to the Contact page.
- **Price marks** are written as `$`, `$$`, `$$$`. The dimmed signs beside them are drawn by the stylesheet.

### The public approved list

`/approved` names the approved companies the owner has chosen to show, and `/approved?id=AV-1003` is one company's record page: the same lines a customer sees on its quote, plus its customer ratings. A company can link to its page from its own site, and anyone shown an approval can look the number up.

- **Off until switched on.** A company's page under Partners has "Public record page". It starts off, because it puts the company's name in front of anyone. Turn it on once the company agrees.
- **Only approved companies.** A paused company drops off the list that day and its number answers "not on the list".
- **The numbers** (approved today, working toward approval, applied and not approved, taken off the list) count every company, named or not. They appear once at least one company is approved.
- **Ratings.** Every rating counts toward a company's average, not only the ones a customer agreed to show, and the average appears from the third rating on. A customer's words show only when they agreed and the owner turned them on.

The Our standard page says when a company comes off the list. Those three rules are a public promise: change the words in `site/standard.html` if the practice changes.

### Business details: one file

`business.json` holds the phone number, the owner's name and role, the About paragraphs, the hours, the reply-time promise, and the email address. Every public page reads from it, both on the hub and in the static build. A detail left empty takes its sentence or section off the page, so nothing shows half filled.

| Field | Shows up |
| --- | --- |
| `phone` | Home page footer, Contact, the "this form needs JavaScript" notes, and the business listing data search engines read. Needs 10 digits |
| `owner`, `ownerRole`, `about` | The "Who runs it" part of the About page. `about` is a list of paragraphs |
| `hours`, `reply` | Contact page |
| `email`, `emailReady` | Contact page and the listing data. The address stays hidden until `emailReady` is `true`. Set it only once mail to that address arrives |

In a page, `<!--if:phone-->…<!--/if:phone-->` keeps its contents only when the detail is filled, `<!--if:!phone-->` only when it is empty, and `{{phone}}` prints it (`server/lib/business.js`).

### What a customer sees on a quote

- **Line by line.** A company's quote form asks for the price, what it includes, what it doesn't, the timeline, the earliest start, payment terms, the permit, and the warranty. Every quote lists them in that order.
- **Company record.** Under each quote: the approved vendor number and date, the date of the passing site visit, each paperwork check the owner ticked, and the points items the company showed at that visit. A license number shows only when the license check is ticked. Nothing in the record is the company's own claim.
- **Side by side.** With two or more quotes in, a wide screen and a printout show one table with a column per company. A phone shows the cards. "Print or save as a PDF" prints the table without buttons.
- **Keep this page.** Until a company is chosen, the page offers to copy, text, or email its own link, because the link is the only way back.
- **A rating after the job.** Once a company is chosen, the page asks for 1 to 5 stars, whether they'd hire the company again, and a comment. One rating per request. It lands in Partners, Customer ratings. A rating shows on the home page only when the customer ticked that it may and the owner turns it on, and then with a first name only.

### Pages customers can read

`/about`, `/standard`, `/contact`, `/privacy`, and `/terms`. The standard page lists the items from the dashboard's standard in the owner's wording; points and the numbers each tier needs stay private. The request form says so when a service has no approved company in a tier yet (`/api/coverage`). **The privacy and terms pages are plain-language drafts. Have an attorney read them before relying on them.** The privacy page promises deletion on request: a request's page in the dashboard has "Delete this request", which removes it with its quotes, files, link history, and rating.

The certification is AT Legacy Services' own. The certificate and the For companies page both say it is not a state license. Florida uses "certified contractor" for a state license class, so don't call an approved company "certified" on its own.

## Rules the code enforces

- A customer's files are served only to the customer (by their private link), the owner, and a company quoting that request, and to a company only when the file is shared. A company's link never opens another request's files.
- An upload must be a JPEG or a PDF by its own first bytes, whatever its name says. Anything else is refused.
- A partner can be sent a brief only when their status is Approved. The database calls this status `verified`, and the public site calls these companies verified.
- A partner can be approved only after the registration, insurance, and references checks are ticked, plus the license check when the trade needs one (`server/lib/catalog.js`), and after a site visit that meets every must-meet item of the standard. The owner's own crew is exempt.
- A scorecard's boxes are named after each item's wording, not its place in the list, so a scorecard opened before the standard changed can't tick the wrong item.
- Each quote is in the partner's name. The site never sets a price.
- An invoice is issued only for a quote the customer chose, and a quote has at most one invoice that isn't cancelled. Its amount is fixed when it is issued.
- An invoice is marked paid through Stripe only when Stripe reports a payment of exactly that amount, on the payment page this site made for that invoice.
- A cancelled invoice can't be reopened or paid from its page. A payment Stripe reported can't be unticked by hand.
- A service the owner has switched off takes no new request, even from a page that was opened before the switch.
- A rating is taken only for a request whose customer chose a company, and only once. Its words are public only when the customer agreed and the owner turned them on. Its stars always count toward the company's average.
- A company is named on the public list only while it is approved and the owner has switched its public page on. The owner's own crew is never listed.
- A contact message needs a name, a phone number or an email, and a message. Ten tries an hour from one connection.
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
| `FEE_PERCENT` | No | The starting percentage for the finder's fee, until the owner saves a rule under Fees, then Fee settings. Defaults to 5 |
| `STRIPE_SECRET_KEY` | No | A Stripe restricted key (`rk_live_...`) or secret key, set as a secret on the `hub` service only. Turns on the Pay button on invoices and marks them paid. See "Invoices and getting paid" |
| `PUBLIC_URL` | Recommended | The hub's public address, such as `https://atlegacyservices.com`. Used for the sign-in redirect, for links copied from the dashboard, and to keep sign-in cookies HTTPS-only. Defaults to the address you opened the dashboard on |
| `RESEND_API_KEY`, `NOTIFY_FROM`, `NOTIFY_TO` | No | Emails you when a request, application, message, quote, site-visit request, choice, rating, or document to check arrives. With the first two set, a customer who gave an email also gets their private link by email |
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
| `site/about.html`, `site/privacy.html`, `site/terms.html` | About page, and the privacy and terms drafts |
| `site/standard.html`, `site/standard.js` | The public standard, filled from the dashboard's standard, and the rules for coming off the list |
| `site/approved.html`, `site/approved.js` | The public approved list, each company's record page, and the numbers |
| `site/contact.html`, `site/contact.js` | Contact form. Messages land in the dashboard's Messages tab |
| `business.json`, `server/lib/business.js` | The business's own details, and the helper that fills them into each page |
| `server/index.js`, `server/app.js` | Server start-up and routing |
| `server/schema.sql`, `server/migrate.js`, `server/db.js` | Database tables and migration |
| `server/routes/public.js` | Request, brief, and application API |
| `server/routes/customer.js` | Customer's private quotes page |
| `server/routes/partner.js` | Partner's private quote page |
| `server/routes/invoice.js` | A company's invoice and receipt page, and the step that sends it to Stripe to pay |
| `server/routes/admin.js` | Dashboard: requests, partners, site visits, the standard, fees, invoices, books |
| `server/lib/fees.js` | The fee rule: the percentage with its smallest and largest amount |
| `server/lib/invoices.js` | Invoices: issuing, what open, paid, refunded and no fee mean, and the sums for the books |
| `server/lib/payments.js` | Stripe: the payment page for an invoice, and asking how it ended |
| `server/lib/brief.js` | Plain and AI job briefs |
| `server/lib/catalog.js` | Services, tiers, and which license each service needs |
| `server/lib/workos.js` | WorkOS AuthKit sign-in for the dashboard |
| `server/lib/edge.js` | Checks the host's sign-in wall before the dashboard service opens |
| `server/lib/links.js` | Names for private links, and the record of when each was sent and opened |
| `server/lib/files.js` | Pictures and files: the limits, what may be stored, cleaning a picture, and who may see each file |
| `server/lib/record.js` | The lines of a company's record, shared by quotes and the public list |
| `server/lib/services.js` | Which services are switched off, and the rule that one stays on |
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
