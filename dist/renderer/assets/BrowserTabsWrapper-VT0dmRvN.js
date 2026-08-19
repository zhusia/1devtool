import{j as t,r,b as Nr,aY as Cr,cu as _r,cv as bn,cw as wn,cx as Sr,aj as jr,cy as Rr,u as me,cz as Ue,cA as yn,cB as be,aK as Er,aq as jn,ar as Me,S as Tr,bj as Lr,bf as Pr}from"./index-KvNu_ZFT.js";function Mr({count:a,onExit:s}){return t.jsxs("div",{className:"flex items-center gap-2 px-3 py-1.5 text-[11px] bg-accent/15 border-b border-accent/30 text-text-secondary",children:[t.jsx("svg",{className:"w-3.5 h-3.5 text-accent",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"})}),t.jsxs("span",{className:"flex-1",children:["Click any element to leave a comment for the AI. ",a>0&&t.jsxs("span",{className:"text-accent",children:["(",a," so far)"]})]}),t.jsx("span",{className:"text-text-muted",children:"Esc to exit"}),t.jsx("button",{className:"px-2 py-0.5 text-[10px] text-text-muted hover:text-text-primary",onClick:s,children:"Exit"})]})}function Dr({count:a,selectedCount:s,paused:c,showPins:l,onTogglePaused:f,onToggleShowPins:h,onOpenList:y,onSendToAI:k,onClearAll:C,onClose:p}){return t.jsxs("div",{className:"pointer-events-auto fixed bottom-4 left-1/2 -translate-x-1/2 z-[10001] flex items-center gap-1 px-2 py-1 bg-[#1a1a1a]/95 backdrop-blur border border-border rounded-full shadow-2xl",children:[t.jsx("button",{className:`p-1.5 rounded-full text-xs ${c?"text-yellow-400":"text-text-secondary hover:text-text-primary"}`,onClick:f,title:c?"Resume placing comments":"Pause placing comments",children:c?t.jsx("svg",{className:"w-3.5 h-3.5",fill:"currentColor",viewBox:"0 0 24 24",children:t.jsx("path",{d:"M8 5v14l11-7z"})}):t.jsx("svg",{className:"w-3.5 h-3.5",fill:"currentColor",viewBox:"0 0 24 24",children:t.jsx("path",{d:"M6 4h4v16H6zM14 4h4v16h-4z"})})}),t.jsx("button",{className:`p-1.5 rounded-full text-xs ${l?"text-text-secondary hover:text-text-primary":"text-text-muted"}`,onClick:h,title:l?"Hide pins":"Show pins",children:t.jsx("svg",{className:"w-3.5 h-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",children:l?t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"}):t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M3 3l18 18M10.477 10.477a3 3 0 104.243 4.243M9.879 4.21A9.953 9.953 0 0112 4c4.478 0 8.268 2.943 9.542 7-.39 1.24-1.02 2.39-1.842 3.396"})})}),t.jsxs("button",{className:"relative p-1.5 rounded-full text-xs text-text-secondary hover:text-text-primary",onClick:y,title:"View all comments",children:[t.jsx("svg",{className:"w-3.5 h-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"})}),a>0&&t.jsx("span",{className:"absolute -top-0.5 -right-0.5 min-w-[13px] h-[13px] px-[3px] rounded-full bg-accent text-[8px] leading-[13px] text-white text-center font-semibold",children:a>99?"99+":a})]}),t.jsxs("button",{className:"px-3 py-1 text-[11px] bg-accent text-white rounded-full hover:bg-accent-hover flex items-center gap-1",onClick:k,disabled:s===0,title:s===0?a===0?"Place at least one comment first":"Select at least one comment to send":"Send selected comments to AI Terminal",style:s===0?{opacity:.5,cursor:"not-allowed"}:{},children:[t.jsx("svg",{className:"w-3 h-3",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2.5",children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M12 19l9 2-9-18-9 18 9-2zm0 0v-8"})}),"Send ",s>0?`(${s})`:""]}),t.jsx("button",{className:"p-1.5 rounded-full text-xs text-text-muted hover:text-red-400",onClick:C,disabled:a===0,title:"Clear all comments",style:a===0?{opacity:.4}:{},children:t.jsx("svg",{className:"w-3.5 h-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"})})}),t.jsx("div",{className:"w-px h-4 bg-border"}),t.jsx("button",{className:"p-1.5 rounded-full text-xs text-text-muted hover:text-text-primary",onClick:p,title:"Exit comment mode (Esc)",children:t.jsx("svg",{className:"w-3.5 h-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M6 18L18 6M6 6l12 12"})})})]})}function Ir({comment:a,index:s,hostTop:c,hostLeft:l,onDelete:f,onEdit:h}){const[y,k]=r.useState(!1),[C,p]=r.useState(!1),[u,v]=r.useState(a.text);return t.jsxs("div",{className:"pointer-events-auto fixed z-[9999]",style:{top:c,left:l,transform:"translate(-50%, -50%)"},onMouseEnter:()=>k(!0),onMouseLeave:()=>k(!1),children:[t.jsxs("button",{className:"relative flex items-center justify-center w-6 h-6 rounded-full bg-accent text-white shadow-lg border-2 border-white/80 hover:scale-110 transition-transform",title:a.text,onClick:()=>p(!0),children:[t.jsx("span",{className:"text-[10px] font-semibold leading-none",children:s}),t.jsx("svg",{className:"absolute -bottom-1 -right-1 w-3 h-3 text-white bg-accent rounded-full p-[1px]",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"3",children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M15.232 5.232l3.536 3.536M9 11l-3 9 9-3 9-13.5a2.121 2.121 0 00-3-3L9 11z"})})]}),(y||C)&&!C&&t.jsxs("div",{className:"absolute top-full left-0 mt-1 w-64 bg-[#1a1a1a] border border-border/60 rounded-md shadow-xl px-2 py-1.5",onClick:b=>b.stopPropagation(),children:[t.jsx("div",{className:"text-[10px] text-text-muted font-mono truncate",children:a.anchor.selector}),t.jsx("div",{className:"text-xs text-text-primary mt-0.5 break-words",children:a.text}),t.jsxs("div",{className:"text-[10px] text-text-muted/70 mt-1",children:[a.pathname," · ",a.viewport.width,"x",a.viewport.height]})]}),C&&t.jsxs("div",{className:"absolute top-full left-0 mt-1 w-72 bg-[#1a1a1a] border border-border rounded-md shadow-2xl p-2",onClick:b=>b.stopPropagation(),children:[t.jsxs("div",{className:"text-[10px] text-text-muted font-mono mb-1 truncate",children:["> ",a.anchor.tag,' "',a.anchor.text.slice(0,24),'"']}),t.jsx("textarea",{value:u,onChange:b=>v(b.target.value),className:"w-full px-2 py-1 text-xs bg-background border border-border rounded resize-none",rows:2,autoFocus:!0}),t.jsxs("div",{className:"flex items-center justify-between mt-1.5",children:[t.jsx("button",{className:"text-[10px] text-red-400 hover:text-red-300",onClick:()=>{p(!1),f()},children:"Delete"}),t.jsxs("div",{className:"flex items-center gap-1",children:[t.jsx("button",{className:"px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary",onClick:()=>{p(!1),v(a.text)},children:"Cancel"}),t.jsx("button",{className:"px-2 py-0.5 text-[11px] bg-accent text-white rounded hover:bg-accent-hover",onClick:()=>{p(!1),h(u)},children:"Save"})]})]})]})]})}const le=8;function Br({hostTop:a,hostLeft:s,anchor:c,onCancel:l,onSubmit:f}){const[h,y]=r.useState(""),[k,C]=r.useState({top:a,left:s}),p=r.useRef(null),u=r.useRef(null),v=r.useRef(!1),b=r.useRef(null);r.useEffect(()=>{const x=window.setTimeout(()=>{var w;return(w=p.current)==null?void 0:w.focus()},0);return()=>window.clearTimeout(x)},[]),r.useLayoutEffect(()=>{if(v.current)return;const x=u.current,w=(x==null?void 0:x.offsetWidth)??320,P=(x==null?void 0:x.offsetHeight)??140,$=Math.max(le,window.innerWidth-w-le),W=Math.max(le,window.innerHeight-P-le);C({left:Math.min(Math.max(le,s),$),top:Math.min(Math.max(le,a),W)})},[a,s]);const I=()=>{const x=h.trim();if(!x){l();return}f(x)},L=x=>{var $,W;if(x.button!==0)return;const w=u.current;if(!w)return;v.current=!0;const P=w.getBoundingClientRect();b.current={pointerId:x.pointerId,offsetX:x.clientX-P.left,offsetY:x.clientY-P.top},(W=($=x.currentTarget).setPointerCapture)==null||W.call($,x.pointerId),x.preventDefault()},j=x=>{const w=b.current;if(!w||w.pointerId!==x.pointerId)return;const P=u.current,$=(P==null?void 0:P.offsetWidth)??320,W=(P==null?void 0:P.offsetHeight)??140,K=Math.max(le,window.innerWidth-$-le),G=Math.max(le,window.innerHeight-W-le);C({left:Math.min(Math.max(le,x.clientX-w.offsetX),K),top:Math.min(Math.max(le,x.clientY-w.offsetY),G)})},z=x=>{var w,P,$;((w=b.current)==null?void 0:w.pointerId)===x.pointerId&&(b.current=null,($=(P=x.currentTarget).releasePointerCapture)==null||$.call(P,x.pointerId))};return t.jsxs("div",{ref:u,className:"pointer-events-auto fixed z-[10000] w-80 bg-[#1a1a1a] border border-border rounded-lg shadow-2xl p-2",style:{top:k.top,left:k.left},onClick:x=>x.stopPropagation(),onKeyDown:x=>{x.key==="Escape"?(x.preventDefault(),x.stopPropagation(),l()):x.key==="Enter"&&(x.metaKey||x.ctrlKey)&&(x.preventDefault(),x.stopPropagation(),I())},children:[t.jsxs("div",{className:"flex items-center gap-1 text-[10px] text-text-muted font-mono mb-1.5 px-1 cursor-move select-none",onPointerDown:L,onPointerMove:j,onPointerUp:z,onPointerCancel:z,title:"Drag to move",children:[t.jsx("span",{children:">"}),t.jsxs("span",{className:"truncate",children:[c.tag,c.text?` "${c.text.slice(0,32)}"`:""]})]}),t.jsx("textarea",{ref:p,value:h,onChange:x=>y(x.target.value),placeholder:"Leave a comment for the AI…",className:"w-full px-2 py-1.5 text-xs bg-background border border-border rounded resize-none",rows:2}),t.jsxs("div",{className:"flex items-center justify-end gap-1 mt-1.5",children:[t.jsx("button",{className:"px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary",onClick:l,children:"Cancel"}),t.jsx("button",{className:"px-3 py-0.5 text-[11px] bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50",onClick:I,disabled:!h.trim(),children:"Add"})]})]})}function Rn(){return{comments:new Map,selectedIds:new Set,guestScroll:{x:0,y:0}}}function Et(a,s){const c=a.get(s);if(c)return c;const l=Rn();return a.set(s,l),l}function it(a,s){const c={comments:new Map(a.comments),selectedIds:new Set(a.selectedIds),guestScroll:{...a.guestScroll}};return s(c),c}function Or(){return`cmt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`}const ee=Cr(a=>({panels:new Map,addComment:(s,c,l,f)=>{const h=Date.now(),y={id:Or(),panelId:s,projectId:c,url:l.url,pathname:l.pathname,search:l.search,hash:l.hash,position:l.position,anchor:l.anchor,viewport:l.viewport,text:f,createdAt:h,updatedAt:h};return a(k=>{const C=new Map(k.panels),p=Et(C,s),u=it(p,v=>{v.comments.set(y.id,y),v.selectedIds.add(y.id)});return C.set(s,u),{panels:C}}),y},updateComment:(s,c,l)=>{a(f=>{const h=f.panels.get(s);if(!h)return f;const y=h.comments.get(c);if(!y)return f;const k=new Map(f.panels),C=it(h,p=>{p.comments.set(c,{...y,...l,updatedAt:Date.now()})});return k.set(s,C),{panels:k}})},deleteComment:(s,c)=>{a(l=>{const f=l.panels.get(s);if(!f)return l;const h=new Map(l.panels),y=it(f,k=>{k.comments.delete(c),k.selectedIds.delete(c)});return h.set(s,y),{panels:h}})},clearPanel:s=>{a(c=>{if(!c.panels.has(s))return c;const l=new Map(c.panels);return l.set(s,Rn()),{panels:l}})},setGuestScroll:(s,c,l)=>{a(f=>{const h=new Map(f.panels),y=Et(h,s);return h.set(s,{...y,guestScroll:{x:c,y:l}}),{panels:h}})},toggleSelection:(s,c)=>{a(l=>{const f=l.panels.get(s);if(!f)return l;const h=new Map(l.panels),y=it(f,k=>{k.selectedIds.has(c)?k.selectedIds.delete(c):k.selectedIds.add(c)});return h.set(s,y),{panels:h}})},setSelected:(s,c)=>{a(l=>{const f=new Map(l.panels),h=Et(f,s);return f.set(s,{...h,selectedIds:new Set(c)}),{panels:f}})}}));function Tt(a){return ee(Nr(s=>{const c=s.panels.get(a);return c?Array.from(c.comments.values()):[]}))}function En(a){return ee(s=>{var c;return((c=s.panels.get(a))==null?void 0:c.selectedIds)??zr})}function Fr(a){return ee(s=>{var c;return((c=s.panels.get(a))==null?void 0:c.guestScroll)??$r})}const zr=new Set,$r={x:0,y:0};function Ur(a){const s=ee.getState().panels.get(a);return s?Array.from(s.comments.values()):[]}function Ar(a,s){try{const c=new URL(s),l=new URL(a.url);return c.origin===l.origin&&c.pathname===l.pathname}catch{return a.url===s}}function Hr({panelId:a,projectId:s,currentUrl:c,webviewRect:l,draft:f,draftHostTop:h,draftHostLeft:y,onSubmitDraft:k,onCancelDraft:C}){const p=Tt(a),u=Fr(a),v=ee(j=>j.deleteComment),b=ee(j=>j.updateComment),I=r.useMemo(()=>p.filter(j=>Ar(j,c)),[p,c]),[,L]=r.useState(0);return r.useEffect(()=>{const j=()=>L(z=>z+1);return window.addEventListener("resize",j),()=>window.removeEventListener("resize",j)},[]),t.jsxs(t.Fragment,{children:[l&&I.map((j,z)=>{const x=j.position.x-u.x,w=j.position.y-u.y;if(!(x>=-32&&w>=-32&&x<=l.width+32&&w<=l.height+32))return null;const $=l.top+w,W=l.left+x;return t.jsx(Ir,{comment:j,index:z+1,hostTop:$,hostLeft:W,onDelete:()=>v(a,j.id),onEdit:K=>b(a,j.id,{text:K})},j.id)}),f&&t.jsx(Br,{hostTop:h,hostLeft:y,anchor:f.anchor,onCancel:C,onSubmit:k})]})}function Wr({panelId:a,onJumpTo:s,onSendToTerminal:c}){const l=Tt(a),f=En(a),h=ee(u=>u.toggleSelection),y=ee(u=>u.setSelected),k=ee(u=>u.deleteComment),C=ee(u=>u.clearPanel),p=r.useMemo(()=>{const u=new Map;return l.forEach(v=>{const b=v.pathname||"/",I=u.get(b)??[];I.push(v),u.set(b,I)}),Array.from(u.entries()).sort(([v],[b])=>v.localeCompare(b))},[l]);return l.length===0?t.jsx("div",{className:"flex items-center justify-center h-full text-text-muted text-xs p-6",children:"No comments yet. Enable comment mode in the toolbar (💬) and click any element on the page."}):t.jsxs("div",{className:"flex-1 overflow-y-auto text-[11px]",children:[t.jsxs("div",{className:"sticky top-0 flex items-center gap-2 px-2 py-1 bg-surface border-b border-border",children:[t.jsxs("span",{className:"text-text-muted",children:[l.length," comment",l.length===1?"":"s"]}),t.jsx("button",{className:"text-text-muted hover:text-text-primary",onClick:()=>y(a,l.map(u=>u.id)),children:"Select all"}),t.jsx("button",{className:"text-text-muted hover:text-text-primary",onClick:()=>y(a,[]),children:"Clear"}),t.jsx("div",{className:"flex-1"}),t.jsxs("button",{className:"px-2 py-0.5 bg-accent text-white rounded hover:bg-accent-hover",onClick:c,children:["Send ",f.size>0?`(${f.size})`:""]}),t.jsx("button",{className:"text-text-muted hover:text-red-400",onClick:()=>C(a),title:"Delete all comments",children:"Clear all"})]}),p.map(([u,v])=>t.jsxs("div",{children:[t.jsx("div",{className:"px-2 py-1 bg-background border-b border-border/40 text-text-muted font-mono",children:u}),v.map((b,I)=>t.jsxs("div",{className:"flex items-start gap-2 px-2 py-1.5 border-b border-border/30 hover:bg-surface-hover",children:[t.jsx("input",{type:"checkbox",checked:f.has(b.id),onChange:()=>h(a,b.id),className:"mt-0.5 rounded border-border"}),t.jsxs("span",{className:"text-accent font-semibold w-5 flex-shrink-0",children:["#",I+1]}),t.jsxs("div",{className:"flex-1 min-w-0",children:[t.jsx("div",{className:"text-text-muted font-mono text-[10px] truncate",children:b.anchor.selector}),t.jsx("div",{className:"text-text-primary break-words",children:b.text}),t.jsxs("div",{className:"text-text-muted/70 text-[10px]",children:["@ (",Math.round(b.position.x),", ",Math.round(b.position.y),") · ",b.viewport.width,"×",b.viewport.height,b.viewport.isDeviceMode&&" (device)"]})]}),t.jsx("button",{className:"text-text-muted hover:text-text-primary",onClick:()=>s(b),title:"Jump to comment",children:"↗"}),t.jsx("button",{className:"text-text-muted hover:text-red-400",onClick:()=>k(a,b.id),title:"Delete",children:"✕"})]},b.id))]},u))]})}const kn=`
(function() {
  try {
    if (window.__1dt_comment_mode__ && window.__1dt_comment_mode__.enabled) return;

    var existing = window.__1dt_comment_mode__;
    if (existing && typeof existing.enable === 'function') {
      existing.enable();
      return;
    }

    var state = {
      enabled: true,
      hoverEl: null,
      overlay: null,
      rafPending: false,
      lastMouseEvent: null,
      lastScrollRaf: false,
      keyHandler: null,
    };

    function makeOverlay() {
      var el = document.createElement('div');
      el.id = '__1dt_cmt_outline__';
      el.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483646',
        'border:2px solid #3b82f6',
        'background:rgba(59,130,246,0.08)',
        'transition:top 80ms ease,left 80ms ease,width 80ms ease,height 80ms ease',
        'display:none',
      ].join(';');
      document.documentElement.appendChild(el);
      return el;
    }

    // Select the EXACT element under the cursor (devtools-style) so inner
    // elements are reachable — do not walk up to a block-level ancestor, which
    // made nested spans/buttons/icons unselectable (they got swallowed by their
    // container li/section). Only normalize the document root away.
    function closestCommentable(el) {
      if (!el) return null;
      if (el === document.documentElement || el === document.body) {
        return document.body || el;
      }
      return el;
    }

    function describeAnchor(el) {
      var tag = (el.tagName || '').toLowerCase();
      var classes = '';
      if (typeof el.className === 'string') {
        classes = el.className.trim().split(/\\s+/).slice(0, 3).join(' ');
      }
      var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);

      var selector = tag;
      if (el.id) {
        selector = tag + '#' + el.id;
      } else if (classes) {
        selector = tag + '.' + classes.split(' ').join('.');
      } else {
        var parent = el.parentElement;
        if (parent) {
          var idx = Array.prototype.indexOf.call(parent.children, el);
          if (idx >= 0) selector = tag + ':nth-child(' + (idx + 1) + ')';
        }
      }

      var componentName, componentFile, componentLine;
      try {
        var keys = Object.keys(el);
        var fiberKey = keys.find(function(k) {
          return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
        });
        if (fiberKey) {
          var fiber = el[fiberKey];
          var cur = fiber;
          while (cur) {
            if (cur.type && typeof cur.type !== 'string') {
              var name = cur.type.displayName || cur.type.name;
              if (name) {
                componentName = name;
                if (cur._debugSource) {
                  componentFile = cur._debugSource.fileName || '';
                  componentLine = cur._debugSource.lineNumber || 0;
                }
                break;
              }
            }
            cur = cur.return;
          }
        }
      } catch (e) {}

      return {
        selector: selector,
        tag: tag,
        text: text,
        classes: classes,
        componentName: componentName,
        componentFile: componentFile,
        componentLine: componentLine,
      };
    }

    // Events reach the host through a guest-side outbox queue that the host
    // drains via executeJavaScript polling. We deliberately do NOT use
    // console.log: production sites routinely strip/no-op the console
    // (Next.js removeConsole, terser drop_console), which would silently
    // swallow every event. The outbox is immune to that and to frame quirks.
    function emit(type, payload) {
      try {
        if (!window.__1dt_outbox__) window.__1dt_outbox__ = [];
        window.__1dt_outbox__.push({ type: type, payload: payload });
        if (window.__1dt_outbox__.length > 300) window.__1dt_outbox__.shift();
      } catch (e) {}
    }

    function isOverlayElement(el) {
      while (el) {
        if (el.id === '__1dt_cmt_outline__') return true;
        el = el.parentElement;
      }
      return false;
    }

    function updateOutline() {
      state.rafPending = false;
      if (!state.enabled || !state.lastMouseEvent || !state.overlay) return;
      var e = state.lastMouseEvent;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || isOverlayElement(el)) {
        state.overlay.style.display = 'none';
        state.hoverEl = null;
        return;
      }
      var block = closestCommentable(el);
      state.hoverEl = block;
      var rect = block.getBoundingClientRect();
      state.overlay.style.display = 'block';
      state.overlay.style.top = rect.top + 'px';
      state.overlay.style.left = rect.left + 'px';
      state.overlay.style.width = rect.width + 'px';
      state.overlay.style.height = rect.height + 'px';
    }

    function onMouseMove(e) {
      if (!state.enabled) return;
      state.lastMouseEvent = e;
      if (state.rafPending) return;
      state.rafPending = true;
      requestAnimationFrame(updateOutline);
    }

    function onClick(e) {
      if (!state.enabled) return;
      if (isOverlayElement(e.target)) return;
      var block = state.hoverEl || closestCommentable(e.target);
      if (!block) return;

      e.preventDefault();
      e.stopPropagation();

      var rect = block.getBoundingClientRect();
      var scrollX = window.scrollX || window.pageXOffset || 0;
      var scrollY = window.scrollY || window.pageYOffset || 0;

      emit('click', {
        position: {
          x: e.clientX + scrollX,
          y: e.clientY + scrollY,
          blockRect: {
            x: rect.left + scrollX,
            y: rect.top + scrollY,
            width: rect.width,
            height: rect.height,
          },
        },
        anchor: describeAnchor(block),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        url: location.href,
        scroll: { x: scrollX, y: scrollY },
      });
    }

    function onScroll() {
      if (state.lastScrollRaf) return;
      state.lastScrollRaf = true;
      requestAnimationFrame(function() {
        state.lastScrollRaf = false;
        emit('scroll', {
          x: window.scrollX || window.pageXOffset || 0,
          y: window.scrollY || window.pageYOffset || 0,
        });
        if (state.enabled && state.lastMouseEvent) updateOutline();
      });
    }

    function onResize() {
      emit('resize', { width: window.innerWidth, height: window.innerHeight });
    }

    function onKeyDown(e) {
      if (!state.enabled) return;
      if (e.key === 'Escape') {
        emit('escape', {});
      }
    }

    state.overlay = makeOverlay();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onResize, true);
    document.addEventListener('keydown', onKeyDown, true);
    state.keyHandler = onKeyDown;

    state.enable = function() {
      state.enabled = true;
      if (!state.overlay || !state.overlay.isConnected) {
        state.overlay = makeOverlay();
      }
    };

    state.disable = function() {
      state.enabled = false;
      if (state.overlay) state.overlay.style.display = 'none';
      state.hoverEl = null;
    };

    state.cleanup = function() {
      state.enabled = false;
      try { document.removeEventListener('mousemove', onMouseMove, true); } catch (e) {}
      try { document.removeEventListener('click', onClick, true); } catch (e) {}
      try { window.removeEventListener('scroll', onScroll, true); } catch (e) {}
      try { window.removeEventListener('resize', onResize, true); } catch (e) {}
      try { document.removeEventListener('keydown', onKeyDown, true); } catch (e) {}
      try { state.overlay && state.overlay.remove(); } catch (e) {}
      state.overlay = null;
      if (window.__1dt_comment_mode__ === state) {
        delete window.__1dt_comment_mode__;
      }
    };

    window.__1dt_comment_mode__ = state;

    emit('ready', {
      scroll: {
        x: window.scrollX || window.pageXOffset || 0,
        y: window.scrollY || window.pageYOffset || 0,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
  } catch (err) {
    try { console.warn('[1DT:cmt:error] ' + (err && err.message ? err.message : String(err))); } catch (e) {}
  }
})();
`,Xr=`
(function() {
  try {
    var s = window.__1dt_comment_mode__;
    if (s && typeof s.disable === 'function') s.disable();
  } catch (e) {}
})();
`,qr=`
(function() {
  try {
    var s = window.__1dt_comment_mode__;
    if (s && typeof s.cleanup === 'function') s.cleanup();
  } catch (e) {}
})();
`,Jr=`
(function() {
  try {
    var o = window.__1dt_outbox__;
    if (!o || !o.length) return [];
    window.__1dt_outbox__ = [];
    return o;
  } catch (e) {
    return [];
  }
})();
`,Yr=`
(function(selector) {
  try {
    var el = document.querySelector(selector);
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    var scrollX = window.scrollX || window.pageXOffset || 0;
    var scrollY = window.scrollY || window.pageYOffset || 0;
    return {
      x: rect.left + scrollX,
      y: rect.top + scrollY,
      width: rect.width,
      height: rect.height,
    };
  } catch (e) {
    return null;
  }
})(`;function Kr(a){return Yr+JSON.stringify(a)+");"}const Nn=`
(function() {
  try {
    if (window.__1dt_router_patched__) return;
    window.__1dt_router_patched__ = true;

    // Route events flow through the shared guest outbox (drained by the host),
    // not console.log — see commentInjection.ts for why.
    function emit(kind) {
      try {
        if (!window.__1dt_outbox__) window.__1dt_outbox__ = [];
        window.__1dt_outbox__.push({ type: 'route', payload: { kind: kind, url: location.href } });
      } catch (e) {}
    }

    var origPush = history.pushState;
    history.pushState = function() {
      var ret = origPush.apply(this, arguments);
      emit('pushState');
      return ret;
    };

    var origReplace = history.replaceState;
    history.replaceState = function() {
      var ret = origReplace.apply(this, arguments);
      emit('replaceState');
      return ret;
    };

    window.addEventListener('popstate', function() { emit('popstate'); }, true);
  } catch (e) {}
})();
`;function Gr({debugPanelHeight:a,panelTab:s,consoleEntries:c,filteredEntries:l,consoleFilter:f,consoleSearch:h,consoleCounts:y,networkEntries:k,filteredNetworkEntries:C,networkFilter:p,selectedNetworkEntry:u,isRecording:v,consoleEndRef:b,panelId:I,commentCount:L,onConsoleFilterChange:j,onConsoleSearchChange:z,onPanelTabChange:x,onNetworkFilterChange:w,onSendToTerminal:P,onToggleRecording:$,onClearConsole:W,onClearNetwork:K,onOpenDevTools:G,onClose:V,onContextMenu:te,onSelectNetworkEntry:pe,onJumpToComment:we}){return t.jsxs("div",{"data-testid":"browser-debug-panel",className:"flex flex-col bg-background",style:{flex:`0 0 ${a}px`,minHeight:120,height:a},children:[t.jsxs("div",{className:"flex items-center gap-1 px-2 py-1 border-t border-border bg-surface",children:[t.jsxs("div",{className:"flex items-center gap-0.5",children:[t.jsxs("button",{className:`px-2 py-0.5 text-xs font-medium rounded ${s==="console"?"bg-accent text-white":"text-text-muted hover:text-text-primary hover:bg-surface-hover"}`,onClick:()=>x("console"),children:["Console",c.length>0&&t.jsxs("span",{className:"ml-1 text-[10px]",children:["(",c.length,")"]})]}),t.jsxs("button",{className:`px-2 py-0.5 text-xs font-medium rounded ${s==="network"?"bg-accent text-white":"text-text-muted hover:text-text-primary hover:bg-surface-hover"}`,onClick:()=>x("network"),children:["Network",k.length>0&&t.jsxs("span",{className:"ml-1 text-[10px]",children:["(",k.length,")"]})]}),t.jsxs("button",{className:`px-2 py-0.5 text-xs font-medium rounded ${s==="comments"?"bg-accent text-white":"text-text-muted hover:text-text-primary hover:bg-surface-hover"}`,onClick:()=>x("comments"),children:["Comments",L>0&&t.jsxs("span",{className:"ml-1 text-[10px]",children:["(",L,")"]})]})]}),s==="console"&&t.jsxs(t.Fragment,{children:[t.jsx("div",{className:"flex items-center gap-0.5 ml-2",children:["all","logs","interactions","errors"].map(o=>t.jsxs("button",{className:`px-1.5 py-0.5 text-[10px] rounded ${f===o?"bg-surface-hover text-text-primary":"text-text-muted hover:text-text-primary hover:bg-surface-hover"}`,onClick:()=>j(o),children:[o==="all"?"All":o.charAt(0).toUpperCase()+o.slice(1),y[o]>0&&t.jsxs("span",{className:`ml-0.5 ${o==="errors"?"text-red-300":o==="interactions"?"text-purple-300":""}`,children:["(",y[o],")"]})]},o))}),t.jsx("input",{type:"text",value:h,onChange:o=>z(o.target.value),placeholder:"Filter...",className:"ml-2 px-2 py-0.5 text-[10px] w-32 bg-background border border-border rounded"})]}),s==="network"&&t.jsx("input",{type:"text",value:p,onChange:o=>w(o.target.value),placeholder:"Filter...",className:"ml-2 px-2 py-0.5 text-[10px] w-32 bg-background border border-border rounded"}),t.jsx("div",{className:"flex-1"}),t.jsx("button",{className:"p-1 text-xs text-text-muted hover:text-accent",onClick:P,title:"Send to AI Terminal",children:"AI"}),t.jsx("button",{className:`p-1 text-xs ${v?"text-red-400":"text-text-muted"}`,onClick:$,title:v?"Stop Recording":"Start Recording",children:v?"⏺":"⏸"}),t.jsx("button",{className:"p-1 text-xs text-text-muted hover:text-text-primary",onClick:s==="console"?W:K,title:s==="console"?"Clear Console":"Clear Network",children:"🗑"}),t.jsx("button",{className:"p-1 text-xs text-text-muted hover:text-text-primary",onClick:G,title:"Open DevTools",children:"🔧"}),t.jsx("button",{className:"p-1 text-xs text-text-muted hover:text-text-primary",onClick:V,title:"Close Panel",children:"✕"})]}),s==="console"&&t.jsxs("div",{className:"flex-1 overflow-y-auto font-mono text-[11px] pb-4",children:[l.length===0?t.jsx("div",{className:"flex items-center justify-center h-full text-text-muted text-xs",children:c.length===0?"No console messages":"No messages match filter"}):l.map(o=>t.jsxs("div",{className:`flex items-start gap-2 px-2 py-0.5 border-b border-border/50 hover:bg-surface-hover cursor-context-menu ${o.level==="error"?"bg-red-500/10 text-red-400":o.level==="warn"?"bg-yellow-500/10 text-yellow-400":o.level==="info"?"text-blue-400":o.level==="click"?"bg-purple-500/10 text-purple-400":o.level==="input"?"bg-cyan-500/10 text-cyan-400":o.level==="submit"?"bg-green-500/10 text-green-400":o.level==="navigation"?"bg-orange-500/10 text-orange-400":o.level==="network"?"bg-indigo-500/10 text-indigo-400":o.level==="component"?"bg-sky-500/10 text-sky-400":"text-text-secondary"}`,onContextMenu:g=>te(g,o,"console"),children:[t.jsx("span",{className:"text-text-muted flex-shrink-0 w-[52px]",children:_r(o.timestamp)}),t.jsx("span",{className:"flex-shrink-0 w-[40px]",children:o.level==="error"?"❌":o.level==="warn"?"⚠️":o.level==="info"?"ℹ️":o.level==="click"?"👆":o.level==="input"?"⌨️":o.level==="submit"?"📤":o.level==="navigation"?"🧭":o.level==="network"?"🌐":o.level==="component"?"⚛️":"📝"}),t.jsx("span",{className:"flex-1 break-all whitespace-pre-wrap",children:o.message}),o.source&&t.jsxs("span",{className:"text-text-muted flex-shrink-0 text-[10px] truncate max-w-[100px]",title:o.source,children:[o.source.split("/").pop(),":",o.line]})]},o.id)),t.jsx("div",{ref:b})]}),s==="network"&&t.jsxs("div",{className:"flex-1 flex min-h-0",children:[t.jsxs("div",{className:`overflow-y-auto font-mono text-[11px] ${u?"w-1/2 border-r border-border":"w-full"}`,children:[t.jsxs("div",{className:"flex items-center gap-2 px-2 py-1 bg-surface border-b border-border text-[10px] text-text-muted font-medium sticky top-0",children:[t.jsx("span",{className:"w-[60px]",children:"Status"}),t.jsx("span",{className:"w-[50px]",children:"Method"}),t.jsx("span",{className:"flex-1",children:"URL"}),t.jsx("span",{className:"w-[50px] text-right",children:"Type"}),t.jsx("span",{className:"w-[60px] text-right",children:"Time"}),t.jsx("span",{className:"w-[60px] text-right",children:"Size"})]}),C.length===0?t.jsx("div",{className:"flex items-center justify-center h-full text-text-muted text-xs p-4",children:k.length===0?"No network requests":"No requests match filter"}):C.map(o=>t.jsxs("div",{className:`flex items-center gap-2 px-2 py-1 border-b border-border/50 cursor-pointer hover:bg-surface-hover ${(u==null?void 0:u.id)===o.id?"bg-accent/20":""} ${o.error?"text-red-400":o.status===null?"text-text-muted":o.status>=400?"text-red-400":o.status>=300?"text-yellow-400":"text-text-secondary"}`,onClick:()=>pe(o),onContextMenu:g=>te(g,o,"network"),children:[t.jsx("span",{className:`w-[60px] font-medium ${o.error?"text-red-400":o.status===null?"":o.status>=400?"text-red-400":o.status>=300?"text-yellow-400":"text-green-400"}`,children:o.error?"Error":o.status??"⏳"}),t.jsx("span",{className:`w-[50px] ${o.method==="GET"?"text-blue-400":o.method==="POST"?"text-green-400":o.method==="PUT"?"text-yellow-400":o.method==="DELETE"?"text-red-400":"text-purple-400"}`,children:o.method}),t.jsx("span",{className:"flex-1 truncate",title:o.url,children:(()=>{try{const g=new URL(o.url,window.location.origin);return g.pathname+g.search}catch{return o.url}})()}),t.jsx("span",{className:"w-[50px] text-right text-text-muted",children:o.type}),t.jsx("span",{className:"w-[60px] text-right",children:o.duration!==null?`${o.duration}ms`:"..."}),t.jsx("span",{className:"w-[60px] text-right text-text-muted",children:o.responseSize!==null?bn(o.responseSize):"-"})]},o.id))]}),u&&t.jsxs("div",{className:"w-1/2 overflow-y-auto text-[11px]",children:[t.jsxs("div",{className:"sticky top-0 flex items-center justify-between px-2 py-1 bg-surface border-b border-border",children:[t.jsx("span",{className:"text-xs font-medium text-text-secondary",children:"Request Details"}),t.jsx("button",{className:"p-0.5 text-text-muted hover:text-text-primary",onClick:()=>pe(null),children:"✕"})]}),t.jsxs("div",{className:"p-2 space-y-3",children:[t.jsxs("div",{children:[t.jsx("div",{className:"text-[10px] text-text-muted font-medium mb-1",children:"General"}),t.jsxs("div",{className:"space-y-0.5 text-text-secondary",children:[t.jsxs("div",{children:[t.jsx("span",{className:"text-text-muted",children:"URL:"})," ",t.jsx("span",{className:"break-all",children:u.url})]}),t.jsxs("div",{children:[t.jsx("span",{className:"text-text-muted",children:"Method:"})," ",u.method]}),t.jsxs("div",{children:[t.jsx("span",{className:"text-text-muted",children:"Status:"})," ",t.jsx("span",{className:u.error||u.status!==null&&u.status>=400?"text-red-400":"text-green-400",children:u.error||`${u.status} ${u.statusText}`})]}),t.jsxs("div",{children:[t.jsx("span",{className:"text-text-muted",children:"Type:"})," ",u.type.toUpperCase()]}),t.jsxs("div",{children:[t.jsx("span",{className:"text-text-muted",children:"Duration:"})," ",u.duration!==null?`${u.duration}ms`:"Pending"]}),t.jsxs("div",{children:[t.jsx("span",{className:"text-text-muted",children:"Size:"})," ",u.responseSize!==null?bn(u.responseSize):"-"]})]})]}),u.requestBody&&t.jsxs("div",{children:[t.jsx("div",{className:"text-[10px] text-text-muted font-medium mb-1",children:"Request Body"}),t.jsx("pre",{className:"p-2 bg-background rounded text-[10px] overflow-x-auto whitespace-pre-wrap break-all max-h-[100px] overflow-y-auto",children:wn(u.requestBody)})]}),u.responseBody&&t.jsxs("div",{children:[t.jsx("div",{className:"text-[10px] text-text-muted font-medium mb-1",children:"Response Body"}),t.jsx("pre",{className:"p-2 bg-background rounded text-[10px] overflow-x-auto whitespace-pre-wrap break-all max-h-[150px] overflow-y-auto",children:wn(u.responseBody)})]})]})]})]}),s==="comments"&&t.jsx(Wr,{panelId:I,onJumpTo:we,onSendToTerminal:P})]})}const lt=[{name:"iPhone SE",width:375,height:667,category:"phone"},{name:"iPhone 14",width:390,height:844,category:"phone"},{name:"iPhone 14 Pro Max",width:430,height:932,category:"phone"},{name:"Samsung Galaxy S21",width:360,height:800,category:"phone"},{name:"Pixel 7",width:412,height:915,category:"phone"},{name:"iPad Mini",width:768,height:1024,category:"tablet"},{name:"iPad Air",width:820,height:1180,category:"tablet"},{name:'iPad Pro 12.9"',width:1024,height:1366,category:"tablet"},{name:"Laptop (1366x768)",width:1366,height:768,category:"desktop"},{name:"Desktop (1920x1080)",width:1920,height:1080,category:"desktop"}],Cn=[.25,.33,.5,.67,.75,.8,.9,1,1.1,1.25,1.5,1.75,2,2.5,3];function Vr({selectedDevice:a,deviceWidth:s,deviceHeight:c,onSelectDevice:l,onWidthChange:f,onHeightChange:h,onRotate:y}){const k={phone:lt.filter(p=>p.category==="phone"),tablet:lt.filter(p=>p.category==="tablet"),desktop:lt.filter(p=>p.category==="desktop")},C=p=>{const u=p.target.value;if(u==="__custom__"){l(null);return}const v=lt.find(b=>b.name===u);v&&(l(v.name),f(v.width),h(v.height))};return t.jsxs("div",{className:"no-drag flex flex-shrink-0 items-center gap-2 border-b border-border px-2 py-1 bg-surface-hover/50 text-xs",children:[t.jsxs("select",{value:a??"__custom__",onChange:C,className:"bg-surface border border-border rounded px-1.5 py-0.5 text-xs text-text-primary min-w-[140px]",children:[t.jsx("optgroup",{label:"Phones",children:k.phone.map(p=>t.jsx("option",{value:p.name,children:p.name},p.name))}),t.jsx("optgroup",{label:"Tablets",children:k.tablet.map(p=>t.jsx("option",{value:p.name,children:p.name},p.name))}),t.jsx("optgroup",{label:"Desktop",children:k.desktop.map(p=>t.jsx("option",{value:p.name,children:p.name},p.name))}),t.jsx("option",{value:"__custom__",children:"Custom"})]}),t.jsxs("div",{className:"flex items-center gap-1",children:[t.jsx("input",{type:"number",value:s,onChange:p=>{const u=parseInt(p.target.value,10);u>0&&(f(u),l(null))},className:"w-14 bg-surface border border-border rounded px-1.5 py-0.5 text-xs text-text-primary text-center",min:100,max:3840}),t.jsx("span",{className:"text-text-muted",children:"×"}),t.jsx("input",{type:"number",value:c,onChange:p=>{const u=parseInt(p.target.value,10);u>0&&(h(u),l(null))},className:"w-14 bg-surface border border-border rounded px-1.5 py-0.5 text-xs text-text-primary text-center",min:100,max:3840})]}),t.jsx("button",{onClick:y,className:"p-0.5 text-text-muted hover:text-text-primary",title:"Rotate (swap width/height)",children:t.jsx("svg",{className:"h-3.5 w-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",children:t.jsx("path",{d:"M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-9L21 12m0 0l-4.5 4.5M21 12H7.5"})})})]})}function Zr({isInspectorActive:a,inspectedComponent:s,onClear:c,onOpenComponentFile:l}){return!a&&!s?null:t.jsxs("div",{className:"flex-shrink-0 border-b border-border bg-surface px-3 py-2",children:[t.jsxs("div",{className:"flex items-center justify-between",children:[t.jsxs("div",{className:"flex items-center gap-2",children:[t.jsx("span",{className:"text-xs text-text-muted",children:"⚛️ React Inspector"}),a&&t.jsx("span",{className:"text-[10px] px-1.5 py-0.5 bg-accent/20 text-accent rounded",children:"Active"})]}),s&&t.jsx("button",{onClick:c,className:"text-xs text-text-muted hover:text-text-primary",children:"✕"})]}),s?t.jsxs("div",{className:"mt-2 space-y-1",children:[t.jsxs("div",{className:"flex items-center gap-2",children:[t.jsxs("span",{className:"text-sm font-medium text-blue-400",children:["<",s.componentName,">"]}),s.fileName&&t.jsxs("button",{onClick:l,className:"text-xs text-text-muted hover:text-accent hover:underline",title:"Click to open in editor",children:[s.fileName.split("/").slice(-2).join("/"),":",s.lineNumber]})]}),s.componentStack.length>1&&t.jsxs("div",{className:"text-[10px] text-text-muted",children:["Stack: ",s.componentStack.slice(0,8).map((f,h)=>t.jsxs("span",{children:[h>0&&" > ",t.jsx("span",{className:h===0?"text-blue-400":"",children:f})]},h)),s.componentStack.length>8&&"..."]})]}):t.jsx("div",{className:"mt-1 text-xs text-text-muted",children:"Click on any element in the browser to inspect its React component"})]})}function Qr({canGoBack:a,canGoForward:s,isLoading:c,inputUrl:l,isInspectorActive:f,showConsole:h,consoleErrorCount:y,isPanelFullscreen:k,deviceMode:C,zoomFactor:p,commentMode:u,commentCount:v,onBack:b,onForward:I,onRefresh:L,onInputUrlChange:j,onInputKeyDown:z,onTakeScreenshot:x,onToggleInspector:w,onToggleConsole:P,onOpenExternal:$,onTogglePanelFullscreen:W,onToggleDeviceMode:K,onToggleCommentMode:G,onZoomIn:V,onZoomOut:te,onZoomReset:pe}){const we=Math.round(p*100);return t.jsxs("div",{className:"no-drag flex flex-shrink-0 items-center gap-1 border-b border-border p-1",children:[t.jsx("button",{"data-testid":"browser-back-button",className:"flex-shrink-0 p-1 text-text-muted hover:text-text-primary disabled:opacity-30",onClick:b,disabled:!a,title:"Back",children:"←"}),t.jsx("button",{"data-testid":"browser-forward-button",className:"flex-shrink-0 p-1 text-text-muted hover:text-text-primary disabled:opacity-30",onClick:I,disabled:!s,title:"Forward",children:"→"}),t.jsx("button",{"data-testid":"browser-refresh-button",className:"flex-shrink-0 p-1 text-text-muted hover:text-text-primary",onClick:L,title:"Refresh",children:c?"⏳":"↻"}),t.jsx("input",{"data-testid":"browser-url-input",type:"text",value:l,onChange:o=>j(o.target.value),onKeyDown:z,className:"flex-1 min-w-0 text-xs",placeholder:"https://1devtool.com/"}),t.jsxs("div",{className:"flex-shrink-0 flex items-center gap-1",children:[t.jsx("button",{className:`p-1 text-xs ${C?"text-accent bg-accent/20 rounded":"text-text-muted hover:text-accent"}`,onClick:K,title:C?"Disable Device Emulation":"Enable Device Emulation",children:t.jsxs("svg",{className:"h-4 w-4",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",children:[t.jsx("rect",{x:"5",y:"2",width:"14",height:"20",rx:"2",ry:"2"}),t.jsx("line",{x1:"12",y1:"18",x2:"12.01",y2:"18"})]})}),t.jsxs("div",{className:"flex items-center",children:[t.jsx("button",{className:"p-1 text-xs text-text-muted hover:text-text-primary disabled:opacity-30",onClick:te,disabled:p<=.25,title:"Zoom Out (Cmd+-)",children:t.jsx("svg",{className:"h-3.5 w-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",children:t.jsx("line",{x1:"5",y1:"12",x2:"19",y2:"12"})})}),t.jsxs("button",{className:"px-1 text-[10px] text-text-muted hover:text-text-primary min-w-[36px] text-center",onClick:pe,title:"Reset Zoom (Cmd+0)",children:[we,"%"]}),t.jsx("button",{className:"p-1 text-xs text-text-muted hover:text-text-primary disabled:opacity-30",onClick:V,disabled:p>=3,title:"Zoom In (Cmd++)",children:t.jsxs("svg",{className:"h-3.5 w-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",children:[t.jsx("line",{x1:"12",y1:"5",x2:"12",y2:"19"}),t.jsx("line",{x1:"5",y1:"12",x2:"19",y2:"12"})]})})]}),t.jsx("button",{className:"p-1 text-xs text-text-muted hover:text-accent",onClick:x,title:"Take Screenshot",children:"📷"}),t.jsxs("button",{className:`relative p-1 text-xs ${u?"text-accent bg-accent/20 rounded":"text-text-muted hover:text-accent"}`,onClick:G,title:u?"Exit comment mode (Esc)":"Add comments to pages (C)",children:[t.jsx("svg",{className:"h-4 w-4",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",children:t.jsx("path",{d:"M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"})}),v>0&&t.jsx("span",{className:"absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-accent text-[9px] leading-[14px] text-white text-center font-semibold",children:v>99?"99+":v})]}),t.jsx("button",{className:`p-1 text-xs ${f?"text-accent bg-accent/20 rounded":"text-text-muted hover:text-accent"}`,onClick:w,title:"React Component Inspector (click to toggle)",children:"⚛️"}),t.jsx("button",{className:`p-1 text-xs ${h?"text-accent":"text-text-muted hover:text-text-primary"}`,onClick:P,title:"Toggle Console",children:y>0?t.jsxs("span",{className:"flex items-center gap-0.5",children:[t.jsx("span",{children:"⚠"}),t.jsx("span",{className:"text-red-400",children:y})]}):"⚙"}),t.jsx("button",{"data-testid":"browser-open-external-button",className:"p-1 text-text-muted hover:text-text-primary text-xs",onClick:$,title:"Open in Browser",children:"↗"}),t.jsx("button",{"data-testid":"browser-fullscreen-button",className:`p-1 text-xs ${k?"text-accent":"text-text-muted hover:text-text-primary"}`,onClick:W,title:k?"Exit Browser Fullscreen":"Expand Browser Fullscreen",children:t.jsxs("svg",{className:"h-4 w-4",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":"true",children:[t.jsx("path",{d:"M8 3H5a2 2 0 0 0-2 2v3"}),t.jsx("path",{d:"M16 3h3a2 2 0 0 1 2 2v3"}),t.jsx("path",{d:"M8 21H5a2 2 0 0 1-2-2v-3"}),t.jsx("path",{d:"M16 21h3a2 2 0 0 0 2-2v-3"})]})}),t.jsx(Sr,{tab:"browser",title:"Browser settings",className:"p-1 text-text-muted hover:text-text-primary",size:14})]})]})}function eo({webviewRef:a,loadError:s,currentUrl:c,isPanelFullscreen:l,isHtmlFullscreen:f,isResizingDebugPanel:h,deviceMode:y,deviceWidth:k,deviceHeight:C,onRetry:p}){const u=r.useRef(null),[v,b]=r.useState({width:0,height:0});r.useEffect(()=>{const P=u.current;if(!P)return;const $=new ResizeObserver(W=>{for(const K of W)b({width:K.contentRect.width,height:K.contentRect.height})});return $.observe(P),()=>$.disconnect()},[]);let I=1;if(y&&v.width>0&&v.height>0){const $=v.width-32,W=v.height-32,K=$/k,G=W/C;I=Math.min(1,K,G)}const L=r.useCallback(()=>{jr.getState().setFocusedPanel("browser")},[]),j=s&&!l&&!f,z=y?{display:j?"none":"flex",width:k,height:C,border:"none",pointerEvents:h?"none":"auto"}:{display:j?"none":"flex",position:"absolute",top:0,left:0,right:0,bottom:0,border:"none",pointerEvents:h?"none":"auto"},x=y?{width:k,height:C,transform:I<1?`scale(${I})`:void 0,transformOrigin:"center center",flexShrink:0,borderRadius:8,overflow:"hidden",boxShadow:"0 0 0 1px rgba(255,255,255,0.1), 0 8px 32px rgba(0,0,0,0.4)",position:"relative"}:{position:"absolute",top:0,left:0,right:0,bottom:0},w={backgroundColor:"#1a1a1a",backgroundImage:"linear-gradient(45deg, #222 25%, transparent 25%, transparent 75%, #222 75%, #222), linear-gradient(45deg, #222 25%, transparent 25%, transparent 75%, #222 75%, #222)",backgroundSize:"16px 16px",backgroundPosition:"0 0, 8px 8px"};return t.jsxs("div",{ref:u,className:`relative flex-1 min-h-0 min-w-0 overflow-hidden ${y?"flex items-center justify-center":""}`,style:y?w:{backgroundColor:"white"},onMouseDown:L,children:[t.jsx("div",{style:x,children:t.jsx("webview",{"data-testid":"browser-webview",ref:a,src:"about:blank",style:z,allowFullScreen:!0,allowpopups:"true",webpreferences:"contextIsolation=yes, plugins=yes",useragent:Rr||void 0})}),s&&t.jsxs("div",{className:"absolute inset-0 flex flex-col items-center justify-center bg-surface text-text-muted p-4",children:[t.jsx("div",{className:"text-4xl mb-4",children:"🌐"}),t.jsx("div",{className:"text-sm font-medium text-text-primary mb-2",children:"Cannot connect"}),t.jsx("div",{className:"text-xs text-center mb-4 max-w-[200px]",children:s.includes("ERR_CONNECTION_REFUSED")?`No server running at ${c}`:s}),t.jsx("button",{onClick:p,className:"px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent-hover",children:"Retry"})]})]})}const _n="http://localhost:3000",to=r.memo(function({project:s,tabId:c,tabUrl:l,onNavigate:f,tabs:h,activeTabId:y,onSwitchTab:k,onAddTab:C,onCloseTab:p,isPanelFullscreen:u,onSetPanelFullscreen:v,panelId:b}){var ln,cn,dn,un,mn,pn,xn,at,hn,fn;const I=me(e=>e.updateProject),L=b??`${s.id}:browser`,j=c??y??"default",z=me(e=>e.activeWorktreePaths[s.id]??s.rootPath),x=l!==void 0,w=x?Ue(l):Ue(((dn=(cn=(ln=s.outputPanel)==null?void 0:ln.browser)==null?void 0:cn.worktreeUrls)==null?void 0:dn[z])??((mn=(un=s.outputPanel)==null?void 0:un.browser)==null?void 0:mn.url)),P=yn((xn=(pn=s.outputPanel)==null?void 0:pn.browser)==null?void 0:xn.history),W=!(w===_n||w===`${_n}/`)||P.length>0,[K,G]=r.useState(w),[V,te]=r.useState(w),pe=r.useRef(!1),[we,o]=r.useState(!1),[g,S]=r.useState(!1),[A,D]=r.useState(!1),[Z,X]=r.useState(null),[J,ce]=r.useState(!1),[ne,xe]=r.useState(!1),H=u!==void 0?u:ne,Ae=v||xe,[Tn,Lt]=r.useState(!1),[Q,ct]=r.useState(!1),[Pt,dt]=r.useState(260),[Ln,Pn]=r.useState(!1),[de,ut]=r.useState([]),[He,Mn]=r.useState("all"),[mt,Dn]=r.useState(""),[Ce,In]=r.useState(!0),We=r.useRef(Ce),Mt=r.useRef(Q),[Bn,Dt]=r.useState("console"),[Xe,pt]=r.useState([]),[On,It]=r.useState(null),[qe,Fn]=r.useState(""),Bt=r.useRef(0),je=r.useRef(null),B=r.useRef(null),re=r.useRef(!1),Ot=r.useRef(((hn=(at=globalThis.crypto)==null?void 0:at.randomUUID)==null?void 0:hn.call(at))??`${Date.now()}-${Math.random().toString(36).slice(2)}`),Je=r.useRef(w),Ye=r.useRef(!1),he=r.useRef(w),xt=r.useRef(0),ht=r.useRef(null),ye=r.useRef(null),ue=r.useRef(null),[ae,_e]=r.useState(null),[Ft,De]=r.useState(!1),[zn,zt]=r.useState(null),[$n,ft]=r.useState(null),[Un,gt]=r.useState([]),[vt,Ke]=r.useState(null),An=r.useRef(0),[Ie,Hn]=r.useState(!1),[ge,Ge]=r.useState(null),[fe,Wn]=r.useState(!1),[Xn,$t]=r.useState("iPhone 14"),[Ve,Ut]=r.useState(390),[Re,At]=r.useState(844),[bt,wt]=r.useState(1),[oe,Be]=r.useState(!1),[Se,Ht]=r.useState(!1),[Wt,qn]=r.useState(!0),[Ee,ke]=r.useState(null),[Xt,Jn]=r.useState({top:0,left:0}),[Ze,Yn]=r.useState(null),qt=r.useRef(oe),yt=r.useRef(Se),Jt=r.useRef(fe),kt=r.useRef(Ze);r.useEffect(()=>{qt.current=oe},[oe]),r.useEffect(()=>{yt.current=Se},[Se]),r.useEffect(()=>{Jt.current=fe},[fe]),r.useEffect(()=>{kt.current=Ze},[Ze]);const Te=Tt(L),Yt=En(L),Kt=ee(e=>e.addComment),Kn=ee(e=>e.clearPanel),Oe=ee(e=>e.setGuestScroll),Gt=r.useMemo(()=>Te.filter(e=>Yt.has(e.id)),[Te,Yt]),Nt=r.useRef(z);r.useEffect(()=>{var T,O;if(x||Nt.current===z)return;const e=Nt.current;Nt.current=z;const n=me.getState().projects.find(U=>U.id===s.id);if(!n)return;const i=he.current,d={...(O=(T=n.outputPanel)==null?void 0:T.browser)==null?void 0:O.worktreeUrls,...e&&i&&!be(i)?{[e]:i}:{}};I(s.id,{outputPanel:{...n.outputPanel,browser:{...n.outputPanel.browser,worktreeUrls:d}}});const m=d[z];if(m&&!be(m)){const U=Ue(m);te(U),he.current=U,G(U),Je.current=U,X(null),et(U)}},[z]),r.useEffect(()=>{We.current=Ce},[Ce]),r.useEffect(()=>{Mt.current=Q},[Q]);const Le=r.useCallback((e,n,i="",d=0,m)=>{if(!We.current)return;const T={id:++xt.current,level:e,message:n,source:i,line:d,timestamp:Date.now(),details:m};ut(O=>[...O.slice(-499),T])},[]),Gn=()=>{ut([]),xt.current=0},Vn=()=>{pt([]),It(null),Bt.current=0},Zn=(e,n,i)=>{e.preventDefault(),_e({x:e.clientX,y:e.clientY,entry:n,type:i})},Ct=e=>{zt(e||null),De(!0),_e(null)},_t=r.useCallback(async()=>{const e=B.current;if(!e){console.warn("Webview not available");return}try{if(typeof e.capturePage=="function"){const i=await e.capturePage();if(i&&typeof i.toDataURL=="function"){const d=i.toDataURL();if(d&&d!=="data:,"){Ke(d);return}}}const n=e.getBoundingClientRect();if(n.width>0&&n.height>0){const i=document.createElement("canvas");i.width=n.width,i.height=n.height;const d=i.getContext("2d");if(d){d.fillStyle="#f0f0f0",d.fillRect(0,0,i.width,i.height),d.fillStyle="#666",d.font="16px sans-serif",d.textAlign="center",d.fillText("Browser Screenshot",i.width/2,i.height/2-10),d.font="12px sans-serif",d.fillText(V,i.width/2,i.height/2+15);const m=i.toDataURL("image/png");Ke(m);return}}console.warn("Screenshot capture not fully supported")}catch(n){console.error("Failed to capture screenshot:",n)}},[V]),Qn=r.useCallback(e=>{const n={id:++An.current,dataUrl:e,timestamp:Date.now()};gt(i=>[...i,n]),Ke(null),De(!0)},[]),er=r.useCallback(()=>{Ke(null)},[]),tr=r.useCallback(e=>{gt(n=>n.filter(i=>i.id!==e))},[]),nr=r.useCallback(()=>{De(!1),_t()},[_t]),rr=r.useCallback(()=>{const e=B.current;if(!(e!=null&&e.executeJavaScript)||!e.isConnected||!re.current)return;const n=!Ie;Hn(n),Ge(null),n?e.executeJavaScript(`
        (function() {
          if (window.__1dt_inspector_active__) {
            window.__1dt_inspector_cleanup__?.();
          }
          window.__1dt_inspector_active__ = true;

          let highlightOverlay = document.createElement('div');
          highlightOverlay.id = '__1dt_inspector_overlay__';
          highlightOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:999999;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s ease;display:none;';
          document.body.appendChild(highlightOverlay);

          let infoBox = document.createElement('div');
          infoBox.id = '__1dt_inspector_info__';
          infoBox.style.cssText = 'position:fixed;z-index:999999;background:#1e1e1e;color:#fff;font-family:monospace;font-size:12px;padding:8px 12px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:none;display:none;max-width:400px;';
          document.body.appendChild(infoBox);

          function getReactFiber(element) {
            const keys = Object.keys(element);
            const fiberKey = keys.find(key =>
              key.startsWith('__reactFiber$') ||
              key.startsWith('__reactInternalInstance$')
            );
            return fiberKey ? element[fiberKey] : null;
          }

          function getComponentInfo(fiber) {
            if (!fiber) return null;

            let current = fiber;
            const componentStack = [];
            let found = null;

            while (current) {
              if (current.type && typeof current.type !== 'string') {
                const name = current.type.displayName || current.type.name || 'Anonymous';
                const debugSource = current._debugSource;

                componentStack.push(name);

                if (!found && debugSource) {
                  found = {
                    componentName: name,
                    fileName: debugSource.fileName || '',
                    lineNumber: debugSource.lineNumber || 0,
                    columnNumber: debugSource.columnNumber || 0,
                    componentStack: componentStack.slice()
                  };
                }
              }
              current = current.return;
            }

            if (!found && componentStack.length > 0) {
              found = {
                componentName: componentStack[0],
                fileName: '',
                lineNumber: 0,
                columnNumber: 0,
                componentStack: componentStack
              };
            }

            return found;
          }

          function handleMouseMove(e) {
            const element = document.elementFromPoint(e.clientX, e.clientY);
            if (!element || element === highlightOverlay || element === infoBox) return;

            const rect = element.getBoundingClientRect();
            highlightOverlay.style.display = 'block';
            highlightOverlay.style.top = rect.top + 'px';
            highlightOverlay.style.left = rect.left + 'px';
            highlightOverlay.style.width = rect.width + 'px';
            highlightOverlay.style.height = rect.height + 'px';

            const fiber = getReactFiber(element);
            const info = getComponentInfo(fiber);

            if (info) {
              infoBox.style.display = 'block';
              infoBox.style.top = Math.min(rect.bottom + 8, window.innerHeight - 80) + 'px';
              infoBox.style.left = Math.min(rect.left, window.innerWidth - 320) + 'px';

              let html = '<div style="color:#60a5fa;font-weight:bold;">&lt;' + info.componentName + '&gt;</div>';
              if (info.fileName) {
                const shortPath = info.fileName.replace(/\\/g, '/').split('/').slice(-2).join('/');
                html += '<div style="color:#9ca3af;font-size:11px;margin-top:4px;">' + shortPath + ':' + info.lineNumber + '</div>';
              }
              if (info.componentStack.length > 1) {
                html += '<div style="color:#6b7280;font-size:10px;margin-top:4px;">Stack: ' + info.componentStack.slice(0, 5).join(' > ') + '</div>';
              }
              infoBox.innerHTML = html;
            } else {
              infoBox.style.display = 'none';
            }
          }

          function handleClick(e) {
            e.preventDefault();
            e.stopPropagation();

            const element = document.elementFromPoint(e.clientX, e.clientY);
            if (!element) return;

            const fiber = getReactFiber(element);
            const info = getComponentInfo(fiber);

            if (info) {
              console.log('[1DT:component]', JSON.stringify(info));
            } else {
              console.log('[1DT:component]', JSON.stringify({
                componentName: element.tagName.toLowerCase(),
                fileName: '',
                lineNumber: 0,
                columnNumber: 0,
                componentStack: [element.tagName.toLowerCase()]
              }));
            }

            return false;
          }

          document.addEventListener('mousemove', handleMouseMove, true);
          document.addEventListener('click', handleClick, true);

          window.__1dt_inspector_cleanup__ = function() {
            document.removeEventListener('mousemove', handleMouseMove, true);
            document.removeEventListener('click', handleClick, true);
            highlightOverlay?.remove();
            infoBox?.remove();
            window.__1dt_inspector_active__ = false;
          };

          console.log('[1DT:inspector] React Component Inspector enabled - click any element to inspect');
        })();
      `).catch(()=>{}):e.executeJavaScript(`
        window.__1dt_inspector_cleanup__?.();
        console.log('[1DT:inspector] React Component Inspector disabled');
      `).catch(()=>{})},[Ie]),or=r.useCallback(()=>{if(!(ge!=null&&ge.fileName))return;const e=ge.fileName,n=ge.lineNumber,i=ge.columnNumber||1,d=`vscode://file/${e}:${n}:${i}`;window.api.app.openExternal(d).catch(()=>{navigator.clipboard.writeText(`${e}:${n}`),console.log("File path copied:",e,"line",n)})},[ge]),Fe=r.useCallback(()=>{wt(e=>Cn.find(i=>i>e)??e)},[]),ze=r.useCallback(()=>{wt(e=>[...Cn].reverse().find(i=>i<e)??e)},[]),$e=r.useCallback(()=>{wt(1)},[]);r.useEffect(()=>{if(!J)return;const e=B.current;e!=null&&e.setZoomFactor&&e.setZoomFactor(bt)},[bt,J]),r.useEffect(()=>{const e=window.api.app.onWebviewZoomShortcut(n=>{n==="in"?Fe():n==="out"?ze():n==="reset"?$e():n==="reload"&&jt()});return()=>{e()}},[Fe,ze,$e]);const sr=r.useCallback(()=>{Ut(e=>{const n=Re;return At(e),n}),$t(null)},[Re]),Vt=r.useCallback(e=>{if(!We.current)return;const n={...e,id:++Bt.current};return pt(i=>[...i.slice(-199),n]),n.id},[]),St=r.useCallback((e,n)=>{pt(i=>i.map(d=>d.id===e?{...d,...n}:d))},[]),ar=qe?Xe.filter(e=>e.url.toLowerCase().includes(qe.toLowerCase())||e.method.toLowerCase().includes(qe.toLowerCase())):Xe,Zt=["log","info","warn"],Qt=["click","input","submit","navigation","network","component"],en=["error"],tn=He==="all"?de:He==="logs"?de.filter(e=>Zt.includes(e.level)):He==="interactions"?de.filter(e=>Qt.includes(e.level)):de.filter(e=>en.includes(e.level)),ir=mt?tn.filter(e=>e.message.toLowerCase().includes(mt.toLowerCase())):tn,nn={all:de.length,logs:de.filter(e=>Zt.includes(e.level)).length,interactions:de.filter(e=>Qt.includes(e.level)).length,errors:de.filter(e=>en.includes(e.level)).length};r.useEffect(()=>{Q&&ht.current&&ht.current.scrollIntoView({behavior:"smooth"})},[de,Q]);const Qe=e=>{const n=Ue(e);te(n),he.current=n,G(n),X(null),et(n)},lr=e=>{var O,U;if(be(e))return;const n=Ue(e);if(Je.current===n)return;if(Je.current=n,f){f(n);return}const i=me.getState().projects.find(R=>R.id===s.id);if(!i)return;const m=yn((U=(O=i.outputPanel)==null?void 0:O.browser)==null?void 0:U.history).filter(R=>R!==n);m.unshift(n),m.length>20&&m.pop();const T=me.getState().activeWorktreePaths[s.id]??s.rootPath;I(s.id,{outputPanel:{...i.outputPanel,browser:{...i.outputPanel.browser,url:n,history:m,worktreeUrls:{...i.outputPanel.browser.worktreeUrls,[T]:n}}}})},cr=()=>{var n,i;if(!J)return;const e=B.current;o(((n=e==null?void 0:e.canGoBack)==null?void 0:n.call(e))??!1),S(((i=e==null?void 0:e.canGoForward)==null?void 0:i.call(e))??!1)},dr=e=>{if(!e||typeof e!="object")return!1;const n="code"in e?e.code:"",i="message"in e&&typeof e.message=="string"?e.message:"";return["ERR_ABORTED","ERR_INVALID_URL","ERR_CONNECTION_REFUSED","ERR_NAME_NOT_RESOLVED"].some(m=>n===m||i.includes(m))},et=async e=>{var i;const n=B.current;if(n!=null&&n.loadURL&&!be(e)&&ye.current!==e){try{if(((i=n.getURL)==null?void 0:i.call(n))===e)return}catch{}if(re.current||await new Promise(d=>{const m=()=>{n.removeEventListener("dom-ready",m),d()};n.addEventListener("dom-ready",m)}),ye.current&&n.stop)try{n.stop()}catch{}ye.current=e,X(null),D(!0);try{await n.loadURL(e)}catch(d){if(ye.current!==e)return;if(dr(d)){const T="code"in d?d.code:"";(T==="ERR_CONNECTION_REFUSED"||T==="ERR_NAME_NOT_RESOLVED")&&X(T==="ERR_CONNECTION_REFUSED"?`No server running at ${e}`:`Could not resolve ${e}`),D(!1);return}D(!1);const m=d instanceof Error?d.message:`Failed to load ${e}`;X(m)}finally{ye.current===e&&(ye.current=null)}}},ur=()=>{var d;if(!W)return;const e=B.current;if(!e||Ye.current)return;const n=((d=e.getURL)==null?void 0:d.call(e))||"";if(n===""||be(n)){const m=he.current;if(be(m))return;Ye.current=!0,X(`Could not render ${m}. Retrying once.`),et(m)}},mr=e=>{e.key==="Enter"&&Qe(K)},jt=()=>{const e=B.current;e!=null&&e.reload&&e.reload()},pr=()=>{const e=B.current;e!=null&&e.goBack&&e.goBack()},xr=()=>{const e=B.current;e!=null&&e.goForward&&e.goForward()},hr=()=>{window.api.app.openExternal(V)},fr=()=>{const e=B.current;e!=null&&e.openDevTools&&e.openDevTools()},rn=()=>{const e=!H;window.api.app.setWindowButtonsVisibility(!e),Ae(e)},tt=r.useCallback(e=>{var m;const n=((m=je.current)==null?void 0:m.clientHeight)??0,i=120;if(!n)return Math.max(i,e);const d=Math.max(i,Math.floor(n*.75));return Math.max(i,Math.min(d,Math.round(e)))},[]),nt=r.useRef(null),on=Er({cursor:"row-resize",getStartSize:()=>{var e;return((e=nt.current)==null?void 0:e.getBoundingClientRect().height)??Pt},computeSize:(e,n,i)=>tt(e-i),applyLiveSize:e=>{const n=nt.current;n&&(n.style.flex=`0 0 ${e}px`,n.style.height=`${e}px`)},onCommit:dt,onDragStateChange:Pn}),gr=r.useCallback(e=>{e.stopPropagation(),nt.current=e.currentTarget.nextElementSibling,nt.current&&on(e)},[on]),rt=r.useCallback(()=>{const e=B.current;if(e!=null&&e.executeJavaScript&&!(!e.isConnected||!re.current))try{e.executeJavaScript(`
        try {
          if (window.__1devtool_tracking__ && typeof window.__1devtool_tracking__.cleanup === 'function') {
            window.__1devtool_tracking__.cleanup();
          }
        } catch (e) {}
      `).catch(()=>{})}catch{}},[]),ot=r.useCallback(()=>{const e=B.current;if(!(e!=null&&e.executeJavaScript)||!e.isConnected||!re.current)return;const n=`
      (function() {
        try {
          if (window.__1devtool_tracking__ && typeof window.__1devtool_tracking__.enable === 'function') {
            window.__1devtool_tracking__.enable();
            return;
          }

          var state = {
            enabled: true,
            listeners: [],
            originalFetch: window.fetch,
            originalXHROpen: XMLHttpRequest.prototype.open,
            originalXHRSend: XMLHttpRequest.prototype.send,
            trackedFetch: null,
            trackedXHROpen: null,
            trackedXHRSend: null
          };

          function emit(type, payload) {
            if (!state.enabled) return;
            try {
              var text = typeof payload === 'string' ? payload : JSON.stringify(payload);
              console.log('[1DT:' + type + '] ' + text);
            } catch (e) {}
          }

          function addTrackedListener(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            state.listeners.push({ target: target, type: type, handler: handler, options: options });
          }

          function getElementInfo(el) {
            try {
              if (!el) return 'unknown';
              var tag = (el.tagName && el.tagName.toLowerCase()) || 'unknown';
              var id = el.id ? '#' + el.id : '';
              var classes = el.className && typeof el.className === 'string'
                ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.')
                : '';
              var text = el.textContent ? el.textContent.trim().slice(0, 30) : '';
              var type = el.type ? '[type=' + el.type + ']' : '';
              var name = el.name ? '[name=' + el.name + ']' : '';
              return tag + id + classes + type + name + (text ? ' "' + text + (text.length >= 30 ? '...' : '') + '"' : '');
            } catch (e) {
              return 'unknown';
            }
          }

          function getRequestUrl(input) {
            try {
              if (typeof input === 'string') return input;
              if (input && typeof URL !== 'undefined' && input instanceof URL) return input.href;
              if (input && typeof input.url === 'string') return input.url;
              return String(input || '');
            } catch (e) {
              return '';
            }
          }

          function getRequestMethod(input, init) {
            try {
              return (init && init.method) || (input && input.method) || 'GET';
            } catch (e) {
              return 'GET';
            }
          }

          function describeBody(body) {
            try {
              if (!body) return '';
              if (typeof body === 'string') return body.slice(0, 1000);
              if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                return body.toString().slice(0, 1000);
              }
              if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]';
              if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob ' + body.size + ' bytes]';
              if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return '[ArrayBuffer ' + body.byteLength + ' bytes]';
              return '[Body]';
            } catch (e) {
              return '';
            }
          }

          function getContentLength(headers) {
            try {
              var raw = headers && typeof headers.get === 'function' ? headers.get('content-length') : null;
              var parsed = raw ? Number(raw) : NaN;
              return Number.isFinite(parsed) ? parsed : null;
            } catch (e) {
              return null;
            }
          }

          var networkId = 0;

          if (typeof state.originalFetch === 'function') {
            state.trackedFetch = function(input, init) {
              if (!state.enabled) {
                return state.originalFetch.apply(this, arguments);
              }

              var id = ++networkId;
              var startTime = Date.now();
              emit('net:start', {
                id: id,
                type: 'fetch',
                method: String(getRequestMethod(input, init)).toUpperCase(),
                url: getRequestUrl(input),
                startTime: startTime,
                requestBody: describeBody(init && init.body)
              });

              try {
                var result = state.originalFetch.apply(this, arguments);
                Promise.resolve(result).then(function(response) {
                  var endTime = Date.now();
                  emit('net:end', {
                    id: id,
                    status: response.status,
                    statusText: response.statusText,
                    endTime: endTime,
                    duration: endTime - startTime,
                    responseSize: getContentLength(response.headers),
                    responseBody: ''
                  });
                }, function(error) {
                  var endTime = Date.now();
                  emit('net:error', {
                    id: id,
                    endTime: endTime,
                    duration: endTime - startTime,
                    error: (error && error.message) || 'Network error'
                  });
                });
                return result;
              } catch (error) {
                var endTime = Date.now();
                emit('net:error', {
                  id: id,
                  endTime: endTime,
                  duration: endTime - startTime,
                  error: (error && error.message) || 'Network error'
                });
                throw error;
              }
            };
            window.fetch = state.trackedFetch;
          }

          state.trackedXHROpen = function(method, url) {
            try {
              this.__1dt_method = method;
              this.__1dt_url = url;
            } catch (e) {}
            return state.originalXHROpen.apply(this, arguments);
          };

          state.trackedXHRSend = function(body) {
            if (!state.enabled) {
              return state.originalXHRSend.apply(this, arguments);
            }

            var xhr = this;
            var id = ++networkId;
            var startTime = Date.now();
            var finished = false;

            emit('net:start', {
              id: id,
              type: 'xhr',
              method: String(xhr.__1dt_method || 'GET').toUpperCase(),
              url: getRequestUrl(xhr.__1dt_url || ''),
              startTime: startTime,
              requestBody: describeBody(body)
            });

            function finish(errorMessage) {
              if (finished) return;
              finished = true;
              var endTime = Date.now();
              if (errorMessage) {
                emit('net:error', {
                  id: id,
                  endTime: endTime,
                  duration: endTime - startTime,
                  error: errorMessage
                });
                return;
              }

              var responseSize = null;
              try {
                var length = xhr.getResponseHeader('content-length');
                var parsed = length ? Number(length) : NaN;
                responseSize = Number.isFinite(parsed) ? parsed : null;
              } catch (e) {}

              emit('net:end', {
                id: id,
                status: xhr.status,
                statusText: xhr.statusText,
                endTime: endTime,
                duration: endTime - startTime,
                responseSize: responseSize,
                responseBody: ''
              });
            }

            xhr.addEventListener('load', function() { finish(null); }, { once: true });
            xhr.addEventListener('error', function() { finish('Network error'); }, { once: true });
            xhr.addEventListener('abort', function() { finish('Request aborted'); }, { once: true });
            xhr.addEventListener('timeout', function() { finish('Request timed out'); }, { once: true });

            try {
              return state.originalXHRSend.apply(this, arguments);
            } catch (error) {
              finish((error && error.message) || 'Network error');
              throw error;
            }
          };

          XMLHttpRequest.prototype.open = state.trackedXHROpen;
          XMLHttpRequest.prototype.send = state.trackedXHRSend;

          addTrackedListener(document, 'click', function(e) {
            emit('click', getElementInfo(e.target));
          }, true);

          addTrackedListener(document, 'input', function(e) {
            try {
              var info = getElementInfo(e.target);
              var target = e.target || {};
              var value = typeof target.value === 'string' ? target.value : '';
              var displayValue = target.type === 'password' ? '***' : value.slice(0, 50);
              emit('input', info + ' = "' + displayValue + '"');
            } catch (err) {}
          }, true);

          addTrackedListener(document, 'submit', function(e) {
            emit('submit', getElementInfo(e.target));
          }, true);

          addTrackedListener(document, 'focus', function(e) {
            try {
              if (e.target && e.target.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(e.target.tagName) >= 0) {
                emit('focus', getElementInfo(e.target));
              }
            } catch (err) {}
          }, true);

          addTrackedListener(document, 'keydown', function(e) {
            try {
              if (e.key === 'Enter' && e.target && e.target.tagName) {
                emit('keypress', 'Enter on ' + getElementInfo(e.target));
              }
            } catch (err) {}
          }, true);

          var scrollTimeout;
          addTrackedListener(window, 'scroll', function() {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(function() {
              emit('scroll', 'scrollY=' + window.scrollY);
            }, 500);
          }, true);

          addTrackedListener(document, 'contextmenu', function(e) {
            var el = e.target;
            var elementInfo = getElementInfo(el);
            var componentInfo = null;

            try {
              var keys = Object.keys(el);
              var fiberKey = keys.find(function(k) {
                return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
              });
              if (fiberKey) {
                var fiber = el[fiberKey];
                var current = fiber;
                var stack = [];
                var found = null;
                while (current) {
                  if (current.type && typeof current.type !== 'string') {
                    var name = current.type.displayName || current.type.name || 'Anonymous';
                    var src = current._debugSource;
                    stack.push(name);
                    if (!found && src) {
                      found = {
                        componentName: name,
                        fileName: src.fileName || '',
                        lineNumber: src.lineNumber || 0,
                        columnNumber: src.columnNumber || 0,
                        componentStack: stack.slice()
                      };
                    }
                  }
                  current = current.return;
                }
                if (!found && stack.length > 0) {
                  found = {
                    componentName: stack[0],
                    fileName: '',
                    lineNumber: 0,
                    columnNumber: 0,
                    componentStack: stack
                  };
                }
                componentInfo = found;
              }
            } catch (err) {}

            emit('contextmenu', {
              element: elementInfo,
              component: componentInfo,
              x: e.clientX,
              y: e.clientY
            });
          }, true);

          state.enable = function() {
            if (state.enabled) return;
            state.enabled = true;
            emit('ready', 'Interaction and network tracking enabled');
          };

          state.cleanup = function() {
            state.enabled = false;
            try {
              state.listeners.forEach(function(listener) {
                listener.target.removeEventListener(listener.type, listener.handler, listener.options);
              });
            } catch (e) {}
            state.listeners = [];

            try {
              if (state.trackedFetch && window.fetch === state.trackedFetch) {
                window.fetch = state.originalFetch;
              }
            } catch (e) {}
            try {
              if (XMLHttpRequest.prototype.open === state.trackedXHROpen) {
                XMLHttpRequest.prototype.open = state.originalXHROpen;
              }
              if (XMLHttpRequest.prototype.send === state.trackedXHRSend) {
                XMLHttpRequest.prototype.send = state.originalXHRSend;
              }
            } catch (e) {}

            if (window.__1devtool_tracking__ === state) {
              delete window.__1devtool_tracking__;
            }
            if (window.__1devtool_tracking_cleanup__ === state.cleanup) {
              delete window.__1devtool_tracking_cleanup__;
            }
          };

          window.__1devtool_tracking__ = state;
          window.__1devtool_tracking_cleanup__ = state.cleanup;
          emit('ready', 'Interaction and network tracking enabled');
        } catch (error) {
          try {
            console.warn('[1DT:ready] Browser debug tracking failed:', error && error.message ? error.message : error);
          } catch (e) {}
        }
      })();
    `;try{e.executeJavaScript(n).catch(()=>{})}catch{}},[]);r.useEffect(()=>{J&&(Q&&Ce?ot():rt())},[Q,Ce,J,ot,rt]),r.useEffect(()=>{if(!J)return;const e=B.current;if(!(e!=null&&e.executeJavaScript)||!e.isConnected||!re.current)return;const n=oe&&!Se;try{n?(e.executeJavaScript(Nn).catch(()=>{}),e.executeJavaScript(kn).catch(()=>{})):oe&&Se?e.executeJavaScript(Xr).catch(()=>{}):e.executeJavaScript(qr).catch(()=>{})}catch{}},[oe,Se,J]);const st=r.useCallback(async()=>{const e=B.current;if(!(e!=null&&e.executeJavaScript)||!e.isConnected||!re.current)return;const n=Ur(L),i=ee.getState().updateComment;for(const d of n)try{const m=await e.executeJavaScript(Kr(d.anchor.selector));m&&typeof m.x=="number"&&i(L,d.id,{position:{x:m.x,y:m.y,blockRect:{x:m.x,y:m.y,width:m.width,height:m.height}}})}catch{}},[L]);r.useEffect(()=>{const e=()=>{var T;const d=B.current,m=(T=d==null?void 0:d.getBoundingClientRect)==null?void 0:T.call(d);m&&m.width>0&&m.height>0&&Yn({top:m.top,left:m.left,width:m.width,height:m.height})};e();const n=je.current;if(!n)return;const i=new ResizeObserver(e);return i.observe(n),window.addEventListener("resize",e),window.addEventListener("scroll",e,!0),()=>{i.disconnect(),window.removeEventListener("resize",e),window.removeEventListener("scroll",e,!0)}},[H,Q,fe]);const sn=r.useCallback(e=>{var Ne,N,F,M,q,ve,Y,E;if(yt.current)return;const n=B.current;if(!n)return;Oe(L,((Ne=e.scroll)==null?void 0:Ne.x)??0,((N=e.scroll)==null?void 0:N.y)??0);let i="/",d="",m="";try{const ie=new URL(e.url);i=ie.pathname,d=ie.search,m=ie.hash}catch{}const T={position:e.position,anchor:e.anchor,viewport:{width:((F=e.viewport)==null?void 0:F.width)??((M=kt.current)==null?void 0:M.width)??0,height:((q=e.viewport)==null?void 0:q.height)??((ve=kt.current)==null?void 0:ve.height)??0,isDeviceMode:Jt.current},url:e.url,pathname:i,search:d,hash:m};ke(T);const O=n.getBoundingClientRect(),U=e.position.blockRect.y-(((Y=e.scroll)==null?void 0:Y.y)??0)+e.position.blockRect.height,R=e.position.blockRect.x-(((E=e.scroll)==null?void 0:E.x)??0);Jn({top:O.top+U+6,left:O.left+R})},[L,Oe]),vr=r.useCallback(e=>{Ee&&(Kt(L,s.id,Ee,e),ke(null))},[Ee,Kt,L,s.id]),br=r.useCallback(()=>{ke(null)},[]),Rt=r.useCallback(()=>{Be(e=>(e&&(ke(null),Ht(!1)),!e))},[]),wr=r.useCallback(e=>{e.url!==he.current&&Qe(e.url);const n=B.current;if(n!=null&&n.executeJavaScript&&n.isConnected&&re.current)try{n.executeJavaScript(`window.scrollTo({ left: ${Math.max(0,e.position.x-80)}, top: ${Math.max(0,e.position.y-80)}, behavior: 'smooth' });`).catch(()=>{})}catch{}},[]),an=r.useCallback(e=>{e!=null&&e.url&&(G(e.url),te(e.url),he.current=e.url,ke(null),st())},[st]);return r.useEffect(()=>{if(!oe||!J)return;let e=!1;const n=async()=>{var T,O,U;const d=B.current;if(!(d!=null&&d.executeJavaScript)||!d.isConnected||!re.current)return;let m=[];try{m=await d.executeJavaScript(Jr)}catch{return}if(!(e||!Array.isArray(m)||m.length===0))for(const R of m)!R||typeof R.type!="string"||(R.type==="click"?sn(R.payload):R.type==="scroll"?Oe(L,((T=R.payload)==null?void 0:T.x)??0,((O=R.payload)==null?void 0:O.y)??0):R.type==="ready"?(U=R.payload)!=null&&U.scroll&&Oe(L,R.payload.scroll.x,R.payload.scroll.y):R.type==="escape"?(ke(null),Be(!1)):R.type==="route"&&an(R.payload))},i=window.setInterval(()=>{n()},100);return n(),()=>{e=!0,window.clearInterval(i)}},[oe,J,sn,an,Oe,L]),r.useEffect(()=>{const e=B.current;if(!e)return;ce(!1),re.current=!1;const n=()=>{re.current=!0,ce(!0),(async()=>{var F;for(let M=0;M<8;M+=1){if(!e.isConnected||!re.current)return;try{const q=(F=e.getWebContentsId)==null?void 0:F.call(e);if(!q||(await window.api.browserAutomation.registerGuest({projectId:s.id,tabId:j,webContentsId:q,registrationId:Ot.current})).ok)return}catch{}await new Promise(q=>window.setTimeout(q,75*(M+1)))}})(),Mt.current&&We.current&&ot()},i=N=>{be(N.url)||(Ye.current=!1,G(N.url),te(N.url),he.current=N.url,X(null),lr(N.url),Le("navigation",`Navigated to ${N.url}`,"",0,{url:N.url}))},d=()=>{Ye.current=!1,D(!0),X(null)},m=()=>{var F,M;D(!1),ye.current=null;try{const q=B.current;q&&(o(((F=q.canGoBack)==null?void 0:F.call(q))??!1),S(((M=q.canGoForward)==null?void 0:M.call(q))??!1))}catch{}ue.current||ur(),st();const N=B.current;if(N!=null&&N.executeJavaScript&&N.isConnected&&re.current)try{N.executeJavaScript(Nn).catch(()=>{}),qt.current&&!yt.current&&N.executeJavaScript(kn).catch(()=>{})}catch{}},T=N=>{var ve,Y;const F=[-3,-300],M=[-102,-105];if(!(N!=null&&N.isMainFrame)||F.includes(N.errorCode)||N.validatedURL&&be(N.validatedURL))return;D(!1);const q=N.validatedURL||he.current;M.includes(N.errorCode)?X(N.errorCode===-102?`No server running at ${q}`:`Could not resolve ${q}`):X(N.errorDescription||`Failed to load ${q}`);try{const E=B.current;E&&(o(((ve=E.canGoBack)==null?void 0:ve.call(E))??!1),S(((Y=E.canGoForward)==null?void 0:Y.call(E))??!1))}catch{}},O=()=>{Lt(!0),window.api.app.setFullScreen(!0)},U=()=>{Lt(!1),window.api.app.setFullScreen(!1)},R=new Map,Ne=N=>{var ve;const F=N.message||"";if(F.startsWith("[1DT:net:"))try{const Y=F.match(/^\[1DT:net:(\w+)\]\s*(.*)$/);if(Y){const[,E,ie]=Y,_=JSON.parse(ie);if(E==="start"){const se=Vt({method:_.method,url:_.url,status:null,statusText:"",type:_.type,startTime:_.startTime,endTime:null,duration:null,requestBody:_.requestBody,responseBody:void 0,responseSize:null});se&&R.set(_.id,se)}else if(E==="end"){const se=R.get(_.id);se&&(St(se,{status:_.status,statusText:_.statusText,endTime:_.endTime,duration:_.duration,responseSize:_.responseSize,responseBody:_.responseBody}),R.delete(_.id))}else if(E==="error"){const se=R.get(_.id);se&&(St(se,{endTime:_.endTime,duration:_.duration,error:_.error,status:0,statusText:"Error"}),R.delete(_.id))}return}}catch{}if(F.startsWith("[1DT:contextmenu]")){try{const Y=F.replace("[1DT:contextmenu]","").trim(),E=JSON.parse(Y),{element:ie,component:_}=E;let se=ie||"unknown element";if(_){const Pe=_.fileName?_.fileName.split("/").slice(-2).join("/")+":"+_.lineNumber:"";se=`<${_.componentName}> ${Pe} (${ie})`}const gn={id:++xt.current,level:_?"component":"click",message:se,source:(_==null?void 0:_.fileName)||"",line:(_==null?void 0:_.lineNumber)||0,timestamp:Date.now(),details:_||void 0};ut(Pe=>[...Pe.slice(-499),gn]);const vn=B.current;if(vn){const Pe=vn.getBoundingClientRect(),yr=Pe.left+E.x,kr=Pe.top+E.y;_e({x:yr,y:kr,entry:gn,type:"console"})}}catch{}return}if(F.startsWith("[1DT:component]")){try{const Y=F.replace("[1DT:component]","").trim(),E=JSON.parse(Y);Ge(E);const ie=E.fileName?E.fileName.split("/").slice(-2).join("/")+":"+E.lineNumber:"",_=((ve=E.componentStack)==null?void 0:ve.length)>1?" ["+E.componentStack.slice(0,5).join(" > ")+"]":"";Le("component",`<${E.componentName}> ${ie}${_}`,E.fileName||"inspector",E.lineNumber||0,E)}catch{}return}if(F.startsWith("[1DT:inspector]")){Le("info",F.replace("[1DT:inspector]","").trim(),"inspector",0);return}if(F.startsWith("[1DT:")){const Y=F.match(/^\[1DT:(\w+)\]\s*(.*)$/);if(Y){const[,E,ie]=Y,se={click:"click",input:"input",submit:"submit",focus:"input",keypress:"input",scroll:"navigation",ready:"info"}[E]||"log";Le(se,ie,"interaction",0,{type:E});return}}const q={0:"log",1:"info",2:"warn",3:"error"}[N.level]||"log";Le(q,F,N.sourceId||"",N.line||0)};return e.addEventListener("dom-ready",n),e.addEventListener("did-navigate",i),e.addEventListener("did-navigate-in-page",i),e.addEventListener("did-start-loading",d),e.addEventListener("did-stop-loading",m),e.addEventListener("did-fail-load",T),e.addEventListener("enter-html-full-screen",O),e.addEventListener("leave-html-full-screen",U),e.addEventListener("console-message",Ne),()=>{if(ye.current=null,ue.current&&(window.clearTimeout(ue.current),ue.current=null),rt(),window.api.browserAutomation.unregisterGuest({projectId:s.id,tabId:j,registrationId:Ot.current}),re.current&&e.isConnected&&e.stop)try{e.stop()}catch{}e.removeEventListener("dom-ready",n),e.removeEventListener("did-navigate",i),e.removeEventListener("did-navigate-in-page",i),e.removeEventListener("did-start-loading",d),e.removeEventListener("did-stop-loading",m),e.removeEventListener("did-fail-load",T),e.removeEventListener("enter-html-full-screen",O),e.removeEventListener("leave-html-full-screen",U),e.removeEventListener("console-message",Ne)}},[s.id,j,Le,Vt,St,Ge,ot,rt,st]),r.useEffect(()=>{J&&cr()},[J]),r.useEffect(()=>()=>{H&&window.api.app.setWindowButtonsVisibility(!0)},[H]),r.useEffect(()=>{const e=n=>{const{projectId:i,url:d}=n.detail;i===s.id&&Qe(d)};return window.addEventListener("browser-navigate",e),()=>window.removeEventListener("browser-navigate",e)},[s.id]),r.useEffect(()=>{const e=n=>{var m,T,O,U,R,Ne,N,F;const d=navigator.platform.toUpperCase().includes("MAC")?n.metaKey:n.ctrlKey;if(d&&!n.shiftKey&&n.key.toLowerCase()==="r"){n.preventDefault(),jt();return}if(d&&n.shiftKey&&n.key.toLowerCase()==="f"){n.preventDefault(),rn();return}if(d&&!n.shiftKey&&(n.key==="="||n.key==="+")){(T=(m=n.target).closest)!=null&&T.call(m,'[data-testid="browser-panel"]')&&(n.preventDefault(),Fe());return}if(d&&!n.shiftKey&&n.key==="-"){(U=(O=n.target).closest)!=null&&U.call(O,'[data-testid="browser-panel"]')&&(n.preventDefault(),ze());return}if(d&&!n.shiftKey&&n.key==="0"){(Ne=(R=n.target).closest)!=null&&Ne.call(R,'[data-testid="browser-panel"]')&&(n.preventDefault(),$e());return}if(H&&n.key==="Escape"&&(n.preventDefault(),Ae(!1),window.api.app.setWindowButtonsVisibility(!0)),n.key==="c"&&!d&&!n.altKey&&!n.shiftKey){const M=n.target;(N=M==null?void 0:M.closest)!=null&&N.call(M,'[data-testid="browser-panel"]')&&(M.tagName==="INPUT"||M.tagName==="TEXTAREA"||M.isContentEditable||(n.preventDefault(),Rt()));return}if(n.key==="Escape"&&oe&&!Ee){const M=n.target;(F=M==null?void 0:M.closest)!=null&&F.call(M,'[data-testid="browser-panel"]')&&(n.preventDefault(),Be(!1))}};return window.addEventListener("keydown",e),()=>window.removeEventListener("keydown",e)},[H,Fe,ze,$e,oe,Ee,Rt]),r.useEffect(()=>{he.current=V},[V]),r.useEffect(()=>{if(fe){ft({width:Ve,height:Re,isDeviceMode:!0});return}const e=()=>{var U,R;const d=B.current,m=(U=d==null?void 0:d.getBoundingClientRect)==null?void 0:U.call(d);if(m&&m.width>0&&m.height>0){ft({width:Math.round(m.width),height:Math.round(m.height)});return}const T=je.current,O=(R=T==null?void 0:T.getBoundingClientRect)==null?void 0:R.call(T);O&&O.width>0&&O.height>0&&ft({width:Math.round(O.width),height:Math.round(O.height)})};e();const n=je.current;if(!n)return;const i=new ResizeObserver(e);return i.observe(n),window.addEventListener("resize",e),()=>{i.disconnect(),window.removeEventListener("resize",e)}},[fe,Ve,Re,Q,J,H]),r.useEffect(()=>{if(!Q)return;const e=je.current;if(!e)return;const n=new ResizeObserver(()=>{dt(i=>tt(i))});return n.observe(e),dt(i=>tt(i)),()=>{n.disconnect()}},[Q,tt,H,ge,Ie]),r.useEffect(()=>{if(!(x&&pe.current))return pe.current=!0,Je.current=w,G(w),te(w),he.current=w,X(null),ue.current&&window.clearTimeout(ue.current),W&&!be(w)&&(ue.current=window.setTimeout(()=>{ue.current=null,et(w)},100)),()=>{ue.current&&(window.clearTimeout(ue.current),ue.current=null)}},[w,W,x]),t.jsxs("div",{"data-testid":"browser-panel","data-fullscreen":H?"true":"false",className:`flex min-h-0 min-w-0 flex-col overflow-hidden no-drag ${H?`fixed inset-x-0 bottom-0 z-[9999] bg-surface shadow-2xl ${h&&h.length>1?"top-[60px]":"top-8"}`:"h-full"}`,children:[H&&t.jsxs("div",{className:"fixed top-0 left-0 right-0 z-[10001] bg-surface drag-region",children:[t.jsx("div",{className:"h-8 flex items-center justify-center",children:t.jsx("button",{onClick:()=>{Ae(!1),window.api.app.setWindowButtonsVisibility(!0)},className:"no-drag relative px-3 py-1 text-xs text-text-muted hover:text-text-primary hover:bg-surface-hover rounded transition-colors",children:"Exit Fullscreen"})}),h&&h.length>1&&k&&t.jsxs("div",{className:"no-drag flex items-center h-7 border-b border-border bg-background px-1 gap-0.5 flex-shrink-0",children:[t.jsx("div",{className:"flex-1 flex items-center gap-0.5 min-w-0 overflow-x-auto scrollbar-none",children:h.map(e=>t.jsxs("button",{onClick:()=>k(e.id),className:`
                      group flex items-center gap-1 px-2 py-0.5 text-[11px] rounded whitespace-nowrap max-w-[160px]
                      transition-colors
                      ${y===e.id?"bg-surface-hover text-text-primary":"text-text-secondary hover:text-text-primary hover:bg-surface-hover/50"}
                    `,children:[t.jsx("span",{className:"truncate",children:e.title&&e.title!=="New Tab"?e.title:(()=>{try{const n=new URL(e.url);return n.hostname+(n.pathname!=="/"?n.pathname:"")}catch{return e.url||"New Tab"}})()}),h.length>1&&p&&t.jsx("span",{onClick:n=>{n.stopPropagation(),p(e.id)},className:"ml-0.5 p-0.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity",children:t.jsx("svg",{className:"w-2.5 h-2.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:2,children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M6 18L18 6M6 6l12 12"})})})]},e.id))}),C&&t.jsx("button",{onClick:()=>C(),className:"flex-shrink-0 p-0.5 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded transition-colors",title:"New tab",children:t.jsx("svg",{className:"w-3.5 h-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:2,children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M12 4v16m8-8H4"})})})]})]}),t.jsx(Qr,{canGoBack:we,canGoForward:g,isLoading:A,inputUrl:K,isInspectorActive:Ie,showConsole:Q,consoleErrorCount:nn.errors,isPanelFullscreen:H,deviceMode:fe,zoomFactor:bt,commentMode:oe,commentCount:Te.length,onBack:pr,onForward:xr,onRefresh:jt,onInputUrlChange:G,onInputKeyDown:mr,onTakeScreenshot:()=>void _t(),onToggleInspector:rr,onToggleConsole:()=>ct(!Q),onOpenExternal:hr,onTogglePanelFullscreen:rn,onToggleDeviceMode:()=>Wn(!fe),onToggleCommentMode:Rt,onZoomIn:Fe,onZoomOut:ze,onZoomReset:$e}),oe&&t.jsx(Mr,{count:Te.length,onExit:()=>{Be(!1),ke(null)}}),fe&&t.jsx(Vr,{selectedDevice:Xn,deviceWidth:Ve,deviceHeight:Re,onSelectDevice:$t,onWidthChange:Ut,onHeightChange:At,onRotate:sr}),t.jsx(Zr,{isInspectorActive:Ie,inspectedComponent:ge,onClear:()=>Ge(null),onOpenComponentFile:or}),t.jsxs("div",{ref:je,className:"flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden",children:[t.jsx(eo,{webviewRef:B,loadError:Z,currentUrl:V,isPanelFullscreen:H,isHtmlFullscreen:Tn,isResizingDebugPanel:Ln,deviceMode:fe,deviceWidth:Ve,deviceHeight:Re,onRetry:()=>Qe(V)}),Q&&t.jsxs(t.Fragment,{children:[t.jsx("div",{"data-testid":"browser-debug-resizer",className:"no-drag h-[6px] cursor-row-resize touch-none border-t border-border bg-surface hover:bg-accent/40 transition-colors",onPointerDown:gr,title:"Resize debug panel"}),t.jsx(Gr,{debugPanelHeight:Pt,panelTab:Bn,consoleEntries:de,filteredEntries:ir,consoleFilter:He,consoleSearch:mt,consoleCounts:nn,networkEntries:Xe,filteredNetworkEntries:ar,networkFilter:qe,selectedNetworkEntry:On,isRecording:Ce,consoleEndRef:ht,panelId:L,commentCount:Te.length,onConsoleFilterChange:Mn,onConsoleSearchChange:Dn,onPanelTabChange:Dt,onNetworkFilterChange:Fn,onSendToTerminal:()=>Ct(),onToggleRecording:()=>In(!Ce),onClearConsole:Gn,onClearNetwork:Vn,onOpenDevTools:fr,onClose:()=>ct(!1),onContextMenu:Zn,onSelectNetworkEntry:It,onJumpToComment:wr})]})]}),ae&&t.jsx("div",{className:"fixed inset-0 z-[99]",onMouseDown:()=>_e(null)}),ae&&t.jsxs(jn,{x:ae.x,y:ae.y,onClose:()=>_e(null),children:[t.jsx(Me,{onClick:()=>Ct(ae.entry),children:"Send to AI Terminal"}),t.jsx(Me,{onClick:()=>{const e=ae.type==="network"?`${ae.entry.method} ${ae.entry.url}`:ae.entry.message;navigator.clipboard.writeText(e),_e(null)},children:"Copy"}),t.jsx(Me,{onClick:()=>{Ct()},children:"Send All to AI Terminal..."}),ae.type==="console"&&((fn=ae.entry.details)==null?void 0:fn.fileName)&&t.jsx(Me,{onClick:()=>{const e=ae.entry.details,n=e.fileName,i=e.lineNumber||1,d=e.columnNumber||1,m=`vscode://file/${n}:${i}:${d}`;window.api.app.openExternal(m).catch(()=>{navigator.clipboard.writeText(`${n}:${i}`)}),_e(null)},children:"Open in Editor"})]}),oe&&!Ft&&!vt&&t.jsxs(t.Fragment,{children:[Wt&&t.jsx(Hr,{panelId:L,projectId:s.id,currentUrl:V,webviewRect:Ze,draft:Ee,draftHostTop:Xt.top,draftHostLeft:Xt.left,onSubmitDraft:vr,onCancelDraft:br}),t.jsx(Dr,{count:Te.length,selectedCount:Gt.length,paused:Se,showPins:Wt,onTogglePaused:()=>Ht(e=>!e),onToggleShowPins:()=>qn(e=>!e),onOpenList:()=>{Dt("comments"),ct(!0)},onSendToAI:()=>De(!0),onClearAll:()=>Kn(L),onClose:()=>{Be(!1),ke(null)}})]}),t.jsx(Tr,{isOpen:Ft,onClose:()=>{De(!1),zt(null)},onSendSuccess:()=>{Ae(!1),gt([])},project:s,consoleEntries:de,networkEntries:Xe,selectedEntry:zn,attachedScreenshots:Un,onRemoveScreenshot:tr,onRequestScreenshot:nr,browserUrl:V,viewportSize:$n,comments:Gt}),vt&&t.jsx(Lr,{imageData:vt,onSave:Qn,onCancel:er})]})});function Sn(a){if(a.title&&a.title!=="New Tab")return a.title;try{const s=new URL(a.url);return s.hostname+(s.pathname!=="/"?s.pathname:"")}catch{return a.url||"New Tab"}}function ro({project:a}){var te,pe,we;const s=me(o=>o.browserReloadNonce[a.id]??0),c=(te=a.outputPanel)==null?void 0:te.browser,l=(pe=c==null?void 0:c.tabs)!=null&&pe.length?c.tabs:[{id:"default",url:(c==null?void 0:c.url)||"https://1devtool.com/",title:"New Tab"}],f=(c==null?void 0:c.activeTabId)||((we=l[0])==null?void 0:we.id)||"default",[h,y]=r.useState(!1);r.useEffect(()=>()=>{h&&window.api.app.setWindowButtonsVisibility(!0)},[h]);const[k,C]=r.useState(!1),[p,u]=r.useState(null),[v,b]=r.useState(null),[I,L]=r.useState(""),j=r.useRef(null);r.useEffect(()=>{var o,g;v&&((o=j.current)==null||o.focus(),(g=j.current)==null||g.select())},[v]);const z=r.useCallback((o,g,S)=>{const A=me.getState(),D=A.projects.find(Z=>Z.id===a.id);D&&A.updateProject(a.id,{outputPanel:{...D.outputPanel,browser:{...D.outputPanel.browser,tabs:o,activeTabId:g,automationTabId:S&&D.outputPanel.browser.automationTabId===S?null:D.outputPanel.browser.automationTabId}}})},[a.id]),x=r.useCallback((o,g)=>{var X,J,ce,ne,xe;const S=me.getState(),A=S.projects.find(H=>H.id===a.id);if(!A)return;const Z=((ce=(J=(X=A.outputPanel)==null?void 0:X.browser)==null?void 0:J.tabs)!=null&&ce.length?A.outputPanel.browser.tabs:[{id:"default",url:((xe=(ne=A.outputPanel)==null?void 0:ne.browser)==null?void 0:xe.url)||"https://1devtool.com/",title:"New Tab"}]).map(H=>H.id===o?{...H,url:g,title:H.title==="New Tab"||H.title===H.url?g:H.title}:H);S.updateProject(a.id,{outputPanel:{...A.outputPanel,browser:{...A.outputPanel.browser,tabs:Z}}})},[a.id]),w=r.useCallback(async o=>{var Z,X,J,ce,ne;const S=me.getState().projects.find(xe=>xe.id===a.id);if(!S)return;const A=(J=(X=(Z=S.outputPanel)==null?void 0:Z.browser)==null?void 0:X.tabs)!=null&&J.length?S.outputPanel.browser.tabs:[{id:"default",url:((ne=(ce=S.outputPanel)==null?void 0:ce.browser)==null?void 0:ne.url)||"https://1devtool.com/",title:"New Tab"}];try{const xe=await window.api.license.canAddBrowserTab(A.length);if(xe.success&&xe.data&&!xe.data.allowed){C(!0),setTimeout(()=>C(!1),4e3);return}}catch{}const D={id:Pr(),url:o||"https://1devtool.com/",title:o||"New Tab"};z([...A,D],D.id)},[a.id,z]),P=r.useCallback(o=>{if(l.length<=1)return;const g=l.findIndex(D=>D.id===o),S=l.filter(D=>D.id!==o),A=f===o?S[Math.min(g,S.length-1)].id:f;z(S,A,o)},[l,f,z]),$=r.useCallback(o=>{var D,Z;if(o===f)return;const g=me.getState(),S=g.projects.find(X=>X.id===a.id);if(!S)return;const A=((Z=(D=S.outputPanel)==null?void 0:D.browser)==null?void 0:Z.tabs)||l;g.updateProject(a.id,{outputPanel:{...S.outputPanel,browser:{...S.outputPanel.browser,tabs:A,activeTabId:o}}})},[l,f,a.id]),W=r.useCallback((o,g)=>{o.preventDefault(),u({x:o.clientX,y:o.clientY,tabId:g})},[]),K=r.useCallback(o=>{const g=l.find(S=>S.id===o);L(g?Sn(g):""),b(o),u(null)},[l]),G=r.useCallback(()=>{var D,Z,X,J,ce;if(!v||!I.trim()){b(null);return}const o=me.getState(),g=o.projects.find(ne=>ne.id===a.id);if(!g)return;const A=((X=(Z=(D=g.outputPanel)==null?void 0:D.browser)==null?void 0:Z.tabs)!=null&&X.length?g.outputPanel.browser.tabs:[{id:"default",url:((ce=(J=g.outputPanel)==null?void 0:J.browser)==null?void 0:ce.url)||"https://1devtool.com/",title:"New Tab"}]).map(ne=>ne.id===v?{...ne,title:I.trim()}:ne);o.updateProject(a.id,{outputPanel:{...g.outputPanel,browser:{...g.outputPanel.browser,tabs:A}}}),b(null)},[v,I,a.id]),V=r.useCallback(o=>{var A;u(null);const g=document.querySelector(`[data-browser-tab-id="${o}"]`),S=g==null?void 0:g.querySelector("webview");S!=null&&S.executeJavaScript&&(S.executeJavaScript(`
      try { localStorage.clear(); } catch(e) {}
      try { sessionStorage.clear(); } catch(e) {}
      try { caches.keys().then(function(names) { names.forEach(function(name) { caches.delete(name); }); }); } catch(e) {}
    `).catch(()=>{}),(A=S.reload)==null||A.call(S))},[]);return r.useEffect(()=>window.api.app.onWebviewNewWindow(o=>{w(o)}),[w]),t.jsxs("div",{className:"flex h-full min-h-0 min-w-0 flex-col overflow-hidden",children:[t.jsxs("div",{className:"flex items-center h-7 border-b border-border bg-background px-1 gap-0.5 flex-shrink-0",children:[t.jsx("div",{className:"flex-1 flex items-center gap-0.5 min-w-0 overflow-x-auto scrollbar-none",children:l.map(o=>t.jsxs("button",{onClick:()=>$(o.id),onContextMenu:g=>W(g,o.id),className:`
                group relative flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-t whitespace-nowrap max-w-[160px]
                transition-colors
                ${f===o.id?"bg-surface-hover text-text-primary after:absolute after:bottom-0 after:left-1 after:right-1 after:h-[2px] after:bg-accent after:rounded-full":"text-text-secondary hover:text-text-primary hover:bg-surface-hover/50"}
              `,children:[v===o.id?t.jsx("input",{ref:j,type:"text",value:I,onChange:g=>L(g.target.value),onBlur:G,onKeyDown:g=>{g.key==="Enter"&&G(),g.key==="Escape"&&b(null),g.stopPropagation()},onClick:g=>g.stopPropagation(),className:"w-20 bg-background border border-border rounded px-1 py-0 text-[11px] text-text-primary outline-none focus:border-accent"}):t.jsx("span",{className:"truncate",children:Sn(o)}),l.length>1&&v!==o.id&&t.jsx("span",{onClick:g=>{g.stopPropagation(),P(o.id)},className:"ml-0.5 p-0.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity",children:t.jsx("svg",{className:"w-2.5 h-2.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:2,children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M6 18L18 6M6 6l12 12"})})})]},o.id))}),t.jsx("button",{"data-testid":"browser-add-tab-button",onClick:()=>w(),className:"flex-shrink-0 p-0.5 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded transition-colors",title:"New tab",children:t.jsx("svg",{className:"w-3.5 h-3.5",fill:"none",viewBox:"0 0 24 24",stroke:"currentColor",strokeWidth:2,children:t.jsx("path",{strokeLinecap:"round",strokeLinejoin:"round",d:"M12 4v16m8-8H4"})})}),k&&t.jsx("span",{"data-testid":"browser-tab-limit-warning",className:"ml-2 text-xs text-amber-400 whitespace-nowrap",children:"Tab limit reached — upgrade to Pro"})]}),l.map(o=>t.jsx("div",{"data-browser-tab-id":o.id,className:`flex-1 min-h-0 min-w-0 flex flex-col ${f===o.id?"":"hidden"}`,children:t.jsx(to,{project:a,tabId:o.id,tabUrl:o.url,onNavigate:g=>x(o.id,g),tabs:l,activeTabId:f,onSwitchTab:$,onAddTab:w,onCloseTab:P,isPanelFullscreen:h,onSetPanelFullscreen:y,panelId:`${a.id}:${o.id}`})},`${o.id}:${s}`)),p&&t.jsxs(jn,{x:p.x,y:p.y,onClose:()=>u(null),children:[t.jsx(Me,{onClick:()=>K(p.tabId),children:"Rename"}),t.jsx(Me,{onClick:()=>V(p.tabId),children:"Clear Cache"})]})]})}export{ro as BrowserTabsWrapper};
