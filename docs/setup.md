# Set up Long Cable

## Demo

Install Node.js 24+, clone the repository and run `npm run demo`. Open
http://127.0.0.1:4173. No dependencies or accounts are needed for the simulation.
For a static demo site, publish **only** `demo.html` (renamed `index.html`),
`demo.css` and `demo.mjs` from `apps/relay/public`. Their asset paths expect the site root.
Never publish the repo directory or `.env` as a static directory.

## Authentication and local relay

1. Create your own [Supabase project](https://supabase.com/dashboard).
2. Under Authentication → Users, create a confirmed owner user with email/password.
3. Disable public sign-ups for this single-owner instance.
4. Copy the project URL and **publishable** API key. Do not use a service-role/secret
   key. No database tables or migrations are needed.
5. At the repository root run `npm ci`, then `npm run setup`.

The wizard asks for the owner email, project URL and publishable key. It generates
two independent signing keys in `apps/relay/.env`, without printing them, and
refuses to overwrite an existing configuration. Keep this ignored file private.

Run `npm start` and open http://127.0.0.1:8790. After password sign-in, add the
displayed setup key to an authenticator and enter its six-digit code. Later
sign-ins use that same authenticator. Owner checks happen on the server.

## Windows app

The easiest path is the [prebuilt portable app](https://github.com/313Wentzy/long-cable/releases).
Extract the entire ZIP and run `Long Cable.exe`. It is unsigned; no installer,
Windows service or scheduled task runs automatically. Keep all extracted files together.
The following build tools are only needed when running the app from source.

Install stable Rust and Visual Studio Build Tools with **Desktop development with
C++** and a Windows SDK. In a terminal with `rustc` and the MSVC linker available,
run `npm run app`. It compiles the broker and launches Electron.

Click **Pair PC** in the browser. Enter `http://127.0.0.1:8790` and the short-lived
code in the app. Compare fingerprints, approve the match in the browser, and
enable access locally. Choose screens and connect.

Test from another device: local input intentionally pauses remote control. Use
the app to resume. Its tray **Quit** action stops it completely. No Windows
service or scheduled task is installed. State uses the **Long Cable** application
data directory; do not copy pairing files from the original private app.

## Public access with Cloudflare Tunnel

Create a [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) and route
a hostname on your domain, such as `pc.example.com`, to `http://127.0.0.1:8790`.
Run cloudflared on the host. Keep its tunnel credentials outside Git.
Edit `apps/relay/.env` locally:

```dotenv
PUBLIC_RELAY_ORIGIN=https://pc.example.com
RELAY_REQUIRE_HTTPS=true
RELAY_ALLOW_LOOPBACK_HTTP=true
```

Restart the relay and re-pair using the public HTTPS URL if you paired locally.
Open that URL from your other device. Keep Node, cloudflared and the Windows host
running. Startup supervision is your responsibility in this developer release.

The HTTPS proxy must overwrite `X-Forwarded-Proto`. Keep the relay listening on
loopback behind the tunnel. Do not expose the HTTP port directly to the Internet
or trust forwarded headers from arbitrary clients.

A temporary test needs no domain: run
`cloudflared tunnel --url http://127.0.0.1:8790`, use its generated HTTPS origin
as `PUBLIC_RELAY_ORIGIN`, and set both flags above. The hostname changes when
restarted and is unsuitable for permanent pairing.

## TURN

Cloudflare Tunnel does not relay WebRTC video. For harder networks, create a
TURN key under **Cloudflare → Realtime → TURN** and privately fill in these fields
in `apps/relay/.env`:

```dotenv
CLOUDFLARE_TURN_KEY_ID=
CLOUDFLARE_TURN_API_TOKEN=
```

Restart the relay. It mints temporary ICE credentials server-side. The long-lived
API token stays on the server. Enable **Compatibility relay** if direct WebRTC
fails. This can add delay and does not guarantee access on every managed network.

Another authenticated TURN provider can use `TURN_URLS`, `TURN_USERNAME`, and
`TURN_CREDENTIAL`. Include a TLS/TCP URL such as
`turns:turn.example.com:443?transport=tcp` for compatibility mode. These TURN client
credentials reach authenticated peers; use short-lived credentials and quotas.

## Docker

```sh
docker build -t long-cable .
docker run --rm --env-file apps/relay/.env -e HOST=0.0.0.0 -p 127.0.0.1:8790:8790 long-cable
```

Put a trusted HTTPS proxy/tunnel in front. Run **one relay process** per instance:
live sockets and sessions are held in memory. Restarts end sessions, but device
certificates survive if the signing key stays the same. Rotate
`REMOTE_RELAY_SECRET` to revoke every paired certificate.

## Integrate your website

Link to your relay's `/console`. Advanced signed-ticket integration requires
server-side `REMOTE_PLATFORM_SECRET` and explicitly configured
`RELAY_BROWSER_ORIGINS`. Never put a signing secret in client-side JavaScript or
a `NEXT_PUBLIC_` variable. A cross-origin opener SDK and detached monitor pages
are not supplied in this standalone release.

## Verify on your hardware

Check real owner sign-in, authenticator enrollment, fingerprint matching, local
approval, remote video on a second network and local takeover. A healthy relay
or HTTP ping does not prove video connectivity or input-to-display latency.
