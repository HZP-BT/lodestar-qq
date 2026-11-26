type Route = 'overview' | 'protocol' | 'metrics' | 'system';

interface StatusPayload {
  ok: boolean;
  demo?: boolean;
  account: { idHash: string; sessionHash: string };
  loader: {
    process: string;
    loginState: string;
    dataPlane: string;
    qqBuild: string | null;
    detail: string | null;
  };
  onebot: { clientState: string };
  health: { state: string; loginState: string };
  pendingEvents: number;
  replayableEvents: number;
  serverTime: string;
}

interface ProtocolPayload {
  panel: { host: string; port: number };
  onebot: { port: number; url: string; tokenConfigured: boolean };
  reverse: { url: string; tokenConfigured: boolean };
  selfIdHash: string;
}

interface RestartResponse {
  ok: boolean;
  restartedAt?: string;
  detail?: string;
  status?: StatusPayload;
}

interface SmoothRestartOptions {
  panelPortChanged: boolean;
}

const view = document.getElementById('view') as HTMLElement;
const connState = document.getElementById('conn-state') as HTMLElement;
const connLabel = document.getElementById('conn-label') as HTMLElement;
const onboardingOpen = document.getElementById('onboarding-open') as HTMLButtonElement;
const authOverlay = document.getElementById('auth-overlay') as HTMLElement;
const authForm = document.getElementById('auth-form') as HTMLFormElement;
const authToken = document.getElementById('auth-token') as HTMLInputElement;
const authError = document.getElementById('auth-error') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLElement;
const modalRoot = document.getElementById('modal-root') as HTMLElement;
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;

type Theme = 'dark' | 'light';

function currentTheme(): Theme {
  const selected = document.documentElement.dataset.theme;
  if (selected === 'light' || selected === 'dark') return selected;
  try {
    const saved = localStorage.getItem('lodestar.theme') ?? localStorage.getItem('polaris.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Keep the dark default when storage is unavailable.
  }
  return 'dark';
}

function applyTheme(next: Theme): void {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('lodestar.theme', next);
  } catch {
    // Keep the theme for this session only.
  }
  themeToggle.textContent = next === 'dark' ? '☀' : '☾';
  themeToggle.title = next === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  themeToggle.setAttribute('aria-label', themeToggle.title);
  themeToggle.setAttribute('aria-pressed', String(next === 'light'));
}

let theme = currentTheme();
applyTheme(theme);
themeToggle.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
});

let token = '';
try {
  token =
    sessionStorage.getItem('lodestar.admin.token') ??
    sessionStorage.getItem('polaris.admin.token') ??
    '';
} catch {
  // sessionStorage can be unavailable; the token stays in memory.
}

let coreStatus: StatusPayload | null = null;
let protocol: ProtocolPayload | null = null;
let route: Route = routeFromHash();
let toastTimer = 0;
let protocolRestartRequired = false;
let metricsRevealPending = false;

function routeFromHash(): Route {
  const value = location.hash.replace(/^#\/?/, '');
  return value === 'protocol' || value === 'metrics' || value === 'system' ? value : 'overview';
}

function esc(value: unknown): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = String(value);
  } else if (value !== null && value !== undefined) {
    text = JSON.stringify(value) ?? '';
  }
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    window.setTimeout(resolvePromise, ms);
  });
}

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 4000);
}

function isDemoStatus(status: StatusPayload | null): boolean {
  return status?.demo === true || status?.loader.qqBuild === 'mock-1';
}

function serviceState(): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!coreStatus) {
    return { label: '后端核心服务未连接', tone: 'bad' };
  }
  const s = coreStatus;
  if (isDemoStatus(s)) {
    return { label: '演示模式（Mock）', tone: 'warn' };
  }
  if (s.health.state === 'OFFLINE') {
    return { label: '后端核心服务未连接', tone: 'bad' };
  }
  if (s.loader.loginState === 'LOGGED_IN' && s.health.state === 'ONLINE') {
    return { label: '登录成功', tone: 'ok' };
  }
  if (s.loader.loginState === 'LOGGED_IN' && s.onebot.clientState === 'open') {
    return { label: '核心已连接，状态确认中', tone: 'warn' };
  }
  if (s.onebot.clientState === 'waiting' || s.onebot.clientState === 'connecting') {
    return { label: '后端核心服务未连接', tone: 'warn' };
  }
  return { label: '后端核心服务未连接', tone: 'warn' };
}

function serviceHint(): string {
  if (!coreStatus) {
    return '无法读取本地 Core 状态。请确认核心进程仍在运行，然后重试。';
  }
  if (isDemoStatus(coreStatus)) {
    return '当前使用内置 Mock 后端，未连接真实 QQ 和 AstrBot；以下状态均为模拟数据。';
  }
  if (coreStatus.health.state === 'OFFLINE') {
    return 'Core 尚未连上 AstrBot 的反向 WebSocket。请确认 QQ、loader 和 AstrBot 已启动，并检查地址和 token。';
  }
  if (coreStatus.loader.dataPlane === 'silent') {
    return 'Loader 进程没有响应。请确认 QQ 已登录，且 loader 仍在运行。';
  }
  if (coreStatus.onebot.clientState === 'open' && coreStatus.loader.loginState !== 'LOGGED_IN') {
    return '已连上 AstrBot，但尚未确认 QQ 登录状态。请在 QQ 窗口完成登录。';
  }
  if (coreStatus.onebot.clientState !== 'open') {
    return 'Core 尚未连上 AstrBot 的反向 WebSocket。请检查地址和 token。';
  }
  return '核心服务运行正常，正在等待上游事件。';
}

function connectionFailureHint(status?: number, message?: string): string {
  if (status === 401 || status === 403) {
    return '鉴权失败，请检查 token';
  }
  if (message && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out|handshake/i.test(message)) {
    return '对端未启动或地址不可达';
  }
  return '连接失败，请检查地址和 token';
}

function updateConnectionState(): void {
  const state = serviceState();
  connLabel.textContent = state.label;
  const dot = connState.querySelector('.dot');
  if (dot) dot.className = `dot ${state.tone}`;
  connState.title = state.label;
}

class AuthError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'AuthError';
  }
}

function showAuth(message = ''): void {
  authOverlay.hidden = false;
  authError.textContent = message;
  authError.hidden = message.length === 0;
  authToken.focus();
}

function hideAuth(): void {
  authOverlay.hidden = true;
  authError.hidden = true;
  authError.textContent = '';
}

function handleUnauthorized(): AuthError {
  token = '';
  try {
    sessionStorage.removeItem('lodestar.admin.token');
    sessionStorage.removeItem('polaris.admin.token');
  } catch {
    // Storage may be unavailable; the in-memory token is already cleared.
  }
  showAuth(
    '管理密码不正确。请使用启动窗口打印的 Token：external 在 config/upstream.json 的 admin.token，源码 demo 在 data/demo/admin-token。',
  );
  return new AuthError();
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    throw handleUnauthorized();
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function apiText(path: string): Promise<string> {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    throw handleUnauthorized();
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

async function loadCore(renderView = true, animate = false): Promise<void> {
  if (!token) return;
  const [nextStatus, nextProtocol] = await Promise.all([
    api<StatusPayload>('/api/status'),
    api<ProtocolPayload>('/api/protocol'),
  ]);
  coreStatus = nextStatus;
  protocol = nextProtocol;
  updateConnectionState();
  if (renderView) {
    render(animate);
  } else if (route === 'overview') {
    render(false);
  }
}

function renderError(error: unknown): void {
  if (error instanceof AuthError) {
    // The auth overlay already explains the 401; keep the page behind it as-is.
    return;
  }
  console.error('Lodestar panel request failed', error);
  view.classList.remove('page-enter');
  view.innerHTML = `
    <div class="page-head"><div><h1>后端核心服务未连接</h1>
    <p>本地 Core API 暂时无响应。请确认核心进程仍在运行，然后重试。</p></div></div>
    <div class="card">
      <div class="row">
        <button class="btn btn-primary" id="retry">重试连接</button>
        <button class="btn" id="error-restart">尝试重启核心服务</button>
      </div>
    </div>`;
  document.getElementById('retry')?.addEventListener('click', () => {
    void loadCore(true, false).catch(renderError);
  });
  document.getElementById('error-restart')?.addEventListener('click', (event) => {
    void restartCore(event.currentTarget as HTMLButtonElement);
  });
}

function render(animate = false): void {
  route = routeFromHash();
  document.querySelectorAll<HTMLAnchorElement>('.nav a').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === route);
  });
  updateConnectionState();
  view.classList.toggle('page-enter', animate);

  if (!token) {
    view.innerHTML = `<div class="card"><div class="empty">输入本地管理 token 后加载面板。</div></div>`;
    return;
  }

  if (route === 'protocol') {
    renderProtocol();
  } else if (route === 'metrics') {
    void renderMetrics().catch(renderError);
  } else if (route === 'system') {
    renderSystem();
  } else {
    renderOverview();
  }
}

function renderOverview(): void {
  if (!coreStatus) {
    view.innerHTML = `<div class="card"><div class="empty">加载中…</div></div>`;
    return;
  }

  const s = coreStatus;
  const demoMode = isDemoStatus(s);
  const loaderOk = s.loader.dataPlane === 'healthy' || s.loader.process === 'ready';
  const onlineOk = s.health.state === 'ONLINE';
  const service = serviceState();
  const waitingFirstMessage =
    s.health.state === 'UNKNOWN' &&
    s.loader.loginState === 'LOGGED_IN' &&
    s.onebot.clientState === 'open';
  const showFirstRun = !onboardingDone();

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>总览</h1>
        <p>本地只读状态；面板不提供发送入口。</p>
      </div>
      <button class="btn" id="refresh">刷新</button>
    </div>
    ${
      demoMode
        ? `<div class="notice demo-notice"><strong>演示模式（Mock）</strong><span>内置 mock 后端，未连接真实 QQ/AstrBot；以下状态均为模拟数据。</span></div>`
        : ''
    }
    ${
      showFirstRun
        ? `<div class="notice onboarding-notice">
            <span>首次使用 Lodestar？</span>
            <button class="btn btn-ghost" id="onb-start" type="button">打开三步引导</button>
          </div>`
        : ''
    }
    <div class="grid">
      <section class="card span-12">
        <div class="service-state ${service.tone}"><span class="dot ${service.tone}"></span>${esc(service.label)}</div>
        <div class="muted small">${esc(serviceHint())}</div>
        ${
          service.tone !== 'ok' && !waitingFirstMessage && !demoMode
            ? `<div class="row service-actions">
                <button class="btn btn-primary" type="button" id="restart-core">尝试重启核心服务</button>
                <span class="muted small">只重启后端连接，不会关闭当前面板。</span>
              </div>`
            : ''
        }
      </section>
      <section class="card span-4">
        <h2>Loader / 上游${demoMode ? '（Mock）' : ''}</h2>
        <div class="metric"><span class="dot ${loaderOk ? 'ok' : 'bad'}"></span>${esc(s.loader.dataPlane)}</div>
        <div class="muted small">process ${esc(s.loader.process)} · login ${esc(s.loader.loginState)}</div>
        <div class="muted small">QQ ${esc(s.loader.qqBuild ?? 'unknown')}${demoMode ? '（模拟）' : ''}</div>
      </section>
      <section class="card span-4">
        <h2>OneBot 连接</h2>
        <div class="metric"><span class="dot ${s.onebot.clientState === 'open' ? 'ok' : 'warn'}"></span>${esc(s.onebot.clientState)}</div>
        <div class="muted small">${demoMode ? '内置 mock AstrBot' : 'AstrBot reverse WS'}</div>
      </section>
      <section class="card span-4">
        <h2>运行状态</h2>
        <div class="metric"><span class="dot ${onlineOk ? 'ok' : 'bad'}"></span>${esc(s.health.state)}</div>
        <div class="muted small">login ${esc(s.health.loginState)}</div>
      </section>
      <section class="card span-12">
        <h2>账号与队列</h2>
        <div class="muted small">账号 ${esc(s.account.idHash)} · pending ${s.pendingEvents} · replayable ${s.replayableEvents} · 服务器时间 ${esc(new Date(s.serverTime).toLocaleString())}</div>
      </section>
    </div>`;

  document.getElementById('refresh')?.addEventListener('click', () => {
    void loadCore(true, false).catch(renderError);
  });
  document.getElementById('restart-core')?.addEventListener('click', (event) => {
    void restartCore(event.currentTarget as HTMLButtonElement);
  });
  document.getElementById('onb-start')?.addEventListener('click', () => {
    showOnboarding(0);
  });
}

async function restartCore(button: HTMLButtonElement | null): Promise<void> {
  if (!button) return;
  const original = button.textContent;
  button.disabled = true;
  button.classList.add('is-loading');
  button.textContent = '正在重启核心服务…';
  try {
    const result = await api<RestartResponse>('/api/restart', { method: 'POST' });
    if (result.status) {
      coreStatus = result.status;
      updateConnectionState();
    }
    toast('核心服务已重启，正在重新连接');
    await loadCore(false).catch(() => {});
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(800);
      try {
        await loadCore(false);
      } catch {
        break;
      }
      if (serviceState().tone === 'ok') {
        toast('核心服务已重新连接');
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast(
      message.includes('smooth restart')
        ? '当前运行方式不支持平滑重启，请手动重启 Core 进程'
        : '重启失败，请检查 Core 日志后重试',
    );
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.textContent = original;
    }
  }
}

function renderProtocol(): void {
  if (!protocol) {
    view.innerHTML = `<div class="card"><div class="empty">加载中…</div></div>`;
    return;
  }
  const p = protocol;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>协议端配置</h1><p>面板、OneBot 上游和 AstrBot 反向连接的本地网络参数。</p></div>
    </div>
    ${protocolRestartRequired ? '<div class="notice">配置已保存。保存后会自动平滑重启 Core 连接；面板本身保持可用。</div>' : ''}
    <form id="protocol-form" class="card">
      <div class="form-grid">
        <label class="field"><span>面板 HTTP 端口</span><input id="panelPort" type="number" min="1024" max="65535" value="${p.panel.port}" /></label>
        <label class="field"><span>OneBot 上游 WS 端口</span><input id="onebotPort" type="number" min="1" max="65535" value="${p.onebot.port}" /></label>
        <label class="field"><span>OneBot Access Token</span><input id="onebotToken" type="password" autocomplete="off" placeholder="${p.onebot.tokenConfigured ? '已设置，留空不修改' : '未设置'}" /></label>
        <label class="field"><span>AstrBot 反向 WS 地址</span><input id="reverseUrl" value="${esc(p.reverse.url)}" placeholder="ws://127.0.0.1:6199/ws" /></label>
        <label class="field"><span>AstrBot Access Token</span><input id="reverseToken" type="password" autocomplete="off" placeholder="${p.reverse.tokenConfigured ? '已设置，留空不修改' : '未设置'}" /></label>
        <div class="field"><span>账号哈希</span><div class="muted" style="padding-top:8px"><code>${esc(p.selfIdHash)}</code></div></div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="protocol-save" type="submit">保存配置</button>
        <button class="btn" type="button" id="test-reverse">测试 AstrBot 连接</button>
      </div>
      <div id="test-result" class="muted small" style="margin-top:12px"></div>
      <p class="muted small" style="margin-top:12px">保存后会平滑重启 Core 的上游与反向 WS 连接，面板不会断线；面板端口变更仍需重启整个进程。</p>
    </form>`;

  (document.getElementById('protocol-form') as HTMLFormElement).addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void saveProtocol().catch(renderError);
    },
  );
  document.getElementById('test-reverse')?.addEventListener('click', () => {
    void testReverseConnection();
  });
}

async function saveProtocol(): Promise<void> {
  const read = (id: string): string =>
    (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
  const number = (id: string, fallback: number): number => {
    const value = Number(read(id));
    return Number.isFinite(value) ? value : fallback;
  };
  const previousPort = protocol?.panel.port;
  const body: Record<string, unknown> = {
    panelPort: number('panelPort', protocol?.panel.port ?? 18081),
    onebotPort: number('onebotPort', protocol?.onebot.port ?? 3001),
    reverseUrl: read('reverseUrl'),
  };
  const onebotToken = read('onebotToken');
  if (onebotToken) body.onebotToken = onebotToken;
  const reverseToken = read('reverseToken');
  if (reverseToken) body.reverseToken = reverseToken;

  const button = document.getElementById('protocol-save') as HTMLButtonElement | null;
  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
    button.textContent = '保存中…';
  }
  try {
    const result = await api<{
      ok: boolean;
      restartRequired: boolean;
      protocol: ProtocolPayload;
    }>('/api/protocol', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    protocol = result.protocol;
    protocolRestartRequired = result.restartRequired;
    const panelPortChanged =
      previousPort !== undefined && result.protocol.panel.port !== previousPort;
    renderProtocol();
    await smoothRestart({ panelPortChanged });
  } catch (error) {
    console.error('protocol save failed', error);
    toast('配置未保存，请检查端口范围和 WebSocket 地址格式');
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.textContent = '保存配置';
    }
  }
}

function updateReconnectModal(progress: number, status: string, detail?: string): void {
  const bar = document.getElementById('reconnect-progress');
  const statusEl = document.getElementById('reconnect-status');
  const detailEl = document.getElementById('reconnect-detail');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  if (statusEl) statusEl.textContent = status;
  if (detailEl && detail !== undefined) detailEl.textContent = detail;
}

function closeReconnectModal(): void {
  modalRoot.innerHTML = '';
  void loadCore(true, false).catch(renderError);
}

function showReconnectModal(): void {
  modalRoot.innerHTML = `
    <div class="overlay">
      <div class="modal reconnect-modal">
        <h2>正在平滑重启核心服务</h2>
        <p id="reconnect-status">正在应用协议端配置…</p>
        <div class="progress reconnect-progress"><span id="reconnect-progress" style="width:10%"></span></div>
        <p class="muted small" id="reconnect-detail">面板保持可用，不需要刷新页面。</p>
        <div class="modal-actions">
          <button class="btn" type="button" id="reconnect-close">关闭</button>
        </div>
      </div>
    </div>`;
  document.getElementById('reconnect-close')?.addEventListener('click', closeReconnectModal);
}

async function smoothRestart(options: SmoothRestartOptions): Promise<void> {
  showReconnectModal();
  updateReconnectModal(18, '正在平滑重启 Core 连接…', '面板不会断线，旧连接会在新连接就绪后释放。');
  try {
    const result = await api<RestartResponse>('/api/restart', { method: 'POST' });
    if (result.status) {
      coreStatus = result.status;
      updateConnectionState();
    }
    updateReconnectModal(
      62,
      '核心已重启，正在等待上游重新连接…',
      '正在后台检查 OneBot 与 AstrBot 的连接状态。',
    );
    await loadCore(false).catch(() => {});

    if (options.panelPortChanged) {
      protocolRestartRequired = true;
      updateReconnectModal(
        100,
        '连接参数已生效；面板端口变更需重启整个进程。',
        '当前页面仍运行在旧端口，关闭窗口后请手动重启 Core 以切换面板端口。',
      );
      toast('连接参数已生效；面板端口需手动重启后生效');
      return;
    }

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await sleep(800);
      updateReconnectModal(
        Math.min(94, 62 + attempt * 2),
        '正在等待核心服务重新连接…',
        `第 ${attempt + 1} 次检查连接状态`,
      );
      try {
        await loadCore(false);
      } catch {
        updateReconnectModal(70, '核心服务正在重启，面板会在恢复后自动继续…');
        continue;
      }
      if (serviceState().tone === 'ok') {
        protocolRestartRequired = false;
        updateReconnectModal(100, '核心服务已重新连接，配置已生效。');
        toast('协议端配置已生效，核心服务已重新连接');
        await sleep(500);
        closeReconnectModal();
        return;
      }
    }

    updateReconnectModal(
      100,
      '核心已重启，但上游仍未连接。',
      '请检查 QQ、loader 和 AstrBot 是否已启动；面板仍然可用。',
    );
    toast('核心已重启，但上游仍未连接');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('smooth restart failed', error);
    updateReconnectModal(
      100,
      '平滑重启失败',
      message.includes('smooth restart')
        ? '当前运行方式不支持平滑重启，请手动重启 Core 进程。'
        : '请检查 Core 日志后重试。面板仍然可用。',
    );
    toast('平滑重启失败，请检查 Core 日志');
  }
}

async function testReverseConnection(): Promise<void> {
  const url = (document.getElementById('reverseUrl') as HTMLInputElement).value.trim();
  const token = (document.getElementById('reverseToken') as HTMLInputElement).value.trim();
  const resultEl = document.getElementById('test-result');
  const button = document.getElementById('test-reverse') as HTMLButtonElement;
  if (!resultEl) return;

  resultEl.textContent = '连接测试中…';
  button.disabled = true;
  try {
    const result = await api<{
      ok: boolean;
      status?: number;
      message?: string;
      latencyMs?: number;
    }>('/api/protocol/test', {
      method: 'POST',
      body: JSON.stringify({
        target: 'reverse',
        url,
        ...(token ? { token } : {}),
      }),
    });
    resultEl.textContent = result.ok
      ? `连接成功（${result.latencyMs ?? 0}ms）`
      : `连接失败：${connectionFailureHint(result.status, result.message)}`;
    resultEl.className = `small ${result.ok ? 'tag ok' : 'tag bad'}`;
  } catch (error) {
    resultEl.textContent = `测试失败：${error instanceof Error ? error.message : String(error)}`;
    resultEl.className = 'small tag bad';
  } finally {
    button.disabled = false;
  }
}

function renderSystem(): void {
  view.innerHTML = `
    <div class="page-head"><div><h1>系统</h1><p>管理密码与 Core 生命周期；不提供发送入口。</p></div></div>
    <form id="admin-password-form" class="card">
      <h2>管理密码</h2>
      <p class="muted small">更新后当前会话立即使用新密码；新密码至少 12 位。</p>
      <div class="form-grid">
        <label class="field"><span>新密码</span><input id="admin-password" type="password" autocomplete="new-password" minlength="12" required /></label>
        <label class="field"><span>确认新密码</span><input id="admin-password-confirm" type="password" autocomplete="new-password" minlength="12" required /></label>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">更新管理密码</button>
      </div>
      <p class="muted small" style="margin-top:12px">若启动时设置了 <code>LODESTAR_ADMIN_TOKEN</code> / <code>POLARIS_ADMIN_TOKEN</code>，环境变量会在重启后覆盖这里保存的值。</p>
    </form>
    <section class="card danger-zone">
      <h2>终止 Core 进程</h2>
      <p class="muted small">只停止当前 Core 和面板；QQ、loader 与 AstrBot 不会被停止。需要输入 <code>TERMINATE</code> 确认。</p>
      <button class="btn btn-danger" type="button" id="terminate-core">终止 Core 进程</button>
    </section>`;

  (document.getElementById('admin-password-form') as HTMLFormElement).addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void saveAdminPassword();
    },
  );
  document.getElementById('terminate-core')?.addEventListener('click', () => {
    confirmPhrase(
      '终止 Core 进程',
      '当前面板会立即断开；QQ、loader 和 AstrBot 不受影响。',
      'TERMINATE',
      '终止 Core',
      async () => {
        await api('/api/shutdown', {
          method: 'POST',
          body: JSON.stringify({ confirm: 'TERMINATE' }),
        });
        showTerminated();
      },
    );
  });
}

async function saveAdminPassword(): Promise<void> {
  const next = (document.getElementById('admin-password') as HTMLInputElement).value;
  const confirmation = (document.getElementById('admin-password-confirm') as HTMLInputElement)
    .value;
  if (next.length < 12) {
    toast('管理密码至少需要 12 位');
    return;
  }
  if (next !== confirmation) {
    toast('两次输入的管理密码不一致');
    return;
  }

  const button = document.querySelector<HTMLButtonElement>(
    '#admin-password-form button[type="submit"]',
  );
  if (button) {
    button.disabled = true;
    button.textContent = '更新中…';
  }
  try {
    const result = await api<{ ok: boolean; envOverride: boolean }>('/api/admin/password', {
      method: 'PUT',
      body: JSON.stringify({ newPassword: next, confirm: 'CHANGE' }),
    });
    token = next;
    try {
      sessionStorage.setItem('lodestar.admin.token', token);
    } catch {
      // Keep the token in memory only.
    }
    toast(result.envOverride ? '管理密码已更新；环境变量仍会在重启后覆盖' : '管理密码已更新');
    (document.getElementById('admin-password') as HTMLInputElement).value = '';
    (document.getElementById('admin-password-confirm') as HTMLInputElement).value = '';
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = '更新管理密码';
    }
  }
}

function showTerminated(): void {
  document.body.innerHTML = `
    <main class="terminated">
      <h1>Core 已终止</h1>
      <p>面板连接已经关闭。QQ、loader 和 AstrBot 仍在运行。</p>
      <p class="muted small">可以关闭此页面，或重新启动 Core 后再打开面板。</p>
    </main>`;
}

async function renderMetrics(): Promise<void> {
  metricsRevealPending = true;
  view.innerHTML = `
    <div class="page-head"><div><h1>指标</h1><p>运行状态与队列；数据来自 /api/metrics。</p></div>
    <button class="btn" id="metrics-refresh">刷新</button></div>
    <div class="card">
      <div class="row" id="metrics-summary"></div>
      <details style="margin-top:14px"><summary class="muted small">原始指标文本</summary><pre id="metrics-raw" class="small" style="white-space:pre-wrap"></pre></details>
    </div>`;
  document.getElementById('metrics-refresh')?.addEventListener('click', () => {
    metricsRevealPending = true;
    void refreshMetrics().catch(renderError);
  });
  await refreshMetrics();
}

async function refreshMetrics(): Promise<void> {
  const text = await apiText('/api/metrics');
  const state = /polaris_health_state\{state="([A-Z]+)"\}\s+1/.exec(text)?.[1] ?? 'UNKNOWN';
  const ready = matchNumber(text, 'polaris_ready');
  const clientUp = matchNumber(text, 'polaris_client_up');
  const pending = matchNumber(text, 'polaris_pending_events');
  const replayable = matchNumber(text, 'polaris_replayable_events');
  const summary = document.getElementById('metrics-summary');
  if (summary) {
    summary.innerHTML = `
      <span class="tag ${state === 'ONLINE' ? 'ok' : state === 'OFFLINE' ? 'bad' : 'warn'}">health ${esc(state)}</span>
      <span class="tag ${ready ? 'ok' : 'bad'}">ready ${ready ? 'yes' : 'no'}</span>
      <span class="tag ${clientUp ? 'ok' : 'warn'}">onebot ${clientUp ? 'up' : 'down'}</span>
      <span class="muted small">pending ${pending} · replayable ${replayable}</span>`;
    summary.className = metricsRevealPending ? 'row data-reveal' : 'row';
  }
  const raw = document.getElementById('metrics-raw');
  if (raw) raw.textContent = text;
  metricsRevealPending = false;
}

function matchNumber(text: string, name: string): number {
  const match = new RegExp(`${name}\\s+([0-9.]+)`).exec(text);
  return Number(match?.[1] ?? 0);
}

function confirmPhrase(
  title: string,
  description: string,
  phrase: string,
  confirmLabel: string,
  onConfirm: () => Promise<void>,
): void {
  modalRoot.innerHTML = `
    <div class="overlay">
      <form class="modal" id="confirm-form">
        <h2>${esc(title)}</h2>
        <p>${esc(description)}</p>
        <label class="field"><span>输入 <code>${esc(phrase)}</code> 确认</span><input id="confirm-input" autocomplete="off" /></label>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" id="confirm-cancel">取消</button>
          <button class="btn btn-danger" type="submit" id="confirm-ok" disabled>${esc(confirmLabel)}</button>
        </div>
      </form>
    </div>`;
  const input = document.getElementById('confirm-input') as HTMLInputElement;
  const ok = document.getElementById('confirm-ok') as HTMLButtonElement;
  input.focus();
  input.addEventListener('input', () => {
    ok.disabled = input.value !== phrase;
  });
  document.getElementById('confirm-cancel')?.addEventListener('click', () => {
    modalRoot.innerHTML = '';
  });
  (document.getElementById('confirm-form') as HTMLFormElement).addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      if (input.value !== phrase) return;
      void onConfirm()
        .then(() => {
          modalRoot.innerHTML = '';
        })
        .catch((error: unknown) => {
          toast(error instanceof Error ? error.message : String(error));
        });
    },
  );
}

function onboardingDone(): boolean {
  try {
    return (
      localStorage.getItem('lodestar.onboarding.done') === '1' ||
      localStorage.getItem('polaris.onboarding.done') === '1'
    );
  } catch {
    return false;
  }
}

function markOnboardingDone(): void {
  try {
    localStorage.setItem('lodestar.onboarding.done', '1');
  } catch {
    // Non-persistent fallback: close this time.
  }
  modalRoot.innerHTML = '';
}

function showOnboarding(step = 0): void {
  const steps = ['本地配置', '账号登录', '连接大脑'];
  const loader = coreStatus?.loader;
  const demo = isDemoStatus(coreStatus);
  const loaderHint = !loader
    ? '等待 loader'
    : loader.dataPlane === 'healthy'
      ? '数据面正常'
      : loader.process === 'ready'
        ? 'Loader 进程已启动，等待消息面'
        : '未检测到 loader';
  const reverseUrl = protocol?.reverse.url ?? 'ws://127.0.0.1:6199/ws';
  const stepContent =
    step === 0
      ? `<p>面板已经运行在本地 <code>127.0.0.1:${esc(protocol?.panel.port ?? 18081)}</code>，token 已加载。需要调整端口或 token 时，去“协议端配置”。</p>
         <dl class="kv"><dt>面板端口</dt><dd>${esc(protocol?.panel.port ?? 18081)}</dd><dt>Token</dt><dd>已加载（sessionStorage）</dd></dl>`
      : step === 1
        ? `${demo ? '<p class="notice demo-notice"><strong>演示模式（Mock）</strong>下面的登录态来自内置 mock，不代表真实 QQ 已登录。</p>' : ''}
           <p>启动官方 QQ 并用测试号登录，loader 才会附着。当前状态：</p>
           <dl class="kv"><dt>Loader</dt><dd>${esc(loader?.process ?? 'unknown')} / ${esc(loader?.dataPlane ?? 'unknown')}</dd><dt>登录态</dt><dd>${esc(loader?.loginState ?? 'UNKNOWN')}</dd><dt>提示</dt><dd>${esc(loaderHint)}</dd></dl>
           <p class="muted small">面板不会代替你启动 QQ；登录后再点“重新检测”。</p>`
        : `<p>在 AstrBot 中新建 OneBot v11 适配器，反向 WS 地址填：</p>
           <p><code id="onb-reverse-url">${esc(reverseUrl)}</code></p>
           <p class="muted small">Token 在“协议端配置”里设置；保存后面板会自动平滑重启 Core 连接。</p>
           <button class="btn" type="button" id="onb-copy">复制地址</button>`;

  modalRoot.innerHTML = `
    <div class="overlay">
      <div class="modal">
        <button class="modal-close" type="button" id="onb-close" aria-label="关闭">×</button>
        <h2>三步初始化</h2>
        <div class="wizard-steps">
          ${steps
            .map(
              (label, index) =>
                `<div class="wizard-step ${index < step ? 'done' : index === step ? 'active' : ''}">${index + 1}. ${esc(label)}</div>`,
            )
            .join('')}
        </div>
        <div id="onb-content">${stepContent}</div>
        <div class="wizard-actions">
          <div class="row">
            ${step > 0 ? '<button class="btn" type="button" id="onb-prev">上一步</button>' : ''}
            ${step === 1 ? '<button class="btn" type="button" id="onb-retry">重新检测</button>' : ''}
            <button class="btn btn-ghost" type="button" id="onb-skip">跳过</button>
          </div>
          <button class="btn btn-primary" type="button" id="onb-next">${step === 2 ? '完成' : '下一步'}</button>
        </div>
      </div>
    </div>`;

  document.getElementById('onb-next')?.addEventListener('click', () => {
    if (step === 2) {
      markOnboardingDone();
      toast('初始化向导已完成');
    } else {
      showOnboarding(step + 1);
    }
  });
  document.getElementById('onb-prev')?.addEventListener('click', () => {
    showOnboarding(Math.max(0, step - 1));
  });
  document.getElementById('onb-skip')?.addEventListener('click', () => {
    markOnboardingDone();
  });
  document.getElementById('onb-close')?.addEventListener('click', () => {
    markOnboardingDone();
  });
  document.getElementById('onb-retry')?.addEventListener('click', () => {
    void loadCore(false)
      .then(() => showOnboarding(1))
      .catch(renderError);
  });
  document.getElementById('onb-copy')?.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(reverseUrl)
      .then(() => toast('反向 WS 地址已复制'))
      .catch(() => toast('复制失败，请手动选择地址'));
  });
}

document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('.btn');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  button.classList.remove('is-rippling');
  void button.offsetWidth;
  button.classList.add('is-rippling');
  window.setTimeout(() => button.classList.remove('is-rippling'), 520);
});

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  token = authToken.value.trim();
  if (!token) return;
  try {
    sessionStorage.setItem('lodestar.admin.token', token);
  } catch {
    // Keep the token in memory only.
  }
  hideAuth();
  updateConnectionState();
  void loadCore(true, true).catch(renderError);
});

onboardingOpen.addEventListener('click', () => {
  showOnboarding(0);
});

window.addEventListener('hashchange', () => {
  render(true);
});

updateConnectionState();
if (token) {
  hideAuth();
  void loadCore(true, true).catch(renderError);
} else {
  showAuth();
}
render(false);
window.setInterval(() => {
  if (!token || document.visibilityState !== 'visible') return;
  void loadCore(false).catch(() => {});
  if (route === 'metrics') void refreshMetrics().catch(() => {});
}, 5000);
