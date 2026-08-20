#!/usr/bin/env tsx
/**
 * Deploy workflow safety static analysis.
 *
 * Enforces the "pure code deploy" invariant for GitHub Actions workflows:
 * a deployment workflow may deploy Worker code, but must never be able to
 * mutate the production D1 database, and every Cloudflare-mutating job must
 * sit behind the LINE_HARNESS_CLOUDFLARE_DEPLOY repository-variable gate.
 *
 * Forbidden anywhere a workflow can execute code (run blocks after
 * backslash-continuation normalization, wrangler-action `command` inputs,
 * env values, resolved package.json scripts, local composite actions):
 *
 *   - wrangler d1 ... (execute / migrations / anything)
 *   - d1 execute / d1 migrations
 *   - --file= (SQL file execution)
 *   - packages/db/migrations references
 *   - _migrations ledger references
 *   - db:migrate script references
 *   - api.cloudflare.com direct REST calls
 *   - dynamic execution (eval, bash/sh -c, node -e) — unauditable, fail closed
 *
 * Additional invariants:
 *
 *   - any job with a mutating wrangler command (deploy without --dry-run,
 *     pages deploy, versions upload/deploy, secret put, kv/r2 writes) must
 *     carry `vars.LINE_HARNESS_CLOUDFLARE_DEPLOY == 'true'` in its job-level
 *     `if:` (job-level so workflow_dispatch is gated too)
 *   - Worker deploy commands must not fall back to a placeholder name
 *     (`your-worker-name` / `|| '...'` name fallbacks are rejected)
 *   - mutating workflows may only use allowlisted actions
 *   - external reusable workflows and non-composite local actions are
 *     rejected (cannot be audited → fail closed)
 *   - YAML that fails to parse is a violation (fail closed), never a skip
 *
 * Library API:
 *   auditWorkflowFile(file, options) → Violation[]
 *   auditWorkflowText(text, name, options) → Violation[]
 *
 * CLI:
 *   tsx scripts/deploy-workflow-safety.ts [repo-root]
 *
 * Audits every *.yml / *.yaml under .github/workflows. Prints
 * "[FAIL] <file>: <rule>: <detail>" per violation and exits 1, or
 * "OK — N workflow files pass deploy safety audit." on success.
 * The deploy workflow runs this before deploying; the Deploy Workflow
 * Safety CI workflow runs the vitest suite as an independent backstop.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'yaml';

export interface Violation {
  file: string;
  location: string;
  rule: string;
  detail: string;
}

export interface PackageInfo {
  name: string;
  dir: string;
  scripts: Record<string, string>;
}

export interface AuditOptions {
  repoRoot: string;
  /** Override workspace package discovery (used by tests). */
  packages?: PackageInfo[];
  /** Internal: reusable workflows already entered, to break `uses:` cycles. */
  _visitedWorkflows?: Set<string>;
}

export const GATE_EXPRESSION = "vars.LINE_HARNESS_CLOUDFLARE_DEPLOY == 'true'";

const MAX_RESOLVE_DEPTH = 6;

const DB_MUTATION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bwrangler\s+d1\b/i, 'wrangler d1 subcommand'],
  [/\bd1\s+execute\b/i, 'd1 execute'],
  [/\bd1\s+migrations\b/i, 'd1 migrations'],
  [/--file=/i, '--file= flag (SQL file execution)'],
  [/\bdb:migrate\b/i, 'db:migrate script reference'],
  [/api\.cloudflare\.com/i, 'direct Cloudflare REST API call'],
];

// Only a violation inside a Cloudflare-mutating (deploy) workflow: release
// tooling legitimately packages/lists migration files read-only, but a
// deployment workflow must have zero migration dependency of any kind.
const DEPLOY_SCOPED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/packages\/db\/migrations/i, 'migration directory reference'],
  [/\b_migrations\b/i, '_migrations ledger reference'],
];

// `node -e` is deliberately NOT flagged: release.yml uses it legitimately for
// inline JSON parsing, and its literal payload sits in the same command
// segment so the DB-mutation patterns above still scan it. Only constructs
// that execute text assembled at runtime (eval, shell -c, pipe-to-shell,
// sourcing) are rejected.
const DYNAMIC_EXEC_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|[\s;("'`])eval(?:$|[\s;)"'`])/, 'eval'],
  [/\b(?:bash|sh|zsh)\s+(?:-\S+\s+)*-c\b/, 'shell -c dynamic command'],
  [/\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/, 'pipe to shell'],
  // `source <path>` / `. <path>` where the arg is file-like (has a slash or a
  // shell extension) — avoids matching jq/JS constructs such as `else . end`.
  [/(?:^|[\s;&])(?:source|\.)\s+(?:[\w.~$/-]*\/[\w.~$/-]*|[\w.~$-]+\.(?:sh|bash|zsh|env))/, 'sourcing a script'],
];

// Interpreters that run an arbitrary script FILE. Inside a Cloudflare-mutating
// job such a file cannot be audited (its contents live outside the workflow),
// so — except for the pinned deploy-safety audit itself — running one is a
// fail-closed violation. Inline `-e`/`-p`/`--eval` payloads are handled by the
// pattern scan over the same segment and are not treated as file execution.
const SCRIPT_INTERPRETER =
  /\b(node|deno|bun|tsx|ts-node|bash|sh|zsh|python3?|ruby|perl|php)\s+(?:-(?!e\b|-eval\b|p\b)\S+\s+)*([^\s]*(?:\/[^\s]*|\.(?:ts|js|mjs|cjs|sh|py|rb|pl|php)))/;

/** Script-file executions that are allowed inside a mutating job. */
const AUDIT_EXEC_ALLOWLIST: readonly RegExp[] = [
  /scripts\/deploy-workflow-safety\.ts\b/,
];

/** Actions a Cloudflare-mutating workflow is allowed to use. */
const MUTATING_WORKFLOW_ACTION_ALLOWLIST = [
  'actions/checkout@',
  'actions/setup-node@',
  'pnpm/action-setup@',
  'cloudflare/wrangler-action@',
];

/** pnpm/npm subcommands that are not workspace script invocations. */
const PACKAGE_MANAGER_BUILTINS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up',
  'upgrade', 'prune', 'store', 'fetch', 'rebuild', 'link', 'unlink', 'import',
  'audit', 'licenses', 'outdated', 'list', 'ls', 'why', 'patch',
  'patch-commit', 'pack', 'publish', 'root', 'bin', 'setup', 'config',
  'exec', 'dlx', 'create', 'init', 'approve-builds', 'version', 'view',
  'info',
]);

interface WranglerMutation {
  kind: string;
  /** The normalized command segment the mutation was found in. */
  segment: string;
  /** True for `wrangler pages deploy` (Pages, not the Worker). */
  pages: boolean;
}

interface ScanContext {
  file: string;
  options: AuditOptions;
  violations: Violation[];
  mutations: WranglerMutation[];
  /** Deploy-scoped pattern hits, promoted to violations iff the workflow mutates Cloudflare. */
  deployScopedHits: Violation[];
  /** Script-file execs in a Cloudflare-credentialed step, promoted iff that job mutates Cloudflare. */
  jobExecCandidates: Violation[];
  /** True while scanning a step (and its resolved scripts) that holds Cloudflare credentials. */
  currentStepHasCfCreds: boolean;
  externalActions: Array<{ location: string; uses: string }>;
  visitedScripts: Set<string>;
  visitedFiles: Set<string>;
}

/**
 * Does this env/with block put deploy-sensitive credentials in scope? Matches
 * Cloudflare-ish names AND any value that references a repository secret, so a
 * renamed secret (`TOKEN: ${{ secrets.DEPLOY_KEY }}`) is still detected. (A
 * token smuggled through $GITHUB_ENV from a prior step is a documented
 * residual — the deploy token's lack of D1 Edit is the backstop there.)
 */
function hasCloudflareCredentials(env: unknown): boolean {
  if (!env || typeof env !== 'object') return false;
  for (const [name, raw] of Object.entries(env as Record<string, unknown>)) {
    if (/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CF_API_TOKEN|WRANGLER/i.test(name)) return true;
    if (/secrets\./i.test(String(raw ?? ''))) return true;
  }
  return false;
}

/**
 * Normalize a command segment before pattern matching so trivial shell
 * quoting cannot hide a banned construct: strip quotes/backticks (so
 * `wrangler "d1"` and `d''1` read as `wrangler d1`/`d1`), collapse `${IFS}`
 * word-splitting tricks to spaces, and drop in-word backslash escapes
 * (`d\1` → `d1`). Used only for matching, never for execution.
 */
export function normalizeSegment(segment: string): string {
  return segment
    // `${IFS}`, `${IFS%??}`, `${IFS:0:1}`, bare `$IFS` — all expand to a
    // separator at runtime; collapse them so word-splitting cannot hide a
    // banned token (`wrangler${IFS%??}d1`).
    .replace(/\$\{IFS[^}]*\}/g, ' ')
    .replace(/\$IFS\b/g, ' ')
    .replace(/['"`]/g, '')
    .replace(/\\(?=\S)/g, '');
}

/**
 * Join backslash-newline continuations and split into command segments.
 * Deliberately does NOT split on `|`/`||`: GitHub expressions like
 * `${{ vars.WORKER_NAME || 'fallback' }}` would be torn apart and hide the
 * fallback from the placeholder checks. Pattern scans work fine on whole
 * lines either way.
 */
export function commandSegments(run: string): string[] {
  const joined = run.replace(/\\\s*\r?\n/g, ' ');
  return joined
    .split(/\r?\n|&&|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function discoverPackages(repoRoot: string): PackageInfo[] {
  const packages: PackageInfo[] = [];
  const addPackage = (dir: string) => {
    const manifestPath = path.join(repoRoot, dir, 'package.json');
    if (!existsSync(manifestPath)) return;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      packages.push({
        name: typeof manifest.name === 'string' ? manifest.name : dir,
        dir,
        scripts: manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {},
      });
    } catch {
      // Unreadable manifest — leave it out; script resolution against it
      // will then fail closed as an unresolvable script.
    }
  };
  addPackage('.');
  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) addPackage(path.join(group, entry.name));
    }
  }
  return packages;
}

function getPackages(ctx: ScanContext): PackageInfo[] {
  if (!ctx.options.packages) {
    ctx.options.packages = discoverPackages(ctx.options.repoRoot);
  }
  return ctx.options.packages;
}

function addViolation(ctx: ScanContext, location: string, rule: string, detail: string): void {
  ctx.violations.push({ file: ctx.file, location, rule, detail });
}

function scanSegmentPatterns(ctx: ScanContext, location: string, rawSegment: string): void {
  const segment = normalizeSegment(rawSegment);
  for (const [pattern, label] of DB_MUTATION_PATTERNS) {
    if (pattern.test(segment)) {
      addViolation(ctx, location, 'db-mutation', `${label} in: ${rawSegment}`);
    }
  }
  for (const [pattern, label] of DEPLOY_SCOPED_PATTERNS) {
    if (pattern.test(segment)) {
      ctx.deployScopedHits.push({
        file: ctx.file,
        location,
        rule: 'db-mutation',
        detail: `${label} in a deploy workflow: ${rawSegment}`,
      });
    }
  }
  for (const [pattern, label] of DYNAMIC_EXEC_PATTERNS) {
    if (pattern.test(segment)) {
      addViolation(ctx, location, 'dynamic-exec', `${label} in: ${rawSegment}`);
    }
  }
  const interp = SCRIPT_INTERPRETER.exec(segment);
  if (interp && ctx.currentStepHasCfCreds && !AUDIT_EXEC_ALLOWLIST.some((re) => re.test(segment))) {
    ctx.jobExecCandidates.push({
      file: ctx.file,
      location,
      rule: 'unauditable-exec',
      detail: `a step holding Cloudflare credentials runs an unauditable script file (${interp[1]} ${interp[2]}) — failing closed: ${rawSegment}`,
    });
  }
}

function detectWranglerMutations(ctx: ScanContext, rawSegment: string): void {
  const segment = normalizeSegment(rawSegment);
  const pages = /\bwrangler\s+pages\s+deploy\b/i.test(segment);
  if (pages) {
    ctx.mutations.push({ kind: 'wrangler pages deploy', segment, pages: true });
  }
  if (/\bwrangler\s+deploy\b/i.test(segment) && !/--dry-run\b/.test(segment)) {
    ctx.mutations.push({ kind: 'wrangler deploy', segment, pages: false });
  }
  if (/\bwrangler\s+versions\s+(?:upload|deploy)\b/i.test(segment)) {
    ctx.mutations.push({ kind: 'wrangler versions upload/deploy', segment, pages: false });
  }
  if (/\bwrangler\s+secret\s+(?:put|delete|bulk)\b/i.test(segment)) {
    ctx.mutations.push({ kind: 'wrangler secret write', segment, pages: false });
  }
  if (/\bwrangler\s+(?:kv|r2)\b/i.test(segment) && !/\b(?:list|get|info)\b/i.test(segment)) {
    ctx.mutations.push({ kind: 'wrangler kv/r2 write', segment, pages: false });
  }
}

/** Strip leading VAR=value assignments from a command segment. */
function stripEnvAssignments(tokens: string[]): string[] {
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start++;
  return tokens.slice(start);
}

function resolveScriptText(
  ctx: ScanContext,
  location: string,
  pkg: PackageInfo,
  script: string,
  depth: number,
): void {
  const key = `${pkg.name} ${script}`;
  if (ctx.visitedScripts.has(key)) return;
  ctx.visitedScripts.add(key);
  const text = pkg.scripts[script];
  // A script the package does not define simply does not run — nothing to
  // audit. (An unresolvable *package* is the fail-closed case, handled by the
  // caller.)
  if (text === undefined) return;
  scanExecutableText(ctx, `${location} → ${pkg.name}#${script}`, text, depth + 1);
}

function resolvePackageManagerInvocation(
  ctx: ScanContext,
  location: string,
  segment: string,
  depth: number,
): void {
  let tokens = stripEnvAssignments(normalizeSegment(segment).split(/\s+/).filter(Boolean));
  // Strip a leading `npx`/`corepack` shim (with its own no-value flags) so
  // `npx pnpm …` / `corepack pnpm …` resolve like `pnpm …`.
  while (tokens[0] === 'npx' || tokens[0] === 'corepack') {
    let j = 1;
    while (j < tokens.length && tokens[j].startsWith('-')) {
      if (tokens[j] === '-p' || tokens[j] === '--package') j += 2;
      else j += 1;
    }
    tokens = tokens.slice(j);
  }
  if (tokens.length === 0) return;
  const tool = tokens[0];
  if (tool !== 'pnpm' && tool !== 'npm' && tool !== 'yarn') return;

  const packages = getPackages(ctx);
  const filters: string[] = [];
  const dirSelectors: string[] = [];
  let recursive = false;
  let i = 1;
  let sawRunKeyword = false;
  let script: string | undefined;

  // `yarn workspace <pkg> <script>` selects one package; `yarn workspaces
  // foreach … run <script>` runs it across every package (like `-r`).
  if (tool === 'yarn' && tokens[1] === 'workspace') {
    filters.push(tokens[2] ?? '');
    i = 3;
    sawRunKeyword = true;
  } else if (tool === 'yarn' && tokens[1] === 'workspaces' && tokens[2] === 'foreach') {
    recursive = true;
    i = 3;
  }

  const selectorFlag = (name: string) => name === '--dir' || name === '-C' || name === '--prefix';

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '--filter' || token === '-F') {
      filters.push(tokens[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (token.startsWith('--filter=') || token.startsWith('-F=')) {
      filters.push(token.slice(token.indexOf('=') + 1));
      i += 1;
      continue;
    }
    if (selectorFlag(token)) {
      // Working-directory selector (space form) — pnpm runs the script there.
      dirSelectors.push(tokens[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (token.startsWith('--dir=') || token.startsWith('--prefix=') || token.startsWith('-C=')) {
      dirSelectors.push(token.slice(token.indexOf('=') + 1));
      i += 1;
      continue;
    }
    if (token.startsWith('-C') && token.length > 2) {
      // Attached form `-Capps/worker`.
      dirSelectors.push(token.slice(2));
      i += 1;
      continue;
    }
    if (token === '-w' || token === '--workspace') {
      // npm workspace selector — value is a package name or a path.
      filters.push(tokens[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (token.startsWith('-w=') || token.startsWith('--workspace=')) {
      filters.push(token.slice(token.indexOf('=') + 1));
      i += 1;
      continue;
    }
    if (token === '-r' || token === '--recursive') {
      recursive = true;
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      i += 1;
      continue;
    }
    if ((token === 'run' || token === 'run-script') && !sawRunKeyword) {
      sawRunKeyword = true;
      i += 1;
      continue;
    }
    script = token;
    break;
  }

  if (script === undefined) return;
  if (script === 'exec' || script === 'dlx') {
    // The remainder is plain command text (e.g. `pnpm --filter worker exec
    // wrangler ...`) and is already covered by the pattern/interpreter scan
    // over this same segment.
    return;
  }
  // Package-manager builtins (`pack`, `publish`, …) are not workspace
  // scripts, even with a `--filter`/`--dir` selector, unless an explicit
  // `run` keyword forces script interpretation.
  if (!sawRunKeyword && PACKAGE_MANAGER_BUILTINS.has(script)) {
    return;
  }

  // A missing SCRIPT in a resolved package is safe — pnpm/npm simply run
  // nothing. A missing PACKAGE (an unresolvable `--filter`/`--dir`) is the
  // fail-closed case: we cannot see what a matched package would have run.
  const selectors: Array<{ kind: 'filter' | 'dir'; value: string }> = [
    ...filters.map((value) => ({ kind: 'filter' as const, value })),
    ...dirSelectors.map((value) => ({ kind: 'dir' as const, value })),
  ];

  if (selectors.length > 0) {
    for (const sel of selectors) {
      // A selector value can be a package name, a bare dir name, or a path
      // (`apps/worker`, `./apps/worker`) — try all so npm `-w <path>` and
      // `--filter=./apps/worker` resolve the same package.
      const norm = (v: string) => path.normalize(v.replace(/^\.\//, ''));
      const target = packages.find(
        (p) =>
          p.name === sel.value ||
          path.basename(p.dir) === sel.value ||
          norm(p.dir) === norm(sel.value),
      );
      if (!target) {
        addViolation(
          ctx,
          location,
          'unresolvable-script',
          `${sel.kind} "${sel.value}" matches no workspace package — cannot audit "${script}", failing closed`,
        );
        continue;
      }
      resolveScriptText(ctx, location, target, script, depth);
    }
    return;
  }
  if (recursive) {
    for (const pkg of packages) resolveScriptText(ctx, location, pkg, script, depth);
    return;
  }
  const root = packages.find((p) => p.dir === '.');
  if (!root) {
    addViolation(ctx, location, 'unresolvable-script', 'workspace root package.json not found');
    return;
  }
  resolveScriptText(ctx, location, root, script, depth);
}

function scanExecutableText(ctx: ScanContext, location: string, text: string, depth: number): void {
  if (depth > MAX_RESOLVE_DEPTH) {
    addViolation(ctx, location, 'resolution-depth', 'script indirection too deep — failing closed');
    return;
  }
  for (const segment of commandSegments(text)) {
    scanSegmentPatterns(ctx, location, segment);
    detectWranglerMutations(ctx, segment);
    resolvePackageManagerInvocation(ctx, location, segment, depth);
  }
}

function scanEnvValues(ctx: ScanContext, location: string, env: unknown): void {
  if (!env || typeof env !== 'object') return;
  for (const [name, raw] of Object.entries(env as Record<string, unknown>)) {
    const value = String(raw ?? '');
    for (const [pattern, label] of DB_MUTATION_PATTERNS) {
      if (pattern.test(value)) {
        addViolation(ctx, `${location} env.${name}`, 'db-mutation', `${label} in env value`);
      }
    }
    for (const [pattern, label] of DEPLOY_SCOPED_PATTERNS) {
      if (pattern.test(value)) {
        ctx.deployScopedHits.push({
          file: ctx.file,
          location: `${location} env.${name}`,
          rule: 'db-mutation',
          detail: `${label} in env value of a deploy workflow`,
        });
      }
    }
  }
}

function auditLocalAction(ctx: ScanContext, location: string, usesPath: string, depth: number): void {
  const actionDir = path.join(ctx.options.repoRoot, usesPath);
  const actionFile = ['action.yml', 'action.yaml']
    .map((f) => path.join(actionDir, f))
    .find((f) => existsSync(f));
  if (!actionFile) {
    addViolation(ctx, location, 'unresolvable-action', `local action "${usesPath}" has no action.yml — failing closed`);
    return;
  }
  if (ctx.visitedFiles.has(actionFile)) return;
  ctx.visitedFiles.add(actionFile);

  let action: any;
  try {
    action = parse(readFileSync(actionFile, 'utf8'));
  } catch (error) {
    addViolation(ctx, location, 'parse-failure', `local action "${usesPath}" is unparseable: ${String(error)}`);
    return;
  }
  const using = action?.runs?.using;
  if (using !== 'composite') {
    addViolation(
      ctx,
      location,
      'unauditable-action',
      `local action "${usesPath}" uses "${using}" — only composite actions can be audited, failing closed`,
    );
    return;
  }
  const steps = Array.isArray(action?.runs?.steps) ? action.runs.steps : [];
  steps.forEach((step: any, index: number) => {
    const stepLocation = `${location} → ${usesPath} step[${index}]`;
    scanEnvValues(ctx, stepLocation, step?.env);
    if (typeof step?.run === 'string') {
      scanExecutableText(ctx, stepLocation, step.run, depth + 1);
    }
    if (typeof step?.uses === 'string') {
      if (step.uses.startsWith('./')) {
        auditLocalAction(ctx, stepLocation, step.uses, depth + 1);
      } else {
        ctx.externalActions.push({ location: stepLocation, uses: step.uses });
      }
    }
  });
}

function auditStep(ctx: ScanContext, jobId: string, step: any, index: number): void {
  const location = `job "${jobId}" step[${index}]${step?.name ? ` (${step.name})` : ''}`;
  scanEnvValues(ctx, location, step?.env);
  const previousCredState = ctx.currentStepHasCfCreds;
  const withInputs = step?.with && typeof step.with === 'object' ? step.with : {};
  // A wrangler-action supplies its token via `with.apiToken`, not `env`.
  ctx.currentStepHasCfCreds =
    ctx.currentStepHasCfCreds ||
    hasCloudflareCredentials(step?.env) ||
    hasCloudflareCredentials(withInputs);

  if (typeof step?.run === 'string') {
    scanExecutableText(ctx, location, step.run, 0);
  }
  const uses = typeof step?.uses === 'string' ? step.uses : undefined;
  if (uses && uses.startsWith('./')) {
    auditLocalAction(ctx, location, uses, 0);
  } else if (uses) {
    ctx.externalActions.push({ location, uses });

    // Scan every string input to any action: preCommands/postCommands run in a
    // shell, and github-script's `script` is JS that can hit the D1 REST API.
    for (const [key, value] of Object.entries(withInputs as Record<string, unknown>)) {
      if (key === 'command') continue; // handled explicitly below
      if (typeof value === 'string') {
        scanExecutableText(ctx, `${location} with.${key}`, value, 0);
      }
    }

    if (uses.startsWith('cloudflare/wrangler-action')) {
      const rawCommand = (withInputs as any).command;
      if (rawCommand === undefined) {
        // The action's default command is `deploy`, so an omitted command is
        // still a mutating deploy.
        scanExecutableText(ctx, `${location} wrangler-action command`, 'wrangler deploy', 0);
      } else if (typeof rawCommand !== 'string') {
        // A sequence/other type would join into a command we can't reason about.
        addViolation(ctx, `${location} wrangler-action command`, 'unauditable-command', `wrangler-action command is not a plain string — failing closed`);
        ctx.mutations.push({ kind: 'wrangler (unauditable command)', segment: JSON.stringify(rawCommand), pages: false });
      } else {
        // An expression in the SUBCOMMAND position could resolve to any wrangler
        // subcommand (e.g. `command: ${{ vars.WRANGLER_COMMAND }}`) and escapes
        // static analysis. An expression in an argument position (e.g. the
        // `--name ${{ vars.WORKER_NAME }}` value) is fine — it is passed as a
        // single arg and WORKER_NAME is checked at deploy time.
        const firstToken = rawCommand.trimStart().split(/\s+/)[0] ?? '';
        if (firstToken.includes('${{')) {
          addViolation(ctx, `${location} wrangler-action command`, 'unauditable-command', `wrangler-action subcommand is a GitHub expression that could resolve to anything at runtime: ${rawCommand}`);
        }
        scanExecutableText(ctx, `${location} wrangler-action command`, `wrangler ${rawCommand}`, 0);
      }
    }
  }
  ctx.currentStepHasCfCreds = previousCredState;
}

export function auditWorkflowText(text: string, name: string, options: AuditOptions): Violation[] {
  const ctx: ScanContext = {
    file: name,
    options,
    violations: [],
    mutations: [],
    deployScopedHits: [],
    jobExecCandidates: [],
    currentStepHasCfCreds: false,
    externalActions: [],
    visitedScripts: new Set(),
    visitedFiles: new Set(),
  };

  let doc: any;
  try {
    doc = parse(text);
  } catch (error) {
    addViolation(ctx, '(document)', 'parse-failure', `YAML parse failed — failing closed: ${String(error)}`);
    return ctx.violations;
  }
  if (!doc || typeof doc !== 'object') {
    addViolation(ctx, '(document)', 'parse-failure', 'not a YAML mapping — failing closed');
    return ctx.violations;
  }
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== 'object') {
    addViolation(ctx, '(document)', 'parse-failure', 'workflow has no jobs mapping — failing closed');
    return ctx.violations;
  }

  scanEnvValues(ctx, 'workflow', doc.env);

  for (const [jobId, jobRaw] of Object.entries(jobs as Record<string, unknown>)) {
    const job: any = jobRaw;
    const mutationsBefore = ctx.mutations.length;
    // Per-job memo: a script or composite action reused across jobs must be
    // re-evaluated in each job so a mutation in a later, ungated job is not
    // silently dropped as "already visited".
    ctx.visitedScripts = new Set();
    ctx.visitedFiles = new Set();
    ctx.jobExecCandidates = [];
    ctx.currentStepHasCfCreds = hasCloudflareCredentials(job?.env);
    scanEnvValues(ctx, `job "${jobId}"`, job?.env);

    if (typeof job?.uses === 'string') {
      if (job.uses.startsWith('./')) {
        const reusablePath = path.join(options.repoRoot, job.uses.split('@')[0]);
        // Cross-invocation cycle guard: nested audits get a fresh ctx, so the
        // visited set must live on options to break `uses:` cycles.
        const visitedWorkflows = (options._visitedWorkflows ??= new Set<string>());
        if (visitedWorkflows.has(reusablePath)) continue;
        visitedWorkflows.add(reusablePath);
        if (!existsSync(reusablePath)) {
          addViolation(ctx, `job "${jobId}"`, 'unresolvable-action', `local reusable workflow "${job.uses}" not found — failing closed`);
        } else {
          const nested = auditWorkflowText(
            readFileSync(reusablePath, 'utf8'),
            `${name} → ${job.uses}`,
            options,
          );
          ctx.violations.push(...nested);
        }
      } else {
        addViolation(
          ctx,
          `job "${jobId}"`,
          'external-reusable-workflow',
          `"${job.uses}" cannot be audited from this repo — failing closed`,
        );
      }
      continue;
    }

    const steps = Array.isArray(job?.steps) ? job.steps : [];
    steps.forEach((step: any, index: number) => auditStep(ctx, jobId, step, index));

    const jobMutations = ctx.mutations.slice(mutationsBefore);
    if (jobMutations.length > 0) {
      // A credentialed deploy job may not run unauditable script files.
      ctx.violations.push(...ctx.jobExecCandidates);

      const jobIf = typeof job?.if === 'string' ? job.if : '';
      // Require the gate as a plain conjunct: reject if it is absent, or if
      // the `if` weakens it with disjunction/negation (`|| dispatch`, `!(…)`),
      // which would let an unguarded trigger through.
      if (!jobIf.includes(GATE_EXPRESSION)) {
        addViolation(
          ctx,
          `job "${jobId}"`,
          'ungated-mutation',
          `job runs ${jobMutations.map((m) => m.kind).join(', ')} without job-level "${GATE_EXPRESSION}" gate (push and workflow_dispatch would both be unguarded)`,
        );
      } else if (/\|\||(?<![!=<>])!(?!=)/.test(jobIf)) {
        addViolation(
          ctx,
          `job "${jobId}"`,
          'weakened-gate',
          `job "if" weakens the deploy gate with a disjunction/negation — the gate must be a plain conjunct: ${jobIf}`,
        );
      }
      for (const mutation of jobMutations) {
        if (mutation.pages) continue;
        if (/your-worker-name/i.test(mutation.segment)) {
          addViolation(ctx, `job "${jobId}"`, 'placeholder-worker-name', `Worker deploy may target the placeholder name: ${mutation.segment}`);
        }
        if (/--name\s+\$\{\{[^}]*\|\|/.test(mutation.segment)) {
          addViolation(ctx, `job "${jobId}"`, 'worker-name-fallback', `Worker deploy --name has a fallback expression instead of failing closed: ${mutation.segment}`);
        }
      }
    }
  }

  if (ctx.mutations.length > 0) {
    ctx.violations.push(...ctx.deployScopedHits);
    for (const { location, uses } of ctx.externalActions) {
      if (!MUTATING_WORKFLOW_ACTION_ALLOWLIST.some((prefix) => uses.startsWith(prefix))) {
        addViolation(
          ctx,
          location,
          'unapproved-action',
          `"${uses}" is not on the deploy-workflow action allowlist`,
        );
      }
    }
  }

  return ctx.violations;
}

export function auditWorkflowFile(file: string, options: AuditOptions): Violation[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return [{
      file,
      location: '(document)',
      rule: 'parse-failure',
      detail: `unreadable workflow file — failing closed: ${String(error)}`,
    }];
  }
  return auditWorkflowText(text, path.basename(file), options);
}

export function auditAllWorkflows(repoRoot: string): Violation[] {
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const files = readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
  const options: AuditOptions = { repoRoot };
  return files.flatMap((f) => auditWorkflowFile(path.join(workflowsDir, f), options));
}

function main(): void {
  const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
  const violations = auditAllWorkflows(repoRoot);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`[FAIL] ${v.file}: ${v.location}: ${v.rule}: ${v.detail}`);
    }
    console.error(`${violations.length} deploy safety violation(s).`);
    process.exit(1);
  }
  const count = readdirSync(path.join(repoRoot, '.github', 'workflows'))
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).length;
  console.log(`OK — ${count} workflow files pass deploy safety audit.`);
}

const isCliEntry =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) main();
