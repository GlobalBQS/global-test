# GlobalBQS test environment

Served at **https://test.globalbqs.com** (GitHub Pages). Demo project only – never production.

- `index.html` – landing page for every auth link the demo sends; forwards invite/recovery tokens to `set-password`; sign-in check (demo).
- `set-password.html` – set a password from an invitation or reset link (edge function `portal-set-password` on the demo).
- `config.js` – demo URL and publishable key (public by design). No secrets in this repo.

Rule: all tests on the demo use this address for links, and test accounts use `test+name@globalbqs.com`.
