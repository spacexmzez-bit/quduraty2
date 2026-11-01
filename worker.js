// Quduraty shared-database Worker.
// Aptitude and Tahsili use one D1 database, separate store namespaces, and independent revisions.
const STORES = ['groups', 'sections', 'questions', 'wordGroups', 'words', 'files'];
const MAX_BODY = 8 * 1024 * 1024;
const BATCH_LIMIT = 2000;

function physicalStore(system, store) {
  return system === 'tahsili' ? `tahsili_${store}` : store;
}
function physicalStores(system) {
  return STORES.map(store => physicalStore(system, store));
}
function validate(op, tahsili = false) {
  if (!op || !STORES.includes(op.store) || typeof op.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(op.id)) {
    throw new Error('Invalid record ID/store');
  }
  if (op.kind === 'delete') return;
  if (op.kind !== 'put' || !op.data || op.data.id !== op.id ||
      JSON.stringify(op.data).length > 100000) {
    throw new Error('Invalid record');
  }
  const d = op.data;
  if (['groups', 'wordGroups'].includes(op.store) &&
      (typeof d.name !== 'string' || !d.name.trim())) {
    throw new Error('Missing group name');
  }
  if (['sections', 'questions', 'words'].includes(op.store) &&
      typeof d.groupId !== 'string') {
    throw new Error('Missing group ID');
  }
  if (op.store === 'questions' &&
      (typeof d.text !== 'string' || !d.text.trim() ||
       typeof d.sectionId !== 'string' || !Array.isArray(d.options) ||
       !d.options.length ||
       !d.options.every(x => typeof x === 'string' && (tahsili || x.trim())) ||
       (tahsili && d.options.length > 4) ||
       !Number.isInteger(d.correct) || d.correct < 0 ||
       d.correct >= d.options.length || !d.options[d.correct].trim())) {
    throw new Error('Invalid question/answer');
  }
  if (op.store === 'words' &&
      (typeof d.word !== 'string' || !d.word.trim() ||
       typeof d.meaning !== 'string' || !d.meaning.trim())) {
    throw new Error('Invalid word');
  }
  if (op.store === 'files' &&
      (typeof d.key !== 'string' || !/^uploads\/[a-f0-9-]{36}$/.test(d.key) ||
       !(d.type === 'application/pdf' || /^image\//.test(d.type)))) {
    throw new Error('Invalid attachment');
  }
}

async function ensureTahsiliMetadata(db) {
  // Aptitude keeps its existing `meta` table. Tahsili gets an independent
  // revision row in the same D1 database, without requiring a migration.
  await db.prepare(`CREATE TABLE IF NOT EXISTS qd_sync_meta (
    system TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  )`).run();
  await db.prepare(
    "INSERT OR IGNORE INTO qd_sync_meta(system, revision) VALUES('tahsili', 0)"
  ).run();
}

async function snapshotFromDatabase(db, system) {
  const physical = physicalStores(system);
  let revision;
  if (system === 'tahsili') {
    const row = await db.prepare(
      "SELECT revision FROM qd_sync_meta WHERE system='tahsili'"
    ).first();
    revision = row?.revision;
  } else {
    const row = await db.prepare('SELECT revision FROM meta WHERE id=1').first();
    revision = row?.revision;
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Sync revision is missing or invalid');
  }
  const placeholders = physical.map(() => '?').join(',');
  const result = await db.prepare(
    `SELECT store, data FROM records WHERE store IN (${placeholders})`
  ).bind(...physical).all();
  const stores = Object.fromEntries(STORES.map(s => [s, []]));
  for (const row of (result.results || [])) {
    const logicalStore = system === 'tahsili' ? row.store.slice('tahsili_'.length) : row.store;
    if (!STORES.includes(logicalStore)) throw new Error('Unknown stored record type');
    stores[logicalStore].push(JSON.parse(row.data));
  }
  return { revision, stores };
}

export default {
  async fetch(request, bindings, ctx) {
    const origin = request.headers.get('Origin');
    const allowed = (bindings.ALLOWED_ORIGINS || '').split(',')
      .map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
    const wildcard = allowed.includes('*') || allowed.length === 0;
    const permitted = !origin || wildcard || allowed.includes(origin);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-File-Name, Authorization'
    };
    if (origin && permitted) headers['Access-Control-Allow-Origin'] = wildcard ? '*' : origin;
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });

    if (request.method === 'OPTIONS') {
      if (origin && !permitted) return json({ error: `Origin ${origin} not allowed` }, 403);
      return new Response(null, { status: 204, headers });
    }
    if (origin && !permitted) {
      return json({ error: `Origin ${origin} not allowed. Add it to ALLOWED_ORIGINS in Worker settings.` }, 403);
    }

    const url = new URL(request.url);
    let path = url.pathname;

    try {
      if (path === '/health' && request.method === 'GET') return json({ ok: true });



      const tahsili = path === '/tahsili' || path.startsWith('/tahsili/');
      if (tahsili) path = path.slice('/tahsili'.length) || '/';
      const system = tahsili ? 'tahsili' : 'aptitude';
      const db = bindings.DB;
      if (!db) return json({ error: "D1 database binding 'DB' is missing" }, 500);

      if (tahsili) await ensureTahsiliMetadata(db);

      const physical = physicalStores(system);
      const guard = system === 'tahsili'
        ? "EXISTS(SELECT 1 FROM qd_sync_meta WHERE system='tahsili' AND revision=?)"
        : 'EXISTS(SELECT 1 FROM meta WHERE id=1 AND revision=?)';

      if (path === '/state' && request.method === 'GET') {
        return json(await snapshotFromDatabase(db, system));
      }

      if (path === '/uploads' && request.method === 'PUT') {
        if (!bindings.FILES) return json({ error: "R2 bucket binding 'FILES' is missing" }, 500);
        const type = request.headers.get('Content-Type') || '';
        const limit = type === 'application/pdf' ? 20 * 1024 * 1024
          : type.startsWith('image/') ? 4 * 1024 * 1024 : 0;
        if (!limit) return json({ error: 'Images and PDF only' }, 415);
        const reader = request.body?.getReader();
        if (!reader) return json({ error: 'Empty upload' }, 400);
        const chunks = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > limit) {
            await reader.cancel();
            return json({ error: 'File too large' }, 413);
          }
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const key = `uploads/${crypto.randomUUID()}`;
        await bindings.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
        return json({
          key, type,
          name: (request.headers.get('X-File-Name')
            ? decodeURIComponent(request.headers.get('X-File-Name')) : 'attachment').slice(0, 200)
        });
      }

      if (path.startsWith('/files/') && request.method === 'GET') {
        if (!bindings.FILES) return json({ error: "R2 bucket binding 'FILES' is missing" }, 500);
        const fileId = decodeURIComponent(path.slice('/files/'.length));
        const row = await db.prepare('SELECT data FROM records WHERE store=? AND id=?')
          .bind(physicalStore(system, 'files'), fileId).first();
        if (!row) return json({ error: 'Not found' }, 404);
        const data = JSON.parse(row.data);
        const object = await bindings.FILES.get(data.key);
        if (!object) return json({ error: 'Attachment object not found in R2' }, 404);
        return new Response(object.body, {
          headers: {
            ...headers,
            'Content-Type': data.type,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(data.name || 'attachment')}`,
            'X-Content-Type-Options': 'nosniff'
          }
        });
      }

      if ((path === '/batch' || path === '/wipe') && request.method === 'POST') {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > MAX_BODY) {
          return json({ error: 'Import too large; split into smaller files' }, 413);
        }
        const body = JSON.parse(raw);
        if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
          return json({ error: 'Revision required' }, 400);
        }
        const ops = path === '/wipe' ? [] : body.ops;
        if (!Array.isArray(ops) || ops.length > BATCH_LIMIT) {
          return json({ error: `Maximum ${BATCH_LIMIT} operations per batch` }, 400);
        }
        ops.forEach(op => validate(op, tahsili));

        const before = await snapshotFromDatabase(db, system);
        if (before.revision !== body.revision) {
          return json({ error: 'Data changed on the server. Refresh and retry.' }, 409);
        }

        if (path !== '/wipe') {
          const next = structuredClone(before.stores);
          for (const op of ops) {
            next[op.store] = next[op.store].filter(x => x.id !== op.id);
            if (op.kind === 'put') next[op.store].push(op.data);
          }
          for (const section of next.sections) {
            if (!next.groups.some(group => group.id === section.groupId)) {
              throw new Error('Section group is missing');
            }
          }
          for (const question of next.questions) {
            if (!next.sections.some(section =>
              section.id === question.sectionId && section.groupId === question.groupId)) {
              throw new Error('Question section is missing');
            }
            if (question.fileId && !next.files.some(file => file.id === question.fileId)) {
              throw new Error('Question attachment is missing');
            }
          }
          for (const word of next.words) {
            if (!next.wordGroups.some(group => group.id === word.groupId)) {
              throw new Error('Word group is missing');
            }
          }
        }

        const revision = body.revision;
        const statements = [];
        if (path === '/wipe') {
          const placeholders = physical.map(() => '?').join(',');
          statements.push(db.prepare(
            `DELETE FROM records WHERE store IN (${placeholders}) AND ${guard}`
          ).bind(...physical, revision));
        }
        for (const op of ops) {
          const store = physicalStore(system, op.store);
          if (op.kind === 'put') {
            statements.push(db.prepare(
              `INSERT INTO records(store,id,data)
               SELECT ?,?,? WHERE ${guard}
               ON CONFLICT(store,id) DO UPDATE SET data=excluded.data`
            ).bind(store, op.id, JSON.stringify(op.data), revision));
          } else {
            statements.push(db.prepare(
              `DELETE FROM records WHERE store=? AND id=? AND ${guard}`
            ).bind(store, op.id, revision));
          }
        }
        if (system === 'tahsili') {
          statements.push(db.prepare(
            "UPDATE qd_sync_meta SET revision=revision+1 WHERE system='tahsili' AND revision=?"
          ).bind(revision));
        } else {
          statements.push(db.prepare(
            'UPDATE meta SET revision=revision+1 WHERE id=1 AND revision=?'
          ).bind(revision));
        }
        const results = await db.batch(statements);
        const last = results[results.length - 1];
        if (!last?.meta?.changes) {
          return json({ error: 'Data changed on the server. Refresh and retry.' }, 409);
        }

        const deletedFiles = before.stores.files.filter(file =>
          path === '/wipe' || ops.some(op =>
            op.store === 'files' && op.id === file.id &&
            (op.kind === 'delete' || op.data.key !== file.key)
          )
        );
        if (deletedFiles.length && bindings.FILES) {
          ctx.waitUntil(bindings.FILES.delete(deletedFiles.map(file => file.key)).catch(console.error));
        }
        return json({ revision: revision + 1 });
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Server error' }, 400);
    }
  }
};
