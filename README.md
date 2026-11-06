# AT Legacy Group

Static website for AT Legacy Group LLC. The only JavaScript is the quote form. The build copies `site` to `dist`.

## Editing the site

- **Services and wording:** Edit `site/index.html`.
- **Email:** Replace `hello@atlegacyllc.com` in `site/index.html` and `site/quote.html`. Each spot is marked `EDIT`, and `quote.html` also has the address in its no-JavaScript message.
- **Quote form:** Edit the dropdown options in `site/quote.html`. `site/quote.js` writes the email.

Keep the wording inside the Florida handyman exemption. Don't describe the business as a contractor or as licensed, and don't list work that needs a permit or a trade license.

## Deploy on Slipway

Slipway runs `npm run build` and publishes `dist`. Each push to `main` updates the site.

## Connect your domain

1. In Slipway, open **Domains** and select **Add domain**.
2. Add the DNS record Slipway gives you, then select **Verify**.
3. On the site's **Networking** tab, set the address to your domain.
4. Add the `www` host under **Also served at**.

Claim and verify the domain before adding `domain:` to `slipway.yaml`. A deploy fails if that field names an unverified domain.

## Files

| Path | Purpose |
| --- | --- |
| `site/index.html` | Home page |
| `site/quote.html` | Quote request form |
| `site/quote.js` | Creates the quote email |
| `site/404.html` | Page shown for a missing URL |
| `site/styles.css` | Styles |
| `site/rings.svg` | Tree-ring artwork |
| `site/favicon.svg` | Browser tab icon |
| `site/fonts/` | Gloock and Hanken Grotesk, under the SIL Open Font License |
| `package.json` | Build command |
| `slipway.yaml` | Slipway deploy settings |
