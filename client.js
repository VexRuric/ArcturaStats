/* ---- hosted storage and accounts ---- */
var me=null,claims={},adminData=null,adminLoading=false,loginOpen=false,authMsg='',docCache={},lastSig='',bootArm=false,discordOn=true,claimMsg='',lgUserVal='';
function api(method,url,body){
  return fetch(url,{method:method,credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}).then(function(r){
    return r.json().catch(function(){return {}}).then(function(j){if(!r.ok){var e=new Error(j.error||'error');e.code=j.error||('http'+r.status);throw e}return j})})
}
db={collection:function(c){return {doc:function(id){return {
  set:function(d){return api('PUT','/api/doc?c='+c+'&id='+encodeURIComponent(id),d).then(function(){return refresh(true)})},
  delete:function(){return api('DELETE','/api/doc?c='+c+'&id='+encodeURIComponent(id)).then(function(){return refresh(true)})}}}}}};
function fetchDoc(kind,it){
  var key=kind+':'+it.id+':'+it.v;if(docCache[key])return Promise.resolve(docCache[key]);
  return fetch(it.url+(it.url.indexOf('?')<0?'?':'&')+'v='+it.v).then(function(r){if(!r.ok)throw new Error('doc');return r.json()}).then(function(d){docCache[key]=d;return d});
}
function refresh(force){
  return api('GET','/api/index').then(function(ix){
    me=ix.me&&ix.me.role?ix.me:null;claims=ix.claims||{};discordOn=!!ix.discord;
    var was=canEdit;canEdit=!!(me&&me.role==='admin');canWrite=canEdit;if(canEdit!==was)adminData=null;
    var sig=JSON.stringify([ix.matches.map(function(x){return x.id+x.v}),ix.snapshots.map(function(x){return x.id+x.v}),claims,me]);
    if(!force&&sig===lastSig&&loaded)return;
    return Promise.all([Promise.all(ix.matches.map(function(it){return fetchDoc('m',it).then(function(d){return [it.id,d]},function(){return null})})),Promise.all(ix.snapshots.map(function(it){return fetchDoc('s',it).then(function(d){return [it.id,d]},function(){return null})}))]).then(function(r){
      remote={};snaps={};r[0].forEach(function(p){if(p)remote[p[0]]=p[1]});r[1].forEach(function(p){if(p)snaps[p[0]]=p[1]});
      lastSig=sig;loaded=true;dbState='ok';renderAuth();render()})
  }).catch(function(){if(!loaded){dbState='off';render()}})
}
function avatarImg(u){return u&&u.avatar?'<img alt="" src="'+esc(u.avatar)+'" style="width:22px;height:22px;border-radius:50%;vertical-align:middle;margin-right:6px">':''}
var AUTHERR={not_configured:'Discord login is not set up yet.',cancelled:'Discord login was cancelled.',state:'Login expired, try again.',discord:'Discord did not accept the login, try again.'};
function renderAuth(){
  var el=document.getElementById('authbar');if(!el)return;var h='';
  if(me){
    h+='<span class="who">'+avatarImg(me)+esc(me.name)+(me.role==='admin'?' <span class="tag ok">Admin</span>':'')+'</span>';
    if(me.claim)h+='<a class="plink" href="#player-'+slug(me.claim)+'">My player</a>';
    if(me.via==='bootstrap'&&discordOn)h+='<a class="btn" href="/auth/discord?promote=1" style="text-decoration:none">Make my Discord an admin</a>';
    h+='<button class="btn ghost" type="button" data-auth="logout">Log out</button>';
  }else{
    h+='<button class="btn" type="button" data-auth="open" aria-expanded="'+loginOpen+'">Log in</button>';
    if(loginOpen){
      h+='<div class="lgpanel" role="dialog" aria-label="Log in">'+(discordOn?'<a class="btn" href="/auth/discord" style="text-decoration:none;display:block;text-align:center">Log in with Discord</a>':'<p class="note" style="margin:0">Discord login is not set up yet.</p>')+
        '<details'+(authMsg&&authMsg.indexOf('Admin')===0?' open':'')+'><summary>Admin account</summary><form id="lgForm" autocomplete="off"><label for="lgUser">Username</label><input id="lgUser" name="user" type="text" autocomplete="username" value="'+esc(lgUserVal)+'"><label for="lgPass">Password</label><input id="lgPass" name="pass" type="password" autocomplete="current-password"><button class="btn" type="submit">Log in</button></form></details>';
      if(authMsg)h+='<p class="note err" style="margin:0" role="alert">'+esc(authMsg)+'</p>';
      h+='</div>';
    }
  }
  el.innerHTML=h;
}
function claimBlock(name){
  if(isBot(name))return '';
  var c=claims[name],h='<div class="panel" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">';
  if(c){h+='<span class="tag ok">Claimed</span><span>'+avatarImg(c)+esc(c.name)+'</span>';if(canEdit)h+='<button class="btn ghost" type="button" data-aop="release:'+esc(name)+'">Release</button>'}
  else if(me&&me.via==='discord'&&me.claim){h+='<span class="note" style="margin:0">Unclaimed. Your Discord account already owns <a class="plink" href="#player-'+slug(me.claim)+'">'+esc(me.claim)+'</a>, one player per account.</span>'}
  else if(me&&me.via==='discord'){h+='<span class="note" style="margin:0">Is this you? Claim this player with your Discord account. You can claim one player.</span><button class="btn" type="button" data-claim="'+esc(name)+'">This is me</button>'}
  else{h+='<span class="note" style="margin:0">Unclaimed. '+(me?'Log in with a Discord account to claim a player.':'Log in with Discord to claim this player.')+'</span>'}
  if(claimMsg)h+='<span class="note err" role="alert" style="margin:0">'+esc(claimMsg)+'</span>';
  return h+'</div>';
}
function accountsPanel(){
  var h='<div class="panel"><h2>Accounts</h2>';
  if(!adminData)return h+'<p class="note">Loading accounts</p></div>';
  var d=adminData,hasD=d.users.some(function(u){return u.admin});
  h+='<p class="note" style="margin-top:0">People who logged in with Discord. Admins can upload and delete logs, set winners, make snapshots and manage accounts. One Discord account can claim one player.</p>';
  if(!d.users.length)h+='<p class="note">Nobody has logged in with Discord yet.</p>';
  else h+='<div class="scroll"><table><thead><tr><th scope="col">Discord</th><th scope="col">Claimed player</th><th scope="col">Role</th><th scope="col"></th></tr></thead><tbody>'+d.users.map(function(u){
    return '<tr><td>'+avatarImg(u)+esc(u.name)+'</td><td>'+(u.claim?'<a class="plink" href="#player-'+slug(u.claim)+'">'+esc(u.claim)+'</a>':'-')+'</td><td>'+(u.admin?'<span class="tag ok">Admin</span>':'<span class="tag">Player</span>')+'</td><td style="text-align:right;white-space:nowrap">'+
      (u.admin?'<button class="btn ghost" type="button" data-aop="removeAdmin:'+esc(u.id)+'">Remove admin</button>':'<button class="btn" type="button" data-aop="makeAdmin:'+esc(u.id)+'">Make admin</button>')+(u.claim?' <button class="btn ghost" type="button" data-aop="release:'+esc(u.claim)+'">Release claim</button>':'')+'</td></tr>'}).join('')+'</tbody></table></div>';
  h+='<h2 style="margin-top:18px">Bootstrap Admin account</h2>';
  if(!d.bootstrapActive)h+='<p class="note">The bootstrap Admin account has been deleted. Only Discord admins can manage the site.</p>';
  else{
    h+='<p class="note" style="margin-top:0">The username and password account. '+(me&&me.via==='bootstrap'?'Use <b>Make my Discord an admin</b> in the header to link your Discord, then delete this account.':'Delete it once a Discord admin exists. This cannot be undone.')+'</p><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn'+(bootArm?'':' ghost')+'" type="button" data-aop="deleteBootstrap"'+(hasD?'':' disabled')+'>'+(bootArm?'Click again to delete Admin account':'Delete Admin account')+'</button>'+(hasD?'':'<span class="note" style="margin:0;align-self:center">Make a Discord account an admin first.</span>')+'</div>';
  }
  h+='<h2 style="margin-top:18px">Bundled matches</h2><p class="note" style="margin-top:0">Imports the earlier Nov 2 and screenshot test games into the shared store. Matches already saved are skipped.</p><button class="btn ghost" type="button" data-aop="seed">Import bundled matches</button>';
  return h+'</div>';
}
function loadAdmin(){
  if(adminLoading)return;adminLoading=true;
  api('GET','/api/admin').then(function(d){adminData=d;adminLoading=false;render()},function(){adminLoading=false});
}
var ERR={taken:'That player is already claimed.',you_already_claimed:'Your Discord account already owns a player.',unknown_player:'That player is not in any saved match.',login_with_discord:'Log in with Discord first.',last_admin:'That is the last admin. Make another admin first.',make_a_discord_admin_first:'Make a Discord account an admin first.',bad_login:'Admin login failed.',too_many_attempts:'Too many attempts. Wait ten minutes.'};
document.addEventListener('click',function(e){
  var a=e.target.closest('[data-auth]');
  if(a){var k=a.dataset.auth;if(k==='open'){loginOpen=!loginOpen;authMsg='';renderAuth();var u=document.getElementById('lgUser');if(loginOpen&&u)u.focus()}
    if(k==='logout')api('POST','/api/auth?a=logout').then(function(){me=null;canEdit=false;canWrite=false;adminData=null;lastSig='';renderAuth();return refresh(true)});return}
  var cl=e.target.closest('[data-claim]');
  if(cl){claimMsg='';api('POST','/api/claim',{player:cl.dataset.claim}).then(function(){return refresh(true)},function(err){claimMsg=ERR[err.code]||'Could not claim.';render()});return}
  var op=e.target.closest('[data-aop]');
  if(op){
    var raw=op.dataset.aop,i=raw.indexOf(':'),name=i<0?raw:raw.slice(0,i),arg=i<0?'':raw.slice(i+1);
    if(name==='deleteBootstrap'){if(!bootArm){bootArm=true;render();return}bootArm=false}
    else if(bootArm){bootArm=false}
    if(name==='seed'){
      fetch('/seed/manifest.json').then(function(r){return r.json()}).then(function(list){
        return list.reduce(function(p,it){return p.then(function(){if(remote[it.id])return;return fetch('/seed/'+it.file).then(function(r){return r.json()}).then(function(d){return api('PUT','/api/doc?c=matches&id='+encodeURIComponent(it.id),d)})})},Promise.resolve())}).then(function(){return refresh(true)}).catch(function(){claimMsg='Import failed.';render()});return}
    var body=name==='release'?{op:'release',player:arg}:name==='deleteBootstrap'?{op:'deleteBootstrap'}:{op:name,id:arg};
    api('POST','/api/admin',body).then(function(){adminData=null;if(name==='deleteBootstrap'){me=null;canEdit=false;canWrite=false;lastSig=''}return refresh(true)}).then(function(){if(canEdit)loadAdmin()},function(err){authMsg=ERR[err.code]||'Action failed.';claimMsg=authMsg;render()});
  }
});
document.addEventListener('submit',function(e){
  if(e.target.id!=='lgForm')return;e.preventDefault();
  var u=document.getElementById('lgUser').value;lgUserVal=u;var p=document.getElementById('lgPass').value;
  api('POST','/api/auth?a=login',{user:u,pass:p}).then(function(){loginOpen=false;authMsg='';lastSig='';return refresh(true)}).then(function(){renderAuth()},function(err){authMsg='Admin: '+(ERR[err.code]||'Login failed.');renderAuth()});
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&loginOpen){loginOpen=false;renderAuth()}});
render();renderAuth();
(function(){var q=new URLSearchParams(location.search);if(q.get('authError')){authMsg=AUTHERR[q.get('authError')]||'Login failed.';loginOpen=true;history.replaceState(null,'',location.pathname+location.hash)}})();
refresh(true).then(function(){renderAuth()});
setInterval(function(){if(document.visibilityState==='visible')refresh(false)},30000);
