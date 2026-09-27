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
 for(const name of ['manageUser','setUserAdmin','setUserStatus','removeUser','adminApproveKyc'])vm.runInContext(fn(app,name),ctx);
 for(const [method,value,action] of [['setUserAdmin',true,'role'],['setUserStatus',false,'status'],['removeUser',undefined,'archive'],['adminApproveKyc',undefined,'manual_verify']]){
  const result=await ctx[method]('target',value);assert.equal(result.ok,true);assert.equal(request.a.p_action,action);assert.equal(request.a.tok,'verified-token');
 }
 ctx.DB.rpc=async()=>{throw Error('not authorized')};assert.equal((await ctx.setUserStatus('target',true)).ok,false);
 // Profit Mode is a server-side admin switch: it goes through the audited RPC
 // for one account and for every account, and a rejection is reported, not faked.
 ctx.DB.rpc=async(n,a)=>{request={n,a};return {ok:true}};
 ctx.DB.setUserProfitMode=async(uid,on)=>{request={n:'admin_set_profit_mode',a:{uid,on}};return {uid,on}};
 vm.runInContext(fn(app,'setProfitMode'),ctx);
 assert.equal((await ctx.setProfitMode('target',true)).ok,true);assert.equal(request.n,'admin_set_profit_mode');assert.deepEqual(request.a,{uid:'target',on:true});
 assert.equal((await ctx.setProfitMode(null,true)).global,true);assert.deepEqual(request.a,{uid:null,on:true});
 ctx.DB.setUserProfitMode=async()=>{throw Error('not authorized')};
 assert.equal((await ctx.setProfitMode('target',true)).ok,false);
 // Trade money moves through open_trade / settle_trade, never a browser write.
 ctx.DB.openTrade=async(d)=>({id:'c-1',payout_pct:185,entry_price:100,balance:40});
 ctx.DB.settleTrade=async(id,px)=>({id,status:'won',amount:100,payout:285,profit:185,balance:325,payout_pct:185,settle_price:px});
 ctx.DB.pullBlob=async()=>true;
 vm.runInContext(fn(app,'marketSymbol'),ctx);vm.runInContext(fn(app,'openTrade'),ctx);vm.runInContext(fn(app,'settleTrade'),ctx);
 ctx.getUserId=()=>'user-1';ctx._notifyChange=()=>{};ctx._tradeIdMap={};
 const opened=await ctx.openTrade({pair:'BTC/USDT',side:'up',amount:100,price:100,duration:60});
 // A whole pair must reduce to its base: the home page links with ?s=ETH%2FUSDT,
 // and sending the pair through reached the server as "ETHUSDT".
 await ctx.openTrade({pair:'ETH/USDT',symbol:'ETH/USDT',side:'up',amount:50,price:10,duration:60});
 assert.equal(ctx.marketSymbol('ETH/USDT'),'ETH');assert.equal(ctx.marketSymbol('BTC'),'BTC');
 assert.equal(opened.id,'c-1');
 const settled=await ctx.settleTrade('c-1',101);
 assert.equal(settled.profit,185);assert.equal(settled.balance,325);
 ctx.DB.settleTrade=async()=>{throw Error('insufficient balance')};
 await assert.rejects(ctx.settleTrade('c-1',101),/insufficient/);
 // Fund limits report success only after confirmed server persistence.
 vm.runInContext(fn(app,'saveFundLimits'),ctx);ctx.reloadConfigFromDb=()=>{};
 ctx.DB.rpc=async(n,a)=>{request={n,a};return {}};
 assert.equal((await ctx.saveFundLimits(100,20)).ok,true);assert.equal(request.n,'admin_save_fund_limits');assert.equal(request.a.p_withdrawal,20);
 assert.equal((await ctx.saveFundLimits(-1,20)).ok,false);assert.equal((await ctx.saveFundLimits(NaN,20)).ok,false);
 ctx.DB.rpc=async()=>{throw Error('save rejected')};assert.equal((await ctx.saveFundLimits(100,20)).msg,'save rejected');
 // Execute the actual User Management click handlers with controlled UI/backend.
 const nodes={editModal:{style:{}},editUserInfo:{},editModalBody:{}};let records=[],state={uid:'target',email:'member@gmail.com',account:'member@gmail.com',uid_code:'000042',createdAt:'2026-09-01',status:'active'};
 let ownProfit={target:false};
 const ui={console,Promise,document:{getElementById:id=>nodes[id]||{textContent:'',className:'',style:{},disabled:false}},userActionBusy:{},editUid:null,globalProfitOn:false,
  esc:String,fmtAmt:String,confirm:()=>true,renderUsers(){},renderStats(){},renderProfitPanel(){},toast:(...a)=>records.push(a),
  TrustApp:{getUserId:()=> 'operator',getProfitMode:u=>ownProfit[u]||ui.globalProfitOn,getOwnProfitMode:u=>ownProfit[u]||false,
   isGlobalProfitMode:()=>ui.globalProfitOn,setProfitMode:async(u,on)=>{if(u==null)ui.globalProfitOn=on;else ownProfit[u]=on;return {ok:true,uid:u,global:u==null,on}},
   isUserAdmin:()=>false,isUserActive:()=>state.status==='active',accountByUid:()=>state,getBalances:()=>({USDT:75}),getVerification:()=>null,
   adminApproveKyc:async()=>({ok:true}),setUserAdmin:async()=>({ok:true,user:state}),setUserStatus:async()=>({ok:true,user:state}),removeUser:async()=>({ok:true,account:state.account})}};
 vm.createContext(ui);for(const name of ['row','ownProfitOn','isProfitOn','profitCell','toggleProfit','toggleProfitAll','openEdit','closeEditModal','refreshEdit','verifyUser','toggleAdmin','toggleStatus','deleteUser'])vm.runInContext(fn(userPage,name,'    '),ui);
 ui.openEdit('target');assert.equal(nodes.editModal.style.display,'flex');assert.match(nodes.editUserInfo.innerHTML,/000042/);assert.match(nodes.editModalBody.innerHTML,/Archive User/);assert.match(nodes.editModalBody.innerHTML,/admin-adjust.html\?u=target/);
 // The Profit Mode row is a live toggle, and it says which scope is in force.
 assert.match(nodes.editModalBody.innerHTML,/Profit Mode/);
 assert.match(ui.profitCell(state),/profit-toggle off/);
 await ui.toggleProfit('target');assert.equal(ownProfit.target,true);assert.match(records.at(-1)[1],/Profit Mode ON/);
 assert.match(ui.profitCell(state),/profit-toggle on/);
 await ui.toggleProfit('target');assert.equal(ownProfit.target,false);
 await ui.toggleProfitAll();assert.equal(ui.globalProfitOn,true);assert.match(records.at(-1)[1],/every trade by every user/);
 assert.match(ui.profitCell(state),/profit-toggle on/);   // covered by the global switch
 await ui.toggleProfitAll();assert.equal(ui.globalProfitOn,false);assert.match(ui.profitCell(state),/profit-toggle off/);
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
