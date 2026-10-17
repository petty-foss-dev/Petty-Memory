import { createHash, randomBytes } from 'node:crypto';
import { type Context, newId } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { type ItemService, isSecret } from './items.ts';
import { presentationOf } from './presentation.ts';
import { REFERENCE_PATTERN } from './references.ts';
import type { ItemMetadata, PublicNode, PublicShare, PublicTree } from './types.ts';

interface ShareRow {
  id: string;
  root_id: string;
  token_hash: string;
  excluded_ids: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const TOKEN_PREFIX = 'ps_';
const MAX_NODES = 5000;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const toShare = (row: ShareRow): PublicShare => ({
  id: row.id,
  rootId: row.root_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  excludedIds: JSON.parse(row.excluded_ids) as string[],
});

// Rebuild the public projection on every read so exclusions, expiry and revocation apply immediately.
export class ShareService {
  private readonly ctx: Context;
  private readonly items: ItemService;

  constructor(ctx: Context, items: ItemService) {
    this.ctx = ctx;
    this.items = items;
  }

  list(): PublicShare[] {
    return this.ctx.all<ShareRow>(`SELECT * FROM public_shares ORDER BY created_at DESC`).map(toShare);
  }

  /** The plaintext token is returned exactly once. */
  create(rootId: string, { excludedIds = [], expiresAt = null }: { excludedIds?: string[]; expiresAt?: string | null } = {}): { share: PublicShare; token: string } {
    const root = this.items.row(rootId);
    if (isSecret(root)) throw invalid('Secret notes can’t be shared publicly.');
    if (root.type === 'decision' || root.archived_at !== null) throw invalid('Share an active note or other ordinary item.');
    if (!Array.isArray(excludedIds) || !excludedIds.every((id) => typeof id === 'string')) throw invalid('excludedIds must be a list of item ids.');
    let expires: string | null = null;
    if (expiresAt !== null && expiresAt !== undefined) {
      const at = Date.parse(expiresAt);
      if (Number.isNaN(at)) throw invalid('expiresAt must be an ISO 8601 timestamp.');
      if (at <= Date.now()) throw invalid('expiresAt must be in the future.');
      expires = new Date(at).toISOString();
    }
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const id = newId();
    this.ctx.run(
      `INSERT INTO public_shares (id, root_id, token_hash, excluded_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, root.id, hashToken(token), JSON.stringify([...new Set(excludedIds)]), this.ctx.now(), expires,
    );
    return { share: this.get(id), token };
  }

  revoke(shareId: string): PublicShare {
    const share = this.get(shareId);
    if (!share.revokedAt) this.ctx.run(`UPDATE public_shares SET revoked_at = ? WHERE id = ?`, this.ctx.now(), share.id);
    return this.get(share.id);
  }

  /** Every failure looks the same, so a visitor can't tell a revoked link from a wrong one. */
  view(token: string): PublicTree {
    const gone = () => new MemoryError('not_found', 'This link doesn’t exist or is no longer shared.');
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) throw gone();
    const row = this.ctx.get<ShareRow>(`SELECT * FROM public_shares WHERE token_hash = ?`, hashToken(token));
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) throw gone();
    const excluded = new Set(JSON.parse(row.excluded_ids) as string[]);
    const visible = (r: NodeRow | undefined): r is NodeRow => r !== undefined && !excluded.has(r.id) && r.type !== 'decision'
      && r.archived_at === null && !(JSON.parse(r.metadata) as ItemMetadata).secret;
    const root = this.node(row.root_id);
    if (!visible(root)) throw gone();

    const nodes: NodeRow[] = [root];
    for (let i = 0; i < nodes.length; i++) {
      for (const child of this.ctx.all<NodeRow>(`${NODE_SELECT} WHERE i.parent_id = ? AND i.archived_at IS NULL
        AND i.type != 'decision' AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0
        AND i.id NOT IN (SELECT value FROM json_each(?)) ORDER BY i.sort_order, i.id LIMIT ?`,
      nodes[i]!.id, row.excluded_ids, MAX_NODES - nodes.length + 1)) {
        if (nodes.length >= MAX_NODES) throw invalid('This shared section is too large. Share a smaller section.');
        nodes.push(child);
      }
    }
    const titles = new Map(nodes.map((n) => [n.id, n.title.replace(REFERENCE_PATTERN, '')]));
    const scrub = (text: string) => text.replace(REFERENCE_PATTERN, (_, id: string) => (titles.has(id) ? `[[item:${id}|${titles.get(id)!.replace(/[\[\]|\n]+/g, ' ') || 'Untitled'}]]` : ''));
    const items: PublicNode[] = nodes.map((n) => {
      const presentation = presentationOf(JSON.parse(n.metadata) as ItemMetadata);
      return {
        id: n.id,
        parentId: n.id === root.id ? null : n.parent_id,
        title: scrub(n.title),
        body: scrub(n.body),
        type: n.type,
        presentation: {
          kind: presentation.kind, attention: presentation.attention, review: presentation.review,
          checklist: presentation.checklist, hideCompleted: presentation.hideCompleted,
          checked: n.task_status !== null ? n.task_status === 'done' : presentation.checked,
          autoOrganize: presentation.autoOrganize,
        },
      };
    });
    return { title: scrub(root.title) || scrub(root.body).split('\n')[0]!.slice(0, 80) || 'Shared list', items };
  }

  private get(id: string): PublicShare {
    const row = this.ctx.get<ShareRow>(`SELECT * FROM public_shares WHERE id = ?`, id);
    if (!row) throw notFound(`No share with id "${id}".`);
    return toShare(row);
  }

  private node(id: string): NodeRow | undefined {
    return this.ctx.get<NodeRow>(`${NODE_SELECT} WHERE id = ?`, id);
  }
}

interface NodeRow {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  body: string;
  metadata: string;
  archived_at: string | null;
  task_status: string | null;
}

const NODE_SELECT = `SELECT i.id, i.parent_id, i.type, i.title, i.body, i.metadata, i.archived_at, t.status AS task_status
  FROM items i LEFT JOIN tasks t ON t.item_id = i.id`;
