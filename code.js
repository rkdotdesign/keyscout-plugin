// KeyScout — minimal core (no build tools)
// Make sure manifest has: { "main": "code.js", "ui": "ui.html", "documentAccess": "dynamic-page" }

figma.showUI(__html__, { width: 540, height: 492 });

// Notify UI when selection/page changes
figma.on("selectionchange", function () {
  figma.ui.postMessage({ type: "SELECTION_CHANGED" });
});
figma.on("currentpagechange", function () {
  figma.ui.postMessage({ type: "SELECTION_CHANGED" });
});

figma.ui.onmessage = async (msg) => {
  if (!msg) return;

  if (msg.type === "SCAN") {
    var scope = msg.scope || "selection";
    var query = (msg.query || "").trim().toLowerCase();
    var kindFilter = msg.kindFilter || "all"; // "all" | "component_set" | "component" | "variable" | "style"

    try {
      if (scope === "selection" && (!figma.currentPage.selection || figma.currentPage.selection.length === 0)) {
        figma.ui.postMessage({ type: "WARNING", message: "Select a component" });
        figma.ui.postMessage({ type: "RESULTS", rows: [], fileKey: figma.fileKey || "" });
        return;
      }

      var rows = await scan(scope, query, kindFilter);
      figma.ui.postMessage({ type: "RESULTS", rows: rows, fileKey: figma.fileKey || "" });
    } catch (e) {
      var message = (e && e.message) ? String(e.message) : String(e);
      figma.ui.postMessage({ type: "ERROR", message: message });
    }
  }
};

// --------------------------- Core scan ---------------------------

async function nodesInScope(scope) {
  if (scope === "selection") return flattenSelection(figma.currentPage.selection || []);
  if (scope === "page") return figma.currentPage.findAll();
  await figma.loadAllPagesAsync();
  return figma.root.findAll();
}

function flattenSelection(sel) {
  var out = [];
  for (var i = 0; i < sel.length; i++) collectNodeAndDesc(sel[i], out);
  return out;
}
function collectNodeAndDesc(node, out) {
  out.push(node);
  var any = node;
  if (any.children && Array.isArray(any.children)) {
    for (var i = 0; i < any.children.length; i++) collectNodeAndDesc(any.children[i], out);
  }
}

function nameMatches(name, key, query) {
  if (!query) return true;
  var n = name ? String(name).toLowerCase() : "";
  var k = key ? String(key).toLowerCase() : "";
  return n.indexOf(query) !== -1 || k.indexOf(query) !== -1;
}
function kindMatches(kind, filter) {
  if (filter === "all") return true;
  return kind === filter;
}

async function scan(scope, query, kindFilter) {
  var rows = [];
  var inScopeNodes = await nodesInScope(scope);

  // Components (variants)
  var compNodes = inScopeNodes.filter(function (n) { return n.type === "COMPONENT"; });
  for (var i = 0; i < compNodes.length; i++) {
    var c = compNodes[i];
    var cKey = c.key || "—";
    if (!nameMatches(c.name, cKey, query)) continue;
    if (!kindMatches("component", kindFilter)) continue;

    rows.push({ kind: "component", name: c.name, id: c.id, key: cKey });
  }

  // Component sets
  var setNodes = inScopeNodes.filter(function (n) { return n.type === "COMPONENT_SET"; });
  for (var k = 0; k < setNodes.length; k++) {
    var s = setNodes[k];
    var sKey = s.key || "—";
    if (!nameMatches(s.name, sKey, query)) continue;
    if (!kindMatches("component_set", kindFilter)) continue;

    rows.push({ kind: "component_set", name: s.name, id: s.id, key: sKey });
  }

  // Styles
  var allLocalStyles = []
    .concat(await figma.getLocalPaintStylesAsync())
    .concat(await figma.getLocalTextStylesAsync())
    .concat(await figma.getLocalEffectStylesAsync())
    .concat(await figma.getLocalGridStylesAsync());

  var usedStyleIds = scope === "selection" ? collectUsedStyleIds(inScopeNodes) : null;

  for (var si = 0; si < allLocalStyles.length; si++) {
    var st = allLocalStyles[si];
    if (scope === "selection" && usedStyleIds && !usedStyleIds.has(st.id)) continue;

    var stKey = st.key || "—";
    if (!nameMatches(st.name, stKey, query)) continue;
    if (!kindMatches("style", kindFilter)) continue;

    rows.push({ kind: "style", name: st.name, id: st.id, key: stKey });
  }

  // Variables
  var allLocalVars = await figma.variables.getLocalVariablesAsync();
  var usedVarIds = scope === "selection" ? collectUsedVariableIds(inScopeNodes) : null;

  for (var vi = 0; vi < allLocalVars.length; vi++) {
    var v = allLocalVars[vi];
    if (scope === "selection" && usedVarIds && !usedVarIds.has(v.id)) continue;

    var vKey = v.key || "—";
    if (!nameMatches(v.name, vKey, query)) continue;
    if (!kindMatches("variable", kindFilter)) continue;

    rows.push({ kind: "variable", name: v.name, id: v.id, key: vKey });
  }

  rows.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return rows;
}

// Helpers: collect used styles/variables for "selection" scope
function collectUsedStyleIds(nodes) {
  var ids = new Set();
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], any = n;
    if (any.fillStyleId) ids.add(any.fillStyleId);
    if (any.strokeStyleId) ids.add(any.strokeStyleId);
    if (any.effectStyleId) ids.add(any.effectStyleId);
    if (any.gridStyleId) ids.add(any.gridStyleId);
    if (n.type === "TEXT" && typeof n.getStyledTextSegments === "function") {
      var segs = n.getStyledTextSegments(["textStyleId", "fillStyleId"]) || [];
      for (var s = 0; s < segs.length; s++) {
        var seg = segs[s];
        if (seg.textStyleId) ids.add(seg.textStyleId);
        if (seg.fillStyleId) ids.add(seg.fillStyleId);
      }
    }
  }
  return ids;
}

function collectUsedVariableIds(nodes) {
  var ids = new Set();
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], any = n;
    var bv = any.boundVariables;
    if (bv) {
      for (var k in bv) {
        var val = bv[k];
        if (val && val.type === "VARIABLE_ALIAS" && val.id) ids.add(val.id);
      }
    }
    if (n.type === "TEXT" && typeof n.getStyledTextSegments === "function") {
      var segs = n.getStyledTextSegments(["boundVariables"]) || [];
      for (var s = 0; s < segs.length; s++) {
        var seg = segs[s], b = seg.boundVariables || {};
        for (var key in b) {
          var vv = b[key];
          if (vv && vv.type === "VARIABLE_ALIAS" && vv.id) ids.add(vv.id);
        }
      }
    }
  }
  return ids;
}
