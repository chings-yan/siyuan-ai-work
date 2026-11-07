export const REFERENCE_PREVIEW_CSS = `
.sac .sac-reference-chips{display:flex;flex:0 1 auto;flex-direction:column;align-items:stretch;gap:4px;min-height:26px;max-height:min(240px,32cqh);overflow-x:hidden;overflow-y:auto;white-space:normal}
.sac .sac-reference-count{position:sticky;top:0;left:auto;padding:3px 4px;overflow-wrap:anywhere}
.sac .sac-reference-chip{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:5px;box-sizing:border-box;width:100%;min-width:0;max-width:100%;padding:4px 5px}
.sac .sac-reference-preview{min-width:0;max-width:100%}
.sac .sac-reference-preview>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1px 6px;min-width:0;list-style:none;cursor:pointer;font-size:12px;line-height:17px}
.sac .sac-reference-preview>summary::-webkit-details-marker{display:none}
.sac .sac-reference-preview .sac-reference-source{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sac .sac-reference-preview-hint{color:var(--b3-theme-on-surface);white-space:nowrap;font-size:11px}
.sac .sac-reference-preview-hint::after{content:' ▸'}
.sac .sac-reference-preview[open] .sac-reference-preview-hint::after{content:' ▾'}
.sac .sac-reference-preview .sac-reference-text{grid-column:1/-1;min-width:0;white-space:nowrap}
.sac .sac-reference-preview-content{min-width:0;overflow-wrap:anywhere;font-size:12px}
.sac .sac-reference-preview dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 8px;margin:6px 0;line-height:1.4}
.sac .sac-reference-preview dt{color:var(--b3-theme-on-surface)}
.sac .sac-reference-preview dd{min-width:0;margin:0;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}
.sac .sac-reference-preview pre{max-width:100%;max-height:min(150px,20cqh);margin:5px 0 0;padding:5px;border:1px solid var(--b3-border-color);border-radius:4px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text;font:12px/1.5 var(--b3-font-family-code,monospace)}
.sac .sac-reference-preview pre code{font:inherit;white-space:inherit;overflow-wrap:inherit}
.sac .sac-reference-preview>summary:focus-visible,.sac .sac-reference-preview pre:focus-visible,.sac .sac-reference-chip>button:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:-2px}
@container (max-height:340px){
 .sac .sac-reference-count{position:static}
 .sac:has([data-references]:not([hidden])):has([data-status-alert]:not([hidden])) .sac-main{min-height:0;padding-block:0}
}
`;
