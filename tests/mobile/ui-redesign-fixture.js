// Browser-only synthetic transport. No requests reach the shared TEST database.
(() => {
  const realFetch = window.fetch.bind(window);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const now = new Date().toISOString();
  const fixture = new URL(location.href).searchParams.get('fixture');
  const fieldActor = fixture === 'field';
  const allModules = fixture === 'all';
  const scope = {ok:true,apiVersion:1,environment:'test',profileId:id(1),checkedAt:now};
  const orgScope = {...scope,organizationId:id(2)};
  const caps = {voice:false,presenceWrite:false};
  const caseItem = {id:id(3),caseNumber:'2026-01428',status:'open',statusLabel:'Otvorený',priority:'urgent',priorityLabel:'Horí',owner:{id:id(1),name:'Jana Testovacia',mine:true},contact:{name:'Martin Ukážkový',phone:'+421900000001'},vehicle:{licensePlate:'BA123XY',description:'Škoda Octavia Combi'},pickupAddress:'D1, diaľničné odpočívadlo Triblavina, smer Trnava',destinationAddress:'Servis Bratislava, Vajnorská 152',summary:'Vozidlo neštartuje. Klient čaká s dvoma deťmi na bezpečnom mieste.',createdAt:now,updatedAt:now};
  const caseTwo = {...caseItem,id:id(4),caseNumber:'2026-01427',priority:'normal',priorityLabel:'Bežná',owner:{id:null,name:null,mine:false},contact:{name:'Lucia Ukážková',phone:'+421900000002'},vehicle:{licensePlate:'TT456AB',description:'Volkswagen Golf'},summary:'Defekt pneumatiky, potrebná asistencia.',statusLabel:'Čaká na pridelenie'};
  const task = {id:id(5),title:'Overiť pristavenie náhradného vozidla a potvrdiť klientovi čas príchodu',status:'overdue',priority:'high',kind:'dispatch',revision:1,workflowState:'todo',originLocked:false,assignedTo:{id:id(1),name:'Jana Testovacia'},reviewer:null,dueAt:new Date(Date.now()-3600000).toISOString(),createdAt:now,updatedAt:now,createdByMe:true,reviewSubmission:null,reviewReturnReason:null};
  const callback = {id:id(6),number:'+421900000003',name:'Peter Ukážkový',status:'open',origin:'missed',originDetail:null,sourceLabel:'Zmeškaný hovor',lineLabel:'Linka pomoci',partnerName:null,caseId:id(3),claimant:null,claimedAt:null,deadlineAt:new Date(Date.now()-900000).toISOString(),createdAt:now,resolvedAt:null,notes:null,lastCalledAt:null,actions:{claim:true,takeover:false,call:true,resolve:true,blockedReason:null}};
  const callbackCounts = {open:1,requested:0,missed:1,manual:0,unknown:0};
  const user = {id:id(1),aud:'authenticated',role:'authenticated',email:'jana@example.invalid',app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:now};
  const encode = value => btoa(JSON.stringify(value)).replaceAll('=','').replaceAll('+','-').replaceAll('/','_');
  const token = `${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:id(1),exp:Math.floor(Date.now()/1000)+86400,role:'authenticated'})}.visual-fixture`;
  window.__mobileFixture = {requests:[],mode:'success'};
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input.toString(),location.origin);
    if (url.origin === location.origin) return realFetch(input,init);
    if (!url.hostname.endsWith('.supabase.co') && url.hostname !== 'test.dispecing.linkapomoci.sk') return Promise.reject(new Error('Visual QA blocks external requests'));
    const method = init.method || 'GET';
    window.__mobileFixture.requests.push({path:url.pathname,method});
    const response = (body,status=200) => Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
    if(url.pathname === '/auth/v1/token') return response({access_token:token,refresh_token:'synthetic-refresh',expires_in:86400,token_type:'bearer',user});
    if(url.pathname === '/auth/v1/user') return response(user);
    if(url.pathname === '/auth/v1/logout') return response({});
    if(method !== 'GET') return response({ok:false,error:'Vizuálny test: zmeny sa neodosielajú.',code:'fixture_read_only'},403);
    const path = url.pathname.replace('/api/mobile/v1/','');
    if(path === 'app-status') return response({ok:true,apiVersion:1,environment:'test',minimumVersion:null,updateUrl:null});
    if(path === 'me' && fieldActor) return response({ok:false,error:'Použite terénny profil.',code:'mobile_no_dispatch_profile'},403);
    if(path === 'me') return response({...scope,profile:{id:id(1),displayName:'Jana Testovacia',email:user.email,role:allModules?'admin':'dispatcher'},capabilities:caps});
    if(path === 'drafts/scope') return response(orgScope);
    if(path === 'console') return response({...scope,presence:{status:'available',since:now},activeCalls:[],capabilities:caps});
    if(path === 'voice/readiness') return response({...scope,nativeCallingEnabled:false,backgroundIncomingEnabled:false});
    if(path === 'field/me' && fieldActor) return response({ok:true,apiVersion:1,environment:'test',memberId:id(10),checkedAt:now,member:{id:id(10),displayName:'Vodič Testovací',email:'vodic@example.invalid'},capabilities:['drive'],branches:[{id:id(11),name:'Bratislava'}]});
    if(path === 'field/me' && allModules) return response({ok:true,apiVersion:1,environment:'test',memberId:id(10),checkedAt:now,member:{id:id(10),displayName:'Jana Testovacia',email:user.email},capabilities:['drive','deliver'],branches:[{id:id(11),name:'Bratislava'}]});
    if(path === 'field/deliveries' && allModules) return response({ok:true,apiVersion:1,environment:'test',memberId:id(10),checkedAt:now,deliveries:[]});
    if(path === 'field/work') return window.__mobileFixture.mode === 'error' ? response({ok:false,error:'Prácu sa nepodarilo načítať.'},503) : response({ok:true,apiVersion:1,environment:'test',memberId:id(10),checkedAt:now,operations:[],towing:null,unavailable:[]});
    if(path.startsWith('field/branch')) return response({ok:false,error:'Požiadavky pobočky sa nepodarilo načítať.'},503);
    if(path === 'field/me') return response({ok:false,error:'Účet nemá terénny profil.',code:'mobile_no_field_membership'},403);
    if(path === 'callbacks/summary') return response({...scope,counts:{...callbackCounts,mine:0,unclaimed:1,overdue:1}});
    if(window.__mobileFixture.mode === 'error' && ['cases','tasks','callbacks','cases/overview'].includes(path)) return response({ok:false,error:'Spojenie sa prerušilo. Skúste obnoviť údaje.'},503);
    const empty = window.__mobileFixture.mode === 'empty';
    if(path === 'callbacks') return response({...orgScope,counts:empty?{open:0,requested:0,missed:0,manual:0,unknown:0}:callbackCounts,open:empty?[]:[callback],resolved:[],nextCursor:null,resetPage:false});
    if(path === 'cases/overview') return response({...scope,counts:empty?{open:0,mine:0,unassigned:0,urgent:0}:{open:18,mine:7,unassigned:3,urgent:1}});
    if(path === 'cases/dispatchers') return response({...scope,dispatchers:[{id:id(1),name:'Jana Testovacia',active:true}]});
    if(path === 'cases') {
      const q = url.searchParams.get('q') || '';
      const priority = url.searchParams.get('priority');
      return response({...scope,cases:empty?[]:(priority==='urgent'?[caseItem]:[caseItem,caseTwo]).filter(c=>!q || JSON.stringify(c).toLowerCase().includes(q.toLowerCase())),nextCursor:null,selection:{ownership:url.searchParams.get('ownership')||'all',category:url.searchParams.get('category')||'open',ownerId:url.searchParams.get('ownerId'),status:url.searchParams.get('status'),priority,q}});
    }
    if(path === `cases/${id(3)}` || path === `cases/${id(4)}`) {
      const c = path.endsWith(id(3))?caseItem:caseTwo;
      return response({...scope,case:{...c,mainNote:'Klient je v bezpečí. Najprv potvrďte dostupnosť náhradného auta.',incidentDescription:c.summary,jobTypeLabels:['Odťah','Náhradné vozidlo'],editable:{contactName:c.contact.name,contactPhone:c.contact.phone,licensePlate:c.vehicle.licensePlate,vehicleMake:'Škoda',vehicleModel:'Octavia',manualPickupAddress:c.pickupAddress,manualDestinationAddress:c.destinationAddress,incidentDescription:c.summary,note:'Klient je v bezpečí.',priority:c.priority,jobTypes:['tow','replacement_vehicle'],status:'open'},statusOptions:[{value:'open',label:'Otvorený'},{value:'completed_assisted',label:'Vybavený s pomocou'},{value:'cancelled',label:'Zrušený'},{value:'completed_no_assistance',label:'Bez pomoci'},{value:'waiting_for_docs',label:'Čaká na dokumenty'},{value:'futile_trip',label:'Márna jazda'}],timeline:[{id:id(7),title:'Prípad vytvorený',body:'Prijaté telefonicky.',createdAt:now,actorName:'Jana Testovacia'}]}});
    }
    if(path === 'tasks') return response({...scope,tasks:empty?[]:[task],nextCursor:null,capabilities:{create:true,workflow:true,messages:true},selection:{view:url.searchParams.get('view')||'assigned',category:url.searchParams.get('category')||'open',q:url.searchParams.get('q')||''}});
    if(path === `tasks/${id(5)}`) return response({...scope,task,linkedCases:[{id:id(3),caseNumber:caseItem.caseNumber,status:'open'}],capabilities:{create:true,workflow:true,messages:true}});
    if(path === 'history') return response({...scope,calls:[],nextCursor:null});
    return response({ok:false,error:`Vizuálny test nemá vzorku pre ${path}.`,code:'fixture_missing'},404);
  };
})();
