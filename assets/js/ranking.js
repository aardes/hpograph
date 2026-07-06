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
  let parents = null;  // Map<child, Set<parent>>
  let children = null; // Map<parent, Set<child>> -- reverse of `parents`, built alongside it
  let icMap = null;    // Map<term, ic>
  const ancestorCache = new Map();
  const descendantCache = new Map();

  function loadGraph() {
    if (parents) return;
    parents = new Map();
    children = new Map();
    const edgeRows = HPODB.all("SELECT child, parent FROM edges");
    for (const { child, parent } of edgeRows) {
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child).add(parent);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(child);
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

  // Descendants of a term (self included), used only to widen candidate-disease
  // *recall* below -- semantic similarity scoring still runs on ancestors()
  // alone and is untouched by this.
  function descendants(t) {
    if (descendantCache.has(t)) return descendantCache.get(t);
    const seen = new Set([t]);
    const stack = [t];
    while (stack.length) {
      const cur = stack.pop();
      const cs = children.get(cur);
      if (!cs) continue;
      for (const c of cs) {
        if (!seen.has(c)) {
          seen.add(c);
          stack.push(c);
        }
      }
    }
    descendantCache.set(t, seen);
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

  // Candidate diseases: pre-filter which diseases are even worth scoring,
  // before running the (more expensive) semantic-similarity pass below.
  //
  // Originally this only pulled in diseases annotated with a selected term or
  // one of its ANCESTORS. That under-recalls: if a clinician selects a broad
  // finding like "Abnormality of the hand", a disease annotated only with a
  // specific descendant like "Camptodactyly" shares no ancestor with the
  // selected term from this direction (its own ancestors go further UP
  // toward the root, not down to what the user picked) and would never be
  // considered a candidate at all -- even though "Camptodactyly" obviously IS
  // a kind of hand abnormality.
  //
  // Fix: also pull in each selected term's DESCENDANTS, so diseases annotated
  // with a more specific sub-term of what the user selected are found too.
  // This only widens the candidate *pool*; scoreDisease()/linSim() below are
  // completely unchanged and still compare via ancestors()/MICA as before,
  // so the actual ranking formula and its output for any already-found
  // disease is unaffected.
  //
  // Safety cap: descendant sets explode near the top of the ontology (e.g.
  // an organ-system category can have thousands of descendants) -- expanding
  // those would balloon the candidate pool toward "score every disease" and
  // slow things down for little benefit, since such broad terms are rarely
  // what a clinician actually selects as a specific finding. If a selected
  // term's descendant set is larger than this cap, we skip the downward
  // expansion for that term only (its ancestor-based candidates are still
  // included as before).
  const MAX_DESCENDANTS_FOR_CANDIDATE_EXPANSION = 500;

  function candidateDiseases(patientTerms) {
    const termSet = new Set();
    for (const p of patientTerms) {
      for (const a of ancestors(p)) termSet.add(a);
      const desc = descendants(p);
      if (desc.size <= MAX_DESCENDANTS_FOR_CANDIDATE_EXPANSION) {
        for (const d of desc) termSet.add(d);
      }
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

  // ---- ClinGen gene-disease validity ----
  // ClinGen's Gene-Disease Validity Classification is an independent,
  // expert-panel-curated confidence signal (Definitive / Strong / Moderate /
  // Limited / Disputed / Refuted / No Known Disease Relationship) -- a
  // genuinely different kind of evidence from the phenotype-similarity
  // ranking above. ClinGen keys its curations by MONDO disease ID, which has
  // no built-in mapping to the OMIM/Orphanet IDs our `disease` table uses.
  // `mondo_xref` (from Mondo's own official exact-match crosswalk releases)
  // supplies that mapping directly for ~99% of our OMIM/Orphanet diseases,
  // so most ClinGen rows CAN now be attached to one specific candidate
  // disease (see clinGenForDisease below) rather than only to a gene overall
  // (clinGenForGene). Where no exact Mondo match exists for a disease (or
  // ClinGen has no entry under that Mondo ID), we fall back to the
  // gene-level signal -- less precise, since one gene can be linked to
  // several diseases, but still informative. See README for more detail.
  const CLINGEN_WEIGHT = {
    Definitive: 1.0,
    Strong: 0.85,
    Moderate: 0.6,
    Limited: 0.3,
    "No Known Disease Relationship": 0.1,
    Disputed: 0.05,
    Refuted: 0.0,
  };
  const clinGenCache = new Map();
  const EMPTY_CLINGEN_RESULT = { entries: [], best: null, dosageActionability: [] };

  // ClinGen tables are optional -- older/rebuilt databases may not have them
  // at all. Checked once (via sqlite_master, which always exists) and cached,
  // rather than letting a "no such table" error surface from every gene
  // lookup and potentially abort whatever loop called into this.
  let clinGenTablesAvailable = null;
  function hasClinGenTables() {
    if (clinGenTablesAvailable !== null) return clinGenTablesAvailable;
    try {
      const rows = HPODB.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('clingen_validity','clingen_dosage_actionability')"
      );
      clinGenTablesAvailable = rows.length === 2;
    } catch (e) {
      console.warn("Could not check for ClinGen tables:", e);
      clinGenTablesAvailable = false;
    }
    return clinGenTablesAvailable;
  }

  function clinGenForGene(symbol) {
    if (!hasClinGenTables()) return EMPTY_CLINGEN_RESULT;
    if (clinGenCache.has(symbol)) return clinGenCache.get(symbol);
    try {
      const entries = HPODB.all(
        "SELECT disease_label, mondo_id, moi, classification, classification_date, gcep, report_url FROM clingen_validity WHERE gene_symbol=?",
        [symbol]
      );
      let best = null;
      for (const e of entries) {
        const w = CLINGEN_WEIGHT[e.classification] ?? 0;
        if (!best || w > best.weight) best = { ...e, weight: w };
      }
      const dosageActionability = HPODB.all(
        `SELECT disease_label, dosage_haploinsufficiency, dosage_triplosensitivity, dosage_report_url,
                actionability_classification, actionability_report_url, actionability_group
         FROM clingen_dosage_actionability WHERE gene_symbol=?`,
        [symbol]
      );
      const result = { entries, best, dosageActionability };
      clinGenCache.set(symbol, result);
      return result;
    } catch (e) {
      // Defensive: never let a ClinGen lookup problem break disease/gene
      // ranking or suggestions, which don't depend on this data.
      console.warn(`ClinGen lookup failed for gene ${symbol}:`, e);
      return EMPTY_CLINGEN_RESULT;
    }
  }

  let mondoXrefTableAvailable = null;
  function hasMondoXrefTable() {
    if (mondoXrefTableAvailable !== null) return mondoXrefTableAvailable;
    try {
      const rows = HPODB.all("SELECT name FROM sqlite_master WHERE type='table' AND name='mondo_xref'");
      mondoXrefTableAvailable = rows.length === 1;
    } catch (e) {
      console.warn("Could not check for mondo_xref table:", e);
      mondoXrefTableAvailable = false;
    }
    return mondoXrefTableAvailable;
  }

  const mondoIdCache = new Map();
  // A disease can (rarely) have more than one exact Mondo match; all are
  // returned so clinGenForDisease can check ClinGen records under any of
  // them, but this is uncommon -- Mondo's exact-match crosswalk is designed
  // to be close to 1:1.
  function diseaseMondoIds(diseaseId) {
    if (!hasMondoXrefTable()) return [];
    if (mondoIdCache.has(diseaseId)) return mondoIdCache.get(diseaseId);
    try {
      const rows = HPODB.all("SELECT mondo_id FROM mondo_xref WHERE disease_id=?", [diseaseId]);
      const ids = rows.map((r) => r.mondo_id);
      mondoIdCache.set(diseaseId, ids);
      return ids;
    } catch (e) {
      console.warn(`mondo_xref lookup failed for ${diseaseId}:`, e);
      return [];
    }
  }

  const clinGenByDiseaseCache = new Map();
  // Disease-specific ClinGen lookup: resolves diseaseId -> Mondo ID(s) via
  // mondo_xref, then reads clingen_validity directly by mondo_id -- this is
  // ClinGen data for THIS exact candidate disease, not "some disease linked
  // to one of its genes". Returns EMPTY_CLINGEN_RESULT (no dosage data here,
  // that's still gene-keyed only) if there's no exact Mondo match for this
  // disease, or ClinGen has no record under that Mondo ID.
  function clinGenForDisease(diseaseId) {
    if (!hasClinGenTables() || !hasMondoXrefTable()) return EMPTY_CLINGEN_RESULT;
    if (clinGenByDiseaseCache.has(diseaseId)) return clinGenByDiseaseCache.get(diseaseId);
    try {
      const mondoIds = diseaseMondoIds(diseaseId);
      if (!mondoIds.length) {
        clinGenByDiseaseCache.set(diseaseId, EMPTY_CLINGEN_RESULT);
        return EMPTY_CLINGEN_RESULT;
      }
      const placeholders = mondoIds.map(() => "?").join(",");
      const entries = HPODB.all(
        `SELECT gene_symbol, disease_label, mondo_id, moi, classification, classification_date, gcep, report_url
         FROM clingen_validity WHERE mondo_id IN (${placeholders})`,
        mondoIds
      );
      let best = null;
      for (const e of entries) {
        const w = CLINGEN_WEIGHT[e.classification] ?? 0;
        if (!best || w > best.weight) best = { ...e, weight: w };
      }
      const result = { entries, best, dosageActionability: [] };
      clinGenByDiseaseCache.set(diseaseId, result);
      return result;
    } catch (e) {
      console.warn(`Disease-level ClinGen lookup failed for ${diseaseId}:`, e);
      return EMPTY_CLINGEN_RESULT;
    }
  }

  // ClinGen weight for a candidate disease, most precise source first:
  //   1. Disease-specific match via Mondo's exact-match crosswalk -- this
  //      IS the classification for this exact disease, not an inference.
  //   2. Fallback: best ClinGen weight among the gene(s) linked to this
  //      disease (via gene_disease) -- less precise, since one gene can be
  //      linked to several diseases, but still informative when no exact
  //      Mondo match is available.
  // Returns 0.5 ("neutral") when neither source has any information --
  // absence of a ClinGen curation is common (only ~3,000 of ~45,000 HGNC
  // genes are covered, and not every disease has an exact Mondo match) and
  // should not be read as negative evidence.
  function diseaseClinGenWeight(diseaseId) {
    if (!hasClinGenTables()) return 0.5;
    const direct = clinGenForDisease(diseaseId);
    if (direct.best) return direct.best.weight;
    try {
      const genes = HPODB.all("SELECT DISTINCT gene_symbol FROM gene_disease WHERE disease_id=?", [diseaseId]);
      if (!genes.length) return 0.5;
      let best = null;
      for (const { gene_symbol } of genes) {
        const info = clinGenForGene(gene_symbol);
        if (!info.best) continue; // this gene has no ClinGen record
        if (best === null || info.best.weight > best) best = info.best.weight;
      }
      return best === null ? 0.5 : best;
    } catch (e) {
      console.warn(`ClinGen disease weight lookup failed for ${diseaseId}:`, e);
      return 0.5;
    }
  }

  // ---- phenotype suggestion: which un-selected HPO terms would be most
  // useful to consider next, given how they distribute across your current
  // top-ranked candidate diseases? ----
  //
  // For each of the top N candidate diseases (already sorted best-first by
  // rankDiseases), look at their annotated HPO terms and compute, for every
  // term not already selected, a weighted "coverage fraction" p(t): the
  // share of top-N disease weight (using each disease's own ranking score as
  // its weight) that is annotated with t.
  //
  //   - REINFORCING terms have p(t) close to 1 -- almost every leading
  //     candidate has this finding, so if the patient does too, it
  //     strengthens the current front-runners.
  //   - DISCRIMINATIVE terms have p(t) close to 0.5 -- present in roughly
  //     half the leading candidates and absent in the other half, so a
  //     yes/no on this finding would meaningfully split the field. Scored
  //     with 4*p*(1-p) (a standard Gini/variance-style "how much would this
  //     split help" measure -- 0 at the extremes, 1 at p=0.5), multiplied by
  //     the term's own specificity (gene_ic) so generic, low-information
  //     terms don't crowd out clinically meaningful ones.
  //
  // Only disease-side data is used (not a separate gene-side pass): ranked
  // genes are themselves derived from their best-supporting disease, so a
  // gene's phenotype profile is already reachable through this same
  // disease-annotation data -- a separate gene-based aggregation would
  // mostly duplicate this signal rather than add new information.
  //
  // ClinGen re-weighting: within the pre-filter pool (top diseases by raw
  // phenotype score), each disease's weight is nudged by up to +/-15% based
  // on the best ClinGen validity classification among its linked genes
  // (diseaseClinGenWeight above) before picking the final top-N pool and
  // before aggregating term coverage. This is intentionally a SECONDARY
  // signal layered on top of phenotype similarity, not a replacement for
  // it -- a disease with a mediocre phenotype match can't out-rank a strong
  // match just because of ClinGen, but among otherwise-similar candidates it
  // nudges the suggestion pool toward better-validated gene-disease
  // relationships. The main rankDiseases()/rankGenes() lists above are
  // untouched by this -- only this suggestion pool uses it.
  const SUGGEST_PREFILTER_POOL = 40; // raw-score candidates considered before ClinGen re-weighting
  const SUGGEST_TOP_N_DISEASES = 15; // final pool size after ClinGen adjustment
  const SUGGEST_MIN_DISEASE_COUNT = 2; // ignore terms seen in only one candidate (too noisy to act on)
  const SUGGEST_MAX_RESULTS = 8;

  function suggestTerms(patientTerms, diseaseScores) {
    const selected = new Set(patientTerms);
    const prefiltered = diseaseScores.filter((d) => d.score > 0).slice(0, SUGGEST_PREFILTER_POOL);
    if (!prefiltered.length) return { reinforcing: [], discriminative: [] };

    const top = prefiltered
      .map((d) => {
        const clinGenWeight = diseaseClinGenWeight(d.diseaseId);
        return { ...d, weight: d.score * (0.85 + 0.3 * clinGenWeight), clinGenWeight };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, SUGGEST_TOP_N_DISEASES);

    const totalWeight = top.reduce((s, d) => s + d.weight, 0);
    if (totalWeight <= 0) return { reinforcing: [], discriminative: [] };

    const nameOf = (id) => HPODB.one("SELECT name FROM terms WHERE id=?", [id])?.name || id;

    const agg = new Map(); // hpo_id -> { weight, diseaseCount }
    for (const d of top) {
      const dTerms = diseaseTerms(d.diseaseId);
      for (const { hpo_id } of dTerms) {
        if (selected.has(hpo_id)) continue;
        if (!agg.has(hpo_id)) agg.set(hpo_id, { weight: 0, diseaseCount: 0 });
        const entry = agg.get(hpo_id);
        entry.weight += d.weight;
        entry.diseaseCount += 1;
      }
    }

    const rows = [];
    for (const [hpo_id, { weight, diseaseCount }] of agg) {
      if (diseaseCount < SUGGEST_MIN_DISEASE_COUNT) continue;
      const p = weight / totalWeight;
      rows.push({
        hpoId: hpo_id,
        name: nameOf(hpo_id),
        coverage: p,
        diseaseCount,
        nCandidates: top.length,
        discriminativeScore: 4 * p * (1 - p) * (ic(hpo_id) || 0),
      });
    }

    const reinforcing = [...rows].sort((a, b) => b.coverage - a.coverage).slice(0, SUGGEST_MAX_RESULTS);
    const discriminative = [...rows]
      .sort((a, b) => b.discriminativeScore - a.discriminativeScore)
      .slice(0, SUGGEST_MAX_RESULTS);

    return { reinforcing, discriminative };
  }

  return {
    loadGraph,
    rankDiseases,
    rankGenes,
    explainDisease,
    pairwiseDistances,
    categoriesFor,
    suggestTerms,
    clinGenForGene,
    clinGenForDisease,
    ancestors,
    ic,
  };
})();
