import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  GATE_EXPRESSION,
  auditAllWorkflows,
  auditWorkflowFile,
  auditWorkflowText,
  commandSegments,
  type Violation,
} from './deploy-workflow-safety';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts', 'fixtures', 'deploy-workflow-safety');
const deployWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'deploy-cloudflare-worker.yml');

function auditFixture(name: string): Violation[] {
  return auditWorkflowFile(path.join(fixturesDir, name), { repoRoot });
}

function rules(violations: Violation[]): string[] {
  return [...new Set(violations.map((v) => v.rule))];
}

describe('live workflows', () => {
  it('every workflow in .github/workflows passes the deploy safety audit', () => {
    expect(auditAllWorkflows(repoRoot)).toEqual([]);
  });

  it('the Worker deploy workflow keeps the job-level deploy gate (guards push AND workflow_dispatch)', () => {
    const doc = parse(readFileSync(deployWorkflowPath, 'utf8'));
    const jobIf = doc.jobs.deploy.if as string;
    expect(jobIf).toContain(GATE_EXPRESSION);
    expect(jobIf).toContain("github.repository != 'Shudesu/line-harness-oss'");
  });

  it('the Worker deploy workflow is a pure code deploy with a fail-closed worker name', () => {
    const text = readFileSync(deployWorkflowPath, 'utf8');
    // The verify step may NAME the placeholder to reject it; what must never
    // exist is a fallback expression that deploys under it.
    expect(text).not.toMatch(/\|\|\s*'your-worker-name'/);
    expect(text).not.toContain('d1 execute');
    const doc = parse(text);
    const steps: any[] = doc.jobs.deploy.steps;
    const deployStep = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('cloudflare/wrangler-action'));
    expect(deployStep.with.command).toBe(
      'deploy --config dist/line_harness/wrangler.json --name ${{ vars.WORKER_NAME }}',
    );
  });

  it('the Worker deploy workflow runs the safety audit before deploying', () => {
    const doc = parse(readFileSync(deployWorkflowPath, 'utf8'));
    const steps: any[] = doc.jobs.deploy.steps;
    const auditIndex = steps.findIndex(
      (s) => typeof s.run === 'string' && s.run.includes('deploy-workflow-safety.ts'),
    );
    const deployIndex = steps.findIndex(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('cloudflare/wrangler-action'),
    );
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(auditIndex);
  });

  it('the deploy workflow does not let its audit step soft-fail via continue-on-error', () => {
    const doc = parse(readFileSync(deployWorkflowPath, 'utf8'));
    const steps: any[] = doc.jobs.deploy.steps;
    const auditStep = steps.find(
      (s) => typeof s.run === 'string' && s.run.includes('deploy-workflow-safety.ts'),
    );
    expect(auditStep).toBeDefined();
    expect(auditStep['continue-on-error']).toBeUndefined();
  });

  it('the deploy CI backstop has no branch filter on push (branch pushes are audited)', () => {
    const safetyWorkflow = path.join(repoRoot, '.github', 'workflows', 'deploy-workflow-safety.yml');
    const on = parse(readFileSync(safetyWorkflow, 'utf8')).on;
    // `push:` present but with no `branches:` narrowing.
    expect('push' in on).toBe(true);
    expect(on.push == null || on.push.branches == null).toBe(true);
  });

  it('flags the deploy workflow if its gate is ever removed (regression control)', () => {
    const text = readFileSync(deployWorkflowPath, 'utf8');
    const ungated = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('if: github.repository'))
      .join('\n');
    expect(ungated).not.toBe(text);
    const violations = auditWorkflowText(ungated, 'deploy-cloudflare-worker.yml (gate removed)', { repoRoot });
    expect(rules(violations)).toContain('ungated-mutation');
  });
});

describe('negative controls — DB mutation paths must FAIL', () => {
  it.each([
    ['d1-execute.yml', 'wrangler d1 execute'],
    ['d1-execute-backslash.yml', 'backslash-continued wrangler d1 execute'],
    ['d1-migrations-apply.yml', 'wrangler d1 migrations apply'],
    ['file-flag.yml', '--file= SQL execution'],
    ['pnpm-db-migrate.yml', 'pnpm db:migrate indirection'],
    ['npm-run-db-migrate.yml', 'npm run db:migrate indirection'],
    ['curl-d1-rest.yml', 'direct Cloudflare REST call'],
    ['composite-indirection.yml', 'local composite action hiding a D1 write'],
    ['quoted-keys-d1.yml', 'quoted YAML keys'],
    ['dangerous-d1-loop.yml', 'frozen pre-hardening deploy workflow with migration loop'],
  ])('%s (%s) is rejected as db-mutation', (fixture) => {
    expect(rules(auditFixture(fixture))).toContain('db-mutation');
  });

  it('env-assembled eval is rejected (dynamic exec AND the env value itself)', () => {
    const found = rules(auditFixture('env-eval.yml'));
    expect(found).toContain('dynamic-exec');
    expect(found).toContain('db-mutation');
  });

  it('an ungated legacy deploy workflow (deploy-worker.yml shape) is rejected', () => {
    expect(rules(auditFixture('legacy-ungated-deploy.yml'))).toContain('ungated-mutation');
  });

  it('a Worker deploy with a placeholder-name fallback is rejected', () => {
    const found = rules(auditFixture('worker-name-fallback.yml'));
    expect(found).toContain('placeholder-worker-name');
    expect(found).toContain('worker-name-fallback');
  });

  it('external reusable workflows cannot be audited and fail closed', () => {
    expect(rules(auditFixture('external-reusable.yml'))).toContain('external-reusable-workflow');
  });

  it('an unresolvable --filter (missing package) fails closed', () => {
    const violations = auditWorkflowText(
      [
        'name: x',
        'on: push',
        'jobs:',
        '  bad:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: pnpm --filter no-such-package deploy',
      ].join('\n'),
      'missing-filter.yml',
      { repoRoot },
    );
    expect(rules(violations)).toContain('unresolvable-script');
  });

  it('unparseable YAML fails closed', () => {
    expect(rules(auditFixture('malformed.yml'))).toContain('parse-failure');
  });

  it.each([
    ['precommands.yml', 'wrangler-action preCommands running d1'],
    ['github-script-d1.yml', 'github-script with.script hitting the D1 REST API'],
  ])('%s (%s) is rejected as db-mutation', (fixture) => {
    expect(rules(auditFixture(fixture))).toContain('db-mutation');
  });

  it.each([
    ['quoted-d1.yml', 'wrangler "d1" execute'],
    ['ifs-d1.yml', 'npx${IFS}wrangler${IFS}d1${IFS}execute'],
    ['ifs-variant-d1.yml', 'wrangler${IFS%??}d1${IFS%??}execute'],
  ])('%s defeats shell-quoting evasion and is caught', (fixture) => {
    expect(rules(auditFixture(fixture))).toContain('db-mutation');
  });

  it.each([
    ['pnpm-dir-deploy.yml', 'pnpm -C apps/worker deploy'],
    ['pnpm-dir-equals.yml', 'pnpm --dir=apps/worker deploy'],
    ['pnpm-c-attached.yml', 'pnpm -Capps/worker deploy'],
    ['npx-pnpm-deploy.yml', 'npx pnpm --filter worker deploy'],
    ['corepack-deploy.yml', 'corepack pnpm --filter worker deploy'],
    ['yarn-workspace-deploy.yml', 'yarn workspace worker deploy'],
    ['yarn-foreach-deploy.yml', 'yarn workspaces foreach run deploy'],
    ['npm-prefix-equals.yml', 'npm --prefix=apps/worker run deploy'],
    ['npm-workspace-deploy.yml', 'npm -w apps/worker run deploy'],
    ['pnpm-filter-path-deploy.yml', 'pnpm --filter=./apps/worker deploy'],
  ])('%s (%s) resolves to an ungated wrangler deploy', (fixture) => {
    expect(rules(auditFixture(fixture))).toContain('ungated-mutation');
  });

  it('mutually-referencing reusable workflows do not crash the auditor', () => {
    expect(() => auditFixture('reusable-cycle-a.yml')).not.toThrow();
  });

  it('a gate weakened by disjunction is rejected', () => {
    expect(rules(auditFixture('gate-disjunction.yml'))).toContain('weakened-gate');
  });

  it('a mutation in a second, ungated job is not memoized away', () => {
    expect(rules(auditFixture('cross-job-memo.yml'))).toContain('ungated-mutation');
  });

  it('an unauditable script file in a credentialed deploy job fails closed', () => {
    expect(rules(auditFixture('script-file-exec.yml'))).toContain('unauditable-exec');
  });

  it('pipe-to-shell is rejected as dynamic exec', () => {
    expect(rules(auditFixture('pipe-to-shell.yml'))).toContain('dynamic-exec');
  });

  it('a wrangler-action subcommand supplied by a GitHub expression fails closed', () => {
    expect(rules(auditFixture('command-expression.yml'))).toContain('unauditable-command');
  });

  it('resolves innocuous-looking package scripts to their real commands', () => {
    const violations = auditWorkflowFile(path.join(fixturesDir, 'indirect-script.yml'), {
      repoRoot,
      packages: [
        {
          name: 'line-oss-crm',
          dir: '.',
          scripts: {
            'sync:data': 'node scripts/sync.js && wrangler d1 execute prod --remote --command "DELETE FROM x"',
          },
        },
      ],
    });
    expect(rules(violations)).toContain('db-mutation');
  });
});

describe('positive controls — safe workflows must PASS', () => {
  it.each([
    ['gated-pure-deploy.yml', 'gated plain wrangler deploy'],
    ['install-build-only.yml', 'pnpm install/build only'],
  ])('%s (%s) passes', (fixture) => {
    expect(auditFixture(fixture)).toEqual([]);
  });
});

describe('commandSegments', () => {
  it('normalizes backslash line continuations into one segment', () => {
    const segments = commandSegments('npx wrangler \\\n  d1 \\\n  execute prod');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatch(/wrangler\s+d1\s+execute prod/);
  });

  it('does not split GitHub || expressions apart', () => {
    const segments = commandSegments("deploy --name ${{ vars.WORKER_NAME || 'your-worker-name' }}");
    expect(segments).toHaveLength(1);
  });
});
