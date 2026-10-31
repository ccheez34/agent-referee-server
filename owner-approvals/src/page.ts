// The owner's one-page form (his phone). No outside scripts, styles or fonts; the token is never stored by the page.
export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Owner approvals</title><style>
:root{color-scheme:light dark}body{font:16px/1.4 system-ui,sans-serif;max-width:34rem;margin:1rem auto;padding:0 1rem}
label{display:block;margin:.6rem 0 .2rem}input,select,button,textarea{font:inherit;width:100%;box-sizing:border-box;padding:.5rem}
button{margin-top:1rem}pre{white-space:pre-wrap;word-break:break-all;font-size:13px}fieldset{margin-top:1rem}
</style></head><body><h1>Owner approvals</h1>
<p>Approve one exact action for a limited time. Every gate checks this record. Never type your token anywhere else.</p>
<label>Your owner token<input id="t" type="password" autocomplete="off"></label>
<fieldset><legend>Approve</legend>
<label>Action<select id="a"><option>deploy</option><option>payment</option><option>delete</option><option>secret</option><option>install</option><option>rule_change</option></select></label>
<label>Target, in words<input id="g" maxlength="200" placeholder="agent-referee-server production"></label>
<label>Exact thing<select id="k"><option value="commit">commit (40 hex)</option><option value="sha256">file sha256 (64 hex)</option><option value="name">setting or secret name</option></select></label>
<input id="v" maxlength="100">
<label>Uses (1-20)<input id="u" type="number" min="1" max="20" value="1"></label>
<label>Expires in hours (0.25-24)<input id="h" type="number" min="0.25" max="24" step="0.25" value="2"></label>
<label>Note (optional)<input id="n" maxlength="200"></label>
<button id="go">Sign this approval</button></fieldset>
<fieldset><legend>Revoke</legend><label>Nonce of the approval<input id="r" maxlength="32"></label><button id="rv">Revoke it</button></fieldset>
<fieldset><legend>Rules version</legend><label>sha256 of the RULES.md in force<input id="p" maxlength="64"></label><button id="pv">Set it</button></fieldset>
<pre id="out"></pre>
<script>
const $=(i)=>document.getElementById(i);
async function send(path,body){$("out").textContent="...";try{const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+$("t").value},body:JSON.stringify(body)});$("out").textContent=r.status+"\\n"+JSON.stringify(await r.json(),null,2)}catch(e){$("out").textContent=String(e)}}
$("go").onclick=()=>send("/approve",{action:$("a").value,target:$("g").value,target_ref:{[$("k").value]:$("v").value},uses:Number($("u").value),expires_in_hours:Number($("h").value),...($("n").value?{note:$("n").value}:{})});
$("rv").onclick=()=>send("/revoke",{nonce:$("r").value});
$("pv").onclick=()=>send("/policy",{sha256:$("p").value});
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
