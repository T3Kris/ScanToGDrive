const { useState, useEffect, useRef, useCallback } = React;

// The API key (if the server requires one) is kept in localStorage and sent on
// every request via the x-api-key header / apiKey query param.
const API_KEY_STORAGE = 'scantogdrive_api_key';

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

async function api(path, options = {}) {
  const key = getApiKey();
  const headers = { ...(options.headers || {}) };
  if (key) headers['x-api-key'] = key;
  const res = await fetch(`/api${path}`, { ...options, headers });
  if (res.status === 401) {
    const err = new Error('Unauthorized');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function fmtBytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function StatusBanner({ status, onToggle, busy }) {
  let dot = 'green'; let text = 'Running';
  if (!status.configured) { dot = 'red'; text = 'Not configured'; }
  else if (status.paused) { dot = 'yellow'; text = 'Paused'; }
  else if (!status.running) { dot = 'red'; text = 'Stopped'; }

  return (
    <div className="status-banner">
      <span className={`dot ${dot}`}></span>
      <div>
        <div className="status-text">{text}</div>
        <div className="status-meta">
          Last activity: {fmtTime(status.lastActivityAt)} · Last poll: {fmtTime(status.lastPollAt)}
        </div>
      </div>
      <span className="spacer"></span>
      {status.configured && (
        <button
          className={`action ${status.paused ? 'resume' : 'pause'}`}
          onClick={onToggle}
          disabled={busy}
        >
          {status.paused ? '▶ Resume' : '⏸ Pause'}
        </button>
      )}
    </div>
  );
}

function StatusPage({ status, refresh }) {
  const [busy, setBusy] = useState(false);
  const s = status.stats || {};

  const toggle = async () => {
    setBusy(true);
    try {
      await api(status.paused ? '/resume' : '/pause', { method: 'POST' });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {!status.configured && status.configProblems?.length > 0 && (
        <div className="warn-box">
          <strong>Configuration incomplete — monitor is not running.</strong>
          <ul>{status.configProblems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}

      <StatusBanner status={status} onToggle={toggle} busy={busy} />

      <div className="cards">
        <div className="card"><div className="label">Emails Processed</div><div className="value">{s.emailsProcessed ?? 0}</div></div>
        <div className="card"><div className="label">Attachments Saved</div><div className="value">{s.attachmentsSaved ?? 0}</div></div>
        <div className="card"><div className="label">Attachments Skipped</div><div className="value">{s.attachmentsSkipped ?? 0}</div></div>
        <div className="card"><div className="label">Errors</div><div className="value">{s.errors ?? 0}</div></div>
      </div>

      <div className="config-list">
        <div className="row"><span className="k">Monitored sender</span><span className="v">{status.config?.sender || '—'}</span></div>
        <div className="row"><span className="k">Monitored group</span><span className="v">{status.config?.group || '—'}</span></div>
        <div className="row"><span className="k">Drive folder</span><span className="v">{status.config?.driveFolderName}</span></div>
        <div className="row"><span className="k">Polling interval</span><span className="v">{status.config?.pollingIntervalSeconds}s</span></div>
        <div className="row"><span className="k">Max file size</span><span className="v">{fmtBytes(status.config?.maxFileSizeBytes)}</span></div>
        <div className="row"><span className="k">Service started</span><span className="v">{fmtTime(status.startedAt)}</span></div>
      </div>
    </div>
  );
}

function LogLine({ entry }) {
  const meta = entry.metadata && Object.keys(entry.metadata).length
    ? ' ' + JSON.stringify(entry.metadata)
    : '';
  return (
    <div className={`log-line ${entry.level}`}>
      <span className="ts">{new Date(entry.timestamp).toLocaleTimeString()}</span>{' '}
      <span className={`lvl ${entry.level}`}>{entry.level.padEnd(5)}</span>{' '}
      <span className="svc">[{entry.service}]</span>{' '}
      {entry.message}
      <span className="meta">{meta}</span>
    </div>
  );
}

function LogsPage() {
  const [logs, setLogs] = useState([]);
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [wsState, setWsState] = useState('connecting');
  const viewRef = useRef(null);
  const wsRef = useRef(null);

  // Live stream via WebSocket.
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const key = getApiKey();
    const url = `${proto}://${location.host}/ws/logs${key ? `?apiKey=${encodeURIComponent(key)}` : ''}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setWsState('connected');
    ws.onclose = () => setWsState('disconnected');
    ws.onerror = () => setWsState('error');
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'backlog') setLogs(data.logs);
      else if (data.type === 'log') setLogs((prev) => [...prev.slice(-999), data.log]);
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (autoscroll && viewRef.current) {
      viewRef.current.scrollTop = viewRef.current.scrollHeight;
    }
  }, [logs, autoscroll]);

  const filtered = logs.filter((e) => {
    if (level && e.level !== level) return false;
    if (search) return JSON.stringify(e).toLowerCase().includes(search.toLowerCase());
    return true;
  });

  const download = () => {
    const text = filtered.map((e) => JSON.stringify(e)).join('\n');
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scantogdrive-logs-${new Date().toISOString()}.jsonl`;
    a.click();
  };

  return (
    <div>
      <div className="log-controls">
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">All levels</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <input
          type="text"
          placeholder="Search by email, filename, message…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label><input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} /> Auto-scroll</label>
        <button className="action" style={{ padding: '8px 14px', fontSize: 14, background: 'var(--blue)' }} onClick={download}>Download</button>
        <span className="ws-state"><span className={`dot ${wsState === 'connected' ? 'green' : 'red'}`} style={{ width: 8, height: 8 }}></span>{wsState}</span>
      </div>
      <div className="log-view" ref={viewRef}>
        {filtered.length === 0
          ? <div className="log-line" style={{ color: 'var(--muted)' }}>No log entries yet.</div>
          : filtered.map((e, i) => <LogLine key={i} entry={e} />)}
      </div>
    </div>
  );
}

function ApiKeyPrompt({ onSubmit }) {
  const [value, setValue] = useState('');
  return (
    <div className="apikey-prompt">
      <h2>🔒 API key required</h2>
      <p style={{ color: 'var(--muted)' }}>This dashboard is protected. Enter the dashboard API key to continue.</p>
      <input
        type="password"
        value={value}
        placeholder="API key"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit(value)}
      />
      <button onClick={() => onSubmit(value)}>Unlock</button>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState('status');
  const [status, setStatus] = useState(null);
  const [needsKey, setNeedsKey] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api('/status');
      setStatus(s);
      setNeedsKey(false);
    } catch (err) {
      if (err.unauthorized) setNeedsKey(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  if (needsKey) {
    return (
      <div className="app">
        <ApiKeyPrompt onSubmit={(key) => { localStorage.setItem(API_KEY_STORAGE, key); refresh(); }} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>📨 ScanToGDrive</h1>
        <span className="status-meta">Email attachments → Google Drive</span>
      </header>

      <div className="tabs">
        <button className={tab === 'status' ? 'active' : ''} onClick={() => setTab('status')}>Status</button>
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button>
      </div>

      {tab === 'status' && (status ? <StatusPage status={status} refresh={refresh} /> : <p>Loading…</p>)}
      {tab === 'logs' && <LogsPage />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
