# Worker Deploy Safety

Invariants for the GitHub Actions deployment of the Cloudflare Worker, and
the checklist for configuring it. Enforced by
`scripts/deploy-workflow-safety.ts` (run inside the deploy workflow before
deploying, and independently by `.github/workflows/deploy-workflow-safety.yml`
on every PR and push to `main` — the CI run is the backstop the deploy
workflow cannot remove from itself).

## Invariants

1. **Pure code deploy.** `deploy-cloudflare-worker.yml` deploys Worker code
   and nothing else. It must contain zero D1 SQL execution, zero migration
   application, zero `_migrations` ledger access, zero Cloudflare REST API
   calls, and zero indirection that reaches any of those (package scripts,
   composite actions, dynamic `eval`). Database migrations are applied
   through a separate, human-driven process — never as a deploy side effect.
2. **Job-level deploy gate.** Every Cloudflare-mutating job carries
   `vars.LINE_HARNESS_CLOUDFLARE_DEPLOY == 'true'` in its job-level `if:`,
   which gates `push` and `workflow_dispatch` equally. Leave the variable
   unset to keep deploys disarmed.
3. **Fail-closed worker name.** The deploy fails before building unless the
   `WORKER_NAME` repository variable is set to a real name. No
   `your-worker-name` placeholder fallback may exist in a deploy command.
4. **CI deploy token must not have D1 Edit.** The `CLOUDFLARE_API_TOKEN`
   secret used by this workflow needs only:
   - Account → Workers Scripts → **Edit**
   - Account → Account Settings → **Read**
   - User → User Details → **Read**

   Do **not** grant Account → D1 → Edit: without it the Cloudflare API
   rejects any `wrangler d1 execute --remote`, even if a modified workflow
   tried one. (`D1_DATABASE_NAME` / `D1_DATABASE_ID` secrets are only
   patched into the built config so the deployed Worker binds the right
   database — holding them grants no SQL capability.)

Token scope alone is not the whole defense: a token with Workers Scripts
Edit can still deploy Worker *code* that writes to D1 at runtime through its
binding. The protection is layered — workflow audit + PR review + the deploy
gate + keeping migrations out of the deploy path entirely.

### Auditor limitations (why the token boundary is the backstop)

The static auditor raises the bar; it is not a complete sandbox. Known
residuals, all mitigated by the token lacking D1 Edit and by human review:

- A credential smuggled through `$GITHUB_ENV` from a prior step can reach a
  later script-file step whose own `env` names no secret.
- A GitHub *variable* (repo admin only) interpolated into a wrangler-action
  `command` argument position is not statically checkable.
- With no branch protection on the repo, a single PR could delete both the
  in-workflow audit step and the `Deploy Workflow Safety` CI workflow while
  re-introducing a D1 step. Recommended: a `main` ruleset requiring the
  `audit` check plus CODEOWNERS review on `.github/**`.

## Configuration checklist (GitHub → Settings → Secrets and variables → Actions)

Secrets: `CLOUDFLARE_API_TOKEN` (scoped as above), `CLOUDFLARE_ACCOUNT_ID`,
`D1_DATABASE_NAME`, `D1_DATABASE_ID`.

Variables: `WORKER_NAME`, `VITE_LIFF_ID`, `VITE_CALENDAR_CONNECTION_ID`
(required — the deploy fails fast without them); `VITE_BOT_BASIC_ID`,
`ADMIN_ORIGIN`, `ADMIN_ALLOW_CROSS_SITE`, `WORKER_URL` (optional);
`LINE_HARNESS_CLOUDFLARE_DEPLOY` — set to `true` **last**, once everything
above is in place and reviewed, and set it back afterwards if deploys should
not stay armed.

## WORKER_URL

The Worker requires `WORKER_URL` at runtime (cron self-calls). Two supported
ways to provide it — pick one before the first CI deploy:

- **Worker secret (preferred):** `wrangler secret put WORKER_URL`. Secrets
  survive redeploys. Verify it exists as a *secret* in the dashboard before
  deploying.
- **Baked config var:** set the `ADMIN_ORIGIN` and `WORKER_URL` repository
  variables; the deploy patches them into the shipped config's `vars` (note
  `WORKER_URL` is only injected when `ADMIN_ORIGIN` is non-empty).

Do **not** rely on a plaintext variable added manually in the dashboard: the
shipped config has no `keep_vars`, so every deploy replaces plaintext vars
with the config's own and would silently wipe it.
