const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict'), path=require('node:path');
const root=path.join(__dirname,'..'), source=fs.readFileSync(path.join(root,'app.js'),'utf8');
function fn(name){const start=source.indexOf('  function '+name+'(');return source.slice(start,source.indexOf('\n  }',start)+4);}
(async()=>{
 const lock={style:{}}, nodes={adminLock:lock}, banners=[];
 const context={console,Date,Promise,_adminRefresh:null,_verifiedAdminToken:'',_adminUsers:null,
   adminToken:()=> '9999999999.signature',notifyAdminUsersLoaded(){},dbUserToApp:u=>u,
   document:{getElementById:id=>nodes[id]||null,createElement:()=>({setAttribute(){},style:{}}),body:{prepend:b=>banners.push(b)}},
   DB:{_authUser:null,getUserStr:()=>null,getUsers:()=>[],pullBlob:async()=>true}};
 vm.createContext(context);
 for(const name of ['isRealAdmin','hasAdminReadAccess','fetchAdminUsers'])vm.runInContext(fn(name),context);
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
 console.log('PASS: verified admin access, empty result, partial failure, session fallback, expired-token priority, removed warning and refresh loop');
})().catch(e=>{console.error(e);process.exitCode=1;});
