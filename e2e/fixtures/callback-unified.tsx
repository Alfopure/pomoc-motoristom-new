import { createRoot } from 'react-dom/client';
import { CallCenterModule } from '../../src/components/dispatch/CallCenterModule';
import type { CallCenterCall } from '../../src/data/dispatch-types';
const noop=()=>{};
const call:CallCenterCall={id:'00000000-0000-4000-8000-000000000901',status:'missed',direction:'inbound',callerNumber:'+421900000001',calledNumber:'+421900000002',lineLabel:'Testovacia linka',startedAt:'2026-09-07T08:00:00Z',endedAt:'2026-09-07T08:01:00Z',waitSeconds:60,recordingStatus:'not_requested',transcriptStatus:'not_requested',history:[]};
createRoot(document.getElementById('root')!).render(<CallCenterModule
  telephonyConfigured onCallAction={noop} onAnswer={noop} onRejectOffer={noop} canManageCalls={false} onSupervise={noop} onStopSupervise={noop}
  calls={[call]} cases={[]} dataSource="supabase" metrics={{totalCalls:1,answeredCalls:0,missedCalls:1,newCases:0,openTasks:0,futileTrips:0,answerRate:0,serviceLevel:0}}
  operatorPresences={[]} operators={[]} onDataChange={noop} onDial={async()=>{}} onNewCase={noop} onNewCaseFromLiveCall={noop} onOpenCase={noop} onAvailabilityAction={noop} onTelephonyChanged={noop}
/>);
