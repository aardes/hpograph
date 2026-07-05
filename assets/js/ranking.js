// ranking.js -- phenotype-driven disease & gene ranking.
//
// Method: information-content (IC) weighted semantic similarity between the
// clinician's selected HPO term set and each disease's annotated HPO term set,
// using Lin similarity on the most informative common ancestor (MICA), combined
// via a symmetric best-match average (BMA). This is the same family of
// algorithm used by tools like Phenomizer / OwlSim / LIRICAL for phenotype-driven
// diagnosis. Gene scores are derived from the best-supporting linked disease.
//
// IC per term (`gene_ic`) is precomputed at build time (see scripts/build_db.py)
// from how many distinct GENES are linked to diseases annotated with that term
// or any of its descendants -- rarer, more gene-specific terms carry more
// diagnostic weight. (There is also a separate, non-propagated "spec_rank" /
// "direct_final_score" per term -- a standalone informativeness leaderboard
// metric shown in the UI -- which intentionally does NOT feed this similarity
// engine, since it collapses to ~0 for most ancestor/internal ontology nodes
// that are rarely annotated directly.)

const Ranking = (() => {
  let parents = null; // Map<child, Set<parent>>
  let icMap = null;   // Map<term, ic>
  const ancestorCache = new Map();

  function loadGraph() {
    if (parents) return;
    parents = new Map();
    const edgeRows = HPODB.all("SELECT child, parent FROM edges");
    for (const { child, parent } of edgeRows) {
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child).add(parent);
    }
    icMap = new Map();
    const termRows = HPODB.all("SELECT id, gene_ic FROM terms");
    for (const { id, gene_ic } of termRows) icMap.set(id, gene_ic);
  }

  function ancestors(t) {
    if (ancestorCache.has(t)) return ancestorCache.get(t);
    const seen = new Set([t]);
    const stack = [t];
    while (stack.length) {
      const cur = stack.pop();
      const ps = parents.get(cur);
      if (!ps) continue;
      for (const p of ps) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    ancestorCache.set(t, seen);
    return seen;
  }

  function ic(t) {
    return icMap.get(t) ?? 0.0;
  }

  function micaIC(a, b) {
    const ancA = ancestors(a);
    const ancB = ancestors(b);
    const [small, large] = ancA.size < ancB.size ? [ancA, ancB] : [ancB, ancA];
    let best = 0.0;
    for (const x of small) {
      if (large.has(x)) {
        const v = ic(x);
        if (v > best) best = v;
      }
    }
    return best;
  }

  function linSim(a, b) {
    if (a === b) return 1.0;
    const ica = ic(a);
    const icb = ic(b);
    if (ica + icb === 0) return 0.0;
    return (2 * micaIC(a, b)) / (ica + icb);
  }

  function freqWeight(f) {
    return f === null || f === undefined ? 0.5 : f;
  }

  // Candidate diseases: any disease annotated with a selected term or one of its ancestors.
  function candidateDiseases(patientTerms) {
    const termSet = new Set();
    for (const p of patientTerms) {
      for (const a of ancestors(p)) termSet.add(a);
    }
    const ids = Array.from(termSet);
    const placeholders = ids.map(() => "?").join(",");
    const rows = HPODB.all(
      `SELECT DISTINCT disease_id FROM disease_hpo WHERE hpo_id IN (${placeholders}) AND aspect='P'`,
      ids
    );
    return rows.map((r) => r.disease_id);
  }

  function diseaseTerms(diseaseId) {
    return HPODB.all(
      "SELECT hpo_id, frequency FROM disease_hpo WHERE disease_id=? AND aspect='P'",
      [diseaseId]
    );
  }

  function scoreDisease(patientTerms, dTerms) {
    if (!dTerms.length) return 0;

    let sum1 = 0;
    for (const p of patientTerms) {
      let best = 0;
      for (const { hpo_id, frequency } of dTerms) {
        const s = linSim(p, hpo_id) * freqWeight(frequency);
        if (s > best) best = s;
      }
      sum1 += best;
    }
    const d1 = sum1 / patientTerms.length;

    let sum2 = 0;
    for (const { hpo_id, frequency } of dTerms) {
      let best = 0;
      for (const p of patientTerms) {
        const s = linSim(p, hpo_id) * freqWeight(frequency);
        if (s > best) best = s;
      }
      sum2 += best;
    }
    const d2 = sum2 / dTerms.length;

    return (d1 + d2) / 2;
  }

  function rankDiseases(patientTerms) {
    loadGraph();
    if (!patientTerms.length) return [];
    const candidates = candidateDiseases(patientTerms);
    const scored = candidates.map((did) => {
      const dTerms = diseaseTerms(did);
      return { diseaseId: did, score: scoreDisease(patientTerms, dTerms), nTerms: dTerms.length };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  // Aggregate disease scores into gene scores via gene_disease table.
  // Gene score = best (max) score among its linked diseases. Every matched
  // linked disease is kept (not just the best one) so the UI can show the
  // full supporting evidence, not a single summary line.
  function rankGenes(diseaseScores) {
    const scoreMap = new Map(diseaseScores.map((d) => [d.diseaseId, d.score]));
    const rows = HPODB.all("SELECT gene_symbol, disease_id, association_type FROM gene_disease");
    const byGene = new Map(); // symbol -> { diseases: [{diseaseId, score, associationType}] }

    for (const { gene_symbol, disease_id, association_type } of rows) {
      const s = scoreMap.get(disease_id);
      if (s === undefined) continue;
      if (!byGene.has(gene_symbol)) byGene.set(gene_symbol, []);
      byGene.get(gene_symbol).push({ diseaseId: disease_id, score: s, associationType: association_type });
    }

    const out = [];
    for (const [symbol, diseases] of byGene) {
      diseases.sort((a, b) => b.score - a.score);
      const best = diseases[0];
      out.push({
        symbol,
        score: best.score,
        bestDisease: best.diseaseId,
        nMatchedDiseases: diseases.length,
        associationTypes: Array.from(new Set(diseases.map((d) => d.associationType))),
        diseases, // full list, sorted best-first -- used by the expandable UI
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // ---- explainability: why did this disease score the way it did? ----
  // For each patient-selected term, find its single best-matching term on the
  // disease (and vice versa isn't needed for display -- the patient->disease
  // direction is what a clinician wants: "your term X best matches Y").
  function explainDisease(patientTerms, diseaseId) {
    const dTerms = diseaseTerms(diseaseId);
    const nameOf = (id) => HPODB.one("SELECT name FROM terms WHERE id=?", [id])?.name || id;

    const matches = patientTerms.map((p) => {
      let best = null;
      for (const { hpo_id, frequency } of dTerms) {
        const sim = linSim(p, hpo_id);
        const weighted = sim * freqWeight(frequency);
        if (!best || weighted > best.weighted) {
          best = { diseaseTerm: hpo_id, diseaseTermName: nameOf(hpo_id), sim, frequency, weighted };
        }
      }
      return {
        patientTerm: p,
        patientTermName: nameOf(p),
        ...best,
      };
    });
    matches.sort((a, b) => (b.weighted || 0) - (a.weighted || 0));
    return matches;
  }

  // ---- pairwise relatedness between the selected terms themselves ----
  // distance = 1 - Lin similarity (0 = identical, 1 = maximally unrelated
  // given the corpus); also reports the most informative common ancestor
  // (MICA) so the UI can show *why* two terms are considered close or far.
  function pairwiseDistances(termIds) {
    const nameOf = (id) => HPODB.one("SELECT name FROM terms WHERE id=?", [id])?.name || id;
    const pairs = [];
    for (let i = 0; i < termIds.length; i++) {
      for (let j = i + 1; j < termIds.length; j++) {
        const a = termIds[i];
        const b = termIds[j];
        const sim = linSim(a, b);
        const common = Array.from(ancestors(a)).filter((x) => ancestors(b).has(x));
        let mica = null;
        let micaIcVal = -1;
        for (const c of common) {
          const v = ic(c);
          if (v > micaIcVal) {
            micaIcVal = v;
            mica = c;
          }
        }
        pairs.push({
          a,
          aName: nameOf(a),
          b,
          bName: nameOf(b),
          similarity: sim,
          distance: 1 - sim,
          micaId: mica,
          micaName: mica ? nameOf(mica) : null,
        });
      }
    }
    return pairs;
  }

  // Which top-level organ-system categories (direct children of "Phenotypic
  // abnormality") does each term fall under? A selected set spanning many
  // systems can itself be a signal (points toward syndromic disease).
  const ROOT = "HP:0000118";
  let topCategoriesCache = null;
  function topCategories() {
    if (topCategoriesCache) return topCategoriesCache;
    const nameOf = (id) => HPODB.one("SELECT name FROM terms WHERE id=?", [id])?.name || id;
    const rows = HPODB.all("SELECT child FROM edges WHERE parent=?", [ROOT]);
    topCategoriesCache = rows.map((r) => ({ id: r.child, name: nameOf(r.child) }));
    return topCategoriesCache;
  }
  function categoriesFor(termId) {
    const anc = ancestors(termId);
    return topCategories().filter((c) => anc.has(c.id));
  }

  return {
    loadGraph,
    rankDiseases,
    rankGenes,
    explainDisease,
    pairwiseDistances,
    categoriesFor,
    ancestors,
    ic,
  };
})();
