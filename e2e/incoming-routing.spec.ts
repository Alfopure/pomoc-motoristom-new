import { test,expect,type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { routingFixture,multiLineRoutingFixture,dualDeviceRoutingFixture,ids,extraIds } from "./fixtures/incoming-routing-data";
import type { RingGroupInput,RingPlanInput,RoutingDocument } from "../src/server/telephony/config-service";
const postcss=createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script:string,css:string;
const screenshotDirectory=process.env.ROUTING_SCREENSHOT_DIR??".context";
test.use({ launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}), args:["--no-sandbox"] } });
test.beforeAll(async()=>{
 const bundle=await build({entryPoints:["e2e/fixtures/incoming-routing.tsx"],outfile:".context/incoming-routing-fixture.js",bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env":JSON.stringify({NODE_ENV:"production"})}});
 script=bundle.outputFiles.find(file=>file.path.endsWith(".js"))!.text;
 css=(await postcss([tailwindcss({base:process.cwd(),optimize:true})]).process(await readFile("src/app/globals.css","utf8"),{from:path.resolve("src/app/globals.css")})).css;
});
type LineModeWrite={id:string;inboundCallMode:RoutingDocument["lines"][number]["inboundCallMode"];expectedInboundCallMode:RoutingDocument["lines"][number]["inboundCallMode"]};
type Api={mode?:"conflict"|"lost-response"|"lost-mode"|"verify-retry"|"missing"|"readonly";verificationReads?:number;releaseVerification?:()=>void;saved?:Record<string,unknown>;writes:number;document?:RoutingDocument;defaultLine?:boolean;linePatches?:Array<Record<string,unknown>>};
async function boot(page:Page,width=1440,api:Api={writes:0}){
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));let document=structuredClone(api.document??routingFixture);
 await page.setViewportSize({width,height:950});
 await page.route("**/*",async route=>{
  const url=new URL(route.request().url());if(url.origin!=="https://routing.test")return route.abort();
  if(url.pathname==="/")return route.fulfill({contentType:"text/html",body:'<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>'});
  if(url.pathname==="/api/telephony/config/numbers"){
   if(route.request().method()==="PATCH"){
    const payload=route.request().postDataJSON() as {lineId:string;patch:{inboundCallMode:RoutingDocument["lines"][number]["inboundCallMode"]}};
    (api.linePatches??=[]).push(payload);
    document={...document,lines:document.lines.map(line=>line.id===payload.lineId?{...line,...payload.patch}:line)};
   }
   return route.fulfill({json:{document:{...document,snapshotId:undefined},canEdit:api.mode!=="readonly",canManageSettings:false}});
  }
  if(url.pathname==="/api/telephony/config/incoming"||url.pathname==="/api/telephony/config/ring-groups"){
   if(api.mode==="missing"&&url.pathname.endsWith("incoming"))return route.fulfill({status:503,json:{code:"config_snapshot_missing",error:"Not activated"}});
   if(route.request().method()==="PUT"){
    api.writes++;api.saved=route.request().postDataJSON();
    if(api.mode==="conflict"){document={...document,routingVersion:6,lines:document.lines.map(line=>({...line,inboundCallMode:"ring_ordered"})),plans:document.plans.map(plan=>({...plan,name:"Zmena kolegu"}))};return route.fulfill({status:409,json:{code:"stale_document",error:"Konfiguráciu medzitým zmenil kolega."}});}
    const payload=api.saved as {groups:RingGroupInput[];plans:RingPlanInput[];lineModes?:LineModeWrite[]};
    const lineModes=new Map((payload.lineModes??[]).map(line=>[line.id,line.inboundCallMode]));
    document={...document,lines:document.lines.map(line=>lineModes.has(line.id)&&api.mode!=="lost-mode"?{...line,inboundCallMode:lineModes.get(line.id)}:line),routingVersion:document.routingVersion+1,groups:payload.groups.map(group=>({...group,description:group.description??null,members:group.members.map(member=>({...member,lastOfferedAt:null,lastAnsweredAt:null}))})),plans:payload.plans} as RoutingDocument;
    if(api.mode==="lost-response"||api.mode==="lost-mode"||api.mode==="verify-retry")return route.abort("failed");
   }
   if(api.mode==="verify-retry"&&api.writes>0){
    api.verificationReads=(api.verificationReads??0)+1;
    if(api.verificationReads===1)return route.abort("failed");
    await new Promise<void>(resolve=>{api.releaseVerification=resolve;});
   }
   return route.fulfill({json:{document,canEdit:api.mode!=="readonly",canManageSettings:false}});
  }
  return route.fulfill({status:503,json:{error:"Isolated fixture"}});
 });
 await page.goto(`https://routing.test/${api.defaultLine?"?default-line":""}`);await page.addStyleTag({content:css});await page.addScriptTag({content:script});
 await expect(page.getByRole("region",{name:api.mode==="missing"?"Plány zvonenia":"Prichádzajúce hovory",exact:true})).toBeVisible();
 return errors;
}
async function openPlanDetails(page:Page,planId=ids.plan){
 const card=page.locator(`#ring-plan-${planId}`);
 if(!await card.getByLabel("Názov plánu",{exact:true}).isVisible())
  await card.getByText("Názov, stav a použitie plánu",{exact:true}).click();
 return card;
}
async function openLineMode(page:Page){
 const control=page.getByLabel(/Čo sa stane s hovorom na číslo/);
 if(!await control.isVisible())await page.locator("summary").filter({hasText:"Režim linky"}).click();
 return control;
}
function expectedGroups(document:RoutingDocument){
 // The read-only call history is not part of the replacement API contract.
 return document.groups.map(group=>({...group,members:group.members.map(member=>({
  id:member.id,memberKind:member.memberKind,profileId:member.profileId,externalNumber:member.externalNumber,
  ...(member.ownerProfileId!==undefined?{ownerProfileId:member.ownerProfileId}:{}),position:member.position,ringSecs:member.ringSecs,
 }))}));
}
for(const width of [1440,1280,390])test(`combined editor remains readable at ${width}px`,async({page})=>{
 const errors=await boot(page,width,{writes:0,document:dualDeviceRoutingFixture,defaultLine:true});await expect(page.getByRole("button",{name:"Uložiť všetky zmeny"})).toHaveCount(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const recipients=page.getByRole("list",{name:"Príjemcovia skupiny Martin – web a mobil",exact:true});
 await expect(recipients.getByRole("listitem")).toHaveCount(1);
 await expect(recipients.getByRole("listitem").filter({hasText:"Martin Novák"})).toHaveCount(1);
 await expect(page.getByRole("textbox",{name:/^Externé číslo/})).toHaveCount(0);
 await page.screenshot({path:path.join(screenshotDirectory,`people-save-${width}.png`),fullPage:true});
 if(width===1440)await page.getByRole("region",{name:"Prichádzajúce hovory",exact:true}).screenshot({path:path.join(screenshotDirectory,"people-save-detail.png")});
 if(width!==1280){
  const card=page.locator(`#ring-plan-${ids.plan}`);
  await card.getByRole("radiogroup",{name:"Ako zvoní",exact:true}).getByRole("radio",{name:/^postupne$/i}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:path.join(screenshotDirectory,`people-save-ordered-${width}.png`),fullPage:true});
 }
 expect(errors).toEqual([]);
});
test("one save includes inline group and plan changes without losing overrides",async({page})=>{
 const api:Api={writes:0};const errors=await boot(page,1440,api);
 await page.getByRole("radiogroup",{name:"Ako zvoní",exact:true}).getByRole("radio",{name:/^postupne$/i}).click();
 await page.locator(`#ring-plan-${ids.plan}`).getByText("Podrobnosti skupiny Dispečeri",{exact:true}).click();
 await page.getByLabel("Názov skupiny",{exact:true}).filter({visible:true}).fill("Tím pomoci");
 await page.getByRole("textbox",{name:/^(Spoločný čas zvonenia|Predvolený čas na osobu) \(s\)$/}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny"}).click();
 await expect(page.getByText("Všetky zmeny sú uložené spolu.",{exact:false})).toBeVisible();
 expect(api.writes).toBe(1);expect(api.saved).toMatchObject({version:5,groups:[{name:"Tím pomoci",members:[{ringSecs:null},{ringSecs:30}]}],plans:[{steps:[{timeoutSecs:25,strategy:"ordered"}]}]});expect(errors).toEqual([]);
});
test("keyboard ringing and fallback choices save the intended route",async({page})=>{
 const api:Api={writes:0};await boot(page,1440,api);
 const strategy=page.getByRole("radiogroup",{name:"Ako zvoní",exact:true});
 await strategy.getByRole("radio",{name:/naraz$/i}).focus();
 await page.keyboard.press("ArrowRight");
 await expect(strategy.getByRole("radio",{name:/^postupne$/i})).toBeChecked();
 const fallback=page.getByRole("radiogroup",{name:"Keď nikto nezdvihne",exact:true});
 await fallback.getByRole("radio",{name:"Čakáreň",exact:true}).focus();
 await page.keyboard.press("ArrowRight");
 await expect(fallback.getByRole("radio",{name:"Iné číslo",exact:true})).toBeChecked();
 await page.getByRole("textbox",{name:/^Číslo presmerovania/}).fill("+421900000004");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Všetky zmeny sú uložené spolu.",{exact:false})).toBeVisible();
 expect(api.writes).toBe(1);
 expect(api.saved).toMatchObject({groups:expectedGroups(routingFixture),plans:[{fallbackKind:"external_number",fallbackNumber:"+421900000004",steps:[{strategy:"ordered"}]}]});
});
test("recipient rows support keyboard ordering and directly editing a new number",async({page})=>{
 const api:Api={writes:0};await boot(page,1440,api);
 const card=page.locator(`#ring-plan-${ids.plan}`);
 const recipients=card.getByRole("list",{name:"Príjemcovia skupiny Dispečeri",exact:true});
 await card.getByRole("radiogroup",{name:"Ako zvoní",exact:true}).getByRole("radio",{name:/^postupne$/i}).click();
 await card.getByRole("button",{name:"Pridať číslo",exact:true}).click();
 await expect(recipients.locator('[role="listitem"]')).toHaveCount(3);
 await card.getByRole("textbox",{name:/^Externé číslo/}).fill("+421900000004");
 await card.getByLabel("Vlastník externého čísla",{exact:true}).selectOption(ids.jana);
 const handle=card.getByRole("button",{name:"Presunúť 1. člena skupiny Dispečeri",exact:true});
 await handle.focus();
 await page.keyboard.press("Space");
 await expect(handle).toHaveAttribute("aria-pressed","true");
 // KeyboardSensor registers its document listener asynchronously; wait for the
 // next paint so the following key uses the measured, active drag state.
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await page.keyboard.press("ArrowDown");
 await expect(page.getByRole("status").filter({hasText:new RegExp(`over droppable area .*${routingFixture.groups[0].members[1].id}`)})).toBeAttached();
 await page.keyboard.press("Space");
 await expect(handle).not.toHaveAttribute("aria-pressed","true");
 await expect(recipients.getByRole("listitem").nth(0)).toContainText("Peter Kováč");
 await expect(recipients.getByRole("listitem").nth(1)).toContainText("Jana Nováková");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Všetky zmeny sú uložené spolu.",{exact:false})).toBeVisible();
 expect(api.saved).toMatchObject({groups:[{members:[
  {id:routingFixture.groups[0].members[1].id,profileId:ids.peter,position:0,ringSecs:30},
  {id:routingFixture.groups[0].members[0].id,profileId:ids.jana,position:1,ringSecs:null},
  {memberKind:"external_number",externalNumber:"+421900000004",ownerProfileId:ids.jana,position:2,ringSecs:null},
 ]}]});
});
test("conflict preserves both drafts and displays current saved comparison",async({page})=>{
 const api:Api={mode:"conflict",writes:0};await boot(page,1440,api);await openPlanDetails(page);await page.getByLabel("Názov plánu",{exact:true}).fill("Moje zmeny");await (await openLineMode(page)).selectOption("ring_all");await page.getByRole("button",{name:"Uložiť všetky zmeny"}).click();
 await expect(page.getByLabel("Názov plánu",{exact:true})).toHaveValue("Moje zmeny");await expect(page.getByText("Zmena kolegu:",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Uložiť všetky zmeny"})).toBeDisabled();
 await expect(await openLineMode(page)).toHaveValue("ring_all");expect(api.linePatches??[]).toEqual([]);
 await page.getByRole("button",{name:"Zahodiť návrh a načítať uložené",exact:true}).click();
 await expect(await openLineMode(page)).toHaveValue("ring_ordered");
 await expect((await openPlanDetails(page)).getByLabel("Názov plánu",{exact:true})).toHaveValue("Zmena kolegu");
});
test("lost response verifies committed contents before allowing another save",async({page})=>{
 const api:Api={mode:"lost-response",writes:0};await boot(page,1440,api);await openPlanDetails(page);await page.getByLabel("Názov plánu",{exact:true}).fill("Overené po výpadku");await page.getByRole("button",{name:"Uložiť všetky zmeny"}).click();
 await expect(page.getByText("Uložený stav je overený.",{exact:false})).toBeVisible();expect(api.writes).toBe(1);await expect(page.getByRole("button",{name:"Uložiť všetky zmeny"})).toBeDisabled();
});
test("dirty tab departure offers save discard and stay",async({page})=>{
 await boot(page);await openPlanDetails(page);await page.getByLabel("Názov plánu",{exact:true}).fill("Zachovať návrh");await page.getByRole("button",{name:"Čísla",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Neuložené nastavenia"});await expect(dialog).toBeVisible();await dialog.getByRole("button",{name:"Zostať",exact:true}).click();await expect(page.getByLabel("Názov plánu",{exact:true})).toHaveValue("Zachovať návrh");await page.getByRole("button",{name:"Čísla",exact:true}).click();await expect(dialog).toBeVisible();await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
});
test("missing coherent RPC adapts deep link to existing plan editor",async({page})=>{
 await boot(page,1440,{mode:"missing",writes:0});await expect(page.locator(`#ring-plan-${ids.plan}`)).toBeVisible();await expect(page.getByRole("button",{name:"Prichádzajúce hovory",exact:true})).toHaveCount(0);
});
test("readonly dispatcher can inspect but not change routing",async({page})=>{
 await boot(page,1440,{mode:"readonly",writes:0});await openPlanDetails(page);await expect(page.getByLabel("Názov plánu",{exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"Uložiť všetky zmeny"})).toBeDisabled();
});

test("active line opens its plan and saving keeps unrelated plans and groups intact",async({page})=>{
 const api:Api={writes:0,document:multiLineRoutingFixture,defaultLine:true};
 const errors=await boot(page,1440,api);
 const line=page.getByRole("combobox",{name:"Linka",exact:true});
 await expect(line).toHaveValue(ids.line);
 await expect(page.locator(`#ring-plan-${ids.plan}`)).toBeVisible();
 await expect(page.locator(`#ring-plan-${extraIds.secondPlan}`)).toHaveCount(0);
 await expect(page.locator(`#ring-plan-${extraIds.unusedPlan}`)).toHaveCount(0);
 await line.selectOption(extraIds.secondLine);
 await expect(page.locator(`#ring-plan-${extraIds.secondPlan}`)).toBeVisible();
 await expect(page.locator(`#ring-plan-${ids.plan}`)).toHaveCount(0);
 await line.selectOption(ids.line);
 await page.getByRole("textbox",{name:/^(Spoločný čas zvonenia|Predvolený čas na osobu) \(s\)$/}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Všetky zmeny sú uložené spolu.",{exact:false})).toBeVisible();
 const expectedPlans=structuredClone(multiLineRoutingFixture.plans);
 expectedPlans[0].steps[0].timeoutSecs=25;
 expect(api.writes).toBe(1);
 expect(api.saved).toEqual({version:5,groups:expectedGroups(multiLineRoutingFixture),plans:expectedPlans});

 await page.getByRole("button",{name:"Všetky plány",exact:true}).click();
 await expect(page.locator(`#ring-plan-${extraIds.unusedPlan}`)).toBeVisible();
 await expect(page.locator('[id^="ring-plan-"]')).toHaveCount(3);
 // Creating a plan from the line scope must reveal the new, unassigned draft.
 await line.selectOption(ids.line);
 await page.getByRole("button",{name:"Pridať plán",exact:true}).click();
 await expect(line).toHaveValue("");
 await expect(page.locator('[id^="ring-plan-"]')).toHaveCount(4);
 await expect(page.getByRole("heading",{name:"Nový plán",exact:true})).toBeVisible();
 expect(errors).toEqual([]);
});

test("simultaneous ringing hides personal timing and ordered ringing restores the saved override",async({page})=>{
 const api:Api={writes:0};await boot(page,1440,api);
 const card=page.locator(`#ring-plan-${ids.plan}`);
 await expect(card.getByLabel(/^Vlastný čas \(s\)/)).toHaveCount(0);
 await card.getByRole("radiogroup",{name:"Ako zvoní",exact:true}).getByRole("radio",{name:/^postupne$/i}).click();
 const memberTimes=card.getByLabel(/^Vlastný čas \(s\)/);
 await expect(memberTimes).toHaveCount(2);
 await expect(memberTimes.nth(0)).toHaveValue("");
 await expect(memberTimes.nth(1)).toHaveValue("30");
 await card.getByRole("radiogroup",{name:"Ako zvoní",exact:true}).getByRole("radio",{name:/naraz$/i}).click();
 await expect(memberTimes).toHaveCount(0);
 await card.getByRole("textbox",{name:/^(Spoločný čas zvonenia|Predvolený čas na osobu) \(s\)$/}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Všetky zmeny sú uložené spolu.",{exact:false})).toBeVisible();
 expect(api.saved).toMatchObject({groups:expectedGroups(routingFixture),plans:[{steps:[{strategy:"all",timeoutSecs:25}]}]});
});

test("queue mode hides automatic controls without losing drafts and hidden errors remain reachable",async({page})=>{
 const api:Api={writes:0,document:multiLineRoutingFixture};await boot(page,1440,api);
 const card=await openPlanDetails(page);
 await card.getByLabel("Názov plánu",{exact:true}).fill("");
 const mode=await openLineMode(page);
 await mode.selectOption("queue_first");
 await expect(page.getByRole("heading",{name:"Hovor čaká na ručné prevzatie",exact:true})).toBeVisible();
 await expect(page.locator('[id^="ring-plan-"]')).toHaveCount(0);
 await expect(page.getByRole("textbox",{name:/^(Spoločný čas zvonenia|Predvolený čas na osobu) \(s\)$/})).toHaveCount(0);
 await expect(page.getByLabel("Keď nikto nezdvihne",{exact:true})).toHaveCount(0);
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(0);
 expect(api.linePatches??[]).toEqual([]);

 await page.getByRole("combobox",{name:"Linka",exact:true}).selectOption(extraIds.secondLine);
 await expect(page.locator(`#ring-plan-${ids.plan}`)).toHaveCount(0);
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 await page.getByRole("button",{name:"Zobraziť všetky plány a chyby",exact:true}).click();
 const restored=await openPlanDetails(page);
 await expect(restored.getByLabel("Názov plánu",{exact:true})).toHaveValue("");
 await expect(restored.getByText("Plán potrebuje názov.",{exact:true})).toBeVisible();
 await restored.getByLabel("Názov plánu",{exact:true}).fill("Upravené prichádzajúce hovory");
 await page.getByRole("combobox",{name:"Linka",exact:true}).selectOption(ids.line);
 await openLineMode(page);
 await mode.selectOption("");
 await expect(page.locator(`#ring-plan-${ids.plan}`)).toBeVisible();
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Všetky zmeny sú uložené spolu.",{exact:false})).toBeVisible();
 const expectedPlans=structuredClone(multiLineRoutingFixture.plans);
 expectedPlans[0].name="Upravené prichádzajúce hovory";
 expect(api.saved).toEqual({version:5,groups:expectedGroups(multiLineRoutingFixture),plans:expectedPlans});
 expect(api.linePatches??[]).toEqual([]);
});

test("line strategy overrides show effective ringing without rewriting the shared plan",async({page})=>{
 const document=structuredClone(routingFixture);
 document.lines[0].inboundCallMode="ring_all";
 document.plans[0].steps[0].strategy="ordered";
 const api:Api={writes:0,document};await boot(page,1440,api);
 const card=page.locator(`#ring-plan-${ids.plan}`);
 await expect(card.getByRole("radiogroup",{name:"Ako zvoní",exact:true})).toHaveCount(0);
 await expect(card.getByText(/Účinný čas kroku: najviac 20 s pre všetkých v jednom kole/)).toBeVisible();
 await expect(card.getByLabel(/^Vlastný čas \(s\)/)).toHaveCount(0);
 await card.getByRole("textbox",{name:/^(Spoločný čas zvonenia|Predvolený čas na osobu) \(s\)$/}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Všetky zmeny sú uložené spolu.",{exact:false})).toBeVisible();
 expect(api.saved).toMatchObject({groups:expectedGroups(document),plans:[{steps:[{strategy:"ordered",timeoutSecs:25}]}]});
 await (await openLineMode(page)).selectOption("ring_ordered");
 await expect(card.getByRole("radiogroup",{name:"Ako zvoní",exact:true})).toHaveCount(0);
 await expect(card.getByLabel(/^Vlastný čas \(s\)/).nth(1)).toHaveValue("30");
 // The library exposes the stored shared strategy, independent of this line.
 await page.getByRole("button",{name:"Všetky plány",exact:true}).click();
 await expect(card.getByRole("radiogroup",{name:"Ako zvoní",exact:true}).getByRole("radio",{name:/^postupne$/i})).toBeChecked();
});

test("unavailable personal mobile controls preserve existing ownership during an unrelated save",async({page})=>{
 const document=structuredClone(multiLineRoutingFixture);
 document.capabilities={ownedMobileRouting:false,defaultInboundCallMode:"ring_first",atomicIncomingLineModes:true};
 document.groups[1].members[0].ownerProfileId=ids.peter;
 const api:Api={writes:0,document};await boot(page,1440,api);
 await page.getByRole("combobox",{name:"Linka",exact:true}).selectOption(extraIds.secondLine);
 const card=page.locator(`#ring-plan-${extraIds.secondPlan}`);
 await card.getByRole("button",{name:/^Upraviť príjemcu/}).click();
 await expect(card.getByLabel("Vlastník externého čísla",{exact:true})).toHaveCount(0);
 await expect(card.getByRole("textbox",{name:/^Externé číslo/})).toBeVisible();
 await card.getByRole("textbox",{name:/^(Spoločný čas zvonenia|Predvolený čas na osobu) \(s\)$/}).fill("40");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Všetky zmeny sú uložené spolu.",{exact:false})).toBeVisible();
 const expectedPlans=structuredClone(document.plans);
 expectedPlans[1].steps[0].timeoutSecs=40;
 expect(api.saved).toEqual({version:5,groups:expectedGroups(document),plans:expectedPlans});
});

test("one save commits the line mode together with group and plan changes",async({page})=>{
 const api:Api={writes:0};await boot(page,1440,api);
 await (await openLineMode(page)).selectOption("ring_ordered");
 await page.locator(`#ring-plan-${ids.plan}`).getByText("Podrobnosti skupiny Dispečeri",{exact:true}).click();
 await page.getByLabel("Názov skupiny",{exact:true}).filter({visible:true}).fill("Tím pomoci");
 await page.getByRole("textbox",{name:/^Predvolený čas na osobu \(s\)$/}).fill("25");
 expect(api.writes).toBe(0);expect(api.linePatches??[]).toEqual([]);
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeEnabled();
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(1);expect(api.linePatches??[]).toEqual([]);
 expect(api.saved).toMatchObject({version:5,lineModes:[{id:ids.line,inboundCallMode:"ring_ordered",expectedInboundCallMode:null}],groups:[{name:"Tím pomoci",members:[{ringSecs:null},{ringSecs:30}]}],plans:[{steps:[{timeoutSecs:25,strategy:"all"}]}]});
 await expect(await openLineMode(page)).toHaveValue("ring_ordered");
});

test("line-only changes are drafted across lines and save only changed modes",async({page})=>{
 const api:Api={writes:0,document:multiLineRoutingFixture};await boot(page,1440,api);
 const line=page.getByRole("combobox",{name:"Linka",exact:true});
 await (await openLineMode(page)).selectOption("queue_first");
 await line.selectOption(extraIds.secondLine);
 await (await openLineMode(page)).selectOption("ring_all");
 await line.selectOption(ids.line);
 await expect(await openLineMode(page)).toHaveValue("queue_first");
 expect(api.writes).toBe(0);expect(api.linePatches??[]).toEqual([]);
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(1);
 expect(api.saved).toEqual({version:5,groups:expectedGroups(multiLineRoutingFixture),plans:multiLineRoutingFixture.plans,lineModes:[
  {id:ids.line,inboundCallMode:"queue_first",expectedInboundCallMode:null},
  {id:extraIds.secondLine,inboundCallMode:"ring_all",expectedInboundCallMode:null},
 ]});
 expect(api.linePatches??[]).toEqual([]);
});

test("discard restores both line mode and plan without a write",async({page})=>{
 const api:Api={writes:0};await boot(page,1440,api);
 await (await openPlanDetails(page)).getByLabel("Názov plánu",{exact:true}).fill("Neuložený názov");
 await (await openLineMode(page)).selectOption("queue_first");
 await expect(page.getByRole("heading",{name:"Hovor čaká na ručné prevzatie",exact:true})).toBeVisible();
 page.once("dialog",dialog=>dialog.accept());
 await page.getByRole("button",{name:"Zahodiť",exact:true}).click();
 await expect(await openLineMode(page)).toHaveValue("");
 await expect((await openPlanDetails(page)).getByLabel("Názov plánu",{exact:true})).toHaveValue(routingFixture.plans[0].name);
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(0);expect(api.linePatches??[]).toEqual([]);
});

test("line mode alone protects tab departure and is discarded with the rest",async({page})=>{
 const api:Api={writes:0};await boot(page,1440,api);
 await (await openLineMode(page)).selectOption("ring_all");
 await page.getByRole("button",{name:"Čísla",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Neuložené nastavenia"});
 await expect(dialog).toBeVisible();
 await dialog.getByRole("button",{name:"Zostať",exact:true}).click();
 await expect(await openLineMode(page)).toHaveValue("ring_all");
 await page.getByRole("button",{name:"Čísla",exact:true}).click();
 await dialog.getByRole("button",{name:"Zahodiť a pokračovať",exact:true}).click();
 await expect(dialog).toHaveCount(0);
 await page.getByRole("button",{name:"Prichádzajúce hovory",exact:true}).click();
 await expect(await openLineMode(page)).toHaveValue("");
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(0);expect(api.linePatches??[]).toEqual([]);
});

test("lost response verifies the line mode as well as plans",async({page})=>{
 const api:Api={mode:"lost-response",writes:0};await boot(page,1440,api);
 await (await openPlanDetails(page)).getByLabel("Názov plánu",{exact:true}).fill("Overené spolu");
 await (await openLineMode(page)).selectOption("ring_all");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Uložený stav je overený.",{exact:false})).toBeVisible();
 await expect(await openLineMode(page)).toHaveValue("ring_all");
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(1);expect(api.saved).toMatchObject({lineModes:[{id:ids.line,inboundCallMode:"ring_all",expectedInboundCallMode:null}]});
});

test("a different saved line mode prevents accepting matching plans after a lost response",async({page})=>{
 const api:Api={mode:"lost-mode",writes:0};await boot(page,1440,api);
 await (await openPlanDetails(page)).getByLabel("Názov plánu",{exact:true}).fill("Zachovaný návrh");
 await (await openLineMode(page)).selectOption("ring_all");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByText("Uložený stav sa líši.",{exact:false})).toBeVisible();
 await expect(page.getByText("Uložený stav je overený.",{exact:false})).toHaveCount(0);
 await expect(await openLineMode(page)).toHaveValue("ring_all");
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(1);expect(api.linePatches??[]).toEqual([]);
});

test("one person controls Web and Mobil while toggling preserves exact endpoint data",async({page})=>{
 const api:Api={writes:0,document:dualDeviceRoutingFixture};await boot(page,1440,api);
 const card=page.locator(`#ring-plan-${ids.plan}`);
 const recipients=card.getByRole("list",{name:"Príjemcovia skupiny Martin – web a mobil",exact:true});
 await expect(recipients.getByRole("listitem")).toHaveCount(1);
 const mobile=recipients.getByRole("checkbox",{name:"Mobil pre Martin Novák",exact:true});
 const web=recipients.getByRole("checkbox",{name:"Web pre Martin Novák",exact:true});
 await expect(mobile).toBeChecked();await expect(web).toBeChecked();
 await mobile.focus();await page.keyboard.press("Space");
 await expect(mobile).not.toBeChecked();await expect(web).toBeChecked();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeEnabled();
 await page.keyboard.press("Space");await expect(mobile).toBeChecked();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 await card.getByRole("textbox",{name:/^Spoločný čas zvonenia \(s\)$/}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.saved).toMatchObject({groups:expectedGroups(dualDeviceRoutingFixture)});
 expect(api.linePatches??[]).toEqual([]);
});

test("ordered ringing exposes the true interleaved device sequence",async({page})=>{
 const document=structuredClone(dualDeviceRoutingFixture);
 const members=document.groups[0].members;
 document.groups[0].members=[members[0],{...routingFixture.groups[0].members[1],id:"00000000-0000-4000-8000-000000000413",position:1},{...members[1],position:2}];
 const api:Api={writes:0,document};await boot(page,1440,api);
 const card=page.locator(`#ring-plan-${ids.plan}`);
 const recipients=card.getByRole("list",{name:"Príjemcovia skupiny Martin – web a mobil",exact:true});
 await expect(recipients.getByRole("listitem")).toHaveCount(2);
 await card.getByRole("radiogroup",{name:"Ako zvoní",exact:true}).getByRole("radio",{name:/^postupne$/i}).click();
 await expect(recipients.getByRole("listitem")).toHaveCount(3);
 await expect(recipients.getByRole("listitem").nth(0)).toContainText("Martin Novák");
 await expect(recipients.getByRole("listitem").nth(0)).toContainText("Web");
 await expect(recipients.getByRole("listitem").nth(1)).toContainText("Peter Kováč");
 await expect(recipients.getByRole("listitem").nth(2)).toContainText("Martin Novák");
 await expect(recipients.getByRole("listitem").nth(2)).toContainText("Mobil");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 const expectedPlans=structuredClone(document.plans);expectedPlans[0].steps[0].strategy="ordered";
 expect(api.saved).toMatchObject({groups:expectedGroups(document),plans:expectedPlans});
});

test("enabling mobile on a Web-only person adds one owned device and preserves Web",async({page})=>{
 const document=structuredClone(dualDeviceRoutingFixture);
 document.groups[0].members=[document.groups[0].members[0]];
 const api:Api={writes:0,document};await boot(page,1440,api);
 const card=page.locator(`#ring-plan-${ids.plan}`);
 const mobile=card.getByRole("checkbox",{name:"Mobil pre Martin Novák",exact:true});
 await expect(mobile).not.toBeChecked();await mobile.check();
 await expect(card.getByRole("checkbox",{name:"Web pre Martin Novák",exact:true})).toBeChecked();
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 const saved=api.saved as {groups:RingGroupInput[]};
 expect(saved.groups[0].members).toHaveLength(2);
 expect(saved.groups[0].members[0]).toEqual(expectedGroups(document)[0].members[0]);
 expect(saved.groups[0].members[1]).toMatchObject({memberKind:"external_number",profileId:null,externalNumber:"+421900000001",ownerProfileId:ids.jana,position:1,ringSecs:null});
 expect(api.writes).toBe(1);expect(api.linePatches??[]).toEqual([]);
});

test("unavailable mobile stays visible but cannot be enabled or lose existing ownership",async({page})=>{
 const document=structuredClone(dualDeviceRoutingFixture);
 document.capabilities={...document.capabilities!,ownedMobileRouting:false};
 const api:Api={writes:0,document};await boot(page,1440,api);
 const card=page.locator(`#ring-plan-${ids.plan}`);
 const mobile=card.getByRole("checkbox",{name:"Mobil pre Martin Novák",exact:true});
 await expect(mobile).toBeChecked();await expect(mobile).toBeDisabled();
 await expect(card.getByText("Zvonenie na osobné čísla tu nie je dostupné.",{exact:false})).toBeVisible();
 await card.getByRole("textbox",{name:/^Spoločný čas zvonenia \(s\)$/}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.saved).toMatchObject({groups:expectedGroups(document)});
});

test("a database without joint mode saving offers no immediate line-mode write",async({page})=>{
 const document=structuredClone(routingFixture);
 document.capabilities={...document.capabilities!,atomicIncomingLineModes:false};
 const api:Api={writes:0,document};await boot(page,1440,api);
 const mode=await openLineMode(page);
 await expect(mode).toBeDisabled();
 await expect(page.getByText("Režim môžeš zmeniť v nastavení čísla.",{exact:false})).toBeVisible();
 await page.getByRole("textbox",{name:/^Spoločný čas zvonenia \(s\)$/}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.saved).not.toHaveProperty("lineModes");expect(api.linePatches??[]).toEqual([]);
});

test("temporarily hidden devices restore exact data after queue and line changes",async({page})=>{
 const api:Api={writes:0,document:dualDeviceRoutingFixture};await boot(page,1440,api);
 const card=page.locator(`#ring-plan-${ids.plan}`);
 await card.getByRole("checkbox",{name:"Mobil pre Martin Novák",exact:true}).uncheck();
 await (await openLineMode(page)).selectOption("queue_first");
 await expect(card).toHaveCount(0);
 const line=page.getByRole("combobox",{name:"Linka",exact:true});
 await line.selectOption(extraIds.secondLine);
 await line.selectOption(ids.line);
 await (await openLineMode(page)).selectOption("");
 await card.getByRole("checkbox",{name:"Mobil pre Martin Novák",exact:true}).check();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(0);expect(api.linePatches??[]).toEqual([]);
 await card.getByRole("textbox",{name:/^Spoločný čas zvonenia \(s\)$/}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.saved).not.toHaveProperty("lineModes");
 expect(api.saved).toMatchObject({groups:expectedGroups(dualDeviceRoutingFixture)});
});

test("manual verification keeps mode plan and device edits locked until the read resolves",async({page})=>{
 const api:Api={mode:"verify-retry",writes:0,document:dualDeviceRoutingFixture};await boot(page,1440,api);
 const card=await openPlanDetails(page);
 await card.getByLabel("Názov plánu",{exact:true}).fill("Spoločne overený plán");
 await (await openLineMode(page)).selectOption("ring_all");
 await page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true}).click();
 const verify=page.getByRole("button",{name:"Overiť uložený stav",exact:true});
 await expect(verify).toBeEnabled();
 await verify.click();
 await expect.poll(()=>Boolean(api.releaseVerification)).toBe(true);
 try{
  await expect(verify).toBeDisabled();
  await expect(await openLineMode(page)).toBeDisabled();
  await expect(card.getByLabel("Názov plánu",{exact:true})).toBeDisabled();
  await expect(card.getByRole("checkbox",{name:"Web pre Martin Novák",exact:true})).toBeDisabled();
  await expect(card.getByRole("checkbox",{name:"Mobil pre Martin Novák",exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Zahodiť",exact:true})).toBeDisabled();
 }finally{api.releaseVerification?.();}
 await expect(page.getByText("Uložený stav je overený.",{exact:false})).toBeVisible();
 await expect(await openLineMode(page)).toHaveValue("ring_all");
 await expect(card.getByLabel("Názov plánu",{exact:true})).toHaveValue("Spoločne overený plán");
 await expect(page.getByRole("button",{name:"Uložiť všetky zmeny",exact:true})).toBeDisabled();
 expect(api.writes).toBe(1);expect(api.verificationReads).toBe(2);expect(api.linePatches??[]).toEqual([]);
});
