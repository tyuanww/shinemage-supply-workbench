import { Input, Layout, Modal, Typography } from 'antd';
import { Link, Outlet, useNavigate } from 'react-router';
import { SearchResultSchema } from '@sw/contracts';
import { searchGroups, type SearchGroups } from '../features/search/hits.js';
import { apiGet } from '../shared/api/client.js';
import { useCallback, useEffect, useState } from 'react';
import {
  closeDrawer,
  initialFrame,
  shellChrome,
  syncFrame,
  toggleFrame,
  useShellViewport,
  type ShellChrome,
  type ShellView,
  type ViewportSnapshot,
} from '../features/shell/index.js';
import { matchesShortcut, searchShortcut, type Shortcut } from '../shared/hooks/shortcuts.js';
import { bg } from '../theme/tokens.js';
import { ShellDrawer, ShellSider, ShellTop, type MenuButton } from './shell-frame.js';
import { WorkspaceBreadcrumb } from './workspace-breadcrumb.js';
import { SearchDialogBlocksPageFocus } from '../shared/hooks/browser-entry-history.js';

export function Shell(props: {
  readonly view: ShellView & { readonly userId: string };
}) {
  const viewport = useShellViewport();
  const [frame, setFrame] = useState(() => initialFrame(viewport));
  const [search, setSearch] = useState<'open' | 'closing' | 'closed'>('closed');
  const openSearch = useCallback(() => setSearch('open'), []);
  useSearchShortcut(openSearch);
  const synced = syncFrame({ frame, snapshot: viewport });
  if (synced !== frame) setFrame(synced);
  return (
    <Layout style={{ minHeight: '100vh', background: bg.page }}>
      <SearchDialogBlocksPageFocus value={search !== 'closed'}>
        <ShellColumns
          view={props.view}
          viewport={viewport}
          chrome={shellChrome(synced)}
          onToggle={() => setFrame(toggleFrame)}
          onClose={() => setFrame(closeDrawer)}
          onSearch={openSearch}
        />
      </SearchDialogBlocksPageFocus>
      <SearchLayer open={search === 'open'} onClose={() => setSearch('closing')}
        afterClose={() => setSearch(current => current === 'closing' ? 'closed' : current)} />
    </Layout>
  );
}

function ShellColumns(input: {
  readonly view: ShellView;
  readonly viewport: ViewportSnapshot;
  readonly chrome: ShellChrome;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onSearch: () => void;
}) {
  const isBreadcrumbInHeader = input.chrome.kind === 'sider';
  return (
    <>
      <FrameSlot chrome={input.chrome} nav={input.view.nav} onToggle={input.onToggle} onClose={input.onClose} />
      <Layout style={{ background: bg.page }}>
        <ShellTop
          account={input.view.account}
          onSearch={input.onSearch}
          contentInset={input.viewport.contentInset}
          menuButton={menuButtonOf(input)}
          startContent={isBreadcrumbInHeader ? <WorkspaceBreadcrumb rows={input.view.nav} inline /> : null}
        />
        <Layout.Content style={{ margin: input.viewport.contentInset, isolation: 'isolate' }}>
          {isBreadcrumbInHeader ? null : <WorkspaceBreadcrumb rows={input.view.nav} />}
          <Outlet context={input.view} />
        </Layout.Content>
      </Layout>
    </>
  );
}

function FrameSlot(input: {
  readonly chrome: ShellChrome;
  readonly nav: ShellView['nav'];
  readonly onToggle: () => void;
  readonly onClose: () => void;
}) {
  if (input.chrome.kind === 'drawer') {
    return <ShellDrawer chrome={input.chrome} nav={input.nav} onClose={input.onClose} />;
  }
  return <ShellSider chrome={input.chrome} nav={input.nav} onToggle={input.onToggle} />;
}

function menuButtonOf(input: { readonly chrome: ShellChrome; readonly onToggle: () => void }): MenuButton | null {
  if (input.chrome.kind !== 'drawer') return null;
  return {
    toggleName: input.chrome.toggleName,
    hitPx: input.chrome.hitPx,
    isOpen: input.chrome.isOpen,
    onToggle: input.onToggle,
  };
}

function useSearchShortcut(openSearch: () => void): void {
  useEffect(() => {
    const shortcut: Shortcut = searchShortcut(openSearch);
    const onKey = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      shortcut.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);
}

function SearchLayer({ open, onClose, afterClose }: { readonly open: boolean; readonly onClose: () => void; readonly afterClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<SearchGroups>({ lines: [], products: [], parties: [] });
  const [error, setError] = useState('');
  useSearchQuery({ open, query, setGroups, setError });
  return (
    <Modal title="搜索" open={open} onCancel={onClose} afterClose={afterClose} footer={null} destroyOnHidden>
      <Input
        autoFocus
        placeholder="单号 / 品名 / 编码"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            navigate(`/lines?lane=all&q=${encodeURIComponent(query.trim())}`);
            onClose();
          }
        }}
      />
      {error === '' ? null : <Typography.Paragraph type="danger">{error}</Typography.Paragraph>}
      <SearchGroup title="订单行" items={groups.lines} onClose={onClose} />
      <SearchGroup title="产品" items={groups.products} onClose={onClose} />
      <SearchGroup title="主体" items={groups.parties} onClose={onClose} />
    </Modal>
  );
}

function SearchGroup({
  title,
  items,
  onClose,
}: {
  readonly title: string;
  readonly items: SearchGroups['lines'];
  readonly onClose: () => void;
}) {
  return (
    <section>
      <Typography.Title level={5}>{title}</Typography.Title>
      {items.slice(0, 5).map((item) => (
        <div key={item.id}>
          <Link to={item.to} onClick={onClose}>
            {item.label}
          </Link>
        </div>
      ))}
    </section>
  );
}

function useSearchQuery(input: {
  readonly open: boolean;
  readonly query: string;
  readonly setGroups: (groups: SearchGroups) => void;
  readonly setError: (error: string) => void;
}): void {
  const { open: isOpen, query, setGroups, setError } = input;
  useEffect(() => {
    if (!isOpen) return;
    const q = query.trim();
    if (q.length < 2) {
      setGroups({ lines: [], products: [], parties: [] });
      setError('');
      return;
    }
    const timer = window.setTimeout(() => {
      void loadSearch(q)
        .then((found) => {
          setGroups(found);
          setError('');
        })
        .catch(() => setError('搜索没有完成'));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [isOpen, query, setGroups, setError]);
}

async function loadSearch(q: string): Promise<SearchGroups> {
  return searchGroups(await apiGet(`/api/v1/search?q=${encodeURIComponent(q)}`, SearchResultSchema));
}
