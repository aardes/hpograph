// app.js -- main UI controller wiring search, graph, selected terms, and ranking tabs.

(() => {
  const state = {
    focusId: "HP:0000118", // "Phenotypic abnormality" as a sane default focus
    selected: new Map(), // id -> {id, name}
    activeTab: "selected",
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
    selectedCount: document.getElementById("selected-count"),
    tabs: document.querySelectorAll(".tab-btn"),
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
    focusOn(state.focusId);
    wireEvents();
  }

  function wireEvents() {
    el.searchInput.addEventListener("input", onSearchInput);
    el.searchInput.addEventListener("focus", onSearchInput);
    document.addEventListener("click", (e) => {
      if (!el.searchResults.contains(e.target) && e.target !== el.searchInput) {
        el.searchResults.style.display = "none";
      }
    });
    el.addFocusBtn.addEventListener("click", () => addTerm(state.focusId));

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
    const like = `%${q.toLowerCase()}%`;
    const idMatch = /^HP:\d+$/i.test(q);
    let rows;
    if (idMatch) {
      rows = HPODB.all("SELECT id, name FROM terms WHERE id = ? AND obsolete = 0", [q.toUpperCase()]);
    } else {
      rows = HPODB.all(
        `SELECT DISTINCT t.id, t.name FROM terms t
         LEFT JOIN synonyms s ON s.term_id = t.id
         WHERE t.obsolete = 0 AND (t.name_lc LIKE ? OR s.synonym_lc LIKE ?)
         ORDER BY LENGTH(t.name) ASC
         LIMIT 25`,
        [like, like]
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
      div.className = "search-result-item";
      div.innerHTML = `<span class="hpo-id">${r.id}</span> ${escapeHtml(r.name)}`;
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
    el.focusLabel.innerHTML = `<span class="hpo-id">${termId}</span> ${escapeHtml(info.name)}`;
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
    el.selectedCount.textContent = state.selected.size;
    el.selectedList.innerHTML = "";
    if (!state.selected.size) {
      el.selectedList.innerHTML = '<div class="empty-hint">No HPO terms selected yet. Search above or click a node in the graph, then "Add" it.</div>';
      return;
    }
    for (const { id, name } of state.selected.values()) {
      const row = document.createElement("div");
      row.className = "selected-row";
      row.innerHTML = `
        <button class="remove-btn" title="Remove">✕</button>
        <span class="hpo-id">${id}</span>
        <span class="term-name">${escapeHtml(name)}</span>
      `;
      row.querySelector(".remove-btn").addEventListener("click", () => removeTerm(id));
      el.selectedList.appendChild(row);
    }
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

    el.rankStatus.textContent = `${diseaseScores.length} candidate diseases scored in ${elapsed} ms.`;
    renderDiseaseList(diseaseScores.slice(0, 50));
    renderGeneList(geneScores.slice(0, 50));
  }

  function diseaseName(id) {
    const row = HPODB.one("SELECT name FROM disease WHERE id=?", [id]);
    return row ? row.name : id;
  }

  function renderDiseaseList(scores) {
    el.diseaseList.innerHTML = "";
    if (!scores.length) {
      el.diseaseList.innerHTML = '<div class="empty-hint">No matching diseases found for this term set.</div>';
      return;
    }
    for (const { diseaseId, score, nTerms } of scores) {
      const name = diseaseName(diseaseId);
      const pct = Math.round(score * 100);
      const row = document.createElement("div");
      row.className = "rank-row";
      row.innerHTML = `
        <div class="rank-bar" style="width:${pct}%"></div>
        <div class="rank-row-content">
          <span class="rank-score">${pct}%</span>
          <span class="hpo-id">${diseaseId}</span>
          <span class="term-name">${escapeHtml(name)}</span>
          <span class="rank-meta">${nTerms} annotated terms</span>
        </div>
      `;
      el.diseaseList.appendChild(row);
    }
  }

  function renderGeneList(scores) {
    el.geneList.innerHTML = "";
    if (!scores.length) {
      el.geneList.innerHTML = '<div class="empty-hint">No matching genes found for this term set.</div>';
      return;
    }
    for (const { symbol, score, bestDisease, nMatchedDiseases, associationTypes } of scores) {
      const pct = Math.round(score * 100);
      const name = diseaseName(bestDisease);
      const row = document.createElement("div");
      row.className = "rank-row";
      row.innerHTML = `
        <div class="rank-bar" style="width:${pct}%"></div>
        <div class="rank-row-content">
          <span class="rank-score">${pct}%</span>
          <span class="gene-symbol">${escapeHtml(symbol)}</span>
          <span class="term-name">best match: ${escapeHtml(name)}</span>
          <span class="rank-meta">${nMatchedDiseases} linked disease(s) · ${associationTypes.join(", ").toLowerCase()}</span>
        </div>
      `;
      el.geneList.appendChild(row);
    }
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
})();
