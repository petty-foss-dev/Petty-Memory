export interface Migration {
  name: string;
  sql: string;
}

// Append only. A migration's position is its schema version; never edit or reorder a shipped entry.
export const MIGRATIONS: readonly Migration[] = [
  {
    name: 'initial',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        memory TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      -- seq is the rowid alias items_fts is keyed on; an implicit rowid can be renumbered by VACUUM.
      CREATE TABLE items (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        url TEXT,
        project_id TEXT REFERENCES projects(id),
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;
      CREATE INDEX items_project ON items(project_id, updated_at);
      CREATE INDEX items_type ON items(type, updated_at);
      CREATE INDEX items_url ON items(url) WHERE url IS NOT NULL;

      CREATE TABLE tasks (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'open',
        priority INTEGER NOT NULL DEFAULT 2,
        due_at TEXT,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX tasks_status ON tasks(status, due_at);

      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE item_tags (
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (item_id, tag_id)
      ) STRICT;
      CREATE INDEX item_tags_tag ON item_tags(tag_id);

      CREATE TABLE relations (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (from_id, to_id, kind)
      ) STRICT;
      CREATE INDEX relations_to ON relations(to_id);

      CREATE TABLE changes (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op TEXT NOT NULL,
        project_id TEXT,
        data TEXT CHECK (data IS NULL OR json_valid(data)),
        at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX changes_entity ON changes(entity, entity_id);
      CREATE INDEX changes_project ON changes(project_id, seq);

      CREATE VIRTUAL TABLE items_fts USING fts5(
        title, body, url,
        content = 'items',
        content_rowid = 'seq',
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid, title, body, url) VALUES (new.seq, new.title, new.body, new.url);
      END;
      CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, title, body, url) VALUES ('delete', old.seq, old.title, old.body, old.url);
      END;
      CREATE TRIGGER items_fts_update AFTER UPDATE OF title, body, url ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, title, body, url) VALUES ('delete', old.seq, old.title, old.body, old.url);
        INSERT INTO items_fts(rowid, title, body, url) VALUES (new.seq, new.title, new.body, new.url);
      END;
    `,
  },
  {
    name: 'api_clients',
    sql: `
      -- Local HTTP/MCP clients. Only a SHA-256 of each token is stored. Not user content, so not in the change log.
      CREATE TABLE api_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_hint TEXT NOT NULL,
        scopes TEXT NOT NULL CHECK (json_valid(scopes)),
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      ) STRICT;
    `,
  },
  {
    name: 'content_and_attachments',
    sql: `
      -- content is text extracted from the source (web article, PDF, text file): untrusted, kept apart from the user's own body.
      ALTER TABLE items ADD COLUMN content TEXT NOT NULL DEFAULT '';
      ALTER TABLE items ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata));
      CREATE INDEX items_ingest ON items(json_extract(metadata, '$.ingest.status')) WHERE json_extract(metadata, '$.ingest.status') = 'pending';

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX attachments_item ON attachments(item_id);
      CREATE INDEX attachments_sha ON attachments(sha256);

      DROP TRIGGER items_fts_insert;
      DROP TRIGGER items_fts_delete;
      DROP TRIGGER items_fts_update;
      DROP TABLE items_fts;
      CREATE VIRTUAL TABLE items_fts USING fts5(
        title, body, url, content,
        content = 'items',
        content_rowid = 'seq',
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid, title, body, url, content) VALUES (new.seq, new.title, new.body, new.url, new.content);
      END;
      CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, title, body, url, content) VALUES ('delete', old.seq, old.title, old.body, old.url, old.content);
      END;
      CREATE TRIGGER items_fts_update AFTER UPDATE OF title, body, url, content ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, title, body, url, content) VALUES ('delete', old.seq, old.title, old.body, old.url, old.content);
        INSERT INTO items_fts(rowid, title, body, url, content) VALUES (new.seq, new.title, new.body, new.url, new.content);
      END;
      INSERT INTO items_fts(items_fts) VALUES ('rebuild');
    `,
  },
  {
    name: 'embeddings',
    sql: `
      -- Derived and rebuildable from items, so not in the change log and never synced.
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        vector BLOB NOT NULL,
        UNIQUE (item_id, model, ordinal)
      ) STRICT;
      CREATE INDEX chunks_model ON chunks(model, id);

      CREATE TABLE embedded_items (
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        PRIMARY KEY (item_id, model)
      ) STRICT;

      CREATE TRIGGER items_embedding_stale AFTER UPDATE OF title, body, content ON items BEGIN
        DELETE FROM embedded_items WHERE item_id = new.id;
      END;
    `,
  },
  {
    name: 'sync',
    sql: `
      -- Hybrid logical clock stamp: ISO time, a counter, and the device, so it sorts correctly across devices.
      ALTER TABLE changes ADD COLUMN hlc TEXT;
      UPDATE changes SET hlc = at || '-0000-' || device_id;

      -- The newest version of each entity known here, and the version last exchanged with other devices.
      CREATE TABLE sync_versions (
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        hlc TEXT NOT NULL,
        synced TEXT,
        PRIMARY KEY (entity, entity_id)
      ) STRICT;
      INSERT INTO sync_versions (entity, entity_id, hlc)
        SELECT entity, entity_id, max(hlc) FROM changes GROUP BY entity, entity_id;

      -- The last segment applied from each other device.
      CREATE TABLE sync_cursors (
        device_id TEXT PRIMARY KEY,
        segment TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    name: 'rules',
    sql: `
      -- Automations: when an item matching 'conditions' is saved, apply 'actions'. Configuration, so not in the change log.
      CREATE TABLE rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        conditions TEXT NOT NULL CHECK (json_valid(conditions)),
        actions TEXT NOT NULL CHECK (json_valid(actions)),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    name: 'idempotency',
    sql: `
      -- Responses to writes that carried an Idempotency-Key, so a client retrying after a lost response gets the same answer.
      CREATE TABLE idempotency (
        client_id TEXT NOT NULL,
        key TEXT NOT NULL,
        status INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (client_id, key)
      ) STRICT;
    `,
  },
  {
    name: 'sync_hardening',
    sql: `
      -- Clock counters widen from 4 to 6 digits so a burst of edits can't overflow and sort out of order.
      UPDATE changes SET hlc = substr(hlc, 1, 25) || '00' || substr(hlc, 26) WHERE substr(hlc, 30, 1) = '-';
      UPDATE sync_versions SET hlc = substr(hlc, 1, 25) || '00' || substr(hlc, 26) WHERE substr(hlc, 30, 1) = '-';
      UPDATE sync_versions SET synced = substr(synced, 1, 25) || '00' || substr(synced, 26) WHERE substr(synced, 30, 1) = '-';

      -- References that arrived before what they point at (an item before its project, a relation before its items).
      CREATE TABLE sync_pending (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        PRIMARY KEY (kind, key)
      ) STRICT;
    `,
  },
  {
    name: 'shelves_and_reminders',
    sql: `
      ALTER TABLE items ADD COLUMN pinned_at TEXT;
      -- Last time the user opened the item or its link; drives "unopened for a month".
      ALTER TABLE items ADD COLUMN opened_at TEXT;
      ALTER TABLE items ADD COLUMN remind_at TEXT;
      -- When the current reminder was delivered, so it fires once.
      ALTER TABLE items ADD COLUMN reminded_at TEXT;
      -- What the user means to do with it: read, watch, buy or revisit.
      ALTER TABLE items ADD COLUMN intent TEXT;
      CREATE INDEX items_pinned ON items(pinned_at) WHERE pinned_at IS NOT NULL;
      CREATE INDEX items_remind ON items(remind_at) WHERE remind_at IS NOT NULL;
      CREATE INDEX items_intent ON items(intent) WHERE intent IS NOT NULL;
    `,
  },
  {
    name: 'outline',
    sql: `
      -- No foreign key: a synced child can arrive before its parent. Core keeps every parent_id pointing at an item.
      ALTER TABLE items ADD COLUMN parent_id TEXT;
      -- Ascending among siblings, ties broken by id. Existing items become roots in creation order, derived from the
      -- item alone so every device computes the same key without recording a change.
      ALTER TABLE items ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
      UPDATE items SET sort_order = coalesce(round((julianday(created_at) - 2440587.5) * 86400000.0), 0);
      CREATE INDEX items_outline ON items(parent_id, sort_order, id);
      CREATE INDEX items_archived ON items(archived_at) WHERE archived_at IS NOT NULL;
    `,
  },
  {
    name: 'versions_and_shares',
    sql: `
      -- Immutable item states (null = deleted), one per user-visible change, local or synced. Built per device from
      -- the changes it applies, so not synced itself. No foreign key: a deleted item's history must survive it.
      CREATE TABLE item_versions (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        item_id TEXT NOT NULL,
        parent_id TEXT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        op TEXT NOT NULL,
        state TEXT CHECK (state IS NULL OR json_valid(state))
      ) STRICT;
      CREATE INDEX item_versions_item ON item_versions(item_id, seq);
      CREATE INDEX item_versions_parent ON item_versions(parent_id, seq);

      -- Existing items get their current state as a baseline, labelled as such; earlier states aren't invented.
      INSERT INTO item_versions (id, item_id, parent_id, at, actor, op, state)
      SELECT
        substr(t.ms, 1, 8) || '-' || substr(t.ms, 9, 4) || '-7' || substr(t.r, 1, 3) || '-'
          || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(t.r, 4, 3) || '-' || substr(t.r, 7, 12),
        i.id, i.parent_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', 'baseline',
        json_object(
          'item', json_object(
            'id', i.id, 'type', i.type, 'title', i.title, 'body', i.body, 'url', i.url, 'content', i.content,
            'metadata', i.metadata, 'project_id', i.project_id, 'source', i.source, 'created_at', i.created_at,
            'updated_at', i.updated_at, 'archived_at', i.archived_at, 'intent', i.intent, 'pinned_at', i.pinned_at,
            'opened_at', i.opened_at, 'remind_at', i.remind_at, 'reminded_at', i.reminded_at,
            'parent_id', i.parent_id, 'sort_order', i.sort_order),
          'task', json((SELECT json_object('status', k.status, 'priority', k.priority, 'due_at', k.due_at, 'completed_at', k.completed_at)
            FROM tasks k WHERE k.item_id = i.id)),
          'tags', json((SELECT json_group_array(g.name) FROM (SELECT tg.name FROM item_tags it JOIN tags tg ON tg.id = it.tag_id
            WHERE it.item_id = i.id ORDER BY tg.name) g)),
          'attachments', json((SELECT json_group_array(json_object('id', a.id, 'sha256', a.sha256, 'filename', a.filename,
            'mime_type', a.mime_type, 'size', a.size, 'created_at', a.created_at)) FROM attachments a WHERE a.item_id = i.id)))
      FROM items i JOIN (
        SELECT seq, lower(hex(randomblob(9))) AS r,
          printf('%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) AS ms
        FROM items
      ) t ON t.seq = i.seq
      ORDER BY i.seq;

      -- Public read-only links to a subtree. Only a hash of each link's token is kept. Configuration, so not logged.
      CREATE TABLE public_shares (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        excluded_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(excluded_ids)),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      ) STRICT;
    `,
  },
  {
    name: 'version_snapshot_boundaries',
    sql: `
      ALTER TABLE item_versions ADD COLUMN snapshot_seq INTEGER;
      UPDATE item_versions SET snapshot_seq = seq;
      UPDATE item_versions SET snapshot_seq = (SELECT max(seq) FROM item_versions WHERE op = 'baseline')
        WHERE op = 'baseline';
    `,
  },
  {
    name: 'editor_journal_and_memory_history',
    sql: `
      -- Structural edits that can be undone and redone: only the items an action changed, before and after. Local
      -- derived history, so neither logged nor synced; undo and redo are ordinary logged changes.
      CREATE TABLE editor_actions (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        actor TEXT NOT NULL,
        label TEXT NOT NULL,
        focus_id TEXT NOT NULL,
        undo_focus_id TEXT NOT NULL,
        created_ids TEXT NOT NULL CHECK (json_valid(created_ids)),
        commands_hash TEXT NOT NULL,
        entries TEXT NOT NULL CHECK (json_valid(entries)),
        created_at TEXT NOT NULL,
        undone_at TEXT
      ) STRICT;

      -- Every project memory text this device wrote or received. Built per device like item history, so not synced.
      CREATE TABLE project_memory_versions (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        op TEXT NOT NULL,
        memory TEXT NOT NULL
      ) STRICT;
      CREATE INDEX project_memory_versions_project ON project_memory_versions(project_id, seq);

      -- Each recorded set_memory change kept its full text.
      INSERT INTO project_memory_versions (id, project_id, at, actor, op, memory)
      SELECT
        substr(c.ms, 1, 8) || '-' || substr(c.ms, 9, 4) || '-7' || substr(c.r, 1, 3) || '-'
          || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(c.r, 4, 3) || '-' || substr(c.r, 7, 12),
        c.entity_id, c.at, c.actor, 'set_memory', json_extract(c.data, '$.memory')
      FROM (
        SELECT seq, entity_id, at, actor, data, lower(hex(randomblob(9))) AS r,
          printf('%012x', CAST((julianday(at) - 2440587.5) * 86400000 AS INTEGER)) AS ms
        FROM changes
        WHERE entity = 'project' AND op = 'set_memory' AND json_type(data, '$.memory') = 'text'
          AND entity_id IN (SELECT id FROM projects)
      ) c
      ORDER BY c.seq;

      -- Text that came from other devices or outside the log was never recorded; history starts from it as it is now.
      INSERT INTO project_memory_versions (id, project_id, at, actor, op, memory)
      SELECT
        substr(p.ms, 1, 8) || '-' || substr(p.ms, 9, 4) || '-7' || substr(p.r, 1, 3) || '-'
          || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(p.r, 4, 3) || '-' || substr(p.r, 7, 12),
        p.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', 'baseline', p.memory
      FROM (
        SELECT id, memory, lower(hex(randomblob(9))) AS r,
          printf('%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) AS ms
        FROM projects
      ) p
      WHERE p.memory != coalesce(
        (SELECT v.memory FROM project_memory_versions v WHERE v.project_id = p.id ORDER BY v.seq DESC LIMIT 1), ''
      );
    `,
  },
];
