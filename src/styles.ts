export const CSS = `
.sac-connection button{width:22px;height:24px;padding:0;flex:0 0 auto}.sac-connection [hidden]{display:none}.sac-connection[data-state="error"]{color:var(--b3-theme-error)}

.sac-floating{position:fixed;z-index:10;top:32px;right:40px;bottom:24px;width:min(420px,calc(100vw - 24px));overflow:hidden;background:var(--b3-theme-background);border-left:1px solid var(--b3-border-color);box-shadow:var(--b3-dialog-shadow)}
.sac{container-type:size;position:relative;box-sizing:border-box;display:flex;flex-direction:column;gap:min(6px,1%);height:100%;min-height:0;min-width:0;padding:10px;overflow:hidden;background:var(--b3-theme-background);color:var(--b3-theme-on-background);font:14px/1.6 var(--b3-font-family,system-ui,sans-serif)}
.sac *{box-sizing:border-box;min-width:0}
.sac-header{display:grid;flex:0 0 auto;gap:4px;padding-bottom:5px;border-bottom:1px solid var(--b3-border-color)}
.sac-header-primary{position:relative;display:flex;align-items:center;gap:5px;min-width:0;min-height:28px}
.sac-header-secondary{position:relative;display:flex;align-items:center;gap:5px;min-width:0;min-height:28px;padding-top:4px}
.sac .sac-answer-actions{display:inline-flex;gap:8px;flex-wrap:wrap;margin:4px 0 0 8px}
.sac .sac-answer-actions button{font:inherit;font-size:12px;border:0;background:transparent;color:var(--b3-theme-on-surface);padding:4px;cursor:pointer}
.sac-dock-tabs,.sac-doc-sections{display:flex;gap:4px;align-items:center}
.sac .sac-dock-tabs button,.sac .sac-doc-sections button{padding:5px 8px;border:0;border-radius:6px;background:transparent;color:var(--b3-theme-on-surface);font:inherit;font-size:12px;line-height:1.5;cursor:pointer}
.sac .sac-dock-tabs [aria-current="page"],.sac .sac-doc-sections [aria-current="page"]{background:var(--b3-theme-surface);color:var(--b3-theme-primary);font-weight:600;box-shadow:inset 0 -2px var(--b3-theme-primary)}
.sac:is([data-dock-view="associations"],[data-dock-view="knowledge"]) [data-chat-only],.sac:is([data-dock-view="associations"],[data-dock-view="knowledge"]) [data-ekko-panel],.sac:is([data-dock-view="associations"],[data-dock-view="knowledge"]) .sac-header-secondary{display:none!important}
.sac-document-panel{flex:1 1 0;min-height:0;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:12px;padding:8px 3px 12px;font-size:13px;line-height:1.6}
.sac-document-panel[hidden]{display:none}
.sac [data-knowledge-panel]{flex:1 1 0;min-height:0;overflow:auto;overscroll-behavior:contain}
.sac [data-knowledge-panel][hidden]{display:none}
.sac-document-panel>*{flex:none;margin:0}
.sac-document-panel p,.sac-document-panel h3{margin:0}
.sac-document-panel h3{font-size:12px;font-weight:600;margin-bottom:6px;color:var(--b3-theme-on-surface)}
.sac-doc-heading{display:flex;align-items:flex-start;gap:10px;justify-content:space-between}
.sac-doc-heading>div{display:grid;gap:3px}
.sac-doc-heading strong,.sac-doc-row strong{overflow-wrap:anywhere;white-space:normal;font-size:13px}
.sac-doc-heading small,.sac-doc-row small,.sac-document-panel [data-doc-help]{color:var(--b3-theme-on-surface);font-size:12px;overflow-wrap:anywhere}
.sac-document-panel button{flex:none;max-width:100%;min-height:30px;padding:4px 9px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);font:inherit;font-size:12px;line-height:1.5;white-space:normal;cursor:pointer}
.sac-document-panel button:disabled{opacity:.55;cursor:default}
.sac-doc-search{display:grid;gap:6px;font-size:12px;color:var(--b3-theme-on-surface)}
.sac-doc-search input{width:100%;min-height:36px;padding:7px 9px;border:1px solid var(--b3-border-color);border-radius:7px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);font:inherit;font-size:13px;line-height:1.5}
.sac-doc-row{display:grid;gap:6px;padding:10px 0;border-bottom:1px solid var(--b3-border-color)}
.sac-doc-row>button{justify-self:start}
.sac-doc-identity{font-size:12px;color:var(--b3-theme-on-surface);overflow-wrap:anywhere}.sac-doc-identity summary{cursor:pointer}
.sac-doc-actions,.sac-doc-footer{display:flex;gap:8px;flex-wrap:wrap}
.sac-document-panel [data-doc-notice]{border-left:3px solid var(--b3-theme-primary);padding:6px 8px;background:var(--b3-theme-surface);overflow-wrap:anywhere}
.sac-document-panel [hidden]{display:none}
.sac-chat-line,.sac-connection-line{display:flex;align-items:center;gap:6px;min-width:0}
.sac-chat-menu-anchor{position:static;z-index:30;flex:0 0 auto}
.sac-current-chat,.sac-connection-choice{display:flex;align-items:center;gap:5px;min-width:0;color:var(--b3-theme-on-surface);font-size:12px;white-space:nowrap}
.sac-current-chat{flex:1}
.sac-connection-choice{flex:1}
.sac-chat-menu,.sac-studio-picker{position:absolute;top:calc(100% + 4px);left:0;z-index:31;width:min(320px,calc(100cqw - 20px));max-width:calc(100vw - 40px);border:1px solid var(--b3-border-color);border-radius:8px;background:var(--b3-theme-surface);box-shadow:var(--b3-dialog-shadow)}
.sac-chat-menu{display:grid;gap:3px;padding:5px;right:0;left:auto;top:calc(100% + 4px);max-width:100%;z-index:20}
.sac-chat-menu[hidden]{display:none}
.sac-chat-menu button{width:100%;padding:7px 9px;text-align:left}
.sac-surface-tabs{display:flex;gap:5px}
.sac-surface-tabs button{flex:1;padding:5px 8px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-surface);color:var(--b3-theme-on-surface)}
.sac-surface-tabs button[aria-current="page"]{border-color:var(--b3-theme-primary);color:var(--b3-theme-primary);font-weight:600}
.sac[data-surface="ekko"] [data-chat-only]{display:none!important}
.sac-ekko{display:flex;flex-direction:column;flex:1 1 0;gap:6px;min-height:0;overflow:hidden;padding:3px 2px 0}
.sac-ekko[hidden]{display:none}
.sac-ekko h3{margin:7px 0 2px;font-size:12px}
.sac-ekko-management p{margin:4px 0}
.sac-ekko-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sac-ekko button{padding:4px 7px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-surface);color:var(--b3-theme-on-background);font:inherit;font-size:12px}
.sac-ekko-status{color:var(--b3-theme-on-surface);font-size:12px;white-space:pre-wrap}
.sac-ekko-account{color:var(--b3-theme-primary);font-size:12px}
.sac-ekko-list{display:grid;gap:5px}
.sac-ekko-list>div{display:flex;align-items:center;gap:5px;padding:4px 0;border-bottom:1px solid var(--b3-border-color)}
.sac-ekko-list span{flex:1;overflow-wrap:anywhere}
.sac-ekko-list small{color:var(--b3-theme-on-surface)}
.sac-ekko form:not(.sac-composer),.sac-ekko fieldset{display:grid;gap:5px;margin:0;padding:7px;border:1px solid var(--b3-border-color);border-radius:7px}
.sac-ekko form label,.sac-ekko fieldset label{display:flex;align-items:center;gap:5px}
.sac-ekko form input{width:100%;padding:5px;border:1px solid var(--b3-border-color);border-radius:5px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);font:inherit}
.sac-ekko form label:has(input:not([type="checkbox"])){display:grid}
.sac-ekko-room{position:relative;display:flex;flex-direction:column;flex:1 1 0;gap:6px;min-height:0;overflow:hidden;border-top:1px solid var(--b3-border-color);padding-top:6px}
.sac-ekko-messages{display:block;flex:1 1 0;min-height:24px;overflow:auto;padding:4px 2px;scrollbar-color:var(--b3-scroll-color) transparent}
.sac-ekko-message{width:fit-content;max-width:94%;margin:0 auto 14px 0;padding:8px 10px;border:1px solid var(--b3-border-color);border-radius:9px;background:var(--b3-theme-background);font-size:14px;line-height:1.6}
.sac-ekko-message[data-author="self"]{margin-left:auto;margin-right:0;background:var(--b3-theme-primary-lightest,var(--b3-theme-surface));border-color:var(--b3-theme-primary-lighter,var(--b3-border-color))}
.sac-ekko-message-meta{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 10px;margin-bottom:5px;font-size:12px;font-weight:500;color:var(--b3-theme-on-surface)}
.sac-ekko-message-meta>span{overflow-wrap:anywhere}
.sac-ekko-message-meta time{font-size:11px;font-weight:400}
.sac-ekko-message-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.sac-ekko .sac-ekko-message-actions button{margin:0;padding:2px 6px;background:transparent;border-color:transparent;color:var(--b3-theme-on-surface)}
.sac-ekko-message-actions button:focus-visible,.sac-ekko-reply-preview>button:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:1px}
.sac-ekko-receipt-status{margin-top:6px;color:var(--b3-theme-on-surface);font-size:11px}
.sac-ekko-message-content{overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}
.sac-ekko-technical{max-width:100%;color:var(--b3-theme-on-surface);font-size:12px}
.sac-ekko-technical summary{cursor:pointer;overflow-wrap:anywhere}
.sac-ekko-technical summary:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:2px}
.sac-ekko-technical pre{max-width:100%;max-height:40vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;font:12px/1.6 var(--b3-font-family-code,monospace)}
.sac-ekko-stream:empty{display:none}
.sac-ekko-preview{margin:0;max-height:14vh;overflow:auto;flex-shrink:0;font-size:12px;color:var(--b3-theme-on-surface)}
.sac-ekko-stream{max-height:16vh;overflow:auto;flex-shrink:0;white-space:pre-wrap;font-size:12px;color:var(--b3-theme-on-surface)}
.sac-brand{display:flex;align-items:center;gap:6px;min-width:0;flex:1;white-space:nowrap}
.sac-brand strong{font-size:14px;letter-spacing:.01em}
.sac-brand>span{overflow:hidden;color:var(--b3-theme-on-surface);font-size:12px;text-overflow:ellipsis}
.sac-brand-icon{width:22px;height:22px;flex:0 0 auto;fill:var(--b3-theme-primary)}
.sac-header-secondary select{min-width:0;flex:1;width:0;height:30px;padding:0 26px 0 8px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-surface);color:var(--b3-theme-on-background);font:inherit;text-overflow:ellipsis}
.sac-header-secondary [data-connection-choice]{max-width:215px}
.sac-icon-button,.sac-associate,.sac-chat-menu button,.sac-tool,.sac-send-stop,.sac-settings button,.sac-reference-chip button,.sac-plan-toggle,.sac-studio-picker button{border:1px solid var(--b3-border-color);background:var(--b3-theme-surface);color:var(--b3-theme-on-background);font:inherit;cursor:pointer}
.sac-icon-button{display:grid;place-items:center;width:30px;height:30px;flex:0 0 30px;padding:0;border-color:transparent;border-radius:6px;font-size:16px}
.sac-associate{height:30px;flex:0 0 auto;padding:0 9px;border-radius:6px;white-space:nowrap}
.sac-connection{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;color:var(--b3-theme-on-surface);max-width:94px;overflow:hidden;text-overflow:ellipsis;font-size:12px;white-space:nowrap}
.sac-connection i{display:block;width:7px;height:7px;border-radius:50%;background:var(--b3-theme-secondary)}
.sac-connection[data-state="connected"] i{background:var(--b3-theme-primary)}
.sac-connection[data-state="error"] i{background:var(--b3-theme-error)}
.sac-status-alert{flex:0 0 auto;max-height:26vh;overflow:auto;position:relative;display:flex;flex-wrap:wrap;align-items:flex-start;gap:5px;padding:7px 8px;border-left:3px solid var(--b3-theme-secondary);border-radius:5px;background:var(--b3-theme-surface);color:var(--b3-theme-on-surface);font-size:12px;line-height:1.45;overflow-wrap:anywhere}
.sac-status-alert[hidden]{display:none}
.sac-status-alert button[hidden]{display:none}
.sac-status-alert [data-action="dismiss-status"]{position:absolute;top:4px;right:4px;width:22px;height:22px;min-height:22px}

.sac-status-alert [data-status]{min-width:0;flex:1 1 100%;max-height:12vh;overflow:auto;padding-right:18px;white-space:pre-wrap}
.sac-status-alert button{width:auto;min-height:25px;flex:0 0 auto;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer}
.sac-status-alert [data-action="retry-connection"]{width:auto;flex:0 0 auto;padding:0 5px;border:1px solid var(--b3-border-color)}
.sac-status-alert [data-action="retry-connection"][hidden]{display:none}
.sac-status-alert [data-action="open-associated-chat"]{width:auto;min-width:64px;flex:0 0 auto;padding:0 5px;border:1px solid var(--b3-border-color)}
.sac-status-alert [data-action="open-associated-chat"][hidden]{display:none}
.sac-work-menu-anchor{position:relative;min-width:0;flex:1;z-index:40}
.sac-work-quick-menu{position:absolute;top:calc(100% + 6px);left:0;width:min(360px,100cqw);max-height:min(460px,calc(100cqh - 44px));overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--b3-border-color);border-radius:9px;background:var(--b3-theme-background);box-shadow:var(--b3-dialog-shadow);font-size:13px;line-height:1.5}
.sac-work-quick-menu>*{flex:none;margin:0}
.sac-work-quick-menu[hidden]{display:none}
.sac-work-quick-menu label{display:grid;gap:6px}
.sac-work-quick-menu input{width:100%;min-height:34px;padding:7px 9px;border:1px solid var(--b3-border-color);border-radius:5px;background:var(--b3-theme-surface);color:var(--b3-theme-on-background);font:inherit}
.sac-quick-context,.sac-quick-row small{display:block;color:var(--b3-theme-on-surface);font-size:12px;line-height:1.45}
.sac-quick-row{padding:8px 0;border-bottom:1px solid var(--b3-border-color)}
.sac-quick-row strong{display:block;white-space:normal;overflow-wrap:anywhere}
.sac-quick-row>div,.sac-quick-footer{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
.sac-work-quick-menu button{padding:5px 7px;border:1px solid var(--b3-border-color);border-radius:5px;background:var(--b3-theme-surface);color:var(--b3-theme-on-background);font:inherit;cursor:pointer}
.sac-settings-overlay{position:fixed;inset:0;z-index:101;display:flex;justify-content:center;align-items:center;padding:16px;background:var(--b3-mask-background,color-mix(in srgb,var(--b3-theme-on-background) 35%,transparent))}
.sac-settings-dialog{box-sizing:border-box;width:min(900px,100%);height:min(700px,calc(100dvh - 32px));display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:18px;border:1px solid var(--b3-border-color);border-radius:8px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);box-shadow:var(--b3-dialog-shadow);font:14px/1.5 var(--b3-font-family,system-ui,sans-serif)}
.sac-create-results{display:grid;gap:6px;max-height:180px;overflow:auto}.sac-create-results button{text-align:left;overflow-wrap:anywhere}.sac-create-selected{padding:10px;border-radius:6px;background:var(--b3-theme-surface)}
.sac-settings-dialog header{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:12px}.sac-settings-dialog h2{margin:0;font-size:16px;font-weight:600}.sac-settings-dialog h3{margin:0 0 10px;font-size:14px;font-weight:600}.sac-settings-dialog p{margin:6px 0;line-height:1.5;color:var(--b3-theme-on-surface)}.sac-settings-dialog label{display:grid;gap:5px}.sac-settings-dialog input,.sac-settings-dialog select{width:100%;min-width:0;box-sizing:border-box;padding:6px 8px;border:1px solid var(--b3-border-color);border-radius:4px;background:var(--b3-theme-surface);color:inherit;font:inherit}.sac-settings-dialog button{max-width:100%;margin:2px 6px 2px 0;padding:5px 9px;border:1px solid var(--b3-border-color);border-radius:4px;background:var(--b3-theme-surface);color:inherit;font:inherit;line-height:1.5;cursor:pointer;overflow-wrap:anywhere}.sac-settings-dialog header button{margin:0;min-width:28px;padding:1px 6px;font-size:18px}.sac-settings-dialog [role=alert]{color:var(--b3-theme-error)}.sac-settings-dialog .sac-settings-secondary{font-size:12px;line-height:1.5}
.sac-settings-layout [data-hermes-results]:not([hidden]){list-style:none;margin:6px 0 8px;padding:0;display:grid;gap:4px}.sac-settings-layout [data-hermes-results] li{padding:5px 8px;border-left:2px solid var(--b3-border-color);line-height:1.5;background:var(--b3-theme-surface)}
.sac-settings-layout .sac-connection-card{padding:12px;border:1px solid var(--b3-border-color);border-radius:8px;background:var(--b3-theme-surface);min-width:0;overflow-wrap:anywhere}.sac-connection-actions{display:flex;flex-wrap:wrap;gap:6px}.sac-settings-dialog .sac-connection-actions button{margin:2px 0}.sac-settings-layout [data-connection-candidate]{margin-top:10px;padding-top:10px;border-top:1px solid var(--b3-border-color)}.sac-settings-layout [data-connection-step]{margin:0 0 8px;padding:0 0 8px;border:0;border-bottom:1px solid var(--b3-border-color)}.sac-settings-layout [data-connection-step] > summary{cursor:pointer;font-weight:600;line-height:1.5}.sac-settings-layout [data-connection-step][open] > summary{margin-bottom:6px}.sac-settings-layout [data-diagnostic-preview]{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;max-height:280px;overflow:auto;padding:10px;background:var(--b3-theme-surface);border:1px solid var(--b3-border-color);border-radius:4px;font:12px/1.5 var(--b3-font-family-code,monospace)}.sac-settings-layout [data-connection-help]{padding:10px 0 0;border-top:1px solid var(--b3-border-color);margin-top:12px}
.sac-settings-dialog .sac-settings-help,.sac-settings-dialog .sac-settings-advanced{margin:0;padding:7px 0;border:0}.sac-settings-dialog .sac-settings-help > summary,.sac-settings-dialog .sac-settings-advanced > summary{cursor:pointer;line-height:1.5;color:var(--b3-theme-on-surface)}.sac-settings-dialog .sac-settings-help[open] > summary,.sac-settings-dialog .sac-settings-advanced[open] > summary{margin-bottom:6px}.sac-settings-dialog .sac-settings-advanced label{margin-top:8px}.sac-settings-dialog .sac-settings-primary{background:var(--b3-theme-primary);border-color:var(--b3-theme-primary);color:var(--b3-theme-on-primary)}.sac-settings-dialog .sac-settings-status{padding:6px 0;color:var(--b3-theme-on-background)}.sac-settings-dialog :is(button,summary,input,select):focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:2px}.sac-settings-layout{display:grid;grid-template-columns:142px minmax(0,1fr);gap:18px;min-height:0;flex:1;margin-top:12px;border-top:1px solid var(--b3-border-color);padding-top:12px}.sac-settings-layout nav{display:flex;flex-direction:column;gap:4px;overflow:auto;border-right:1px solid var(--b3-border-color);padding-right:12px}.sac-settings-layout nav button{text-align:left;margin:0;border-color:transparent;background:transparent}.sac-settings-layout nav button[aria-current="page"]{color:var(--b3-theme-primary);background:var(--b3-list-hover)}.sac-settings-layout main{min-width:0;min-height:0;overflow:auto;padding:0 6px 4px 2px;overflow-wrap:anywhere}.sac-settings-layout section{margin:0;padding:0;border:0}.sac-settings-layout [hidden]{display:none}.sac-settings-layout form{display:grid;gap:12px}.sac-settings-dialog button:disabled{opacity:.55;cursor:default}.sac-settings-dialog footer{flex:0 0 auto;margin-top:10px;padding-top:8px;border-top:1px solid var(--b3-border-color);text-align:right}.sac-settings-dialog footer button{margin:0;border-color:transparent;background:transparent;color:var(--b3-theme-on-surface);font-size:12px}
@media(max-width:600px){.sac-settings-overlay{padding:8px}.sac-settings-dialog{padding:12px;height:calc(100dvh - 16px)}.sac-settings-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:10px}.sac-settings-layout nav{flex-direction:row;border-right:0;padding:0;flex-wrap:wrap}.sac-settings-layout nav button{padding:5px 7px}.sac-settings-layout main{padding-right:3px}.sac-settings-dialog footer{text-align:left}}
@media(max-height:400px){.sac-settings-overlay{padding:8px}.sac-settings-dialog{height:calc(100dvh - 16px);padding:10px}.sac-settings-layout{margin-top:6px;padding-top:6px;gap:8px}.sac-settings-dialog footer{margin-top:6px;padding-top:4px}}
.sac-main{display:flex;flex-direction:column;flex:1 1 0;gap:20px;min-height:56px;overflow:auto;overflow-x:hidden;padding:10px 2px 12px;scrollbar-color:var(--b3-scroll-color) transparent}
.sac-empty{display:flex;flex-direction:column;align-items:center;align-self:center;width:min(100%,290px);margin:auto;padding:12px 8px;text-align:center;color:var(--b3-theme-on-surface)}
.sac-empty-icon{width:28px;height:28px;margin-bottom:8px;fill:var(--b3-theme-primary)}
.sac-empty h2{margin:0;color:var(--b3-theme-on-background);font-size:14px;font-weight:600}
.sac-empty p{margin:5px 0 12px;font-size:12px;line-height:1.5}
.sac-empty-capabilities{display:grid;width:100%;gap:5px;text-align:left}
.sac-empty-capability{display:flex;align-items:center;gap:7px;padding:3px 8px;font-size:12px}
.sac-empty-capability i{display:grid;place-items:center;width:20px;height:20px;flex:0 0 20px;color:var(--b3-theme-primary);font-style:normal}
.sac-message{display:flex;flex-direction:column;max-width:92%;font-size:14px;line-height:1.6;overflow-wrap:anywhere}
.sac-message-user{align-self:flex-end;align-items:flex-end}
.sac-message-assistant{align-self:flex-start;align-items:flex-start;width:100%;max-width:100%}
.sac-message-author{display:flex;align-items:center;gap:5px;margin:0 3px 4px;color:var(--b3-theme-on-surface);font-size:12px}
.sac-message-avatar{display:grid;place-items:center;width:18px;height:18px;border-radius:5px;background:var(--b3-theme-primary-lightest);color:var(--b3-theme-primary);font-size:12px;font-weight:700}
.sac-message-user .sac-message-avatar{background:var(--b3-theme-surface);color:var(--b3-theme-on-surface)}
.sac-message-content{max-width:100%}
.sac-message-user .sac-message-content{padding:8px 10px;border-radius:8px;background:var(--b3-theme-surface)}
.sac-message-assistant .sac-message-content{padding:2px 4px}
.sac-message-body{overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}
.sac-message-refs{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
.sac-message-ref{max-width:100%;padding:3px 6px;border:1px solid var(--b3-border-color);border-radius:5px;color:var(--b3-theme-on-surface);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sac-message-state{display:inline-flex;margin-top:5px;padding:2px 6px;border-radius:4px;background:var(--b3-theme-surface);color:var(--b3-theme-error);font-size:12px}
.sac-reference-chips{flex:0 0 auto;max-height:12vh;display:flex;align-items:center;gap:5px;min-width:0;padding:2px 0;overflow-x:auto;overflow-y:hidden;white-space:nowrap;scrollbar-color:var(--b3-scroll-color) transparent}
.sac-reference-chips[hidden]{display:none}
.sac-reference-count{position:sticky;left:0;z-index:1;flex:0 0 auto;padding:4px 6px;background:var(--b3-theme-background);color:var(--b3-theme-on-surface);font-size:12px;font-weight:600}
.sac-reference-chip{display:inline-flex;align-items:center;gap:5px;max-width:210px;flex:0 0 auto;padding:4px 5px 4px 7px;border:1px solid var(--b3-border-color);border-radius:7px;background:var(--b3-theme-surface);font-size:12px}
.sac-reference-source{flex:0 0 auto;color:var(--b3-theme-primary);font-weight:600}
.sac-reference-text{overflow:hidden;color:var(--b3-theme-on-surface);text-overflow:ellipsis}
.sac-reference-chip button{display:grid;place-items:center;width:20px;height:20px;flex:0 0 20px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font-size:15px;line-height:1}
.sac-composer{display:grid;flex:0 0 auto;gap:5px;margin-top:0;padding:7px;border:1px solid var(--b3-border-color);border-radius:9px;background:var(--b3-theme-surface)}
.sac-composer-resize{display:grid;place-items:center;height:12px;cursor:ns-resize;touch-action:none;user-select:none}
.sac-composer-resize::before{content:"";width:36px;height:3px;border-radius:3px;background:var(--b3-theme-on-surface);opacity:.5}
.sac-composer-resize:hover::before,.sac-composer-resize:focus-visible::before{background:var(--b3-theme-primary)}
.sac-composer:focus-within{border-color:var(--b3-theme-primary)}
.sac textarea{width:100%;height:38px;min-height:38px;max-height:240px;padding:4px 5px;resize:none;border:0;outline:0;background:transparent;color:var(--b3-theme-on-background);font:inherit;line-height:1.6}
.sac-mention-wrap{position:relative;min-width:0}
.sac-mention-list{position:absolute;z-index:1000;right:0;bottom:calc(100% + 7px);left:0;max-height:220px;padding:4px;overflow-y:auto;border:1px solid var(--b3-border-color);border-radius:9px;background:var(--b3-theme-background);box-shadow:var(--b3-dialog-shadow)}
.sac-mention-option{display:flex;flex-direction:column;align-items:flex-start;width:100%;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:var(--b3-theme-on-background);cursor:pointer;text-align:left}
.sac-mention-marker,.sac-mention-source{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sac-mention-marker{font-weight:600}
.sac-mention-source{margin-top:2px;color:var(--b3-theme-on-surface);font-size:12px}
.sac-mention-empty{padding:10px;color:var(--b3-theme-on-surface);font-size:12px;text-align:center}
.sac-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px}
.sac-tools{display:flex;align-items:center;gap:3px;min-width:0;overflow-x:auto;overflow-y:hidden}
.sac-tool{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:3px 6px;border-color:transparent;border-radius:6px;background:transparent;color:var(--b3-theme-on-surface);font-size:12px;white-space:nowrap}
.sac-send-stop{position:relative;display:grid;place-items:center;width:36px;height:36px;flex:0 0 36px;padding:0;border-color:var(--b3-theme-primary);border-radius:9px;background:var(--b3-theme-primary);color:var(--b3-theme-on-primary);font-size:19px}
.sac-send-stop.is-generating{font-size:12px}
.sac-thinking-indicator{position:absolute;right:2px;bottom:2px;display:inline-flex;gap:1px;align-items:center}
.sac-thinking-indicator[hidden]{display:none}
.sac-thinking-indicator i{width:2px;height:2px;border-radius:50%;background:currentColor;animation:sac-thinking 1s ease-in-out infinite}
.sac-thinking-indicator i:nth-child(2){animation-delay:.15s}
.sac-thinking-indicator i:nth-child(3){animation-delay:.3s}
@keyframes sac-thinking{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
.sac-plan-toggle{margin-top:6px;padding:0;border:0;background:transparent;color:var(--b3-theme-primary);text-align:left}
.sac-studio-picker{padding:8px}
.sac-studio-picker>div{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:100%;max-height:200px;min-height:0;gap:8px;overflow:hidden}
.sac-studio-body{display:flex;flex-direction:column;min-height:0;overflow:hidden;gap:8px}
.sac-studio-body>[data-studio-read-warning]{flex-shrink:0}
.sac-studio-picker [data-studio-feedback]{flex-shrink:0;max-height:80px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.sac-studio-picker input[data-studio-search]{width:100%;height:32px;padding:0 8px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-background);color:var(--b3-theme-on-background)}
.sac-studio-actions{display:flex;justify-content:flex-end;gap:6px}
.sac-studio-actions button{padding:5px 9px;border-radius:6px}
[data-studio-options]{min-height:0;overflow-y:auto}
[data-studio-options] label{display:flex;align-items:center;gap:7px;padding:7px;border-radius:6px;cursor:pointer}
[data-studio-options] label>span{display:block;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sac-header button:hover,.sac-icon-button:hover,.sac-associate:hover,.sac-chat-menu button:hover,.sac-tool:hover,.sac-settings button:hover,.sac-reference-chip button:hover,.sac-plan-toggle:hover,.sac-status-alert button:hover,.sac-mention-option:hover,.sac-mention-option[aria-selected="true"],[data-studio-options] label:hover,.sac-studio-picker button:hover{background:var(--b3-list-hover)}
.sac-send-stop:hover{filter:brightness(.96)}
.sac button:focus-visible,.sac select:focus-visible,.sac input:focus-visible,.sac textarea:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:2px}
.sac button:disabled,.sac select:disabled,.sac input:disabled{cursor:not-allowed;opacity:.45}
@container (max-width:340px){.sac{padding:8px;gap:6px}.sac-brand>span{display:none}.sac-header-primary{gap:3px}.sac-header-secondary{gap:4px}.sac-associate{padding:0 7px}.sac-connection{max-width:78px}.sac-tool{padding-inline:5px}.sac-message{max-width:96%}.sac-current-chat{gap:3px}.sac-header button{padding-inline:5px}.sac-current-chat select{padding-left:4px;padding-right:16px}.sac-status-alert{padding:5px 6px}}

/* The dock has two header rows; history owns the remaining height. */
.sac-task-menu-anchor{flex:0 0 auto}.sac-task-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:32;display:flex;flex-direction:column;gap:12px;width:min(360px,100%);max-height:min(460px,var(--sac-task-menu-space,60vh));overflow:auto;padding:14px;border:1px solid var(--b3-border-color);border-radius:10px;background:var(--b3-theme-background);box-shadow:var(--b3-dialog-shadow)}
.sac-task-menu[hidden]{display:none}
.sac-header .sac-task-menu button{padding:7px 10px;text-align:left;white-space:normal;line-height:1.4;cursor:pointer}
.sac-task-menu small{display:block;color:var(--b3-theme-on-surface);font-size:12px;line-height:1.5}
.sac-task-menu-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex:0 0 auto}.sac-task-menu-header strong{font-size:14px}.sac-header .sac-task-menu-header button{padding:3px 8px;font-size:18px;background:transparent}
.sac-task-menu>label{display:grid;gap:6px;flex:0 0 auto;font-size:12px}.sac-task-menu input{box-sizing:border-box;width:100%;min-width:0;font:inherit;padding:8px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-surface);color:inherit}
.sac-task-menu [data-recent-task-results]{min-height:44px;overflow:auto;flex:1 1 auto;border-top:1px solid var(--b3-border-color);padding-top:10px}.sac-task-menu-result-label{margin-bottom:4px}
.sac-task-menu[data-short="true"] [data-recent-task-results]{flex:0 0 auto;min-height:0;overflow:visible}.sac-task-menu[data-short="true"] .sac-task-menu-header{position:sticky;top:0;z-index:1;background:var(--b3-theme-background)}
.sac-task-menu-row{display:grid;gap:6px;padding:12px 0;border-bottom:1px solid var(--b3-border-color)}.sac-task-menu-row strong{display:block;font-size:13px;font-weight:500;line-height:1.5;overflow-wrap:anywhere}.sac-task-menu-row button{justify-self:start;font-size:12px}
.sac-task-menu-row small{overflow-wrap:anywhere}
.sac-task-menu-footer{display:grid;gap:8px;flex:0 0 auto;border-top:1px solid var(--b3-border-color);padding-top:10px}.sac-task-menu-actions summary{padding:5px 0;cursor:pointer;color:var(--b3-theme-on-surface);font-size:12px}.sac-task-menu-actions>div{display:grid;gap:7px;margin-top:7px}
.sac-task-menu button:focus-visible,.sac-task-menu input:focus-visible,.sac-task-menu summary:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:2px}
.sac-header button{font:inherit;font-size:12px;border:1px solid transparent;border-radius:5px;background:transparent;color:inherit;padding:3px 7px;flex-shrink:0}
.sac-work-switch{display:flex;align-items:center;flex:1;min-width:0;max-width:100%}
.sac-work-switch span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sac .sac-work-compact{flex:0 0 auto;padding:3px 2px;border:0;max-height:26vh;overflow:auto}
.sac-work-compact summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.sac-work-compact label{display:flex;align-items:center;gap:4px}
.sac .sac-work-compact details{margin-top:0}
.sac-studio-picker{position:absolute;left:0;right:0;top:62px;width:auto;max-width:100%;z-index:21}
.sac-studio-picker>div{max-height:220px;overflow:hidden}
.sac-proposal{flex:0 1 auto;max-height:26vh;overflow:auto;border:1px solid var(--b3-border-color);padding:6px}
.sac-ekko-management{flex:0 0 auto;max-height:25vh;overflow:auto}
.sac-ekko-management summary,.sac-ekko-room>details>summary{cursor:pointer;font-size:12px}
.sac-ekko-room>h3{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 0 auto}
.sac-ekko-room>details{max-height:22vh;overflow:auto;flex-shrink:0}
.sac-ekko-room>form{flex:0 0 auto}
.sac-ekko-status{max-height:14vh;overflow:auto;flex-shrink:0}
.sac-room-association{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:var(--b3-mask-background)}
.sac-room-association>[role=dialog]{width:min(480px,94vw);max-height:85vh;overflow:auto;padding:16px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);border:1px solid var(--b3-border-color);border-radius:8px}
@media(max-height:500px){.sac{gap:3px;padding:5px}.sac-header{gap:2px}.sac-composer textarea,.sac-ekko-room .sac-composer textarea{max-height:70px}.sac-empty{padding:6px}.sac .sac-work-compact{max-height:12vh}.sac-ekko-room{gap:5px}.sac-ekko-room>h3{position:absolute;width:1px;height:1px;padding:0;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.sac-ekko-preview{max-height:20px;overflow:auto}}

.sac-markdown-fallback{white-space:pre-wrap}
.sac-markdown{line-height:1.6;overflow-wrap:anywhere}
.sac-markdown>:first-child{margin-top:0}.sac-markdown>:last-child{margin-bottom:0}
.sac-markdown p,.sac-markdown ul,.sac-markdown ol,.sac-markdown blockquote{margin:7px 0}
.sac-markdown ul,.sac-markdown ol{padding-left:22px}.sac-markdown h1{font-size:19px}.sac-markdown h2{font-size:17px}.sac-markdown h3{font-size:15px}.sac-markdown h4,.sac-markdown h5,.sac-markdown h6{font-size:13px}.sac-markdown h1,.sac-markdown h2,.sac-markdown h3{margin:12px 0 5px}
.sac-markdown blockquote{margin-left:0;padding-left:10px;border-left:3px solid var(--b3-border-color);color:var(--b3-theme-on-surface)}
.sac-markdown pre{position:relative;max-width:100%;overflow:auto;padding:10px 10px 38px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-surface);white-space:pre}
.sac-markdown code{font-family:var(--b3-font-family-code,monospace);font-size:12px}.sac-markdown :not(pre)>code{padding:1px 4px;border-radius:3px;background:var(--b3-theme-surface)}
.sac-markdown table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse;font-size:12px}.sac-markdown th,.sac-markdown td{padding:5px 8px;border:1px solid var(--b3-border-color);white-space:nowrap}
.sac-markdown a{color:var(--b3-theme-primary)}
.sac-copy-reply,.sac-ekko .sac-copy-reply,.sac-markdown [data-copy-code],.sac-message-latest{border:1px solid var(--b3-border-color);border-radius:5px;background:var(--b3-theme-surface);color:var(--b3-theme-on-surface);font:inherit;font-size:12px;padding:3px 7px;cursor:pointer}
.sac-copy-reply,.sac-ekko .sac-copy-reply{margin-top:7px;border-color:transparent;background:transparent}.sac-markdown [data-copy-code]{display:block;position:sticky;left:0;margin-top:6px;width:max-content}.sac-markdown pre:has([data-copy-code]){padding-bottom:8px}
.sac-message-latest{position:absolute;z-index:3;max-width:calc(100% - 16px);margin:0;box-shadow:var(--b3-button-shadow)}.sac-message-latest[hidden]{display:none}
.sac-connection[hidden]{display:none}
.sac-work-switch:before{content:'Work';font-size:12px;color:var(--b3-theme-on-surface);border-right:1px solid var(--b3-border-color);padding-right:6px;margin-right:6px;flex-shrink:0}
.sac-session-kind{flex:0 0 auto;font-size:12px;padding:3px 5px;border-radius:4px;line-height:1.4;color:var(--b3-theme-primary);background:color-mix(in srgb,var(--b3-theme-primary) 10%,transparent)}
.sac-session-kind[data-kind=ekko]{color:var(--b3-theme-on-surface);background:var(--b3-theme-surface);border:1px solid var(--b3-border-color)}
.sac-ekko-composer>button{justify-self:end;font-size:12px;padding:5px 10px}
.sac-ekko-composer .sac-composer-resize:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:1px}
/* SiYuan can place a short dock inside a tall window. Budget its actual height,
   keeping the composer and scrollable notices usable without hiding controls. */
@container (max-height:400px){
  .sac-header{gap:2px;padding-bottom:3px}
  .sac-header-primary,.sac-header-secondary{min-height:28px}
  .sac-header-secondary{padding-top:0}
  .sac-header-secondary select{height:28px}
  .sac-header .sac-icon-button{width:28px;height:28px;flex-basis:28px}
  .sac-main{min-height:24px}
  .sac-status-alert{flex:0 1 auto;min-height:40px;max-height:26cqh}
  .sac-status-alert [data-status]{max-height:12cqh}
  .sac-reference-chips{padding-block:0}
  .sac-reference-chip{padding-block:2px}
  .sac .sac-work-compact{flex:0 1 auto;min-height:20px;max-height:20cqh;padding-block:1px}
  .sac-composer{gap:3px;padding:4px}
  .sac-composer textarea{display:block;max-height:70px}
  .sac-ekko-management{max-height:25cqh}
  .sac-ekko-room{gap:2px;padding-top:3px}
  .sac-ekko-room>h3{margin:0;line-height:16px}
  .sac-ekko-room>.sac-composer{gap:2px;padding:3px}
  .sac-ekko-room>details{flex:0 1 auto;min-height:20px;max-height:22cqh}
  .sac-ekko-room .sac-composer textarea{max-height:70px}
  .sac-ekko-status{max-height:17px}
  .sac-ekko-stream{max-height:14cqh;flex-shrink:1}
  .sac-ekko-stream:empty{display:none}
  .sac-ekko-preview{max-height:20px;min-height:0;flex-shrink:1;margin-block:0;overflow:auto}
  .sac:has([data-status-alert]:not([hidden])):has([data-references]:not([hidden])) .sac-composer textarea{max-height:clamp(38px,calc(100cqh - 270px),70px)}
}

/* Room robots share checkbox selection; keep chips to one scrollable row. */
.sac-ekko-selected-agents{display:flex;gap:4px;overflow-x:auto;overflow-y:hidden;max-height:32px;white-space:nowrap}
.sac-ekko-composer-state[hidden],.sac-ekko-composer-state button[hidden],.sac-ekko-selected-agents[hidden],.sac-ekko-mention-list[hidden]{display:none}
.sac-ekko-agent-chip{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;max-width:100%;border:1px solid var(--b3-border-color);border-radius:5px;background:var(--b3-theme-surface);font-size:12px}
.sac-ekko-agent-chip>span{overflow:hidden;text-overflow:ellipsis;padding-left:4px}
.sac-ekko-agent-chip>button{padding:1px 5px}
.sac-ekko-mention-wrap textarea{display:block}
.sac-ekko-send-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px}
.sac-ekko-send-controls button{min-height:30px;font-size:12px;white-space:nowrap}
.sac-ekko-send-controls [data-ekko-action="open-sources"],.sac-ekko-send-controls [data-ekko-action="mention-agents"]{border-color:transparent;background:transparent;color:var(--b3-theme-on-surface)}
.sac-ekko-send-controls button[type="submit"]{border-color:var(--b3-theme-primary);background:var(--b3-theme-primary);color:var(--b3-theme-on-primary)}
.sac-ekko-mention-list{position:absolute;z-index:12;left:3px;right:3px;bottom:40px;max-height:min(220px,55cqh);overflow:auto;padding:3px;border:1px solid var(--b3-border-color);border-radius:7px;background:var(--b3-theme-background);box-shadow:var(--b3-dialog-shadow)}
.sac-ekko-mention-list>button{display:block;width:100%;min-height:30px;margin:0 0 2px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sac-ekko-mention-list>button:hover,.sac-ekko-mention-list>button[aria-selected="true"]{background:var(--b3-list-hover,var(--b3-theme-surface));border-color:var(--b3-theme-primary)}
.sac-ekko-mention-empty{padding:6px;color:var(--b3-theme-on-surface);font-size:12px}
.sac-ekko-reply-preview{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:2px 8px;padding:5px 7px;border-left:3px solid var(--b3-theme-primary);background:var(--b3-theme-surface);min-width:0}
.sac-ekko-reply-preview>details{grid-column:1;grid-row:1;max-height:min(180px,25cqh);overflow:auto}
.sac-ekko-reply-preview>button{grid-column:2;grid-row:1;align-self:start;white-space:nowrap}
.sac .sac-ekko-quote{min-width:0;max-width:100%;margin:6px 0 0;border-left:2px solid var(--b3-border-color);padding-left:8px;color:var(--b3-theme-on-surface);font-size:12px;line-height:16px}
.sac .sac-ekko-reply-preview .sac-ekko-quote{margin:0;border:0;padding:0}
.sac .sac-ekko-quote>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 6px;list-style:none;cursor:pointer;min-width:0;max-width:100%;font-size:12px;line-height:16px;overflow:hidden}
.sac .sac-ekko-quote>summary::-webkit-details-marker{display:none}
.sac .sac-ekko-quote>summary:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:-2px}
.sac .sac-ekko-quote>summary>strong{grid-column:1;grid-row:1;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px}
.sac .sac-ekko-quote-excerpt{grid-column:1/-1;grid-row:2;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;max-height:32px;overflow:hidden;white-space:normal;overflow-wrap:anywhere;font-size:12px;line-height:16px}
.sac .sac-ekko-quote-hint{grid-column:2;grid-row:1;display:block;white-space:nowrap;color:var(--b3-theme-primary);font-size:11px;line-height:16px}
.sac .sac-ekko-quote-hint::after{content:" ▸"}
.sac .sac-ekko-quote[open] .sac-ekko-quote-hint::after{content:" ▾"}
.sac .sac-ekko-quote pre{max-width:100%;max-height:min(240px,32cqh);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;padding:4px;user-select:text;-webkit-user-select:text;font:12px/18px var(--b3-font-family-code,monospace)}
.sac .sac-ekko-reply-preview .sac-ekko-quote pre{max-height:min(100px,15cqh)}
.sac .sac-ekko-quote pre code{font:inherit;white-space:inherit;overflow-wrap:inherit}

.sac-ekko-composer-state{display:flex;align-items:center;flex-wrap:wrap;gap:3px 6px;min-width:0;max-height:min(6em,20cqh);overflow:auto;font-size:12px;line-height:1.4;color:var(--b3-theme-on-surface)}
.sac-ekko-composer-state span{flex:1 1 160px;overflow-wrap:anywhere}.sac-ekko-composer-state button{flex:0 0 auto;font-size:12px}.sac-ekko-composer-state button:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:1px}
`;
