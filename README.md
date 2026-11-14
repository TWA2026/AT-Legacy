# AT Legacy Services

Static website for AT Legacy Services (AT Legacy Group LLC). The only JavaScript is the quote form. The build copies `site` to `dist`.

## Editing the site

- **Services and wording:** Edit `site/index.html`. Each service is a `<details>` block; its quote link passes `?service=` with the exact option text from `site/quote.html` so the form opens with that service selected.
- **Email:** Replace `hello@atlegacyservices.com` in `site/index.html` and `site/quote.html`. Each spot is marked `EDIT`, and `quote.html` also has the address in its no-JavaScript message.
- **Quote form:** Edit the dropdown options in `site/quote.html`. `site/quote.js` writes the email.

Brand colors: navy `#13283A`, bay blue `#2F5D7C`, sun gold `#F2B544`, sea glass `#A9D3CB`, shell `#F4F7F5`.

Keep the wording inside the Florida handyman exemption. Don't describe the business as a contractor or as licensed, and don't list work that needs a permit or a trade license.

## Deploy on Slipway

Slipway runs `npm run build` and publishes `dist`. Each push to `main` updates the site.

## Connect your domain

1. In Slipway, open **Domains** and select **Add domain**.
2. Add the DNS record Slipway gives you, then select **Verify**.
3. On the site's **Networking** tab, set the address to your domain.
4. Redirect `www.atlegacyservices.com` and the old `atlegacyllc.com` to `https://atlegacyservices.com` with Cloudflare Redirect Rules.

Claim and verify the domain before adding `domain:` to `slipway.yaml`. A deploy fails if that field names an unverified domain.

## Files

| Path | Purpose |
| --- | --- |
| `site/index.html` | Home page |
| `site/quote.html` | Quote request form |
| `site/quote.js` | Creates the quote email |
| `site/404.html` | Page shown for a missing URL |
| `site/styles.css` | Styles |
| `site/home.js` | House picker, service links, and the phone quote bar on the home page |
| `site/og.png` | Image shown when the site is shared in texts and social posts |
| `site/robots.txt`, `site/sitemap.xml` | Search engine files |
| `site/favicon.svg` | Browser tab icon and monogram (navy square, AT, gold waves) |
| `site/fonts/` | Alfa Slab One and Public Sans, under the SIL Open Font License |
| `package.json` | Build command |
| `slipway.yaml` | Slipway deploy settings |

## Sections waiting on real content

- **Guarantee:** `styles.css` keeps the `.guarantee` band styles. Add the section back to `site/index.html` once the guarantee length is decided.
- **Recent work:** `styles.css` keeps the `.work-grid` styles. Add the section back with real before-and-after photos.
- **Reviews and phone number:** not on the site yet.
