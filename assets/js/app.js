// app.js -- single search box drives the graph (left panel); the right panel
// owns the multi-term selection, the disease/gene ranking, and the
// phenotype-set relationship view.

const HPOApp = (() => {
  const DB_LABELS = { OMIM: "OMIM", ORPHA: "Orphanet (ORPHA)", DECIPHER: "DECIPHER" };
  const DB_ORDER = ["OMIM", "ORPHA", "DECIPHER"];
  const ROWS_PER_SOURCE = 50;

  const state = {
    focusId: null,
    selected: new Map(), // id -> {id, name}
    activeTab: "selected",
    activeDiseaseSource: "OMIM",
    lastDiseaseScores: [],
    lastGeneScores: [],
    expandedDiseaseIds: new Set(),
    expandedGeneSymbols: new Set(),
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
    tabSelected: document.getElementById("tab-selected"),
    tabDisease: document.getElementById("tab-disease"),
    tabGene: document.getElementById("tab-gene"),
    tabs: document.querySelectorAll(".hg-tab-btn"),
    panels: {
      selected: document.getElementById("panel-selected"),
      disease: document.getElementById("panel-disease"),
      gene: document.getElementById("panel-gene"),
    },
    diseaseList: document.getElementById("disease-list"),
    geneList: document.getElementById("gene-list"),
    rankStatus: document.getElementById("rank-status"),
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
    renderSelectedList();
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
    if (state.activeTab === "disease" || state.activeTab === "gene") {
      runRanking();
    }
  }

  function removeTerm(termId) {
    state.selected.delete(termId);
    renderSelectedList();
    if (state.activeTab === "disease" || state.activeTab === "gene") {
      runRanking();
    }
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
    renderRelationships();
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
      el.tabDisease.textContent = "Diseases";
      el.tabGene.textContent = "Genes";
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

    el.rankStatus.textContent = `${diseaseScores.length} candidate diseases scored in ${elapsed} ms.`;
    el.tabDisease.textContent = `Diseases (${diseaseScores.length})`;
    el.tabGene.textContent = `Genes (${geneScores.length})`;
    renderDiseaseList();
    renderGeneList();
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
          <span class="hg-rank-meta">${nTerms} annotated terms · click to see why</span>
        </div>
        ${expanded ? `<div class="hg-explain-box" data-detail-disease="${cssId(diseaseId)}"></div>` : ""}
      </div>
    `;
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
