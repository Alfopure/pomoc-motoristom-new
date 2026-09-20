import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { callCenterCalls } from "../src/mock/seed";
const postcss=createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script:string,css:string;
const origin="https://ustredna.test";
test.beforeAll(async()=>{
 const bundle=await build({entryPoints:["e2e/fixtures/ustredna.tsx"],outfile:".context/ustredna-fixture.js",bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env":JSON.stringify({NODE_ENV:"production"})},plugins:[{name:"isolated-telephony",setup(b){b.onResolve({filter:/supabase\/browser$/},()=>({path:path.resolve("e2e/fixtures/ustredna-supabase.ts")}));b.onResolve({filter:/^\.\/useTelephonyConsole$/},()=>({path:path.resolve("e2e/fixtures/ustredna-telephony.ts")}));}}]});
 script=bundle.outputFiles.find(f=>f.path.endsWith(".js"))!.text;css=bundle.outputFiles.find(f=>f.path.endsWith(".css"))?.text??"";
 css+=(await postcss([tailwindcss({base:process.cwd(),optimize:true})]).process(await readFile("src/app/globals.css","utf8"),{from:path.resolve("src/app/globals.css")})).css;
});
async function boot(page:Page,width=1440,height=900){
 await page.setViewportSize({width,height});const errors:string[]=[];const queries:string[]=[];const historyRequests:URLSearchParams[]=[];
 page.on("pageerror",e=>errors.push(e.message));
 const calls=Array.from({length:25},(_,i)=>({...callCenterCalls[i%callCenterCalls.length],id:`history-${i}`,callerName:`Testovací klient ${i+1}`,...(i===0?{status:"ended" as const,answeredAt:"2026-05-20T18:31:10+02:00",endedAt:"2026-05-20T18:35:17+02:00",durationSeconds:247,recordingId:"recording-history-1",recordingStatus:"available" as const,outcomeNote:"Klient chce volať po 15:00",callback:{status:"scheduled" as const,claimedByName:"Jana Nováková",dueAt:"2026-09-20T15:00:00+02:00"}}:{})}));
 await page.route("**/*",route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();
 if(u.pathname==="/")return route.fulfill({contentType:"text/html",body:'<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>'});
 const send=(json:unknown)=>route.fulfill({json});
 if(u.pathname==="/api/cases/live")return send({available:false});
 if(u.pathname==="/api/telephony/callbacks")return send({configured:true,checkedAt:new Date().toISOString(),actorProfileId:"00000000-0000-4000-8000-000000000002",actorRole:"manager",openTotal:125,nextCursor:null,open:[{id:"callback-1",callerNumber:"+421900000040",callerName:"Čakajúci klient",source:"missed",status:"open",createdAt:new Date(Date.now()-720000).toISOString(),dueAt:null,claimedByProfileId:null}],resolved:[]});
 if(u.pathname==="/api/telephony/calls/history"){
  queries.push(u.searchParams.get("q")??"");historyRequests.push(new URLSearchParams(u.search));
  if(u.searchParams.get("category")==="received"&&!u.searchParams.get("cursor"))return send({calls:[],scanLimited:true,nextCursor:"scan-page-2",filters:{lines:[{id:"line-assistance",label:"Asistencia"}],operators:[{id:"operator-jana",name:"Jana Nováková"}]}});
  const pageCalls=u.searchParams.get("q")?calls.slice(0,2):calls;
  return send({calls:pageCalls,nextCursor:u.searchParams.get("cursor")?null:"history-page-2",filters:{lines:[{id:"line-assistance",label:"Asistencia"}],operators:[{id:"operator-jana",name:"Jana Nováková"}]}});
 }
 if(u.pathname==="/api/telephony/team")return send({checkedAt:new Date().toISOString(),operators:[{profileId:"1",name:"Jana Nováková",status:"available",statusSince:new Date(Date.now()-180000).toISOString(),answeredToday:12,online:true,lastOnlineAt:new Date().toISOString()},{profileId:"2",name:"Peter Veselý",status:"on_call",statusSince:new Date(Date.now()-90000).toISOString(),answeredToday:8,online:true,lastOnlineAt:new Date().toISOString(),call:{callerNumber:"+421900000031",sessionId:"colleague"}},{profileId:"3",name:"Eva Tichá",status:"offline",statusSince:new Date(Date.now()-3600000).toISOString(),answeredToday:0,online:false,lastOnlineAt:new Date(Date.now()-3600000).toISOString()}]});
 if(u.pathname==="/api/telephony/routing-summary")return send({snapshotId:"fixture",checkedAt:new Date().toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),canEdit:true,lines:[{id:"00000000-0000-4000-8000-000000000030",label:"Asistencia",phoneNumber:"+421900000000",status:"open",sentence:"Dostupným členom Dispečingu zvoní naraz najviac 20 s. Ak nikto nezdvihne, hovor prejde do čakárne.",branches:[],notes:[],target:{section:"telephony",tab:"incoming",lineId:"00000000-0000-4000-8000-000000000030"}}]});
 if(u.pathname==="/api/notifications")return send({notifications:[]});
 if(u.pathname==="/api/telephony/directory/favorites")return send({favorites:[]});
 if(u.pathname==="/api/health/live")return send({version:"isolated-workspace"});
 return route.fulfill({status:503,json:{error:"Izolovaný test: služba nedostupná."}});
 });
 await page.goto(origin+"/?view=call-center");await page.addStyleTag({content:css});await page.addScriptTag({content:script});
 try { await expect(page.getByTestId("call-center-history")).toBeVisible(); } catch (error) { throw new Error(`Boot errors: ${errors.join("; ")}`, {cause:error}); } await expect(page.getByTestId("call-center-history").getByText("Testovací klient 1",{exact:true}).filter({visible:true})).toBeVisible();return{errors,queries,historyRequests};
}

async function waitForHistoryRequest(evidence:Awaited<ReturnType<typeof boot>>,predicate:(params:URLSearchParams)=>boolean){
 await expect.poll(()=>evidence.historyRequests.some(predicate)).toBe(true);
 return evidence.historyRequests.findLast(predicate)!;
}
for(const width of[1440,1280,390])test(`Ústredňa light shell and real states ${width}`,async({page})=>{
 const evidence=await boot(page,width,width===1440?900:width===1280?800:844);
 for(const state of["idle","ringing","active","busy","waiting"]){
  await page.evaluate(state=>window.dispatchEvent(new CustomEvent("fixture-calls",{detail:state})),state);
  if(state==="idle")await expect(page.getByTestId("call-tray")).toHaveCount(0);else if(state!=="waiting")await expect(page.getByTestId("call-tray")).toBeVisible();
  if (width===1280 && state==="busy") {
    const rows=await page.getByTestId("call-history-row").evaluateAll(nodes=>nodes.filter(node=>{const r=node.getBoundingClientRect();return r.height>0&&r.top>=0&&r.bottom<=innerHeight;}).length);
    expect(rows,"at least five complete history rows with maximum call tray").toBeGreaterThanOrEqual(5);
  }
  await page.screenshot({path:`.context/ustredna-app-${state}-${width}.png`});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.locator(".dispatch-app-header").evaluate(el=>getComputedStyle(el).backgroundColor)).toBe("rgb(252, 252, 253)");
 }
 expect(evidence.errors).toEqual([]);
});
test("server search survives exact routing navigation and browser back",async({page})=>{
 const evidence=await boot(page);const search=page.getByRole("searchbox",{name:"Hľadať v celej histórii"});
 await search.fill("Stastny");await expect.poll(()=>evidence.queries.at(-1)).toBe("Stastny");
 await page.getByRole("button",{name:"Upraviť smerovanie"}).click();await expect(page).toHaveURL(/view=settings.*section=telephony/);
 await page.goBack();await expect(search).toHaveValue("Stastny");expect(evidence.errors).toEqual([]);
});

test("history quick filters preserve shared filters and reset pagination and advanced call state",async({page})=>{
 const evidence=await boot(page);const history=page.getByTestId("call-center-history");
 await history.getByRole("searchbox",{name:"Hľadať v celej histórii"}).fill("Stastny");
 await history.getByText("Filtre",{exact:true}).click();
 await history.getByLabel("Od",{exact:true}).fill("2026-09-01");
 await history.getByLabel("Do",{exact:true}).fill("2026-09-20");
 await history.getByRole("combobox",{name:"Operátor",exact:true}).selectOption("operator-jana");
 await history.getByRole("combobox",{name:"Linka",exact:true}).selectOption("line-assistance");
 await history.getByRole("combobox",{name:"Smer",exact:true}).selectOption("inbound");
 await history.getByRole("combobox",{name:"Výsledok",exact:true}).selectOption("failed");
 await waitForHistoryRequest(evidence,p=>p.get("direction")==="inbound"&&p.get("outcome")==="failed");
 await history.getByRole("button",{name:"Nasledujúca strana"}).click();
 await waitForHistoryRequest(evidence,p=>p.get("cursor")==="history-page-2");

 const quickFilters=history.getByRole("group",{name:"Typ hovorov"});
 await expect(quickFilters.getByRole("button")).toHaveCount(4);
 await quickFilters.getByRole("button",{name:"Volané",exact:true}).click();
 const outbound=await waitForHistoryRequest(evidence,p=>p.get("category")==="outbound");
 expect(Object.fromEntries(outbound)).toMatchObject({q:"Stastny",from:"2026-09-01",to:"2026-09-20",operatorId:"operator-jana",lineId:"line-assistance",category:"outbound",cursor:""});
 expect(outbound.get("direction")).toBe("");expect(outbound.get("outcome")).toBe("");
 await expect(quickFilters.getByRole("button",{name:"Volané",exact:true})).toHaveAttribute("aria-pressed","true");

 await history.getByText("Filtre",{exact:true}).click();
 await history.getByRole("combobox",{name:"Smer",exact:true}).selectOption("internal");
 const advanced=await waitForHistoryRequest(evidence,p=>p.get("direction")==="internal");
 expect(advanced.get("category")).toBe("all");expect(advanced.get("cursor")).toBe("");
 await expect(quickFilters.getByRole("button",{name:"Všetky",exact:true})).toHaveAttribute("aria-pressed","true");
 expect(evidence.errors).toEqual([]);
});

test("history columns have accessible defaults, keyboard controls, and actor persistence",async({page})=>{
 let evidence=await boot(page);const history=page.getByTestId("call-center-history");
 const columns=history.locator("details").filter({has:page.getByText("Stĺpce",{exact:true})});
 const summary=columns.locator("summary");await summary.focus();await page.keyboard.press("Enter");
 const duration=columns.getByRole("checkbox",{name:"Dĺžka rozhovoru"});
 const recording=columns.getByRole("checkbox",{name:"Nahrávka"});
 const waiting=columns.getByRole("checkbox",{name:"Čakanie"});
 const callback=columns.getByRole("checkbox",{name:"Spätné volanie"});
 const note=columns.getByRole("checkbox",{name:"Poznámka"});
 await expect(duration).toBeChecked();await expect(recording).toBeChecked();
 await expect(waiting).not.toBeChecked();await expect(callback).not.toBeChecked();await expect(note).not.toBeChecked();
 await waiting.focus();await page.keyboard.press("Space");await expect(waiting).toBeChecked();
 await callback.check();await note.check();
 await expect(history.getByText(/Prevzaté/).first()).toContainText("Jana Nováková");
 const noteButton=history.getByRole("button",{name:"Klient chce volať po 15:00"});await expect(noteButton).toHaveAttribute("title","Klient chce volať po 15:00");
 await noteButton.click();const detail=page.getByRole("dialog",{name:/Detail hovoru/});await expect(detail.getByRole("heading",{name:"Poznámka k hovoru"})).toBeVisible();await expect(detail.getByText("Klient chce volať po 15:00",{exact:true})).toBeVisible();await detail.getByRole("button",{name:"Zavrieť detail hovoru"}).click();
 await summary.click();
 await recording.uncheck();await expect(recording).not.toBeChecked();

 evidence=await boot(page);
 const restored=page.getByTestId("call-center-history").locator("details").filter({has:page.getByText("Stĺpce",{exact:true})});
 await restored.locator("summary").click();
 await expect(restored.getByRole("checkbox",{name:"Čakanie"})).toBeChecked();
 await expect(restored.getByRole("checkbox",{name:"Spätné volanie"})).toBeChecked();
 await expect(restored.getByRole("checkbox",{name:"Poznámka"})).toBeChecked();
 await expect(restored.getByRole("checkbox",{name:"Nahrávka"})).not.toBeChecked();
 expect(evidence.errors).toEqual([]);
});

test("history quick filters and column chooser remain reachable on mobile",async({page})=>{
 const evidence=await boot(page,390,844);const history=page.getByTestId("call-center-history");
 const group=history.getByRole("group",{name:"Typ hovorov"});
 await expect(group.getByRole("button",{name:"Zmeškané",exact:true})).toBeVisible();
 await group.getByRole("button",{name:"Zmeškané",exact:true}).click();
 await waitForHistoryRequest(evidence,p=>p.get("category")==="missed");
 const columns=history.locator("details").filter({has:page.getByText("Stĺpce",{exact:true})});const summary=columns.locator("summary");
 await summary.click();
 const panel=columns.locator(":scope > div");
 const panelBox=await panel.boundingBox();expect(panelBox).not.toBeNull();
 const headerBox=await page.locator(".dispatch-app-header").boundingBox();expect(headerBox).not.toBeNull();
 expect(panelBox!.x).toBeGreaterThanOrEqual(0);expect(panelBox!.x+panelBox!.width).toBeLessThanOrEqual(390);
 expect(panelBox!.y,"column menu stays below the sticky app header").toBeGreaterThanOrEqual(headerBox!.y+headerBox!.height+8);expect(panelBox!.y+panelBox!.height,"column menu stays above the 76px mobile navigation clearance").toBeLessThanOrEqual(844-76);
 for(const name of["Dĺžka rozhovoru","Nahrávka","Čakanie","Spätné volanie","Poznámka"]){
  const option=columns.getByRole("checkbox",{name});await option.scrollIntoViewIfNeeded();await expect(option).toBeVisible();
  const optionBox=await option.boundingBox();expect(optionBox!.y).toBeGreaterThanOrEqual(panelBox!.y);expect(optionBox!.y+optionBox!.height).toBeLessThanOrEqual(panelBox!.y+panelBox!.height);
 }
 const defaults=columns.getByRole("button",{name:"Predvolené stĺpce"});await defaults.scrollIntoViewIfNeeded();await expect(defaults).toBeVisible();
 await columns.getByRole("checkbox",{name:"Poznámka"}).focus();await page.keyboard.press("Escape");
 await expect(columns).not.toHaveAttribute("open","");await expect(summary).toBeFocused();
 await summary.click();await expect(columns).toHaveAttribute("open","");
 await page.getByRole("heading",{name:"Ústredňa",exact:true}).first().click();await expect(columns).not.toHaveAttribute("open","");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:".context/history-mobile-quick-filters-columns.png"});
 expect(evidence.errors).toEqual([]);
});

test("scan-limited empty category continues with its cursor",async({page})=>{
 const evidence=await boot(page);const history=page.getByTestId("call-center-history");
 await history.getByRole("group",{name:"Typ hovorov"}).getByRole("button",{name:"Prijaté",exact:true}).click();
 await waitForHistoryRequest(evidence,p=>p.get("category")==="received"&&!p.get("cursor"));
 await expect(history.getByText("Hľadanie pokračuje v starších hovoroch. Pokračujte na ďalšiu stranu.")).toBeVisible();
 await expect(history.getByText("Hľadanie pokračuje",{exact:true})).toBeVisible();
 await history.getByRole("button",{name:"Nasledujúca strana"}).click();
 const next=await waitForHistoryRequest(evidence,p=>p.get("category")==="received"&&p.get("cursor")==="scan-page-2");
 expect(next.get("category")).toBe("received");
 await expect(history.getByText("Testovací klient 1",{exact:true}).filter({visible:true})).toBeVisible();
 expect(evidence.errors).toEqual([]);
});

test("desktop history preview shows representative duration and recording",async({page})=>{
 const evidence=await boot(page,1440,900);const history=page.getByTestId("call-center-history");
 await expect(history.getByText("4:07",{exact:true}).filter({visible:true})).toBeVisible();
 await expect(history.getByRole("button",{name:/Otvoriť nahrávku hovoru/}).filter({visible:true}).first()).toBeVisible();
 await history.screenshot({path:".context/history-quick-filters-preview.png"});
 expect(evidence.errors).toEqual([]);
});

test("routing validity expires at a schedule boundary even while offline",async({page})=>{
 await page.clock.install({time:new Date()});
 await boot(page);
 const now=await page.evaluate(()=>Date.now());
 let reads=0;
 await page.route("**/api/telephony/routing-summary",route=>{
  reads++;
  if(reads>1)return route.abort();
  return route.fulfill({json:{snapshotId:"boundary",checkedAt:new Date(now).toISOString(),validUntil:new Date(now+5000).toISOString(),canEdit:false,lines:[{id:"boundary",label:"Hraničná linka",phoneNumber:"+421900000000",status:"open",sentence:"Platné pred zmenou hodín.",branches:[],notes:[],target:{section:"telephony",tab:"hours"}}]}});
 });
 await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
 await expect(page.getByText("Platné pred zmenou hodín.")).toBeVisible();
 await page.clock.fastForward(6000);
 await expect(page.getByText("Platné pred zmenou hodín.")).toHaveCount(0);
 await expect(page.getByText(/Pravidlá.*over/)).toBeVisible();
});

test("200 percent equivalent viewport and reduced motion keep primary actions reachable",async({page})=>{
 await page.emulateMedia({reducedMotion:"reduce"});
 const evidence=await boot(page,720,450);
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent("fixture-calls",{detail:"active"})));
 const hangup=page.getByRole("button",{name:"Zavesiť",exact:true});
 await expect(hangup).toBeVisible();
 const rect=await hangup.boundingBox();expect(rect!.x+rect!.width).toBeLessThanOrEqual(720);expect(rect!.y+rect!.height).toBeLessThanOrEqual(450);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole("searchbox",{name:"Hľadať v celej histórii"}).focus();await expect(page.getByRole("searchbox",{name:"Hľadať v celej histórii"})).toBeFocused();
 const columns=page.getByTestId("call-center-history").locator("details").filter({has:page.getByText("Stĺpce",{exact:true})});await columns.locator("summary").click();
 const panel=columns.locator(":scope > div");const panelBox=await panel.boundingBox();expect(panelBox).not.toBeNull();
 const headerBox=await page.locator(".dispatch-app-header").boundingBox();expect(headerBox).not.toBeNull();
 expect(panelBox!.y).toBeGreaterThanOrEqual(headerBox!.y+headerBox!.height+8);expect(panelBox!.y+panelBox!.height,"column menu remains above fixed navigation at 200 percent equivalent viewport").toBeLessThanOrEqual(450-76);
 for(const control of[...(await columns.getByRole("checkbox").all()),columns.getByRole("button",{name:"Predvolené stĺpce"})]){await control.scrollIntoViewIfNeeded();const currentPanel=await panel.boundingBox();const box=await control.boundingBox();expect(currentPanel).not.toBeNull();expect(box).not.toBeNull();expect(currentPanel!.y+currentPanel!.height).toBeLessThanOrEqual(450-76);expect(box!.y).toBeGreaterThanOrEqual(currentPanel!.y);expect(box!.y+box!.height).toBeLessThanOrEqual(currentPanel!.y+currentPanel!.height);}
 await page.screenshot({path:".context/ustredna-app-zoom200.png"});expect(evidence.errors).toEqual([]);
});

test("eight operators retain readable last-online cards and busy history space", async ({page}) => {
  const evidence=await boot(page,1280,800);
  const names=["Alexandra Nováková","Ján Ondrejčík","Lucia Kováčová","Martin Horváth","Matej Novotný","Michal Michálek","Natália Kováčová","Tester 2"];
  await page.route("**/api/telephony/team",route=>route.fulfill({json:{checkedAt:new Date().toISOString(),operators:names.map((name,index)=>({profileId:String(index),name,status:"available",statusSince:new Date(Date.now()-13*3600000).toISOString(),online:index<2,lastOnlineAt:new Date(Date.now()-(index<2?0:12*60000)).toISOString(),answeredToday:0,talkSecondsToday:0,lastDeviceContactAt:new Date().toISOString(),lastMobileContactAt:null}))}}));
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("operator-card")).toHaveCount(8);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent("fixture-calls",{detail:"busy"})));
  const visibleRows=await page.getByTestId("call-history-row").evaluateAll(nodes=>nodes.filter(node=>{const r=node.getBoundingClientRect();return r.height>0&&r.top>=0&&r.bottom<=innerHeight;}).length);
  await page.screenshot({path:".context/ustredna-operators-eight-busy.png"});
  expect(visibleRows,"five history rows remain with eight operators and three call bars").toBeGreaterThanOrEqual(5);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

  expect(evidence.errors).toEqual([]);
});
