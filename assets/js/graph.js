// graph.js -- renders the HPO neighborhood of a focused term as a DAG using Cytoscape.js.
//
// Unlike a simple tree view, this shows the FULL ancestor closure of the focused
// term (every path back to the root, since HPO is a DAG and a term can have more
// than one parent) plus its direct children. Convergent paths make the multi-parent
// structure visible instead of hiding it behind a single tree branch.

const HPOGraph = (() => {
  let cy = null;

  function directParents(termId) {
    return HPODB.all("SELECT parent FROM edges WHERE child=?", [termId]).map((r) => r.parent);
  }

  function directChildren(termId) {
    return HPODB.all("SELECT child FROM edges WHERE parent=?", [termId]).map((r) => r.child);
  }

  function termInfo(termId) {
    return HPODB.one("SELECT id, name, obsolete FROM terms WHERE id=?", [termId]);
  }

  // Build the set of nodes/edges to display: full ancestor closure of focusId + its direct children.
  function buildNeighborhood(focusId) {
    const nodeIds = new Set([focusId]);
    const edges = [];

    // ancestor closure (BFS upward), recording every is_a edge traversed
    const queue = [focusId];
    const visited = new Set([focusId]);
    while (queue.length) {
      const cur = queue.shift();
      for (const p of directParents(cur)) {
        edges.push({ child: cur, parent: p });
        nodeIds.add(p);
        if (!visited.has(p)) {
          visited.add(p);
          queue.push(p);
        }
      }
    }

    // direct children only (keeps the view navigable; click a child to expand further)
    for (const c of directChildren(focusId)) {
      nodeIds.add(c);
      edges.push({ child: c, parent: focusId });
    }

    return { nodeIds, edges };
  }

  function render(containerEl, focusId, { onNodeClick, onAdd } = {}) {
    const { nodeIds, edges } = buildNeighborhood(focusId);

    const elements = [];
    for (const id of nodeIds) {
      const info = termInfo(id);
      if (!info) continue;
      let role = "ancestor";
      if (id === focusId) role = "focus";
      else if (edges.some((e) => e.child === id && e.parent === focusId)) role = "child";
      elements.push({
        data: { id, label: `${id}\n${info.name}`, role },
      });
    }
    for (const e of edges) {
      elements.push({ data: { id: `${e.child}->${e.parent}`, source: e.child, target: e.parent } });
    }

    if (cy) {
      cy.destroy();
    }

    cy = cytoscape({
      container: containerEl,
      elements,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": "120px",
            "font-size": "9px",
            "text-valign": "bottom",
            "text-margin-y": 6,
            "background-color": "#5ecfc9",
            width: 16,
            height: 16,
            "border-width": 2,
            "border-color": "#3aa9a3",
          },
        },
        {
          selector: "node[role = 'focus']",
          style: {
            "background-color": "#1c3d5a",
            "border-color": "#1c3d5a",
            width: 22,
            height: 22,
            "font-weight": "bold",
          },
        },
        {
          selector: "node[role = 'child']",
          style: {
            "background-color": "#ffffff",
            "border-color": "#5ecfc9",
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#c7d3d6",
            "target-arrow-shape": "none",
            "curve-style": "bezier",
          },
        },
      ],
      wheelSensitivity: 0.2,
    });

    cy.on("tap", "node", (evt) => {
      const id = evt.target.id();
      if (onNodeClick) onNodeClick(id);
    });

    cy.on("dbltap", "node", (evt) => {
      const id = evt.target.id();
      if (onAdd) onAdd(id);
    });

    // Prefer the dagre layout (clean top-down DAG rendering); if the
    // cytoscape-dagre extension failed to load (e.g. CDN hiccup), fall back
    // to cytoscape's built-in breadthfirst layout so the graph still renders.
    try {
      const layout = cy.layout({ name: "dagre", rankDir: "TB", nodeSep: 20, rankSep: 50 });
      layout.run();
    } catch (err) {
      console.warn("dagre layout unavailable, falling back to breadthfirst:", err);
      cy.layout({ name: "breadthfirst", directed: true, spacingFactor: 1.2 }).run();
    }

    cy.fit(undefined, 30);
  }

  return { render, directParents, directChildren, termInfo };
})();
