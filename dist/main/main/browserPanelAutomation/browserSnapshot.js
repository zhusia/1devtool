"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildBrowserSnapshotScript = buildBrowserSnapshotScript;
exports.buildBrowserResolveRefScript = buildBrowserResolveRefScript;
exports.buildBrowserSelectOptionScript = buildBrowserSelectOptionScript;
exports.buildBrowserWaitConditionScript = buildBrowserWaitConditionScript;
exports.buildBrowserPasteImageScript = buildBrowserPasteImageScript;
const browserMcp_1 = require("../../shared/browserMcp");
const SNAPSHOT_MAX_NODES = 700;
function json(value) {
    return JSON.stringify(value);
}
/** Fixed app-owned script. Only JSON-encoded scalar parameters are interpolated. */
function buildBrowserSnapshotScript(snapshotId) {
    return `(() => {
    const snapshotId = ${json(snapshotId)};
    const maxNodes = ${SNAPSHOT_MAX_NODES};
    const maxChars = ${browserMcp_1.BROWSER_MCP_MAX_SNAPSHOT_CHARS};
    const state = globalThis.__1devtoolBrowserMcpState || (globalThis.__1devtoolBrowserMcpState = {});
    const refs = new Map();
    let refCounter = 0;
    let nodeCount = 0;
    let charCount = 0;
    let truncated = false;
    const lines = [];

    const clean = (value, max = 240) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const visible = (el) => {
      const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const roleFor = (el) => {
      const explicit = clean(el.getAttribute('role'), 60);
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
        if (type === 'range') return 'slider';
        return 'textbox';
      }
      if (tag === 'nav') return 'navigation';
      if (tag === 'main') return 'main';
      if (tag === 'header') return 'banner';
      if (tag === 'footer') return 'contentinfo';
      if (tag === 'form') return 'form';
      if (tag === 'img') return 'img';
      if (tag === 'li') return 'listitem';
      if (tag === 'ul' || tag === 'ol') return 'list';
      if (tag === 'table') return 'table';
      if (tag === 'tr') return 'row';
      if (tag === 'th') return 'columnheader';
      if (tag === 'td') return 'cell';
      if (tag === 'iframe' || tag === 'frame') return 'frame';
      return '';
    };
    const labelledBy = (el) => {
      const ownerDocument = el.ownerDocument || document;
      const ids = clean(el.getAttribute('aria-labelledby'), 500).split(' ').filter(Boolean);
      return clean(ids.map((id) => ownerDocument.getElementById(id)?.textContent || '').join(' '));
    };
    const nameFor = (el) => {
      const ownerDocument = el.ownerDocument || document;
      const aria = clean(el.getAttribute('aria-label')) || labelledBy(el);
      if (aria) return aria;
      if (el.id) {
        try {
          const label = ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          const text = clean(label?.textContent);
          if (text) return text;
        } catch {}
      }
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const text = clean(parentLabel.textContent);
        if (text) return text;
      }
      return clean(el.getAttribute('alt'))
        || clean(el.getAttribute('title'))
        || clean(el.getAttribute('placeholder'))
        || clean(el.textContent);
    };
    const ownText = (el) => clean(Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent || '')
      .join(' '));
    const isActionable = (el, role) => Boolean(
      role && ['button','link','textbox','checkbox','radio','combobox','slider','menuitem','option','switch','tab'].includes(role)
      || el.hasAttribute('contenteditable')
      || typeof el.onclick === 'function'
      || el.tabIndex >= 0
    );
    const stateText = (el, role) => {
      const parts = [];
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
      if (el.getAttribute('aria-expanded')) parts.push('expanded=' + el.getAttribute('aria-expanded'));
      if (el.getAttribute('aria-pressed')) parts.push('pressed=' + el.getAttribute('aria-pressed'));
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        const checked = 'checked' in el ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true';
        parts.push('checked=' + checked);
      }
      if ('value' in el && typeof el.value === 'string') {
        const type = (el.getAttribute('type') || '').toLowerCase();
        const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
        const sensitive = type === 'password' || /(password|cc-|one-time-code)/.test(autocomplete);
        const value = sensitive ? '«redacted»' : clean(el.value, 160);
        if (value) parts.push('value=' + JSON.stringify(value));
      }
      if (/^h[1-6]$/i.test(el.tagName)) parts.push('level=' + el.tagName.slice(1));
      return parts.length ? ' (' + parts.join(', ') + ')' : '';
    };
    const push = (line) => {
      if (truncated) return;
      if (nodeCount >= maxNodes || charCount + line.length + 1 > maxChars) {
        truncated = true;
        return;
      }
      lines.push(line);
      charCount += line.length + 1;
      nodeCount += 1;
    };
    const visit = (root, depth) => {
      const children = Array.from(root.children || []);
      for (const el of children) {
        if (truncated) break;
        // Elements from same-origin frames have a different JS realm, so a
        // top-frame constructor check would reject them.
        if (!el || el.nodeType !== 1 || !visible(el)) continue;
        const tag = el.tagName.toLowerCase();
        if (['script','style','noscript','template','svg'].includes(tag)) continue;
        const role = roleFor(el);
        const actionable = isActionable(el, role);
        const name = nameFor(el);
        const text = ownText(el);
        const meaningful = Boolean(role || actionable || text);
        let nextDepth = depth;
        if (meaningful) {
          let ref = '';
          if (actionable) {
            ref = 'e' + (++refCounter);
            refs.set(ref, el);
          }
          const label = name || text;
          const descriptor = role || tag;
          push('  '.repeat(Math.min(depth, 12)) + '- ' + descriptor
            + (label ? ' ' + JSON.stringify(label) : '')
            + (ref ? ' [ref=' + ref + ']' : '')
            + stateText(el, role));
          nextDepth = depth + 1;
        }
        if (tag === 'iframe' || tag === 'frame') {
          try {
            if (el.contentDocument) visit(el.contentDocument, nextDepth);
            else push('  '.repeat(Math.min(nextDepth, 12)) + '- frame «cross-origin or unavailable»');
          } catch {
            push('  '.repeat(Math.min(nextDepth, 12)) + '- frame «cross-origin or unavailable»');
          }
        } else {
          if (el.shadowRoot) visit(el.shadowRoot, nextDepth);
          visit(el, nextDepth);
        }
      }
    };

    visit(document, 0);
    state.snapshotId = snapshotId;
    state.refs = refs;
    return {
      tree: lines.join('\\n') || '- document «no visible semantic content»',
      nodeCount,
      truncated,
    };
  })()`;
}
function buildBrowserResolveRefScript(snapshotId, ref, options = {}) {
    return `(() => {
    const state = globalThis.__1devtoolBrowserMcpState;
    if (!state || state.snapshotId !== ${json(snapshotId)}) return { ok: false, code: 'stale_snapshot' };
    const el = state.refs && state.refs.get(${json(ref)});
    if (!el || !el.isConnected) return { ok: false, code: 'element_detached' };
    const ownerDocument = el.ownerDocument || document;
    const ownerWindow = ownerDocument.defaultView || window;
    const style = ownerWindow.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return { ok: false, code: 'element_not_actionable', reason: 'Element is hidden' };
    }
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      return { ok: false, code: 'element_not_actionable', reason: 'Element is disabled' };
    }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
    const select = tag === 'select';
    if (${options.requireEditable === true} && !editable) {
      return { ok: false, code: 'element_not_actionable', reason: 'Element is not editable' };
    }
    if (${options.requireSelect === true} && !select) {
      return { ok: false, code: 'element_not_actionable', reason: 'Element is not a select control' };
    }
    const frameChain = [];
    let currentWindow = ownerWindow;
    try {
      while (currentWindow && currentWindow !== currentWindow.top) {
        const frame = currentWindow.frameElement;
        if (!frame) return { ok: false, code: 'unsupported_frame', reason: 'Frame boundary is unavailable' };
        frameChain.push(frame);
        currentWindow = frame.ownerDocument?.defaultView;
      }
    } catch {
      return { ok: false, code: 'unsupported_frame', reason: 'Cross-origin frame targeting is unsupported' };
    }
    for (let index = frameChain.length - 1; index >= 0; index -= 1) {
      frameChain[index].scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { ok: false, code: 'element_not_actionable', reason: 'Element has no visible bounds' };
    }
    const x = Math.max(rect.left + 1, Math.min(rect.right - 1, rect.left + rect.width / 2));
    const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, rect.top + rect.height / 2));
    const root = el.getRootNode?.();
    const hit = root && typeof root.elementFromPoint === 'function'
      ? root.elementFromPoint(x, y)
      : ownerDocument.elementFromPoint(x, y);
    const composedContains = (outer, inner) => {
      let current = inner;
      while (current) {
        if (current === outer) return true;
        const currentRoot = current.getRootNode?.();
        current = current.parentElement || currentRoot?.host || null;
      }
      return false;
    };
    if (hit && hit !== el && !composedContains(el, hit) && !composedContains(hit, el)) {
      return { ok: false, code: 'element_not_actionable', reason: 'Element is obscured' };
    }
    if (${options.focus === true}) {
      el.focus({ preventScroll: true });
      if (editable) {
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) {
          const selection = getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    }
    let guestX = x;
    let guestY = y;
    for (const frame of frameChain) {
      const frameRect = frame.getBoundingClientRect();
      guestX += frameRect.left + (frame.clientLeft || 0);
      guestY += frameRect.top + (frame.clientTop || 0);
    }
    return {
      ok: true,
      tag,
      type,
      editable,
      select,
      isPassword: type === 'password',
      isFile: type === 'file',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      point: { x: guestX, y: guestY },
    };
  })()`;
}
function buildBrowserSelectOptionScript(snapshotId, ref, values) {
    return `(() => {
    const state = globalThis.__1devtoolBrowserMcpState;
    if (!state || state.snapshotId !== ${json(snapshotId)}) return { ok: false, code: 'stale_snapshot' };
    const el = state.refs && state.refs.get(${json(ref)});
    if (!el || !el.isConnected) return { ok: false, code: 'element_detached' };
    if (String(el.tagName || '').toLowerCase() !== 'select') return { ok: false, code: 'element_not_actionable', reason: 'Element is not a select control' };
    const requested = new Set(${json(values)}.map(String));
    const matches = Array.from(el.options).filter((option) =>
      requested.has(option.value) || requested.has((option.textContent || '').trim())
    );
    if (!matches.length) return { ok: false, code: 'element_not_actionable', reason: 'No matching option' };
    if (el.multiple) {
      for (const option of el.options) option.selected = matches.includes(option);
    } else {
      el.selectedIndex = matches[0].index;
      el.value = matches[0].value;
    }
    const selected = Array.from(el.selectedOptions).map((option) => option.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected };
  })()`;
}
function buildBrowserWaitConditionScript(condition) {
    return `(() => {
    const text = document.body ? String(document.body.innerText || document.body.textContent || '') : '';
    const wanted = ${json(condition.text ?? null)};
    const gone = ${json(condition.textGone ?? null)};
    const loadState = ${json(condition.loadState ?? null)};
    if (wanted !== null && !text.includes(wanted)) return false;
    if (gone !== null && text.includes(gone)) return false;
    if (loadState === 'complete' && document.readyState !== 'complete') return false;
    if (loadState === 'domcontentloaded' && document.readyState === 'loading') return false;
    return true;
  })()`;
}
/** Inject an image File via paste event or file-input assignment (BUG-78). */
function buildBrowserPasteImageScript(args) {
    return `(() => {
    const state = globalThis.__1devtoolBrowserMcpState;
    if (!state || state.snapshotId !== ${json(args.snapshotId)}) {
      return { ok: false, code: 'stale_snapshot', reason: 'The snapshot is stale; take a fresh browser_snapshot' };
    }
    const el = state.refs && state.refs.get(${json(args.ref)});
    if (!el || !el.isConnected) {
      return { ok: false, code: 'element_detached', reason: 'The referenced element is no longer attached' };
    }

    const fileName = ${json(args.fileName)};
    const mimeType = ${json(args.mimeType)};
    const b64 = ${json(args.base64)};
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const file = new File([blob], fileName, { type: mimeType, lastModified: Date.now() });

    const tag = String(el.tagName || '').toLowerCase();
    const isFileInput = tag === 'input' && String(el.type || '').toLowerCase() === 'file';
    const attachmentSelector = 'img, [data-attachment], [class*="attachment"], [class*="preview"]';
    // Scope to form/parent only — never document.body (absolute img count is not an ack).
    const scope = el.closest('form') || el.parentElement || null;
    const countAttachments = () => scope ? scope.querySelectorAll(attachmentSelector).length : 0;

    if (isFileInput) {
      try {
        const before = el.files ? el.files.length : 0;
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const after = el.files ? el.files.length : 0;
        const delta = after - before;
        return {
          ok: true,
          method: 'file-input',
          pasteStatus: delta > 0 ? 'attached' : 'dispatched',
          attachmentDelta: delta,
          detail: delta > 0
            ? 'File input gained ' + delta + ' file(s) (now ' + after + ').'
            : 'File assignment dispatched; host may ignore programmatic files.',
        };
      } catch (error) {
        return {
          ok: false,
          method: 'file-input',
          pasteStatus: 'failed',
          reason: 'File input assignment failed: ' + (error && error.message ? error.message : String(error)),
        };
      }
    }

    try { el.focus && el.focus(); } catch (_) { /* best-effort */ }

    try {
      const before = countAttachments();
      const dt = new DataTransfer();
      dt.items.add(file);
      let pasteEvent;
      try {
        pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      } catch (_) {
        pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        try { Object.defineProperty(pasteEvent, 'clipboardData', { value: dt }); } catch (_) { /* */ }
      }
      const cancelled = !el.dispatchEvent(pasteEvent);
      // Only drop when paste was not consumed — otherwise double-attach.
      if (!cancelled) {
        try {
          const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
          el.dispatchEvent(dropEvent);
        } catch (_) { /* optional */ }
      }
      const after = countAttachments();
      const delta = after - before;
      return {
        ok: true,
        method: 'paste-event',
        pasteStatus: delta > 0 ? 'attached' : 'dispatched',
        attachmentDelta: delta,
        detail: delta > 0
          ? 'Attachment UI gained ' + delta + ' node(s) after paste (before=' + before + ', after=' + after + ').'
          : cancelled
            ? 'Paste event was handled (defaultPrevented) but no new attachment nodes appeared yet — re-snapshot after upload.'
            : 'Paste event dispatched; no attachment-node delta in the local form/parent. Re-snapshot before assuming failure.',
      };
    } catch (error) {
      return {
        ok: false,
        method: 'none',
        pasteStatus: 'failed',
        reason: 'Paste injection failed: ' + (error && error.message ? error.message : String(error)),
      };
    }
  })()`;
}
