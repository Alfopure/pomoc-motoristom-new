// Real Expo UI, composed synthetic transport. No TEST/provider data or writes.
// Run from repository root after starting Metro: node tests/mobile/simple-tasks-smoke.mjs
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const origin=process.env.MOBILE_QA_ORIGIN||'http://localhost:8081';
const url=new URL(origin);
assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.protocol==='http:','Use only isolated local Expo web');
const out=resolve(process.env.MOBILE_QA_OUTPUT||'.context/simple-tasks-qa');mkdirSync(out,{recursive:true});
const init=resolve(out,'composed-fixture.js');
writeFileSync(init,readFileSync('tests/mobile/ui-redesign-fixture.js','utf8')+'\n'+readFileSync('tests/mobile/simple-tasks-fixture.js','utf8'));
const report={source:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),startedAt:new Date().toISOString(),synthetic:true,checks:[],sessions:[],screenshots:[]};
let session;
function newSession(kind){
  const result=spawnSync('agent-browser',['session','id','--scope','worktree','--prefix',`simple-tasks-${kind}-${Date.now()}`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);session=result.stdout.trim();report.sessions.push(session);
}
function browser(...args){
  const result=spawnSync('agent-browser',['--session',session,'--json',...args],{encoding:'utf8',timeout:60_000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const reply=JSON.parse(result.stdout);assert(reply.success,JSON.stringify(reply.error));return reply.data;
}
const evaluate=code=>browser('eval',code).result;
const wait=code=>browser('wait','--fn',code);
const button=name=>browser('find','role','button','click','--name',name,'--exact');
const namedButton=name=>`Array.from(document.querySelectorAll('[role="button"]')).find(e=>(e.getAttribute('aria-label')||e.textContent.trim())===${JSON.stringify(name)}&&e.getBoundingClientRect().width>0)`;
const hasButton=name=>evaluate(`Boolean(${namedButton(name)})`);
const waitButton=name=>wait(`Boolean(${namedButton(name)})`);
const tab=name=>browser('find','role','tab','click','--name',name,'--exact');
const fill=(name,value)=>browser('fill',`[aria-label=${JSON.stringify(name)}]`,value);
const exists=selector=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const bodyIncludes=text=>evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
function check(name,value){assert(value,name);report.checks.push(name);}
function top(){evaluate(`document.querySelectorAll('*').forEach(e=>{if(e.scrollHeight>e.clientHeight+5&&['auto','scroll'].includes(getComputedStyle(e).overflowY))e.scrollTop=0});window.scrollTo(0,0)`);}
function capture(name){
  top();
  check(name+': no horizontal overflow',evaluate('document.documentElement.scrollWidth<=innerWidth'));
  const small=evaluate(`Array.from(document.querySelectorAll('[role="button"],[role="tab"],input,textarea')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[aria-hidden="true"]')&&(r.width<43.5||r.height<43.5)}).map(e=>({label:e.getAttribute('aria-label')||e.innerText,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))`);
  check(name+': labeled controls at least44points '+JSON.stringify(small),small.length===0);
  const path=resolve(out,name+'.png');browser('screenshot',path);report.screenshots.push(path);
}
function selectPrefix(prefix){
  const selector=`[role="button"][aria-label^=${JSON.stringify(prefix)}]`;
  browser('wait',selector);browser('click',selector);
}
function tasksRoot(){tab('Úlohy');waitButton('+ Nová úloha');}
function back(){button('Späť na Úlohy');waitButton('+ Nová úloha');}
function newTask(title){button('+ Nová úloha');browser('wait','[aria-label="Čo treba urobiť?"]');fill('Čo treba urobiť?',title);}
function choosePerson(name){selectPrefix('Komu:');browser('wait','--text','Komu patrí úloha?');button('Kolega');button(name);waitButton('Vytvoriť úlohu');}
function signIn(field=false){
  newSession(field?'field':'office');
  // agent-browser wraps fetch after init scripts. These synthetic API origins
  // must reach the fixture; the fixture itself rejects external fallthrough.
  browser('--allowed-domains','localhost,127.0.0.1,test.dispecing.linkapomoci.sk,nzpnqdstvkfncflgqlny.supabase.co','--executable-path','/usr/bin/google-chrome','open','--init-script',init,origin+(field?'/?fixture=field':'/'));
  browser('set','viewport','390','844');browser('wait','[aria-label="E-mail"]');
  fill('E-mail','person@example.invalid');fill('Heslo','synthetic-password');button('Prihlásiť sa');
  wait(`!!document.querySelector('[role="tab"][aria-label="Úlohy"]')`);
  tasksRoot();
}
function assertIsolated(name){
  const unexpected=evaluate(`__mobileFixture.requests.filter(r=>r.method!=='GET'&&!['/auth/v1/token','/auth/v1/logout'].includes(r.path)&&!r.path.startsWith('/api/mobile/v1/tasks/workspace'))`);
  check(name+': only intercepted synthetic task mutations '+JSON.stringify(unexpected),unexpected.length===0);
  report[name+'Transport']=evaluate(`({requestCount:__mobileFixture.requests.length,taskRequestCount:__simpleTasksFixture.requests.length,mutations:__simpleTasksFixture.mutations,created:__simpleTasksFixture.created})`);
}

try{
  signIn();
  for(const [width,height]of [[320,568],[390,844]]){
    browser('set','viewport',String(width),String(height));capture('office-list-'+width);
    check('office-list-'+width+': root has visible create action',hasButton('+ Nová úloha'));
  }
  newTask('Samostatná úloha bez prípadu');
  check('new task defaults to myself',exists('[aria-label="Komu: Ja"]'));
  for(const [width,height]of [[320,568],[390,844]]){browser('set','viewport',String(width),String(height));capture('office-create-'+width);}
  selectPrefix('Termín:');browser('wait','--text','Dokedy?');button('Zajtra do konca dňa');
  choosePerson('Martin Ukážkový');capture('office-create-colleague-390');button('Vytvoriť úlohu');
  browser('wait','--text','Priebeh a správy');
  check('standalone create assigns selected colleague without case/ISO entry',evaluate(`(()=>{const t=__simpleTasksFixture.tasks.find(t=>t.title==='Samostatná úloha bez prípadu');return t&&t.assignee.displayName==='Martin Ukážkový'&&t.caseLinks.length===0&&t.dueAt!==null})()`));
  capture('office-colleague-detail-390');
  button('Zmeniť riešiteľa');browser('wait','--text','Komu patrí úloha?');button('Jana Testovacia (ja)');
  waitButton('Začať riešiť');button('Začať riešiť');waitButton('Označiť ako hotové');
  fill('Správa','Vozidlo je pripravené, kolega môže pokračovať.');button('Odoslať správu');
  wait(`document.body.innerText.includes('Vozidlo je pripravené, kolega môže pokračovať.')&&document.querySelector('[aria-label="Správa"]').value===''`);
  capture('office-working-detail-390');button('Označiť ako hotové');waitButton('Znovu otvoriť');
  check('completion is explicit and visible',bodyIncludes('Hotovo'));button('Znovu otvoriť');waitButton('Začať riešiť');
  back();button('Pobočka');selectPrefix('Pripraviť vozidlo na pobočke.');waitButton('Prevezmem');
  check('branch lead sees both ownership choices',hasButton('Prideliť kolegovi'));capture('office-branch-queue-390');
  button('Prevezmem');waitButton('Začať riešiť');
  check('taking branch task keeps its branch and appoints myself',evaluate(`(()=>{const t=__simpleTasksFixture.tasks.find(t=>t.title==='Pripraviť vozidlo na pobočke');return t.assignee.userId==='00000000-0000-4000-8000-000000000001'&&t.group.name==='Žilina'})()`));
  back();newTask('Úloha pre pobočku');selectPrefix('Komu:');button('Pobočka');button('Žilina');button('Vytvoriť úlohu');
  waitButton('Prideliť kolegovi');button('Prideliť kolegovi');button('Kolega');button('Lucia Ukážková');
  browser('wait','--text','Priebeh a správy');
  check('branch lead delegates queued task directly',evaluate(`(()=>{const t=__simpleTasksFixture.tasks.find(t=>t.title==='Úloha pre pobočku');return t.assignee.displayName==='Lucia Ukážková'&&t.group.name==='Žilina'})()`));
  capture('office-branch-delegated-390');back();

  newTask('Úloha po krátkom výpadku');evaluate(`__simpleTasksFixture.failNextMutation='uncertain'`);button('Vytvoriť úlohu');
  waitButton('Overiť pôvodné vytvorenie');capture('office-create-uncertain-390');
  check('uncertain create locks new create',!hasButton('Vytvoriť úlohu'));
  button('Overiť pôvodné vytvorenie');browser('wait','--text','Priebeh a správy');
  check('uncertain creation retry reuses exact command and creates one task',evaluate(`(()=>{const writes=__simpleTasksFixture.mutations.filter(r=>r.path==='tasks/workspace'&&r.input.title==='Úloha po krátkom výpadku');return writes.length===2&&writes[0].input.commandId===writes[1].input.commandId&&__simpleTasksFixture.tasks.filter(t=>t.title==='Úloha po krátkom výpadku').length===1})()`));
  evaluate(`__simpleTasksFixture.failNextMutation='uncertain'`);button('Začať riešiť');waitButton('Overiť pôvodnú požiadavku');
  button('Overiť pôvodnú požiadavku');waitButton('Označiť ako hotové');
  check('uncertain state retry preserves command ID',evaluate(`(()=>{const writes=__simpleTasksFixture.mutations.slice(-2);return writes.every(r=>r.input.action==='start')&&writes[0].input.commandId===writes[1].input.commandId})()`));
  fill('Správa','Tento text zostane po konflikte.');evaluate(`__simpleTasksFixture.failNextMutation='conflict'`);button('Odoslať správu');
  browser('wait','--text','Úloha sa medzitým zmenila');
  wait(`document.querySelector('[aria-label="Správa"]').value==='Tento text zostane po konflikte.'&&(${namedButton('Odoslať správu')})?.getAttribute('aria-disabled')!=='true'`);
  check('409 preserves the typed comment',evaluate(`document.querySelector('[aria-label="Správa"]').value==='Tento text zostane po konflikte.'`));
  capture('office-comment-conflict-390');button('Odoslať správu');
  wait(`document.querySelector('[aria-label="Správa"]').value===''`);
  check('retry after409 uses latest revision and a new command',evaluate(`(()=>{const writes=__simpleTasksFixture.mutations.slice(-2);return writes.every(r=>r.input.action==='comment')&&writes[0].input.commandId!==writes[1].input.commandId&&writes[1].input.expectedRevision>writes[0].input.expectedRevision})()`));
  back();fill('Hľadať úlohu','nenájdená skúšobná úloha');browser('wait','--text','Nenašla sa žiadna úloha');
  browser('set','viewport','320','568');capture('office-empty-search-320');
  evaluate(`__simpleTasksFixture.readsFail=true`);fill('Hľadať úlohu','výpadok');browser('wait','--text','Úlohy sa nepodarilo načítať.');
  check('source error does not masquerade as completed work',!bodyIncludes('Tu je všetko vybavené'));capture('office-read-error-320');
  assertIsolated('office');browser('close');

  signIn(true);
  check('field-only employee has Tasks without dispatch modules',evaluate(`!!document.querySelector('[role="tab"][aria-label="Úlohy"]')&&!document.querySelector('[role="tab"][aria-label="Prípady"]')&&!document.querySelector('[role="tab"][aria-label="Hovory"]')`));
  for(const [width,height]of [[320,568],[390,844]]){browser('set','viewport',String(width),String(height));capture('field-list-'+width);}
  newTask('Úloha vytvorená vodičom');choosePerson('Martin Ukážkový');button('Vytvoriť úlohu');browser('wait','--text','Priebeh a správy');
  check('field-only employee creates task for another colleague',evaluate(`(()=>{const t=__simpleTasksFixture.tasks.find(t=>t.title==='Úloha vytvorená vodičom');return t&&t.createdBy.displayName==='Vodič Testovací'&&t.assignee.displayName==='Martin Ukážkový'&&t.caseLinks.length===0})()`));
  check('field Tasks never fetches dispatch cases or console',evaluate(`!__mobileFixture.requests.some(r=>r.path.startsWith('/api/mobile/v1/cases')||r.path==='/api/mobile/v1/console')`));
  capture('field-colleague-detail-390');assertIsolated('field');
  report.status='passed';report.finishedAt=new Date().toISOString();
}catch(error){
  report.status='failed';report.error=error.message;
  if(session){try{report.failureSnapshot=browser('snapshot','-i');browser('screenshot',resolve(out,'failure.png'));}catch{}}
  throw error;
}finally{
  writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,report:resolve(out,'report.json')}));
  if(session){try{browser('close');}catch{}}
}
