function a(e){return e.some(n=>n.startsWith("read-"))}function i(e,n,t){const r=new Set(e);return t?(r.add(n),n==="read-transcript-full"&&r.add("read-transcript")):(r.delete(n),n==="read-transcript"&&r.delete("read-transcript-full")),[...r]}function o(e){if(!e.authorizationToken)return null;const n=e.closure.map(t=>`• ${t.displayName} (${t.agentId}, ${t.terminalId})`).join(`
`);return!window.confirm(`Allow pull access to this effective disclosure scope?

${n}

Content returned to the requesting agent becomes part of that vendor-managed transcript and may follow the vendor’s retention/deletion policy. 1DevTool content-capture settings cannot retract it.

Revocation stops future reads; it cannot recall content already copied.`)||e.requiresScreenSecretConsent&&!window.confirm(`Allow unredacted terminal-screen disclosure?

Screen reads strip terminal control codes only. Credentials, API keys, environment output, and .env contents are returned verbatim. This permission is off by default.`)?null:{fingerprint:e.fingerprint,authorizationToken:e.authorizationToken,vendorTranscript:e.requiresVendorTranscriptConsent,screenSecrets:e.requiresScreenSecretConsent}}async function s(e){const n=await window.api.orchestration.previewReadConsent(e);if(!n.ok)return{ok:!1,error:n.error};const t=o(n.preview);return t?{ok:!0,grant:t}:{ok:!1,cancelled:!0}}export{a as h,i as n,s as r};
