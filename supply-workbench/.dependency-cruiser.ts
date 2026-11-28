// 依赖规则集中在这里。适配器可以引用自己的 npm 库（drizzle、xlsx），
// 但不能引用兄弟适配器或 apps：那才是圈与圈之间的耦合。
import path from 'node:path';
import type { IConfiguration, IForbiddenRuleType } from 'dependency-cruiser';
import { CAPABILITY_IDS, WEB_FEATURE_IDS } from './packages/contracts/src/capabilities.ts';

const root = import.meta.dirname;
// 能力清单只在 @sw/contracts 维护一份；这里再手写第二份会让新增能力漏掉边界规则。
const applicationCapabilities = CAPABILITY_IDS;
const webFeatures = WEB_FEATURE_IDS;

const here = String.raw`(^|/)`;
const domain = `${here}packages/domain/`;
const application = `${here}packages/application/`;
const contracts = `${here}packages/contracts/`;
const persistence = `${here}packages/persistence/`;
const importers = `${here}packages/importers/`;
const renderers = `${here}packages/report-renderers/`;
const auth = `${here}packages/auth/`;
const testkit = `${here}packages/testkit/`;
const memoryBox = `${testkit}src/memory/box\\.ts$`;
const apps = `${here}apps/`;
const adapters = [persistence, importers, renderers, auth];
const adapterNames = ['persistence', 'importers', 'report-renderers', 'auth'];

const forbidden: IForbiddenRuleType[] = [
  {
    name: 'r1-domain-isolated',
    severity: 'error',
    comment: 'domain 不引用任何内部包、npm 包和 node:',
    from: { path: domain },
    to: { pathNot: domain },
  },
  {
    name: 'r2-application-only-domain',
    severity: 'error',
    comment: 'application 只引用 domain',
    from: { path: application },
    to: { pathNot: [application, domain] },
  },
  {
    name: 'r3-contracts-boundary',
    severity: 'error',
    comment: 'contracts 只引用 zod 和 domain',
    from: { path: contracts },
    to: {
      pathNot: [contracts, domain, application, '^zod$', '^zod/', 'node_modules/zod/'],
    },
  },
  {
    name: 'r3-contracts-application-type-only',
    severity: 'error',
    comment: 'contracts 引用 application 时只能 import type',
    from: { path: contracts },
    to: {
      path: application,
      dependencyTypesNot: ['type-only'],
    },
  },
  ...adapterNames.flatMap((name, index): IForbiddenRuleType[] => {
    const own = adapters[index];
    if (own === undefined) return [];
    return [
      {
        name: `r4-${name}-does-not-cross`,
        severity: 'error',
        comment: '适配器不引用兄弟适配器、contracts、testkit 或 apps',
        from: { path: own },
        to: {
          path: [...adapters.filter((adapter) => adapter !== own), contracts, testkit, apps],
        },
      },
    ];
  }),
  {
    name: 'r5-testkit-only-domain-application',
    severity: 'error',
    from: { path: testkit, pathNot: memoryBox },
    to: { pathNot: [testkit, domain, application] },
  },
  {
    name: 'r5-testkit-memory-transaction-context',
    severity: 'error',
    comment: '只在内存事务模型中使用 Node 异步上下文区分嵌套事务',
    from: { path: memoryBox },
    to: { pathNot: [testkit, domain, application, '^(?:node:)?async_hooks$'] },
  },
  {
    name: 'r5-testkit-only-from-tests',
    severity: 'error',
    comment: '生产代码不能引用 testkit',
    from: {
      pathNot: ['\\.test\\.ts$', `${here}test/`, testkit],
    },
    to: { path: testkit },
  },
  {
    name: 'r6-http-no-inner-or-adapters',
    severity: 'error',
    comment: '控制器不能引用 domain 和适配器',
    from: { path: `${here}apps/server/src/http/` },
    to: { path: [domain, persistence, importers, renderers, testkit] },
  },
  {
    name: 'r6-http-application-public-entry',
    severity: 'error',
    comment: '控制器只能引用 application 的公开入口',
    from: { path: `${here}apps/server/src/http/` },
    to: { path: `${application}(?!src/index\\.ts$)` },
  },
  {
    name: 'r7-only-main-composes',
    severity: 'error',
    comment: '只有 main 和 composition 可以引用适配器',
    from: {
      path: `${here}apps/server/src/`,
      pathNot: ['main\\.ts$', `${here}apps/server/src/composition/`],
    },
    to: { path: [persistence, importers, renderers, testkit] },
  },
  {
    name: 'r8-web-only-contracts-domain',
    severity: 'error',
    from: { path: `${here}apps/web/` },
    to: {
      path: [application, persistence, importers, renderers, auth, testkit, `${here}apps/server/`],
    },
  },
  {
    name: 'r10-model-no-ui-framework',
    severity: 'error',
    comment: 'feature 的 model 是纯函数，不认识界面框架',
    from: { path: `${here}apps/web/src/features/[^/]+/model/` },
    to: { path: '(^|/)(react|react-dom|antd|echarts|echarts-for-react)(/|$)' },
  },
  {
    name: 'r10-pages-compose-features',
    severity: 'error',
    from: { path: `${here}apps/web/src/pages/` },
    to: { path: `${here}apps/web/src/features/[^/]+/(?!index\\.ts$)` },
  },
  {
    name: 'r10-app-uses-shell-index',
    severity: 'error',
    comment: 'app 只能引用 shell 的公开入口',
    from: { path: `${here}apps/web/src/app/` },
    to: { path: `${here}apps/web/src/features/shell/(?!index\\.ts$)` },
  },
  {
    name: 'r11-no-circular',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
];

for (const source of applicationCapabilities) {
  for (const target of applicationCapabilities) {
    if (source === target) continue;
    forbidden.push({
      name: `r9-${source}-to-${target}-internals`,
      severity: 'error',
      comment: '能力之间只能经过对方的 index.ts',
      from: { path: `${application}src/${source}/` },
      to: { path: `${application}src/${target}/(?!index\.ts$)` },
    });
  }
}
for (const source of webFeatures) {
  for (const target of webFeatures) {
    if (source === target) continue;
    forbidden.push({
      name: `r10-${source}-to-${target}-internals`,
      severity: 'error',
      comment: 'feature 之间只能经过对方的 index.ts',
      from: { path: `${here}apps/web/src/features/${source}/` },
      to: { path: `${here}apps/web/src/features/${target}/(?!index\.ts$)` },
    });
  }
}

const config = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: `(${here}(dist|node_modules|fixtures)/)|\\.violation\\.ts$` },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: path.join(root, 'tsconfig.json') },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'default'],
      extensions: ['.ts', '.tsx', '.js'],
    },
    reporterOptions: {
      text: { highlightFocused: false },
    },
  },
} satisfies IConfiguration;

export default config;
