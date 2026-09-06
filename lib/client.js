// dsh-koyuki-starter — client half (v3: split run button with dropdown,
// bilingual zh/en, runs inside the built-in better-sidebar terminal).
//
// DOM overlay on top of dsh-better-sidebar (no source changes):
//   - every runnable file row (.py/.R/.r/.bat/.cmd) and the editor header
//     gets a pink ▶ control;
//   - clicking ▶ runs in the current terminal (as before);
//   - a ▾ caret opens a small dropdown:
//       1) Run in current terminal
//       2) Run in a new terminal
//   - labels/toasts follow the UI language (html lang / navigator).
window.__ModuleLoader__.load({
  id: "dsh-koyuki-starter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ------------------------------------------------------------- consts
    const HOST_SELECTOR = "[data-dsh-better-sidebar]";
    const RUN_RE = /\.(?:py|r|bat|cmd)$/i;
    const RUN_NAME_RE = /([^\\/\s]+\.(?:py|r|bat|cmd))$/i;
    const CHIP_MARK = "data-dsh-koyuki-starter-chip";
    const BTN_MARK = "data-dsh-koyuki-starter-header-btn";
    const TOAST_MARK = "data-dsh-koyuki-starter-toast";
    const XTERM_TEXTAREA = "textarea.xterm-helper-textarea";
    const PINK = "#f472b6";
    const PINK_BG = "rgba(244,114,182,0.16)";

    // -------------------------------------------------------------- i18n
    const isZh = /^zh/i.test(document.documentElement.lang || "") || /^zh/i.test(navigator.language || "");
    const zh = (z, e) => (isZh ? z : e);
    const STR = {
      runTitle: zh("在终端中运行", "Run in terminal"),
      caretTitle: zh("运行方式", "Run options"),
      runHere: zh("在当前终端运行", "Run in current terminal"),
      runNew: zh("新开终端再运行", "Run in a new terminal"),
      unsupported: zh("不支持的文件类型（支持 .py / .R / .bat / .cmd）", "Unsupported file type (supported: .py / .R / .bat / .cmd)"),
      clipboardHint: zh("已复制到剪贴板：请到下方终端粘贴后回车执行", "Copied to clipboard: paste it in the terminal below and press Enter"),
      newTermFallback: zh("未能打开新终端（可能已达上限或按钮不可用），命令已复制——请手动粘贴到某个终端执行", "Could not open a new terminal (limit or button issue) — command copied; paste it into a terminal manually"),
      noTerminal: zh("未找到可用终端，命令已复制到剪贴板", "No usable terminal found — command copied to clipboard"),
    };
    function isDarkMode() {
      try {
        return document.body?.matches?.("[data-ds-dark-theme]") ?? false;
      } catch {
        return false;
      }
    }

    let host = null;
    let hostObserver = null;
    let bodyObserver = null;
    let scanQueued = false;
    const pyPaths = new Set();

    // ---------------------------------------------------------------- dom
    function makeEl(tag, text, style, attrs) {
      const el = document.createElement(tag);
      if (text !== "") el.textContent = text;
      if (style) Object.assign(el.style, style);
      if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
      return el;
    }
    /** Small transient toast, auto-removed. */
    function toast(message, ms = 4000) {
      try {
        const el = makeEl(
          "div",
          message,
          {
            position: "fixed",
            left: "50%",
            bottom: "14px",
            transform: "translateX(-50%)",
            zIndex: "2147483001",
            maxWidth: "min(560px, calc(100vw - 32px))",
            padding: "8px 14px",
            borderRadius: "8px",
            background: "rgba(236,72,153,0.92)",
            color: "#ffffff",
            font: "12px/1.5 system-ui,sans-serif",
            whiteSpace: "pre-wrap",
            boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          },
          { [TOAST_MARK]: "" },
        );
        document.body.appendChild(el);
        setTimeout(() => el.remove(), ms);
      } catch {
        // toast is best-effort
      }
    }

    // --------------------------------------------------- terminal automation
    /** Shell command to run a file; works in cmd.exe and PowerShell. */
    function buildCommandLine(path) {
      const lower = path.toLowerCase();
      if (lower.endsWith(".py")) return `python "${path}"`;
      if (lower.endsWith(".r")) return `Rscript "${path}"`;
      if (lower.endsWith(".bat") || lower.endsWith(".cmd")) return `cmd /d /c "${path}"`;
      return null;
    }

    /** Collect visible elements whose own text / title / aria-label match. */
    function findLabel(texts) {
      return Array.from(document.querySelectorAll("span,button,div,a,[role='menuitem'],[role='button']")).filter((el) => {
        const box = el.getBoundingClientRect();
        if (!(box.width > 0 && box.height > 0)) return false;
        const own = (el.textContent ?? "").trim();
        if (el.children.length === 0 && texts.includes(own)) return true;
        const labeled = el.getAttribute("title") ?? el.getAttribute("aria-label");
        if (labeled && texts.includes(labeled.trim())) return true;
        return false;
      });
    }
    /** Click one matched element (or its clickable ancestor). */
    function clickEl(el) {
      const clickable = el.closest("button,[role='button'],[role='menuitem']") ?? el;
      clickable.click();
      return true;
    }
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function listVisibleTextareas() {
      return Array.from(document.querySelectorAll(XTERM_TEXTAREA)).filter((ta) => {
        const box = ta.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
    }
    const TERM_LABELS = [zh("终端", "Terminal"), "终端", "Terminal"];
    const NEWTERM_LABELS = [zh("新终端", "New terminal"), "新终端", "New terminal", "New Terminal"];
    const PLUS_LABELS = [zh("新建标签页", "New tab"), "新建标签页", "New tab", "+", "＋"];

    function rectCenter(el) {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    /** Nearest candidate to the anchor; without an anchor prefer the lowest
     *  one on screen (i.e. the bottom terminal workbench). */
    function pickNearest(cands, anchorEl) {
      if (cands.length === 0) return null;
      if (!anchorEl) {
        return cands.reduce((a, b) =>
          b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a,
        );
      }
      const ac = rectCenter(anchorEl);
      return cands.reduce((a, b) => (dist(rectCenter(b), ac) < dist(rectCenter(a), ac) ? b : a));
    }
    function terminalTabLeaves() {
      return findLabel(TERM_LABELS.concat(NEWTERM_LABELS));
    }

    /** Climb from a terminal view to the smallest ancestor that ALSO holds
     *  that panel's terminal tab labels — i.e. the pane that owns both its
     *  tab bar and the terminal view (bottom bar vs right sidebar are
     *  different panes, so this keeps a new terminal inside the same one). */
    function paneRootFor(ta) {
      let node = ta;
      for (let i = 0; node && node !== document.body && i < 18; i++, node = node.parentElement) {
        if (!node.querySelectorAll) continue;
        const leaves = Array.from(node.querySelectorAll("[class*='tabTitle']")).filter((l) =>
          /终端|terminal/i.test(l.textContent ?? ""),
        );
        if (leaves.length > 0) return node;
      }
      return null;
    }

    /** Visible label matches contained in `scope`. */
    function labelIn(labels, scope) {
      return findLabel(labels).filter((el) => scope.contains(el));
    }

    /** Terminal tab labels + their row element inside a pane (best effort). */
    function terminalRowOf(pane) {
      const leaves = labelIn(TERM_LABELS, pane);
      if (leaves.length === 0) return null;
      return { leaves, row: leaves[leaves.length - 1].parentElement ?? pane };
    }

    /** The pane's "add terminal" control: prefer a label match (新终端 /
     *  New terminal / 新建标签页 / New tab / +), otherwise the clickable
     *  sitting right after the last terminal tab on the same row — the
     *  classic + at the end of the tab bar (the user's tip). */
    function plusControlIn(pane, rowInfo) {
      const labeled = labelIn(PLUS_LABELS.concat(NEWTERM_LABELS), pane);
      if (labeled.length > 0) return pickNearest(labeled, null);
      if (!rowInfo) return null;
      const lastLeaf = rowInfo.leaves[rowInfo.leaves.length - 1];
      const lr = lastLeaf.getBoundingClientRect();
      const rowCands = Array.from(rowInfo.row.querySelectorAll("button,[role='button'],span,div")).filter((c) => {
        if (c === lastLeaf || rowInfo.leaves.includes(c)) return false;
        const box = c.getBoundingClientRect();
        if (!(box.width > 0 && box.height > 0)) return false;
        const nearRow = Math.abs(rectCenter(c).y - rectCenter(lastLeaf).y) < 28;
        const toTheRight = box.left >= lr.right - 6;
        return nearRow && toTheRight;
      });
      if (rowCands.length === 0) return null;
      return rowCands.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    }

    /** Debug: surface DOM findings in a toast + console so we can fix the
     *  pane targeting on the first shot (remove after tuning). */
    function dbg(msg) {
      try {
        toast(`[koyuki-debug] ${msg}`, 8000);
        console.info("[koyuki-debug]", msg);
      } catch {
        // ignore
      }
    }
    function labelOf(el) {
      if (!el) return "none";
      const t = el.getAttribute("title") ?? el.getAttribute("aria-label") ?? (el.textContent ?? "").trim();
      return t ? t.slice(0, 40) : el.tagName;
    }

    /** Visible bottom-panel root (bottom workbench). Both the bottom panel
     *  and the right sidebar have their own "+" — we must click the one
     *  INSIDE the bottom panel. */
    function visibleBottomPanel() {
      const all = Array.from(document.querySelectorAll('[class*="bottomPanel"]')).filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      return all[all.length - 1] ?? null;
    }

    /** Dispatch real pointer/mouse event sequences at `el`'s center.
     *  better-sidebar tracks "the pane the user touched last" through pointer
     *  handlers, so a bare HTMLElement.click() never switches panes. */
    function realMouse(el) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const seq = [
        ["pointerdown", PointerEvent],
        ["mousedown", MouseEvent],
        ["pointerup", PointerEvent],
        ["mouseup", MouseEvent],
        ["click", MouseEvent],
      ];
      for (const [type, Ctor] of seq) {
        try {
          el.dispatchEvent(
            new Ctor(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y,
              button: 0,
              pointerId: 1,
              isPrimary: true,
            }),
          );
        } catch {
          // ignore per-type failures
        }
      }
    }

    /** Open a new terminal in the BOTTOM panel.
     *  1) pointer-click the bottom panel itself  → bottom becomes the pane
     *     that receives new tabs;
     *  2) pointer-click the bottom "+" (tabBarPlus inside bottomPanel);
     *  3) pointer-click the Terminal entry of the popup (smallest real match
     *     outside any tab bar). */
    async function openNewTerminalNear() {
      const bottomRoot = visibleBottomPanel();
      if (bottomRoot) {
        const focusEl =
          bottomRoot.querySelector(
            '[class*="paneBody"],[class*="panelBody"],[class*="paneContent"],[class*="tabBar"]',
          ) ?? bottomRoot;
        realMouse(focusEl);
        await wait(220);
      }
      let plus = null;
      if (bottomRoot) {
        const inside = Array.from(bottomRoot.querySelectorAll('[class*="tabBarPlus"]')).filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
        if (inside.length > 0) plus = inside[inside.length - 1];
      }
      let clickedY = "na";
      if (plus) {
        realMouse(plus);
        clickedY = String(Math.round(rectCenter(plus).y));
        await wait(600);
      }
      const cands = Array.from(document.querySelectorAll("button,[role='menuitem'],[role='button'],span,div"))
        .filter((el) => {
          const box = el.getBoundingClientRect();
          if (!(box.width > 0 && box.height > 0)) return false;
          if (box.width > 360 || box.height > 64) return false;
          if (!TERM_LABELS.concat(NEWTERM_LABELS).includes((el.textContent ?? "").trim())) return false;
          if (el.closest('[class*="tabBar"]')) return false; // existing tab labels
          return true;
        })
        .sort((a, b) => {
          const A = a.getBoundingClientRect();
          const B = b.getBoundingClientRect();
          return A.width * A.height - B.width * B.height; // smallest real row first
        });
      let menuCands = 0;
      if (cands.length > 0) {
        realMouse(cands[0]);
        menuCands = cands.length;
      }
      dbg(`bottom=${bottomRoot ? "Y" : "N"} clickedY=${clickedY} menuCands=${menuCands}`);
      return plus !== null || cands.length > 0;
    }

    /** Send cmd + Enter into one specific terminal textarea. */
    function sendToTextarea(ta, cmd) {
      ta.focus();
      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, cmd);
      } catch {
        inserted = false;
      }
      for (const type of ["keydown", "keypress", "keyup"]) {
        try {
          ta.dispatchEvent(
            new KeyboardEvent(type, {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            }),
          );
        } catch {
          // per-type failures are fine
        }
      }
      return inserted;
    }

    async function runInTerminal(path, mode) {
      const cmd = buildCommandLine(path);
      if (!cmd) {
        toast(STR.unsupported);
        return;
      }
      const listBefore = listVisibleTextareas();
      const anchor = listBefore[listBefore.length - 1] ?? null;

      let created = false;
      let target = null;

      if (mode === "current") {
        target = anchor;
        if (!target) {
          const t = findLabel(TERM_LABELS);
          if (t.length > 0) {
            clickEl(t[t.length - 1]);
            await wait(600);
            target = listVisibleTextareas().pop() ?? null;
          }
        }
        if (!target) {
          // no terminal at all: open one in the bottom panel (pointer-click
          // path that is known to work), then poll up to ~5s for its xterm
          const made = await openNewTerminalNear();
          if (made) {
            for (let i = 0; i < 13 && !target; i++) {
              await wait(400);
              const nowList = listVisibleTextareas();
              if (nowList.length > 0) {
                target = nowList[nowList.length - 1];
                break;
              }
              const leaves = terminalTabLeaves();
              if (leaves.length > 0 && i === 2) clickEl(leaves[leaves.length - 1]);
            }
          }
        }
      } else {
        // mode "new": open a fresh terminal, then POLL up to ~5s until its
        // xterm textarea appears (PTY mount can lag the tab creation), then
        // type into exactly that fresh terminal — never into the old one.
        const tabsBefore = terminalTabLeaves().length;
        created = await openNewTerminalNear();
        if (created) {
          for (let i = 0; i < 13 && !target; i++) {
            await wait(400);
            const nowList = listVisibleTextareas();
            if (nowList.length > listBefore.length) {
              const fresh = nowList.filter((ta) => !listBefore.includes(ta));
              target = fresh.pop() ?? nowList[nowList.length - 1];
              break;
            }
            if (terminalTabLeaves().length > tabsBefore && i === 2) {
              // tab added but not active yet — activate it so its view mounts
              const leaves = terminalTabLeaves();
              if (leaves.length > 0) {
                clickEl(leaves[leaves.length - 1]);
              }
            }
          }
        } else {
          await wait(250);
        }
      }

      if (!target) {
        navigator.clipboard?.writeText(cmd).catch(() => {});
        toast(mode === "new" ? STR.newTermFallback : STR.noTerminal, 6000);
        return;
      }
      let ok = false;
      try {
        ok = sendToTextarea(target, cmd);
      } catch {
        ok = false;
      }
      if (!ok) {
        navigator.clipboard?.writeText(cmd).catch(() => {});
        toast(STR.clipboardHint, 6000);
        return;
      }
    }

    // ------------------------------------------------------------- control
    /** A single pink ▶ button (the "new terminal" dropdown was removed in
     *  v0.3.0 — automating a new terminal in the bottom pane proved too
     *  fragile, so ▶ simply runs in the current visible terminal). */
    function makeRunControl(path, rowStyle) {
      const btn = makeEl("span", "▶", {
        display: "inline-block",
        cursor: "pointer",
        userSelect: "none",
        flex: "none",
        lineHeight: "18px",
        padding: "0 7px",
        borderRadius: "6px",
        fontSize: "12px",
        fontWeight: "700",
        color: PINK,
        background: PINK_BG,
        ...(rowStyle ? { marginLeft: "auto", alignSelf: "center" } : { marginLeft: "6px" }),
      });
      btn.title = STR.runTitle;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        runInTerminal(path, "current");
      });
      return btn;
    }

    function scanRows(root) {
      const rows = Array.from(root.querySelectorAll('[class*="explorerRow"]')).filter(
        (r) => r.hasAttribute("title") && RUN_RE.test(r.getAttribute("title")),
      );
      const seen = new Set();
      for (const row of rows) {
        const path = row.getAttribute("title");
        seen.add(path);
        pyPaths.add(path);
        let ctl = row.querySelector(`[${CHIP_MARK}]`);
        if (!ctl) {
          ctl = makeRunControl(path, true);
          ctl.setAttribute(CHIP_MARK, "");
          row.appendChild(ctl);
        }
      }
      for (const ctl of Array.from(root.querySelectorAll(`[${CHIP_MARK}]`))) {
        if (!ctl.closest('[class*="explorerRow"]')) ctl.remove();
      }
      for (const path of Array.from(pyPaths)) {
        if (!seen.has(path)) pyPaths.delete(path);
      }
    }

    /** Best-effort: active editor header showing a runnable file. */
    function currentHeaderPyPath(root) {
      const headers = Array.from(document.querySelectorAll('[class*="_editorHeader"]')).filter((h) => {
        let node = h;
        while (node && node !== document.body) {
          if (node === root || root.contains(node)) return true;
          node = node.parentElement;
        }
        return false;
      });
      const header = headers.find((h) => h.offsetParent !== null) ?? headers[0];
      if (!header) return { header: null, path: null };
      const titled = header.querySelector("[title]");
      if (titled && typeof titled.getAttribute("title") === "string" && RUN_RE.test(titled.getAttribute("title"))) {
        return { header, path: titled.getAttribute("title") };
      }
      const text = (header.textContent ?? "").trim();
      const m = text.match(RUN_NAME_RE);
      if (m) {
        const wanted = m[1];
        for (const p of pyPaths) {
          const base = p.split(/[\\/]/).pop();
          if (base === wanted) return { header, path: p };
        }
      }
      return { header, path: null };
    }

    function scanHeader() {
      if (!host) return;
      const { header, path } = currentHeaderPyPath(host);
      let ctl = header ? header.querySelector(`[${BTN_MARK}]`) : null;
      if (!header || !path) {
        if (ctl) ctl.remove();
        return;
      }
      if (!ctl) {
        ctl = makeRunControl(path, false);
        ctl.setAttribute(BTN_MARK, "");
        header.appendChild(ctl);
      }
    }

    function refreshButtons() {
      if (!host) return;
      scanRows(host);
      scanHeader();
    }
    function scheduleScan() {
      if (scanQueued) return;
      scanQueued = true;
      requestAnimationFrame(() => {
        scanQueued = false;
        refreshButtons();
      });
    }

    // ------------------------------------------------------------ lifecycle
    function attach(rootEl) {
      host = rootEl;
      if (hostObserver) hostObserver.disconnect();
      hostObserver = new MutationObserver(scheduleScan);
      hostObserver.observe(host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["title", "class"],
      });
      scheduleScan();
    }
    function detach() {
      if (hostObserver) hostObserver.disconnect();
      hostObserver = null;
      host = null;
      pyPaths.clear();
      document.querySelectorAll(`[${CHIP_MARK}]`).forEach((el) => el.remove());
      document.querySelectorAll(`[${BTN_MARK}]`).forEach((el) => el.remove());
    }
    function start() {
      const found = document.querySelector(HOST_SELECTOR);
      if (found && host !== found) attach(found);
      bodyObserver = new MutationObserver(() => {
        const foundNow = document.querySelector(HOST_SELECTOR);
        if (foundNow && host !== foundNow) attach(foundNow);
        else if (!foundNow && host) detach();
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
    function dispose() {
      if (bodyObserver) bodyObserver.disconnect();
      bodyObserver = null;
      detach();
      document.querySelectorAll(`[${TOAST_MARK}]`).forEach((el) => el.remove());
    }

    // --------------------------------------------------------------- entry
    function apply(ctx) {
      ctx.effect(() => {
        start();
        return () => dispose();
      }, "dsh-koyuki-starter: run-button overlay (dropdown v3)");
    }

    exports.apply = apply;
    return module.exports;
  },
});
