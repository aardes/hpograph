// db.js -- thin wrapper around sql.js (SQLite compiled to WASM).
// Loads /data/hpo.db.gz entirely client-side; no server/backend involved.
//
// The database is shipped gzip-compressed (~11MB instead of ~42MB) because
// static hosts including Cloudflare Pages cap individual deployed files at
// 25 MiB. We fetch the compressed bytes ourselves (for accurate download
// progress) and decompress them in-browser with the native
// DecompressionStream API -- no extra JS library needed. See
// scripts/build_db.py for how hpo.db.gz is produced.

const HPODB = (() => {
  let SQL = null;
  let db = null;

  async function init(onProgress) {
    SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/${file}`,
    });

    // cache: "no-store" -- the compiled DB changes across rebuilds/deploys,
    // and a browser-cached stale copy with an older schema (e.g. missing a
    // newly-added table) can otherwise cause hard-to-diagnose errors deep in
    // ranking/rendering code that has no way to know it received old data.
    const resp = await fetch("data/hpo.db.gz", { cache: "no-store" });
    if (!resp.ok) throw new Error(`Failed to fetch hpo.db.gz: ${resp.status}`);

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
    const compressed = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    if (typeof DecompressionStream === "undefined") {
      throw new Error(
        "This browser doesn't support gzip decompression (DecompressionStream). Please use a recent version of Chrome, Firefox, Edge, or Safari."
      );
    }
    const decompressedStream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buf = new Uint8Array(await new Response(decompressedStream).arrayBuffer());

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
