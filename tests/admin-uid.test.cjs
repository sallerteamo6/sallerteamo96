const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function functionSource(name) {
 const start = app.indexOf('  function ' + name + '(');
 const end = app.indexOf('\n  }', start) + 4;
 return app.slice(start, end);
}
(async () => {
 const context = {console, window:{location:{pathname:'/admin-users.html'},dispatchEvent(){},CustomEvent:function(){}}, sessionStorage:{getItem:()=> 'valid-token'}, setTimeout, clearTimeout};
 vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(root, 'scripts/db.js'), 'utf8'), context);
 const db = context.DB;
 vm.runInContext(functionSource('dbUserToApp'), context);
 assert.equal(context.dbUserToApp({id:'user-uuid',uid_code:'000042'}).uid,'user-uuid');
 assert.equal(context.dbUserToApp({uid:'legacy-uuid'}).uid,'legacy-uuid');
 let calls = [];
 db.rpc = async (name,args) => {calls.push([name,args]);return args.table_name==='users' ? [{id:'user-uuid',account:'member@example.test',uid_code:'000042'}] : [{uid:'user-uuid',coin:'USDT',amount:'123.45'}];};
 await db.pullBlob('users'); await db.pullBlob('balances');
 assert.equal(db.getUsers()[0].uid,'user-uuid');
 assert.equal(db.getAllBalances('user-uuid').USDT,123.45);
 assert.equal(calls[0][1].tok,'valid-token');
 // Passphrase RPC paginates rather than truncating the member list.
 db.rpc = async (_,a)=> a.row_offset===0 ? Array.from({length:500},(_,i)=>({id:'u'+i})) : [{id:'u500'}];
 await db.pullBlob('users'); assert.equal(db.getUsers().length,501);
 // A normal member page uses JWT/RLS reads even if this tab has an admin token.
 context.window.location.pathname='/account.html'; let normalReads=0;
 db.q = async()=> {normalReads++;return [{id:'own-user'}];};
 db.rpc = async()=> {throw new Error('must not use admin RPC on member page');};
 await db.pullBlob('users'); assert.equal(normalReads,1);
 assert.equal(db.getUsers().length,1);
 db._loadTable=async()=>0; db._markConnected=()=>{};
 assert.equal(await db._bootstrap(),true);
 // Menu preserves leading zeroes and updates safely with textContent.
 const idEl={style:{}};
 context.document={querySelector:s=>s==='.menu-id'?idEl:null,getElementById:()=>null};
 context.getUserId=()=> 'user-uuid';context.accountByUid=()=>({uid_code:'000042'});
 vm.runInContext(functionSource('updateMenuUser'),context);
 context.updateMenuUser(); assert.equal(idEl.textContent,'ID: 000042');
 context.accountByUid=()=>null;context.updateMenuUser();assert.equal(idEl.textContent,'ID: user-uuid');
 context.getUserId=()=>null;context.updateMenuUser();assert.equal(idEl.textContent,'ID: Not Logged In');
 console.log('PASS: UUID mapping, related balances, admin paging, member RLS route, ready result, UID/menu states');
})().catch(e=>{console.error(e);process.exitCode=1;});
