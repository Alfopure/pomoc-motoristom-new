import { expect,test } from '@playwright/test';
import { build } from 'esbuild';
let script:string;
test.beforeAll(async()=>{
  const result=await build({entryPoints:['e2e/fixtures/callback-unified.tsx'],bundle:true,write:false,outfile:'callback-test.js',platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
  script=result.outputFiles.find((file)=>file.path.endsWith(".js"))!.text;
});
test('CB-12/14: one live request queue, done leaves missed history, explicit scheduling carries a user action id',async({page})=>{
  const at='2026-09-07T08:30:00Z';
  const request={id:'00000000-0000-4000-8000-000000000801',callerNumber:'+421900000001',callerName:'Pending request',source:'missed',status:'open',lineId:null,lineLabel:'Testovacia linka',partnerName:null,caseId:null,sessionId:null,claimedByProfileId:null,claimedByName:null,claimedAt:null,dueAt:at,createdAt:at,resolvedAt:null,notes:null,lastCallSessionId:null,lastCalledAt:null};
  let resolved=false; const actions:Record<string,unknown>[]=[]; const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const url=route.request().url();
    if(url==='https://callback.test/') return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div>'});
    if(url.endsWith('/api/telephony/directory')) return route.fulfill({json:{contacts:[]}});
    if(url.endsWith('/api/telephony/directory/favorites')) return route.fulfill({json:{favorites:[]}});
    if(url.endsWith('/api/telephony/callbacks')) return route.fulfill({json:{unifiedRequests:true,schedulingEnabled:true,configured:true,checkedAt:at,actorProfileId:'operator',actorRole:'dispatcher',open:resolved?[]:[request],resolved:resolved?[{...request,status:'done'}]:[]}});
    if(url.endsWith(`/callbacks/${request.id}/done`)){resolved=true;return route.fulfill({json:{ok:true}});}
    if(url.endsWith('/calls/00000000-0000-4000-8000-000000000901/outcome')){
      actions.push(route.request().postDataJSON());return route.fulfill({json:{dispatchData:{}}});
    }
    errors.push(`Unexpected network ${url}`);return route.abort();
  });
  await page.goto('https://callback.test/');await page.addScriptTag({content:script});
  await expect(page.getByText('1 čaká na spätné volanie',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Vybavené',exact:true})).toHaveCount(1);
  await page.getByRole('button',{name:'Vybavené',exact:true}).click();
  await expect(page.getByRole('button',{name:'Vybavené',exact:true})).toHaveCount(0);
  await expect(page.getByText('1 čaká na spätné volanie',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Zmeškaný',{exact:true}).first()).toBeVisible();
  await page.getByLabel('Naplánovať spätné volanie',{exact:true}).selectOption('00000000-0000-4000-8000-000000000901');
  await page.getByRole('button',{name:'Naplánovať o 30 minút',exact:true}).click();
  await expect(page.getByText('Spätné volanie je naplánované.',{exact:true})).toBeVisible();
  expect(actions).toHaveLength(1);expect(actions[0]).toMatchObject({outcome:'callback',callbackMinutes:30,callbackActionId:expect.stringMatching(/^[0-9a-f-]{36}$/)});
  await expect(page.getByText('Staršie samostatné úlohy na spätné volanie zostávajú v prehľade úloh.',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
