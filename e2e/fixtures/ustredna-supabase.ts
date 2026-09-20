/** Browser-only API fake. No credentials, sockets or remote database access. */
export function createSupabaseBrowserClient() {
 return {
   auth: { onAuthStateChange: () => ({data:{subscription:{unsubscribe(){}}}}), getSession: async()=>({data:{session:{access_token:"isolated"}}}), signOut:async()=>({error:null}) },
   realtime:{setAuth:async()=>{}},
   channel:()=>{ const channel={on:()=>channel,subscribe:(callback?:(status:string)=>void)=>{queueMicrotask(()=>callback?.("SUBSCRIBED"));return channel;},unsubscribe:async()=>{}};return channel; },
   removeChannel:async()=>{},
 };
}
