const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict'),path=require('node:path');
const root=path.join(__dirname,'..'),app=fs.readFileSync(path.join(root,'app.js'),'utf8'),userPage=fs.readFileSync(path.join(root,'admin-users.html'),'utf8');
function fn(source,name,indent='  '){const re=new RegExp('^'+indent+'(?:async )?function '+name+'\\(', 'm');const m=re.exec(source);assert.ok(m,name);return source.slice(m.index,source.indexOf('\n'+indent+'}',m.index)+indent.length+2);}
(async()=>{
 // A signed-in Supabase account works before legacy state/table bootstrap.
 const user={id:'user-1'},ctx={console,Promise,_session:null,_restorePromise:null,DB:{ENABLED:true,_uid:()=>user.id,authReady:async()=>true,getSession:async()=>({uid:user.id})},getToken:()=>null,updateMenuUser(){}};
 vm.createContext(ctx);for(const name of ['getUserId','isLoggedIn','restoreSession','ensureGuest'])vm.runInContext(fn(app,name),ctx);
 assert.equal(ctx.getUserId(),'user-1');assert.equal(ctx.isLoggedIn(),true);assert.equal(await ctx.ensureGuest(),'user-1');assert.equal(ctx._session.uid,'user-1');
 ctx.DB._uid=()=>null;ctx.DB.getSession=async()=>null;await assert.rejects(ctx.ensureGuest(),/sign in/);
 // All supported management actions use the server and expose failures.
 let request;ctx.dbActive=()=>true;ctx.adminToken=()=> 'verified-token';ctx.dbUserToApp=u=>({...u,uid:u.id});
 ctx.DB.rpc=async(n,a)=>{request={n,a};return {user:{id:a.p_uid,account:'member@example.test'}}};ctx.DB.pullBlob=async()=>true;
 for(const name of ['manageUser','setUserAdmin','setUserStatus','removeUser','adminApproveKyc','setProfitMode'])vm.runInContext(fn(app,name),ctx);
 for(const [method,value,action] of [['setUserAdmin',true,'role'],['setUserStatus',false,'status'],['removeUser',undefined,'archive'],['adminApproveKyc',undefined,'manual_verify']]){
  const result=await ctx[method]('target',value);assert.equal(result.ok,true);assert.equal(request.a.p_action,action);assert.equal(request.a.tok,'verified-token');
 }
 ctx.DB.rpc=async()=>{throw Error('not authorized')};assert.equal((await ctx.setUserStatus('target',true)).ok,false);assert.equal(ctx.setProfitMode('target',true).ok,false);
 // Fund limits report success only after confirmed server persistence.
 vm.runInContext(fn(app,'saveFundLimits'),ctx);ctx.reloadConfigFromDb=()=>{};
 ctx.DB.rpc=async(n,a)=>{request={n,a};return {}};
 assert.equal((await ctx.saveFundLimits(100,20)).ok,true);assert.equal(request.n,'admin_save_fund_limits');assert.equal(request.a.p_withdrawal,20);
 assert.equal((await ctx.saveFundLimits(-1,20)).ok,false);assert.equal((await ctx.saveFundLimits(NaN,20)).ok,false);
 ctx.DB.rpc=async()=>{throw Error('save rejected')};assert.equal((await ctx.saveFundLimits(100,20)).msg,'save rejected');
 // Execute the actual User Management click handlers with controlled UI/backend.
 const nodes={editModal:{style:{}},editUserInfo:{},editModalBody:{}};let records=[],state={uid:'target',email:'member@gmail.com',account:'member@gmail.com',uid_code:'000042',createdAt:'2026-09-01',status:'active'};
 const ui={console,Promise,document:{getElementById:id=>nodes[id]},userActionBusy:{},editUid:null,
  esc:String,fmtAmt:String,confirm:()=>true,renderUsers(){},toast:(...a)=>records.push(a),
  TrustApp:{getUserId:()=> 'operator',getProfitMode:()=>false,isUserAdmin:()=>false,isUserActive:()=>state.status==='active',accountByUid:()=>state,getBalances:()=>({USDT:75}),getVerification:()=>null,
   adminApproveKyc:async()=>({ok:true}),setUserAdmin:async()=>({ok:true,user:state}),setUserStatus:async()=>({ok:true,user:state}),removeUser:async()=>({ok:true,account:state.account})}};
 vm.createContext(ui);for(const name of ['row','profitCell','openEdit','closeEditModal','refreshEdit','verifyUser','toggleAdmin','toggleStatus','deleteUser'])vm.runInContext(fn(userPage,name,'    '),ui);
 ui.openEdit('target');assert.equal(nodes.editModal.style.display,'flex');assert.match(nodes.editUserInfo.innerHTML,/000042/);assert.match(nodes.editModalBody.innerHTML,/Archive User/);assert.match(nodes.editModalBody.innerHTML,/admin-adjust.html\?u=target/);
 await ui.verifyUser('target');assert.match(records.at(-1)[1],/Manual approval/);
 await ui.toggleAdmin('target');assert.match(records.at(-1)[1],/Granted admin/);
 await ui.toggleStatus('target');assert.match(records.at(-1)[1],/Deactivated/);
 await ui.deleteUser('target');assert.equal(nodes.editModal.style.display,'none');assert.match(records.at(-1)[1],/Archived/);
 ui.openEdit('target');ui.closeEditModal();assert.equal(nodes.editModal.style.display,'none');
 // The actual withdrawal click handler must select its own transaction, not the first row.
 const funds=fs.readFileSync(path.join(root,'admin-funds.html'),'utf8');let balanceUid,approved;
 const fc={window:{},TrustApp:{getTxns:()=>[{id:'wrong',uid:'other',coin:'USDT',amount:99},{id:'right',uid:'selected',coin:'USDT',amount:10}],getBalance:u=>{balanceUid=u;return 20},setTxnStatus:async(id,status)=>{approved=[id,status]}},toast(){},renderAll(){},fmtAmt:String};
 vm.createContext(fc);vm.runInContext(fn(funds,'setWd','    '),fc);await fc.setWd({closest:()=>({getAttribute:()=> 'right'})},'confirmed');assert.equal(balanceUid,'selected');assert.deepEqual(approved,['right','confirmed']);
 assert.ok(!funds.includes('Ã'),'marked corrupted amount section removed');
 // Repeated unchanged loads cannot trigger redraw storms.
 const dc={console,setTimeout,clearTimeout,window:{location:{pathname:'/account.html'},CustomEvent:function(t){this.type=t},dispatchEvent(){}},sessionStorage:{getItem:()=>''}};
 vm.createContext(dc);vm.runInContext(fs.readFileSync(path.join(root,'scripts/db.js'),'utf8'),dc);const db=dc.DB;let updates=0;
 db.q=async()=>[{uid:'user-1',coin:'USDT',amount:'20'}];db._dispatchTrustSync=()=>updates++;
 await db.pullBlob('balances');await db.pullBlob('balances');assert.equal(updates,1);
 assert.deepEqual(Array.from(db._pageTables()),['users','balances']);
 console.log('PASS: delayed login restore, user/admin chat identity, management buttons and errors, matching withdrawal record, clean amount text, unchanged-data redraw suppression');
})().catch(e=>{console.error(e);process.exitCode=1;});
