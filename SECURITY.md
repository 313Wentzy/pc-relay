# Security

Long Cable can control a PC and execute commands with the Windows host's
permissions. Use it only for computers you own or are authorized to administer.
This early release has not received an independent security audit.

Report vulnerabilities using the repository's **Security → Report a vulnerability**
feature if enabled. Otherwise request a private reporting channel in an issue,
without posting exploit details, credentials, certificates or personal screenshots.

Use your own Supabase project, confirmed owner and authenticator MFA. Disable
public sign-ups. Keep HTTPS at a trusted proxy and retain the relay's loopback
binding behind a tunnel. Only approve fingerprint-matched devices locally.
Avoid elevating the Windows host unless you intentionally need elevated commands.

Keep `.env`, relay signing keys, TURN API tokens, tunnel credentials, identity,
pairing state and private diagnostics out of Git. The demo has no PC connection.
WebRTC encrypts media/data transport, but the relay handles signaling and control;
this is not a claim of protection against a compromised relay. Protect its keys.

Before publishing changes, run `npm run scan` and Gitleaks and inspect the exact
staged files. Scans reduce risk but cannot prove the absence of every possible
secret. Revoke exposed real credentials at their providers immediately.
