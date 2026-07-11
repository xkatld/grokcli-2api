const THEME_KEY = "g2a_theme";
let current_theme = localStorage.getItem(THEME_KEY) || "dark";
document.documentElement.setAttribute("data-theme", current_theme);
const TOKEN_KEY = "g2a_admin_token";
const REG_CONFIG_KEY = "g2a_register_config";
let token = localStorage.getItem(TOKEN_KEY) || "";
let status_cache = null;
let dash_cache = null;
let login_session_id = null;
let device_poll_timer = null;
let reg_session_id = null;
let reg_session_ids = [];
let reg_poll_timer = null;
const PAGE_META = {
  overview: { title: "概览", sub: "服务状态、账号池与 Token 健康度一览" },
  keys: { title: "API Keys", sub: "创建、复制、停用客户端访问密钥" },
  accounts: { title: "账号 / 轮询", sub: "Grok 账号、设备码登录、额度与导入导出" },
  models: { title: "模型", sub: "上游模型缓存与探测结果" },
  guide: { title: "接入指南", sub: "OpenAI / Anthropic 客户端配置示例" },
  settings: { title: "系统设置", sub: "管理与修改 SQLite 数据库中的动态参数" },
};

function $(id) { return document.getElementById(id); }
function toast(msg, ok = true) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show " + (ok ? "ok" : "err");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 4200);
}
function fmt_time(ts) {
  if (!ts) return "—";
  try { return new Date(ts * 1000).toLocaleString(); } catch { return String(ts); }
}
function fmt_remaining(ts) {
  if (!ts) return "—";
  const sec = Math.floor(Number(ts) - Date.now() / 1000);
  if (Number.isNaN(sec)) return "—";
  if (sec <= 0) return "已过期";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 48) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}
function remaining_class(ts) {
  if (!ts) return "";
  const sec = Number(ts) - Date.now() / 1000;
  if (sec <= 0) return "bad";
  if (sec < 15 * 60) return "warn";
  return "ok";
}
function headers(json = true) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (token) h["X-Admin-Token"] = token;
  return h;
}
async function api(path, opts = {}) {
  const res = await fetch("/admin/api" + path, {
    ...opts,
    headers: { ...headers(!(opts.body instanceof FormData) && opts.method !== "GET"), ...(opts.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.error || data.message)) || res.statusText;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
async function copy_text(text) {
  const t = String(text ?? "");
  if (!t) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, t.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function show_boot(msg, hint) {
  $("boot-view").classList.remove("hidden");
  $("auth-view").classList.add("hidden");
  $("main-view").classList.add("hidden");
  if (msg) $("boot-desc").textContent = msg;
  if (hint) $("boot-hint").innerHTML = hint;
}
function show_auth(setup) {
  $("boot-view").classList.add("hidden");
  $("auth-view").classList.remove("hidden");
  $("main-view").classList.add("hidden");
  $("auth-title").textContent = setup ? "初始化管理密码" : "登录管理台";
  $("auth-desc").textContent = setup
    ? "首次使用，请设置管理员密码（至少 4 位）"
    : "使用管理员密码进入";
  $("auth-submit").textContent = setup ? "创建并进入" : "进入";
}
function show_main() {
  $("boot-view").classList.add("hidden");
  $("auth-view").classList.add("hidden");
  $("main-view").classList.remove("hidden");
  start_auto_ui_refresh();
}

function switch_tab(name) {
  const meta = PAGE_META[name] || PAGE_META.overview;
  document.querySelectorAll(".nav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  const panel = $("panel-" + name);
  if (panel) panel.classList.add("active");
  $("page-title").textContent = meta.title;
  $("page-sub").textContent = meta.sub;
  if (name === "settings") {
    load_settings();
  }
}

function build_mobile_nav() {
  const host = $("mobile-nav");
  if (!host) return;
  host.innerHTML = Object.keys(PAGE_META).map(k => {
    const label = PAGE_META[k].title;
    return `<button class="nav-btn ${k === "overview" ? "active" : ""}" data-tab="${k}">${label}</button>`;
  }).join("");
  host.querySelectorAll(".nav-btn").forEach(btn => {
    btn.onclick = () => switch_tab(btn.dataset.tab);
  });
}

function current_origin() {
  try {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return location.origin;
    }
  } catch (_) {}
  return "";
}

function current_admin_url() {
  const origin = current_origin();
  if (origin) return origin.replace(/\/$/, "") + "/admin";
  const port = location.port || "3000";
  return `http://<your-host>:${port}/admin`;
}

async function bootstrap() {
  if (location.protocol === "file:") {
    show_boot(
      "请通过服务打开管理台",
      '不要直接双击 HTML。请运行 ./start.sh 或 python app.py，然后在浏览器打开服务的 /admin 地址（公网部署请用你的域名或公网 IP）。'
    );
    toast("检测到 file:// 打开，无法连接 API", false);
    return;
  }

  show_boot("正在连接服务…");
  try {
    status_cache = await api("/status");
  } catch (e) {
    show_boot(
      "无法连接 grokcli-2api 服务",
      `请先启动服务：./start.sh 或 python app.py，再打开 ${esc(current_admin_url())}。<br><br>错误：${esc(e.message)}`
    );
    toast("无法连接服务: " + e.message, false);
    return;
  }
  if (status_cache.setup_needed) {
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    show_auth(true);
    return;
  }
  if (!token) {
    show_auth(false);
    return;
  }
  try {
    await load_dashboard();
    show_main();
  } catch (e) {
    if (e.status === 401) {
      token = "";
      localStorage.removeItem(TOKEN_KEY);
      show_auth(false);
      toast("会话已失效，请重新登录", false);
    } else {
      toast(e.message, false);
      show_auth(false);
    }
  }
}

async function load_dashboard() {
  dash_cache = await api("/dashboard");
  render_stats();
  render_keys();
  render_accounts();
  render_models();
  render_model_health_info();
  render_guide();
  render_maintainer();
  const mode = dash_cache.account_mode || "round_robin";
  if ($("account-mode")) $("account-mode").value = mode;
}

function render_stats() {
  const s = status_cache || {};
  const d = dash_cache || {};
  const pool = d.pool || s.pool || {};
  const cred_ok = !(d.credentials && d.credentials.error) && (s.credentials_ok || (pool.live > 0));
  const pill = $("status-pill");
  if (cred_ok) {
    pill.className = "pill ok";
    pill.textContent = "● 已登录 " + (s.credentials_email || "") + " · " + (d.account_mode || s.account_mode || "");
  } else {
    pill.className = "pill bad";
    pill.textContent = "● 未登录 / 凭证异常";
  }
  const keys = d.keys || s.keys || {};
  const acc = d.accounts || s.accounts || {};
  const tm = d.token_maintainer || s.token_maintainer || {};
  const rem = tm.min_remaining_sec;
  const rem_label = rem == null ? "—" : fmt_remaining(Date.now() / 1000 + rem);
  $("stats-grid").innerHTML = `
    <div class="stat"><div class="label">API Base</div><div class="value mono">${esc(d.api_base || s.api_base || "")}</div></div>
    <div class="stat"><div class="label">CLI 版本</div><div class="value mono">${esc(d.cli_version || s.cli_version || "")}</div>
      <div class="sub">上游 ${esc(d.upstream || s.upstream || "")}</div></div>
    <div class="stat"><div class="label">账号池</div><div class="value">${pool.enabled ?? acc.active_count ?? 0} 启用 / ${pool.live ?? acc.active_count ?? 0} 有效</div>
      <div class="sub">模式 ${esc(d.account_mode || s.account_mode || "—")} · 冷却 ${pool.in_cooldown ?? 0} · 额度禁用 ${pool.quota_disabled ?? 0}</div></div>
    <div class="stat"><div class="label">API Keys</div><div class="value">${keys.enabled ?? 0} 启用 / ${keys.total ?? 0}</div>
      <div class="sub">请求累计 ${keys.total_requests ?? 0} · 鉴权 ${keys.auth_required ? "开启" : "关闭"}</div></div>
    <div class="stat"><div class="label">Token 自动续期</div><div class="value">${tm.running ? "运行中" : (tm.enabled === false ? "已关闭" : "未运行")}</div>
      <div class="sub">最短剩余 ${esc(rem_label)} · 周期 ${tm.next_wait_sec ?? tm.interval_sec ?? "—"}s</div></div>
  `;
}

function render_maintainer() {
  const d = dash_cache || {};
  const s = status_cache || {};
  const tm = d.token_maintainer || s.token_maintainer || {};
  const pill = $("maintainer-pill");
  const info = $("maintainer-info");
  if (!pill || !info) return;
  if (tm.running) {
    pill.className = "pill ok";
    pill.textContent = "● 自动续期运行中";
  } else if (tm.enabled === false) {
    pill.className = "pill warn";
    pill.textContent = "● 已禁用";
  } else {
    pill.className = "pill bad";
    pill.textContent = "● 未运行";
  }
  const last = tm.last || {};
  const refreshed = (last.refresh && last.refresh.refreshed) ?? "—";
  const rem = tm.min_remaining_sec;
  info.textContent = [
    `最短剩余: ${rem == null ? "—" : fmt_remaining(Date.now() / 1000 + rem)}`,
    `下次检查约 ${tm.next_wait_sec ?? tm.interval_sec ?? "—"}s`,
    `上次刷新 ${refreshed} 个`,
    last.at ? `于 ${fmt_time(last.at)}` : null,
  ].filter(Boolean).join(" · ");
}

let keys_cache = {};
function render_keys() {
  api("/keys").then(data => {
    const tbody = $("keys-tbody");
    const keys = data.keys || [];
    keys_cache = {};
    keys.forEach(k => { keys_cache[k.id] = k; });
    if (!keys.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted">暂无 Key。创建后客户端访问 /v1 将需要鉴权。</td></tr>`;
      return;
    }
    tbody.innerHTML = keys.map(k => {
      const can_copy = !!(k.secret || k.key);
      return `
      <tr>
        <td>${esc(k.name)}<div class="muted" style="font-size:0.75rem">${esc(k.note || "")}</div></td>
        <td class="mono" title="${can_copy ? "点击复制完整 Key" : "缺少完整 Key，需重新生成"}">${esc(k.prefix)}…</td>
        <td>${k.enabled ? '<span class="pill ok">启用</span>' : '<span class="pill bad">停用</span>'}</td>
        <td>${k.request_count || 0}</td>
        <td class="muted">${fmt_time(k.created_at)}</td>
        <td class="actions">
          <button class="btn sm primary" data-act="copy" data-id="${esc(k.id)}">${can_copy ? "复制" : "重建复制"}</button>
          <button class="btn sm" data-act="toggle" data-id="${esc(k.id)}" data-on="${k.enabled ? 0 : 1}">${k.enabled ? "停用" : "启用"}</button>
          <button class="btn sm danger" data-act="del" data-id="${esc(k.id)}">删除</button>
        </td>
      </tr>`;
    }).join("");
  }).catch(e => toast(e.message, false));
}

function fmt_quota_cell(p, live_quota) {
  const q = live_quota || p.last_quota || null;
  const pool_disabled = p.enabled === false || p.disabled_for_quota || !!(live_quota && live_quota.pool_disabled);
  if (!q) {
    return `<span class="muted">未查询</span>
      <div style="margin-top:4px"><button class="btn sm" data-act="quota-one" data-id="${esc(p.id || "")}">查询</button></div>`;
  }
  if (q.error && !q.summary) {
    return `<span class="pill bad">查询失败</span><div class="muted" style="font-size:0.72rem;margin-top:4px">${esc(q.error)}</div>`;
  }
  const exhausted = q.exhausted || p.disabled_for_quota;
  const summary = (q.display && q.display.summary) || q.summary || "—";
  let pill;
  if (exhausted) pill = '<span class="pill bad">额度耗尽</span>';
  else if (pool_disabled) pill = '<span class="pill warn">禁用·不计入汇总</span>';
  else if (q.unlimited_or_free) pill = '<span class="pill ok">免费/促销</span>';
  else pill = '<span class="pill ok">有额度</span>';
  const detail = exhausted && p.disabled_reason
    ? `<div class="muted" style="font-size:0.72rem;margin-top:4px">${esc(p.disabled_reason)}</div>`
    : `<div class="muted" style="font-size:0.72rem;margin-top:4px">${esc(summary)}</div>`;
  return `${pill}${detail}`;
}

let quota_cache = {};
let accounts_list = [];
let accounts_page = 1;
let accounts_page_size = 25;
let accounts_search_query = "";
let selected_account_ids = new Set();

function get_filtered_accounts() {
  const q = (accounts_search_query || "").trim().toLowerCase();
  if (!q) return accounts_list.slice();
  return accounts_list.filter(a => {
    const p = a._pool || {};
    const hay = [
      a.email || "",
      a.id || "",
      a.user_id || "",
      a.expired ? "expired" : "valid",
      p.enabled === false ? "disabled" : "enabled",
      p.in_cooldown ? "cooldown" : "",
      p.disabled_for_quota ? "quota" : "",
      p.last_error || "",
      (p.blocked_model_ids || []).join(" "),
    ].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function update_account_selection_info(filtered_count, page_count) {
  const el = $("acc-selection-info");
  if (!el) return;
  const selected = selected_account_ids.size;
  const q = (accounts_search_query || "").trim();
  el.textContent = q
    ? `已选 ${selected} 个 · 筛选 ${filtered_count} / 全部 ${accounts_list.length} · 本页 ${page_count}`
    : `已选 ${selected} 个 · 全部 ${accounts_list.length} · 本页 ${page_count}`;
  const page_check = $("acc-check-page");
  if (page_check) {
    const page_ids = Array.from(document.querySelectorAll(".acc-check-one")).map(x => x.dataset.id);
    const selected_on_page = page_ids.filter(id => selected_account_ids.has(id)).length;
    page_check.checked = page_ids.length > 0 && selected_on_page === page_ids.length;
    page_check.indeterminate = selected_on_page > 0 && selected_on_page < page_ids.length;
  }
}

function render_accounts_page() {
  const list = get_filtered_accounts();
  const page_size = accounts_page_size;
  const total_pages = Math.max(1, Math.ceil(list.length / page_size) || 1);
  accounts_page = Math.max(1, Math.min(accounts_page, total_pages));
  const start = (accounts_page - 1) * page_size;
  const page_items = list.slice(start, start + page_size);
  const valid_ids = new Set(accounts_list.map(a => a.id));
  selected_account_ids = new Set(Array.from(selected_account_ids).filter(id => valid_ids.has(id)));
  $("accounts-empty").classList.toggle("hidden", accounts_list.length > 0);
  const tbody = $("accounts-tbody");
  tbody.innerHTML = page_items.map(a => {
    const p = a._pool || { id: a.id };
    const enabled = p.enabled !== false;
    const cooling = p.in_cooldown;
    const quota_off = p.disabled_for_quota;
    let pool_label;
    if (quota_off) pool_label = '<span class="pill bad">额度禁用</span>';
    else if (!enabled) pool_label = '<span class="pill bad">已禁用</span>';
    else if (cooling) pool_label = '<span class="pill warn">冷却中</span>';
    else pool_label = '<span class="pill ok">轮询中</span>';
    const usage = `${p.success_count || 0}√ / ${p.fail_count || 0}× · 共 ${p.request_count || 0}`;
    const refresh_pill = a.has_refresh_token
      ? '<span class="pill ok" title="可自动 refresh">可自动续期</span>'
      : '<span class="pill warn">无 refresh</span>';
    const live_q = quota_cache[a.id];
    const rem_cls = remaining_class(a.expires_at);
    const rem_pill = rem_cls
      ? `<span class="pill ${rem_cls}">剩余 ${esc(fmt_remaining(a.expires_at))}</span>`
      : '<span class="muted">—</span>';
    const probe_cell = fmt_probe_cell(p.last_probe, p.last_error, p.blocked_model_ids);
    const checked = selected_account_ids.has(a.id) ? "checked" : "";
    return `
    <tr>
      <td><input type="checkbox" class="acc-check-one" data-id="${esc(a.id)}" ${checked} /></td>
      <td>${esc(a.email || "—")}<div class="muted mono" style="font-size:0.72rem">${esc(a.id)}</div></td>
      <td>${a.expired ? '<span class="pill bad">已过期</span>' : '<span class="pill ok">有效</span>'}</td>
      <td>${pool_label}</td>
      <td class="muted" style="font-size:0.8rem">${usage}</td>
      <td style="font-size:0.82rem;min-width:140px">${fmt_quota_cell({ ...p, id: a.id }, live_q)}</td>
      <td style="font-size:0.78rem;min-width:160px">${probe_cell}</td>
      <td class="muted" style="font-size:0.8rem">
        ${fmt_time(a.expires_at)}
        <div style="margin-top:4px">${rem_pill} ${refresh_pill}</div>
      </td>
      <td class="actions">
        <button class="btn sm" data-act="renew-one" data-id="${esc(a.id)}" ${a.has_refresh_token ? "" : "disabled"}>续期</button>
        <button class="btn sm" data-act="probe-one" data-id="${esc(a.id)}">模型测试</button>
        <button class="btn sm" data-act="quota-one" data-id="${esc(a.id)}">额度</button>
        <button class="btn sm" data-act="toggle-acc" data-id="${esc(a.id)}" data-on="${enabled ? 0 : 1}">${enabled ? "禁用" : "启用"}</button>
        <button class="btn sm danger" data-act="rm-acc" data-id="${esc(a.id)}">移除</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" class="muted">${accounts_list.length ? "无匹配账号" : "无账号"}</td></tr>`;
  $("acc-page-info").textContent = `${accounts_page} / ${total_pages} (显示 ${list.length} / 共 ${accounts_list.length} 个)`;
  $("acc-page-prev").disabled = accounts_page <= 1;
  $("acc-page-next").disabled = accounts_page >= total_pages;
  update_account_selection_info(list.length, page_items.length);
}

function render_accounts() {
  api("/accounts").then(data => {
    const pool = data.pool || {};
    const pool_map = {};
    (pool.accounts || []).forEach(a => { pool_map[a.id] = a; });
    accounts_list = (data.accounts || []).map(a => ({ ...a, _pool: pool_map[a.id] || { id: a.id } }));
    render_accounts_page();
  }).catch(e => toast(e.message, false));
}

function apply_account_search(reset_page = true) {
  accounts_search_query = $("acc-search") ? $("acc-search").value.trim() : "";
  if (reset_page) accounts_page = 1;
  render_accounts_page();
}

function set_page_selection(checked) {
  document.querySelectorAll(".acc-check-one").forEach(el => {
    const id = el.dataset.id;
    if (!id) return;
    el.checked = !!checked;
    if (checked) selected_account_ids.add(id);
    else selected_account_ids.delete(id);
  });
  update_account_selection_info(get_filtered_accounts().length, document.querySelectorAll(".acc-check-one").length);
}

function set_filtered_selection(checked) {
  const list = get_filtered_accounts();
  list.forEach(a => {
    if (!a.id) return;
    if (checked) selected_account_ids.add(a.id);
    else selected_account_ids.delete(a.id);
  });
  render_accounts_page();
}

async function delete_selected_accounts() {
  const ids = Array.from(selected_account_ids);
  if (!ids.length) {
    toast("请先勾选要删除的账号", false);
    return;
  }
  if (!confirm(`确定删除选中的 ${ids.length} 个账号？`)) return;
  try {
    const r = await api("/accounts/delete-batch", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    selected_account_ids.clear();
    toast(`已删除 ${r.removed_count || 0} 个` + (r.missing_count ? `，未找到 ${r.missing_count}` : ""));
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) {
    toast(e.message, false);
  }
}

async function renew_accounts(ids, { confirm_many = true } = {}) {
  const list = Array.from(new Set((ids || []).map(x => String(x || "").trim()).filter(Boolean)));
  if (!list.length) {
    toast("请先选择要续期的账号", false);
    return;
  }
  if (confirm_many && list.length > 1) {
    if (!confirm(`确认续期选中的 ${list.length} 个账号？`)) return;
  }
  try {
    const r = await api("/accounts/refresh", {
      method: "POST",
      body: JSON.stringify({ force: true, ids: list }),
    });
    const n = r.refreshed ?? (r.results || []).filter(x => x.ok && !x.skipped).length;
    const failed = (r.results || []).filter(x => !x.ok).length;
    const skipped = (r.results || []).filter(x => x.ok && x.skipped).length;
    let msg = `续期完成：成功 ${n}`;
    if (failed) msg += `，失败 ${failed}`;
    if (skipped) msg += `，跳过 ${skipped}`;
    toast(msg, failed === 0);
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) {
    toast(e.message, false);
  }
}

async function export_selected_accounts() {
  const ids = Array.from(selected_account_ids);
  if (!ids.length) {
    toast("请先勾选要导出的账号", false);
    return;
  }
  try {
    const res = await fetch("/admin/api/accounts/export-batch?download=1", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ ids, include_secrets: true }),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const d = await res.json();
        msg = d.detail || d.error || msg;
      } catch {}
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    let filename = `grok2api-auth-export-selected-${ids.length}.json`;
    const m = /filename=\"?([^\";]+)\"?/.exec(cd);
    if (m) filename = m[1];
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`已导出选中 ${ids.length} 个账号`);
  } catch (e) {
    toast(e.message, false);
  }
}

$("acc-page-prev").onclick = () => { if (accounts_page > 1) { accounts_page--; render_accounts_page(); } };
$("acc-page-next").onclick = () => { accounts_page++; render_accounts_page(); };
$("acc-page-size").onchange = () => {
  accounts_page_size = parseInt($("acc-page-size").value || "25", 10) || 25;
  accounts_page = 1;
  render_accounts_page();
};

if ($("btn-acc-search")) $("btn-acc-search").onclick = () => apply_account_search(true);
if ($("btn-acc-search-clear")) $("btn-acc-search-clear").onclick = () => {
  if ($("acc-search")) $("acc-search").value = "";
  apply_account_search(true);
};
if ($("acc-search")) {
  $("acc-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply_account_search(true);
  });
}
if ($("btn-acc-select-page")) $("btn-acc-select-page").onclick = () => set_page_selection(true);
if ($("btn-acc-select-all-filtered")) $("btn-acc-select-all-filtered").onclick = () => set_filtered_selection(true);
if ($("btn-acc-select-none")) $("btn-acc-select-none").onclick = () => {
  selected_account_ids.clear();
  render_accounts_page();
};
if ($("btn-acc-delete-selected")) $("btn-acc-delete-selected").onclick = () => delete_selected_accounts();
if ($("btn-acc-renew-selected")) $("btn-acc-renew-selected").onclick = () => renew_accounts(Array.from(selected_account_ids));
if ($("btn-acc-export-selected")) $("btn-acc-export-selected").onclick = () => export_selected_accounts();
if ($("acc-check-page")) {
  $("acc-check-page").onchange = (e) => set_page_selection(!!e.target.checked);
}

function fmt_probe_cell(last_probe, last_error, blocked_ids) {
  const lp = last_probe || null;
  if (!lp) {
    const err = last_error
      ? `<div class="muted" title="${esc(last_error)}" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(last_error).slice(0, 48))}</div>`
      : '<span class="muted">未探测</span>';
    return err;
  }
  const ok = lp.available || lp.ok;
  const pill = ok ? '<span class="pill ok">正常</span>' : '<span class="pill bad">报错</span>';
  const model = lp.model ? `<span class="mono">${esc(lp.model)}</span>` : "";
  const when = lp.probed_at ? fmt_time(lp.probed_at) : "";
  const blocked = (blocked_ids && blocked_ids.length)
    ? `<div class="muted">屏蔽: ${esc(blocked_ids.join(", "))}</div>`
    : "";
  const err = (!ok && lp.error)
    ? `<div class="muted" title="${esc(lp.error)}" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(lp.error).slice(0, 60))}</div>`
    : "";
  return `${pill} ${model}<div class="muted">${when}</div>${err}${blocked}`;
}

async function refresh_all_quota(show_toast = true) {
  try {
    const data = await api("/accounts/quota");
    quota_cache = {};
    (data.accounts || []).forEach(q => {
      if (q.account_id) quota_cache[q.account_id] = q;
    });
    const qs = $("quota-summary");
    if (qs) {
      const used = data.total_used != null ? Number(data.total_used) : null;
      const limit = data.total_monthly_limit != null ? Number(data.total_monthly_limit) : null;
      const remaining = data.total_remaining != null
        ? Number(data.total_remaining)
        : (used != null && limit != null ? Math.max(0, limit - used) : null);
      const fmt_usd = (v) => {
        if (v == null || Number.isNaN(v)) return "—";
        return "$" + Number(v).toFixed(2);
      };
      const parts = [
        `可用账号 ${data.active_ok_count ?? 0}/${data.count ?? 0}`,
        remaining != null || limit != null
          ? `可用额度 ${fmt_usd(remaining)} / ${fmt_usd(limit)}`
          : null,
        data.exhausted_count ? `耗尽 ${data.exhausted_count}` : null,
        data.pool_disabled_count ? `禁用不计入 ${data.pool_disabled_count}` : null,
        data.auto_disabled_count ? `已自动移出轮询 ${data.auto_disabled_count}` : null,
      ].filter(Boolean);
      qs.textContent = "额度汇总：" + parts.join(" · ");
    }
    if (show_toast) {
      const msg = data.auto_disabled_count
        ? `额度已刷新；${data.auto_disabled_count} 个账号因额度耗尽移出轮询`
        : "额度已刷新";
      toast(msg, !data.auto_disabled_count || data.auto_disabled_count === 0);
    }
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) {
    toast(e.message, false);
  }
}

function render_models() {
  const models = (dash_cache && dash_cache.models) || [];
  const tbody = $("models-tbody");
  if (!tbody) return;
  tbody.innerHTML = models.map(m => `
    <tr>
      <td class="mono">${esc(m.id)}</td>
      <td>${esc(m.name || "—")}</td>
      <td class="muted">${m.context_window ? m.context_window.toLocaleString() : "—"}</td>
      <td class="muted">${m.supports_reasoning_effort ? "是" : "—"}</td>
    </tr>
  `).join("") || `<tr><td colspan="4" class="muted">无模型缓存，使用默认 grok-4.5</td></tr>`;
}

function render_model_health_info() {
  const el = $("model-health-info");
  if (!el) return;
  const mh = (dash_cache && dash_cache.model_health)
    || (status_cache && status_cache.model_health)
    || {};
  if (!mh.enabled) {
    el.textContent = "模型探测：已关闭";
    return;
  }
  const last = mh.last;
  const last_txt = last
    ? `上次 ${fmt_time(last.at || last.probed_at)} · 可用 ${last.available_count ?? "—"}/${last.count ?? "—"} · 自动处理 ${last.auto_action_count ?? 0}`
    : "尚未跑过周期探测";
  el.textContent = `模型探测：后台每 ${mh.interval_sec ?? "?"}s 检查 · 模型 ${(mh.probe_models || []).join(", ") || "—"} · ${last_txt}`;
}

async function run_account_probe(account_id, model) {
  const box = $("probe-result");
  if (box) box.textContent = `探测中… account=${account_id}` + (model ? ` model=${model}` : "");
  try {
    const body = {};
    if (model) body.model = model;
    const r = await api("/accounts/" + encodeURIComponent(account_id) + "/probe", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const res = r.result || r;
    const lines = [
      r.ok || res.available ? "✓ 探测成功" : "✗ 探测失败",
      `账号: ${r.email || res.email || account_id}`,
      `模型: ${res.model || "—"}`,
      res.latency_ms != null ? `耗时: ${res.latency_ms} ms` : null,
      res.status_code != null ? `HTTP: ${res.status_code}` : null,
      res.error ? `错误: ${res.error}` : null,
      res.auto_disabled ? "已自动屏蔽模型 / 移出轮询" : null,
    ].filter(Boolean);
    if (box) box.textContent = lines.join("\n");
    toast(r.ok || res.available ? "账号模型探测成功" : (res.error || "探测失败"), !!(r.ok || res.available));
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) {
    if (box) box.textContent = "✗ " + e.message;
    toast(e.message, false);
  }
}

async function run_probe_all() {
  const box = $("probe-result");
  if (box) box.textContent = "正在探测全部账号…";
  try {
    const r = await api("/accounts/probe-all", { method: "POST", body: "{}" });
    const lines = [
      `全部探测完成`,
      `可用 ${r.available_count ?? 0}/${r.count ?? 0}`,
      `不可用 ${r.unavailable_count ?? 0}`,
      `自动处理 ${r.auto_action_count ?? 0}`,
    ];
    const bad = (r.results || []).filter(x => !x.available);
    bad.slice(0, 8).forEach(x => {
      lines.push(`- ${x.email || x.account_id}: ${(x.error || "error").slice(0, 120)}`);
    });
    if (box) box.textContent = lines.join("\n");
    toast(`探测完成：${r.available_count ?? 0}/${r.count ?? 0} 可用`);
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) {
    if (box) box.textContent = "✗ " + e.message;
    toast(e.message, false);
  }
}

let ui_refresh_timer = null;
let last_auto_token_refresh_at = 0;
function start_auto_ui_refresh() {
  if (ui_refresh_timer) return;
  ui_refresh_timer = setInterval(async () => {
    if (!$("main-view") || $("main-view").classList.contains("hidden")) return;
    const chk = $("chk-auto-refresh-ui");
    if (chk && !chk.checked) {
      render_accounts();
      return;
    }
    try {
      status_cache = await api("/status");
      await load_dashboard();
      const tm = (dash_cache && dash_cache.token_maintainer) || (status_cache && status_cache.token_maintainer) || {};
      const rem = tm.min_remaining_sec;
      if (rem != null && rem < 300 && Date.now() - last_auto_token_refresh_at > 120000) {
        last_auto_token_refresh_at = Date.now();
        try {
          await api("/accounts/refresh", {
            method: "POST",
            body: JSON.stringify({ force: true }),
          });
          toast("临近过期，已自动刷新 Token");
          status_cache = await api("/status");
          await load_dashboard();
        } catch (_) {}
      }
    } catch (_) {}
  }, 30000);
}

function render_guide() {
  const page_origin = current_origin();
  let base = (dash_cache && dash_cache.api_base) || (status_cache && status_cache.api_base) || "";
  if (page_origin && (!base || /127\.0\.0\.1|localhost/i.test(base))) {
    base = page_origin.replace(/\/$/, "") + "/v1";
  }
  if (!base) base = "<your-host>/v1";
  let origin = base.replace(/\/v1\/?$/, "");
  if (!origin) origin = page_origin || "<your-host>";
  const model = (dash_cache && dash_cache.default_model) || (status_cache && status_cache.default_model) || "grok-4.5";
  $("guide-base").textContent = base;
  $("guide-model").textContent = model;
  $("guide-curl").textContent = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer sk-g2a-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}],"stream":false}'`;
  $("guide-py").textContent = `from openai import OpenAI
client = OpenAI(base_url="${base}", api_key="sk-g2a-YOUR_KEY")
r = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)

tools = [{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get weather",
    "parameters": {
      "type": "object",
      "properties": {"city": {"type": "string"}},
      "required": ["city"],
    },
  },
}]
r = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "北京天气？"}],
    tools=tools,
    tool_choice="auto",
)
print(r.choices[0].message.tool_calls or r.choices[0].message.content)`;
  if ($("guide-anthropic")) {
    $("guide-anthropic").textContent = `curl ${origin}/v1/messages \\
  -H "x-api-key: sk-g2a-YOUR_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'

from anthropic import Anthropic
client = Anthropic(base_url="${origin}", api_key="sk-g2a-YOUR_KEY")
msg = client.messages.create(
    model="${model}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(msg.content[0].text)`;
  }
  $("guide-linux").textContent = `pip install -r requirements.txt
./start.sh`;
}

function read_reg_config() {
  return {
    base_url: $("reg-base-url") ? $("reg-base-url").value.trim() : "",
    prefix: $("reg-prefix") ? $("reg-prefix").value.trim() : "",
    domain: $("reg-domain") ? $("reg-domain").value.trim() : "",
    expiry_ms: $("reg-expiry-ms") ? $("reg-expiry-ms").value.trim() : "",
    api_key: $("reg-api-key") ? $("reg-api-key").value.trim() : "",
    yescaptcha_key: $("reg-yescaptcha-key") ? $("reg-yescaptcha-key").value.trim() : "",
    proxy: $("reg-proxy") ? $("reg-proxy").value.trim() : "",
    proxy_username: $("reg-proxy-username") ? $("reg-proxy-username").value.trim() : "",
    proxy_password: $("reg-proxy-password") ? $("reg-proxy-password").value.trim() : "",
    count: $("reg-count") ? $("reg-count").value.trim() : "1",
    concurrency: $("reg-concurrency") ? $("reg-concurrency").value.trim() : "3",
    stagger_ms: $("reg-stagger-ms") ? $("reg-stagger-ms").value.trim() : "400",
  };
}
const MOEMAIL_EXPIRY_PRESETS = [3600000, 86400000, 259200000, 0];

function normalize_reg_expiry_ms(value) {
  const raw = value == null ? "" : String(value).trim();
  if (raw === "" || raw == null) return "3600000";
  if (raw === "0") return "0";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return "3600000";
  if (MOEMAIL_EXPIRY_PRESETS.includes(n)) return String(n);
  const timed = [3600000, 86400000, 259200000];
  let best = timed[0];
  let best_diff = Math.abs(n - best);
  for (const p of timed) {
    const d = Math.abs(n - p);
    if (d < best_diff) {
      best = p;
      best_diff = d;
    }
  }
  return String(best);
}

function apply_reg_config(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  if ($("reg-base-url")) $("reg-base-url").value = cfg.base_url || "";
  if ($("reg-prefix")) $("reg-prefix").value = cfg.prefix || "";
  if ($("reg-domain")) $("reg-domain").value = cfg.domain || "";
  if ($("reg-expiry-ms")) $("reg-expiry-ms").value = normalize_reg_expiry_ms(cfg.expiry_ms);
  if ($("reg-api-key")) $("reg-api-key").value = cfg.api_key || "";
  if ($("reg-yescaptcha-key")) $("reg-yescaptcha-key").value = cfg.yescaptcha_key || "";
  if ($("reg-proxy")) $("reg-proxy").value = cfg.proxy || "";
  if ($("reg-proxy-username")) $("reg-proxy-username").value = cfg.proxy_username || "";
  if ($("reg-proxy-password")) $("reg-proxy-password").value = cfg.proxy_password || "";
  if ($("reg-count")) $("reg-count").value = cfg.count || "1";
  if ($("reg-concurrency")) $("reg-concurrency").value = cfg.concurrency || "3";
  if ($("reg-stagger-ms")) $("reg-stagger-ms").value = cfg.stagger_ms || "400";
}
function save_reg_config() {
  localStorage.setItem(REG_CONFIG_KEY, JSON.stringify(read_reg_config()));
  toast("注册配置已保存");
}
function load_reg_config() {
  try {
    apply_reg_config(JSON.parse(localStorage.getItem(REG_CONFIG_KEY) || "null"));
  } catch (_) {}
}
function build_reg_body(config) {
  const body = {};
  if (config.base_url) body.base_url = config.base_url;
  if (config.prefix) body.prefix = config.prefix;
  if (config.domain) body.domain = config.domain;
  body.expiry_ms = Number.parseInt(normalize_reg_expiry_ms(config.expiry_ms), 10);
  if (config.api_key) body.api_key = config.api_key;
  if (config.yescaptcha_key) body.yescaptcha_key = config.yescaptcha_key;
  if (config.proxy) body.proxy = config.proxy;
  if (config.proxy_username) body.proxy_username = config.proxy_username;
  if (config.proxy_password) body.proxy_password = config.proxy_password;
  const count = Number.parseInt(config.count || "1", 10);
  const concurrency = Number.parseInt(config.concurrency || "3", 10);
  const stagger = Number.parseInt(config.stagger_ms || "400", 10);
  if (Number.isFinite(count) && count > 0) body.count = Math.min(50, count);
  if (Number.isFinite(concurrency) && concurrency > 0) body.concurrency = Math.min(10, concurrency);
  if (Number.isFinite(stagger) && stagger >= 0) body.stagger_ms = Math.min(10000, stagger);
  return body;
}
function build_proxy_test_body(config) {
  const body = {};
  if (config.proxy) body.proxy = config.proxy;
  if (config.proxy_username) body.proxy_username = config.proxy_username;
  if (config.proxy_password) body.proxy_password = config.proxy_password;
  return body;
}
function show_reg_session(s) {
  $("reg-session-box").classList.remove("hidden");
  reg_session_id = s.id || s.session_id || reg_session_id;
  if (reg_session_id && !reg_session_ids.includes(reg_session_id)) reg_session_ids = [reg_session_id];
  $("reg-email").textContent = s.email || s.mailbox_email || "—";
  const status_bits = [
    s.status || "running",
    s.message || s.error || "",
    s.sso ? "SSO 已提取" : null,
    s.oauth ? "OAuth 已完成" : null,
    s.auth_json_count ? `已导入 ${s.auth_json_count} 账号` : null,
  ].filter(Boolean);
  $("reg-status").textContent = status_bits.join(" · ");
  const out = {
    id: s.id || s.session_id,
    email: s.email,
    status: s.status,
    message: s.message,
    error: s.error,
    sso: s.sso ? (s.sso.slice(0, 20) + "...") : null,
    oauth: s.oauth || null,
    auth_json_count: s.auth_json_count,
    auth_json: s.auth_json || null,
  };
  $("reg-log").textContent = JSON.stringify(out, null, 2);
}
function show_reg_session_group(sessions) {
  $("reg-session-box").classList.remove("hidden");
  $("reg-email").textContent = `${sessions.length} 个注册会话`;
  const imported = sessions.filter(s => s.status === "imported" || s.status === "success" || s.status === "completed").length;
  const failed = sessions.filter(s => ["error", "failed", "expired", "protocol_error", "protocol_blocked"].includes(s.status)).length;
  const waiting = sessions.length - imported - failed;
  $("reg-status").textContent = `运行 ${waiting} · 完成 ${imported} · 异常 ${failed}`;
  $("reg-log").textContent = JSON.stringify({
    total: sessions.length,
    sessions: sessions.map(s => ({
      id: s.id || s.session_id,
      email: s.email,
      status: s.status,
      message: s.message || s.error,
      sso: s.sso ? (s.sso.slice(0, 20) + "...") : null,
      oauth: s.oauth || null,
      auth_json_count: s.auth_json_count,
    })),
  }, null, 2);
}
async function poll_reg_session() {
  const ids = reg_session_ids.length ? reg_session_ids : (reg_session_id ? [reg_session_id] : []);
  if (!ids.length) return;
  try {
    const sessions = [];
    for (const id of ids) {
      try {
        sessions.push(await api("/accounts/register-email/sessions/" + id));
      } catch (_) {}
    }
    try {
      const all = await api("/accounts/register-email/sessions");
      if (all && Array.isArray(all.sessions)) {
        const known = new Set(sessions.map(s => s.id || s.session_id));
        for (const s of all.sessions) {
          const id = s.id || s.session_id;
          if (id && !known.has(id) && reg_session_ids.includes(id)) {
            sessions.push(s);
            known.add(id);
          }
          if (id && s.batch_id && sessions.some(x => x.batch_id === s.batch_id) && !reg_session_ids.includes(id)) {
            reg_session_ids.push(id);
            if (!known.has(id)) { sessions.push(s); known.add(id); }
          }
        }
      }
    } catch (_) {}
    if (!sessions.length) return;
    if (sessions.length === 1) show_reg_session(sessions[0]);
    else show_reg_session_group(sessions);
    const terminal_ok = new Set(["success", "completed", "imported"]);
    const terminal_bad = new Set(["error", "failed", "expired", "protocol_error", "protocol_blocked"]);
    const done = sessions.every(s => terminal_ok.has(s.status));
    const failed = sessions.every(s => terminal_bad.has(s.status));
    const finished = sessions.every(s => terminal_ok.has(s.status) || terminal_bad.has(s.status));
    if (done) {
      toast(`邮箱注册完成：${sessions.length} 个账号已导入`);
      clearInterval(reg_poll_timer);
      reg_poll_timer = null;
      status_cache = await api("/status");
      await load_dashboard();
    } else if (failed) {
      toast("注册会话全部失败，请查看日志", false);
      clearInterval(reg_poll_timer);
      reg_poll_timer = null;
    } else if (finished) {
      const ok = sessions.filter(s => terminal_ok.has(s.status)).length;
      const bad = sessions.length - ok;
      toast(`批量注册结束：成功 ${ok} · 失败 ${bad}`, ok > 0);
      clearInterval(reg_poll_timer);
      reg_poll_timer = null;
      status_cache = await api("/status");
      await load_dashboard();
    }
  } catch (_) {}
}

load_reg_config();

document.querySelectorAll(".sidebar .nav-btn").forEach(btn => {
  btn.onclick = () => switch_tab(btn.dataset.tab);
});
document.querySelectorAll("[data-jump]").forEach(btn => {
  btn.onclick = () => switch_tab(btn.dataset.jump);
});
build_mobile_nav();

$("auth-submit").onclick = async () => {
  const password = $("password").value;
  if (!password) return toast("请输入密码", false);
  try {
    const setup = status_cache && status_cache.setup_needed;
    const data = setup
      ? await api("/setup", { method: "POST", body: JSON.stringify({ password }) })
      : await api("/login", { method: "POST", body: JSON.stringify({ password }) });
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    $("password").value = "";
    status_cache = await api("/status");
    await load_dashboard();
    show_main();
    toast(setup ? "初始化成功" : "登录成功");
  } catch (e) {
    toast(e.message, false);
  }
};
$("password").addEventListener("keydown", e => { if (e.key === "Enter") $("auth-submit").click(); });
$("auth-refresh").onclick = () => bootstrap();
const theme_btn = $("btn-toggle-theme");
function update_theme_ui() {
  if (current_theme === "light") {
    theme_btn.textContent = "☾ 暗色主题";
  } else {
    theme_btn.textContent = "☼ 白色主题";
  }
}
update_theme_ui();
theme_btn.onclick = () => {
  current_theme = current_theme === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", current_theme);
  localStorage.setItem(THEME_KEY, current_theme);
  update_theme_ui();
};
$("btn-logout").onclick = async () => {
  try { await api("/logout", { method: "POST" }); } catch {}
  token = "";
  localStorage.removeItem(TOKEN_KEY);
  show_auth(false);
};
$("btn-refresh-all").onclick = async () => {
  try {
    status_cache = await api("/status");
    await load_dashboard();
    toast("已刷新");
  } catch (e) { toast(e.message, false); }
};

$("btn-create-key").onclick = async () => {
  try {
    const name = $("key-name").value || "default";
    const note = $("key-note").value || "";
    const data = await api("/keys", { method: "POST", body: JSON.stringify({ name, note }) });
    const rec = data.key || data;
    const full = (rec && (rec.key || rec.secret)) || data.secret || "";
    const box = $("new-key-box");
    box.classList.remove("hidden");
    box.innerHTML = `<div style="font-weight:600;margin-bottom:6px;color:var(--ok)">✓ Key 已创建 — 列表中可随时再复制</div>
      <div class="mono" id="new-key-value" style="user-select:all;word-break:break-all;cursor:pointer" title="点击复制">${esc(full)}</div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm primary" id="copy-key">复制 Key</button>
        <button class="btn sm" id="dismiss-key">收起</button>
      </div>`;
    const do_copy = async () => {
      if (!full) { toast("Key 为空", false); return; }
      const ok = await copy_text(full);
      toast(ok ? "已复制 API Key" : "复制失败，请手动选中复制", ok);
    };
    $("copy-key").onclick = do_copy;
    $("new-key-value").onclick = do_copy;
    $("dismiss-key").onclick = () => box.classList.add("hidden");
    if (full) {
      const ok = await copy_text(full);
      if (ok) toast("已创建并自动复制到剪贴板");
    }
    $("key-name").value = "";
    $("key-note").value = "";
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) { toast(e.message, false); }
};

$("keys-tbody").onclick = async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === "copy") {
      const k = keys_cache[id] || {};
      let full = k.secret || k.key || "";
      let regenerated = false;
      if (!full) {
        if (!confirm("该 Key 未保存完整值，无法直接复制。是否重新生成一个新 Key？旧 Key 会立即失效。")) return;
        const data = await api("/keys/" + id + "/regenerate", { method: "POST" });
        const rec = data.key || data;
        full = (rec && (rec.key || rec.secret)) || data.secret || "";
        if (!full) {
          toast("Key 已重建，但接口未返回完整值，请刷新后再试", false);
          await load_dashboard();
          return;
        }
        keys_cache[id] = rec;
        regenerated = true;
      }
      const ok = await copy_text(full);
      toast(ok ? (regenerated ? "已重建并复制 API Key" : "已复制 API Key") : "复制失败，请手动选中复制", ok);
      if (regenerated) await load_dashboard();
      return;
    }
    if (btn.dataset.act === "del") {
      if (!confirm("确定删除此 Key？")) return;
      await api("/keys/" + id, { method: "DELETE" });
      toast("已删除");
    } else if (btn.dataset.act === "toggle") {
      await api("/keys/" + id, {
        method: "PATCH",
        body: JSON.stringify({ enabled: btn.dataset.on === "1" }),
      });
      toast("已更新");
    }
    status_cache = await api("/status");
    await load_dashboard();
  } catch (err) { toast(err.message, false); }
};

$("accounts-tbody").onclick = async (e) => {
  const chk = e.target.closest(".acc-check-one");
  if (chk) {
    const id = chk.dataset.id;
    if (!id) return;
    if (chk.checked) selected_account_ids.add(id);
    else selected_account_ids.delete(id);
    update_account_selection_info(get_filtered_accounts().length, document.querySelectorAll(".acc-check-one").length);
    return;
  }

  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === "renew-one") {
      await renew_accounts([id], { confirm_many: false });
      return;
    }
    if (btn.dataset.act === "probe-one") {
      await run_account_probe(id);
      return;
    }
    if (btn.dataset.act === "quota-one") {
      const q = await api("/accounts/" + encodeURIComponent(id) + "/quota");
      quota_cache[id] = q;
      if (q.auto_disabled) toast("该账号额度已耗尽，已移出轮询", false);
      else if (q.ok) toast((q.display && q.display.summary) || "额度已更新");
      else toast(q.error || "额度查询失败", false);
      status_cache = await api("/status");
      await load_dashboard();
      return;
    } else if (btn.dataset.act === "toggle-acc") {
      await api("/accounts/" + encodeURIComponent(id) + "/enabled", {
        method: "PATCH",
        body: JSON.stringify({ enabled: btn.dataset.on === "1" }),
      });
      toast(btn.dataset.on === "1" ? "已启用（重新加入轮询）" : "已禁用");
    } else if (btn.dataset.act === "rm-acc") {
      if (!confirm("确定从 auth.json 移除此账号？")) return;
      await api("/accounts/" + encodeURIComponent(id), { method: "DELETE" });
      selected_account_ids.delete(id);
      toast("已移除");
    }
    status_cache = await api("/status");
    await load_dashboard();
  } catch (err) { toast(err.message, false); }
};

const bind_quota = (id) => { const el = $(id); if (el) el.onclick = () => refresh_all_quota(true); };
bind_quota("btn-refresh-quota");
bind_quota("btn-refresh-quota-2");
const bind_probe = (id) => { const el = $(id); if (el) el.onclick = () => run_probe_all(); };
bind_probe("btn-probe-all");
bind_probe("btn-probe-all-2");

$("btn-save-mode").onclick = async () => {
  try {
    const mode = $("account-mode").value;
    await api("/settings/account-mode", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
    toast("轮询策略已保存: " + mode);
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) { toast(e.message, false); }
};

function show_device_session(r) {
  $("device-session").classList.remove("hidden");
  login_session_id = r.session_id || login_session_id;
  if (r.user_code) $("device-code").textContent = r.user_code;
  if (r.verification_url) {
    $("device-url").textContent = r.verification_url;
    $("device-url").href = r.verification_url;
  }
  $("device-status").textContent = (r.status || "") + " · " + (r.message || r.error || "");
  if (r.output_tail) $("device-log").textContent = r.output_tail;
}
async function poll_device_session() {
  if (!login_session_id) return;
  try {
    const s = await api("/accounts/login/sessions/" + login_session_id);
    show_device_session(s);
    if (s.status === "success") {
      toast("登录成功");
      clearInterval(device_poll_timer);
      device_poll_timer = null;
      status_cache = await api("/status");
      await load_dashboard();
    } else if (s.status === "error") {
      toast(s.error || "登录失败", false);
      clearInterval(device_poll_timer);
      device_poll_timer = null;
    }
  } catch (e) {}
}

$("btn-login-device").onclick = async () => {
  try {
    const r = await api("/accounts/login", {
      method: "POST",
      body: JSON.stringify({ mode: "device", capture: true }),
    });
    if (!r.ok) return toast(r.error || "启动失败", false);
    show_device_session(r);
    clearInterval(device_poll_timer);
    device_poll_timer = setInterval(poll_device_session, 2500);
    setTimeout(poll_device_session, 1000);
    setTimeout(poll_device_session, 3000);
    toast(r.user_code ? ("设备码: " + r.user_code) : (r.message || "已启动设备码登录"));
  } catch (e) { toast(e.message, false); }
};
$("btn-poll-device").onclick = () => poll_device_session();
$("btn-copy-device").onclick = async () => {
  const code = $("device-code").textContent;
  if (!code || code === "····") return toast("暂无设备码", false);
  const ok = await copy_text(code);
  toast(ok ? "已复制设备码" : code, ok);
};

if ($("import-file")) {
  $("import-file").onchange = () => {
    const files = $("import-file").files;
    const label = $("import-file-name");
    if (label) {
      if (!files || !files.length) {
        label.textContent = "未选择文件";
      } else if (files.length === 1) {
        label.textContent = `已选择：${files[0].name}（${(files[0].size / 1024).toFixed(1)} KB）`;
      } else {
        const total_kb = Array.from(files).reduce((s, f) => s + f.size, 0) / 1024;
        label.textContent = `已选择 ${files.length} 个文件（共 ${total_kb.toFixed(1)} KB）`;
      }
    }
  };
}
$("btn-import").onclick = async () => {
  const input = $("import-file");
  const files = input && input.files;
  if (!files || !files.length) return toast("请先选择 JSON 文件", false);
  const merge = $("import-merge").checked ? "true" : "false";
  let total_imported = 0;
  let total_failed = 0;
  let last_message = "";
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("merge", merge);
      const r = await api("/accounts/import-file", { method: "POST", body: fd });
      total_imported += r.imported?.length || 0;
      last_message = r.message || `已导入 ${r.imported?.length || 0} 个账号`;
    } catch (e) {
      total_failed++;
      toast(`${f.name}: ${e.message}`, false);
    }
  }
  if (files.length > 1) {
    toast(`批量导入完成：${total_imported} 个账号成功，${total_failed} 个文件失败`);
  } else {
    toast(last_message || `已导入 ${total_imported} 个账号`);
  }
  if (input) input.value = "";
  if ($("import-file-name")) $("import-file-name").textContent = "未选择文件";
  status_cache = await api("/status");
  await load_dashboard();
};
if ($("btn-import-sso")) {
  $("btn-import-sso").onclick = async () => {
    const ta = $("sso-cookies");
    const file_input = $("sso-file");
    let raw = ta && ta.value.trim();
    if (!raw && file_input && file_input.files && file_input.files[0]) {
      try {
        raw = await file_input.files[0].text();
      } catch (e) {
        return toast("读取文件失败: " + e.message, false);
      }
    }
    if (!raw) return toast("请粘贴 SSO cookie 或选择文件", false);
    const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
    if (!lines.length) return toast("请粘贴 SSO cookie 或选择文件", false);
    try {
      $("btn-import-sso").disabled = true;
      const box = $("sso-result");
      if (box) {
        box.classList.add("hidden");
        box.textContent = "";
      }
      const delay = parseInt($("sso-delay")?.value || "0", 10) || 0;
      const r = await api("/accounts/import-sso", {
        method: "POST",
        body: JSON.stringify({
          sso_cookies: lines,
          merge: !!$("sso-merge")?.checked,
          delay,
        }),
      });
      if (box) {
        const rows = (r.results || []).map(x => {
          const ok = x.status === "ok";
          const meta = ok ? `${x.email || x.user_id || ""} ${x.has_refresh_token ? "+refresh" : ""}` : (x.error || "");
          return `[${x.index}] ${ok ? "✅" : "❌"} ${x.sso_hint} ${meta}`;
        });
        box.textContent = `${r.message}\n${rows.join("\n")}`;
        box.classList.remove("hidden");
      }
      toast(r.message || `已导入 ${r.imported?.length || 0} 个账号`);
      if (ta) ta.value = "";
      if (file_input) file_input.value = "";
      if ($("sso-file-name")) $("sso-file-name").textContent = "未选择文件";
      status_cache = await api("/status");
      await load_dashboard();
    } catch (e) { toast(e.message, false); }
    finally { $("btn-import-sso").disabled = false; }
  };
}
if ($("sso-file")) {
  $("sso-file").onchange = () => {
    const f = $("sso-file").files && $("sso-file").files[0];
    const label = $("sso-file-name");
    if (label) {
      label.textContent = f
        ? `已选择：${f.name}（${(f.size / 1024).toFixed(1)} KB）`
        : "未选择文件";
    }
  };
}
if ($("btn-export")) {
  $("btn-export").onclick = async () => {
    try {
      const res = await fetch("/admin/api/accounts/export?download=1", {
        headers: headers(false),
      });
      if (!res.ok) {
        let msg = res.statusText;
        try {
          const d = await res.json();
          msg = d.detail || d.error || msg;
        } catch {}
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      let filename = "grok2api-auth-export.json";
      const m = /filename=\"?([^\";]+)\"?/.exec(cd);
      if (m) filename = m[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("已导出 auth.json");
    } catch (e) { toast(e.message, false); }
  };
}

$("btn-refresh-acc").onclick = async () => {
  try {
    status_cache = await api("/status");
    await load_dashboard();
    if (login_session_id) await poll_device_session();
    toast("已刷新");
  } catch (e) { toast(e.message, false); }
};
$("btn-logout-cli").onclick = async () => {
  if (!confirm("注销全部 Grok 账号？")) return;
  try {
    const r = await api("/accounts/logout", { method: "POST" });
    toast(r.message || "完成", !!r.ok);
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) { toast(e.message, false); }
};

$("btn-refresh-tokens").onclick = async () => {
  try {
    $("btn-refresh-tokens").disabled = true;
    const r = await api("/accounts/refresh", {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    const n = r.refreshed ?? (r.results || []).filter(x => x.ok && !x.skipped).length;
    const lines = (r.results || [])
      .filter(x => x.ok && !x.skipped)
      .map(x => `${x.email || x.id}: 新过期 ${fmt_time(x.expires_at)} (剩余 ${fmt_remaining(x.expires_at)})`);
    toast(`Token 已刷新：${n} 个账号` + (lines.length ? " · " + lines[0] : ""));
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) { toast(e.message, false); }
  finally { $("btn-refresh-tokens").disabled = false; }
};
$("btn-normalize-keys").onclick = async () => {
  try {
    const r = await api("/accounts/normalize", { method: "POST" });
    toast(`多账号键规范化：变更 ${r.changed ?? 0}，共 ${r.total ?? 0} 个`);
    status_cache = await api("/status");
    await load_dashboard();
  } catch (e) { toast(e.message, false); }
};

if ($("btn-sync-models")) {
  $("btn-sync-models").onclick = async () => {
    try {
      const r = await api("/models/sync", { method: "POST" });
      toast(`已同步 ${r.count || 0} 个模型`);
      status_cache = await api("/status");
      await load_dashboard();
    } catch (e) { toast(e.message, false); }
  };
}

if ($("btn-start-reg")) {
  $("btn-start-reg").onclick = async () => {
    try {
      const config = read_reg_config();
      $("btn-start-reg").disabled = true;
      const r = await api("/accounts/register-email", {
        method: "POST",
        body: JSON.stringify(build_reg_body(config)),
      });
      if (r.batch || (Array.isArray(r.session_ids) && r.session_ids.length > 1) || (Array.isArray(r.sessions) && r.sessions.length > 1)) {
        reg_session_ids = Array.isArray(r.session_ids) && r.session_ids.length
          ? r.session_ids.slice()
          : (Array.isArray(r.sessions) ? r.sessions.map(s => s.id || s.session_id).filter(Boolean) : []);
        reg_session_id = reg_session_ids[0] || r.id || r.session_id || null;
        if (Array.isArray(r.sessions) && r.sessions.length) {
          show_reg_session_group(r.sessions);
        } else {
          show_reg_session_group(reg_session_ids.map(id => ({ id, status: "starting" })));
        }
        $("reg-session-box").classList.remove("hidden");
        $("reg-email").textContent = `批量注册 × ${r.count || reg_session_ids.length || "?"}`;
        $("reg-status").textContent = r.message || `concurrency=${r.concurrency || "?"} · batch=${r.batch_id || "—"}`;
        toast(`已启动批量注册：${r.count || reg_session_ids.length} 个 / 并发 ${r.concurrency || "?"}`);
      } else {
        reg_session_id = r.id || r.session_id || null;
        reg_session_ids = reg_session_id ? [reg_session_id] : [];
        show_reg_session(r);
        toast(r.email ? ("已启动: " + r.email) : "已启动邮箱注册");
      }
      clearInterval(reg_poll_timer);
      reg_poll_timer = setInterval(poll_reg_session, 2500);
      setTimeout(poll_reg_session, 800);
      if (r.batch_id) {
        setTimeout(async () => {
          try {
            const b = await api("/accounts/register-email/batches/" + encodeURIComponent(r.batch_id));
            if (Array.isArray(b.session_ids) && b.session_ids.length) {
              reg_session_ids = b.session_ids.slice();
              reg_session_id = reg_session_ids[0];
            }
            if (Array.isArray(b.sessions) && b.sessions.length) show_reg_session_group(b.sessions);
          } catch (_) {}
        }, 1500);
      }
    } catch (e) {
      toast(e.message, false);
    } finally {
      $("btn-start-reg").disabled = false;
    }
  };
}
if ($("btn-test-reg-proxy")) {
  $("btn-test-reg-proxy").onclick = async () => {
    try {
      $("btn-test-reg-proxy").disabled = true;
      const r = await api("/register-email/test-proxy", {
        method: "POST",
        body: JSON.stringify(build_proxy_test_body(read_reg_config())),
      });
      $("reg-session-box").classList.remove("hidden");
      $("reg-email").textContent = "xAI 代理测试";
      $("reg-status").textContent = r.ok ? "代理可用" : "代理不可用";
      $("reg-log").textContent = JSON.stringify(r, null, 2);
      toast(r.ok ? "代理测试通过" : "代理测试失败", !!r.ok);
    } catch (e) {
      toast(e.message, false);
    } finally {
      $("btn-test-reg-proxy").disabled = false;
    }
  };
}
if ($("btn-save-reg")) {
  $("btn-save-reg").onclick = () => save_reg_config();
}
if ($("btn-refresh-reg")) {
  $("btn-refresh-reg").onclick = () => poll_reg_session();
}

async function load_settings() {
  try {
    const data = await api("/settings");
    $("set-default-model").value = data.default_model || "";
    $("set-require-api-key").value = data.require_api_key || "auto";
    $("set-reasoning-compat").value = data.reasoning_compat || "off";
    $("set-token-maintain-interval").value = data.token_maintain_interval || 180;
    $("set-model-health-interval").value = data.model_health_interval || 900;
    $("set-public-base-url").value = data.public_base_url || "";
    $("set-xai-proxy").value = data.xai_proxy || "";
    $("set-xai-proxy-username").value = data.xai_proxy_username || "";
    $("set-xai-proxy-password").value = data.xai_proxy_password || "";
    $("set-moemail-base-url").value = data.moemail_base_url || "";
    $("set-moemail-api-key").value = data.moemail_api_key || "";
    $("set-moemail-domain").value = data.moemail_domain || "";
    $("set-moemail-expiry-ms").value = data.moemail_expiry_ms || 3600000;
  } catch (e) {
    toast(e.message, false);
  }
}

$("btn-save-settings").onclick = async () => {
  const body = {
    default_model: $("set-default-model").value.trim(),
    require_api_key: $("set-require-api-key").value,
    reasoning_compat: $("set-reasoning-compat").value,
    token_maintain_interval: parseFloat($("set-token-maintain-interval").value) || 180,
    model_health_interval: parseFloat($("set-model-health-interval").value) || 900,
    public_base_url: $("set-public-base-url").value.trim(),
    xai_proxy: $("set-xai-proxy").value.trim(),
    xai_proxy_username: $("set-xai-proxy-username").value.trim(),
    xai_proxy_password: $("set-xai-proxy-password").value.trim(),
    moemail_base_url: $("set-moemail-base-url").value.trim(),
    moemail_api_key: $("set-moemail-api-key").value.trim(),
    moemail_domain: $("set-moemail-domain").value.trim(),
    moemail_expiry_ms: parseInt($("set-moemail-expiry-ms").value, 10) || 3600000,
  };
  try {
    await api("/settings", { method: "POST", body: JSON.stringify(body) });
    toast("设置已保存到数据库");
  } catch (e) {
    toast(e.message, false);
  }
};

$("btn-change-password").onclick = async () => {
  const password = $("set-admin-password").value;
  if (!password || password.length < 4) return toast("密码至少 4 位", false);
  try {
    await api("/settings/password", { method: "POST", body: JSON.stringify({ password }) });
    $("set-admin-password").value = "";
    toast("密码修改成功");
  } catch (e) {
    toast(e.message, false);
  }
};

bootstrap();
