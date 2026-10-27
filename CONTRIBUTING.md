# Contributing

Use Node.js 24+. Run `npm ci`, `npm run check`, `npm test`, and `npm run scan`.
On Windows, compile the broker with
`npm run build:native --workspace=apps/desktop-agent` before testing native behavior.

Report your OS/browser, reproduction steps, and expected behavior. Remove tokens,
pairing codes, certificates, personal screen content and private paths from reports.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Small PRs are welcome. Preserve server-side owner/MFA checks, fingerprint approval,
local input fences, origin checks and OS-encrypted identity storage. Contributions
are MIT licensed. Never weaken authentication to make a demo work.
