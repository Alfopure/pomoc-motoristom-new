import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CaseDetail } from '@/components/dispatch/CaseDetail';
import { collaborationCard } from './case-collaboration-data';
import type { DispatchCase } from '@/domain/types';

const observed = { dirty: [] as boolean[], saving: [] as boolean[] };
Object.assign(window, { editorFeedback: observed });
function Fixture() {
  const [card] = useState<DispatchCase>({ ...collaborationCard,
    jobTypes: ['replacement_vehicle'], customerDetails: { ...collaborationCard.customerDetails, type: 'insurance', assistanceServiceName: 'Synthetic assistance', assistanceReference: 'FIXTURE' },
    replacementVehicle: { ...collaborationCard.replacementVehicle, needed: true },
  });
  const [editorState, setEditorState] = useState({ dirty: false, saving: false });
  const [revision, setRevision] = useState(0);
  return <>
    <button onClick={() => setRevision(value => value + 1)}>Obnoviť nadradený panel</button>
    <output>{JSON.stringify({ ...editorState, revision })}</output>
    <CaseDetail caseItem={card} assets={[]} branches={[]} partnerDirectory={[]} editing persistentEditing compactEditor
      onDirtyChange={dirty => { observed.dirty.push(dirty); setEditorState(current => ({ ...current, dirty })); }}
      onSavingChange={saving => { observed.saving.push(saving); setEditorState(current => ({ ...current, saving })); }} />
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
