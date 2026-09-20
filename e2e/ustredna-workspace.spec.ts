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
 await page.setViewportSize({width,height});const errors:string[]=[];const queries:string[]=[];
 page.on("pageerror",e=>errors.push(e.message));
 const calls=Array.from({length:25},(_,i)=>({...callCenterCalls[i%callCenterCalls.length],id:`history-${i}`,callerName:`Testovací klient ${i+1}`}));
 await page.route("**/*",route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();
 if(u.pathname==="/")return route.fulfill({contentType:"text/html",body:'<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>'});
 const send=(json:unknown)=>route.fulfill({json});
 if(u.pathname==="/api/cases/live")return send({available:false});
 if(u.pathname==="/api/telephony/callbacks")return send({configured:true,checkedAt:new Date().toISOString(),actorProfileId:"00000000-0000-4000-8000-000000000002",actorRole:"manager",openTotal:125,nextCursor:null,open:[{id:"callback-1",callerNumber:"+421900000040",callerName:"Čakajúci klient",source:"missed",status:"open",createdAt:new Date(Date.now()-720000).toISOString(),dueAt:null,claimedByProfileId:null}],resolved:[]});
 if(u.pathname==="/api/telephony/calls/history"){queries.push(u.searchParams.get("q")??"");return send({calls:u.searchParams.get("q")?calls.slice(0,2):calls,nextCursor:null,filters:{lines:[],operators:[]}});}
 if(u.pathname==="/api/telephony/team")return send({checkedAt:new Date().toISOString(),operators:[{profileId:"1",name:"Jana Nováková",status:"available",statusSince:new Date(Date.now()-180000).toISOString(),answeredToday:12,online:true,lastOnlineAt:new Date().toISOString()},{profileId:"2",name:"Peter Veselý",status:"on_call",statusSince:new Date(Date.now()-90000).toISOString(),answeredToday:8,online:true,lastOnlineAt:new Date().toISOString(),call:{callerNumber:"+421900000031",sessionId:"colleague"}},{profileId:"3",name:"Eva Tichá",status:"offline",statusSince:new Date(Date.now()-3600000).toISOString(),answeredToday:0,online:false,lastOnlineAt:new Date(Date.now()-3600000).toISOString()}]});
 if(u.pathname==="/api/telephony/routing-summary")return send({snapshotId:"fixture",checkedAt:new Date().toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),canEdit:true,lines:[{id:"00000000-0000-4000-8000-000000000030",label:"Asistencia",phoneNumber:"+421900000000",status:"open",sentence:"Dostupným členom Dispečingu zvoní naraz najviac 20 s. Ak nikto nezdvihne, hovor prejde do čakárne.",branches:[],notes:[],target:{section:"telephony",tab:"incoming",lineId:"00000000-0000-4000-8000-000000000030"}}]});
 if(u.pathname==="/api/notifications")return send({notifications:[]});
 if(u.pathname==="/api/telephony/directory/favorites")return send({favorites:[]});
 if(u.pathname==="/api/health/live")return send({version:"isolated-workspace"});
 return route.fulfill({status:503,json:{error:"Izolovaný test: služba nedostupná."}});
 });
 await page.goto(origin+"/?view=call-center");await page.addStyleTag({content:css});await page.addScriptTag({content:script});
 try { await expect(page.getByTestId("call-center-history")).toBeVisible(); } catch (error) { throw new Error(`Boot errors: ${errors.join("; ")}`, {cause:error}); } await expect(page.getByTestId("call-center-history").getByText("Testovací klient 1",{exact:true}).filter({visible:true})).toBeVisible();return{errors,queries};
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
