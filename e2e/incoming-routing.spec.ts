import { test,expect,type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { routingFixture,ids } from "./fixtures/incoming-routing-data";
import { buildRoutingSummary } from "../src/lib/telephony/routing-summary";
import type { RingGroupInput,RingPlanInput,RoutingDocument } from "../src/server/telephony/config-service";
const postcss=createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script:string,css:string;
test.use({ launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}), args:["--no-sandbox"] } });
test.beforeAll(async()=>{
 const bundle=await build({entryPoints:["e2e/fixtures/incoming-routing.tsx"],outfile:".context/incoming-routing-fixture.js",bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env":JSON.stringify({NODE_ENV:"production"})}});
 script=bundle.outputFiles.find(file=>file.path.endsWith(".js"))!.text;
 css=(await postcss([tailwindcss({base:process.cwd(),optimize:true})]).process(await readFile("src/app/globals.css","utf8"),{from:path.resolve("src/app/globals.css")})).css;
});
type Api={mode?:"conflict"|"lost-response"|"missing"|"readonly";saved?:Record<string,unknown>;writes:number};
async function boot(page:Page,width=1440,api:Api={writes:0}){
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));let document=structuredClone(routingFixture);
 await page.setViewportSize({width,height:950});
 await page.route("**/*",async route=>{
  const url=new URL(route.request().url());if(url.origin!=="https://routing.test")return route.abort();
  if(url.pathname==="/")return route.fulfill({contentType:"text/html",body:'<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>'});
  if(url.pathname==="/api/telephony/routing-summary")return route.fulfill({json:buildRoutingSummary(document,new Date(),true)});
  if(url.pathname==="/api/telephony/config/incoming"||url.pathname==="/api/telephony/config/ring-groups"){
   if(api.mode==="missing"&&url.pathname.endsWith("incoming"))return route.fulfill({status:503,json:{code:"config_snapshot_missing",error:"Not activated"}});
   if(route.request().method()==="PUT"){
    api.writes++;api.saved=route.request().postDataJSON();
    if(api.mode==="conflict"){document={...document,routingVersion:6,plans:document.plans.map(plan=>({...plan,name:"Zmena kolegu"}))};return route.fulfill({status:409,json:{code:"stale_document",error:"Konfiguráciu medzitým zmenil kolega."}});}
    const payload=api.saved as {groups:RingGroupInput[];plans:RingPlanInput[]};
    document={...document,routingVersion:document.routingVersion+1,groups:payload.groups.map(group=>({...group,description:group.description??null,members:group.members.map(member=>({...member,lastOfferedAt:null,lastAnsweredAt:null}))})),plans:payload.plans} as RoutingDocument;
    if(api.mode==="lost-response")return route.abort("failed");
   }
   return route.fulfill({json:{document,canEdit:api.mode!=="readonly",canManageSettings:false}});
  }
  return route.fulfill({status:503,json:{error:"Isolated fixture"}});
 });
 await page.goto("https://routing.test/");await page.addStyleTag({content:css});await page.addScriptTag({content:script});
 await expect(page.getByRole("region",{name:api.mode==="missing"?"Plány zvonenia":"Prichádzajúce hovory",exact:true})).toBeVisible();
 return errors;
}
for(const width of [1440,1280,390])test(`combined editor remains readable at ${width}px`,async({page})=>{
 const errors=await boot(page,width);await expect(page.getByRole("button",{name:"Uložiť všetky zmeny"})).toHaveCount(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`.context/routing-implemented-${width}.png`,fullPage:true});expect(errors).toEqual([]);
});
test("one save includes inline group and plan changes without losing overrides",async({page})=>{
 const api:Api={writes:0};const errors=await boot(page,1440,api);
 await page.getByLabel("Ako zvoní",{exact:true}).selectOption("ordered");
 await page.getByText(/Členovia skupiny:.*Upraviť členov/).click();
 await page.getByLabel("Názov skupiny",{exact:true}).filter({visible:true}).fill("Tím pomoci");
 await page.getByLabel("Čas (s)",{exact:true}).fill("25");
 await page.getByRole("button",{name:"Uložiť všetky zmeny"}).click();
 await expect(page.getByText("Skupiny aj plány sú uložené spolu.",{exact:false})).toBeVisible();
 expect(api.writes).toBe(1);expect(api.saved).toMatchObject({version:5,groups:[{name:"Tím pomoci",members:[{ringSecs:null},{ringSecs:30}]}],plans:[{steps:[{timeoutSecs:25,strategy:"ordered"}]}]});expect(errors).toEqual([]);
});
test("conflict preserves both drafts and displays current saved comparison",async({page})=>{
 const api:Api={mode:"conflict",writes:0};await boot(page,1440,api);await page.getByLabel("Názov plánu",{exact:true}).fill("Moje zmeny");await page.getByRole("button",{name:"Uložiť všetky zmeny"}).click();
 await expect(page.getByLabel("Názov plánu",{exact:true})).toHaveValue("Moje zmeny");await expect(page.getByText("Zmena kolegu:",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Uložiť všetky zmeny"})).toBeDisabled();
});
test("lost response verifies committed contents before allowing another save",async({page})=>{
 const api:Api={mode:"lost-response",writes:0};await boot(page,1440,api);await page.getByLabel("Názov plánu",{exact:true}).fill("Overené po výpadku");await page.getByRole("button",{name:"Uložiť všetky zmeny"}).click();
 await expect(page.getByText("Uložený stav je overený.",{exact:false})).toBeVisible();expect(api.writes).toBe(1);await expect(page.getByRole("button",{name:"Uložiť všetky zmeny"})).toBeDisabled();
});
test("dirty tab departure offers save discard and stay",async({page})=>{
 await boot(page);await page.getByLabel("Názov plánu",{exact:true}).fill("Zachovať návrh");await page.getByRole("button",{name:"Čísla",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Neuložené nastavenia"});await expect(dialog).toBeVisible();await dialog.getByRole("button",{name:"Zostať",exact:true}).click();await expect(page.getByLabel("Názov plánu",{exact:true})).toHaveValue("Zachovať návrh");await page.getByRole("button",{name:"Čísla",exact:true}).click();await expect(dialog).toBeVisible();await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
});
test("missing coherent RPC adapts deep link to existing plan editor",async({page})=>{
 await boot(page,1440,{mode:"missing",writes:0});await expect(page.locator(`#ring-plan-${ids.plan}`)).toBeVisible();await expect(page.getByRole("button",{name:"Prichádzajúce hovory",exact:true})).toHaveCount(0);
});
test("readonly dispatcher can inspect but not change routing",async({page})=>{
 await boot(page,1440,{mode:"readonly",writes:0});await expect(page.getByLabel("Názov plánu",{exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"Uložiť všetky zmeny"})).toBeDisabled();
});
