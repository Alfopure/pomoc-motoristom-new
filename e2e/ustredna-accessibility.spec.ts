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
 if(u.pathname==="/api/telephony/team")return send({checkedAt:new Date().toISOString(),operators:[{profileId:"1",name:"Jana Nováková",status:"available",statusSince:new Date(Date.now()-180000).toISOString(),answeredToday:12},{profileId:"2",name:"Peter Veselý",status:"on_call",statusSince:new Date(Date.now()-90000).toISOString(),answeredToday:8,call:{callerNumber:"+421900000031",sessionId:"colleague"}},{profileId:"3",name:"Eva Tichá",status:"offline",statusSince:new Date(Date.now()-3600000).toISOString(),answeredToday:0}]});
 if(u.pathname==="/api/telephony/routing-summary")return send({snapshotId:"fixture",checkedAt:new Date().toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),canEdit:true,lines:[{id:"00000000-0000-4000-8000-000000000030",label:"Asistencia",phoneNumber:"+421900000000",status:"open",sentence:"Dostupným členom Dispečingu zvoní naraz najviac 20 s. Ak nikto nezdvihne, hovor prejde do čakárne.",branches:[],notes:[],target:{section:"telephony",tab:"incoming",lineId:"00000000-0000-4000-8000-000000000030"}}]});
 if(u.pathname==="/api/notifications")return send({notifications:[]});
 if(u.pathname==="/api/telephony/directory/favorites")return send({favorites:[]});
 if(u.pathname==="/api/health/live")return send({version:"isolated-workspace"});
 return route.fulfill({status:503,json:{error:"Izolovaný test: služba nedostupná."}});
 });
 await page.goto(origin+"/?view=call-center");await page.addStyleTag({content:css});await page.addScriptTag({content:script});
 try { await expect(page.getByTestId("call-center-history")).toBeVisible(); } catch (error) { throw new Error(`Boot errors: ${errors.join("; ")}`, {cause:error}); } await expect(page.getByTestId("call-center-history").getByText("Testovací klient 1",{exact:true}).filter({visible:true})).toBeVisible();return{errors,queries};
}
test("Ústredňa at the CSS viewport equivalent of 200% browser zoom keeps actions reachable", async ({ browser }) => {
 // Browser zoom halves the CSS viewport and activates responsive breakpoints.
 // CSS zoom alone does not model that behavior, so use 640×400 CSS pixels at
 // DPR 2 for the equivalent 1280×800 physical display.
 const context = await browser.newContext({viewport:{width:640,height:400},deviceScaleFactor:2});
 const page = await context.newPage();
 const { errors } = await boot(page, 640, 400);
 for (const state of ["idle", "busy", "waiting"]) {
  await page.evaluate(state => window.dispatchEvent(new CustomEvent("fixture-calls", {detail:state})), state);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const brand = await page.locator(".dispatch-account-trigger").boundingBox();
  const registration = await page.getByTestId("phone-registration").boundingBox();
  expect(brand!.x + brand!.width).toBeLessThanOrEqual(registration!.x);
  const search = page.getByRole("searchbox", {name:"Hľadať v celej histórii"});
  await search.scrollIntoViewIfNeeded();
  await expect(search).toBeInViewport();
  const callAction = page.getByTestId("call-history-row").first().getByRole("button", {name:/^Volať/}).filter({visible:true}).first();
  await callAction.scrollIntoViewIfNeeded();
  await expect(callAction).toBeInViewport();
  const actionBounds = await callAction.boundingBox();
  expect(actionBounds!.x).toBeGreaterThanOrEqual(0);
  expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(640);
  // Trial click checks that another panel does not cover the primary action.
  await callAction.click({trial:true});
  await page.screenshot({path:`.context/ustredna-app-zoom200-${state}.png`});
 }
 expect(errors).toEqual([]);
 await context.close();
});

test("reduced motion and keyboard-only header queue controls", async ({ page }) => {
 await page.emulateMedia({reducedMotion:"reduce"});
 const { errors } = await boot(page, 390, 844);
 await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-calls", {detail:"waiting"})));
 expect(await page.locator('[class*="motion-safe:animate-pulse"]').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === "none"))).toBe(true);
 const trigger = page.locator('summary[aria-label="Spätné volania: 125"]');
 await trigger.focus(); await page.keyboard.press("Enter");
 const menu = trigger.locator("..");
 const goToQueue = menu.getByRole("button", {name:"Otvoriť ústredňu a všetky spätné volania"});
 await expect(goToQueue).toBeVisible();
 const box = await goToQueue.boundingBox();
 expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
 await page.keyboard.press("Tab"); await expect(goToQueue).toBeFocused();
 await page.keyboard.press("Escape"); await expect(goToQueue).toBeHidden(); await expect(trigger).toBeFocused();
 expect(errors).toEqual([]);
});
