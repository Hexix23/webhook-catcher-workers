# Webhook Catcher Workers

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![OPSEC](https://img.shields.io/badge/OPSEC-Friendly-red)

🎯 Modern webhook receiver and dashboard built on Cloudflare Workers + KV. Features real-time UI, export capabilities, and OPSEC-friendly on-premises deployment options. Perfect for red teams, penetration testing, and secure webhook management.

## Description

A comprehensive webhook receiver and management panel designed for receiving, visualizing, searching, exporting, and deleting webhook payloads by project (optionally by `key`) using Cloudflare Workers + KV storage. Features Basic authentication for the panel and sensitive operations, making it ideal for security testing, development workflows, and operational security scenarios.

## Features

- Webhook reception with or without `key` (keyless webhooks are tagged as `NO-KEY`)
- Modern UI with search, auto-refresh, multi-select deletion, JSON/CSV export, and detected key selector
- API pagination ready (`cursor`, `listComplete`)
- Light/dark theme support
- Responsive modern interface with no external dependencies

## Endpoints

### `POST /webhook`
- Receives flat JSON (key-value pairs, no nested objects/arrays) and stores it
- Optional: header `key: <PROJECT_KEY>`. If not sent, stored as `NO-KEY`
- Legacy compatibility: `api_key` (query) and `X-API-Key` (header)

### `GET /panel?limit=50`
- HTML panel protected with Basic Auth (`PANEL_USER`/`PANEL_PASS`)
- Loads available keys and allows choosing `NO-KEY` or a specific `key`

### `GET /api/events?limit=50&cursor=...&key=...`
- Returns `{ events, cursor, listComplete }`. No Basic Auth (designed for panel frontend)
- If `key` is omitted/empty, lists `NO-KEY`

### `GET /api/keys`
- Returns `{ keys: [...] }` with detected keys in KV (panel adds `NO-KEY`)

### `DELETE /api/events`
- Body: `{ "key": "<KEY|'' for NO-KEY>", "ids": ["<eventId>", ...] }`
- Batch deletion (internal limit 500). Protected with Basic Auth

## Setup

### 1. Install dependencies
`npm install`

### 2. Configure KV Namespaces
```bash
# Create KV namespaces
npx wrangler kv namespace create WEBHOOKS
npx wrangler kv namespace create WEBHOOKS --preview
```

Copy the generated IDs to `wrangler.toml` (replace `YOUR_KV_NAMESPACE_ID` and `YOUR_KV_PREVIEW_NAMESPACE_ID`).

### 3. Configure variables

Edit `wrangler.toml` with your values:

- `ALLOWED_API_KEYS`: comma-separated list. Empty = accept any `key` (including `NO-KEY`)
- `RETENTION_DAYS`: retention days via TTL in KV (default `30`)
- `PANEL_USER`, `PANEL_PASS`: credentials for panel and `DELETE /api/events`
- `APP_NAME`: application name displayed in panel

## Development

`npm run dev`

Local panel: `http://localhost:8787/panel` (user/password configured in `wrangler.toml`).

## Deployment

Prerequisites: `npx wrangler login` and account/zone configured in Cloudflare.

### A) Production without custom domain (workers.dev)

1. Ensure `workers_dev = true` in `wrangler.toml` (already default)
2. Deploy: `npm run deploy`
3. Output will show `*.workers.dev` URL, e.g.: `https://webhook-panel.<your-subdomain>.workers.dev/panel`

### B) Production with custom subdomain

1. In Cloudflare DNS, create record for your subdomain and mark as Proxied (orange cloud)
2. Add route in `wrangler.toml`:

   ```toml
   routes = [
     { pattern = "webhook.yourdomain.com/*", zone_name = "yourdomain.com" }
   ]
   ```

3. Deploy: `npm run deploy`
4. Access panel at `https://webhook.yourdomain.com/panel`

## OPSEC (Operational Security)

For projects requiring **high operational security** like red teams, penetration testing, or any scenario where protecting client data and avoiding exposure on public cloud services is critical, it's possible to run this panel **on-premises**.

### Local Deployment with Reverse Proxy

#### Option 1: Ngrok (Development/POC)

For quick tests or demonstrations:

```bash
# Run panel locally
npm run dev

# In another terminal, expose with ngrok
ngrok http http://localhost:8787
```

![Ngrok Example](pics/ngrok.png)

Ngrok will provide a temporary public URL that redirects to your local panel, keeping all data in your infrastructure.

#### Option 2: Caddy (Production Recommended)

For production environments, using **Caddy** or another professional reverse proxy is recommended:

```bash
# Install Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/setup.deb.sh' | sudo bash
sudo apt install caddy
```

**Basic configuration (no proxy, IP exposed):**

```bash
# Configure Caddyfile - WITHOUT tls internal to use Let's Encrypt
echo "webhook.yourdomain-internal.com {
    reverse_proxy localhost:8787
}" | sudo tee /etc/caddy/Caddyfile
```

**OPSEC configuration (with Cloudflare as proxy - RECOMMENDED):**

```bash
# Configure Caddyfile - WITH tls internal (requires Cloudflare as proxy)
echo "webhook.yourdomain-internal.com {
    reverse_proxy localhost:8787
    tls internal
}" | sudo tee /etc/caddy/Caddyfile
```

**⚠️ Important for OPSEC:**

- **`tls internal` (MORE OPSEC)**: Caddy must be **behind Cloudflare** as proxy. Advantages: real IP hidden, DDoS protection, integrated WAF, makes infrastructure fingerprinting difficult.
- **Without `tls internal` (LESS OPSEC)**: Caddy will generate **Let's Encrypt** certificates directly. Disadvantages: server IP exposed, no proxy protection, domain registered in public Certificate Transparency logs.

```bash
# Start Caddy
sudo systemctl start caddy
sudo systemctl enable caddy
```

### On-Premises Deployment Advantages

- **Total data control**: Webhooks never leave your infrastructure
- **No cloud dependencies**: Doesn't require Cloudflare accounts or external services
- **Complete audit**: Logs and full traceability in your network
- **Red Team friendly**: Perfect for projects where you can't use public services

## Usage Examples

### Send webhook with key

```bash
curl -X POST "http://localhost:8787/webhook" \
  -H "Content-Type: application/json" \
  -H "key: demo" \
  -d '{"orderId":"123","status":"paid"}'
```

### Send webhook without key

```bash
curl -X POST "http://localhost:8787/webhook" \
  -H "Content-Type: application/json" \
  -d '{"ping":"pong"}'
```

## Security

- **Change credentials**: Modify `PANEL_USER` and `PANEL_PASS` before production
- **API key allowlist**: Configure `ALLOWED_API_KEYS` to restrict valid keys
- **Basic Auth**: Panel is protected with basic authentication
- **CORS**: Configured to allow webhooks from any origin

## Management and Maintenance

### Export data

- **JSON**: "Export JSON" button in panel
- **CSV**: "Export CSV" button in panel

### Delete events

- Multi-select with checkboxes
- "Delete selected" button for batch deletion
- Limit of 500 events per operation

### Monitoring

- Configurable auto-refresh in panel. **(Be careful with free quota if running on Cloudflare)**
- Real-time search and filtering
- Visible event counter

## Cleanup and Uninstallation

### Remove Cloudflare deployment

#### Workers.dev (no custom domain)

`npx wrangler delete`

#### With custom domain

1. Comment routes in `wrangler.toml`:

   ```toml
   # routes = [
   #   { pattern = "webhook.yourdomain.com/*", zone_name = "yourdomain.com" }
   # ]
   ```

2. Redeploy: `npm run deploy`

3. Or delete completely: `npx wrangler delete`

### Delete KV Namespaces (optional)

```bash
# Replace with your real IDs from wrangler.toml
npx wrangler kv:namespace delete --namespace-id <WEBHOOKS_id>
npx wrangler kv:namespace delete --namespace-id <WEBHOOKS_preview_id>
```

### Clean DNS

- Remove DNS records from Cloudflare panel if you used custom domain

## Project Structure

```
webhook-catcher-workers/
├── src/
│   └── index.ts          # Main Worker logic
├── package.json          # Dependencies and scripts
├── wrangler.toml        # Cloudflare Workers configuration
├── wrangler.toml.sample # Configuration template
├── tsconfig.json        # TypeScript configuration
├── .gitignore          # Git ignored files
└── README.md           # This documentation
```

## Contributing

Contributions are welcome! Please:

1. Fork the project
2. Create a feature branch (`git checkout -b feature/new-feature`)
3. Commit your changes (`git commit -am 'Add new feature'`)
4. Push to branch (`git push origin feature/new-feature`)
5. Create a Pull Request

## Acknowledgments

Thanks to [0xh3l1x](https://x.com/cgomezz_23) for being the guinea pig and suggesting improvements as well as fixing some bugs.

## License

This project is under the MIT license. See `LICENSE` file for more details.

---

**📖 [Documentación en Español](README_ES.md)**
