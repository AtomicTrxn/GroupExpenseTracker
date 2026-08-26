/*
 * Shared DOM + formatting helpers for the calculator pages.
 * Loaded before each page's own script; no dependencies. Pages keep their
 * own state, rendering, and page-specific handlers.
 */

// ---- state paths -----------------------------------------------------------

function getByPath(obj, path){
  return path.split('.').reduce((o,k)=> (o==null?undefined:o[k]), obj);
}

function setByPath(obj, path, value){
  const keys = path.split('.');
  let o = obj;
  for(let i=0;i<keys.length-1;i++){
    const k = keys[i];
    const nextIsIndex = /^\d+$/.test(keys[i+1]);
    if(o[k]==null) o[k] = nextIsIndex ? [] : {};
    o = o[k];
  }
  o[keys[keys.length-1]] = value;
}

// ---- formatting ------------------------------------------------------------

function fmt(n){
  if(!Number.isFinite(n)) return '—';
  const neg = n<0; n = Math.abs(n);
  return (neg?'-$':'$') + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtPct(x){ return (x*100).toFixed(x>=0.1?0:1) + '%'; }
function fmtCompact(n){
  if(!Number.isFinite(n)) return '—';
  const neg = n<0, a = Math.abs(n); const p = neg?'-$':'$';
  if(a>=1e9) return p+(a/1e9).toFixed(1).replace(/\.0$/,'')+'B';
  if(a>=1e6) return p+(a/1e6).toFixed(1).replace(/\.0$/,'')+'M';
  if(a>=1e3) return p+Math.round(a/1e3)+'K';
  return p+Math.round(a);
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ---- input binding ---------------------------------------------------------
// data-type: bool | int | money | pct | age; untyped fields pass strings
// through (labels, enum selects).

function coerce(el){
  const type = el.dataset.type;
  if(type==='bool') return el.checked;
  if(type==='int'){ const n=parseInt(el.value,10); return Number.isFinite(n)?n:0; }
  if(type==='money'){ const n=parseFloat(el.value); return Number.isFinite(n)?n:0; }
  if(type==='pct'){ const n=parseFloat(el.value); return Number.isFinite(n)?n/100:0; }
  if(type==='age'){ const v=el.value.trim(); if(v==='') return null; const n=parseInt(v,10); return Number.isFinite(n)?n:null; }
  return el.value;
}

// Writes the state value into the element (mutates the element, returns nothing).
function displayValue(el, v){
  const type = el.dataset.type;
  if(type==='bool'){ el.checked = !!v; return; }
  if(type==='pct'){ el.value = v==null?'':+( (v*100).toFixed(4) ); return; }
  el.value = (v==null?'':v);
}
