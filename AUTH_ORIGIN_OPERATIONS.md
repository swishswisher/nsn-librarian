# Human mutation origins

Human API mutations and logout require an allowlisted signed human session and
a single serialized Origin header from the server's explicit origin allowlist.
Host, Forwarded, X-Forwarded-Host, X-Forwarded-Proto and the request URL never
add trusted origins. Sec-Fetch-Site is an additional denial check, not authority.

Set `NSN_LIBRARIAN_APP_URL` to this deployment's exact application origin. The
existing `NEXT_PUBLIC_APP_URL` is used only when that server setting is absent.
For explicitly authorized preview deployments, set `NSN_AUTH_TRUSTED_ORIGINS`
to additional comma-separated exact HTTPS origins. No wildcard, domain suffix,
automatic Vercel preview discovery, path, credential, query or fragment grants
trust. A malformed configured entry makes human mutations fail closed.

Example synthetic settings:

```text
NSN_LIBRARIAN_APP_URL=https://nsn-librarian.example
NSN_AUTH_TRUSTED_ORIGINS=https://authorized-preview.example
```

HTTP is allowed only for explicitly configured loopback origins, including the
exact port. Without any origin configuration, development defaults to
`http://localhost:3000` and `http://127.0.0.1:3000`; production has no fallback.
Set the app URL for other local ports. Existing `.env` files are not rewritten.

Signed Bridge-device routes, the protected Memory scheduler and Google's
state/PKCE-checked authentication callback keep their distinct authorization.
An approved origin does not replace human session, device signature, root or
operation authority. Explicitly trusting a preview includes trusting its code;
remove retired previews from the allowlist.

Before deployment, verify the actual configured primary/preview origins and
browser behavior at the ingress, alongside scheduler protection and device
authentication. Local production-server tests do not constitute staging
acceptance or permission to activate scheduling.
