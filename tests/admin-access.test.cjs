const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict'), path=require('node:path');
const root=path.join(__dirname,'..'), source=fs.readFileSync(path.join(root,'app.js'),'utf8');
function fn(name){const start=source.indexOf('  function '+name+'(');return source.slice(start,source.indexOf('\n  }',start)+4);}

// A stand-in for the lock overlay that records what the operator would see. The
// point of most of these checks is not that the overlay is hidden, it is that the
// password form is never put on screen for somebody who does not need it.
function makeLock(idle) {
  const p={textContent:idle||'Enter the admin password to continue',attrs:{},
    setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k]==null?null:this.attrs[k];}};
  const box={querySelector:s=>(s==='p'?p:null)};
  const btn={textContent:'Unlock',disabled:false};
  const input={value:'',disabled:false};
  return {style:{display:'flex'},
    querySelector:s=>(s==='.admin-lock-box'?box:(s==='.admin-lock-btn'?btn:null)),
    __p:p,__btn:btn,__input:input};
}

(async()=>{
 const lock=makeLock(), nodes={adminLock:lock}, banners=[];
 const context={console,Date,Promise,setTimeout,clearTimeout,_adminRefresh:null,_verifiedAdminToken:'',_adminUsers:null,
   adminToken:()=> '9999999999.signature',notifyAdminUsersLoaded(){},dbUserToApp:u=>u,
   document:{getElementById:id=>nodes[id]||null,createElement:()=>({setAttribute(){},style:{}}),body:{prepend:b=>banners.push(b)}},
   DB:{_pageTables:()=>['users','balances','loans'],_authUser:null,isAdmin:false,getUserStr:()=>null,getUsers:()=>[],pullBlob:async()=>true}};
 vm.createContext(context);
 for(const name of ['isRealAdmin','hasAdminReadAccess','fetchAdminUsers','setAdminLockState','initAdminLock'])
   vm.runInContext(fn(name),context);
 assert.equal(context.hasAdminReadAccess(),false,'unvalidated token alone grants no access');
 await context.fetchAdminUsers();
 assert.equal(context.hasAdminReadAccess(),true,'verified passphrase can read an empty list');
 assert.equal(lock.style.display,'none');assert.equal(banners.length,0,'empty list must not produce restriction warning');
 context.DB.getUsers=()=>[{uid:'member',account:'member@example.test'}];
 context.DB.pullBlob=async table=>{if(table==='loans')throw Error('offline');return true;};
 const users=await context.fetchAdminUsers();assert.equal(users.length,1);assert.equal(lock.style.display,'none');
 assert.match(banners[0].textContent,/Users loaded/);
 context.adminToken=()=> '1.expired';assert.equal(context.hasAdminReadAccess(),false);
 context.DB._authUser={id:'admin'};context.DB.getUserStr=()=>({is_admin:true});
 assert.equal(context.isRealAdmin(),true,'Supabase admin works without legacy app session');
 assert.equal(context.hasAdminReadAccess(),true,'expired shared token cannot demote account admin');
 const dbContext={console,window:{location:{pathname:'/admin-users.html'},dispatchEvent(){},CustomEvent:function(){}},sessionStorage:{getItem:()=> '1.expired'},setTimeout,clearTimeout};
 vm.createContext(dbContext);vm.runInContext(fs.readFileSync(path.join(root,'scripts/db.js'),'utf8'),dbContext);
 const db=dbContext.DB;db._authUser={id:'admin'};db._session={access_token:'jwt',user:db._authUser};
 db.q=async route=> route.startsWith('users?')?[{id:'admin',is_admin:true}]:[];
 db.rpc=async()=>{throw Error('Expired shared token must not be used for account admin');};
 await db._bootstrap();assert.equal(db.isAdmin,true);assert.equal(db.getUsers()[0].uid,'admin');
 assert.ok(!source.includes('Admin data is hidden:'),'obsolete banner removed');
 const userPage=fs.readFileSync(path.join(root,'admin-users.html'),'utf8');
 assert.ok(!userPage.includes("DB.pullBlob('users').then"),'user update handler cannot restart a load loop');

 // ---- A real account admin is never asked for the shared passphrase ----------
 // The check that decides this used to read only the bulk users cache, which can
 // still be loading, so a real admin read as an ordinary user and was prompted.
 // DB.isAdmin comes from a dedicated self-only query, so it does not depend on it.
 context.DB.isAdmin=true;context.DB._authUser={id:'admin'};context.DB.getUserStr=()=>null;
 assert.equal(context.isRealAdmin(),true,
   'a real admin is recognised from DB.isAdmin even with no cached user row');
 context.DB.isAdmin=false;context.DB._authUser={id:'u'};context.DB.getUserStr=()=>({is_admin:1});
 assert.equal(context.isRealAdmin(),true,'is_admin arriving as 1 must still count as admin');
 context.DB.getUserStr=()=>({is_admin:'t'});
 assert.equal(context.isRealAdmin(),true,"is_admin arriving as 't' must still count as admin");
 context.DB.getUserStr=()=>({is_admin:false});
 assert.equal(context.isRealAdmin(),false,'an ordinary member is not an admin');
 context.DB._authUser=null;
 assert.equal(context.isRealAdmin(),false,'a signed-out visitor is not an admin');

 // ---- The lock, for each kind of caller -------------------------------------
 const tick=()=>new Promise(r=>setTimeout(r,20));
 async function runLock({isAdmin,row,load}) {
   const l=makeLock();const n={adminLock:l,adminPassInput:l.__input,adminLockErr:null};
   const c={console,Date,Promise,setTimeout,clearTimeout,adminToken:()=>'',
     getToken:()=> 'jwt',getUserId:()=> 'someone',accountByUid:()=>row,
     restoreSession:async()=>({}),whenDbReady:async()=>true,
     fetchAdminUsers:load,notifyAdminUsersLoaded(){},isRealAdmin:()=>isAdmin,
     document:{getElementById:id=>n[id]||null,createElement:()=>({setAttribute(){},style:{}}),body:{prepend(){}}}};
   c.DB={_authUser:isAdmin?{id:'a'}:{id:'u'},isAdmin};
   vm.createContext(c);
   for(const name of ['setAdminLockState','initAdminLock']) vm.runInContext(fn(name),c);
   c.initAdminLock(); await tick(); await tick();
   return l;
 }

 // While the answer is still being decided the form is not offered at all: it is
 // disabled and the panel says so, so there is no password prompt to flash up.
 const deciding=makeLock();
 {
   const c={console,Date,Promise,setTimeout,clearTimeout,adminToken:()=>'',
     getToken:()=> 'jwt',getUserId:()=> 'a',accountByUid:()=>null,
     restoreSession:()=>new Promise(()=>{}),whenDbReady:()=>new Promise(()=>{}),
     fetchAdminUsers:async()=>[],notifyAdminUsersLoaded(){},isRealAdmin:()=>true,
     document:{getElementById:id=>({adminLock:deciding,adminPassInput:deciding.__input,adminLockErr:null}[id]||null),createElement:()=>({setAttribute(){},style:{}}),body:{prepend(){}}}};
   c.DB={_authUser:{id:'a'},isAdmin:true};vm.createContext(c);
   for(const name of ['setAdminLockState','initAdminLock']) vm.runInContext(fn(name),c);
   c.initAdminLock(); await tick();
   assert.equal(deciding.__input.disabled,true,'the password field is disabled while access is being checked');
   assert.equal(deciding.__btn.disabled,true,'unlock is unavailable while the answer is unknown');
   assert.match(deciding.__p.textContent,/Checking access/i,'the panel says it is checking, not asking for a password');
   assert.equal(deciding.__p.getAttribute('data-idle'),'Enter the admin password to continue',
     'the real prompt is kept so it can be restored if a passphrase is needed');
 }

 let l=await runLock({isAdmin:true,row:{uid:'a',is_admin:true},load:async()=>[{uid:'a'}]});
 assert.equal(l.style.display,'none','a real account admin sees the panel, not a password prompt');
 assert.equal(l.__input.disabled,true,'a real admin is never handed a password field');

 // A real admin whose user list fails to refresh used to be locked out, because
 // any failure raised the lock. Being entitled to the page cannot depend on a
 // read succeeding.
 l=await runLock({isAdmin:true,row:{uid:'a',is_admin:true},load:async()=>{throw Error('network down');}});
 assert.equal(l.style.display,'none','a failed data refresh must not lock out a real account admin');
 assert.equal(l.__input.disabled,true,'and still no password field is offered');

 // A member with no admin standing is asked, and the form is live.
 l=await runLock({isAdmin:false,row:{uid:'u',is_admin:false},load:async()=>[]});
 assert.equal(l.style.display,'flex','someone without admin access is stopped at the lock');
 assert.equal(l.__input.disabled,false,'the password field is enabled when it is genuinely needed');
 assert.equal(l.__p.textContent,'Enter the admin password to continue','the prompt is restored, not left saying checking');

 // ---- Rotating the admin password ------------------------------------------
 const pwCtx={console,Promise,setAdminToken:t=>{pwCtx.__token=t;},adminToken:()=> 'old.token',
   clearAdminUsers:()=>{pwCtx.__cleared=true;},notifyAdminUsersLoaded(){},
   _verifiedAdminToken:'old.token'};
 pwCtx.__token=null;pwCtx.__cleared=false;
 pwCtx.DB={rpc:async(n,a)=>{pwCtx.__call={n,a};return pwCtx.__reply;}};
 vm.createContext(pwCtx);
 vm.runInContext(fn('adminPassphraseErrorText'),pwCtx);
 vm.runInContext(fn('changeAdminPassword'),pwCtx);
 const settings=fs.readFileSync(path.join(root,'admin-settings.html'),'utf8');

 // The old behaviour refused and told the operator to paste an UPDATE into the
 // Supabase SQL editor, which put a credential into a query box.
 assert.ok(!source.includes('cannot be changed from here'),
   'the banner telling the operator to edit SQL by hand is gone');
 assert.match(source,/admin_set_passphrase/,'the rotation goes through the database');

 pwCtx.__reply='4000.freshsignature';
 let res=await pwCtx.changeAdminPassword('oldpassword','newpassword1');
 assert.equal(res.ok,true,'a correct current password rotates the passphrase');
 assert.equal(pwCtx.__call.n,'admin_set_passphrase');
 assert.equal(pwCtx.__call.a.p_current,'oldpassword','the current password is sent to be checked');
 assert.equal(pwCtx.__call.a.p_new,'newpassword1');
 assert.equal(pwCtx.__call.a.p_tok,'old.token','a passphrase-only operator proves authority with their token');
 assert.equal(pwCtx.__token,'4000.freshsignature',
   'the token from the rotation is stored, so the operator stays signed in after the signing key rotated');
 assert.equal(pwCtx.__cleared,true,'the list cached under the old session is dropped');
 assert.equal(pwCtx._verifiedAdminToken,'','the verified token is cleared so it is re-read under the new key');

 pwCtx.__reply=null;pwCtx.__token=null;
 res=await pwCtx.changeAdminPassword('wrong','newpassword1');
 assert.equal(res.ok,false,'a wrong current password does not rotate');
 assert.match(res.msg,/current admin password is not correct/i);
 assert.equal(pwCtx.__token,null,'a failed rotation must not disturb the existing session');

 pwCtx.__call=null;
 assert.equal((await pwCtx.changeAdminPassword('old','short')).ok,false,'a short new password is refused');
 assert.equal((await pwCtx.changeAdminPassword('','newpassword1')).ok,false,'a missing current password is refused');
 assert.equal((await pwCtx.changeAdminPassword('old','')).ok,false,'a missing new password is refused');
 assert.equal((await pwCtx.changeAdminPassword('samepassword1','samepassword1')).ok,false,'reusing the password is refused');
 assert.equal(pwCtx.__call,null,'none of those reached the database');

 // PostgREST hands a failed function back as a JSON envelope; dumping that at an
 // operator is not an explanation.
 assert.match(pwCtx.adminPassphraseErrorText(new Error('{"code":"42501","message":"admin sign-in required"}')),
   /sign in as an admin/i,'the real message is pulled out of the envelope');
 assert.equal(pwCtx.adminPassphraseErrorText(new Error('something else entirely')),'something else entirely',
   'an unrecognised error is still shown rather than swallowed');

 // The page must wait for the write, and must not fire it twice.
 assert.match(settings,/changeAdminPassword\(cur, nw\)\.then\(/,'the settings page awaits the rotation');
 assert.match(settings,/if \(saveBtn\.disabled\) return;/,'the button cannot be double-submitted');
 assert.match(settings,/at least 8 characters/,'the page states the real minimum');

 // ---- Migration 23 ------------------------------------------------------------
 const sql=fs.readFileSync(path.join(root,'supabase','v2','23_admin_password_rotation.sql'),'utf8');
 const sqlCode=sql.replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(l=>l.replace(/--.*$/,'')).join('\n');
 assert.match(sqlCode,/create or replace function public\.admin_set_passphrase\(/);
 // The current password is always required, whoever the caller is: a stolen
 // session must not be able to take the panel over permanently.
 const body=sqlCode.split('create or replace function public.admin_set_passphrase')[1].split('\nend $$')[0];
 const at=re=>{const i=body.search(re);assert.notEqual(i,-1,'missing: '+re);return i;};
 // A stolen session must not be able to take the panel over permanently by
 // setting a password it now knows, so authority is settled before the current
 // password is even looked at. Ordering is the property; whitespace is not.
 assert.ok(at(/if not token_ok then[\s\S]{0,60}raise exception 'admin sign-in required'/) <
   at(/crypt\(p_current, stored_hash\)/),
   'the caller is authorised before the current password is checked');
 assert.ok(at(/crypt\(p_current, stored_hash\)/) < at(/update public\.admin_credentials/),
   'the current password is verified before anything is written');
 assert.ok(at(/update public\.admin_credentials/) < at(/return tok_exp \|\| '\.' \|\| tok_sig/),
   'the new token is signed after the new secret is stored, not before');
 // Every path that writes must have passed the password check first.
 assert.equal((body.match(/update public\.admin_credentials/g)||[]).length,1,
   'exactly one write, so there is no second route around the password check');
 // Rotating the signing key is what signs other tabs out, and is why a new token
 // comes back.
 assert.match(sqlCode,/token_secret\s*=\s*new_secret/,'the signing key rotates with the password');
 assert.match(sqlCode,/set passphrase_hash = 'bf\$' \|\| crypt\(p_new, gen_salt\('bf'\)\)/,
   'the new password is stored as salted bcrypt, not a bare sha256');
 // An existing install still holds a bare sha256 hash; it must keep working.
 assert.match(sqlCode,/left\(stored_hash, 3\) = 'bf\$' then[\s\S]*?encode\(digest\(pass, 'sha256'\), 'hex'\) = stored_hash/,
   'admin_login accepts both the legacy hash and bcrypt, so nothing is locked out');
 assert.ok(!/revoke execute[^;]*from (anon|authenticated)/.test(sqlCode),'no call is left unreachable');
 assert.match(sqlCode,/revoke all on function public\.admin_set_passphrase\(text, text, text\) from public;/,
   'no blanket execute survives');
 // The table itself still cannot be written from the client.
 assert.match(sqlCode,/revoke insert, update, delete on public\.admin_credentials from anon, authenticated/);

 console.log('PASS: verified admin access, empty result, partial failure, session fallback, expired-token priority, ' +
   'a real account admin never asked for the passphrase, a failed refresh not locking out an admin, ' +
   'rotating the admin password from the panel, and legacy and bcrypt hashes both accepted');
})().catch(e=>{console.error(e);process.exitCode=1;});
