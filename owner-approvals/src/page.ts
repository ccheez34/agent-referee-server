// The owner's one-page form (his phone). No outside scripts, styles or fonts; the token is never stored by the page.
// Answers are shown as plain text (textContent), never as HTML. While a request is out every button is off, and a
// repeated "Sign" sends the same request id, so a double tap can't make a second approval (fresh read of c3b0b64, #3).
export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Owner approvals</title><style>
:root{color-scheme:light dark}body{font:16px/1.4 system-ui,sans-serif;max-width:34rem;margin:1rem auto;padding:0 1rem}
label{display:block;margin:.6rem 0 .2rem}input,select,button{font:inherit;width:100%;box-sizing:border-box;padding:.5rem}
button{margin-top:.6rem}button:disabled{opacity:.5}pre{white-space:pre-wrap;word-break:break-all;font-size:13px}fieldset{margin-top:1rem}
.row{border-top:1px solid #8884;padding:.4rem 0}.row button{width:auto;margin:.3rem 0 0}
</style></head><body><h1>Owner approvals</h1>
<p>Approve one exact action for a limited time. Every gate checks these records. Only type your token on this page's own address.</p>
<label>Your owner token<input id="t" type="password" autocomplete="off"></label>
<fieldset><legend>Approve</legend>
<label>Action<select id="a"><option>deploy</option><option>publish</option><option>payment</option><option>delete</option><option>secret</option><option>install</option><option>rule_change</option></select></label>
<label>Target, exactly as the gate will ask for it<input id="g" maxlength="200" placeholder="agent-referee-server:production@&lt;40-hex commit&gt;"></label>
<label>Its sha256 (64 hex, optional)<input id="v" maxlength="64"></label>
<label>Uses (1-20)<input id="u" type="number" min="1" max="20" value="1"></label>
<label>Expires in hours (0.25-24)<input id="h" type="number" min="0.25" max="24" step="0.25" value="2"></label>
<button id="go">Sign this approval</button></fieldset>
<fieldset><legend>Live approvals</legend><button id="ls">Show them</button><div id="list"></div><button id="ra">Revoke every live approval</button></fieldset>
<fieldset><legend>Emergency</legend><button id="fz">Freeze: every gate refuses everything</button><button id="uf">Unfreeze</button></fieldset>
<fieldset><legend>Policy version</legend><label>The gate policy's "version"<input id="p" maxlength="64"></label><button id="pv">Set it</button></fieldset>
<pre id="out"></pre>
<script>
const $=(i)=>document.getElementById(i);
let rid=crypto.randomUUID();
let busy=false;
function lock(on){busy=on;for(const b of document.querySelectorAll("button"))b.disabled=on}
async function send(path,body){if(busy)return null;lock(true);$("out").textContent="...";try{const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+$("t").value},body:JSON.stringify(body)});const j=await r.json();$("out").textContent=r.status+"\\n"+JSON.stringify(j,null,2);return {status:r.status,body:j}}catch(e){$("out").textContent=String(e);return null}finally{lock(false)}}
function row(rec){const p=rec.payload;const d=document.createElement("div");d.className="row";const t=document.createElement("div");t.textContent=p.action+" | "+p.target+(p.target_sha256?" | sha256 "+p.target_sha256.slice(0,12)+"...":"")+" | uses "+p.max_uses+" | until "+p.expires_at+" | nonce "+p.nonce;const b=document.createElement("button");b.textContent="Revoke";b.onclick=async()=>{await send("/revoke",{nonce:p.nonce});await show()};d.append(t,b);return d}
async function show(){const r=await send("/status",{});const l=$("list");l.replaceChildren();if(!r||r.status!==200)return;const s=document.createElement("p");s.textContent=(r.body.frozen?"FROZEN. ":"")+"Policy version: "+(r.body.policy_version||"not set")+". Live approvals: "+r.body.live.length+".";l.append(s);for(const rec of r.body.live)l.append(row(rec))}
$("go").onclick=async()=>{const r=await send("/approve",{action:$("a").value,target:$("g").value,target_sha256:$("v").value||null,max_uses:Number($("u").value),expires_in_hours:Number($("h").value),request_id:rid});if(r&&r.status===200)rid=crypto.randomUUID()};
$("ls").onclick=show;
$("ra").onclick=async()=>{await send("/revoke",{all:true});await show()};
$("fz").onclick=async()=>{await send("/freeze",{on:true});await show()};
$("uf").onclick=async()=>{await send("/freeze",{on:false});await show()};
$("pv").onclick=()=>send("/policy",{version:$("p").value});
</script></body></html>`;

export const pageResponse = () =>
  new Response(PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
