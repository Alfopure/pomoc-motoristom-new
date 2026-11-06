// Optional task tools in real Expo UI with synthetic Auth/API/Storage only.
// After starting Metro: node tests/mobile/task-extensions-smoke.mjs
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const origin=process.env.MOBILE_QA_ORIGIN||'http://localhost:8081';
const url=new URL(origin);
assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.protocol==='http:','Use only isolated local Expo web');
const out=resolve(process.env.MOBILE_QA_OUTPUT||'.context/task-extensions/ui');mkdirSync(out,{recursive:true});
const init=resolve(out,'composed-fixture.js');
writeFileSync(init,'window.__taskLocalMediaFetch=window.fetch.bind(window);(()=>{const click=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type==="file"){if(!this.isConnected)document.body.appendChild(this);return;}return click.call(this);};const dispatch=HTMLInputElement.prototype.dispatchEvent;HTMLInputElement.prototype.dispatchEvent=function(event){if(this.type==="file"&&event.type==="click")return true;return dispatch.call(this,event);};})();\n'+readFileSync('tests/mobile/ui-redesign-fixture.js','utf8')+'\n'+readFileSync('tests/mobile/simple-tasks-fixture.js','utf8'));
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
const button=name=>{evaluate(`(${namedButton(name)})?.scrollIntoView({block:'center',inline:'nearest'})`);return browser('find','role','button','click','--name',name,'--exact');};
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

const currentTask = title => `__simpleTasksFixture.tasks.find(t=>t.title===${JSON.stringify(title)})`;
function more(){ if(hasButton('Ďalšie možnosti úlohy'))button('Ďalšie možnosti úlohy'); }
function addPoint(title){fill('Nový bod',title);button('Pridať bod');}
function pickPhoto(){
  button('Pridať fotku');waitButton('Galéria');button('Galéria');
  wait(`!!document.querySelector('input[type="file"]')`);browser('upload','input[type="file"]',resolve(out,'test-photo.png'));
  wait(`document.body.innerText.includes('test-photo.jpg')`);
}
writeFileSync(resolve(out,'test-photo.png'),readFileSync('mobile/assets/icon-test.png'));
try{
  signIn();
  if(process.env.MOBILE_TASK_QA_START!=='photos'){
  capture('extensions-list-390');
  button('Po termíne');
  wait(`__simpleTasksFixture.requests.some(r=>r.path==='/api/mobile/v1/tasks/workspace')&&document.body.innerText.includes('Overiť pristavenie')`);
  check('overdue choice uses a server dueFilter query',evaluate(`document.body.innerText.includes('Overiť pristavenie')&&!document.body.innerText.includes('Skontrolovať doklady pred odovzdaním')`));
  capture('extensions-overdue-390');button('Po termíne');

  newTask('Pravidelná kontrola vozidla');
  check('checklist and recurrence are hidden by default',!bodyIncludes('Checklist (voliteľný)')&&!bodyIncludes('Opakovanie (voliteľné)'));
  button('Ďalšie možnosti');addPoint('Skontrolovať doklady');addPoint('Skontrolovať výbavu');
  button('Týždenne');button('Pondelok');fill('Čas opakovania','09:30');
  for(const [width,height]of [[320,568],[390,844]]){browser('set','viewport',String(width),String(height));capture('extensions-create-'+width);}
  button('Vytvoriť úlohu');browser('wait','--text','Priebeh a správy');
  check('creation preserves checklist and weekly schedule',evaluate(`(()=>{const t=${currentTask('Pravidelná kontrola vozidla')};return t.checklist.length===2&&t.checklist.every(i=>!i.done)&&t.recurrence.frequency==='weekly'&&t.recurrence.weekday===1&&t.recurrence.time==='09:30'})()`));
  button('Začať riešiť');waitButton('Označiť ako hotové');
  const before=evaluate('__simpleTasksFixture.mutations.length');button('Označiť ako hotové');waitButton('Dokončiť aj s nehotovými bodmi');
  check('incomplete checklist requires explicit confirmation before write',evaluate('__simpleTasksFixture.mutations.length')===before);
  capture('extensions-incomplete-confirm-390');button('Pokračovať v riešení');
  button('Skontrolovať doklady');wait(`(${currentTask('Pravidelná kontrola vozidla')}).checklist[0].done===true`);
  more();waitButton('Pozastaviť opakovanie');button('Pozastaviť opakovanie');waitButton('Obnoviť opakovanie');
  check('pausing carries the semantic series version',evaluate(`(()=>{const r=__simpleTasksFixture.mutations.filter(m=>m.input.action==='recurrence').at(-1);return r.input.schedule===null&&r.input.expectedSeriesRevision===1&&(${currentTask('Pravidelná kontrola vozidla')}).recurrence.state==='paused'})()`));
  capture('extensions-paused-390');button('Obnoviť opakovanie');waitButton('Pozastaviť opakovanie');
  button('Označiť ako hotové');waitButton('Dokončiť aj s nehotovými bodmi');button('Dokončiť aj s nehotovými bodmi');waitButton('Znovu otvoriť');
  check('explicit completion leaves unfinished points untouched',evaluate(`(()=>{const t=${currentTask('Pravidelná kontrola vozidla')};return t.state==='done'&&t.checklist[0].done&&!t.checklist[1].done&&__simpleTasksFixture.mutations.filter(m=>m.input.action==='complete').at(-1).input.allowIncompleteChecklist===true})()`));
  back();newTask('Úloha s dnešným termínom');selectPrefix('Termín:');button('Dnes do konca dňa');button('Vytvoriť úlohu');browser('wait','--text','Priebeh a správy');back();button('Dnes');
  wait(`document.body.innerText.includes('Úloha s dnešným termínom')`);
  check('today filter keeps due tasks and excludes tasks without deadline',!bodyIncludes('Pripraviť vozidlo na pobočke'));
  capture('extensions-today-320');button('Dnes');

  }
  newTask('Doklad o vykonaní práce');pickPhoto();capture('extensions-photo-selected-390');
  evaluate('__simpleTasksFixture.failNextPhotoUpload=true');button('Vytvoriť úlohu');browser('wait','--text','Priebeh a správy');waitButton('Overiť nahrávanie fotografie');
  check('failed upload keeps one created task and pending exact photo',evaluate(`__simpleTasksFixture.tasks.filter(t=>t.title==='Doklad o vykonaní práce').length===1&&(${currentTask('Doklad o vykonaní práce')}).attachments.length===0&&__simpleTasksFixture.photoUploads.length===1`));
  capture('extensions-photo-retry-390');button('Overiť nahrávanie fotografie');waitButton('Zobraziť fotografiu');
  check('photo retry reuses immutable photo and prepare command',evaluate(`(()=>{const puts=__simpleTasksFixture.photoUploads;const prepares=__simpleTasksFixture.mutations.filter(m=>m.path.endsWith('/photos'));return puts.length===2&&puts[0].photoId===puts[1].photoId&&prepares.length===2&&prepares[0].input.commandId===prepares[1].input.commandId&&(${currentTask('Doklad o vykonaní práce')}).attachments.length===1})()`));
  capture('extensions-photo-saved-390');button('Odstrániť fotografiu');waitButton('Potvrdiť odstránenie fotografie');button('Potvrdiť odstránenie fotografie');
  wait(`(${currentTask('Doklad o vykonaní práce')}).attachments.length===0`);check('photo removal requires confirmation and removes metadata',!hasButton('Zobraziť fotografiu'));
  back();newTask('Ďalšia čistá úloha');check('new creation has a clean independent photo selection',!bodyIncludes('test-photo.jpg'));button('Zahodiť koncept');waitButton('+ Nová úloha');
  assertIsolated('office');browser('close');

  signIn(true);newTask('Kontrola od vodiča');button('Ďalšie možnosti');addPoint('Potvrdiť prevzatie');button('Denne');fill('Čas opakovania','08:00');button('Vytvoriť úlohu');browser('wait','--text','Priebeh a správy');
  check('field-only employee uses checklist and recurrence without office access',evaluate(`(()=>{const t=${currentTask('Kontrola od vodiča')};return t.checklist.length===1&&t.recurrence.frequency==='daily'&&!__mobileFixture.requests.some(r=>r.path.startsWith('/api/mobile/v1/cases')||r.path==='/api/mobile/v1/console')})()`));
  capture('extensions-field-detail-390');assertIsolated('field');
  report.status='passed';report.finishedAt=new Date().toISOString();
}catch(error){
  report.status='failed';report.error=error.message;
  if(session){try{report.failureSnapshot=browser('snapshot','-i');browser('screenshot',resolve(out,'failure.png'));}catch{}}
  throw error;
}finally{
  writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,report:resolve(out,'report.json')}));
  for(const name of report.sessions){try{spawnSync('agent-browser',['--session',name,'close'],{encoding:'utf8',timeout:10_000});}catch{}}
}
