import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const cruise = path.join(root, 'node_modules/.bin/depcruise');
const config = path.join(root, 'test/architecture/cruise-violations.ts');

const cases = [
  ['r1-domain-imports-zod', 'r1-domain-isolated'],
  ['r2-application-imports-node', 'r2-application-only-domain'],
  ['r3-contracts-imports-fastify', 'r3-contracts-boundary'],
  ['r4-persistence-imports-importers', 'r4-persistence-does-not-cross'],
  ['r5-server-imports-testkit', 'r5-testkit-only-from-tests'],
  ['r6-http-imports-domain', 'r6-http-no-inner-or-adapters'],
  ['r7-job-imports-persistence', 'r7-only-main-composes'],
  ['r8-web-imports-persistence', 'r8-web-only-contracts-domain'],
  ['r9-capability-internals', 'r9-follow-up-to-today-internals'],
  ['r10-model-imports-react', 'r10-model-no-ui-framework'],
  ['r11-circular', 'r11-no-circular'],
] as const;

function violationReport(dir: string): string {
  const cwd = path.join(root, 'test/architecture/violations', dir);
  const result = spawnSync(cruise, ['--config', config, '--output-type', 'err', '.'], {
    cwd,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).not.toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

it('R1 到 R11 的故意违反样例都会被 dependency-cruiser 拦住', () => {
  for (const [dir, rule] of cases) {
    expect(violationReport(dir), dir).toContain(rule);
  }
});

it('contracts 用值导入 application 也会被拦住', () => {
  expect(violationReport('r3-contracts-imports-fastify')).toContain(
    'r3-contracts-application-type-only',
  );
});

it('内存事务只在 box 中允许导入 Node 异步上下文', () => {
  const report = violationReport('r5-testkit-memory-context');
  expect(report).toMatch(/r5-testkit-only-domain-application: .*memory\/unit-of-work\.ts → (node:)?async_hooks/);
  expect(report).toMatch(/r5-testkit-memory-transaction-context: .*memory\/box\.ts → (node:)?fs/);
  expect(report).not.toMatch(/memory\/box\.ts → (node:)?async_hooks/);
});
