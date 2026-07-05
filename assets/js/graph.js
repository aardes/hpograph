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

  function termDefinition(termId) {
    return HPODB.one("SELECT definition FROM terms WHERE id=?", [termId])?.definition || "";
  }

  function escapeHtmlLocal(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
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
      // source=parent, target=child so a top-to-bottom (TB) dagre layout puts
      // the root at the top and leaves toward the bottom, matching how
      // clinicians expect the ontology hierarchy to read.
      elements.push({ data: { id: `${e.child}->${e.parent}`, source: e.parent, target: e.child } });
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
            "text-max-width": "100px",
            "font-size": "9px",
            "text-valign": "bottom",
            "text-margin-y": 6,
            "background-color": "#18B8A0",
            width: 16,
            height: 16,
            "border-width": 2,
            "border-color": "#0e8f7c",
          },
        },
        {
          selector: "node[role = 'focus']",
          style: {
            "background-color": "#0B1220",
            "border-color": "#0B1220",
            width: 22,
            height: 22,
            "font-weight": "bold",
          },
        },
        {
          selector: "node[role = 'child']",
          style: {
            "background-color": "#ffffff",
            "border-color": "#18B8A0",
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#d7dee0",
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

    // Hover tooltip: definition preview before committing to a click.
    const tooltipEl = document.getElementById("graph-tooltip");
    if (tooltipEl) {
      cy.on("mouseover", "node", (evt) => {
        const node = evt.target;
        const id = node.id();
        const info = termInfo(id);
        if (!info) return;
        const def = termDefinition(id);
        const pos = node.renderedPosition();
        tooltipEl.innerHTML = `<span class="hg-tooltip-id">${id}</span>${escapeHtmlLocal(info.name)}${
          def ? `<br>${escapeHtmlLocal(def)}` : ""
        }`;
        tooltipEl.style.left = `${pos.x}px`;
        tooltipEl.style.top = `${pos.y}px`;
        tooltipEl.style.display = "block";
        containerEl.style.cursor = "pointer";
      });
      cy.on("mouseout", "node", () => {
        tooltipEl.style.display = "none";
        containerEl.style.cursor = "";
      });
      cy.on("pan zoom", () => {
        tooltipEl.style.display = "none";
      });
    }

    // Prefer the dagre layout (clean top-down DAG rendering); if the
    // cytoscape-dagre extension failed to load (e.g. CDN hiccup), fall back
    // to cytoscape's built-in breadthfirst layout so the graph still renders.
    try {
      const layout = cy.layout({ name: "dagre", rankDir: "TB", nodeSep: 130, edgeSep: 20, rankSep: 80 });
      layout.run();
    } catch (err) {
      console.warn("dagre layout unavailable, falling back to breadthfirst:", err);
      cy.layout({ name: "breadthfirst", directed: true, spacingFactor: 1.2 }).run();
    }

    // cy.fit() zooms out to fit every node on screen, which makes labels
    // unreadable for high fan-out terms (e.g. a term with 20+ children).
    // Fit first (so panning/zoom bounds are sane), then clamp to a minimum
    // readable zoom and re-center on the focused node -- any nodes that no
    // longer fit are still reachable by panning/scrolling.
    cy.fit(undefined, 30);
    const MIN_ZOOM = 0.85;
    const MAX_ZOOM = 1.4;
    const clamped = Math.min(Math.max(cy.zoom(), MIN_ZOOM), MAX_ZOOM);
    if (clamped !== cy.zoom()) {
      cy.zoom(clamped);
    }
    const focusNode = cy.getElementById(focusId);
    if (focusNode && focusNode.length) {
      cy.center(focusNode);
    }
  }

  return { render, directParents, directChildren, termInfo };
})();
