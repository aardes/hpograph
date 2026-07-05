// db.js -- thin wrapper around sql.js (SQLite compiled to WASM).
// Loads /data/hpo.db entirely client-side; no server/backend involved.

const HPODB = (() => {
  let SQL = null;
  let db = null;

  async function init(onProgress) {
    SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/${file}`,
    });

    const resp = await fetch("data/hpo.db");
    if (!resp.ok) throw new Error(`Failed to fetch hpo.db: ${resp.status}`);

    const contentLength = resp.headers.get("Content-Length");
    const total = contentLength ? parseInt(contentLength, 10) : null;
    let loaded = 0;
    const reader = resp.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (onProgress) onProgress(loaded, total);
    }
    const buf = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.length;
    }

    db = new SQL.Database(buf);
    return db;
  }

  // Run a query, return array of row objects keyed by column name.
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  function one(sql, params = []) {
    const rows = all(sql, params);
    return rows.length ? rows[0] : null;
  }

  return { init, all, one };
})();
