import { Button, ConfigProvider, Drawer, Layout, Menu } from 'antd';
import { CloseOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons';
import type { CSSProperties, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { globalSearchTriggerId } from '../shared/hooks/browser-entry-history.js';
import { shellLayer, type NavRow, type ShellChrome, type ShellView } from '../features/shell/index.js';
import { searchShortcutHint } from '../shared/hooks/shortcuts.js';
import { bg, border, brand, navCollapsed, navWidth, onBrand, space, topBar } from '../theme/tokens.js';
import { groupKey, navMenuItems, sidebarSelection } from './shell-nav.js';
import { AccountMenu } from './shell-session.js';

export const searchTrackPx = 280;
const searchLabel = '搜索单号、品名、供应商';

export function menuWidth(input: { readonly isCollapsed: boolean }): typeof navCollapsed | typeof navWidth {
  if (input.isCollapsed) return navCollapsed;
  return navWidth;
}

export function onBrandIconColor(): CSSProperties {
  return { color: onBrand.solid };
}

export function headerGridColumns(input: { readonly isPhone: boolean }): string {
  if (input.isPhone) return 'auto minmax(0, 1fr) auto';
  return `minmax(0, 1fr) minmax(0, ${searchTrackPx}px) auto`;
}

export function headerBarStyle(input: { readonly contentInset: 16 | 24; readonly isPhone: boolean }): CSSProperties {
  return {
    position: 'sticky',
    top: 0,
    zIndex: shellLayer.header,
    height: topBar,
    lineHeight: `${topBar}px`,
    display: 'grid',
    gridTemplateColumns: headerGridColumns({ isPhone: input.isPhone }),
    alignItems: 'center',
    columnGap: space[2],
    padding: `0 ${input.contentInset}px`,
    background: bg.surface,
    borderBottom: `1px solid ${border}`,
  };
}

export function siderBarStyle(): CSSProperties {
  return {
    position: 'sticky',
    top: 0,
    zIndex: shellLayer.sider,
    height: '100vh',
    alignSelf: 'flex-start',
    background: brand[800],
  };
}

export function drawerFrame(input: { readonly width: typeof navWidth }): {
  readonly placement: 'left';
  readonly size: typeof navWidth;
} {
  return { placement: 'left', size: input.width };
}

export function searchButtonStyle(): CSSProperties {
  return {
    width: searchTrackPx,
    maxWidth: '100%',
    minWidth: 0,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    overflow: 'hidden',
  };
}

export function searchTextStyle(): CSSProperties {
  return { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
}

export type MenuButton = {
  readonly toggleName: '打开菜单' | '关闭菜单';
  readonly hitPx: 44;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
};

export function ShellSider(input: {
  readonly chrome: Extract<ShellChrome, { readonly kind: 'sider' }>;
  readonly nav: readonly NavRow[];
  readonly onToggle: () => void;
}): ReactNode {
  return (
    <Layout.Sider
      width={navWidth}
      collapsedWidth={navCollapsed}
      collapsed={input.chrome.isCollapsed}
      trigger={null}
      className="shell-sider"
      style={siderBarStyle()}
      styles={{ body: siderBodyStyle() }}
    >
      <SiderLogo isCollapsed={input.chrome.isCollapsed} />
      <div style={menuRegionStyle()}>
        <ShellMenu rows={input.nav} isCollapsed={input.chrome.isCollapsed} onNavigate={noop} />
      </div>
      <CollapseButton name={input.chrome.toggleName} hitPx={input.chrome.hitPx} isCollapsed={input.chrome.isCollapsed} onToggle={input.onToggle} />
    </Layout.Sider>
  );
}

export function ShellTop(input: {
  readonly account: ShellView['account'];
  readonly onSearch: () => void;
  readonly contentInset: 16 | 24;
  readonly menuButton: MenuButton | null;
  readonly startContent: ReactNode;
}): ReactNode {
  const isPhone = input.menuButton !== null;
  return (
    <Layout.Header className="shell-header" style={headerBarStyle({ contentInset: input.contentInset, isPhone })}>
      <HeaderStart menuButton={input.menuButton} startContent={input.startContent} />
      <SearchButton onSearch={input.onSearch} hitPx={input.menuButton?.hitPx} />
      <AccountMenu account={input.account} hitPx={input.menuButton?.hitPx} />
    </Layout.Header>
  );
}

export function ShellDrawer(input: {
  readonly chrome: Extract<ShellChrome, { readonly kind: 'drawer' }>;
  readonly nav: readonly NavRow[];
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Drawer
      {...drawerFrame({ width: navWidth })}
      open={input.chrome.isOpen}
      onClose={input.onClose}
      closable={false}
      title={<span style={drawerTitleStyle()}>导航</span>}
      extra={<DrawerCloseButton onClose={input.onClose} />}
      styles={drawerChromeStyles()}
    >
      <ConfigProvider theme={{ components: { Menu: { itemHeight: input.chrome.hitPx } } }}>
        <ShellMenu rows={input.nav} isCollapsed={false} onNavigate={input.onClose} />
      </ConfigProvider>
    </Drawer>
  );
}

export const searchButtonLabel = searchLabel;

function ShellMenu(input: {
  readonly rows: readonly NavRow[];
  readonly isCollapsed: boolean;
  readonly onNavigate: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { selected, group } = sidebarSelection(input.rows, location);
  const isTabGroup = group === groupKey('/today') || group === groupKey('/progress');
  return (
    <Menu
      key={isTabGroup && input.isCollapsed ? `${group}:collapsed` : group ?? 'main'}
      theme="dark"
      mode="inline"
      inlineCollapsed={input.isCollapsed}
      defaultOpenKeys={[group].filter((key): key is string => key !== undefined && !input.isCollapsed)}
      selectedKeys={selected === undefined ? [] : [selected]}
      style={{ background: brand[800], width: menuWidth({ isCollapsed: input.isCollapsed }) }}
      items={navMenuItems({ ...input, location, selected, navigate })}
    />
  );
}

function CollapseButton(input: {
  readonly name: '收起侧栏' | '展开侧栏';
  readonly hitPx: 40;
  readonly isCollapsed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      type="text"
      aria-label={input.name}
      onClick={input.onToggle}
      icon={input.isCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
      style={{ ...onBrandIconColor(), width: input.hitPx, height: input.hitPx, flexShrink: 0, alignSelf: input.isCollapsed ? 'center' : 'flex-start' }}
    />
  );
}

function HeaderStart(input: {
  readonly menuButton: MenuButton | null;
  readonly startContent: ReactNode;
}) {
  if (input.menuButton !== null) return <HeaderMenuButton button={input.menuButton} />;
  return <div style={{ minWidth: 0, overflow: 'hidden' }}>{input.startContent}</div>;
}

function DrawerCloseButton({ onClose }: { readonly onClose: () => void }) {
  return (
    <Button
      type="text"
      aria-label="关闭导航"
      onClick={onClose}
      icon={<CloseOutlined />}
      style={{ ...onBrandIconColor(), width: 44, height: 44 }}
    />
  );
}

function HeaderMenuButton({ button }: { readonly button: MenuButton }) {
  return (
    <Button
      type="text"
      aria-label={button.toggleName}
      onClick={button.onToggle}
      icon={button.isOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
      style={{ width: button.hitPx, height: button.hitPx, flexShrink: 0 }}
    />
  );
}

function SearchButton({ onSearch, hitPx }: { readonly onSearch: () => void; readonly hitPx: number | undefined }) {
  const hint = searchShortcutHint();
  const isPhone = hitPx !== undefined;
  return (
    <Button
      aria-label={searchLabel}
      aria-haspopup="dialog"
      id={globalSearchTriggerId}
      aria-keyshortcuts={hint.ariaKeys}
      onClick={onSearch}
      icon={isPhone ? <SearchOutlined aria-hidden="true" /> : undefined}
      style={isPhone
        ? {
          ...searchButtonStyle(),
          minHeight: hitPx,
          justifyContent: 'center',
          paddingInline: space[2],
          lineHeight: 'var(--ant-line-height, 1.5)',
        }
        : searchButtonStyle()}
    >
      <span style={searchTextStyle()}>{isPhone ? '搜索' : searchLabel}</span>
      {isPhone ? null : <span aria-hidden="true" style={{ flexShrink: 0 }}>{hint.label}</span>}
    </Button>
  );
}

function SiderLogo({ isCollapsed }: { readonly isCollapsed: boolean }) {
  return (
    <div style={logoStyle(isCollapsed)}>{isCollapsed ? '供' : '供应链'}</div>
  );
}

function siderBodyStyle(): CSSProperties {
  return { display: 'flex', flexDirection: 'column', height: '100%' };
}

function menuRegionStyle(): CSSProperties {
  return { flex: 1, minHeight: 0, overflowY: 'auto' };
}

function logoStyle(isCollapsed: boolean): CSSProperties {
  return {
    height: topBar,
    lineHeight: `${topBar}px`,
    color: onBrand.solid,
    fontWeight: 600,
    flexShrink: 0,
    paddingInline: isCollapsed ? 0 : space[3],
    textAlign: isCollapsed ? 'center' : 'start',
  };
}

function drawerChromeStyles(): { readonly header: CSSProperties; readonly body: CSSProperties } {
  return {
    header: { background: brand[800], borderBottom: 'none', paddingInline: space[3], color: onBrand.solid },
    body: { padding: 0, background: brand[800] },
  };
}

function drawerTitleStyle(): CSSProperties {
  return { color: onBrand.solid, fontWeight: 600 };
}

function noop(): void {
  return undefined;
}
