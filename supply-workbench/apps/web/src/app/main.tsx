import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App as AntApp, Button, ConfigProvider, Result, Skeleton } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import '../pages/products/dossier-review.css';
import { antdTheme, themePatchCss } from '../theme/antd.js';
import { SessionMetaSchema, type MeResponse } from '@sw/contracts';
import { ApiError, apiGet } from '../shared/api/client.js';
import { failureText, read, readFailureOf, ReadError } from '../shared/api/reads.js';
import { AppRoutes } from './routes.js';
import { fontFamily } from '../theme/tokens.js';
import { setBusinessTimeZone } from '../shared/business-time-zone.js';
import { BrowserEntryHistory } from '../shared/hooks/browser-entry-history.js';

const root = document.querySelector('#root');
if (root === null) throw new Error('找不到根节点');

async function boot(mount: Element): Promise<void> {
  if (import.meta.env.DEV) {
    const mocks = await import('../mocks/browser.js');
    await mocks.startMocks();
  }
  createRoot(mount).render(<AppRoot />);
}

type BootState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly session: MeResponse | undefined }
  | { readonly kind: 'failed'; readonly message: string };

function AppRoot() {
  const [state, setState] = useState<BootState>({ kind: 'loading' });
  useEffect(() => {
    void loadSession().then((next) => setState(next));
  }, []);
  return (
    <StrictMode>
      <ConfigProvider theme={antdTheme} locale={zhCN} button={{ autoInsertSpace: false }}>
        <AntApp>
          <style>{themePatchCss}</style>
          <BrowserRouter>
            <BrowserEntryHistory>
              <div style={{ fontFamily }}>
                <BootScreen state={state} />
              </div>
            </BrowserEntryHistory>
          </BrowserRouter>
        </AntApp>
      </ConfigProvider>
    </StrictMode>
  );
}

function BootScreen(props: { readonly state: BootState }) {
  if (props.state.kind === 'loading') return <div style={{ padding: 24 }}><Skeleton active paragraph={{ rows: 8 }} /></div>;
  if (props.state.kind === 'failed') {
    return (
      <Result
        status="error"
        title="会话没有读出来"
        subTitle={props.state.message}
        extra={<Button type="primary" onClick={() => window.location.reload()}>重试</Button>}
      />
    );
  }
  return <AppRoutes user={props.state.session} />;
}

async function loadSession(): Promise<BootState> {
  try {
    const session = await read({ name: 'me' });
    await readSessionMeta();
    return { kind: 'ready', session };
  } catch (error) {
    if (error instanceof ReadError && error.failure.kind === 'api') return { kind: 'ready', session: undefined };
    if (error instanceof ApiError) return { kind: 'ready', session: undefined };
    const failure = readFailureOf(error);
    if (failure === null) throw error;
    return { kind: 'failed', message: failureText(failure) };
  }
}

async function readSessionMeta(): Promise<void> {
  try {
    const meta = await apiGet('/api/v1/meta/session', SessionMetaSchema);
    setBusinessTimeZone(meta.businessTimeZone);
  } catch (error) {
    if (error instanceof ApiError) return;
    throw error;
  }
}

void boot(root);
