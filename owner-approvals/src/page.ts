// The owner's one-page form (his phone). No outside scripts, styles or fonts; the token is never stored by the page.
// Answers are shown as plain text (textContent), never as HTML. While a request is out every button is off, and a
// repeated "Sign" sends the same request id, so a double tap can't make a second approval (fresh read of c3b0b64, #3);
// changing any field makes a new id (part A review 1). v2 (Nov 3): the seat each approval is for, from the policy's
// members (loaded with Show them), and how many approvals, since each is used once. The seats and the actions both come
// from the stored policy; a load that changes the chosen one makes a new request id (review 2, Sonnet).
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
<label>For which seat (load them with "Show them" below)<select id="m"><option value="">(press Show them first)</option></select></label>
<label>Action (from the policy, after "Show them")<select id="a"><option value="">(press Show them first)</option></select></label>
<label>Target, exactly as the gate will ask for it<input id="g" maxlength="200" placeholder="agent-referee-server:production@&lt;40-hex commit&gt;"></label>
<label>Its sha256 (64 hex, optional)<input id="v" maxlength="64"></label>
<label>How many approvals (each is used once; 1-20)<input id="c" type="number" min="1" max="20" value="1"></label>
<label>Expires in hours (0.25-24)<input id="h" type="number" min="0.25" max="24" step="0.25" value="2"></label>
<button id="go">Sign this approval</button></fieldset>
<fieldset><legend>Live approvals</legend><button id="ls">Show them</button><div id="list"></div><button id="ra">Revoke every live approval</button></fieldset>
<fieldset><legend>Emergency</legend><button id="fz">Freeze: every gate refuses everything</button><button id="uf">Unfreeze</button></fieldset>
<fieldset><legend>Policy</legend><p>Copy these from the gate policy file.</p><label>Its "version"<input id="p" maxlength="64"></label>
<label>Its "members", separated by commas<input id="pm" placeholder="1.0, 2.0, 3.0, 4.0, 5.0"></label>
<label>Its owner-only actions, separated by commas (empty: the ten usual ones)<input id="pa"></label>
<label>Its "approval_max_hours" (empty: 24)<input id="ph" type="number" min="1" max="24"></label><button id="pv">Set it</button></fieldset>
<pre id="out"></pre>
<script>
const $=(i)=>document.getElementById(i);
let rid=crypto.randomUUID();
let busy=false;
function lock(on){busy=on;for(const b of document.querySelectorAll("button"))b.disabled=on}
async function send(path,body){if(busy)return null;lock(true);$("out").textContent="...";try{const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+$("t").value},body:JSON.stringify(body)});const j=await r.json();$("out").textContent=r.status+"\\n"+JSON.stringify(j,null,2);return {status:r.status,body:j}}catch(e){$("out").textContent=String(e);return null}finally{lock(false)}}
function row(rec){const p=rec.payload;const d=document.createElement("div");d.className="row";const t=document.createElement("div");t.textContent=p.member+" | "+p.action+" | "+p.target+(p.target_sha256?" | sha256 "+p.target_sha256.slice(0,12)+"...":"")+" | until "+p.expires_at+" | nonce "+p.nonce;const b=document.createElement("button");b.textContent="Revoke";b.onclick=async()=>{await send("/revoke",{nonce:p.nonce});await show()};d.append(t,b);return d}
function fill(sel,items){const old=sel.value;sel.replaceChildren();for(const x of items){const o=document.createElement("option");o.textContent=x;o.value=x;sel.append(o)}if(items.includes(old))sel.value=old;else rid=crypto.randomUUID()}
async function show(){const r=await send("/status",{});const l=$("list");l.replaceChildren();if(!r||r.status!==200)return;const pol=r.body.policy;if(pol){fill($("m"),pol.members);fill($("a"),pol.actions);$("h").max=String(pol.max_hours)}const s=document.createElement("p");s.textContent=(r.body.frozen?"FROZEN. ":"")+"Policy: "+(pol?pol.version+", seats "+pol.members.join(", ")+", at most "+pol.max_hours+" hours":"not set")+". Live approvals: "+r.body.live.length+".";l.append(s);for(const rec of r.body.live)l.append(row(rec))}
for(const i of ["m","a","g","v","c","h"])$(i).addEventListener("input",()=>{rid=crypto.randomUUID()});
$("go").onclick=async()=>{const r=await send("/approve",{member:$("m").value,action:$("a").value,target:$("g").value,target_sha256:$("v").value||null,count:Number($("c").value),expires_in_hours:Number($("h").value),request_id:rid});if(r&&r.status===200)rid=crypto.randomUUID()};
$("ls").onclick=show;
$("ra").onclick=async()=>{await send("/revoke",{all:true});await show()};
$("fz").onclick=async()=>{await send("/freeze",{on:true});await show()};
$("uf").onclick=async()=>{await send("/freeze",{on:false});await show()};
const list=(v)=>v.split(",").map((x)=>x.trim()).filter(Boolean);
$("pv").onclick=async()=>{const b={version:$("p").value,members:list($("pm").value)};if($("pa").value.trim())b.actions=list($("pa").value);if($("ph").value)b.approval_max_hours=Number($("ph").value);await send("/policy",b);await show()};
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
