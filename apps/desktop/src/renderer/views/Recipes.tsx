import type { ChatResponse } from '@enve-memory/ai';
import type { OrganizationPreference, Recipe, SaveRecipeInput } from '@enve-memory/core';
import { useEffect, useState } from 'react';
import type { ActionProposal } from '../../shared/ipc.ts';
import { call, errorMessage } from '../lib/api.ts';
import { displayTitle } from '../lib/format.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, Modal, ProjectSelect, useFeedback } from '../ui.tsx';
import { ActionsDialog } from './Actions.tsx';
import { ItemPicker, type Picked } from './ItemPicker.tsx';
import { LiveStatus, knowledgePath, useKnowledge } from './KnowledgeCommon.tsx';
import { PreferenceChooser } from './Preferences.tsx';

const NAME_MAX = 120;
const INSTRUCTION_MAX = 4000;
const TOPIC_MAX = 500;

const EXAMPLES = [
  { name: 'Weekly next steps', instruction: 'Suggest tasks for what still needs doing this week, with due dates only where the notes give one.' },
  { name: 'Meeting follow-up', instruction: 'Turn the decisions and open questions into tasks, and write a short brief summarizing what was agreed.' },
  { name: 'Tag by theme', instruction: 'Add one or two short tags to each note that says what it is about. Never remove tags.' },
];

function useBranchTitle(rootId: string | null): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setTitle(null);
    if (rootId) call('items.get', rootId).then((item) => current && setTitle(displayTitle(item)), () => current && setTitle('a missing or archived note'));
    return () => {
      current = false;
    };
  }, [rootId]);
  return title;
}

/** Saved AI workflows: a named instruction and scope, run on demand against a fresh snapshot and reviewed before anything changes. */
export function Recipes() {
  const { info, go } = useApp();
  const { toast, confirm } = useFeedback();
  const list = useKnowledge<Recipe[]>('/recipes');
  const [editing, setEditing] = useState<{ recipe: Recipe | null; draft: { name: string; instruction: string } } | null>(null);
  const [running, setRunning] = useState<Recipe | null>(null);
  const [proposal, setProposal] = useState<ActionProposal | null>(null);

  const archive = async (recipe: Recipe) => {
    if (!(await confirm({
      title: 'Archive this workflow?',
      body: <p>“{recipe.name}” is archived as a note and can be restored. Changes it already made stay as they are.</p>,
      confirmLabel: 'Archive workflow',
    }))) return;
    knowledgeRequest(`/recipes/${encodeURIComponent(recipe.id)}`, 'DELETE').then(() => toast('Workflow archived'), (error: unknown) => toast(errorMessage(error), 'error'));
  };

  return (
    <section className="knowledge-section" aria-labelledby="recipes-heading">
      <div className="panel-header">
        <h2 id="recipes-heading">Workflows</h2>
        <button className="button primary small" onClick={() => setEditing({ recipe: null, draft: { name: '', instruction: '' } })}>
          <Icon name="plus" size={14} /> New workflow
        </button>
      </div>
      <p className="note">
        A workflow is a saved instruction and the notes it works on. Each run reads those notes as they are now and suggests tasks, tags,
        reminders or a brief. You choose which suggestions to apply, and can undo them. Runs never happen on their own.
      </p>
      {info && !info.aiEnabled && (
        <p className="warning small">
          Running a workflow needs an AI provider. <button className="link-button" onClick={() => go({ view: 'settings', section: 'ai' })}>Set one up in AI settings</button>
        </p>
      )}
      <LiveStatus live={list} />
      {list.data?.length === 0 && (
        <>
          <Empty title="No workflows yet">Start from an example and choose the notes it should work on.</Empty>
          <div className="workflow-examples">
            {EXAMPLES.map((example) => (
              <button key={example.name} className="hint-card" onClick={() => setEditing({ recipe: null, draft: example })}>
                <Icon name="sparkle" />
                <span><strong>{example.name}</strong> {example.instruction}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="knowledge-list">
          {list.data.map((recipe) => (
            <li key={recipe.id} className="knowledge-card">
              <div className="knowledge-card-head">
                <strong>{recipe.name}</strong>
                <RecipeScope recipe={recipe} />
              </div>
              <p className="knowledge-instruction">{recipe.instruction}</p>
              <div className="inline-actions">
                <button className="button small primary" disabled={!info?.aiEnabled} onClick={() => setRunning(recipe)}><Icon name="sparkle" size={14} /> Run…</button>
                <button className="button small" onClick={() => setEditing({ recipe, draft: { name: recipe.name, instruction: recipe.instruction } })}>Edit…</button>
                <button className="button small danger-ghost" onClick={() => void archive(recipe)}><Icon name="archive" size={14} /> Archive…</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <RecipeForm
          recipe={editing.recipe}
          draft={editing.draft}
          onClose={(saved) => {
            setEditing(null);
            if (saved) toast(editing.recipe ? 'Workflow updated' : 'Workflow saved');
          }}
        />
      )}
      {running && (
        <RunDialog
          recipe={running}
          onClose={() => setRunning(null)}
          onProposal={(next) => {
            setRunning(null);
            setProposal(next);
          }}
        />
      )}
      {proposal && <ActionsDialog proposal={proposal} onApplied={() => toast('Applied. Undo is available in this dialog.')} onUndone={() => setProposal(null)} onClose={() => setProposal(null)} />}
    </section>
  );
}

function RecipeScope({ recipe }: { recipe: Recipe }) {
  const { projects } = useApp();
  const branch = useBranchTitle(recipe.scope.rootId);
  if (recipe.scope.rootId) return <span className="badge">Branch: {branch ?? '…'}</span>;
  const project = recipe.scope.project ? projects.find((p) => p.id === recipe.scope.project)?.name ?? 'an archived project' : null;
  return <span className="badge">Topic: {recipe.scope.query}{project ? ` in ${project}` : ''}</span>;
}

function RecipeForm({ recipe, draft, onClose }: { recipe: Recipe | null; draft: { name: string; instruction: string }; onClose: (saved: boolean) => void }) {
  const { projects } = useApp();
  const [name, setName] = useState(draft.name);
  const [instruction, setInstruction] = useState(draft.instruction);
  const [kind, setKind] = useState<'branch' | 'topic'>(recipe?.scope.query ? 'topic' : 'branch');
  const [rootId, setRootId] = useState<string | null>(recipe?.scope.rootId ?? null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [query, setQuery] = useState(recipe?.scope.query ?? '');
  const [project, setProject] = useState<string | null>(recipe?.scope.project ?? null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedTitle = useBranchTitle(picked ? null : rootId);
  const branchTitle = picked?.title ?? loadedTitle;

  const problem = !name.trim() ? 'Name the workflow.'
    : !instruction.trim() ? 'Say what the AI should propose.'
      : kind === 'branch' && !rootId ? 'Choose the note the workflow works on.'
        : kind === 'topic' && !query.trim() ? 'Name the topic.' : null;

  const save = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const input: SaveRecipeInput = {
      name: name.trim(),
      instruction: instruction.trim(),
      scope: kind === 'branch' ? { rootId, query: null, project: null } : { rootId: null, query: query.trim(), project },
    };
    try {
      await knowledgeRequest('/recipes', 'POST', recipe ? { ...input, id: recipe.id } : { ...input });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Modal label={recipe ? 'Edit workflow' : 'New workflow'} onClose={() => onClose(false)} busy={busy || picking} className="workflow-dialog">
        <h2>{recipe ? 'Edit workflow' : 'New workflow'}</h2>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="field">
            <span>Name</span>
            <input autoFocus maxLength={NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>Instruction</span>
            <textarea rows={6} maxLength={INSTRUCTION_MAX} value={instruction} placeholder="Suggest tasks for what still needs doing, and write a short brief." onChange={(event) => setInstruction(event.target.value)} />
            <span className="muted small">{instruction.length.toLocaleString()} / {INSTRUCTION_MAX.toLocaleString()}</span>
          </label>
          <fieldset className="field">
            <legend>Works on</legend>
            <label className="check"><input type="radio" name="recipe-scope" checked={kind === 'branch'} onChange={() => setKind('branch')} /> One note and everything inside it</label>
            <label className="check"><input type="radio" name="recipe-scope" checked={kind === 'topic'} onChange={() => setKind('topic')} /> Notes about a topic</label>
          </fieldset>
          {kind === 'branch' ? (
            <div className="inline-actions">
              <button type="button" className="button small" onClick={() => setPicking(true)}>
                <Icon name="note" size={14} /> {rootId ? `Note: ${branchTitle ?? '…'}` : 'Choose a note…'}
              </button>
            </div>
          ) : (
            <div className="field-row">
              <label className="field">
                <span>Topic keywords</span>
                <input type="search" maxLength={TOPIC_MAX} value={query} placeholder="garage door" onChange={(event) => setQuery(event.target.value)} />
              </label>
              <label className="field">
                <span>Project</span>
                <ProjectSelect value={project} onChange={setProject} projects={projects} emptyLabel="Whole library" />
              </label>
            </div>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="button ghost" disabled={busy} onClick={() => onClose(false)}>Cancel</button>
            <button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save workflow'}</button>
          </div>
        </form>
      </Modal>
      {picking && (
        <ItemPicker
          title="Choose the note this workflow works on"
          filter={{ type: 'note', secret: false }}
          onClose={() => setPicking(false)}
          onPick={(item) => {
            setPicking(false);
            setPicked(item);
            setRootId(item.id);
          }}
        />
      )}
    </>
  );
}

/** Chooses preferences for one run. Only global ones and, for work inside a project, that project's own are offered. */
function RunDialog({ recipe, onClose, onProposal }: { recipe: Recipe; onClose: () => void; onProposal: (proposal: ActionProposal) => void }) {
  const [project, setProject] = useState<string | null | undefined>(recipe.scope.rootId ? undefined : recipe.scope.project);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branch = useBranchTitle(recipe.scope.rootId);
  const preferences = useKnowledge<OrganizationPreference[]>(project === undefined ? null : knowledgePath('/preferences', { project }));

  useEffect(() => {
    if (!recipe.scope.rootId) return;
    let current = true;
    call('items.get', recipe.scope.rootId).then((item) => current && setProject(item.project?.id ?? null), (err: unknown) => current && setError(errorMessage(err)));
    return () => {
      current = false;
    };
  }, [recipe.scope.rootId]);

  const offered = (preferences.data ?? []).filter((preference) => preference.project === null || preference.project === project);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const reply = await knowledgeRequest<ChatResponse>(`/recipes/${encodeURIComponent(recipe.id)}/run`, 'POST', selected.length ? { preferences: selected } : {});
      if (reply.kind !== 'actions') throw new Error('The workflow didn’t return suggested actions. Try running it again.');
      onProposal(reply.proposal);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal label={`Run ${recipe.name}`} onClose={onClose} busy={busy} className="workflow-dialog">
      <h2><Icon name="sparkle" size={18} /> Run “{recipe.name}”</h2>
      <p className="muted small">
        {recipe.scope.rootId ? <>Reads “{branch ?? '…'}” and what’s inside it, as it is now.</> : <>Reads notes about “{recipe.scope.query}”, as they are now.</>}{' '}
        They are sent to your AI provider with the instruction. Nothing changes until you review the suggestions.
      </p>
      {preferences.error && <p className="error-text" role="alert">{preferences.error.message}</p>}
      <PreferenceChooser preferences={offered} selected={selected} onChange={setSelected} disabled={busy} legend="Also follow these preferences (optional)" />
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={busy || project === undefined} onClick={() => void run()}>{busy ? 'Thinking…' : 'Suggest actions'}</button>
      </div>
    </Modal>
  );
}
