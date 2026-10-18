import type { ClientScope, ItemType, Rule, SyncResult } from '@enve-memory/core';
import type { ImportResult } from '@enve-memory/importers';
import { type ReactNode, Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { AiStatus, ImportKind, PairResult, ThemeMode } from '../../shared/ipc.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { TYPE_LABELS, formatBytes, formatDateTime, relativeTime } from '../lib/format.ts';
import { type SettingsSection, useApp } from '../context.ts';
import { CopyButton, Empty, Icon, ProjectSelect, Toggle, useFeedback } from '../ui.tsx';
import { VaultSettings } from './Vault.tsx';

const EnveHighlightsImport = lazy(() => import('./EnveImport.tsx').then((module) => ({ default: module.EnveHighlightsImport })));

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'mcp', label: 'AI tools' },
  { id: 'devices', label: 'Devices & extensions' },
  { id: 'search', label: 'Search' },
  { id: 'ai', label: 'AI' },
  { id: 'automations', label: 'Automations' },
  { id: 'sync', label: 'Sync' },
  { id: 'vault', label: 'Secret notes' },
  { id: 'sharing', label: 'Shared links' },
  { id: 'import', label: 'Import' },
  { id: 'backups', label: 'Backups' },
  { id: 'export', label: 'Export' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'about', label: 'About' },
];

export function Settings({ section }: { section?: SettingsSection }) {
  const [current, setCurrent] = useState<SettingsSection>(section ?? 'library');
  useEffect(() => {
    if (section) setCurrent(section);
  }, [section]);
  return (
    <div className="page settings">
      <header className="page-header"><h1>Settings</h1></header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className={current === s.id ? 'active' : ''} aria-current={current === s.id ? 'page' : undefined} onClick={() => setCurrent(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {current === 'library' && <LibrarySection />}
          {current === 'mcp' && <McpSection />}
          {current === 'devices' && <DevicesSection />}
          {current === 'search' && <SearchSection />}
          {current === 'ai' && <AiSection />}
          {current === 'automations' && <AutomationsSection />}
          {current === 'sync' && <SyncSection />}
          {current === 'sync' && <RemoteSyncSection />}
          {current === 'vault' && (
            <Section title="Secret notes" intro="Notes encrypted with a passphrase. Search, AI, shared links and other apps only ever see “Secret note”.">
              <VaultSettings />
            </Section>
          )}
          {current === 'sharing' && <SharingSection />}
          {current === 'import' && <ImportSection />}
          {current === 'backups' && <BackupsSection />}
          {current === 'export' && <ExportSection />}
          {current === 'appearance' && <AppearanceSection />}
          {current === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

function Section({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title}>
      <h2>{title}</h2>
      {intro && <p className="section-intro">{intro}</p>}
      {children}
    </section>
  );
}

function Row({ label, detail, children }: { label: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {detail && <div className="setting-detail">{detail}</div>}
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

function Snippet({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="snippet">
      <div className="snippet-head">
        <strong>{title}</strong>
        <div className="inline-actions">{children}<CopyButton text={text} /></div>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

const useFail = () => {
  const { toast } = useFeedback();
  return (error: unknown) => toast(errorMessage(error), 'error');
};

function LibrarySection() {
  const { info } = useApp();
  const fail = useFail();
  if (!info) return null;
  const s = info.stats;
  return (
    <Section title="Library" intro="Everything lives in one SQLite file on this computer. The CLI and MCP servers open the same library.">
      <Row label="Location" detail={<code className="path">{info.home}</code>}>
        <button className="button small" onClick={() => call('app.openLibraryFolder').catch(fail)}>Open folder</button>
      </Row>
      <div className="stats">
        {([['Notes', s.note], ['Links', s.bookmark], ['Files', s.file + s.image], ['Tasks', s.task], ['Decisions', s.decision], ['Projects', s.projects], ['Tags', s.tags]] as const).map(([label, n]) => (
          <div key={label} className="stat"><strong>{n.toLocaleString()}</strong><span>{label}</span></div>
        ))}
      </div>
      <Row label="Schema version" detail={`${info.schemaVersion} · device ${info.deviceId.slice(0, 8)}`} />
    </Section>
  );
}

function McpSection() {
  const setup = useLive(() => call('mcp.setup'), []);
  const [output, setOutput] = useState<{ ok: boolean; output: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = useFail();
  const data = setup.data;
  if (!data) return null;
  return (
    <Section
      title="AI tools"
      intro="Connect Claude Code, Codex, Cursor or Claude Desktop once, and they all share this library over MCP: search it, read project briefings, and add notes, tasks and decisions. No AI tool can delete anything."
    >
      <Snippet title="Claude Code" text={data.claudeCode}>
        {data.claudeAvailable && (
          <button
            className="button small primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              call('mcp.addToClaudeCode').then(setOutput, fail).finally(() => setBusy(false));
            }}
          >
            {busy ? 'Adding…' : 'Add to Claude Code'}
          </button>
        )}
      </Snippet>
      {output && <pre className={`command-output ${output.ok ? 'ok' : 'failed'}`}>{output.output || (output.ok ? 'Added.' : 'Failed.')}</pre>}
      <Snippet title="Codex (~/.codex/config.toml)" text={data.codex} />
      <Snippet title="Claude Desktop, Cursor and other JSON configs" text={data.json} />
      <p className="note">
        These start the MCP server with this app’s own runtime ({data.env.ELECTRON_RUN_AS_NODE ? 'ELECTRON_RUN_AS_NODE=1' : 'Node'}), so nothing else needs
        installing. Remote agents and other machines can use MCP over HTTP at <code>{data.httpUrl}</code> with a token from Devices & extensions.
      </p>
    </Section>
  );
}

function DevicesSection() {
  const { toast, confirm } = useFeedback();
  const fail = useFail();
  const api = useLive(() => call('api.status'), []);
  const clients = useLive(() => call('clients.list'), []);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ClientScope[]>(['read', 'capture']);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [phoneName, setPhoneName] = useState('My iPhone');
  const [phoneSecrets, setPhoneSecrets] = useState(false);
  const [pair, setPair] = useState<PairResult | null>(null);
  const status = api.data;

  const setLan = async (on: boolean) => {
    if (on) {
      const ok = await confirm({
        title: 'Allow other devices on your network?',
        body: (
          <p>
            The API will listen on your local network so your phone can connect. Every request still needs a token, but traffic on a plain
            network isn’t encrypted. Prefer Tailscale for anything beyond your home Wi‑Fi.
          </p>
        ),
        confirmLabel: 'Allow network access',
      });
      if (!ok) return;
    }
    call('api.setLan', on).then(() => api.reload(), fail);
  };

  const create = () => {
    call('clients.create', name, scopes).then((result) => {
      setCreated({ name: result.client.name, token: result.token });
      setName('');
    }, fail);
  };

  const revoke = async (id: string, clientName: string) => {
    const ok = await confirm({
      title: `Revoke ${clientName}?`,
      body: <p>Its token stops working on the next request. Create a new token if you want to reconnect it.</p>,
      confirmLabel: 'Revoke token',
      danger: true,
    });
    if (ok) call('clients.revoke', id).then(() => toast(`${clientName} revoked`), fail);
  };

  return (
    <Section
      title="Devices & extensions"
      intro="The browser extension, your phone and remote agents reach this library through a local API. Each gets its own token and permissions."
    >
      {status && (
        <Row
          label="Local API"
          detail={status.running
            ? <>Listening on <code>{status.url}</code>{status.lan ? ' and your network' : ' (this computer only)'}</>
            : <span className="error-text">{status.error ?? 'Not running.'}</span>}
        >
          <span className={`status-dot ${status.running ? 'on' : 'off'}`}>{status.running ? 'Running' : 'Stopped'}</span>
        </Row>
      )}
      {status && (
        <Row label="Allow devices on this network" detail={status.lan ? status.lanUrls.join(' · ') || 'No network address found.' : 'Needed for pairing a phone. Tokens are still required.'}>
          <Toggle label="Allow devices on this network" checked={status.lan} onChange={(on) => void setLan(on)} />
        </Row>
      )}

      <h3>Create a token</h3>
      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <input aria-label="Client name" placeholder="Chrome extension" value={name} onChange={(event) => setName(event.target.value)} />
        {SCOPE_CHOICES.map((scope) => (
          <label key={scope} className="check" title={SCOPE_HELP[scope]}>
            <input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope))} />
            {scope}
          </label>
        ))}
        <button type="submit" className="button small primary" disabled={!name.trim() || scopes.length === 0}>Create token</button>
      </form>
      <p className="note">
        read: search and view · capture: save notes, links, tasks and files (the extension needs only this) · write: every non-destructive change.
        Two scopes are never implied by the others: <strong>secrets</strong> lets a device unlock and use secret notes, and <strong>sync</strong> lets
        another Petty Memory replicate this whole library, deletions included. Give sync only to your own computers’ server sync.
      </p>
      {(scopes.includes('sync') || scopes.includes('secrets')) && (
        <p className="warning small">
          {scopes.includes('sync') && 'A sync token can copy and change everything in this library, including deleting items. '}
          {scopes.includes('secrets') && 'A secrets token can work with secret notes. '}
          Only give it to a device you fully trust.
        </p>
      )}
      {created && (
        <div className="token-once" role="alert">
          <p><strong>Token for {created.name}</strong> — shown once. Paste it into the client now.</p>
          <div className="token-value">
            <code data-testid="new-token">{created.token}</code>
            <CopyButton text={created.token} />
          </div>
          <button className="link-button" onClick={() => setCreated(null)}>I’ve saved it</button>
        </div>
      )}

      <h3>Pair a phone</h3>
      <p className="note">Creates a read + write token and a pairing link. Scan the code with the Petty Memory app on your phone.</p>
      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          call('clients.pair', phoneName, { secrets: phoneSecrets }).then(setPair, fail);
        }}
      >
        <input aria-label="Phone name" value={phoneName} onChange={(event) => setPhoneName(event.target.value)} />
        <label className="check" title={SCOPE_HELP.secrets}>
          <input type="checkbox" checked={phoneSecrets} onChange={(event) => setPhoneSecrets(event.target.checked)} /> Also allow secret notes
        </label>
        <button type="submit" className="button small" disabled={!phoneName.trim()}>Pair a phone</button>
      </form>
      {phoneSecrets && (
        <p className="warning small">
          The phone gets the <strong>secrets</strong> scope: it can read encrypted notes and files and decrypts them itself with your vault passphrase.
          Revoking its token later stops it reaching this library, but can’t erase anything the phone already decrypted or saved.
        </p>
      )}
      {pair && (
        <div className="pairing" role="alert">
          {!status?.lan && <p className="warning">Turn on “Allow devices on this network” above, or the phone won’t be able to reach this computer.</p>}
          {pair.links.length === 0 && <p className="warning">This computer has no network address. Connect to Wi‑Fi or Tailscale and pair again.</p>}
          <div className="qr-grid">
            {pair.links.map((link) => (
              <figure key={link.url}>
                <img src={link.qr} alt={`Pairing code for ${link.url}`} width={200} height={200} />
                <figcaption><code>{link.url}</code></figcaption>
              </figure>
            ))}
          </div>
          <p className="note">
            The code contains the token and is shown once. This phone can {pair.client.scopes.includes('secrets') ? 'read, change and open secret notes' : 'read and change the library, but not secret notes'}.
          </p>
          <button className="link-button" onClick={() => setPair(null)}>Done</button>
        </div>
      )}

      <h3>Connected clients</h3>
      {clients.data?.length === 0 && <p className="muted">No tokens yet.</p>}
      <ul className="client-list">
        {(clients.data ?? []).map((client) => (
          <li key={client.id} className={client.revokedAt ? 'revoked' : ''}>
            <div>
              <strong>{client.name}</strong> <span className="muted small">{client.scopes.join(', ')} · {client.tokenHint}</span>
              <div className="muted small">
                {client.revokedAt ? `Revoked ${relativeTime(client.revokedAt)}` : client.lastUsedAt ? `Last used ${relativeTime(client.lastUsedAt)}` : 'Never used'}
              </div>
            </div>
            {!client.revokedAt && <button className="button small danger-ghost" onClick={() => void revoke(client.id, client.name)}>Revoke</button>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

const SCOPE_CHOICES: ClientScope[] = ['read', 'capture', 'write', 'secrets', 'sync'];

const SCOPE_HELP: Record<ClientScope, string> = {
  read: 'Search and view the library',
  capture: 'Save notes, links, tasks and files',
  write: 'Every non-destructive change (includes capture)',
  secrets: 'Unlock, read and write secret notes. Not included in read or write',
  sync: 'Full replication for server sync, deletions included. Not included in read or write',
};

function SearchSection() {
  const fail = useFail();
  const { toast } = useFeedback();
  const settings = useLive(() => call('settings.get'), []);
  const index = useLive(() => call('index.status'), []);
  const pending = index.data?.pending ?? 0;
  useEffect(() => {
    if (!index.data?.model || pending === 0) return;
    const timer = setInterval(index.reload, 2000);
    return () => clearInterval(timer);
  }, [index.data?.model, pending, index.reload]);
  const set = (key: 'fetchLinks' | 'semanticSearch', value: boolean) =>
    call('settings.set', key, value).then(() => {
      settings.reload();
      index.reload();
    }, fail);
  if (!settings.data) return null;
  const total = (index.data?.indexed ?? 0) + pending;
  return (
    <Section title="Search" intro="Keyword search always works. Semantic search also matches meaning, using a small model that runs on this computer.">
      {index.data && !index.data.supported ? (
        <Row
          label="Semantic search"
          detail={<span className="warning">Not available on this Mac. The local model’s runtime (onnxruntime) has no build for Intel Macs, so search matches words only. Everything else, including MCP search for your AI tools, works as usual.</span>}
        >
          <Toggle label="Semantic search" checked={false} disabled onChange={() => {}} />
        </Row>
      ) : (
        <Row label="Semantic search" detail="Downloads a ~23 MB model once, then works offline. Nothing is sent anywhere.">
          <Toggle label="Semantic search" checked={settings.data.semanticSearch} onChange={(on) => void set('semanticSearch', on)} />
        </Row>
      )}
      {index.data?.enabled && index.data.model && (
        <div className="index-status">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={index.data.indexed}>
            <span style={{ width: `${total ? (index.data.indexed / total) * 100 : 100}%` }} />
          </div>
          <p className="muted small">
            {pending ? `Indexing: ${index.data.indexed} of ${total} items` : `${index.data.indexed} items indexed`} · {index.data.chunks} passages · {index.data.model}
          </p>
        </div>
      )}
      <Row label="Archive saved links" detail="Fetch each saved page (no cookies) and keep its readable text. Off means saving never touches the network.">
        <Toggle label="Archive saved links" checked={settings.data.fetchLinks} onChange={(on) => void set('fetchLinks', on)} />
      </Row>
      <Row label="Failed archives" detail="Pages that couldn’t be fetched keep their link; try them again.">
        <button className="button small" onClick={() => call('items.retryFailed').then((n) => toast(n ? `Retrying ${n}` : 'Nothing failed'), fail)}>Retry failed</button>
      </Row>
    </Section>
  );
}

function AiSection() {
  const fail = useFail();
  const { toast } = useFeedback();
  const status = useLive(() => call('ai.status'), []);
  const [provider, setProvider] = useState('none');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const data = status.data;

  const load = (s: AiStatus) => {
    setProvider(s.provider);
    setModel(s.model);
    setBaseUrl(s.baseUrl);
  };
  // Only the first load seeds the form; later reloads must not wipe what the user is typing.
  const seeded = useRef(false);
  useEffect(() => {
    if (data && !seeded.current) {
      seeded.current = true;
      load(data);
    }
  }, [data]);

  if (!data) return null;
  const info = data.providers.find((p) => p.id === provider);
  const saved = data.provider === provider && data.model === model && data.baseUrl === baseUrl && !key;
  const config = { provider, model, baseUrl, apiKey: key || undefined };

  const run = (label: string, task: () => Promise<void>) => {
    setBusy(label);
    task().catch(fail).finally(() => setBusy(null));
  };
  const save = () => run('save', async () => {
    if (key) await call('ai.setKey', provider, key);
    load(await call('ai.configure', { provider, model, baseUrl }));
    setKey('');
    status.reload();
    toast(provider === 'none' ? 'AI turned off' : 'AI settings saved');
  });

  return (
    <Section
      title="AI"
      intro="Optional. Everything else (capture, search, MCP, sync) works without it. With a provider you can ask questions of your library and get summaries and tag suggestions for new items."
    >
      <label className="field">
        <span>Provider</span>
        <select value={provider} onChange={(event) => {
          setProvider(event.target.value);
          setModels([]);
          setTest(null);
          const next = data.providers.find((p) => p.id === event.target.value);
          setModel(next?.defaultModel ?? '');
          setBaseUrl('');
        }}>
          <option value="none">Off</option>
          {data.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      {info && (
        <>
          <p className={`note ${info.cloud ? 'warning' : ''}`}>
            {info.cloud
              ? `When you ask a question or enrichment runs, the question and the text of the relevant items are sent to ${info.label}. Nothing is sent otherwise.`
              : `Requests go to the server at ${baseUrl || info.baseUrl}. If that’s another computer, item text travels there.`}
          </p>
          <label className="field">
            <span>Server address <span className="muted">(leave empty for {info.baseUrl})</span></span>
            <input value={baseUrl} placeholder={info.baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          {(info.needsKey || provider === 'openai-compatible') && (
            <label className="field">
              <span>API key {data.keys.includes(provider) && <span className="badge">saved</span>}</span>
              <input
                type="password"
                autoComplete="off"
                value={key}
                placeholder={data.keys.includes(provider) ? '•••••••• (type to replace)' : info.needsKey ? 'Required' : 'Optional'}
                onChange={(event) => setKey(event.target.value)}
              />
              <span className="muted small">
                {data.encryptionAvailable
                  ? 'Encrypted with your system’s credential store. Never stored in the library, backups, exports or sync.'
                  : 'This computer has no credential store available, so keys can’t be saved.'}
                {data.keys.includes(provider) && (
                  <> <button type="button" className="link-button" onClick={() => call('ai.setKey', provider, null).then(() => status.reload(), fail)}>Remove saved key</button></>
                )}
              </span>
            </label>
          )}
          <label className="field">
            <span>Model</span>
            <div className="inline-actions">
              <input list="ai-models" value={model} placeholder={info.defaultModel ?? 'Model name'} onChange={(event) => setModel(event.target.value)} />
              <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
              <button type="button" className="button small" disabled={busy !== null} onClick={() => run('models', async () => {
                const list = await call('ai.models', config);
                setModels(list);
                toast(list.length ? `${list.length} models available` : 'The provider listed no models');
              })}>
                {busy === 'models' ? 'Loading…' : 'Load models'}
              </button>
            </div>
          </label>
          <div className="inline-actions">
            <button type="button" className="button small" disabled={busy !== null} onClick={() => run('test', async () => {
              try {
                setTest({ ok: true, text: `Replied: ${await call('ai.test', config)}` });
              } catch (error) {
                setTest({ ok: false, text: errorMessage(error) });
              }
            })}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </button>
            {test && <span className={test.ok ? 'ok-text' : 'error-text'}>{test.text}</span>}
          </div>
        </>
      )}
      <div className="inline-actions section-actions">
        <button className="button primary" disabled={saved || busy !== null} onClick={save}>Save</button>
      </div>
      {data.error && <p className="error-text">{data.error}</p>}
      {data.provider !== 'none' && (
        <Row
          label="Summaries and suggestions for new items"
          detail={data.enrich
            ? `On for items saved since ${formatDateTime(data.enrichSince)}. Suggestions appear in the Inbox; nothing is applied without you.`
            : 'Only items saved after you turn this on are sent, so it never processes your whole backlog.'}
        >
          <Toggle label="Enrich new items" checked={data.enrich} onChange={(on) => call('ai.setEnrich', on).then(() => status.reload(), fail)} />
        </Row>
      )}
      {data.provider !== 'none' && data.enrich && (
        <Row
          label="File new items automatically"
          detail={data.autoApply
            ? 'Suggested tags and projects are applied as soon as they arrive, marked as the AI’s change in Activity. Items already in a project are never moved.'
            : 'Off: suggestions wait in the Inbox until you accept them. On: they’re applied right away, and you can still change anything afterwards.'}
        >
          <Toggle label="File new items automatically" checked={data.autoApply} onChange={(on) => call('ai.setAutoApply', on).then(() => status.reload(), fail)} />
        </Row>
      )}
    </Section>
  );
}

const RULE_TYPES: ItemType[] = ['bookmark', 'note', 'file', 'image', 'task'];
const RULE_SOURCES = [
  { value: '', label: 'Anyone' },
  { value: 'mcp:', label: 'AI tools (MCP)' },
  { value: 'api:', label: 'Browser extension and devices' },
  { value: 'desktop', label: 'This app' },
];
const splitList = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean);

function describeRule(rule: Rule, projectName: (id: string) => string): string {
  const c = rule.conditions;
  const what = c.types?.length ? `a ${c.types.map((t) => TYPE_LABELS[t].toLowerCase()).join(' or ')}` : 'anything';
  const where = [
    c.domains?.length ? `from ${c.domains.join(', ')}` : '',
    c.keywords?.length ? `mentioning “${c.keywords.join('” or “')}”` : '',
    c.source ? `saved by ${RULE_SOURCES.find((s) => s.value === c.source)?.label ?? c.source}` : '',
  ].filter(Boolean);
  const then = [
    rule.actions.tags?.length ? `tag ${rule.actions.tags.map((t) => `#${t}`).join(' ')}` : '',
    rule.actions.project ? `file into ${projectName(rule.actions.project)}` : '',
  ].filter(Boolean);
  return `When ${[what, ...where].join(' ')} is saved: ${then.join(' and ')}.`;
}

function AutomationsSection() {
  const { projects } = useApp();
  const { toast, confirm } = useFeedback();
  const fail = useFail();
  const rules = useLive(() => call('rules.list'), []);
  const [name, setName] = useState('');
  const [types, setTypes] = useState<ItemType[]>([]);
  const [domains, setDomains] = useState('');
  const [keywords, setKeywords] = useState('');
  const [source, setSource] = useState('');
  const [tags, setTags] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'a project';
  const hasAction = splitList(tags).length > 0 || project !== null;

  const create = () => {
    call('rules.create', {
      name,
      conditions: {
        ...(types.length ? { types } : {}),
        ...(splitList(domains).length ? { domains: splitList(domains) } : {}),
        ...(splitList(keywords).length ? { keywords: splitList(keywords) } : {}),
        ...(source ? { source } : {}),
      },
      actions: { ...(splitList(tags).length ? { tags: splitList(tags) } : {}), ...(project ? { project } : {}) },
    }).then(() => {
      toast('Automation added');
      setName('');
      setTypes([]);
      setDomains('');
      setKeywords('');
      setSource('');
      setTags('');
      setProject(null);
      rules.reload();
    }, fail);
  };

  const remove = async (rule: Rule) => {
    const ok = await confirm({
      title: `Delete “${rule.name}”?`,
      body: <p>New items stop being tagged or filed by it. Items it already changed keep their tags and projects.</p>,
      confirmLabel: 'Delete automation',
      danger: true,
    });
    if (ok) call('rules.delete', rule.id).then(() => rules.reload(), fail);
  };

  return (
    <Section
      title="Automations"
      intro="Tag and file new items automatically, whoever saves them: this app, the browser extension, your phone or an AI tool. Automations never move an item that’s already in a project."
    >
      {rules.data?.length === 0 && <p className="muted">No automations yet.</p>}
      <ul className="client-list">
        {(rules.data ?? []).map((rule) => (
          <li key={rule.id} className={rule.enabled ? '' : 'revoked'}>
            <div>
              <strong>{rule.name}</strong>
              <div className="muted small">{describeRule(rule, projectName)}</div>
            </div>
            <div className="inline-actions">
              <Toggle label={`Enable ${rule.name}`} checked={rule.enabled} onChange={(on) => call('rules.setEnabled', rule.id, on).then(() => rules.reload(), fail)} />
              <button className="icon-button" aria-label={`Delete ${rule.name}`} onClick={() => void remove(rule)}><Icon name="trash" size={16} /></button>
            </div>
          </li>
        ))}
      </ul>

      <h3>New automation</h3>
      <form
        className="rule-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="GitHub links" />
        </label>
        <fieldset className="field">
          <legend>When a saved item is</legend>
          <div className="chips">
            {RULE_TYPES.map((t) => (
              <button type="button" key={t} className={`chip ${types.includes(t) ? 'active' : ''}`} aria-pressed={types.includes(t)}
                onClick={() => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t])}>
                {TYPE_LABELS[t]}
              </button>
            ))}
            <span className="muted small">{types.length ? '' : 'any type'}</span>
          </div>
        </fieldset>
        <div className="field-row">
          <label className="field">
            <span>From sites <span className="muted">(comma-separated)</span></span>
            <input value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="github.com, gitlab.com" />
          </label>
          <label className="field">
            <span>Mentioning <span className="muted">(any of)</span></span>
            <input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="esp32, garage door" />
          </label>
          <label className="field">
            <span>Saved by</span>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              {RULE_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Then add tags</span>
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="code, reference" />
          </label>
          <label className="field">
            <span>And file into</span>
            <ProjectSelect value={project} onChange={setProject} projects={projects} emptyLabel="Leave where it is" label="And file into" />
          </label>
        </div>
        <button type="submit" className="button primary small" disabled={!name.trim() || !hasAction}>Add automation</button>
      </form>
    </Section>
  );
}

const IMPORTS: { kind: ImportKind; title: string; detail: string; button: string; project: boolean }[] = [
  { kind: 'bookmarks', title: 'Browser bookmarks', detail: 'The HTML file Chrome, Safari, Firefox or Edge exports. Folders become tags; pages aren’t fetched, so importing hundreds stays quick.', button: 'Choose file…', project: true },
  { kind: 'markdown', title: 'Markdown folder', detail: 'An Obsidian vault or any folder of .md files. Front matter titles, tags and dates are kept.', button: 'Choose folder…', project: true },
  { kind: 'csv', title: 'CSV', detail: 'A spreadsheet with columns like title, url, note, tags. Rows with a URL become links, the rest notes.', button: 'Choose file…', project: true },
  { kind: 'enve', title: 'Petty Memory export', detail: 'A folder written by Export everything, from this or another computer. Projects, decisions and files come back too.', button: 'Choose folder…', project: false },
];

function ImportSection() {
  const { projects } = useApp();
  const fail = useFail();
  const [project, setProject] = useState<string | null>(null);
  const [busy, setBusy] = useState<ImportKind | null>(null);
  const [result, setResult] = useState<{ kind: ImportKind; result: ImportResult } | null>(null);
  return (
    <Section title="Import" intro="Bring in what you already have. Anything already in the library (same link, file or source) is skipped, so importing twice is safe.">
      <label className="field">
        <span>Put imported items in</span>
        <ProjectSelect value={project} onChange={setProject} projects={projects} emptyLabel="Inbox" label="Put imported items in" />
      </label>
      {IMPORTS.map((entry) => (
        <Row key={entry.kind} label={entry.title} detail={entry.detail}>
          <button className="button small" disabled={busy !== null} onClick={() => {
            setBusy(entry.kind);
            call('imports.run', entry.kind, entry.project ? project ?? undefined : undefined)
              .then((r) => r && setResult({ kind: entry.kind, result: r }), fail)
              .finally(() => setBusy(null));
          }}>
            {busy === entry.kind ? 'Importing…' : entry.button}
          </button>
        </Row>
      ))}
      <Suspense fallback={<p className="muted small" role="status">Loading…</p>}>
        <EnveHighlightsImport project={project} disabled={busy !== null} />
      </Suspense>
      {result && (
        <div className="token-once" role="status">
          <p>
            <strong>{IMPORTS.find((i) => i.kind === result.kind)!.title}:</strong> imported {result.result.created}, skipped {result.result.skipped} already saved
            {result.result.failed.length ? `, ${result.result.failed.length} failed` : ''}.
          </p>
          {result.result.failed.length > 0 && (
            <ul className="history">
              {result.result.failed.slice(0, 20).map((f) => <li key={f.source}><code>{f.source}</code> <span className="error-text">{f.error}</span></li>)}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

function SyncSection() {
  const fail = useFail();
  const { toast, confirm } = useFeedback();
  const sync = useLive(() => call('sync.status'), []);
  const [picked, setPicked] = useState<string | null>(null);
  const [encrypt, setEncrypt] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [unlock, setUnlock] = useState('');
  const [busy, setBusy] = useState(false);
  const data = sync.data;
  if (!data) return null;

  const act = (task: () => Promise<unknown>) => {
    setBusy(true);
    task().then(() => sync.reload(), fail).finally(() => setBusy(false));
  };
  const mismatch = encrypt && repeat.length > 0 && passphrase !== repeat;
  const canStart = picked && (!encrypt || (passphrase.length >= 8 && passphrase === repeat));

  const stop = async () => {
    const ok = await confirm({
      title: 'Stop syncing?',
      body: <p>This computer stops exchanging changes with the folder. Nothing is deleted, here or in the folder, and you can start again later.</p>,
      confirmLabel: 'Stop syncing',
    });
    if (ok) act(async () => {
      await call('sync.stop');
      toast('Sync stopped');
    });
  };

  return (
    <Section
      title="Sync"
      intro={<>Keep this library in step with your other computers through a folder you already sync: iCloud Drive, Dropbox, OneDrive, Syncthing or a NAS. Each computer writes its own files there, so the sync service never sees two writers on one file.</>}
    >
      {!data.folder && (
        <>
          <Row label="Sync folder" detail={picked ? <code className="path">{picked}</code> : 'Not syncing.'}>
            <button className="button small" disabled={busy} onClick={() => call('sync.pickFolder').then((folder) => folder && setPicked(folder), fail)}>
              {picked ? 'Change…' : 'Choose folder…'}
            </button>
          </Row>
          {picked && (
            <div className="sync-setup">
              <label className="check">
                <input type="checkbox" checked={encrypt} onChange={(event) => setEncrypt(event.target.checked)} />
                Encrypt with a passphrase (recommended for cloud drives)
              </label>
              {encrypt && (
                <>
                  <p className="note">
                    Every computer needs the same passphrase. It can’t be recovered: if you lose it, start over with a new, empty folder.
                    Petty Memory keeps only a key derived from it, never the passphrase. If this folder is already encrypted, enter its passphrase.
                  </p>
                  <div className="field-row">
                    <label className="field">
                      <span>Passphrase</span>
                      <input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="At least 8 characters" />
                    </label>
                    <label className="field">
                      <span>Repeat</span>
                      <input type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />
                    </label>
                  </div>
                  {mismatch && <p className="error-text">The passphrases don’t match.</p>}
                </>
              )}
              <button className="button primary small" disabled={!canStart || busy} onClick={() => act(async () => {
                await call('sync.start', picked!, encrypt ? passphrase : null);
                setPicked(null);
                setPassphrase('');
                setRepeat('');
              })}>
                {busy ? 'Starting…' : 'Start syncing'}
              </button>
            </div>
          )}
        </>
      )}

      {data.folder && (
        <>
          <Row label="Sync folder" detail={<><code className="path">{data.folder}</code>{data.encrypted && <span className="badge">Encrypted</span>}</>}>
            <button className="button small" disabled={busy || data.running} onClick={() => act(() => call('sync.now'))}>
              {data.running ? 'Syncing…' : 'Sync now'}
            </button>
          </Row>
          <Row
            label="Last sync"
            detail={data.last
              ? data.last.error
                ? <span className="error-text">{data.last.error}</span>
                : <SyncResultLine at={data.last.at} result={data.last.result!} />
              : 'Syncs every 2 minutes and when you switch back to this window.'}
          />
          {data.needsPassphrase && (
            <form className="token-form" onSubmit={(event) => {
              event.preventDefault();
              act(async () => {
                await call('sync.unlock', unlock);
                setUnlock('');
              });
            }}>
              <input type="password" aria-label="Sync passphrase" placeholder="This folder’s passphrase" value={unlock} onChange={(event) => setUnlock(event.target.value)} />
              <button type="submit" className="button small primary" disabled={unlock.length < 8 || busy}>Unlock</button>
            </form>
          )}
          <p className="note">
            If two computers edit the same note or project memory between syncs, both versions are kept: the other one becomes a
            “Conflicting edit of …” note. The CLI can do the same with <code>petty-memory sync [folder]</code> and <code>petty-memory sync off</code>.
          </p>
          <button className="button small" disabled={busy} onClick={() => void stop()}>Stop syncing</button>
        </>
      )}
    </Section>
  );
}

function RemoteSyncSection() {
  const fail = useFail();
  const { toast, confirm } = useFeedback();
  const remote = useLive(() => call('remoteSync.get'), []);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const data = remote.data;
  if (!data) return null;

  const act = (task: () => Promise<unknown>) => {
    setBusy(true);
    task().then(() => remote.reload(), fail).finally(() => setBusy(false));
  };
  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect from the server?',
      body: <p>This computer stops syncing with {data.url}. Nothing is deleted here or on the server, and the saved token is removed from this computer.</p>,
      confirmLabel: 'Disconnect',
    });
    if (ok) act(async () => {
      await call('remoteSync.disconnect');
      toast('Disconnected');
    });
  };

  return (
    <Section
      title="Sync through a server"
      intro={<>Sync with a Petty Memory server you run, such as <code>petty-memory serve</code> on a home machine. Folder sync above keeps working alongside it.</>}
    >
      {data.url ? (
        <>
          <Row label="Server" detail={<code className="path">{data.url}</code>}>
            <button className="button small" disabled={busy || data.running} onClick={() => act(() => call('remoteSync.run'))}>
              {data.running ? 'Syncing…' : 'Sync now'}
            </button>
          </Row>
          <Row
            label="Last sync"
            detail={data.last
              ? data.last.error
                ? <span className="error-text">{data.last.error}</span>
                : <>{formatDateTime(data.last.at)} · sent {data.last.pushed}, received {data.last.pulled}{data.last.conflicts ? `, ${data.last.conflicts} conflicting edits kept` : ''}{data.last.rejected ? <span className="warning"> · {data.last.rejected} skipped</span> : null}</>
              : 'Syncs every 2 minutes and when you switch back to this window.'}
          />
          <button className="button small" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
        </>
      ) : (
        <form className="sync-setup" onSubmit={(event) => {
          event.preventDefault();
          act(async () => {
            await call('remoteSync.configure', { url, token });
            setToken('');
          });
        }}>
          <div className="field-row">
            <label className="field">
              <span>Server address</span>
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://memory.example.com" autoComplete="url" />
            </label>
            <label className="field">
              <span>Token</span>
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="A sync token from the server" autoComplete="off" />
            </label>
          </div>
          <p className="note">
            On the server, create a token with the sync scope: <code>petty-memory clients add "My laptop" --scope sync</code>. Ordinary read/write tokens
            can’t sync. The token is encrypted with this computer’s credential store and never written to the library, exports or sync.
          </p>
          <button type="submit" className="button primary small" disabled={busy || !url.trim() || !token.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
        </form>
      )}
    </Section>
  );
}

function SharingSection() {
  const fail = useFail();
  const { toast } = useFeedback();
  const { openItem } = useApp();
  const shares = useLive(() => call('shares.list'), []);
  const list = shares.data ?? [];
  return (
    <Section
      title="Shared links"
      intro="Read-only links to an item and what’s inside it. Make one from an item’s Share… button. Links work wherever you run the Petty Memory web host; nothing is published for you."
    >
      {shares.data && list.length === 0 && <p className="muted">No shared links yet.</p>}
      <ul className="client-list">
        {list.map((share) => (
          <li key={share.id} className={share.revokedAt ? 'revoked' : ''}>
            <span>
              <button className="link-button" onClick={() => openItem(share.rootId)}>Open the shared item</button>
              {' · '}made {formatDateTime(share.createdAt)}
              {share.excludedIds.length > 0 && ` · ${share.excludedIds.length} left out`}
              {share.revokedAt ? ` · revoked ${relativeTime(share.revokedAt)}` : share.expiresAt ? ` · expires ${formatDateTime(share.expiresAt)}` : ' · no expiry'}
            </span>
            {!share.revokedAt && (
              <button className="button small danger-ghost" onClick={() => call('shares.revoke', share.id).then(() => toast('Link revoked'), fail)}>Revoke</button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function SyncResultLine({ at, result }: { at: string; result: SyncResult }) {
  return (
    <>
      {formatDateTime(at)} · sent {result.exported}, received {result.imported}
      {result.conflicts ? `, ${result.conflicts} conflicting edit${result.conflicts === 1 ? '' : 's'} kept` : ''} · {result.devices} computer{result.devices === 1 ? '' : 's'}
      {result.rejected > 0 && (
        <span className="warning"> · {result.rejected} record{result.rejected === 1 ? '' : 's'} from other devices couldn’t be applied and were skipped</span>
      )}
    </>
  );
}

function BackupsSection() {
  const fail = useFail();
  const { toast, confirm } = useFeedback();
  const backups = useLive(() => call('backups.list'), []);
  const [busy, setBusy] = useState(false);

  const restore = async (file: string, createdAt: string) => {
    const ok = await confirm({
      title: 'Restore this snapshot?',
      body: (
        <>
          <p>Your library goes back to how it was on <strong>{formatDateTime(createdAt)}</strong>. Anything saved since then disappears from it.</p>
          <p>The current library is snapshotted first, so you can undo this by restoring that snapshot. Quit AI clients that use Petty Memory (Claude Code, Codex…) before continuing.</p>
        </>
      ),
      confirmLabel: 'Restore snapshot',
      danger: true,
      typeToConfirm: 'restore',
    });
    if (!ok) return;
    setBusy(true);
    call('backups.restore', file).then(
      ({ saved }) => toast(`Restored. The previous state was saved as ${saved.split(/[\\/]/).pop()}.`),
      fail,
    ).finally(() => {
      setBusy(false);
      backups.reload();
    });
  };

  return (
    <Section title="Backups" intro="While the app runs it snapshots the library automatically: 24 hourly, 30 daily and 12 monthly copies are kept in the library folder.">
      <div className="inline-actions">
        <button className="button small" disabled={busy} onClick={() => call('backups.create').then(() => {
          toast('Snapshot saved');
          backups.reload();
        }, fail)}>
          Snapshot now
        </button>
      </div>
      {backups.data?.length === 0 && <Empty title="No snapshots yet" />}
      <ul className="backup-list">
        {(backups.data ?? []).map((backup) => (
          <li key={backup.file}>
            <span>{formatDateTime(backup.createdAt)}</span>
            <span className="badge">{backup.kind}</span>
            <span className="muted small">{formatBytes(backup.size)}</span>
            <button className="button small ghost" disabled={busy} onClick={() => void restore(backup.file, backup.createdAt)}>Restore…</button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ExportSection() {
  const fail = useFail();
  const [summary, setSummary] = useState<{ path: string; items: number; projects: number; files: number } | null>(null);
  return (
    <Section
      title="Export everything"
      intro="Writes your whole library as plain Markdown and the original files, plus a complete metadata.json. Useful with or without Petty Memory."
    >
      <button className="button" onClick={() => call('exports.run').then((result) => result && setSummary(result), fail)}>
        <Icon name="external" size={15} /> Choose a folder and export…
      </button>
      {summary && (
        <p className="ok-text">Exported {summary.items} items, {summary.projects} projects and {summary.files} files to <code className="path">{summary.path}</code></p>
      )}
    </Section>
  );
}

function AppearanceSection() {
  const fail = useFail();
  const prefs = useLive(() => call('prefs.get'), []);
  const isMac = window.enve.platform === 'darwin';
  if (!prefs.data) return null;
  const shortcut = prefs.data.shortcut.replace('CommandOrControl', isMac ? '⌘' : 'Ctrl').replace('Shift', isMac ? '⇧' : 'Shift').replaceAll('+', isMac ? '' : '+');
  return (
    <Section title="Appearance">
      <Row label="Theme">
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(['system', 'dark', 'light'] as ThemeMode[]).map((theme) => (
            <button key={theme} role="radio" aria-checked={prefs.data!.theme === theme} className={prefs.data!.theme === theme ? 'active' : ''}
              onClick={() => call('prefs.setTheme', theme).then(() => prefs.reload(), fail)}>
              {theme === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </Row>
      <Row
        label="Quick capture"
        detail={prefs.data.shortcutRegistered
          ? `Press ${shortcut} anywhere to jot a note or paste a link into your Inbox.`
          : `${shortcut} is taken by another app, so the global shortcut is off. Use File → Quick Capture instead.`}
      >
        <button className="button small" onClick={() => call('capture.open').catch(fail)}>Open</button>
      </Row>
    </Section>
  );
}

function AboutSection() {
  const { info } = useApp();
  return (
    <Section title="About">
      <p>Petty Memory {info?.version} — shared memory for you and your AI tools.</p>
      <p className="muted">Free software under the GNU Affero General Public License v3.0 (AGPL-3.0-only). Your data stays on this computer unless you choose otherwise.</p>
    </Section>
  );
}
