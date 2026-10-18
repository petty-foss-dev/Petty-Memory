import type { OrganizationPreference, SavePreferenceInput } from '@enve-memory/core';
import { useState } from 'react';
import { errorMessage } from '../lib/api.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, Modal, ProjectSelect, useFeedback } from '../ui.tsx';
import { LiveStatus, useKnowledge } from './KnowledgeCommon.tsx';

const INSTRUCTION_MAX = 1000;
const NAME_MAX = 120;
const MAX_SELECTED = 10;

/** Saved organization preferences: plain instructions used only when someone ticks them for one request. */
export function Preferences() {
  const { projects } = useApp();
  const { toast, confirm } = useFeedback();
  const list = useKnowledge<OrganizationPreference[]>('/preferences');
  const [editing, setEditing] = useState<OrganizationPreference | 'new' | null>(null);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'an archived project';

  const archive = async (preference: OrganizationPreference) => {
    if (!(await confirm({
      title: 'Archive this preference?',
      body: <p>“{preference.name}” stops appearing in workflow and organization requests. It stays in your library as an archived note, so you can restore it.</p>,
      confirmLabel: 'Archive preference',
    }))) return;
    knowledgeRequest(`/preferences/${encodeURIComponent(preference.id)}`, 'DELETE').then(() => toast('Preference archived'), (error: unknown) => toast(errorMessage(error), 'error'));
  };

  return (
    <section className="knowledge-section" aria-labelledby="preferences-heading">
      <div className="panel-header">
        <h2 id="preferences-heading">Organization preferences</h2>
        <button className="button primary small" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New preference</button>
      </div>
      <p className="note">
        Write down how you like things filed, such as “Receipts go under Finance, by year”. A preference is used only when you tick it for a
        workflow run or an AI organization request. Nothing learns from your chats, and nothing is filed automatically. A project preference can
        be chosen only for work in that project; organizing the whole library offers global preferences only.
      </p>
      <LiveStatus live={list} />
      {list.data?.length === 0 && <Empty title="No preferences yet">Save one when you notice yourself explaining the same filing rule twice.</Empty>}
      {list.data && list.data.length > 0 && (
        <ul className="knowledge-list">
          {list.data.map((preference) => (
            <li key={preference.id} className="knowledge-card">
              <div className="knowledge-card-head">
                <strong>{preference.name}</strong>
                <span className="badge">{preference.project ? projectName(preference.project) : 'All projects'}</span>
              </div>
              <p className="knowledge-instruction">{preference.instruction}</p>
              <div className="inline-actions">
                <button className="button small" onClick={() => setEditing(preference)}>Edit…</button>
                <button className="button small danger-ghost" onClick={() => void archive(preference)}><Icon name="archive" size={14} /> Archive…</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <PreferenceForm
          preference={editing === 'new' ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) toast(editing === 'new' ? 'Preference saved' : 'Preference updated');
          }}
        />
      )}
    </section>
  );
}

function PreferenceForm({ preference, onClose }: { preference: OrganizationPreference | null; onClose: (saved: boolean) => void }) {
  const { projects } = useApp();
  const [name, setName] = useState(preference?.name ?? '');
  const [instruction, setInstruction] = useState(preference?.instruction ?? '');
  const [project, setProject] = useState<string | null>(preference?.project ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!instruction.trim()) {
      setError('Write the preference first.');
      return;
    }
    setBusy(true);
    setError(null);
    const input: SavePreferenceInput = { instruction: instruction.trim(), name: name.trim() || null, project };
    try {
      await knowledgeRequest('/preferences', 'POST', preference ? { ...input, id: preference.id } : { ...input });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal label={preference ? 'Edit preference' : 'New preference'} onClose={() => onClose(false)} busy={busy} className="workflow-dialog">
      <h2>{preference ? 'Edit preference' : 'New preference'}</h2>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="field">
          <span>Preference</span>
          <textarea autoFocus rows={4} maxLength={INSTRUCTION_MAX} value={instruction} placeholder="File receipts under Finance, one heading per year." onChange={(event) => setInstruction(event.target.value)} />
          <span className="muted small">{instruction.length} / {INSTRUCTION_MAX}</span>
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input maxLength={NAME_MAX} value={name} placeholder="Taken from the preference when left empty" onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>Applies to</span>
          <ProjectSelect value={project} onChange={setProject} projects={projects} emptyLabel="All projects" label="Applies to" />
        </label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={() => onClose(false)}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy || !instruction.trim()}>{busy ? 'Saving…' : 'Save preference'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Ticks for preferences to send with one request. Starts empty; nothing is chosen for the person. */
export function PreferenceChooser({ preferences, selected, onChange, disabled, legend = 'Use saved preferences' }: {
  preferences: OrganizationPreference[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  legend?: string;
}) {
  if (!preferences.length) return null;
  return (
    <fieldset className="field preference-chooser">
      <legend>{legend}</legend>
      {preferences.map((preference) => (
        <label key={preference.id} className="check">
          <input
            type="checkbox"
            disabled={disabled || (selected.length >= MAX_SELECTED && !selected.includes(preference.id))}
            checked={selected.includes(preference.id)}
            onChange={(event) => onChange(event.target.checked ? [...selected, preference.id] : selected.filter((id) => id !== preference.id))}
          />
          <span><strong>{preference.name}</strong>{preference.name !== preference.instruction && <span className="muted small"> · {preference.instruction}</span>}</span>
        </label>
      ))}
    </fieldset>
  );
}
