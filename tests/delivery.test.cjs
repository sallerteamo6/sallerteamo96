const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.join(__dirname,'..'), app=fs.readFileSync(path.join(root,'app.js'),'utf8');
function fn(name){let a=app.indexOf('  function '+name+'(');if(a<0)a=app.indexOf('  async function '+name+'(');assert.ok(a>=0,name);return app.slice(a,app.indexOf('\n  }',a)+4);}
(async()=>{
 const events=[],ctx={console,setTimeout,clearTimeout,window:{location:{pathname:'/funds.html'},dispatchEvent:e=>events.push(e.type),CustomEvent:function(type){this.type=type;}},sessionStorage:{getItem:()=>''}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'scripts/db.js'),'utf8'),ctx);const db=ctx.DB;
 db._authUser={id:'customer'};let request;
 db.q=async(p,o)=>{request={p,o};return [{id:5,...o.body}];};
 const txn=await db.addTransaction({type:'withdraw',coin:'USDT',amount:75,note:'Withdrawal',request_details:{address:'full-wallet-address'}});
 assert.equal(request.o.body.type,'withdrawal');assert.equal(request.o.body.status,'pending');assert.equal(request.o.body.request_details.address,'full-wallet-address');assert.equal(txn.uid,'customer');
 let args;db.rpc=async(n,a)=>{args={n,a};return {uid:'customer',full_name:a.p_name,id_front_url:a.p_front,status:'pending'};};
 await db.submitVerification('customer',{name:'Test Person',idNumber:'TEST',idFront:'front-image',idBack:'back-image'});
 assert.equal(args.n,'customer_submit_kyc');assert.equal(args.a.p_front,'front-image');assert.equal(db.getVerification('customer').full_name,'Test Person');
 // Chat aliases query and populate the canonical cache; incoming updates render immediately.
 db.q=async p=>{assert.ok(p.startsWith('chat_messages?'));return [{id:10,uid:'customer',body:'Hello',from_role:'user'}];};
 await db.pullBlob('chat');assert.equal(db.getChat('customer')[0].message,'Hello');
 db._handleRealtime('chat_messages',{eventType:'INSERT',new:{id:11,uid:'customer',body:'Reply',from_role:'admin'},old:{}});
 assert.equal(db.getChat('customer').length,2);assert.ok(events.includes('trustsync:chat_messages'));
 db._handleRealtime('chat_messages',{eventType:'DELETE',new:{},old:{id:11,uid:'customer'}});assert.equal(db.getChat('customer').length,1);
 // Operator reply uses the authenticated support RPC, even without a customer login.
 ctx.window.location.pathname='/admin-chat.html';ctx.sessionStorage.getItem=()=> '9999999999.token';db._authUser=null;
 db.rpc=async(n,a)=>{args={n,a};return {id:12,uid:a.p_uid,body:a.p_body,from_role:'admin'};};
 await db.sendChatMessage('customer','admin','Support reply',{attachments:[]});assert.equal(args.n,'admin_support_send');assert.equal(db.getChat('customer').at(-1).from_role,'admin');
 // Concurrent reads share one request and failed writes reject, never report success.
 let resolve,reads=0;db.isAdmin=true;db.q=()=>{reads++;return new Promise(r=>resolve=r)};
 const one=db.pullBlob('loans'),two=db.pullBlob('loans');assert.equal(one,two);resolve([]);await one;assert.equal(reads,1);
 const a={console,Promise,dbActive:()=>true,DB:{addTransaction:()=>Promise.reject(Error('network down'))},_notifyChange(){},dbTxnToApp:x=>x};vm.createContext(a);vm.runInContext(fn('addTxn'),a);
 await assert.rejects(a.addTxn({type:'deposit',amount:10}),/network down/);
 const writes=[];a.DB={setTransactionStatus:async(id,status)=>writes.push([id,status]),pullBlob:async()=>true};vm.runInContext(fn('setTxnStatus'),a);
 await a.setTxnStatus(5,'confirmed');assert.deepEqual(writes,[[5,'approved']]);assert.ok(!fn('setTxnStatus').includes('addBalance'),'server is sole balance writer');
 const values={},language={LANGS:{English:'en','Español':'es','Français':'fr'},_lang:null,_session:null,getConfig:()=>({defaultLanguage:'en'}),localStorage:{getItem:k=>values[k],setItem:(k,v)=>values[k]=v},dbActive:()=>false,applyI18n(){},document:{getElementById:()=>null},window:{dispatchEvent(){}},CustomEvent:function(){}};
 vm.createContext(language);for(const n of ['langLabel','getLang','setLang'])vm.runInContext(fn(n),language);
 language.setLang(null,'es');assert.equal(language.getLang(),'Español');language._lang=null;assert.equal(language.getLang(),'Español');assert.equal(language.langLabel('fr'),'Français');
 console.log('PASS: withdrawal enum/destination, KYC fields, chat aliases/push/delete, admin reply, deduplicated reads, rejected writes, single balance write, saved language');
})().catch(e=>{console.error(e);process.exitCode=1;});
