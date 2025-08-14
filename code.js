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
  if (scope ===