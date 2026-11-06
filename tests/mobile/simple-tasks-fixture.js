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
  const tasks = new Map(), activity = new Map(), receipts = new Map(), photos = new Map(), uploaded = new Map();
  const fixture = window.__simpleTasksFixture = {
    requests:[], mutations:[], failNextMutation:null, readsFail:false, created:[], photoUploads:[], failNextPhotoUpload:false,
    get tasks() { return [...tasks.values()].map(value => structuredClone(value)); },
  };
  const scope = () => ({ok:true,apiVersion:1,environment:'test',userId,organizationId,checkedAt:new Date().toISOString()});
  const group = {id:groupId,name:'Žilina'};
  function sample(number, title, extra = {}) {
    return {id:id(number),title,description:'Jednoduchá úloha so zrozumiteľným ďalším krokom.',state:'todo',priority:'normal',dueAt:null,
      revision:1,createdAt:initialTime,updatedAt:initialTime,createdBy:another,assignee:self,group:null,reviewer:null,
      caseLinks:[],reviewSubmission:null,reviewReturnReason:null,checklist:[],recurrence:null,attachments:[],...extra};
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
      comment:true,submitReview:own&&Boolean(task.reviewer)&&['todo','in_progress'].includes(task.state),approve:review,return:review,
      editChecklist:active&&(own||lead||task.createdBy?.userId===userId||!field),
      manageRecurrence:task.createdBy?.userId===userId||lead||!field,attach:true};
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
      task=sample(500+fixture.created.length,input.title.trim(),{description:input.description||'',createdBy:self,priority:input.priority||'normal',dueAt:input.dueAt||null,
        checklist:structuredClone(input.checklist||[]),recurrence:input.recurrence?{...input.recurrence,id:id(4000+fixture.created.length),revision:1,weekday:input.recurrence.weekday||null,timeZone:'Europe/Bratislava',state:'active',nextAt:new Date(Date.now()+86_400_000).toISOString()}:null});
      if (!assign(input.target)) return failure(400,'Vyberte kolegu alebo pobočku.','invalid_input');
      if (input.caseId) {
        if (field) return failure(403,'Nemáte prístup k prípadu.','access_denied');
        task.caseLinks=[{id:input.caseId,number:'2026-01428'}];
      }
      tasks.set(taskId,task);fixture.created.push(taskId);event(taskId,'created','Úloha bola vytvorená.');
    } else {
      const allowed=permissions(task);
      const key=input.action==='submit_review'?'submitReview':input.action==='checklist'?'editChecklist':input.action==='recurrence'?'manageRecurrence':input.action;
      if (!allowed[key]) return failure(403,'Tento krok nie je dostupný.','access_denied');
      if ((input.action==='complete'||input.action==='approve')&&task.checklist.some(item=>!item.done)&&input.allowIncompleteChecklist!==true) return failure(400,'Checklist obsahuje nedokončené body.','task_checklist_incomplete');
      if(input.action==='recurrence'&&task.recurrence&&input.expectedSeriesRevision!==task.recurrence.revision)return failure(409,'Séria sa medzitým zmenila. Obnovte ju.','task_workspace_conflict');
      if(input.action==='checklist') {task.checklist=structuredClone(input.items);event(taskId,'state','Checklist bol upravený.');}
      else if(input.action==='recurrence') {
        const revision=(task.recurrence?.revision||0)+1;
        task.recurrence=input.schedule?{...input.schedule,id:task.recurrence?.id||id(4000+fixture.mutations.length),revision,weekday:input.schedule.weekday||null,timeZone:'Europe/Bratislava',state:'active',nextAt:new Date(Date.now()+86_400_000).toISOString()}:{...task.recurrence,revision,state:'paused',nextAt:null};
        event(taskId,'state',input.schedule?'Opakovanie bolo upravené.':'Opakovanie bolo pozastavené.');
      } else if (input.action==='assign') {
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
  function photoMutation(path, method, input) {
    const parts=path.split('/'),taskId=parts[2],photoId=parts[4],task=tasks.get(taskId);
    fixture.mutations.push({path,method,input:structuredClone(input)});
    if(!task)return failure(404,'Úloha už nie je dostupná.','task_unavailable');
    const envelope=signature({path,method,input}),previous=receipts.get(input.commandId);
    if(previous)return previous.envelope===envelope?response(previous.receipt,previous.status):failure(409,'Pôvodná požiadavka už bola použitá.','task_workspace_conflict');
    if(input.expectedRevision!==task.revision)return failure(409,'Úloha sa medzitým zmenila. Obnovte ju.','task_workspace_conflict');
    let photo;
    if(parts.length===4&&method==='POST') {
      photo={id:input.attachmentId,fileName:input.fileName,mimeType:input.mimeType,sizeBytes:input.sizeBytes,createdAt:new Date().toISOString(),canRemove:true};
      photos.set(photo.id,{taskId,photo,ready:false});task.revision+=1;
      const receipt={...scope(),commandId:input.commandId,committedRevision:task.revision,task:dto(task)};
      const path=`${organizationId}/${taskId}/${photo.id}.${photo.mimeType==='image/png'?'png':'jpg'}`;
      const grant={...scope(),receipt,attachment:photo,upload:{url:`https://nzpnqdstvkfncflgqlny.supabase.co/storage/v1/object/upload/sign/motorist-task-photos/${path}?token=fixture-only-upload`,token:'fixture-only-upload',path,method:'PUT',contentType:photo.mimeType}};
      receipts.set(input.commandId,{envelope,receipt:grant,status:201});return response(grant,201);
    }
    const stored=photos.get(photoId);
    if(!stored||stored.taskId!==taskId)return failure(404,'Fotografia nie je dostupná.','task_photo_unavailable');
    photo=stored.photo;
    if(parts[5]==='confirm'&&method==='POST') {
      if(!uploaded.has(photoId))return failure(422,'Fotografia ešte nie je nahratá.','task_photo_storage_mismatch');
      if(!stored.ready){task.attachments.push(photo);stored.ready=true;}
    } else if(parts.length===5&&method==='DELETE') {
      task.attachments=task.attachments.filter(item=>item.id!==photoId);photos.delete(photoId);uploaded.delete(photoId);
    } else return failure(404,'Neznámy fixture zápis fotografie.','fixture_missing');
    task.revision+=1;task.updatedAt=new Date().toISOString();
    const receipt={...scope(),commandId:input.commandId,committedRevision:task.revision,task:dto(task)};
    receipts.set(input.commandId,{envelope,receipt,status:200});return response(receipt);
  }
  window.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url||input.toString(),location.origin);
    const path=url.pathname.replace('/api/mobile/v1/','');
    const method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
    if((url.protocol==='blob:'||url.protocol==='data:')&&window.__taskLocalMediaFetch)return window.__taskLocalMediaFetch(input,init);
    if(url.hostname==='nzpnqdstvkfncflgqlny.supabase.co'&&url.pathname.startsWith('/storage/v1/object/upload/sign/motorist-task-photos/')&&url.searchParams.get('token')==='fixture-only-upload') {
      const photoId=url.pathname.split('/').at(-1).split('.')[0];fixture.photoUploads.push({photoId,method});
      if(fixture.failNextPhotoUpload){fixture.failNextPhotoUpload=false;return failure(503,'Skúšobný výpadok prenosu.','fixture_outage');}
      if(method!=='PUT'||!photos.has(photoId))return failure(403,'Nepovolený fixture prenos.','fixture_read_only');
      if(uploaded.has(photoId))return failure(409,'The resource already exists','Duplicate');
      uploaded.set(photoId,new Uint8Array(init.body));return response({Key:photoId});
    }
    if(url.hostname==='test.dispecing.linkapomoci.sk'&&path==='field/me') {
      const row={path:url.pathname,method};fixture.requests.push(row);window.__mobileFixture.requests.push(row);
      return field?response({ok:true,apiVersion:1,environment:'test',memberId:id(10),organizationId,tasks:true,checkedAt:new Date().toISOString(),
        member:{id:id(10),displayName:self.displayName,email:'vodic@example.invalid'},capabilities:['drive'],branches:[{id:groupId,name:'Žilina'}]})
        :failure(403,'Účet nemá terénny profil.','mobile_no_field_membership');
    }
    if(url.hostname!=='test.dispecing.linkapomoci.sk'||!path.startsWith('tasks/workspace')) return baseFetch(input,init);
    const row={path:url.pathname,method};fixture.requests.push(row);window.__mobileFixture.requests.push(row);
    if(method==='POST'||method==='DELETE') {
      let body;try{body=JSON.parse(init.body===undefined?await input.clone().text():init.body);}catch{return failure(400,'Neplatný formulár.','invalid_input');}
      if(/^tasks\/workspace\/[a-f\d-]+\/photos(?:\/[a-f\d-]+(?:\/confirm)?)?$/i.test(path))return photoMutation(path,method,body);
      if(path!=='tasks/workspace'&&!/^tasks\/workspace\/[a-f\d-]+\/commands$/i.test(path)) return failure(404,'Neznámy fixture zápis.','fixture_missing');
      return mutate(path,body);
    }
    if(method!=='GET')return failure(403,'Vizuálny test nepovoľuje tento zápis.','fixture_read_only');
    if(fixture.readsFail)return failure(503,'Úlohy sa nepodarilo načítať. Skúste znova.','fixture_outage');
    const photoMatch=/^tasks\/workspace\/([a-f\d-]+)\/photos\/([a-f\d-]+)$/i.exec(path);
    if(photoMatch) {
      const stored=photos.get(photoMatch[2]);
      if(!stored?.ready||stored.taskId!==photoMatch[1])return failure(404,'Fotografia nie je dostupná.','task_photo_unavailable');
      const extension=stored.photo.mimeType==='image/png'?'png':'jpg';
      return response({...scope(),attachment:stored.photo,url:`https://nzpnqdstvkfncflgqlny.supabase.co/storage/v1/object/sign/motorist-task-photos/${organizationId}/${stored.taskId}/${stored.photo.id}.${extension}?token=fixture-only-read`,expiresAt:new Date(Date.now()+60_000).toISOString()});
    }
    if(path==='tasks/workspace/directory') {
      const q=(url.searchParams.get('q')||'').trim().toLocaleLowerCase('sk');
      return response({...scope(),people:people.filter(person=>!q||person.displayName.toLocaleLowerCase('sk').includes(q)),groups,hasMorePeople:false,canLinkCases:!field,timeZone:'Europe/Bratislava'});
    }
    if(path==='tasks/workspace') {
      const view=url.searchParams.get('view')||'mine',category=url.searchParams.get('category')||'open',q=(url.searchParams.get('q')||'').trim().toLocaleLowerCase('sk'),dueFilter=url.searchParams.get('dueFilter')||'all';
      const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bratislava',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
      const selected=[...tasks.values()].filter(task=>(view==='mine'?task.assignee?.userId===userId:view==='created'?task.createdBy?.userId===userId:view==='branch'?task.group?.id===groupId:task.reviewer?.userId===userId)
        &&(category==='all'||(category==='done'?task.state==='done':task.state!=='done'))&&(!q||task.title.toLocaleLowerCase('sk').includes(q))
        &&(dueFilter==='all'||task.state!=='done'&&task.dueAt!==null&&(dueFilter==='today'?day(task.dueAt)===day(Date.now()):Date.parse(task.dueAt)<Date.now())));
      return response({...scope(),view,tasks:selected.map(dto),nextCursor:null,dueFilter,timeZone:'Europe/Bratislava'});
    }
    const match=/^tasks\/workspace\/([a-f\d-]+)$/i.exec(path);
    if(match&&tasks.has(match[1]))return response({...scope(),task:dto(tasks.get(match[1])),activity:activity.get(match[1])||[],nextActivityCursor:null});
    return failure(404,'Úloha už nie je dostupná.','task_unavailable');
  };
})();
