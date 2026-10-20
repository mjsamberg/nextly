# Running sync through Cloudflare

The server runs at home in Docker. `cloudflared` opens an outbound tunnel to
Cloudflare, so no ports are opened and local firewalls don't get in the way.
Cloudflare Access sits in front of it. The apps prove who they are with a
service token, sent as two request headers.

You need a domain on Cloudflare (the free plan is fine) and a free Zero Trust
team (one.dash.cloudflare.com).

## 1. Create the tunnel

1. Zero Trust → **Networks → Tunnels → Create a tunnel** → **Cloudflared**. Name it `nextly`.
2. Under **Install and run a connector**, choose **Docker** and copy the long
   token after `--token`. Put it in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. **Public hostname**: add `nextly.example.com` (your domain) with service
   **HTTP** and URL `nextly:8080`. That's the Compose service name, which
   cloudflared can reach on the Compose network.
4. On the host: `docker compose up -d --build`. The tunnel shows **Healthy**.

## 2. Protect it with Access

1. Zero Trust → **Access → Service auth → Service tokens → Create service token**.
   Name it `nextly-apps`. Copy the **Client ID** and **Client Secret** now; the
   secret is only shown once.
2. **Access → Applications → Add an application → Self-hosted**.
   - Domain: `nextly.example.com`
   - Policy 1: action **Service Auth**, include **Service Token** `nextly-apps`.
     This is what the apps use.
   - Policy 2 (for the browser): action **Allow**, include **Emails** with your
     address. This lets you sign in from a browser to use the Gmail bookmarklet
     and open attachments.

## 3. Set up each app

Settings → Sync:

| Field | Value |
| --- | --- |
| Server address | `https://nextly.example.com` |
| Sync token | `NEXTLY_TOKEN` from `.env` |
| Request headers | **Add Cloudflare Access headers**, then paste the Client ID and Client Secret |

**Save and sync** should show "Up to date". If it says Cloudflare Access
blocked the request, check the two header values and that the Service Auth
policy includes the token.

## Browser pieces

- **Gmail bookmarklet**: set `NEXTLY_HOST` in `capture/gmail-bookmarklet.js` to
  `https://nextly.example.com`. The first time, the capture window asks you to
  sign in with Cloudflare Access (policy 2). After that it works as before.
- **Opening attachments** in the system browser goes through the same sign-in.
  The file links are already signed by the server and expire after 10 minutes,
  so you can skip the sign-in for them by adding a second Access application for
  `nextly.example.com/files` with a **Bypass** policy (include **Everyone**).

## Keep in mind

- The sync token still protects the server, so Access is a second lock, not the only one.
- Cloudflare's free plan limits uploads to 100 MB per request; Nextly's limit is 50 MB.
- Rotate the service token in Zero Trust if a device is lost, then update the
  headers on the other devices.
