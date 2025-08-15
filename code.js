// KeyScout — review-safe main file

figma.showUI(__html__, { width: 540, height: 492 });

// Auto-refresh on selection/page changes
figma.on("selectionchange", () => figma.ui.postMessage({ type: "SELECTION_CHANGED" }));
figma.on("currentpagechange", () => figma.ui.postMessage({ type: "SELECTION_CHANGED" }));

figma.ui.onmessage = async (msg) => {
  if (!msg) return;

  if (msg.type === "SCAN") {
    const scopeReq = msg.scope || "selection";      // "selection" | "page" | "file"
    const query = (msg.query || "").trim().toLowerCase();
    const kindFilter = msg.kindFilter || "all";     // "all" | "component" | "component_set" | "variable" | "style"

    try {
      // Guard for selection scope
      if (scopeReq === "selection" && (figma.currentPage.selection || []).length === 0) {
        figma.ui.postMessage({ type: "WARNING", message: "Select a component" });
        figma.ui.postMessage({ type: "RESULTS", rows: [], fileKey: figma.fileKey || "" });
        return;
      }

      const rows = await scan(scopeReq, query, kindFilter);
      figma.ui.postMessage({ type: "RESULTS", rows, fileKey: figma.fileKey || "" });

    } catch (e) {
      const msgText = (e && e.message) ? String(e.message) : String(e);

      // Graceful fallback if entire-file scan needs loadAllPagesAsync
      if (
        scopeReq === "file" &&
        /loadAllPagesAsync|documentAccess|findAll/.test(msgText)
      ) {
        // Attempt a safe fallback to current page so users don't see a hard error
        figma.ui.postMessage({
          type: "WARNING",
          message: "Full-file scan needs all pages loaded. Scanning Current Page instead."
        });
        try {
          const rows = await scan("page", query, kindFilter);
          figma.ui.postMessage({ type: "RESULTS", rows, fileKey: figma.fileKey || "" });
          return;
        } catch (_) {
          // If even fallback fails, send a compact error
        }
      }

      // Compact error to status area (no raw stack spam)
      figma.ui.postMessage({ type: "ERROR", message: msgText });
    }
  }
};

// --------------------------- Core scan ---------------------------

async function nodesInScope(scope) {
  if (scope === "selection") {
    return flattenSelection(figma.currentPage.selection || []);
  }
  if (scope === "page") {
    return figma.currentPage.findAll();
  }
  // scope === "file"
  // Load all pages when API is available; otherwise we'll let caller fall back.
  if (typeof figma.loadAllPagesAsync === "function") {
    await figma.loadAllPagesAsync();
    return figma.root.findAll();
  } else {
    // Older builds may not expose loadAllPagesAsync
    // Throw a small error to let caller trigger fallback UX.
    throw new Error("Full-file scan requires loadAllPagesAsync.");
  }
}

function flattenSelection(sel) {
  const out = [];
  for (let i = 0; i < sel.length; i++) collectNodeAndDesc(sel[i], out);
  return out;
}
function collectNodeAndDesc(node, out) {
  out.push(node);
  const any = node;
  if (any.children && Array.isArray(any.children)) {
    for (let i = 0; i < any.children.length; i++) collectNodeAndDesc(any.children[i], out);
  }
}

function nameMatches(name, key, query) {
  if (!query) return true;
  const n = name ? String(name).toLowerCase() : "";
  const k = key ? String(key).toLowerCase() : "";
  return n.includes(query) || k.includes(query);
}
function kindMatches(kind, filter) {
  return filter === "all" ? true : kind === filter;
}

async function scan(scope, query, kindFilter) {
  const rows = [];
  const inScopeNodes = await nodesInScope(scope);

  // Components (variants)
  const compNodes = inScopeNodes.filter((n) => n.type === "COMPONENT");
  for (let i = 0; i < compNodes.length; i++) {
    const c = compNodes[i];
    const cKey = c.key || "—";
    if (!nameMatches(c.name, cKey, query)) continue;
    if (!kindMatches("component", kindFilter)) continue;
    rows.push({ kind: "component", name: c.name, id: c.id, key: cKey });
  }

  // Component sets
  const setNodes = inScopeNodes.filter((n) => n.type === "COMPONENT_SET");
  for (let k = 0; k < setNodes.length; k++) {
    const s = setNodes[k];
    const sKey = s.key || "—";
    if (!nameMatches(s.name, sKey, query)) continue;
    if (!kindMatches("component_set", kindFilter)) continue;
    rows.push({ kind: "component_set", name: s.name, id: s.id, key: sKey });
  }

  // Styles
  const allLocalStyles = []
    .concat(await figma.getLocalPaintStylesAsync())
    .concat(await figma.getLocalTextStylesAsync())
    .concat(await figma.getLocalEffectStylesAsync())
    .concat(await figma.getLocalGridStylesAsync());

  const usedStyleIds = scope === "selection" ? collectUsedStyleIds(inScopeNodes) : null;

  for (let si = 0; si < allLocalStyles.length; si++) {
    const st = allLocalStyles[si];
    if (scope === "selection" && usedStyleIds && !usedStyleIds.has(st.id)) continue;

    const stKey = st.key || "—";
    if (!nameMatches(st.name, stKey, query)) continue;
    if (!kindMatches("style", kindFilter)) continue;

    rows.push({ kind: "style", name: st.name, id: st.id, key: stKey });
  }

  // Variables
  const allLocalVars = await figma.variables.getLocalVariablesAsync();
  const usedVarIds = scope === "selection" ? collectUsedVariableIds(inScopeNodes) : null;

  for (let vi = 0; vi < allLocalVars.length; vi++) {
    const v = allLocalVars[vi];
    if (scope === "selection" && usedVarIds && !usedVarIds.has(v.id)) continue;

    const vKey = v.key || "—";
    if (!nameMatches(v.name, vKey, query)) continue;
    if (!kindMatches("variable", kindFilter)) continue;

    rows.push({ kind: "variable", name: v.name, id: v.id, key: vKey });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

// Helpers for selection scope
function collectUsedStyleIds(nodes) {
  const ids = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i], any = n;
    if (any.fillStyleId) ids.add(any.fillStyleId);
    if (any.strokeStyleId) ids.add(any.strokeStyleId);
    if (any.effectStyleId) ids.add(any.effectStyleId);
    if (any.gridStyleId) ids.add(any.gridStyleId);
    if (n.type === "TEXT" && typeof n.getStyledTextSegments === "function") {
      const segs = n.getStyledTextSegments(["textStyleId", "fillStyleId"]) || [];
      for (let s = 0; s < segs.length; s++) {
        const seg = segs[s];
        if (seg.textStyleId) ids.add(seg.textStyleId);
        if (seg.fillStyleId) ids.add(seg.fillStyleId);
      }
    }
  }
  return ids;
}

function collectUsedVariableIds(nodes) {
  const ids = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i], any = n;
    const bv = any.boundVariables;
    if (bv) {
      for (const key in bv) {
        const val = bv[key];
        if (val && val.type === "VARIABLE_ALIAS" && val.id) ids.add(val.id);
      }
    }
    if (n.type === "TEXT" && typeof n.getStyledTextSegments === "function") {
      const segs = n.getStyledTextSegments(["boundVariables"]) || [];
      for (let s = 0; s < segs.length; s++) {
        const seg = segs[s], b = seg.boundVariables || {};
        for (const kk in b) {
          const vv = b[kk];
          if (vv && vv.type === "VARIABLE_ALIAS" && vv.id) ids.add(vv.id);
        }
      }
    }
  }
  return ids;
}
