// Actual Expo components with synthetic transport; no shared TEST writes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const origin=process.env.MOBILE_QA_ORIGIN||'http://localhost:8081';
assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname));
const out=resolve('.context/mobile-six-tabs-qa');mkdirSync(out,{recursive:true});
const identity=spawnSync('agent-browser',['session','id','--scope','worktree','--prefix','six-tabs'],{encoding:'utf8'});
assert.equal(identity.status,0);const session=identity.stdout.trim();
const report={startedAt:new Date().toISOString(),synthetic:true,checks:[],session};
function browser(...args){
 const r=spawnSync('agent-browser',['--session',session,'--json',...args],{encoding:'utf8',timeout:60000});
 assert.equal(r.status,0,r.stdout+r.stderr);const v=JSON.parse(r.stdout);assert(v.success,JSON.stringify(v.error));return v.data;
}
const evaluate=code=>browser('eval',code).result;
const click=(role,name)=>browser('find','role',role,'click','--name',name,'--exact');
const labels=()=>evaluate(`Array.from(document.querySelectorAll('[role="tablist"]:has([aria-label="Prehľad"]):has([aria-label="Moduly"]) [role="tab"]')).map(e=>e.getAttribute('aria-label').split(',')[0])`);
function check(name,value){assert(value,name);report.checks.push(name);}
function capture(name){
 check(name+': six tabs',labels().length===6);
 check(name+': no horizontal overflow',evaluate('document.documentElement.scrollWidth<=innerWidth'));
 const targets=evaluate(`Array.from(document.querySelectorAll('[role="tablist"]:has([aria-label="Prehľad"]):has([aria-label="Moduly"]) [role="tab"]')).map(e=>({label:e.getAttribute('aria-label'),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))`);
 check(name+': actual targets at least44points '+JSON.stringify(targets),targets.every(t=>t.width>=43.5&&t.height>=43.5));
 browser('screenshot',resolve(out,name+'.png'));
}
try{
 browser('--executable-path','/usr/bin/google-chrome','open','--init-script',resolve('tests/mobile/ui-redesign-fixture.js'),origin+'/?fixture=all');
 browser('set','viewport','390','844');browser('wait','[aria-label="E-mail"]');
 browser('fill','[aria-label="E-mail"]','person@example.invalid');browser('fill','[aria-label="Heslo"]','synthetic-password');
 click('button','Prihlásiť sa');browser('wait','--text','Treba riešiť');
 check('new default has four chosen modules between fixed tabs',JSON.stringify(labels())===JSON.stringify(['Prehľad','Hovory','Prípady','Moje úlohy','Nástroje','Moduly']));
 for(const [width,height]of[[320,568],[390,844],[768,1024]]){
  browser('set','viewport',String(width),String(height));capture('default-'+width);
 }
 browser('set','viewport','390','844');click('tab','Moduly');browser('wait','--text','7 dostupných modulov');
 click('button','Upraviť lištu');browser('wait','--text','4 z 4');
 click('button','Odobrať Nástroje z lišty');browser('wait','--text','3 z 4');
 click('button','Pridať Pristavenia do lišty');browser('wait','--text','4 z 4');
 check('fourth custom field module is added',labels().includes('Pristavenia'));
 click('button','Pridať Pobočka do lišty');browser('wait','--text','Lišta je plná.');
 check('fifth module asks for replacement instead of expanding bar',labels().length===6&&!labels().includes('Pobočka'));
 click('button','Nahradiť Hovory');
 check('replacement retains fixed tabs',labels()[0]==='Prehľad'&&labels().at(-1)==='Moduly'&&labels().includes('Pobočka'));
 click('button','Pridať Moja práca do lišty');click('button','Nahradiť Prípady');
 click('button','Pridať Nástroje do lišty');click('button','Nahradiť Moje úlohy');
 click('button','Posunúť Pobočka nižšie');
 const chosen=['Prehľad','Moja práca','Pobočka','Nástroje','Pristavenia','Moduly'];
 check('all four custom slots reorder independently',JSON.stringify(labels())===JSON.stringify(chosen));
 click('button','Hotovo');
 for(const [width,height]of[[320,568],[390,844],[768,1024]]){
  browser('set','viewport',String(width),String(height));capture('custom-'+width);
 }
 click('tab','Prehľad');click('tab','Moduly');
 check('four chosen modules and ordering survive navigation',JSON.stringify(labels())===JSON.stringify(chosen));
 browser('set','viewport','320','568');
 // RN Web pins fontScale to1. Mount the actual Dock component in a dev-only
 // isolated root; label CSS supplies the native text-size equivalent.
 const scale=evaluate(`(()=>{
  const modules=Array.from(__r.getModules());
  const find=name=>modules.find(([,m])=>m.verboseName?.includes('/exports/'+name+'/index.js'))?.[0];
  const dim=find('Dimensions'),registry=find('AppRegistry');
  const loaded=modules.flatMap(([,m])=>[m.publicModule?.exports,m.publicModule?.exports?.default]);
  const React=loaded.find(e=>e&&typeof e.createElement==='function'&&typeof e.useState==='function');
  const safe=loaded.find(e=>e&&typeof e.SafeAreaProvider==='function'&&typeof e.useSafeAreaInsets==='function');
  const Dock=loaded.find(e=>e&&typeof e.DockTabBar==='function')?.DockTabBar;
  if(dim===undefined||registry===undefined||!Dock||!React||!safe)return{ok:false,reason:'Metro modules unavailable',dim,registry,dock:!!Dock,react:!!React,safe:!!safe};
  const D=__r(dim).default,A=__r(registry).default,original=D.get.bind(D);
  D.get=name=>({...original(name),fontScale:2});
  function QA(){const[tabs,setTabs]=React.useState(['prehlad','praca','pobocka','nastroje','pristavenia','moduly']);window.__setSixTabQA=setTabs;return React.createElement(safe.SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,left:0,right:0,bottom:0}}},React.createElement(Dock,{tabs,selected:'moduly',badges:{},showAdd:false,onSelect:()=>{},onAdd:()=>{}}))}
  document.getElementById('root').remove();
  const root=document.createElement('div');root.id='nav-font-scale-qa';root.style.cssText='display:flex;position:fixed;inset:0;background:#f2f2f7';document.body.appendChild(root);
  A.registerComponent('SixTabScaleQA',()=>QA);A.runApplication('SixTabScaleQA',{rootTag:root});return{ok:true};
 })()`);
 check('2x navigation layout uses real fontScale branch '+JSON.stringify(scale),scale.ok);
 browser('wait','[role="tablist"]:has([aria-label="Prehľad"]):has([aria-label="Moduly"])');
 check('2x component retains six configured tabs',JSON.stringify(labels())===JSON.stringify(chosen));
 check('2x component reserves expanded native layout height',evaluate(`document.querySelector('[role="tablist"]').parentElement.getBoundingClientRect().height>=127.5`));
 evaluate(`Array.from(document.querySelectorAll('[role="tablist"]:has([aria-label="Prehľad"]):has([aria-label="Moduly"]) [role="tab"]')).map(e=>e.lastElementChild).map(e=>({e,size:parseFloat(getComputedStyle(e).fontSize),line:parseFloat(getComputedStyle(e).lineHeight)})).forEach(({e,size,line})=>{e.style.fontSize=(size*2)+'px';e.style.lineHeight=(line*2)+'px'})`);
 capture('custom-320-font2x-emulated');
 check('2x tabs form two rows of three',evaluate(`(()=>{const rows={};for(const e of document.querySelectorAll('[role="tablist"] [role="tab"]')){const top=Math.round(e.getBoundingClientRect().top);rows[top]=(rows[top]||0)+1}return Object.values(rows).length===2&&Object.values(rows).every(n=>n===3)})()`));
 check('2x labels remain whole words without letter fragments',evaluate(`Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).every(e=>{const t=e.lastElementChild;return t.scrollHeight<=t.clientHeight+1&&t.getBoundingClientRect().height<=parseFloat(getComputedStyle(t).lineHeight)+1})`));
 browser('wait','--fn',`(()=>{const row=document.querySelector('[role="tablist"]'),lens=row.firstElementChild.getBoundingClientRect(),selected=row.querySelector('[aria-selected="true"]').getBoundingClientRect();return Math.abs(lens.left-selected.left)<1&&Math.abs(lens.top-selected.top)<1&&Math.abs(lens.height-selected.height)<1})()`);
 check('selected lens aligns with the second-row tab',true);
 evaluate(`__setSixTabQA(['prehlad','praca','pobocka','nastroje','moduly'])`);
 browser('wait','--fn',`document.querySelectorAll('[role="tablist"] [role="tab"]').length===5`);
 check('five-item accessibility layout has one inert spacer',evaluate(`Array.from(document.querySelector('[role="tablist"]').children).filter(e=>!e.hasAttribute('role')&&!e.textContent&&e.childElementCount===0&&e.tabIndex<0&&getComputedStyle(e).pointerEvents==='none'&&getComputedStyle(e).position!=='absolute').length===1`));
 check('Moduly remains at bottom right with five items',evaluate(`(()=>{const row=document.querySelector('[role="tablist"]').getBoundingClientRect(),last=document.querySelector('[role="tab"][aria-label="Moduly"]').getBoundingClientRect();return Math.abs(last.right-row.right)<1&&last.top>row.top+20})()`));
 browser('screenshot',resolve(out,'custom-320-font2x-five-items.png'));
 report.status='passed';report.finishedAt=new Date().toISOString();
}catch(error){report.status='failed';report.error=error.message;throw error;}
finally{writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,report:resolve(out,'report.json')}));try{browser('close')}catch{}}
