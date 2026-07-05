// ranking.js -- phenotype-driven disease & gene ranking.
//
// Method: information-content (IC) weighted semantic similarity between the
// clinician's selected HPO term set and each disease's annotated HPO term set,
// using Lin similarity on the most informative common ancestor (MICA), combined
// via a symmetric best-match average (BMA). This is the same family of
// algorithm used by tools like Phenomizer / OwlSim / LIRICAL for phenotype-driven
// diagnosis. Gene scores are derived from the best-supporting linked disease.
//
// IC per term is precomputed at build time (see scripts/build_db.py) from how
// many diseases in the corpus use that term or any of its descendants -- rarer,
// more specific terms carry more diagnostic weight.

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
    const termRows = HPODB.all("SELECT id, ic FROM terms");
    for (const { id, ic } of termRows) icMap.set(id, ic);
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
  // Gene score = best (max) score among its linked diseases; also report match count.
  function rankGenes(diseaseScores) {
    const scoreMap = new Map(diseaseScores.map((d) => [d.diseaseId, d.score]));
    const rows = HPODB.all("SELECT gene_symbol, disease_id, association_type FROM gene_disease");
    const best = new Map(); // symbol -> {score, diseaseId, nMatched, assocTypes:Set}

    for (const { gene_symbol, disease_id, association_type } of rows) {
      const s = scoreMap.get(disease_id);
      if (s === undefined) continue;
      const entry = best.get(gene_symbol);
      if (!entry) {
        best.set(gene_symbol, {
          score: s,
          diseaseId: disease_id,
          nMatched: 1,
          assocTypes: new Set([association_type]),
        });
      } else {
        entry.nMatched += 1;
        entry.assocTypes.add(association_type);
        if (s > entry.score) {
          entry.score = s;
          entry.diseaseId = disease_id;
        }
      }
    }

    const out = [];
    for (const [symbol, v] of best) {
      out.push({
        symbol,
        score: v.score,
        bestDisease: v.diseaseId,
        nMatchedDiseases: v.nMatched,
        associationTypes: Array.from(v.assocTypes),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  return { loadGraph, rankDiseases, rankGenes, ancestors, ic };
})();
