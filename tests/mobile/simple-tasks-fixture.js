// Append after ui-redesign-fixture.js. Only browser-local synthetic task state.
// Auth, account identity and all unrelated transport stay in the base fixture.
(() => {
  if (!window.__mobileFixture) throw new Error('Load the base mobile fixture first');
  const baseFetch = window.fetch.bind(window);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const field = new URL(location.href).searchParams.get('fixture') === 'field';
  const userId = id(1), organizationId = id(2), groupId = id(11);
  const initialTime = new Date().toISOString();
  const self = {userId, displayName:field ? 'Vodič Testovací' : 'Jana Testovacia'};
  const colleague = {userId:id(101), displayName:'Martin Ukážkový'};
  const another = {userId:id(102), displayName:'Lucia Ukážková'};
  const people = [self,colleague,another];
  const groups = [{id:groupId,name:'Žilina',canManage:true},{id:id(12),name:'Bratislava',canManage:false}];
  const tasks = new Map(), activity = new Map(), receipts = new Map();
  const fixture = window.__simpleTasksFixture = {
    requests:[], mutations:[], failNextMutation:null, readsFail:false, created:[],
    get tasks() { return [...tasks.values()].map(value => structuredClone(value)); },
  };
  const scope = () => ({ok:true,apiVersion:1,environment:'test',userId,organizationId,checkedAt:new Date().toISOString()});
  const group = {id:groupId,name:'Žilina'};
  function sample(number, title, extra = {}) {
    return {id:id(number),title,description:'Jednoduchá úloha so zrozumiteľným ďalším krokom.',state:'todo',priority:'normal',dueAt:null,
      revision:1,createdAt:initialTime,updatedAt:initialTime,createdBy:another,assignee:self,group:null,reviewer:null,
      caseLinks:[],reviewSubmission:null,reviewReturnReason:null,...extra};
  }
  tasks.set(id(5),sample(5,'Overiť pristavenie náhradného vozidla a potvrdiť klientovi čas príchodu',{
    priority:'high',dueAt:new Date(Date.now()-3_600_000).toISOString(),
    caseLinks:field?[]:[{id:id(3),number:'2026-01428'}],
  }));
  tasks.set(id(201),sample(201,'Pripraviť vozidlo na pobočke',{assignee:null,group,createdBy:colleague}));
  tasks.set(id(202),sample(202,'Skontrolovať doklady pred odovzdaním',{createdBy:self,assignee:colleague}));
  tasks.set(id(203),sample(203,'Overiť doplnené podklady',{state:'in_review',createdBy:self,assignee:colleague,reviewer:self,reviewSubmission:'Doklady sú doplnené.'}));
  function permissions(task) {
    const own = task.assignee?.userId === userId, lead = task.group?.id === groupId;
    const active = task.state !== 'done', review = task.reviewer?.userId === userId && task.state === 'in_review';
    return {start:own&&task.state==='todo',complete:own&&active&&task.state!=='in_review'&&!task.reviewer,
      reopen:own&&!active,claim:lead&&active&&!task.assignee,assign:active&&(own||lead||task.createdBy?.userId===userId||!field),
      comment:true,submitReview:own&&Boolean(task.reviewer)&&['todo','in_progress'].includes(task.state),approve:review,return:review};
  }
  const dto = task => ({...structuredClone(task),permissions:permissions(task)});
  function event(taskId, kind, body) {
    const rows = activity.get(taskId) || [];
    rows.unshift({id:id(2_000+fixture.mutations.length*10+rows.length),author:self,body,createdAt:new Date().toISOString(),kind});
    activity.set(taskId,rows);
  }
  const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const failure = (status,error,code) => response({ok:false,error,code},status);
  function signature(value) {
    if (Array.isArray(value)) return '['+value.map(signature).join(',')+']';
    if (value&&typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+signature(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  function mutate(path,input) {
    const record = {path,input:structuredClone(input)};
    fixture.mutations.push(record);
    const key = input.commandId, envelope = signature({path,input});
    if (receipts.has(key)) {
      const previous = receipts.get(key);
      return previous.envelope === envelope ? response({...previous.receipt,task:dto(tasks.get(previous.receipt.task.id))},previous.status)
        : failure(409,'Pôvodná požiadavka už bola použitá.','task_workspace_conflict');
    }
    const create = path === 'tasks/workspace';
    const taskId = create ? id(500+fixture.created.length) : path.split('/')[2];
    let task = tasks.get(taskId);
    if (!create&&!task) return failure(404,'Úloha už nie je dostupná.','task_unavailable');
    if (fixture.failNextMutation === 'conflict') {
      fixture.failNextMutation = null;
      if (task) {task.revision+=1;task.updatedAt=new Date().toISOString();}
      return failure(409,'Úloha sa medzitým zmenila. Obnovte ju a overte pôvodnú požiadavku.','task_workspace_conflict');
    }
    if (!create&&input.expectedRevision!==task.revision) return failure(409,'Úloha sa medzitým zmenila. Obnovte ju.','task_workspace_conflict');
    function assign(target) {
      if (target?.kind === 'person') {
        const assignee = people.find(person=>person.userId===target.userId);
        if (!assignee) return false;
        task.assignee=assignee;
      } else if (target?.kind === 'group') {
        const destination=groups.find(value=>value.id===target.groupId);
        if (!destination) return false;
        task.group={id:destination.id,name:destination.name};task.assignee=null;
      } else return false;
      return true;
    }
    if (create) {
      if (typeof input.title!=='string'||!input.title.trim()) return failure(400,'Doplňte názov úlohy.','invalid_input');
      task=sample(500+fixture.created.length,input.title.trim(),{description:input.description||'',createdBy:self,priority:input.priority||'normal',dueAt:input.dueAt||null});
      if (!assign(input.target)) return failure(400,'Vyberte kolegu alebo pobočku.','invalid_input');
      if (input.caseId) {
        if (field) return failure(403,'Nemáte prístup k prípadu.','access_denied');
        task.caseLinks=[{id:input.caseId,number:'2026-01428'}];
      }
      tasks.set(taskId,task);fixture.created.push(taskId);event(taskId,'created','Úloha bola vytvorená.');
    } else {
      const allowed=permissions(task);
      const key=input.action==='submit_review'?'submitReview':input.action;
      if (!allowed[key]) return failure(403,'Tento krok nie je dostupný.','access_denied');
      if (input.action==='assign') {
        if (!assign(input.target)) return failure(400,'Vyberte kolegu alebo pobočku.','invalid_input');
        event(taskId,'assigned','Úloha bola pridelená.');
      } else if (input.action==='claim') {task.assignee=self;event(taskId,'assigned','Úlohu som prevzal.');}
      else if (input.action==='comment') event(taskId,'comment',input.body);
      else {
        task.state=input.action==='start'||input.action==='return'?'in_progress':input.action==='reopen'?'todo':input.action==='submit_review'?'in_review':'done';
        if(input.action==='return')task.reviewReturnReason=input.comment;
        if(input.action==='submit_review')task.reviewSubmission=input.comment;
        event(taskId,'state',input.action==='complete'||input.action==='approve'?'Úloha bola dokončená.':'Stav úlohy bol zmenený.');
      }
      task.revision+=1;task.updatedAt=new Date().toISOString();
    }
    const receipt={...scope(),commandId:input.commandId,committedRevision:task.revision,task:dto(task)};
    const status=create?201:200;receipts.set(input.commandId,{envelope,receipt,status});
    if(fixture.failNextMutation==='uncertain') {
      fixture.failNextMutation=null;
      return failure(503,'Spojenie sa prerušilo po uložení. Overte pôvodnú požiadavku.','task_workspace_unconfirmed');
    }
    return response(receipt,status);
  }
  window.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url||input.toString(),location.origin);
    const path=url.pathname.replace('/api/mobile/v1/','');
    const method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
    if(url.hostname==='test.dispecing.linkapomoci.sk'&&path==='field/me') {
      const row={path:url.pathname,method};fixture.requests.push(row);window.__mobileFixture.requests.push(row);
      return field?response({ok:true,apiVersion:1,environment:'test',memberId:id(10),organizationId,tasks:true,checkedAt:new Date().toISOString(),
        member:{id:id(10),displayName:self.displayName,email:'vodic@example.invalid'},capabilities:['drive'],branches:[{id:groupId,name:'Žilina'}]})
        :failure(403,'Účet nemá terénny profil.','mobile_no_field_membership');
    }
    if(url.hostname!=='test.dispecing.linkapomoci.sk'||!path.startsWith('tasks/workspace')) return baseFetch(input,init);
    const row={path:url.pathname,method};fixture.requests.push(row);window.__mobileFixture.requests.push(row);
    if(method==='POST') {
      let body;try{body=JSON.parse(init.body===undefined?await input.clone().text():init.body);}catch{return failure(400,'Neplatný formulár.','invalid_input');}
      if(path!=='tasks/workspace'&&!/^tasks\/workspace\/[a-f\d-]+\/commands$/i.test(path)) return failure(404,'Neznámy fixture zápis.','fixture_missing');
      return mutate(path,body);
    }
    if(method!=='GET')return failure(403,'Vizuálny test nepovoľuje tento zápis.','fixture_read_only');
    if(fixture.readsFail)return failure(503,'Úlohy sa nepodarilo načítať. Skúste znova.','fixture_outage');
    if(path==='tasks/workspace/directory') {
      const q=(url.searchParams.get('q')||'').trim().toLocaleLowerCase('sk');
      return response({...scope(),people:people.filter(person=>!q||person.displayName.toLocaleLowerCase('sk').includes(q)),groups,hasMorePeople:false,canLinkCases:!field});
    }
    if(path==='tasks/workspace') {
      const view=url.searchParams.get('view')||'mine',category=url.searchParams.get('category')||'open',q=(url.searchParams.get('q')||'').trim().toLocaleLowerCase('sk');
      const selected=[...tasks.values()].filter(task=>(view==='mine'?task.assignee?.userId===userId:view==='created'?task.createdBy?.userId===userId:view==='branch'?task.group?.id===groupId:task.reviewer?.userId===userId)
        &&(category==='all'||(category==='done'?task.state==='done':task.state!=='done'))&&(!q||task.title.toLocaleLowerCase('sk').includes(q)));
      return response({...scope(),view,tasks:selected.map(dto),nextCursor:null});
    }
    const match=/^tasks\/workspace\/([a-f\d-]+)$/i.exec(path);
    if(match&&tasks.has(match[1]))return response({...scope(),task:dto(tasks.get(match[1])),activity:activity.get(match[1])||[],nextActivityCursor:null});
    return failure(404,'Úloha už nie je dostupná.','task_unavailable');
  };
})();
