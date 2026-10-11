// Tests the number logic in finance-sync.gs with the spreadsheet calls stubbed. Run: node tests/finance-sync.test.js
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const eq=(a,b)=>require("assert").strictEqual(JSON.stringify(a),JSON.stringify(b));
const ctx={Utilities:{formatDate:(d)=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')},console};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require('path').join(__dirname,'../apps-script/finance-sync.gs'),'utf8')+';this.pairTransfers_=pairTransfers_;this.buildSummary_=buildSummary_;',ctx);
const now=new Date(); const d=(n)=>new Date(now.getFullYear(),now.getMonth(),1+n,12);
const row=(date,acc,amt,cat,cur='NZD',nzd)=>[date,acc,'','',amt,'','',cat,'id',cur,nzd===undefined?amt:nzd];
// pairing
let rows=[
  row(d(0),'BNZ',-500,'Uncategorised'),   // top-up out
  row(d(1),'Wise NZD',500,'Uncategorised'),// top-up in -> pair
  row(d(0),'BNZ',-80,'Groceries'),
  row(d(20),'Wise NZD',80,'Uncategorised'),// too far apart -> no pair
  row(d(2),'BNZ',-300,'Rent'),
  row(d(2),'Wise NZD',300,'Income'),        // income never paired
  row(d(3),'BNZ',-200,'Credit card payment'),
  row(d(3),'Visa',200,'Uncategorised'),     // gets CC payment
  row(d(4),'BNZ',-50,'Food'),
  row(d(4),'BNZ',50,'Uncategorised'),       // same account -> no pair
];
const c=ctx.pairTransfers_(rows).map(x=>x[0]);
eq(c,['Transfer','Transfer','Groceries','Uncategorised','Rent','Income','Credit card payment','Credit card payment','Food','Uncategorised']);
// summary
const tx=[
  row(d(0),'BNZ',-100,'Groceries'),
  row(d(1),'BNZ',30,'Groceries'),           // refund
  row(d(2),'BNZ',1000,'Uncategorised'),     // income
  row(d(2),'BNZ',2000,'Income: freelance'),
  row(d(3),'Wise USD',-50,'Travel','USD',''),// no rate -> skipped
  row(d(3),'BNZ',-500,'Transfer'),
];
let written,note;
const sheet=(vals)=>({clear(){},getLastRow:()=>vals.length+1,getRange:(r,c,h,w)=>({getValues:()=>vals,setValues:v=>{written=v},setFontWeight(){},setNote:n=>{note=n},setNumberFormat(){return this}}),setFrozenRows(){}});
const ss={getSheetByName:n=>n==='Transactions'?sheet(tx):sheet([]),getSpreadsheetTimeZone:()=>'UTC'};
ctx.buildSummary_(ss);
const get=l=>written.find(r=>r[0]===l).slice(-1)[0];
assert.strictEqual(get('INCOME (take-home)'),3000); assert.strictEqual(get('TOTAL SPEND'),70); assert.strictEqual(get('Groceries'),70);
assert(!written.some(r=>r[0]==='Travel')); assert(/1 foreign-currency rows left out/.test(note));
console.log('all pass');
// merchants
vm.runInContext('this.buildMerchants_=buildMerchants_;this.merchantName_=merchantName_;',ctx);
const pm=(k,day)=>new Date(now.getFullYear(),now.getMonth()-k,day,12);
const mrow=(date,merchant,desc,amt,cat)=>[date,'BNZ',desc,merchant,amt,'','',cat,'id','NZD',amt];
const mtx=[];
for(let k=1;k<=4;k++) mtx.push(mrow(pm(k,5),'Netflix','',-22.99,'Entertainment'));
for(let k=1;k<=3;k++){ for(let n=0;n<8;n++) mtx.push(mrow(pm(k,2+n*3),'Uber Eats','',-30,'Takeaway')); }
mtx.push(mrow(pm(1,20),'Uber Eats','',30,'Takeaway'));        // refund
mtx.push(mrow(pm(0,2),'Netflix','',-24.99,'Entertainment'));   // current month: only the last charge
mtx.push(mrow(pm(2,9),'','POS W/D COUNTDOWN AKL 1234-5678 12/03',-150,'Groceries'));
mtx.push(mrow(pm(2,9),'','Salary ACME',4000,'Income'));
let mout;
const ss2={getSheetByName:n=>n==='Transactions'?sheet(mtx):{clear(){},getRange:()=>({setValues:v=>{mout=v},setFontWeight(){},setNote(){},setNumberFormat(){return this}}),setFrozenRows(){}},getSpreadsheetTimeZone:()=>'UTC'};
ctx.buildMerchants_(ss2);
const M=n=>mout.find(r=>r[0]===n);
assert.strictEqual(mout[1][0],'Uber Eats'); assert.strictEqual(M('Uber Eats')[3],230); assert.strictEqual(M('Uber Eats')[7],'');
assert.strictEqual(M('Netflix')[3],22.99); assert.strictEqual(M('Netflix')[9],24.99); assert.strictEqual(M('Netflix')[7],'Yes'); assert.strictEqual(M('Netflix')[6],4); assert.strictEqual(M('Netflix')[2],'Lifestyle');
assert.strictEqual(M('COUNTDOWN AKL')[3],50);
assert(!mout.some(r=>/SALARY/.test(r[0])));
console.log('merchants pass');
// dashboard data
vm.runInContext('this.dashboardData_=dashboardData_;',ctx);
const months=['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'];
const S2={months,
  income:{'2026-04':5000,'2026-05':5000,'2026-06':5000,'2026-07':5000,'2026-08':5200,'2026-09':1000},
  totals:{'2026-04':3000,'2026-05':3300,'2026-06':3600,'2026-07':3000,'2026-08':3500,'2026-09':900},
  groupOfCat:{Takeaway:'Lifestyle',Groceries:'Lifestyle','Food out':'Lifestyle'}, groupTotals:{Bills:{'2026-07':1500,'2026-08':1500},Lifestyle:{'2026-05':300,'2026-06':300,'2026-07':200,'2026-08':950}}, order:['Bills','Lifestyle'],
  spend:{Takeaway:{'2026-05':300,'2026-06':300,'2026-07':200,'2026-08':500},Groceries:{'2026-06':800,'2026-07':800,'2026-08':750},'Food out':{'2026-08':450}}};
const accounts=[['Everyday','CHECKING','NZD',2000,2000,2000],['Savings account','SAVINGS','NZD',8000,8000,8000],['Visa','CREDITCARD','NZD',-900,0,-900],['Wise USD','Wise balance','USD',100,100,165]];
const targets=[['Emergency fund','Savings goal','Savings account',10000,'','','',1,''],['Eating out','Spending limit','Food out',400,'','','',2,''],['Ex','Savings goal','x',1,'','','',1,'Example']];
const actions=[[2,'Cut takeaway by half','Takeaway',150,'Medium','','','2026-10-15','Open','',''],[1,'Cancel Disney+','Disney+',19,'Low','','','2026-10-05','',' ',''],[3,'Switch phone plan','Phone',25,'Low','','','','Done',30,'']];
const D=ctx.dashboardData_(S2,[['Uber Eats','Takeaway',230]],accounts,targets,actions);
const kv=Object.fromEntries(D.kpis.map(k=>[k[0],k[1]]));
assert.strictEqual(D.monthName,'Aug 2026');
assert.strictEqual(kv['Spent'],3500); assert.strictEqual(kv['Spent vs 3-mo avg'],200); assert.strictEqual(kv['Left over'],1700);
assert.strictEqual(kv['Runway'],3); // (2000+8000+165)/ avg(3600,3000,3500)=10165/3366.67
assert.strictEqual(kv['Saved by actions last month'],30);
eq(D.actions.map(a=>a[1]),['Cut takeaway by half','Cancel Disney+']); assert.strictEqual(D.actions[0][3],1800);
eq(D.targets.filter(t=>!t.unalloc&&!t.reserved).map(t=>[t.name,t.now,t.ratio]),[['Emergency fund',8000,0.8]]);
assert.strictEqual(D.mom.prevName,'Jul 2026');
const mo=Object.fromEntries(D.mom.rows.map(r=>[r.name,r]));
assert.strictEqual(mo['Total spend'].change,500); assert.strictEqual(mo['Income'].change,200); assert.strictEqual(mo['Left over'].change,-300);
eq(D.mom.rows.map(r=>r.name),['Income','Total spend','Left over','Bills','Lifestyle','    Groceries','    Takeaway','    Food out']); assert.strictEqual(mo['    Takeaway'].pct,1.5); assert.strictEqual(mo['    Takeaway'].kind,'category');
assert.strictEqual(D.trend[6][0],'Sep 2026 (so far)'); assert.strictEqual(kv['Bills'],1500);
assert.strictEqual(mo['Lifestyle'].change,750); assert.strictEqual(mo['Lifestyle'].kind,'group');
console.log('dashboard pass');

// rules
vm.runInContext('this.parseRules_=parseRules_;this.myCategory_=myCategory_;this.groupOf_=groupOf_;',ctx);
const R=ctx.parseRules_([
  ['credit card','Credit card payment','','',''],
  ['e.g. landlord name','Rent','Bills','','out'],
  ['j smith','Rent','Bills','bnz','out'],
  ['j smith','Income: board','','','in'],
  ['','Groceries','Everyday','',''],
  ['netflix','Subscriptions','','',''],
]);
assert.strictEqual(R.rules.length,4);                                   // e.g. row and group-only row skipped
assert.strictEqual(ctx.groupOf_(R.groups,'rent'),'Bills'); assert.strictEqual(ctx.groupOf_(R.groups,'Groceries'),'Everyday');
assert.strictEqual(ctx.groupOf_(R.groups,'Takeaway'),'Other'); assert.strictEqual(ctx.groupOf_(R.groups,'Transfer'),'Transfer');
assert(R.ruled.has('rent') && !R.ruled.has('credit card payment'));
const C=t=>ctx.myCategory_(R.rules,t);
assert.strictEqual(C({account:'BNZ Everyday',description:'Transfer',reference:'J SMITH RENT',amount:-600,type:'TRANSFER'}),'Rent');
assert.strictEqual(C({account:'Wise NZD',description:'Transfer',reference:'J SMITH',amount:-600,type:'TRANSFER'}),'Transfer'); // wrong account
assert.strictEqual(C({account:'BNZ',reference:'J SMITH',amount:200,type:'CREDIT'}),'Income: board');                         // money in
assert.strictEqual(C({account:'BNZ',merchant:'Netflix',amount:-20,category:'Entertainment'}),'Subscriptions');
assert.strictEqual(C({account:'BNZ',merchant:'Pak n Save',amount:-20,category:'Groceries'}),'Groceries');
// ruled rows are never paired
const pr=[row(d(0),'BNZ',-600,'Rent'),row(d(1),'Wise NZD',600,'Uncategorised')];
eq(ctx.pairTransfers_(pr,R.ruled).map(x=>x[0]),['Rent','Uncategorised']);
eq(ctx.pairTransfers_(pr).map(x=>x[0]),['Transfer','Transfer']);
console.log('rules pass');
// net worth
vm.runInContext('this.netWorthData_=netWorthData_;',ctx);
const NW=ctx.netWorthData_(
  [['BNZ Everyday','CHECKING','NZD',97000,0,97000,'','a1','BNZ'],['KiwiSaver','KIWISAVER','NZD',86000,0,86000,'','a2','Simplicity'],
   ['Wise USD','Wise balance','USD',19000,0,0,'','w1','Wise'],['Visa','CREDITCARD','NZD',-1200,0,-1200,'','a3','BNZ']],
  [['Investment','Sharesies','Portfolio','CAD',13000,'','',''],['Investment','Coinbase','Bitcoin','CAD','',0.5,'CURRENCY:BTCCAD',''],
   ['Investment','Sharesies','VOO','USD','',2,'VOO',''],['Debt','IRD','Tax owed','NZD',5000,'','',''],
   ['Investment','X','Example','CAD',999,'','','Example'],['Property','','House','GBP',100,'','','']],
  {NZD:1,CAD:1.2,USD:1.7},{'CURRENCY:BTCCAD':100000});
eq(NW.currencies,['NZD','CAD','USD','GBP']);
eq(NW.byCurrency,{NZD:97000+86000-1200-5000,USD:19000,CAD:63000,GBP:100});
assert.strictEqual(NW.byCurrencyNzd.CAD,75600); assert.strictEqual(NW.byCurrencyNzd.GBP,null);
assert(NW.missing.includes('VOO') && NW.missing.includes('GBP'));
assert.strictEqual(NW.rows.find(r=>r.account==='Tax owed').value,-5000);
assert.strictEqual(NW.rows[0].type,'Cash'); assert.strictEqual(NW.rows.find(r=>r.account==='KiwiSaver').type,'Investment');
assert.strictEqual(NW.total, Math.round((176800+19000*1.7+75600)*100)/100);
eq(NW.byType.map(x=>x[0]),['Cash','Investment','Property','Debt']);
// dashboard with history
const H=[['2026-07','',0,0,0,0,0,300000],['2026-08','',0,0,0,0,0,310000],['2026-09','',0,0,0,0,0,315000]];
const D2=ctx.dashboardData_(S2,[],accounts,[],[],H);
assert.strictEqual(D2.kpis[0][0],'Net worth'); assert.strictEqual(D2.kpis[0][1],315000);
const nwRow=D2.mom.rows.find(r=>r.name==='Net worth'); assert.strictEqual(nwRow.change,10000);
assert.strictEqual(D2.netWorth.length,4);
console.log('net worth pass');
// per-account goals on Net worth
const NW2=ctx.netWorthData_([['BNZ Everyday','CHECKING','NZD',97000,0,97000,'','a1','BNZ'],['Visa','CREDITCARD','NZD',-1200,0,-1200,'','a3','BNZ']],[],
  {NZD:1},{},[['Buffer','Savings goal','everyday',100000,'','','',1,''],['Card','Debt payoff','visa','','','','',2,''],['Ex','Savings goal','visa',5,'','','',1,'Example']]);
assert.strictEqual(NW2.rows.find(r=>r.account==='BNZ Everyday').progress,0.97);
assert.strictEqual(NW2.rows.find(r=>r.account==='Visa').goal,0);
// forecast
vm.runInContext('this.forecastData_=forecastData_;',ctx);
const today=new Date(2026,8,15);
const FT=[['Emergency fund','Savings goal','Savings account',15000,new Date(2027,5,1),'','',1,''],
  ['Trip','Savings goal','',3000,'','','',2,''],
  ['Tax','Debt payoff','Tax owed','','','','',3,''],
  ['Eating out','Spending limit','Food out',400,'','','',4,'']];
const BH=[['2026-07','BNZ Savings account','BNZ','Cash','NZD',7000,7000],['2026-08','BNZ Savings account','BNZ','Cash','NZD',7500,7500],
  ['2026-09','BNZ Savings account','BNZ','Cash','NZD',8000,8000],['2026-09','Tax owed','IRD','Debt','NZD',-1000,-1000]];
const F=ctx.forecastData_(S2,[],FT,actions,H,today,BH);
assert.strictEqual(F.surplus,1700); assert.strictEqual(F.actionSaving,150);   // committed only
const G=n=>F.goals.find(g=>g.name===n); const ym=d=>d?d.getFullYear()+'-'+(d.getMonth()+1):'';
assert.strictEqual(G('Emergency fund').source,'Account trend'); assert.strictEqual(G('Emergency fund').perMonth,500);
assert.strictEqual(G('Emergency fund').left,7000); assert.strictEqual(ym(G('Emergency fund').doneBy),'2027-11');
assert.strictEqual(ym(G('Emergency fund').withActions),'2027-8'); assert.strictEqual(G('Emergency fund').status,'Behind');
assert.strictEqual(G('Emergency fund').needs,777.78);
assert.strictEqual(G('Trip').source,'Surplus'); assert.strictEqual(G('Trip').perMonth,1200); assert.strictEqual(ym(G('Trip').doneBy),'2026-12');
assert.strictEqual(G('Tax').left,1000); assert.strictEqual(ym(G('Tax').doneBy),'2027-1'); assert.strictEqual(G('Tax').account,'Tax owed');
assert.strictEqual(F.thisMonth[0].pace,1800); assert.strictEqual(F.thisMonth[0].status,'Under pace');
assert.strictEqual(F.netWorth.length,14); assert.strictEqual(F.netWorth[13][1],335400); assert.strictEqual(F.netWorth[13][2],335400+150*12);
console.log('forecast pass');
// one account, several goals (buckets filled by priority)
vm.runInContext('this.goalBalances_=goalBalances_;',ctx);
const BT=[['Emergency','Savings goal','Savings',5000,'','','',1,''],['Trip','Savings goal','Savings',6000,'','','',2,''],
  ['Car','Savings goal','Savings',2000,'','','',3,''],['Typed','Savings goal','Savings',1000,'',400,'',0,'']];
const GB=ctx.goalBalances_(BT,a=>/savings/i.test(a)?'BNZ Savings':'',()=>8000);
eq(GB.map(g=>g.now),[5000,3000,0,null]); assert.strictEqual(GB[3].account,'BNZ Savings');
const BH2=[['2026-07','BNZ Savings','BNZ','Cash','NZD',7000,7000],['2026-08','BNZ Savings','BNZ','Cash','NZD',7500,7500],['2026-09','BNZ Savings','BNZ','Cash','NZD',8000,8000]];
const F2=ctx.forecastData_(S2,[],BT.slice(0,3).concat([['Trip2','Savings goal','',1200,'','','',4,'']]),[],[],today,BH2);
const G2=n=>F2.goals.find(g=>g.name===n);
assert.strictEqual(G2('Emergency').status,'Done'); assert.strictEqual(G2('Trip').left,3000); assert.strictEqual(G2('Trip').perMonth,500);
assert.strictEqual(ym(G2('Trip').doneBy),'2027-3'); assert.strictEqual(G2('Car').perMonth,'queued'); assert.strictEqual(ym(G2('Car').doneBy),'2027-7');
assert.strictEqual(G2('Trip2').perMonth,1200);   // surplus 1700 minus the account's 500 trend
const NW3=ctx.netWorthData_([['BNZ Savings','SAVINGS','NZD',8000,0,8000,'','a','BNZ']],[],{NZD:1},{},BT);
assert.strictEqual(NW3.rows[0].goal,14000); assert.strictEqual(NW3.rows[0].goals,'Emergency, Trip, Car, Typed');
const D3=ctx.dashboardData_(S2,[],[['BNZ Savings','SAVINGS','NZD',8000,0,8000]],BT.slice(0,3),[],[]);
eq(D3.targets.filter(t=>!t.unalloc&&!t.reserved).map(t=>t.now),[3000,5000,0]);   // biggest goal first
console.log('shared account pass');
// planned purchases on the Forecast
const PA=[['/ Savings','CHECKING','NZD',10000,0,10000],['/ Savings #Car','CHECKING','NZD',16000,0,16000],['Income Tax','SAVINGS','NZD',5000,0,5000]];
const PB=[['2026-09','/ Savings #Car','BNZ','Cash','NZD',16000,16000],['2026-07','/ Savings','BNZ','Cash','NZD',9000,9000],
  ['2026-08','/ Savings','BNZ','Cash','NZD',9500,9500],['2026-09','/ Savings','BNZ','Cash','NZD',10000,10000]];
const PT=[['Emergency','Savings goal','/ Savings',4000,'','','',1,''],
  ['Japan','Planned purchase','/ Savings',5000,new Date(2027,1,1),'','','',''],
  ['DJ decks','Planned purchase','/ Savings',3000,'','','','',''],
  ['Projector','Planned purchase','/ Savings',3000,new Date(2026,11,1),'','','',''],
  ['Speaker','Planned purchase','',1000,new Date(2026,10,10),'','','',''],
  ['Mystery','Planned purchase','Nowhere',50,'','','','',''],
  ['Ex','Planned purchase','/ Savings',99,'','','','','Example']];
const FP=ctx.forecastData_(S2,PA,PT,[],H,today,PB);
const P=n=>FP.purchases.find(p=>p.name===n);
eq(FP.purchases.map(p=>p.name),['DJ decks','Mystery','Speaker','Projector','Japan']);
assert.strictEqual(P('DJ decks').account,'/ Savings');   // exact name beats "/ Savings #Car"
eq([P('DJ decks').before,P('DJ decks').after,P('DJ decks').lowest,P('DJ decks').status],[10000,7000,1500,'Covered']);
eq([P('Projector').before,P('Projector').after,P('Projector').status],[8500,5500,'Covered']);
eq([P('Japan').before,P('Japan').after,P('Japan').earnBack,P('Japan').status],[6500,1500,10,'Dips into goals on this account']);
eq([P('Speaker').account,P('Speaker').before,P('Speaker').after,P('Speaker').earnBack],['All cash',29400,28400,1]);   // cash 26000, Income Tax is reserved
assert(/no account/i.test(P('Mystery').status));
eq(FP.planChart[0].slice(0,2),['Month','/ Savings with purchases']); eq(FP.planChart[1].slice(1,2),[7000]);
assert.strictEqual(FP.netWorth[13][3],335400-12000);
assert.strictEqual(F.netWorth[0].length,3);   // no purchases, no extra line
const DP=ctx.dashboardData_(S2,[],PA,PT,[],[]);
eq(DP.targets.filter(t=>!t.plan&&!t.unalloc&&!t.reserved).map(t=>t.name),['Emergency']);
const DS=ctx.dashboardData_(S2,[],[['#Home','CHECKING','NZD',18000,0,18000],['My KiwiSaver','KIWISAVER','NZD',90000,0,90000],['Save','HOLDING','CAD',25000,0,31000],['#Car','CHECKING','NZD',16000,0,16000]],
  [['House deposit (Cash)','Savings goal','#Home',83000,'','','',2,''],['House deposit (KiwiSaver)','Savings goal','My KiwiSaver',92000,'','','',3,''],
   ['House deposit (Canada)','Savings goal','Save',31000,'','','',4,''],['Car','Savings goal','#Car',20000,'','','',1,'']],[],[]);
eq(DS.targets.filter(t=>!t.unalloc&&!t.reserved).map(t=>[t.name,t.aim,t.now,!!t.header]),[['House deposit',206000,139000,true],['    KiwiSaver',92000,90000,false],
  ['    Cash',83000,18000,false],['    Canada',31000,31000,false],['Car',20000,16000,false]]);   // parts grouped under one section
assert(/Home scenarios/.test(DS.targets[0].note));
eq(DS.targets.filter(t=>!t.unalloc&&!t.reserved).map(t=>t.kind),['','My KiwiSaver','#Home','Save','#Car']);
const DW=ctx.dashboardData_(S2,[],[['/ Savings #Home','CHECKING','NZD',1,0,1,'','a','BNZ'],['Portfolio','HOLDING','CAD',1,0,1,'','','Sharesies'],['Save','HOLDING CASH','CAD',1,0,1,'','','Sharesies']],
  [['A','Savings goal','/ Savings #Home',5,'','','',1,''],['B','Savings goal','Portfolio + Save',5,'','','',2,'']],[],[]);
eq(DW.targets.filter(t=>!t.unalloc&&!t.reserved).map(t=>t.kind).sort(),['BNZ / Savings #Home','Sharesies / Portfolio + Save']);   // provider once, leading / dropped
// unallocated: what's left in each account after its goals and purchases; tax accounts and loans left out
const DU=ctx.dashboardData_(S2,[],[['/ Savings #Home','CHECKING','NZD',5000,0,5000,'','a','BNZ'],['Wise USD','FOREIGN','USD',100,0,170,'','w','Wise'],
  ['Income Tax','SAVINGS','NZD',9000,0,9000,'','t','BNZ'],['/ Savings','CHECKING','NZD',4000,0,4000,'','s','BNZ'],['Loan to Dad','HOLDING','NZD',500,0,500,'','','Dad','Owed to you']],
  [['House','Savings goal','#Home',3000,'','','',1,''],['Decks','Planned purchase','/ Savings',3000,'','','','','']],[],[]);
eq(DU.targets.filter(t=>t.unalloc).map(t=>[t.name,t.kind,t.now]),[['Unallocated savings','',1170],
  ['    Savings','BNZ / Savings',1000],['    Wise USD','Wise / Wise USD',170]]);   // #Home holds a goal, so its extra 2000 is the goal's
eq(DU.targets.filter(t=>t.reserved).map(t=>[t.name,t.now]),[['Tax & GST',9000],['    Income Tax',9000]]);
// budget group: the accounts the spending budget runs through, ahead of Unallocated
const DBG=ctx.dashboardData_(Object.assign({},S2,{groupOfCat:{Rent:'Bills',Groceries:'Everyday'}}),[],
  [['# Everyday','CHECKING','NZD',300,0,300,'','e','BNZ'],['# Monthly','CHECKING','NZD',2000,0,2000,'','m','BNZ'],['/ Bills','CHECKING','NZD',900,0,900,'','b','BNZ'],
   ['Invoices','CHECKING','NZD',5000,0,5000,'','i','BNZ'],['Wise USD','FOREIGN','USD',100,0,170,'','w','Wise']],
  [['Savings','Monthly savings','',1000,'','','','',''],['Rent','Spending limit','Rent',1950,'','','','',''],['Food','Spending limit','Groceries',2600,'','','','','']],[],[]);
eq(DBG.targets.filter(t=>!t.reserved).map(t=>[t.name,Math.round(t.aim)||t.aim,t.now]),[['Unallocated savings','',170],['    Wise USD','',170],['Budget',4550,8200],['    Bills',1950,900],['    Monthly',2600,2000],
  ['    Everyday (weekly)',600,300],['    Invoices (pay lands, then moved out)',0,5000]].map(r=>r));
const DBG2=ctx.dashboardData_(Object.assign({},S2,{groupOfCat:{Rent:'Bills',Groceries:'Everyday'}}),[],
  [['# Everyday','CHECKING','NZD',300,0,300,'','e','BNZ'],['# Monthly','CHECKING','NZD',2000,0,2000,'','m','BNZ'],['/ Bills','CHECKING','NZD',900,0,900,'','b','BNZ']],
  [['Savings','Monthly savings','',1000,'','','','',''],['Rent','Spending limit','Rent',1950,'','','','',''],['Food','Spending limit','Groceries',2600,'','','','',''],
   ['Apps','Spending limit','AI & software',400,'','','','','','','# Everyday']],[],[]);
eq(DBG2.targets.filter(t=>/Everyday/.test(t.name)).map(t=>[t.name,t.aim]),[['    Everyday (automatic payments, plus $600 a week from Monthly)',400]]);   // both sources named   // where each goal's money sits
eq(ctx.dashboardData_(S2,[],[],[['Car','Savings goal','',20000,'','','',1,''],['House','Savings goal','',114000,'','','',2,''],['Card','Debt payoff','',0,'','','',1,'']],[],[]).targets.filter(t=>!t.unalloc&&!t.reserved).map(t=>t.name),['House','Car','Card']);   // biggest goal first, debts after   // savings goals and debts, no spending limits
// then planned purchases, soonest first, covered from the paying account in that order (/ Savings has 10000)
eq(DP.targets.filter(t=>t.plan&&!t.unalloc&&!t.reserved).map(t=>[t.name,t.kind,t.aim,t.now,t.ratio]),[
  ['Planned purchases','/ Savings',11000,10000,0.91],['    DJ decks, now','/ Savings',3000,3000,1],['    Projector, Dec 2026','/ Savings',3000,3000,1],['    Japan, Feb 2027','/ Savings',5000,4000,0.8],
  ['    Mystery, now','no account matches Applies to',50,'',''],
  ['Planned purchases','All cash',1000,26000,1],['    Speaker, Nov 2026','All cash',1000,1000,1]]);   // grouped under the account that pays
console.log('planned purchases pass');
// one goal over several accounts ("#Home + KiwiSaver")
const CA=[['/ Savings #Home','CHECKING','NZD',18000,0,18000],['My KiwiSaver','KIWISAVER','NZD',90000,0,90000],['/ Savings #Car','CHECKING','NZD',16000,0,16000]];
const CB=[['2026-07','/ Savings #Home','BNZ','Cash','NZD',17000,17000],['2026-08','/ Savings #Home','BNZ','Cash','NZD',17500,17500],['2026-09','/ Savings #Home','BNZ','Cash','NZD',18000,18000],
  ['2026-07','My KiwiSaver','X','Investment','NZD',89000,89000],['2026-08','My KiwiSaver','X','Investment','NZD',89500,89500],['2026-09','My KiwiSaver','X','Investment','NZD',90000,90000]];
const CT=[['Car','Savings goal','#Car',20000,'','','',1,''],['House deposit','Savings goal','#Home + KiwiSaver',200000,'','','',2,'']];
const GC=ctx.goalBalances_(CT,a=>(CA.find(x=>x[0].toLowerCase().includes(a.toLowerCase()))||[])[0]||'',n=>(CA.find(x=>x[0]===n)||[])[5]);
eq([GC[1].account,GC[1].now],['/ Savings #Home + My KiwiSaver',108000]); eq(GC[1].accounts,['/ Savings #Home','My KiwiSaver']);
const FC=ctx.forecastData_(S2,CA,CT,[],H,today,CB);
const HD=FC.goals.find(g=>g.name==='House deposit');
eq([HD.left,HD.perMonth,HD.source],[92000,1000,'Account trend']);   // trends 500 + 500
assert.strictEqual(ctx.goalBalances_([['X','Savings goal','#Home + Nowhere',1,'','','',1,'']],a=>a==='#Home'?'/ Savings #Home':'',()=>1)[0].account,'');   // every part must match
const NWC=ctx.netWorthData_(CA.map(r=>r.concat(['','id','BNZ'])),[],{NZD:1},{},CT);
const NR=n=>NWC.rows.find(r=>r.account===n);
eq([NR('/ Savings #Home').goals,NR('/ Savings #Home').progress,NR('My KiwiSaver').progress,NR('/ Savings #Car').progress],['House deposit',0.54,0.54,0.8]);
eq(ctx.dashboardData_(S2,[],CA,CT,[],[]).targets.filter(t=>!t.unalloc&&!t.reserved).map(t=>t.now),[108000,16000]);
// a goal on KiwiSaver alone grows by itself: no share of savings, no payday transfer
const KT=[['Cash','Savings goal','#Home',30000,'','','',1,'',1],['KS','Savings goal','My KiwiSaver',95000,'','','',2,'',0.5]];
const FK=ctx.forecastData_(S2,CA,KT,[],[],new Date(2026,9,3),CB);
const KG=n=>FK.goals.find(g=>g.name===n);
eq([KG('KS').source,KG('KS').perMonth,KG('Cash').perMonth],['Account trend',500,1700]);   // its own trend; the cash goal gets all the savings
assert(FK.goalFlows.find(g=>g.name==='KS').own);
const KT2=KT.map(r=>r.slice());const FK2=ctx.forecastData_(S2,CA,KT2,[],[],new Date(2026,9,3),[]);
assert.strictEqual(FK2.goals.find(g=>g.name==='KS').source,'Grows on its own (not enough history yet)');
const FH=ctx.forecastData_(S2,CA,[['CAD','Savings goal','Save',40000,'','','',1,''],['Cash','Savings goal','#Home',30000,'','','',2,'']],[],[],new Date(2026,9,3),
  CB.concat([['2026-09','Save','Sharesies','Cash','CAD',25000,31000]]));
eq([FH.goals[0].source,FH.goals[0].perMonth],['Grows on its own (not enough history yet)',0]);   // a Holdings goal never takes payday savings
console.log('combined accounts pass');
// home scenarios layout
vm.runInContext('this.homeScenariosLayout_=homeScenariosLayout_;this.housePlanFunds_=housePlanFunds_;this.keptInputs_=keptInputs_;'+
  'this.resolveInputs_=resolveInputs_;this.selectedNeed_=selectedNeed_;this.houseGoalResize_=houseGoalResize_;this.foreignFromNetWorth_=foreignFromNetWorth_;',ctx);
const HF=ctx.housePlanFunds_([{name:'Car',account:'#Car',left:3000,saved:17000,share:0.7,target:20000},
  {name:'Rainy day',account:'Save',left:0,saved:10000,share:0,target:10000},
  {name:'House deposit (Cash)',account:'#Home',left:12000,saved:19000,share:0.3,target:31000},
  {name:'House deposit (KiwiSaver)',account:'Sam KiwiSaver',left:100,saved:90000,share:0,target:90100},
  {name:'House deposit (Wise)',account:'Wise USD + Wise CAD',left:0,saved:18500,share:0,target:18500},
  {name:'Loan',account:'Card',left:500,saved:'',debt:true}]);
eq([HF.saved,HF.kiwiSaver,HF.ahead,HF.goalTotal,HF.parts.length,HF.aheadNames],[37500,90000,3000,139600,2,['Car']]);
const HP=ctx.homeScenariosLayout_(Object.assign({takeHome:12800,spend:12070,gross:200000,rent:1900,foreign:50000},HF));
const HK=k=>HP.find(r=>r.key===k), HR=(k,c)=>(c||'B')+(HP.indexOf(HK(k))+1), HS=k=>'$B'+(HP.indexOf(HK(k))+1);
assert(HP.every(r=>!/undefined/.test(String(r.a)+String(r.b))));             // every formula's references resolve
assert.strictEqual(new Set(HP.filter(r=>r.key).map(r=>r.key)).size,HP.filter(r=>r.key).length);
assert.strictEqual(new Set(HP.map(r=>r.label).filter(Boolean)).size,HP.map(r=>r.label).filter(Boolean).length);   // inputs are kept by label
eq([HK('gross').a,HK('price').a,HK('price').b,HK('haveSave').a,HK('ahead').a,HK('goalTotal').a,HK('foreign').a],[200000,750000,1000000,37500,3000,139600,50000]);
assert(/Targets!B:B="Monthly savings"\),1\),750\)$/.test(HK('monthly').a));   // Targets first, typical surplus if none
assert(/Targets!C:C="Rent"\),1\),1900\)$/.test(HK('rent').a));
assert.strictEqual(HK('haveKs').a,'=IF('+HS('useKs')+'="Yes",90000,0)');
assert.strictEqual(HK('needed').a,'='+HR('deposit')+'+'+HR('costs')+'+IF('+HS('useKs')+'="Yes",1000,0)');
assert.strictEqual(HK('needed').b,'='+HR('deposit','C')+'+'+HR('costs','C')+'+IF('+HS('useKs')+'="Yes",1000,0)');   // each scenario in its own column
assert(HK('months').b.includes('('+HR('left','C')+'+'+HS('ahead')+')'));      // the car is paid alongside
assert(HK('selNeeded').a.includes(HR('needed','B'))&&HK('selNeeded').a.includes(HR('needed','C')));
assert.strictEqual(HK('vsRentWeek').a,'='+HR('vsRent')+'*12/52');
assert(HP.filter(r=>r.kind==='input').every(r=>r.a!==''&&r.b!==''&&r.format));
assert.strictEqual(HK('haveSave').b,'');
eq(HP.map((r,i)=>r.kind==='section'?HP[i-1].kind:'').filter(Boolean),['header','blank','blank','blank','blank','blank']);   // a spacer before each section after the first                                      // one-value rows stay in column B
assert(/,0\)$/.test(ctx.homeScenariosLayout_({}).find(r=>r.key==='monthly').a));   // no data yet, no negative saving
// inputs: this tab's first row per label, then the old House plan for one-value inputs
const KI=ctx.keptInputs_([['Price',800000,1200000,''],['Deposit',0.15,0.2,''],['Deposit',150000,200000,''],['Selected scenario (A or B)','a','','']],
  [['Price',999,'',''],['Take-home per month',9000,'',''],['Use KiwiSaver for it? (Yes / No)','No','','']]);
const HI=ctx.resolveInputs_(ctx.homeScenariosLayout_({}),KI), HJ=k=>HI.find(r=>r.key===k);
eq([HJ('price').a,HJ('price').b,HJ('depositPct').a,HJ('takeHome').a,HJ('useKs').a,HJ('costs').a],[800000,1200000,0.15,9000,'No',10000]);
assert.strictEqual(ctx.selectedNeed_(HI),800000*0.15+10000);                   // A selected, no KiwiSaver $1,000
assert.strictEqual(ctx.selectedNeed_(ctx.resolveInputs_(ctx.homeScenariosLayout_({}),ctx.keptInputs_([],[]))),null);   // nothing selected
// the goal that takes monthly savings absorbs the difference
const HT=[['Car','Savings goal','#Car',20000,'','','',1,'','0.7'],['House deposit (Cash)','Savings goal','#Home',31000,'','','','','','0.3'],
  ['House deposit (KiwiSaver)','Savings goal','KS',90000,'','','',3,''],['House deposit (Wise)','Savings goal','Wise',18000,'','','',4,'']];
eq(ctx.houseGoalResize_(HT,211000),{index:1,target:103000});
assert.strictEqual(ctx.houseGoalResize_(HT,139000),null);                     // already matches
assert.strictEqual(ctx.houseGoalResize_(HT,null),null);
assert.strictEqual(ctx.houseGoalResize_(HT.map(t=>t.slice(0,9)),211000),null);  // no goal takes savings: leave them alone
eq(ctx.houseGoalResize_(HT,50000),{index:1,target:0});                        // never below zero
// money held in other currencies, from the Net worth tab's "in NZD" row
assert.strictEqual(ctx.foreignFromNetWorth_([['Type','Provider','Account','NZD','CAD','USD','NZD value'],['Cash','B','x',10,'','',10],
  ['Total','','in each currency',10,5,4],['','','in NZD',10,6.5,7.25,23.75]]),13.75);
assert.strictEqual(ctx.foreignFromNetWorth_([]),0);
vm.runInContext('this.uncategorisedHeaderRow_=uncategorisedHeaderRow_;',ctx);
eq([ctx.uncategorisedHeaderRow_([['How to sort: ...'],[''],['Match text (edit if needed)'],['acme']]),
    ctx.uncategorisedHeaderRow_([['Match text (edit if needed)'],['acme']]),ctx.uncategorisedHeaderRow_([['x']])],[3,1,1]);   // old layout still read
vm.runInContext('this.keptTransfers_=keptTransfers_;',ctx);
eq(ctx.keptTransfers_([['Transfers To Do','','','',''],['','','','',''],['One-off transfers','','','',''],['','Transfer','Amount','Status','Why'],
  ['','A to B',100,'Done','x'],['','C to D',50,'','y'],['','','','',''],['Your routine','','','',''],['','Monday','auto','','']]),
  [['A to B',100,'Done','x'],['C to D',50,'To do','y']]);
eq(ctx.keptTransfers_([['One-off transfers'],['','None right now. Moves outside payday','','','']]),[]);
eq(ctx.keptTransfers_([['Money in Invoices']]),[]);
console.log('home scenarios pass');
// goals: flat accounts share the surplus, month by month, and per pay
const GT=[['Car','Savings goal','#Car',20000,'','','',1,''],['House','Savings goal','#Home',30000,'','','',2,'']];
const GA=[['/ Savings #Car','CHECKING','NZD',16000,0,16000],['/ Savings #Home','CHECKING','NZD',18000,0,18000]];
const GH=[['2026-08','/ Savings #Car','BNZ','Cash','NZD',16000,16000],['2026-09','/ Savings #Car','BNZ','Cash','NZD',16000,16000],
  ['2026-09','/ Savings #Home','BNZ','Cash','NZD',18000,18000]];
const FG=ctx.forecastData_(S2,GA,GT,[],[],new Date(2026,9,2),GH);   // surplus 1700; car's account is flat, house has no history
const GG=n=>FG.goals.find(g=>g.name===n);
eq([GG('Car').source,GG('Car').perMonth,GG('Car').saved,GG('Car').target],['Surplus',1700,16000,20000]);   // flat no longer means never
eq([GG('House').perMonth,ym(GG('House').startsBy)],['queued','2027-1']);   // starts once the car is done
eq(ym(GG('Car').doneBy),'2027-1'); assert.strictEqual(FG.allocated,1700);
eq(FG.goalMonths[0],['Month','Car','House','Not allocated']);
eq(FG.goalMonths[1],['Nov 2026',17700,18000,0]); eq(FG.goalMonths[3],['Jan 2027',20000,19100,0]);   // Jan: car takes its last 600, 1100 rolls to house
// pay schedule
vm.runInContext('this.paySchedule_=paySchedule_;',ctx);
const PR=(y,m,d,amt,cat)=>[new Date(y,m,d),'Invoices','','',amt,'','',cat,'','NZD',amt];
eq(ctx.paySchedule_([PR(2026,8,17,9000,'Income: Job'),PR(2026,7,18,9000,'Income: Job'),PR(2026,6,20,9000,'Income: Job'),PR(2026,8,3,40,'Income: Other')],new Date(2026,9,2)),
  {perMonth:1,label:"You're paid monthly, around the 18th, so per pay is the same as per month",account:'Invoices'});
eq(ctx.paySchedule_([PR(2026,8,1,4000,'Income'),PR(2026,8,15,4000,'Income')],new Date(2026,9,2)).perMonth,2);
eq(ctx.paySchedule_([],new Date(2026,9,2)).perMonth,1);
eq(FG.goalGrid.map(r=>r.slice(0,4)),[['','Nov 2026','Dec 2026','Jan 2027'],['Savings to allocate',1700,1700,1700],
  ['Car: into / Savings #Car',1700,1700,600],['Car balance',17700,19400,20000],['House: into / Savings #Home',0,0,1100],['House balance',18000,18000,19100],
  ['Not allocated',0,0,0]]);
// share of savings: 40/60 split, a finished goal's share moves to the other
const ST=GT.map(r=>r.concat(['']));ST[0][9]='40%';ST[1][9]=0.6;
const FS=ctx.forecastData_(S2,GA,ST,[],[],new Date(2026,9,2),GH);
const SG=n=>FS.goals.find(g=>g.name===n);
eq([SG('Car').source,SG('Car').perMonth,SG('House').source,SG('House').perMonth],['40% of savings',680,'60% of savings',1020]);
eq(FS.goalGrid.find(r=>r[0]==='Car balance').slice(1,8),[16680,17360,18040,18720,19400,20000,20000]);
eq(FS.goalGrid.find(r=>/^House: into/.test(r[0])).slice(6,8),[1100,1700]);   // month 6: car takes its last 600; month 7: all to the house
const S1=GT.map(r=>r.concat([''])).map((r,i)=>i?r:r.slice(0,9).concat([25]));   // 25 means 25%; the rest goes by priority
const F1=ctx.forecastData_(S2,GA,S1,[],[],new Date(2026,9,2),GH);
eq([F1.goals[0].perMonth,F1.goals[1].perMonth,F1.goals[1].source],[425,1275,'Surplus']);
const SX=ST.map(r=>r.slice());SX[0][6]=300;   // a Monthly transfer beats a share
eq(ctx.forecastData_(S2,GA,SX,[],[],new Date(2026,9,2),GH).goals[0].source,'Monthly transfer');
console.log('goal plan pass');
// budget: savings first, the rest is the spending budget, split by Spending limits
vm.runInContext('this.budget_=budget_;',ctx);
const BU=[['Savings','Monthly savings','',2000,'','','','',''],['Eating out','Spending limit','Eating out',1250,'','','','',''],
  ['Groceries','Spending limit','Groceries',800,'','','','',''],['Ex','Monthly savings','',9,'','','','','Example']];
eq(ctx.budget_(BU,10000),{income:10000,savings:2000,spending:8000,byCat:{'eating out':1250,groceries:800},from:{},names:{'eating out':'Eating out',groceries:'Groceries'},unassigned:5950});
eq(ctx.budget_(BU.concat([['Pay','Income target','',12000,'','','','','']]),10000).spending,10000);
assert.strictEqual(ctx.budget_(BU.slice(1),10000),null);
const FB=ctx.forecastData_(S2,GA,GT.concat([['Savings','Monthly savings','',1000,'','','','','']]),[],[],new Date(2026,9,2),GH);
eq([FB.toSave,FB.goals[0].perMonth,FB.goalGrid[1][0]],[1000,1000,'Savings target to allocate']);   // goals paid from the target, not the surplus
const DB=ctx.dashboardData_(S2,[],accounts,BU,[],[]);
const DR=n=>DB.mom.rows.find(r=>r.name.trim()===n);
eq([DR('Total spend').target,DR('Left over').target,DR('Buffer: budget not given to a category').target],[DB.mom.budget.spending,2000,DB.mom.budget.unassigned]);
assert(DB.mom.rows.filter(r=>r.kind==='income').every(r=>r.target===DB.mom.budget.income));
// payday plan: tax, each goal's money, each spending account, and what stays
vm.runInContext('this.paydayPlan_=paydayPlan_;',ctx);
const PYB=ctx.budget_([['Savings','Monthly savings','',1000,'','','','',''],['Rent','Spending limit','Rent',2000,'','','','',''],
  ['Food','Spending limit','Groceries',800,'','','','',''],['Trips','Spending limit','Trips',500,'','','','','','','/ Savings']],7000);
const PFL=[{name:'Car',into:'/ Savings #Car',paid:[700,300,0]},{name:'House',into:'/ Savings #Home',paid:[300,700,1000]}];
const PP=ctx.paydayPlan_(PYB,PFL,['Nov','Dec','Jan'],['Invoices','/ Bills','# Everyday','/ Savings','/ Savings #Car','/ Savings #Home','Income Tax'],
  {Rent:'Bills',Groceries:'Everyday',Trips:'One-off'},0.3,'Invoices');
eq(PP,[['','Nov','Dec','Jan'],['Pay lands in Invoices',10000,10000,10000],['To Income Tax (tax, 30%)',3000,3000,3000],
  ['To / Savings #Car (Car)',700,300,0],['To / Savings #Home (House)',300,700,1000],['To / Bills (Rent)',2000,2000,2000],
  ['To # Everyday (Groceries)',800,800,800],['To / Savings (Trips)',500,500,500],['Stays in Invoices (buffer)',2700,2700,2700]]);
const PP2=ctx.paydayPlan_(PYB,PFL,['Nov'],['Invoices','# Everyday','Monthly Budget'],{Groceries:'Everyday'},0,'Invoices');
assert(PP2.some(r=>/^To Monthly Budget \(.*Groceries/.test(r[0])));
assert(ctx.paydayPlan_(PYB,PFL,['Nov'],['Invoices','# Everyday','/ Monthly'],{},0,'Invoices').some(r=>/^To \/ Monthly \(/.test(r[0])));   // a Monthly budget account takes over from Everyday
eq(ctx.paydayPlan_(null,PFL,['Nov'],[],{},0,'x'),[]);
// purchases: what the account covers today in date order, the rest set aside over the paydays before
vm.runInContext('this.purchaseSetAsides_=purchaseSetAsides_;this.accountFlows_=accountFlows_;',ctx);
const SA=ctx.purchaseSetAsides_([{name:'Decks',account:'S',cost:3000,month:0},{name:'Trip',account:'S',cost:5000,month:4}],()=>4000);
eq(SA.map(p=>[p.name,p.covered,p.short,p.months,p.perMonth]),[['Decks',3000,0,1,0],['Trip',1000,4000,3,4000/3]]);
// money actually moved into each account per month
eq(ctx.accountFlows_([[new Date(2026,8,3),'#Home','','',450,'','','Transfer','id','NZD',450],[new Date(2026,8,9),'#Home','','',-50,'','','Transfer','id','NZD',-50]]),{'#Home':{'2026-09':400}});
// invoice split: GST inside the payment, tax on what's left, then bills, spending, savings, set-asides, buffer
vm.runInContext('this.invoiceSplit_=invoiceSplit_;',ctx);
const IT=[['GST','Set-aside rate','Income GST',0.15,'','','','',''],['Income tax','Set-aside rate','Income Tax',0.3,'','','','',''],
  ['Car','Savings goal','#Car',20000,'','','',1,'',0.7],['House','Savings goal','#Home',50000,'','','',2,'',0.3]];
const IA=[['Invoices','CHECKING','NZD',9000,0,9000],['Income GST','CHECKING','NZD',0,0,0],['Income Tax','SAVINGS','NZD',0,0,0],['#Car','CHECKING','NZD',0,0,0],['#Home','CHECKING','NZD',0,0,0],['/ Bills','CHECKING','NZD',0,0,0]];
const IX=(d,acc,amt,cat)=>[d,acc,'','Acme',amt,'','',cat,'id','NZD',amt,''];
const IS=ctx.invoiceSplit_([IX(new Date(2026,8,17),'Invoices',11500,'Income: Acme'),IX(new Date(2026,8,18),'Income GST',1500,'Transfer'),IX(new Date(2026,8,18),'Invoices',-1500,'Transfer'),
  IX(new Date(2026,8,18),'Income Tax',1000,'Transfer'),IX(new Date(2026,8,18),'Invoices',-1000,'Transfer'),
  IX(new Date(2026,8,24),'/ Bills',1800,'Transfer'),IX(new Date(2026,8,24),'/ Savings',-1800,'Transfer')],   // bills topped up from / Savings: not this invoice
  IT,IA,{savings:1000},[{a:'/ Bills',amt:2000}],0.34,new Date(2026,9,3));
eq(IS.lines.map(l=>[l[0],l[1],l[2],l[3]]),[['GST','Income GST',1500,'Done'],['Income tax (30% after GST)','Income Tax',3000,'Moved 1000 of 3000'],
  ['Bills top-up ($2000 budget)','/ Bills',2000,'To do'],['Savings: Car','#Car',700,'To do'],['Savings: House','#Home',300,'To do']]);
assert.strictEqual(IS.buffer,4000); assert.strictEqual(IS.amount,11500);   // no general savings account here, so it stays
const IS2=ctx.invoiceSplit_([IX(new Date(2026,8,17),'Invoices',11500,'Income: Acme')],IT,IA.map(r=>r[0]==='Invoices'?['Invoices','CHECKING','NZD',11500,0,11500]:r).concat([['/ Savings','CHECKING','NZD',0,0,0]]),{savings:1000},[{a:'/ Bills',amt:2000}],0.34,new Date(2026,9,3));
eq(IS2.lines[IS2.lines.length-1].slice(0,3),['Left over','/ Savings',4000]); assert.strictEqual(IS2.buffer,0);   // the rest goes to / Savings
const IT3=IT.concat([['Trip','Planned purchase','/ Savings',3000,new Date(2027,1,1),'','','','']]);
const IS3=ctx.invoiceSplit_([IX(new Date(2026,8,17),'Invoices',11500,'Income: Acme')],IT3,IA.map(r=>r[0]==='Invoices'?['Invoices','CHECKING','NZD',11500,0,11500]:r).concat([['/ Savings','CHECKING','NZD',0,0,0]]),{savings:1000},[{a:'/ Bills',amt:2000}],0.34,new Date(2026,9,3));
eq(IS3.lines.filter(l=>l[1]==='/ Savings').map(l=>[l[0],l[2]]),[['Set aside: Trip + left over',4000]]);   // one transfer per account
eq(ctx.invoiceSplit_([],IT,IA,{savings:1000},[],0.34,new Date(2026,9,3)),null);   // no payment in the last 60 days
// top-up: budget less what's been paid from the account this month in its categories, less what's already there
const ITU=ctx.invoiceSplit_([IX(new Date(2026,8,17),'Invoices',11500,'Income: Acme'),IX(new Date(2026,9,2),'/ Bills',-450,'Rent')],IT,
  IA.map(r=>r[0]==='Invoices'?['Invoices','CHECKING','NZD',11500,0,11500]:r[0]==='/ Bills'?['/ Bills','CHECKING','NZD',1325,0,1325]:r),{savings:1000},
  [{a:'/ Bills',amt:2250,cats:['Rent','Utilities']}],0.34,new Date(2026,9,3));
eq(ITU.lines.find(l=>/^Bills/.test(l[0])).slice(0,3),['Bills top-up ($2250 budget, $450 paid, $1325 there)','/ Bills',475]);
const IE=ctx.invoiceSplit_([IX(new Date(2026,8,17),'Invoices',11500,'Income: Acme')],IT,IA.map(r=>r[0]==='Invoices'?['Invoices','CHECKING','NZD',0,0,0]:r),{savings:1000},[],0.34,new Date(2026,9,3));
assert(IE.empty);   // everything moved out: nothing to do
const IE2=ctx.invoiceSplit_([IX(new Date(2026,8,17),'Invoices',11500,'Income: Acme'),[new Date(2026,9,3),'Invoices','/ Bills INTERNET XFR','',-2000,'','','Transfer','id','NZD',-2000,''],
  [new Date(2026,9,3),'Invoices','/ Savings INTERNET XFR','',-9500,'','','Transfer','id','NZD',-9500,'']],IT,IA.map(r=>r[0]==='Invoices'?['Invoices','CHECKING','NZD',0,0,0]:r),{savings:1000},[],0.34,new Date(2026,9,5));
eq([IE2.empty,IE2.amount,IE2.lines],[true,11500,[['Moved','/ Bills',2000,'Done'],['Moved','/ Savings',9500,'Done']]]);   // where it actually went
const I2=ctx.invoiceSplit_([IX(new Date(2026,7,17),'Invoices',11500,'Income: Acme'),IX(new Date(2026,8,17),'Invoices',11500,'Income: Acme')],IT,IA.map(r=>r[0]==='Invoices'?['Invoices','CHECKING','NZD',23000,0,23000]:r),{savings:1000},[],0.34,new Date(2026,9,3));
assert.strictEqual(I2.amount,23000);   // two invoices waiting: both get allocated
// daily email: cheeky coach format from real numbers
vm.runInContext('this.dailyEmailData_=dailyEmailData_;',ctx);
const EA=[['# Everyday','CHECKING','NZD',300,0,300],['# Monthly','CHECKING','NZD',2000,0,2000],['#Car','CHECKING','NZD',15000,0,15000]];
const ET=[['Savings','Monthly savings','',1000,'','','','',''],['Eating out','Spending limit','Eating out',300,'','','','',''],['Groceries','Spending limit','Groceries',600,'','','','',''],
  ['Car','Savings goal','#Car',20000,'','','',1,'',1]];
const EX=(d,acc,amt,cat,m)=>[d,acc,'',m,amt,'','',cat,'id','NZD',amt,''];
const ED=ctx.dailyEmailData_([EX(new Date(2026,9,4),'# Everyday',-200,'Eating out','Bar'),EX(new Date(2026,9,2),'# Everyday',-40,'Groceries','Shop')],EA,ET,new Date(2026,9,5,7),c=>'Everyday');
assert(ED.watch.alert && /Eating out: \$200 so far, already over the \$300 limit|Eating out: \$200 in 4 days/.test(ED.watch.lines[0]));
assert(/morning nudge: a word about eating out/.test(ED.subject));
assert(/Bar, \$200. Was that a shout\?/.test(ED.shout));
assert(/Car<\/b>: \$5,000 to go/.test(ED.goals[0]));
assert(ED.plan===null && typeof ED.question==='string');   // Monday: no Friday plan yet
const EF=ctx.dailyEmailData_([],EA,ET,new Date(2026,9,9,7),c=>'Everyday');
assert(EF.plan && !EF.watch.alert && /calm/.test(EF.subject));   // Friday: plan shown; nothing to watch
console.log('budget pass');
// net worth: where each balance comes from, and when it was last updated
const upd=new Date(2026,9,2);
const NWS=ctx.netWorthData_([['BNZ Everyday','CHECKING','NZD',100,0,100,upd,'a','BNZ']],
  [['Investment','Broker','Portfolio','CAD',1000,'','','',upd],['Cash','Broker','Save','CAD',500,'','','',''],['Investment','Broker','ETF','CAD','',2,'TSE:X','','']],{NZD:1,CAD:1.2},{'TSE:X':10});
eq(['BNZ Everyday','Portfolio','Save','ETF'].map(n=>NWS.rows.find(r=>r.account===n)).map(r=>[r.account,r.source,r.updated===upd]),[['BNZ Everyday','Synced',true],['Portfolio','Manual',true],['Save','Manual',false],['ETF','Manual, live price',false]]);
// exact names win over a longer name containing the text
vm.runInContext('this.findAccount_=findAccount_;',ctx);
eq([ctx.findAccount_('/ Savings',['/ Savings #Car','/ Savings']),ctx.findAccount_('kiwisaver',['KiwiSaver Min','My KiwiSaver']),ctx.findAccount_('nope',['a'])],['/ Savings','KiwiSaver Min','']);
console.log('net worth source pass');
// net worth tab as formulas you can click through
vm.runInContext('this.netWorthSheet_=netWorthSheet_;',ctx);
const NWF=ctx.netWorthData_([['Savings','CHECKING','NZD',1000,0,1000,'','a','BNZ'],['Card','CREDITCARD','NZD',-200,0,-200,'','b','BNZ']],
  [['Investment','Broker','Portfolio','CAD',500,'','','',''],['Investment','Broker','ETF','CAD','',2,'TSE:X','',''],['Reserved','','Tax pot','NZD',300,'','','','']],
  {NZD:1,CAD:1.2},{'TSE:X':10},[['Pot','Savings goal','Savings + Portfolio',4000,'','','',1,'']]);
const SF=ctx.netWorthSheet_(NWF);
const SR=n=>SF.out[NWF.rows.findIndex(r=>r.account===n)+1];
eq(SF.out[0].slice(3,6),['NZD','CAD','NZD value']);
assert.strictEqual(SR('Savings')[3],'=Accounts!D2'); assert.strictEqual(SR('Card')[3],'=-ABS(Accounts!D3)');
assert.strictEqual(SR('Portfolio')[4],'=N(Holdings!E2)'); assert.strictEqual(SR('ETF')[4],'=IFERROR(Holdings!F3*VLOOKUP(Holdings!G3,FX!$D:$E,2,FALSE),0)');
assert.strictEqual(SR('Portfolio')[5],'=IFERROR(E'+(NWF.rows.findIndex(r=>r.account==='Portfolio')+2)+'*VLOOKUP("CAD",FX!$A:$B,2,FALSE),"no rate")');
const rS=NWF.rows.findIndex(r=>r.account==='Savings')+2, rT=NWF.rows.findIndex(r=>r.account==='Portfolio')+2;
assert.strictEqual(SR('Savings')[7],'=IFERROR(MIN((F'+rS+'+F'+rT+')/G'+rS+',9.99),"")');   // a goal over two accounts
assert.strictEqual(SF.out[0][SF.nzdCol-1],'NZD value');   // the check reads the total from this column
const nwRowF=SF.out[SF.out.length-1]; assert.strictEqual(nwRowF[0],'Net worth'); assert.strictEqual(nwRowF[5],'=SUMIFS(F2:F6,$A$2:$A$6,"<>Reserved")');
assert(SF.out.some(r=>r[0]==='Reserved (not counted)'&&r[5]==='=SUMIF($A$2:$A$6,"Reserved",F2:F6)'));
assert.strictEqual(NWF.total,1000-200+500*1.2+20*1.2);   // the script's own working, which the sheet's formulas are checked against
const NWK=ctx.netWorthData_([['Everyday','CHECKING','NZD',1000,0,1000,'','a','BNZ'],['KiwiSaver Min','CHECKING','NZD',0,0,0,'','b','BNZ'],['My KiwiSaver','KIWISAVER','NZD',9000,0,9000,'','c','X']],
  [['Investment','Broker','Portfolio','NZD',500,'','','','']],{NZD:1},{},[]);
const SK=ctx.netWorthSheet_(NWK), lab=SK.out.map(r=>r[0]);
assert(lab.includes('Investment you can access')&&lab.includes('KiwiSaver (locked until a first home or 65)')&&lab[lab.length-1]==='Net worth you can access');
assert.strictEqual(SK.out[SK.worthRow-1][0],'Net worth');
const ksRow=SK.out.find(r=>/^KiwiSaver/.test(r[0])); assert(/"Investment",\$C\$2:\$C\$5,"\*kiwisaver\*"/.test(ksRow[SK.nzdCol-1]));   // only Investments, so KiwiSaver Min (cash) stays accessible
vm.runInContext('this.worthTiles_=worthTiles_;',ctx);
const WT=ctx.worthTiles_(ctx.netWorthData_([['Everyday','CHECKING','NZD',1000,0,1000,'','a','BNZ'],['Card','CREDITCARD','NZD',-200,0,-200,'','b','BNZ'],['My KiwiSaver','KIWISAVER','NZD',9000,0,9000,'','c','X'],['Income Tax','SAVINGS','NZD',5000,0,5000,'','d','BNZ']],
  [['Investment','Broker','Portfolio','NZD',500,'','','',''],['Owed to you','Dad','Loan to Dad','NZD',300,'','','','']],{NZD:1},{},[]));
eq(WT.map(k=>[k[0],k[1]]),[['Net worth',10600],['Cash',1000],['Invested',500],['KiwiSaver',9000],['Debt',-200],['Owed to you',300],['Set aside for tax (not counted)',5000]]);   // tax shown, not in net worth
console.log('net worth formulas pass');
// reserved tax accounts and type overrides
const NW4=ctx.netWorthData_([['Everyday','CHECKING','NZD',5000,0,5000,'','a','BNZ'],['GST','SAVINGS','NZD',8000,0,8000,'','b','BNZ'],
  ['Income Tax','SAVINGS','NZD',12000,0,12000,'','c','BNZ'],['Holiday','SAVINGS','NZD',900,0,900,'','d','BNZ']],
  [['Reserved','','Holiday','','','','',''],['Investment','Sharesies','Portfolio','CAD',1000,'','','']],{NZD:1,CAD:1.2},{});
const T4=n=>NW4.rows.find(r=>r.account===n).type;
assert.strictEqual(T4('GST'),'Reserved'); assert.strictEqual(T4('Income Tax'),'Reserved'); assert.strictEqual(T4('Holiday'),'Reserved');
assert.strictEqual(NW4.rows.length,5);                      // the override row adds no account
assert.strictEqual(NW4.total,6200); assert.strictEqual(NW4.byCurrency.NZD,5000);
assert.strictEqual(NW4.byType.find(x=>x[0]==='Reserved')[1],20900);
const D4=ctx.dashboardData_(S2,[],[['Everyday','CHECKING','NZD',5000,0,5000],['GST','SAVINGS','NZD',8000,0,8000]],[],[],[],[]);
assert.strictEqual(D4.kpis.find(k=>k[0]==='Runway')[1],1.5);   // 5000 / 3366.67, GST left out
console.log('reserved pass');
// three months in month over month
assert.strictEqual(D.mom.prev2Name,'Jun 2026'); assert.strictEqual(mo['Total spend'].prev2,3600);
// tax set-aside: money into a Reserved account comes off income; tax paid from it isn't spending
const ttx=[row(d(0),'Invoices',10000,'Uncategorised'), row(d(0),'Invoices',-3000,'Transfer'), row(d(0),'Income Tax',3000,'Transfer'),
  row(d(1),'Income Tax',-5000,'Tax payments'), row(d(2),'Everyday',-200,'Groceries')];
let tw; const ss5={getSheetByName:n=>n==='Transactions'?sheet(ttx):{clear(){},getRange:()=>({setValues:v=>{tw=v},setFontWeight(){},setNote(){},setNumberFormat(){return this}}),setFrozenRows(){}},getSpreadsheetTimeZone:()=>'UTC'};
const S5=ctx.buildSummary_(ss5,{},new Set(['income tax']));
const cm=S5.months[S5.months.length-1];
assert.strictEqual(S5.income[cm],7000); assert.strictEqual(S5.gross[cm],10000); assert.strictEqual(S5.totals[cm],200);
assert(tw.some(r=>r[0]==='  set aside for tax (30%)')); assert.strictEqual(S5.setAsideRate,0.3);
console.log('tax pass');
// month over month shows every month, the current one marked so far
assert.strictEqual(D.mom.labels.length,6); assert.strictEqual(D.mom.labels[5],'Sep 2026 (so far)');
eq(mo['Total spend'].values,[3000,3300,3600,3000,3500,900]);
console.log('mom pass');
// uncategorised tab
vm.runInContext('this.uncategorisedData_=uncategorisedData_;this.suggestMatch_=suggestMatch_;',ctx);
const tr=(date,acc,desc,merchant,amt,cat)=>[date,acc,desc,merchant,amt,'','',cat,'id','NZD',amt,''];
const U=ctx.uncategorisedData_([
  tr(d(0),'/ Bills','Mr A B Landlord & Mrs C','',-450,'Uncategorised'), tr(d(1),'/ Bills','Mr A B Landlord & Mrs C','',-450,'Uncategorised'),
  tr(d(2),'# Everyday','HARBOUR LODGE 93 TIL 1234 NELSON 55512345','',-1200,'Uncategorised'),
  tr(d(2),'# Everyday','FRIEND J T','',1000,'Uncategorised'),
  tr(d(2),'# Everyday','Uber','Uber',-20,'Transport'),                       // already categorised
  tr(d(2),'Income Tax','INLAND REVENUE','',-5000,'Uncategorised'),          // reserved account
  tr(new Date(2020,0,1),'# Everyday','OLD THING','',-99,'Uncategorised'),   // too old
], new Date(now.getFullYear(),now.getMonth()-3,1), new Set(['income tax']));
eq(U.map(u=>[u.match,u.money,u.count,u.total]),[['harbour lodge',"out",1,-1200],['friend j t','in',1,1000],['mr a b landlord & mrs','out',2,-900]]);
// every suggestion matches its own transactions as a rule
[['Mr A B Landlord & Mrs C',''],['HARBOUR LODGE 93 TIL 1234 NELSON 55512345',''],['110 CP GS NZSKI 1234 WANAKA',''],['ANTHROPIC* CLAUDE SU 1234','Anthropic']]
  .forEach(([desc,m])=>{ const match=ctx.suggestMatch_(m,desc);
    assert.strictEqual(ctx.myCategory_([{match,cat:'X',account:'',dir:''}],{description:desc,merchant:m,amount:-1}),'X',desc+' -> '+match); });
console.log('uncategorised pass');
assert.strictEqual(ctx.suggestMatch_('','SMZ*Corner Cafe Nels 1234 Nelson 5550001111'),'corner cafe nels');
assert.strictEqual(ctx.suggestMatch_('','TM *Ticketmaster 1234 ticketmaster'),'ticketmaster');
assert.strictEqual(ctx.myCategory_([{match:'*',cat:'Trips',account:'usd balance',dir:'out'}],{account:'Jo Bloggs USD Balance',description:'Box Mart',amount:-5}),'Trips');
assert.strictEqual(ctx.myCategory_([{match:'*',cat:'Trips',account:'usd balance',dir:'out'}],{account:'# Everyday',description:'Box Mart',amount:-5}),'Uncategorised');
console.log('wildcard pass');
// current subscriptions
const recentD=new Date(Date.now()-10*864e5), oldD=new Date(Date.now()-90*864e5);
const MR=[['Netflix','Entertainment','Lifestyle',22.99,275.88,1,6,'Yes',recentD,22.99],
  ['Notion','Work tools','Other',42,504,1,2,'',recentD,42],
  ['Meridian Energy','Bills','Bills',209,2508,1,6,'Yes',recentD,215],
  ['Old Gym','Personal care','Everyday',50,600,1,4,'Yes',oldD,50],
  ['Uber Eats','Eating out','Lifestyle',344,4128,8,6,'',recentD,30]];
const D5=ctx.dashboardData_(S2,MR,[],[],[],[]);
eq(D5.subscriptions.map(s=>s[0]),['Notion','Netflix']);
console.log('subscriptions pass');
const D6=ctx.dashboardData_(S2,[['Kebab','Fast food stores','Other',26.67,320,1,4,'Yes',recentD,17],['Kmart','General retail stores','Other',37,444,1,4,'Yes',recentD,30],
  ['LinkedIn','Advertising and marketing services','Other',39.99,480,1,5,'Yes',recentD,39.99],['Cursor','Business software and cloud services','Other',237,2851,1,6,'Yes',recentD,356]],[],[],[],[]);
eq(D6.subscriptions.map(s=>s[0]),['Cursor','LinkedIn']);
console.log('subscriptions tight pass');
// recurring payments split: subscriptions vs bills
const D7=ctx.dashboardData_(S2,[['Netflix','Entertainment','Lifestyle',22.99,276,1,6,'Yes',recentD,22.99],
  ['Meridian Energy','Bills','Bills',209,2508,1,6,'Yes',recentD,158],['MR LANDLORD','Rent','Bills',1950,23400,4.3,6,'',recentD,450],
  ['One-off Plumber','Bills','Bills',300,3600,1,1,'',recentD,300]],[],[],[],[]);
eq(D7.subscriptions.map(s=>s[0]),['Netflix']);
const S7=Object.assign({},S2,{spend:Object.assign({},S2.spend,{Rent:{'2026-06':1800,'2026-07':1350,'2026-08':1350},'Electricity services':{'2026-06':140,'2026-07':336,'2026-08':158}}),groupOfCat:{Rent:'Bills'}});
const D8=ctx.dashboardData_(S7,[['Meridian Energy','Electricity services','Other',211,2537,1,6,'Yes',recentD,158],['Cursor','Business software','Other',237,2851,1,6,'Yes',recentD,356]],[],[],[],[]);
eq(D8.subscriptions.map(s=>s[0]),['Cursor']);                              // power is never a subscription
eq(D8.livingCosts.map(c=>[c[0],c[1],c[2],c[3]]),[['Rent','',1350,1500],['Electricity services','Meridian Energy',158,211.33]]);
console.log('recurring split pass');
vm.runInContext('this.isLivingCost_=isLivingCost_;',ctx);
assert(ctx.isLivingCost_('Office','') && ctx.isLivingCost_('Electricity services','Other') && !ctx.isLivingCost_('Stationery and office supplies','Other') && !ctx.isLivingCost_('Subscriptions','Bills'));
console.log('living costs pass');
// Akahu categories map to the short set, and user rules still win
const AK=c=>ctx.myCategory_([],{category:c,amount:-1});
eq(['Internet services','Electricity services','Telecommunication services','Physiotherapy and massage therapy','Hotels, motels, and other temporary accommodation',
    'Bars, pubs, nightclubs','Gyms, fitness, aquatic facilities, yoga, pilates','Business software and cloud services','National government services','Some new thing'].map(AK),
   ['Utilities','Utilities','Utilities','Health','Trips','Eating out','Fitness','Software','Fees','Some new thing']);
assert.strictEqual(ctx.groupOf_({}, 'Software'),'Subscriptions'); assert.strictEqual(AK('Professional services'),'Work');
eq(ctx.groupOrder_(['Lifestyle','Other','Subscriptions','Bills','Mine']),['Bills','Subscriptions','Lifestyle','Other','Mine']);
assert.strictEqual(ctx.groupOf_({}, 'Utilities'),'Bills'); assert.strictEqual(ctx.groupOf_({}, 'Fitness'),'Lifestyle');
assert.strictEqual(ctx.myCategory_([{match:'skinny',cat:'Phone',account:'',dir:''}],{merchant:'Skinny',category:'Telecommunication services',amount:-50}),'Phone');
const RM=ctx.parseRules_([['pharmac','Personal care','','',''],['','Health & self-care','Everyday','','']],[['Personal care','Health & self-care'],['health','Health & self-care']]);
eq([ctx.myCategory_(RM.rules,{merchant:'Pharmacy',amount:-5}),ctx.myCategory_(RM.rules,{category:'Dental services',amount:-50}),
    ctx.myCategory_(RM.rules,{category:'Haircut',amount:-30}),ctx.myCategory_(RM.rules,{category:'Groceries',amount:-30})],
   ['Health & self-care','Health & self-care','Health & self-care','Groceries']);   // rules and Akahu's labels both merge
assert.strictEqual(RM.groups['health & self-care'],'Everyday');
eq([ctx.myCategory_([],{description:'WITHDRAWAL 5540 Woolworths',type:'ATM',amount:-850}),ctx.myCategory_([{match:'woolworths',cat:'Groceries',account:'',dir:''}],{description:'WITHDRAWAL Woolworths',type:'ATM',amount:-20})],
   ['ATM withdrawals','Groceries']);   // ATM cash is its own category; a rule still wins
assert.strictEqual(ctx.groupOf_({},'ATM withdrawals'),'Other');
const RI=ctx.parseRules_([['dad','Gifts','','','out']],[],[['t1','Loan']]);
eq([ctx.myCategory_(RI.rules,{merchant:'Dad',amount:-500,id:'t1'}),ctx.myCategory_(RI.rules,{merchant:'Dad',amount:-75,id:'t2'})],['Loan','Gifts']);
assert.strictEqual(ctx.groupOf_({},'Loan'),'Transfer');   // left out of spending and income
console.log('akahu map pass');
// rules kept in my-rules.gs: behaviour from the example (forks and CI have no my-rules.gs), and your own file's shape
const here=f=>require('path').join(__dirname,'../apps-script/'+f);
const yours=f=>fs.existsSync(here(f))?here(f):here(f+'.example');
const ctx2={Utilities:ctx.Utilities,console};vm.createContext(ctx2);
vm.runInContext(fs.readFileSync(here('my-rules.gs.example'),'utf8')+';'+fs.readFileSync(here('finance-sync.gs'),'utf8')+';this.p=parseRules_;this.c=myCategory_;this.MY=MY_RULES;this.g=groupOf_;',ctx2);
const R2=ctx2.p([['office landlord','Work','','','']].concat(ctx2.MY));
assert.strictEqual(ctx2.c(R2.rules,{description:'Office Landlord Ltd',amount:-202}),'Work');   // sheet rule first wins
const R3=ctx2.p(ctx2.MY);
assert.strictEqual(ctx2.c(R3.rules,{description:'Office Landlord Ltd',amount:-202}),'Office rent'); assert.strictEqual(ctx2.g(R3.groups,'Office rent'),'Bills');
assert.strictEqual(ctx2.c(R3.rules,{account:'Jo Bloggs USD Balance',merchant:'Il Salotto',amount:-30}),'Trips');
assert.strictEqual(ctx2.c(R3.rules,{account:'Jo Bloggs USD Balance',description:'Sent money to your name',amount:-300}),'Transfer');   // above the catch-all
const ctx4={};vm.createContext(ctx4);
vm.runInContext(fs.readFileSync(yours('my-rules.gs'),'utf8')+';this.MY=MY_RULES;this.E=MY_RULE_EDITS;this.S=MY_SUBSCRIPTIONS;this.V=MY_SERVICES;this.M=MY_CATEGORY_MERGES;this.T=MY_TRANSACTION_CATEGORIES;',ctx4);
assert(ctx4.MY.every(r=>r.length===5) && ctx4.E.every(e=>e.length===3) && ctx4.S.every(x=>typeof x==='string') && ctx4.V.every(v=>v.length===3) && ctx4.M.every(m=>m.length===2) && ctx4.T.every(m=>m.length===2));
console.log('my rules pass');
// income sources
vm.runInContext('this.incomeSource_=incomeSource_;',ctx);
eq(['Income: Acme','Income','Income: Other','Uncategorised','income : Acme'].map(ctx.incomeSource_),['Acme','Other','Other','Other','Acme']);
const S9=Object.assign({},S2,{incomeBy:{Acme:{'2026-08':5000},Other:{'2026-08':200}},setAsideRate:0.3,setAside:{'2026-08':1560}});
const D9=ctx.dashboardData_(S9,[],[],[],[],[]);
eq(D9.mom.rows.slice(0,6).map(r=>r.name),['Income','    Acme','    Other','    Set aside for tax & GST (30%)','Total spend','Left over']);
assert.strictEqual(D9.mom.rows[3].last,-1560);
const DI=ctx.dashboardData_(Object.assign({},S9,{expectedIncome:['Acme','SideCo']}),[],accounts,[],[],[]);
eq(DI.mom.rows.filter(r=>r.kind==='incomePart').map(r=>r.name.trim()).slice(0,3),['Acme','SideCo','Other']);   // a source with a rule shows before it pays
assert(DI.mom.rows.find(r=>r.name.trim()==='SideCo').values.every(v=>v===0));
console.log('income sources pass');
// rule edits
vm.runInContext('this.ruleEdits_=ruleEdits_;',ctx);
const RV=[['acme payroll ltd','Income'],['Acme Payroll Ltd','Income: Acme'],['mr a b landlord & mrs','Rent']];
assert.strictEqual(ctx.ruleEdits_(RV,[['acme payroll ltd','Income','Income: Acme']]),1);
eq(RV.map(r=>r[1]),['Income: Acme','Income: Acme','Rent']);
assert.strictEqual(ctx.ruleEdits_(RV,[['acme payroll ltd','Income','Income: Acme']]),0);   // idempotent
console.log('rule edits pass');
// savings actions from my-actions.gs
const ctx3={Utilities:ctx.Utilities,console};vm.createContext(ctx3);
vm.runInContext(fs.readFileSync(yours('my-actions.gs'),'utf8')+';this.MA=MY_ACTIONS;',ctx3);
assert(ctx3.MA.every(a=>a.length===14 && typeof a[3]==='number' && (!a[11] || typeof a[12]==='number')));   // anything tracked has a baseline
console.log('savings actions pass');

// action sync: renames keep your status, Claude's columns refresh, new ones added; Open becomes Committed
vm.runInContext('this.syncActions_=syncActions_;this.trackAction_=trackAction_;',ctx);
const cur=[[2,'Halve Uber Eats','Eating out',170,'Medium','old','2026-09-29','2026-10-31','Suggested','',''],
           [4,'Cancel ClassPass','Fitness',79,'Low','ev','2026-09-29','2026-10-06','Open','','']];
const mine=[[1,'Stop Uber Eats','Eating out',380,'Medium','new ev','2026-09-30','2026-10-31','Committed','','','uber eats',380,0],
            [4,'Cancel ClassPass','Fitness',79,'Low','ev2','2026-09-29','2026-10-06','Suggested','','','classpass',79,0],
            [9,'Set a travel budget','Trips',1100,'High','ev','2026-09-30','','Suggested','','','category:Trips',3120,2000]];
const SY=ctx.syncActions_(cur,mine,[['Halve Uber Eats','Stop Uber Eats']]);
eq(SY.map(r=>[r[1],r[8],r[3],r[11]]),[['Stop Uber Eats','Committed',380,'uber eats'],['Cancel ClassPass','Committed',79,'classpass'],['Set a travel budget','Suggested',1100,'category:Trips']]);
assert.strictEqual(SY[1][5],'ev2'); assert.strictEqual(SY[0][6],'2026-09-29');   // added date kept
// tracking
const TV=[['','# Everyday','Uber Eats order','Uber Eats',-40,'','','Eating out','','NZD',-40,''],['','# Everyday','Uber Eats order','Uber Eats',-35,'','','Eating out','','NZD',-35,''],
          ['','# Everyday','Airbnb','Airbnb',-900,'','','Trips','','NZD',-900,''],['','# Everyday','Uber trip','Uber',-12,'','','Transport','','NZD',-12,'']]
  .map((r,i)=>Object.assign(r,{month:i===1?'2026-09':'2026-08'}));
eq(ctx.trackAction_(TV,SY[0],'2026-08','2026-09'),[40,35,'Started 2026-09: $35 so far this month, target $0']);
eq(ctx.trackAction_(TV,SY[0],'2026-09','2026-10'),[35,0,'Over target by $35 last month']);
eq(ctx.trackAction_(TV,SY[2],'2026-08','2026-09'),[900,0,'Not committed. Started 2026-09: $0 so far this month, target $2000']);
eq(ctx.trackAction_(TV,SY[2],'2026-08','2026-09').length,3);
eq(ctx.trackAction_(TV,[1,'x','',0,'','','','','Committed','','','uber eats|airbnb',1000,1000],'2026-08','2026-09'),[940,35,'On target last month, saved $60']);
console.log('action tracking pass');
eq(ctx.trackAction_(TV,[1,'x','',0,'','','','','Committed','','','uber|!uber eats',166,80],'2026-08','2026-09'),[12,0,'On target last month, saved $154']);
console.log('exclude pass');
// recurring charge detection
vm.runInContext('this.recurringCharges_=recurringCharges_;',ctx);
const RT=(y,m,dd,desc,merchant,amt,cat)=>[new Date(y,m,dd),'# Everyday',desc,merchant,amt,'','',cat,'id','NZD',amt,''];
const today2=new Date(2026,8,30);
const RC=ctx.recurringCharges_([
  RT(2026,6,15,'FIGMA','Figma',-36,'Work'),RT(2026,7,15,'FIGMA','Figma',-36,'Work'),RT(2026,8,15,'FIGMA','Figma',-36,'Work'),
  RT(2026,8,3,'Les Mills','Les Mills',-35,'Fitness'),RT(2026,8,10,'Les Mills','Les Mills',-35,'Fitness'),RT(2026,8,17,'Les Mills','Les Mills',-35,'Fitness'),
  RT(2026,8,23,'BRIGHTWORKS, INC. 1234 NOTELY.CO','',-30,'Work'),                                       // new, known
  RT(2026,3,1,'MIDJOURNEY','Midjourney',-50,'Work'),RT(2026,4,1,'MIDJOURNEY','Midjourney',-50,'Work'), // stopped
  RT(2026,8,1,'Uber Eats','Uber Eats',-44,'Eating out'),RT(2026,8,9,'Uber Eats','Uber Eats',-61,'Eating out'),RT(2026,8,20,'Uber Eats','Uber Eats',-23,'Eating out'),
  RT(2025,9,20,'ANNUAL APP','Annual App',-120,'Work'),RT(2026,8,21,'ANNUAL APP','Annual App',-120,'Work')      // yearly
],today2,['notely']);
const RN=Object.fromEntries(RC.map(r=>[r.name,r]));
assert.strictEqual(RN['Figma'].kind,'monthly'); assert.strictEqual(RN['Les Mills'].kind,'weekly'); assert.strictEqual(Math.round(RN['Les Mills'].perMonth),152);
assert(RN['Notely']&&RN['Notely'].known); assert(!RN['Midjourney']); assert(!RN['Uber Eats']);
assert.strictEqual(RN['Annual App'].kind,'yearly'); assert.strictEqual(RN['Annual App'].perMonth,10);
console.log('recurring pass');
// subscriptions vs recurring services
const D10=ctx.dashboardData_(S2,[],[],[],[],[],[],[
  {name:'Figma',category:'Work',kind:'monthly',typical:36,perMonth:36,last:new Date(),lastAmt:36,count:3,known:true},
  {name:'Headspace',category:'Fitness',kind:'monthly',typical:9,perMonth:9,last:new Date(),lastAmt:9,count:9,known:true},
  {name:'Les Mills',category:'Fitness',kind:'weekly',typical:35,perMonth:152,last:new Date(),lastAmt:35,count:9,known:false},
  {name:'The Barbers Room',category:'Personal care',kind:'monthly',typical:52,perMonth:52,last:new Date(),lastAmt:52,count:9,known:false}]);
eq(D10.subscriptions.map(s=>s[0]),['Figma','Headspace']); eq(D10.services.map(s=>s[0]),['Les Mills','The Barbers Room']);
assert.strictEqual(ctx.myCategory_([],{category:'Financial asset brokers, exchanges, and managed funds',amount:-2000}),'Transfer');
console.log('services pass');
// regular services paid per visit or in packs
vm.runInContext('this.regularServices_=regularServices_;',ctx);
const GV=[RT(2026,3,26,'BLUE DOOR STUDIO','',-300,'Fitness'),RT(2026,5,3,'BLUE DOOR STUDIO','',-35,'Fitness'),RT(2026,7,13,'Blue Door Studio Ltd','',-70,'Fitness'),
  RT(2026,8,22,'Blue Door Studio Ltd','',-36,'Fitness'),RT(2025,0,1,'BLUE DOOR STUDIO','',-999,'Fitness')];
const RS=ctx.regularServices_(GV,new Date(2026,8,30),[['blue door','Blue Door','Fitness']]);
assert.strictEqual(RS.length,1); assert.strictEqual(RS[0].perMonth,Math.round((300+35+70)/6*100)/100); assert.strictEqual(RS[0].kind,'0.5 visits/mo');
assert.strictEqual(RS[0].lastAmt,36); assert(RS[0].service);
console.log('regular services pass');
