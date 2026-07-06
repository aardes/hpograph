// app.js -- single search box drives the graph (left panel); the right panel
// owns the multi-term selection, the disease/gene ranking, and the
// phenotype-set relationship view.

const HPOApp = (() => {
  const DB_LABELS = { OMIM: "OMIM", ORPHA: "Orphanet (ORPHA)", DECIPHER: "DECIPHER" };
  const DB_ORDER = ["OMIM", "ORPHA", "DECIPHER"];
  const ROWS_PER_SOURCE = 50;

  // Validated during development: both of these correctly surface the
  // clinically-expected diagnosis at or near the top of both lists.
  const EXAMPLES = {
    marfan: ["HP:0001166", "HP:0001083", "HP:0002616"], // Arachnodactyly, Ectopia lentis, Aortic root aneurysm
    ndd: ["HP:0001250", "HP:0001263", "HP:0000252"], // Seizure, Global developmental delay, Microcephaly
  };

  const state = {
    focusId: null,
    selected: new Map(), // id -> {id, name}
    activeTab: "selected",
    activeDiseaseSource: "OMIM",
    lastDiseaseScores: [],
    lastGeneScores: [],
    expandedDiseaseIds: new Set(),
    expandedGeneSymbols: new Set(),
    expandedClinGenSymbols: new Set(),
    activeSuggestMode: "discriminative",
    lastSuggestions: { reinforcing: [], discriminative: [] },
  };

  const el = {
    loading: document.getElementById("loading-overlay"),
    loadingText: document.getElementById("loading-text"),
    searchInput: document.getElementById("search-input"),
    searchResults: document.getElementById("search-results"),
    graphContainer: document.getElementById("graph-container"),
    focusLabel: document.getElementById("focus-label"),
    addFocusBtn: document.getElementById("add-focus-btn"),
    selectedList: document.getElementById("selected-list"),
    relationshipsPanel: document.getElementById("relationships-panel"),
    topSummary: document.getElementById("top-summary"),
    suggestList: document.getElementById("suggest-list"),
    suggestModeBtns: document.querySelectorAll("[data-suggest-mode]"),
    exportActions: document.getElementById("export-actions"),
    exportBtn: document.getElementById("export-btn"),
    copyLinkBtn: document.getElementById("copy-link-btn"),
    exportJsonBtn: document.getElementById("export-json-btn"),
    exampleChips: document.querySelectorAll(".hg-example-chip"),
    tabSelected: document.getElementById("tab-selected"),
    tabDisease: document.getElementById("tab-disease"),
    tabGene: document.getElementById("tab-gene"),
    tabClinGen: document.getElementById("tab-clingen"),
    tabSuggest: document.getElementById("tab-suggest"),
    tabs: document.querySelectorAll(".hg-tab-btn"),
    panels: {
      selected: document.getElementById("panel-selected"),
      disease: document.getElementById("panel-disease"),
      gene: document.getElementById("panel-gene"),
      clingen: document.getElementById("panel-clingen"),
      suggest: document.getElementById("panel-suggest"),
    },
    diseaseList: document.getElementById("disease-list"),
    geneList: document.getElementById("gene-list"),
    clingenList: document.getElementById("clingen-list"),
    rankStatus: document.getElementById("rank-status"),
    footerBuildInfo: document.getElementById("footer-build-info"),
  };

  function setLoading(visible, text) {
    el.loading.style.display = visible ? "flex" : "none";
    if (text) el.loadingText.textContent = text;
  }

  async function boot() {
    setLoading(true, "Loading HPO database…");
    await HPODB.init((loaded, total) => {
      if (total) {
        const pct = Math.round((loaded / total) * 100);
        el.loadingText.textContent = `Loading HPO database… ${pct}%`;
      } else {
        el.loadingText.textContent = `Loading HPO database… ${(loaded / 1e6).toFixed(1)} MB`;
      }
    });
    Ranking.loadGraph();
    setLoading(false);
    wireEvents();
    renderBuildInfo();
    if (!loadTermsFromUrl()) {
      renderSelectedList();
    }
  }

  // Footer build/version info, read from the `meta` key/value table written
  // by scripts/build_db.py. Older databases built before a given meta key
  // existed simply won't have it -- every lookup here is optional, so a
  // missing key degrades to a shorter footer line rather than an error.
  function renderBuildInfo() {
    try {
      const rows = HPODB.all("SELECT key, value FROM meta");
      const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const parts = [];
      if (meta.build_date) parts.push(`DB build ${meta.build_date}`);
      if (meta.schema_version) parts.push(`schema v${meta.schema_version}`);
      if (meta.num_terms) parts.push(`${Number(meta.num_terms).toLocaleString()} terms`);
      el.footerBuildInfo.textContent = parts.length ? parts.join(" · ") : "Version info unavailable";

      const tooltipParts = [];
      if (meta.hpo_source) tooltipParts.push(`HPO: ${meta.hpo_source}`);
      if (meta.phenotype_annotation_source) tooltipParts.push(`Annotations: ${meta.phenotype_annotation_source}`);
      if (meta.hgnc_source) tooltipParts.push(`HGNC: ${meta.hgnc_source}`);
      el.footerBuildInfo.title = tooltipParts.join("\n");
    } catch (e) {
      console.warn("Could not read build metadata:", e);
      el.footerBuildInfo.textContent = "Version info unavailable";
    }
  }

  function wireEvents() {
    el.searchInput.addEventListener("input", onSearchInput);
    el.searchInput.addEventListener("focus", onSearchInput);
    document.addEventListener("click", (e) => {
      if (!el.searchResults.contains(e.target) && e.target !== el.searchInput) {
        el.searchResults.style.display = "none";
      }
    });
    el.addFocusBtn.addEventListener("click", () => {
      if (state.focusId) addTerm(state.focusId);
    });

    el.tabs.forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    el.exampleChips.forEach((btn) => {
      btn.addEventListener("click", () => loadExample(btn.dataset.example));
    });

    el.exportBtn.addEventListener("click", exportPdf);
    el.copyLinkBtn.addEventListener("click", copyShareLink);
    el.exportJsonBtn.addEventListener("click", exportJson);

    el.suggestModeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeSuggestMode = btn.dataset.suggestMode;
        el.suggestModeBtns.forEach((b) => b.classList.toggle("active", b === btn));
        renderSuggestList();
      });
    });
  }

  function loadExample(key) {
    const ids = EXAMPLES[key];
    if (!ids) return;
    state.selected.clear();
    for (const id of ids) {
      const info = HPOGraph.termInfo(id);
      if (info) state.selected.set(id, { id, name: info.name });
    }
    renderSelectedList();
    focusOn(ids[ids.length - 1]);
    switchTab("disease");
  }

  function onSearchInput() {
    const q = el.searchInput.value.trim();
    if (q.length < 2) {
      el.searchResults.style.display = "none";
      return;
    }
    const qlc = q.toLowerCase();
    const like = `%${qlc}%`;
    const idMatch = /^HP:\d+$/i.test(q);
    let rows;
    if (idMatch) {
      rows = HPODB.all("SELECT id, name FROM terms WHERE id = ? AND obsolete = 0", [q.toUpperCase()]);
    } else {
      // Rank name matches above synonym-only matches (a synonym hit on a
      // short-named, unrelated-looking term used to outrank an actual
      // substring match in the term's own name -- e.g. searching "finger"
      // surfaced "Clubbing" before "Finger pain").
      rows = HPODB.all(
        `SELECT t.id, t.name, MIN(
           CASE
             WHEN t.name_lc LIKE ? THEN 0
             WHEN s.synonym_lc LIKE ? THEN 1
             ELSE 2
           END
         ) AS match_rank
         FROM terms t
         LEFT JOIN synonyms s ON s.term_id = t.id
         WHERE t.obsolete = 0 AND (t.name_lc LIKE ? OR s.synonym_lc LIKE ?)
         GROUP BY t.id
         ORDER BY match_rank ASC, t.name_lc ASC
         LIMIT 25`,
        [like, like, like, like]
      );
    }
    renderSearchResults(rows);
  }

  function renderSearchResults(rows) {
    el.searchResults.innerHTML = "";
    if (!rows.length) {
      el.searchResults.style.display = "none";
      return;
    }
    for (const r of rows) {
      const div = document.createElement("div");
      div.className = "hg-search-result-item";
      div.innerHTML = `<span class="hg-id">${r.id}</span> ${escapeHtml(r.name)}`;
      div.addEventListener("click", () => {
        el.searchResults.style.display = "none";
        el.searchInput.value = "";
        focusOn(r.id);
      });
      el.searchResults.appendChild(div);
    }
    el.searchResults.style.display = "block";
  }

  function focusOn(termId) {
    const info = HPOGraph.termInfo(termId);
    if (!info) return;
    state.focusId = termId;

    const spec = HPODB.one(
      "SELECT spec_rank, direct_final_score, direct_gene_count, direct_disease_count FROM terms WHERE id=?",
      [termId]
    );
    const totalTerms = HPODB.one("SELECT COUNT(*) AS n FROM terms WHERE obsolete=0")?.n ?? 0;
    let specLine = "";
    if (spec) {
      specLine = `
        <div class="hg-focus-spec">
          Informativeness rank <b>#${spec.spec_rank.toLocaleString()}</b> of ${totalTerms.toLocaleString()}
          (score ${spec.direct_final_score.toFixed(2)}) ·
          ${spec.direct_gene_count} gene${spec.direct_gene_count === 1 ? "" : "s"},
          ${spec.direct_disease_count} disease${spec.direct_disease_count === 1 ? "" : "s"} (direct annotations)
        </div>`;
    }
    el.focusLabel.innerHTML = `<span class="hg-id">${termId}</span> ${escapeHtml(info.name)}${specLine}`;
    el.addFocusBtn.disabled = false;

    HPOGraph.render(el.graphContainer, termId, {
      onNodeClick: (id) => focusOn(id),
      onAdd: (id) => addTerm(id),
    });
  }

  function addTerm(termId) {
    if (state.selected.has(termId)) return;
    const info = HPOGraph.termInfo(termId);
    if (!info) return;
    state.selected.set(termId, { id: termId, name: info.name });
    renderSelectedList();
    // Always (re)rank, not just when the Diseases/Genes tab is active -- the
    // Selected tab's "Top matches so far" summary needs fresh scores too.
    runRanking();
  }

  function removeTerm(termId) {
    state.selected.delete(termId);
    renderSelectedList();
    runRanking();
  }

  function renderSelectedList() {
    el.tabSelected.textContent = `Selected (${state.selected.size})`;
    el.selectedList.innerHTML = "";
    if (!state.selected.size) {
      el.selectedList.innerHTML =
        '<div class="hg-empty">No HPO terms selected yet. Search above, then "Add to selected".</div>';
    } else {
      for (const { id, name } of state.selected.values()) {
        const row = document.createElement("div");
        row.className = "hg-selected-row";
        row.innerHTML = `
          <button class="hg-remove-btn" title="Remove">✕</button>
          <span class="hg-id">${id}</span>
          <span class="hg-term-name">${escapeHtml(name)}</span>
        `;
        row.querySelector(".hg-remove-btn").addEventListener("click", () => removeTerm(id));
        el.selectedList.appendChild(row);
      }
    }
    el.exportActions.style.display = state.selected.size ? "flex" : "none";
    updateShareUrl();
    renderRelationships();
  }

  // ---- export: a one-page PDF report of the phenotype set (and, if
  // available, the current ranking) generated entirely client-side with
  // jsPDF -- no server, so nothing about the patient's phenotype set ever
  // leaves the browser. ----

  // Same hue sweep as scoreColor() (blue=low -> red=high), but returning an
  // RGB triple since jsPDF's setTextColor() needs numeric channels, not a
  // CSS hsl() string.
  function scoreRgb(pct) {
    const clamped = Math.min(Math.max(pct, 0), 100);
    const h = (240 - (clamped / 100) * 240) / 360;
    const s = 0.75;
    const l = 0.48;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  function truncatePdf(str, max) {
    if (!str) return "";
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  }

  function generatePdfReport() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      console.warn("jsPDF failed to load -- cannot generate report.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const marginX = 16;
    const maxY = 275; // leaves room for the footer below
    let y = 18;

    const setFont = (size, style, color) => {
      doc.setFont("helvetica", style || "normal");
      doc.setFontSize(size);
      const c = color || [30, 30, 30];
      doc.setTextColor(c[0], c[1], c[2]);
    };
    const room = (next) => y + next <= maxY;

    // -- header --
    setFont(18, "bold", [11, 18, 32]);
    doc.text("HPOGraph — Phenotype Report", marginX, y);
    y += 6;
    setFont(9, "normal", [110, 110, 110]);
    const now = new Date();
    doc.text(`Generated ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`, marginX, y);
    y += 4;
    doc.setDrawColor(24, 184, 160);
    doc.setLineWidth(0.6);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 8;

    // -- selected phenotypes --
    setFont(12, "bold", [11, 18, 32]);
    doc.text(`Selected phenotypes (${state.selected.size})`, marginX, y);
    y += 6;
    for (const { id, name } of state.selected.values()) {
      if (!room(5)) break;
      setFont(9.5, "bold");
      doc.text(id, marginX, y);
      setFont(9.5, "normal");
      doc.text(truncatePdf(name, 85), marginX + 28, y);
      y += 5;
    }
    y += 3;

    // -- phenotype-set relationships (only meaningful with 2+ terms) --
    const ids = Array.from(state.selected.keys());
    if (ids.length >= 2 && room(16)) {
      const allCats = new Map();
      for (const id of ids) {
        for (const c of Ranking.categoriesFor(id)) allCats.set(c.id, c.name);
      }
      const pairs = Ranking.pairwiseDistances(ids);
      const avgDist = pairs.reduce((s, p) => s + p.distance, 0) / pairs.length;
      const minDist = Math.min(...pairs.map((p) => p.distance));

      setFont(12, "bold", [11, 18, 32]);
      doc.text("Phenotype-set relationships", marginX, y);
      y += 6;
      setFont(9.5, "normal");
      const catLine = `${allCats.size} organ system${allCats.size === 1 ? "" : "s"} spanned: ${truncatePdf(
        Array.from(allCats.values()).join(", "),
        90
      )}`;
      doc.text(catLine, marginX, y);
      y += 5;
      doc.text(
        `Average pairwise distance ${(avgDist * 100).toFixed(0)}% · closest pair ${(minDist * 100).toFixed(0)}% apart`,
        marginX,
        y
      );
      y += 7;
    }

    // -- top candidate diseases --
    if (state.lastDiseaseScores.length && room(14)) {
      setFont(12, "bold", [11, 18, 32]);
      doc.text("Top candidate diseases", marginX, y);
      y += 6;
      setFont(8, "bold", [110, 110, 110]);
      doc.text("SCORE", marginX, y);
      doc.text("ID", marginX + 18, y);
      doc.text("NAME", marginX + 48, y);
      y += 4.5;
      for (const s of state.lastDiseaseScores.slice(0, 8)) {
        if (!room(5)) break;
        const pct = Math.round(s.score * 100);
        setFont(9, "bold", scoreRgb(pct));
        doc.text(`${pct}%`, marginX, y);
        setFont(9, "normal");
        doc.text(s.diseaseId, marginX + 18, y);
        doc.text(truncatePdf(diseaseName(s.diseaseId), 62), marginX + 48, y);
        y += 5;
      }
      y += 3;
    }

    // -- top candidate genes --
    if (state.lastGeneScores.length && room(14)) {
      setFont(12, "bold", [11, 18, 32]);
      doc.text("Top candidate genes", marginX, y);
      y += 6;
      setFont(8, "bold", [110, 110, 110]);
      doc.text("SCORE", marginX, y);
      doc.text("GENE", marginX + 18, y);
      doc.text("BEST-SUPPORTING DISEASE", marginX + 40, y);
      y += 4.5;
      for (const g of state.lastGeneScores.slice(0, 8)) {
        if (!room(5)) break;
        const pct = Math.round(g.score * 100);
        setFont(9, "bold", scoreRgb(pct));
        doc.text(`${pct}%`, marginX, y);
        setFont(9, "normal");
        doc.text(g.symbol, marginX + 18, y);
        doc.text(truncatePdf(diseaseName(g.bestDisease), 55), marginX + 40, y);
        y += 5;
      }
    }

    // -- footer disclaimer, pinned near the bottom of the page --
    const footerY = 282;
    doc.setDrawColor(215, 222, 224);
    doc.setLineWidth(0.3);
    doc.line(marginX, footerY - 5, pageWidth - marginX, footerY - 5);
    setFont(7.5, "italic", [110, 110, 110]);
    const disclaimer =
      "HPOGraph is a decision-support aid for exploring phenotype-driven differential diagnoses -- it is not a diagnostic tool. " +
      "Findings should be independently verified against primary sources before any clinical use. Data: HPO Consortium, OMIM, Orphanet, HGNC.";
    doc.text(doc.splitTextToSize(disclaimer, pageWidth - marginX * 2), marginX, footerY);

    doc.save(`hpograph-report-${now.toISOString().slice(0, 10)}.pdf`);
  }

  // Briefly swap a button's label to confirm an action succeeded (or
  // failed), then restore it. Shared by every export/share button below.
  function flashButton(btn, tempHtml, ms = 1800) {
    const original = btn.innerHTML;
    btn.classList.add("copied");
    btn.innerHTML = tempHtml;
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = original;
    }, ms);
  }

  function exportPdf() {
    try {
      generatePdfReport();
      flashButton(el.exportBtn, '<i class="fa fa-check"></i> Report downloaded!');
    } catch (e) {
      console.error("PDF generation failed:", e);
      flashButton(el.exportBtn, '<i class="fa fa-exclamation-triangle"></i> Failed -- see console');
    }
  }

  // ---- share/export: a shareable URL (?terms=...) and a full JSON export
  // of the current phenotype set plus its disease/gene rankings. Everything
  // here stays client-side -- the "shareable URL" is just this same static
  // page with a query string, and JSON export is a Blob download, no server
  // involved. ----

  function copyToClipboard(text, onDone) {
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e) {
        console.warn("Copy failed:", e);
      }
      document.body.removeChild(ta);
      onDone();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onDone, fallback);
    } else {
      fallback();
    }
  }

  function copyShareLink() {
    copyToClipboard(location.href, () => {
      flashButton(el.copyLinkBtn, '<i class="fa fa-check"></i> Copied!');
    });
  }

  function downloadBlob(filename, mimeType, content) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Full export: selected terms plus the complete current disease/gene
  // rankings (not just the terms) -- everything currently cached in state
  // from the last runRanking() pass, reshaped into a self-describing JSON
  // document.
  function exportJson() {
    const terms = Array.from(state.selected.values());
    const diseases = state.lastDiseaseScores.map((s) => ({
      id: s.diseaseId,
      name: diseaseName(s.diseaseId),
      source: s.diseaseId.split(":")[0],
      score: Number(s.score.toFixed(4)),
      scorePercent: Math.round(s.score * 100),
      annotatedTerms: s.nTerms,
    }));
    const genes = state.lastGeneScores.map((g) => ({
      symbol: g.symbol,
      score: Number(g.score.toFixed(4)),
      scorePercent: Math.round(g.score * 100),
      bestSupportingDisease: { id: g.bestDisease, name: diseaseName(g.bestDisease) },
      matchedDiseaseCount: g.nMatchedDiseases,
      associationTypes: g.associationTypes,
    }));
    const payload = {
      tool: "HPOGraph",
      exported: new Date().toISOString(),
      terms,
      diseases,
      genes,
    };
    downloadBlob(
      `hpograph-export-${new Date().toISOString().slice(0, 10)}.json`,
      "application/json",
      JSON.stringify(payload, null, 2)
    );
    flashButton(el.exportJsonBtn, '<i class="fa fa-check"></i> Saved!');
  }

  // Keep the URL's ?terms= param in sync with the current selection, so the
  // address bar itself is always a valid, shareable link (no explicit
  // "generate link" step needed -- Copy Link just copies location.href).
  function updateShareUrl() {
    const url = new URL(location.href);
    if (state.selected.size) {
      url.searchParams.set("terms", Array.from(state.selected.keys()).join(","));
    } else {
      url.searchParams.delete("terms");
    }
    history.replaceState(null, "", url.toString());
  }

  // On page load, preselect terms from a shared ?terms=HP:x,HP:y URL.
  // Unknown/invalid IDs are silently skipped rather than failing the whole
  // load. Returns true if at least one valid term was preselected.
  function loadTermsFromUrl() {
    const raw = new URLSearchParams(location.search).get("terms");
    if (!raw) return false;
    const ids = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    let lastValid = null;
    for (const id of ids) {
      const info = HPOGraph.termInfo(id);
      if (info) {
        state.selected.set(id, { id, name: info.name });
        lastValid = id;
      }
    }
    if (!lastValid) return false;
    renderSelectedList();
    focusOn(lastValid);
    // Stay on the Selected tab (the default) rather than jumping the user
    // straight to Diseases -- opening a shared link shouldn't change which
    // tab is active out from under them. Ranking still runs immediately so
    // the "Top matches so far" summary and tab counts are ready either way.
    runRanking();
    return true;
  }

  // ---- phenotype-set relationships: how close/far are the selected terms
  // from each other, and how many organ systems do they span? ----
  function renderRelationships() {
    const ids = Array.from(state.selected.keys());
    if (ids.length < 2) {
      el.relationshipsPanel.innerHTML = "";
      return;
    }

    const allCats = new Map(); // id -> name
    for (const id of ids) {
      for (const c of Ranking.categoriesFor(id)) allCats.set(c.id, c.name);
    }

    const pairs = Ranking.pairwiseDistances(ids);
    pairs.sort((a, b) => a.distance - b.distance);

    el.relationshipsPanel.innerHTML = `
      <div class="hg-rel-head">Phenotype set relationships</div>
      <div class="hg-rel-cats">
        <b>${allCats.size}</b> organ system${allCats.size === 1 ? "" : "s"} spanned:
        ${Array.from(allCats.values()).map((n) => `<span class="hg-pill blue">${escapeHtml(n)}</span>`).join(" ")}
      </div>
      <div class="hg-rel-table">
        ${pairs
          .map(
            (p) => `
          <div class="hg-rel-row">
            <div class="hg-rel-pair"><span class="hg-id">${p.a}</span> ${escapeHtml(p.aName)} &harr; <span class="hg-id">${p.b}</span> ${escapeHtml(p.bName)}</div>
            <div class="hg-rel-meta">
              closeness ${(p.similarity * 100).toFixed(0)}% · distance ${(p.distance * 100).toFixed(0)}%
              · shared ancestor: ${p.micaName ? escapeHtml(p.micaName) : "—"}
            </div>
          </div>`
          )
          .join("")}
      </div>
    `;
  }

  function switchTab(tab) {
    state.activeTab = tab;
    el.tabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
    Object.entries(el.panels).forEach(([key, panel]) => {
      panel.style.display = key === tab ? "block" : "none";
    });
    if (tab === "disease" || tab === "gene") {
      runRanking();
    }
  }

  let rankingToken = 0;
  async function runRanking() {
    const myToken = ++rankingToken;
    const terms = Array.from(state.selected.keys());
    if (!terms.length) {
      el.rankStatus.textContent = "Select one or more HPO terms to see ranked diseases and genes.";
      el.diseaseList.innerHTML = "";
      el.geneList.innerHTML = "";
      if (el.clingenList) el.clingenList.innerHTML = "";
      el.tabDisease.textContent = "Diseases";
      el.tabGene.textContent = "Genes";
      if (el.tabClinGen) el.tabClinGen.textContent = "ClinGen";
      el.tabSuggest.textContent = "Suggest";
      state.lastDiseaseScores = [];
      state.lastGeneScores = [];
      renderTopCandidatesSummary();
      renderSuggestions();
      return;
    }
    el.rankStatus.textContent = `Scoring against ${terms.length} selected term(s)…`;
    // Yield to the browser so the status message paints before the (synchronous) scoring runs.
    await new Promise((r) => setTimeout(r, 20));

    const t0 = performance.now();
    const diseaseScores = Ranking.rankDiseases(terms);
    const geneScores = Ranking.rankGenes(diseaseScores);
    const elapsed = (performance.now() - t0).toFixed(0);

    if (myToken !== rankingToken) return; // stale, a newer ranking has started

    state.lastDiseaseScores = diseaseScores;
    state.lastGeneScores = geneScores;
    state.expandedDiseaseIds.clear();
    state.expandedGeneSymbols.clear();
    state.expandedClinGenSymbols.clear();

    el.rankStatus.textContent = `${diseaseScores.length} candidate diseases scored in ${elapsed} ms.`;
    el.tabDisease.textContent = `Diseases (${diseaseScores.length})`;
    el.tabGene.textContent = `Genes (${geneScores.length})`;
    // Each render step is isolated: a bug or bad data in any single one
    // (e.g. an optional ClinGen table being unexpectedly absent) must never
    // prevent the others from rendering.
    runIsolated("renderDiseaseList", renderDiseaseList);
    runIsolated("renderGeneList", renderGeneList);
    runIsolated("renderClinGenList", renderClinGenList);
    runIsolated("renderTopCandidatesSummary", renderTopCandidatesSummary);
    runIsolated("renderSuggestions", renderSuggestions);
  }

  function runIsolated(name, fn) {
    try {
      fn();
    } catch (e) {
      console.error(`${name}() failed:`, e);
    }
  }

  // ---- "Top matches so far" summary: shown on the Selected tab so a top-1
  // snapshot (per disease source + top gene) is visible without having to
  // switch tabs. Purely a read of already-computed state.lastDiseaseScores /
  // state.lastGeneScores (both pre-sorted best-first by Ranking.rankDiseases
  // / rankGenes) -- no extra scoring work happens here. ----
  function renderTopCandidatesSummary() {
    if (!el.topSummary) return;
    if (!state.selected.size || !state.lastDiseaseScores.length) {
      el.topSummary.innerHTML = "";
      return;
    }

    const topByDb = {};
    for (const s of state.lastDiseaseScores) {
      const db = s.diseaseId.split(":")[0];
      if (!topByDb[db]) topByDb[db] = s; // first hit per db = highest score (list is pre-sorted)
    }
    const topGene = state.lastGeneScores[0] || null;

    const cards = [];
    for (const db of DB_ORDER) {
      const s = topByDb[db];
      if (!s) continue;
      const pct = Math.round(s.score * 100);
      cards.push(`
        <div class="hg-top-card" data-jump-disease="${db}">
          <div class="hg-top-card-label">Top ${DB_LABELS[db] || db}</div>
          <div class="hg-top-card-score" style="color:${scoreColor(pct)}">${pct}%</div>
          <div class="hg-id">${s.diseaseId}</div>
          <div class="hg-top-card-name">${escapeHtml(diseaseName(s.diseaseId))}</div>
          ${clinGenSummaryTagHtml(Ranking.clinGenForDisease ? Ranking.clinGenForDisease(s.diseaseId) : null)}
        </div>
      `);
    }
    if (topGene) {
      const pct = Math.round(topGene.score * 100);
      cards.push(`
        <div class="hg-top-card" data-jump-gene="1">
          <div class="hg-top-card-label">Top gene</div>
          <div class="hg-top-card-score" style="color:${scoreColor(pct)}">${pct}%</div>
          <div class="hg-id">${escapeHtml(topGene.symbol)}</div>
          <div class="hg-top-card-name">${topGene.nMatchedDiseases} linked disease${topGene.nMatchedDiseases === 1 ? "" : "s"}</div>
          ${clinGenSummaryTagHtml(Ranking.clinGenForGene ? Ranking.clinGenForGene(topGene.symbol) : null)}
        </div>
      `);
    }

    if (!cards.length) {
      el.topSummary.innerHTML = "";
      return;
    }

    el.topSummary.innerHTML = `
      <div class="hg-rel-head">Top matches so far</div>
      <div class="hg-top-summary-grid">${cards.join("")}</div>
    `;

    el.topSummary.querySelectorAll("[data-jump-disease]").forEach((card) => {
      card.addEventListener("click", () => {
        state.activeDiseaseSource = card.dataset.jumpDisease;
        switchTab("disease");
      });
    });
    el.topSummary.querySelectorAll("[data-jump-gene]").forEach((card) => {
      card.addEventListener("click", () => switchTab("gene"));
    });
  }

  // ---- "Suggest more phenotypes": which un-selected HPO terms would help
  // narrow things down, based on how they distribute across your current
  // top-ranked candidate diseases? See Ranking.suggestTerms() for the
  // scoring logic. Purely exploratory -- never auto-added, the clinician
  // reviews and clicks "+ Add" themselves. ----
  function renderSuggestions() {
    if (!el.suggestList) return;
    if (!state.selected.size || !state.lastDiseaseScores.length) {
      state.lastSuggestions = { reinforcing: [], discriminative: [] };
      el.tabSuggest.textContent = "Suggest";
      el.suggestList.innerHTML = '<div class="hg-empty">Select at least one term to see suggestions here.</div>';
      return;
    }
    const terms = Array.from(state.selected.keys());
    state.lastSuggestions = Ranking.suggestTerms(terms, state.lastDiseaseScores);
    const distinctCount = new Set([
      ...state.lastSuggestions.discriminative.map((r) => r.hpoId),
      ...state.lastSuggestions.reinforcing.map((r) => r.hpoId),
    ]).size;
    el.tabSuggest.textContent = `Suggest (${distinctCount})`;
    renderSuggestList();
  }

  function renderSuggestList() {
    if (!el.suggestList) return;
    const rows = state.lastSuggestions[state.activeSuggestMode] || [];
    if (!rows.length) {
      el.suggestList.innerHTML = '<div class="hg-empty">No suggestions available for this term set yet.</div>';
      return;
    }
    el.suggestList.innerHTML = rows
      .map((r) => {
        const pct = Math.round(r.coverage * 100);
        return `
          <div class="hg-suggest-row">
            <div>
              <span class="hg-id">${r.hpoId}</span> ${escapeHtml(r.name)}
              <div class="hg-rank-meta">in ${r.diseaseCount}/${r.nCandidates} top candidates (${pct}%)</div>
            </div>
            <button class="hg-suggest-add-btn" data-add-term="${r.hpoId}">+ Add</button>
          </div>
        `;
      })
      .join("");
    el.suggestList.querySelectorAll("[data-add-term]").forEach((btn) => {
      btn.addEventListener("click", () => addTerm(btn.dataset.addTerm));
    });
  }

  function diseaseName(id) {
    const row = HPODB.one("SELECT name FROM disease WHERE id=?", [id]);
    return row ? row.name : id;
  }

  // Score -> a position on a rainbow (blue = low, through green/yellow, to
  // red = high), plus a bar filled to the score's width -- both the fill
  // amount and the hue communicate the magnitude.
  function scoreColor(pct) {
    const clamped = Math.min(Math.max(pct, 0), 100);
    const hue = 240 - (clamped / 100) * 240; // 240=blue -> 120=green -> 0=red
    return `hsl(${hue.toFixed(0)}, 75%, 48%)`;
  }

  function renderDiseaseList() {
    const scores = state.lastDiseaseScores;
    el.diseaseList.innerHTML = "";
    if (!scores.length) {
      el.diseaseList.innerHTML = '<div class="hg-empty">No matching diseases found for this term set.</div>';
      return;
    }

    const byDb = { OMIM: [], ORPHA: [], DECIPHER: [] };
    for (const s of scores) {
      const db = s.diseaseId.split(":")[0];
      (byDb[db] || (byDb[db] = [])).push(s);
    }

    const availableSources = DB_ORDER.filter((db) => byDb[db] && byDb[db].length);
    if (!availableSources.includes(state.activeDiseaseSource)) {
      state.activeDiseaseSource = availableSources[0] || "OMIM";
    }

    const subtabs = `
      <div class="hg-subtab-bar">
        ${availableSources
          .map(
            (db) => `
          <button class="hg-subtab-btn ${db === state.activeDiseaseSource ? "active" : ""}" data-source="${db}">
            ${DB_LABELS[db] || db} (${byDb[db].length})
          </button>`
          )
          .join("")}
      </div>
    `;

    const patientTerms = Array.from(state.selected.keys());
    const list = byDb[state.activeDiseaseSource] || [];
    const shown = list.slice(0, ROWS_PER_SOURCE);
    const rowsHtml = `
      ${shown.map((s) => diseaseRowHtml(s)).join("")}
      ${list.length > ROWS_PER_SOURCE ? `<div class="hg-empty">Showing top ${ROWS_PER_SOURCE} of ${list.length} ${DB_LABELS[state.activeDiseaseSource]} matches.</div>` : ""}
    `;

    el.diseaseList.innerHTML = subtabs + rowsHtml;

    el.diseaseList.querySelectorAll("[data-source]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeDiseaseSource = btn.dataset.source;
        renderDiseaseList();
      });
    });

    el.diseaseList.querySelectorAll("[data-toggle-disease]").forEach((elm) => {
      elm.addEventListener("click", () => {
        const id = elm.dataset.toggleDisease;
        if (state.expandedDiseaseIds.has(id)) state.expandedDiseaseIds.delete(id);
        else state.expandedDiseaseIds.add(id);
        renderDiseaseList();
      });
    });
    for (const did of state.expandedDiseaseIds) {
      const holder = el.diseaseList.querySelector(`[data-detail-disease="${cssId(did)}"]`);
      if (!holder) continue;
      const matches = Ranking.explainDisease(patientTerms, did);
      holder.innerHTML = `
        <div class="hg-explain-head">Which selected terms matched, and to what on this disease:</div>
        ${matches
          .map(
            (m) => `
          <div class="hg-explain-row">
            <span class="hg-id">${m.patientTerm}</span> ${escapeHtml(m.patientTermName)}
            &rarr; <span class="hg-id">${m.diseaseTerm || "—"}</span> ${escapeHtml(m.diseaseTermName || "no match")}
            <span class="hg-rank-meta">similarity ${((m.sim || 0) * 100).toFixed(0)}%${
              m.frequency != null ? ` · frequency ${(m.frequency * 100).toFixed(0)}%` : " · frequency unknown (assumed 50%)"
            }</span>
          </div>`
          )
          .join("")}
      `;
    }
  }

  function diseaseRowHtml({ diseaseId, score, nTerms }) {
    const name = diseaseName(diseaseId);
    const pct = Math.round(score * 100);
    const expanded = state.expandedDiseaseIds.has(diseaseId);
    return `
      <div class="hg-rank-row ${expanded ? "expanded" : ""}" data-toggle-disease="${diseaseId}">
        <div class="hg-rank-bar" style="width:${pct}%; background:${scoreColor(pct)}"></div>
        <div class="hg-rank-row-content">
          <span class="hg-rank-score">${pct}%</span>
          <span class="hg-id">${diseaseId}</span>
          <span class="hg-term-name">${escapeHtml(name)}</span>
          ${clinGenDiseaseBadgeHtml(diseaseId)}
          <span class="hg-rank-meta">${nTerms} annotated terms · click to see why</span>
        </div>
        ${expanded ? `<div class="hg-explain-box" data-detail-disease="${cssId(diseaseId)}"></div>` : ""}
      </div>
    `;
  }

  // Disease-specific ClinGen badge -- distinct from clinGenBadgeHtml() on
  // gene rows, which reflects a gene's best classification across ALL its
  // linked diseases. This one only shows when Mondo's exact-match crosswalk
  // resolves this exact candidate disease to a Mondo ID that ClinGen has
  // curated directly (see Ranking.clinGenForDisease) -- i.e. it's evidence
  // for this disease specifically, not inferred via a shared gene.
  function clinGenDiseaseBadgeHtml(diseaseId) {
    try {
      if (!Ranking.clinGenForDisease) return "";
      const info = Ranking.clinGenForDisease(diseaseId);
      if (!info || !info.best) return "";
      const color = CLINGEN_BADGE_COLORS[info.best.classification] || "#6b7280";
      return `<span class="hg-clingen-badge" style="color:${color}; border-color:${color}" title="ClinGen (this disease, via ${escapeHtml(
        info.best.gene_symbol || ""
      )}): ${escapeHtml(info.best.classification)}">ClinGen: ${escapeHtml(info.best.classification)}</span>`;
    } catch (e) {
      console.warn(`ClinGen disease badge failed for ${diseaseId}:`, e);
      return "";
    }
  }

  // Only surface a ClinGen tag on the "Top matches so far" summary cards for
  // stronger classifications (Definitive/Strong/Moderate) -- Limited,
  // Disputed, Refuted, and "No Known Disease Relationship" are meaningful in
  // the Diseases/Genes/ClinGen tabs but too weak a signal to earn space on
  // this compact, at-a-glance summary. Accepts an already-fetched
  // clinGenForDisease()/clinGenForGene() result (or null/undefined) so
  // callers don't need their own try/catch.
  const CLINGEN_SUMMARY_TIERS = new Set(["Definitive", "Strong", "Moderate"]);
  function clinGenSummaryTagHtml(info) {
    try {
      if (!info || !info.best) return "";
      const classification = info.best.classification;
      if (!CLINGEN_SUMMARY_TIERS.has(classification)) return "";
      const color = CLINGEN_BADGE_COLORS[classification] || "#6b7280";
      return `<span class="hg-clingen-badge hg-top-card-clingen" style="color:${color}; border-color:${color}">ClinGen: ${escapeHtml(
        classification
      )}</span>`;
    } catch (e) {
      console.warn("ClinGen summary tag failed:", e);
      return "";
    }
  }

  function renderGeneList() {
    const scores = state.lastGeneScores;
    el.geneList.innerHTML = "";
    if (!scores.length) {
      el.geneList.innerHTML = '<div class="hg-empty">No matching genes found for this term set.</div>';
      return;
    }
    const shown = scores.slice(0, 50);
    el.geneList.innerHTML = shown.map((g) => geneRowHtml(g)).join("");
    if (scores.length > 50) {
      el.geneList.innerHTML += `<div class="hg-empty">Showing top 50 of ${scores.length} genes.</div>`;
    }

    el.geneList.querySelectorAll("[data-toggle-gene]").forEach((elm) => {
      elm.addEventListener("click", () => {
        const sym = elm.dataset.toggleGene;
        if (state.expandedGeneSymbols.has(sym)) state.expandedGeneSymbols.delete(sym);
        else state.expandedGeneSymbols.add(sym);
        renderGeneList();
      });
    });

    for (const sym of state.expandedGeneSymbols) {
      const holder = el.geneList.querySelector(`[data-detail-gene="${cssId(sym)}"]`);
      if (!holder) continue;
      const gene = shown.find((g) => g.symbol === sym) || scores.find((g) => g.symbol === sym);
      if (!gene) continue;
      holder.innerHTML = `
        <div class="hg-explain-head">All linked diseases that matched (not just the best one):</div>
        ${gene.diseases
          .map(
            (d) => `
          <div class="hg-explain-row">
            <span class="hg-id">${d.diseaseId}</span> ${escapeHtml(diseaseName(d.diseaseId))}
            <span class="hg-rank-meta">${Math.round(d.score * 100)}% match · association: ${associationLabel(d.associationType)}</span>
          </div>`
          )
          .join("")}
        <div class="hg-explain-note">
          "Association: unknown" means the source database (usually Orphanet) linked this gene to the
          disease without classifying it as Mendelian or polygenic — it's a gap in the source data's
          labeling, not an uncertain match.
        </div>
      `;
    }
  }

  function associationLabel(type) {
    if (!type) return "unknown";
    return type.toLowerCase();
  }

  function geneRowHtml({ symbol, score, nMatchedDiseases, associationTypes }) {
    const pct = Math.round(score * 100);
    const expanded = state.expandedGeneSymbols.has(symbol);
    const hasUnknown = associationTypes.some((t) => (t || "").toUpperCase() === "UNKNOWN");
    return `
      <div class="hg-rank-row ${expanded ? "expanded" : ""}" data-toggle-gene="${symbol}">
        <div class="hg-rank-bar" style="width:${pct}%; background:${scoreColor(pct)}"></div>
        <div class="hg-rank-row-content">
          <span class="hg-rank-score">${pct}%</span>
          <span class="hg-gene-symbol">${escapeHtml(symbol)}</span>
          ${clinGenBadgeHtml(symbol)}
          <span class="hg-rank-meta">
            ${nMatchedDiseases} linked disease(s) · ${associationTypes.map(associationLabel).join(", ")}
            ${hasUnknown ? '<span title="Source database did not classify this association">ⓘ</span>' : ""}
            · click to see all
          </span>
        </div>
        ${expanded ? `<div class="hg-explain-box" data-detail-gene="${cssId(symbol)}"></div>` : ""}
      </div>
    `;
  }

  // ---- ClinGen: independent expert-panel gene-disease validity curations,
  // joined into our data by gene symbol only (there is no simple, reliable
  // MONDO-to-OMIM/Orphanet disease-level crosswalk, so this cannot be tied to
  // a specific candidate disease -- only to a gene overall). Shown as a
  // compact badge on each gene row, and as its own tab with full detail. ----
  const CLINGEN_BADGE_COLORS = {
    Definitive: "#1f9d55",
    Strong: "#2f855a",
    Moderate: "#b7791f",
    Limited: "#c05621",
    Disputed: "#dc2626",
    Refuted: "#991b1b",
    "No Known Disease Relationship": "#6b7280",
  };

  function clinGenBadgeHtml(symbol) {
    try {
      if (!Ranking.clinGenForGene) return "";
      const info = Ranking.clinGenForGene(symbol);
      if (!info || !info.best) return "";
      const color = CLINGEN_BADGE_COLORS[info.best.classification] || "#6b7280";
      return `<span class="hg-clingen-badge" style="color:${color}; border-color:${color}" title="ClinGen: ${escapeHtml(
        info.best.classification
      )} for ${escapeHtml(info.best.disease_label || "")}">ClinGen: ${escapeHtml(info.best.classification)}</span>`;
    } catch (e) {
      console.warn(`ClinGen badge failed for ${symbol}:`, e);
      return "";
    }
  }

  function renderClinGenList() {
    if (!el.clingenList) return;
    const scores = state.lastGeneScores;
    if (!scores.length) {
      el.clingenList.innerHTML = "";
      if (el.tabClinGen) el.tabClinGen.textContent = "ClinGen";
      return;
    }

    const withClinGen = scores
      .map((g) => ({ gene: g, clinGen: Ranking.clinGenForGene(g.symbol) }))
      .filter((x) => x.clinGen && x.clinGen.best);

    if (el.tabClinGen) el.tabClinGen.textContent = `ClinGen (${withClinGen.length})`;

    if (!withClinGen.length) {
      el.clingenList.innerHTML = '<div class="hg-empty">None of the current candidate genes have a ClinGen curation.</div>';
      return;
    }

    el.clingenList.innerHTML = withClinGen.map(({ gene, clinGen }) => clinGenRowHtml(gene, clinGen)).join("");

    el.clingenList.querySelectorAll("[data-toggle-clingen]").forEach((elm) => {
      elm.addEventListener("click", () => {
        const sym = elm.dataset.toggleClingen;
        if (state.expandedClinGenSymbols.has(sym)) state.expandedClinGenSymbols.delete(sym);
        else state.expandedClinGenSymbols.add(sym);
        renderClinGenList();
      });
    });

    for (const sym of state.expandedClinGenSymbols) {
      const holder = el.clingenList.querySelector(`[data-detail-clingen="${cssId(sym)}"]`);
      if (!holder) continue;
      const entry = withClinGen.find((x) => x.gene.symbol === sym);
      if (!entry) continue;
      holder.innerHTML = clinGenDetailHtml(entry.clinGen);
    }
  }

  function clinGenRowHtml(gene, clinGen) {
    const pct = Math.round(gene.score * 100);
    const symbol = gene.symbol;
    const expanded = state.expandedClinGenSymbols.has(symbol);
    const color = CLINGEN_BADGE_COLORS[clinGen.best.classification] || "#6b7280";
    return `
      <div class="hg-rank-row ${expanded ? "expanded" : ""}" data-toggle-clingen="${symbol}">
        <div class="hg-rank-row-content">
          <span class="hg-gene-symbol">${escapeHtml(symbol)}</span>
          <span class="hg-clingen-badge" style="color:${color}; border-color:${color}">${escapeHtml(clinGen.best.classification)}</span>
          <span class="hg-rank-meta">
            for ${escapeHtml(clinGen.best.disease_label || "")} · your rank ${pct}% ·
            ${clinGen.entries.length} curation${clinGen.entries.length === 1 ? "" : "s"} on file · click for details
          </span>
        </div>
        ${expanded ? `<div class="hg-explain-box" data-detail-clingen="${cssId(symbol)}"></div>` : ""}
      </div>
    `;
  }

  function clinGenDetailHtml(clinGen) {
    const entriesHtml = clinGen.entries
      .map((e) => {
        const color = CLINGEN_BADGE_COLORS[e.classification] || "#6b7280";
        return `
        <div class="hg-explain-row">
          <span class="hg-clingen-badge" style="color:${color}; border-color:${color}">${escapeHtml(e.classification)}</span>
          ${escapeHtml(e.disease_label || "")}
          <span class="hg-rank-meta">
            (${escapeHtml(e.moi || "inheritance unspecified")} ·
            ${escapeHtml((e.classification_date || "").slice(0, 10) || "date unspecified")} ·
            ${escapeHtml(e.gcep || "GCEP unspecified")})
          </span>
          ${e.report_url ? ` · <a href="${e.report_url}" target="_blank" rel="noopener">ClinGen report</a>` : ""}
        </div>
      `;
      })
      .join("");

    const dosageHtml = clinGen.dosageActionability.length
      ? `<div class="hg-explain-head">Dosage sensitivity / clinical actionability:</div>` +
        clinGen.dosageActionability
          .map(
            (d) => `
        <div class="hg-explain-row">
          ${escapeHtml(d.disease_label || "(gene-level)")}<br>
          ${d.dosage_haploinsufficiency ? `Haploinsufficiency: ${escapeHtml(d.dosage_haploinsufficiency)}<br>` : ""}
          ${d.dosage_triplosensitivity ? `Triplosensitivity: ${escapeHtml(d.dosage_triplosensitivity)}<br>` : ""}
          ${d.actionability_classification ? `Actionability: ${escapeHtml(d.actionability_classification)}` : ""}
        </div>
      `
          )
          .join("")
      : "";

    return `
      <div class="hg-explain-head">All ClinGen gene-disease validity curations for this gene:</div>
      ${entriesHtml}
      ${dosageHtml}
    `;
  }

  function cssId(str) {
    return str.replace(/[^a-zA-Z0-9]/g, "_");
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
  }

  boot().catch((err) => {
    console.error(err);
    setLoading(true, "Failed to load: " + err.message);
  });

  return { addTerm, removeTerm };
})();

window.HPOApp = HPOApp;
