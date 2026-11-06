"use client";

import { useId, useState } from "react";
import { BookOpen, Truck } from "lucide-react";
import type { TowingView } from "@/domain/towing/types";
import { TowingWorkspace } from "./TowingWorkspace";
import { usePendingChanges, type PendingChangesReporter } from "./primitives";
import styles from "./towing.module.css";

export type TowingModuleAccess = { office: boolean; driver: boolean };

/** The shared console owns the application header and keeps this module mounted. */
export function TowingModule({ access, initialOrderId, sourceCaseId, onPendingChangesChange, revealPendingRequest = 0 }: {
  access: TowingModuleAccess;
  initialOrderId?: string;
  sourceCaseId?: string;
  onPendingChangesChange?: PendingChangesReporter;
  revealPendingRequest?: number;
}) {
  const [selection, setSelection] = useState<{ view: TowingView; reveal: number }>({ view: access.office ? "office" : "driver", reveal: revealPendingRequest });
  const selectedView = selection.view;
  const [visitedViews, setVisitedViews] = useState<TowingView[]>([access.office ? "office" : "driver"]);
  const [officePending, setOfficePending] = useState(false);
  const [driverPending, setDriverPending] = useState(false);
  if (selection.reveal !== revealPendingRequest) {
    const pendingView = access.office && officePending ? "office" : access.driver && driverPending ? "driver" : null;
    setSelection({ view: pendingView ?? selectedView, reveal: revealPendingRequest });
  }
  usePendingChanges(access.office && officePending || access.driver && driverPending, onPendingChangesChange);
  const id = useId();
  if (!access.office && !access.driver) return null;

  const view = access[selectedView] ? selectedView : access.office ? "office" : "driver";
  const views = (["office", "driver"] as const).filter(candidate => access[candidate]);
  const select = (next: TowingView) => {
    setSelection(current => ({ ...current, view: next }));
    setVisitedViews(current => current.includes(next) ? current : [...current, next]);
  };
  const Icon = access.office ? BookOpen : Truck;

  return <section className={styles.module} aria-labelledby={`${id}-title`}>
    <div className={styles.moduleHeader}>
      <div className={styles.moduleIdentity}>
        <span className={styles.moduleIcon}><Icon size={22} aria-hidden="true" /></span>
        <div>
          <h1 id={`${id}-title`} className={styles.moduleTitle}>{access.office ? "Kniha odťahov" : "Moje odťahy"}</h1>
          <p className={styles.subtitle}>{access.office ? "Zákazky odťahovej služby, kontrola výkonov a financie." : "Vaše pridelené odťahy, fotografie a odovzdanie práce."}</p>
        </div>
      </div>
      {views.length > 1 && <nav className={styles.moduleViews} aria-label="Pohľady odťahov">
        {views.map(candidate => <button key={candidate} type="button" aria-current={view === candidate ? "page" : undefined} aria-controls={`${id}-${candidate}`} onClick={() => select(candidate)}>
          {candidate === "office" ? "Kancelária" : "Moje odťahy"}
        </button>)}
      </nav>}
    </div>
    {views.filter(candidate => visitedViews.includes(candidate) || candidate === view).map(candidate => <div key={candidate} id={`${id}-${candidate}`} className={styles.moduleView} hidden={candidate !== view}>
      <TowingWorkspace view={candidate} embedded initialOrderId={initialOrderId} sourceCaseId={candidate === "office" ? sourceCaseId : undefined} onPendingChangesChange={candidate === "office" ? setOfficePending : setDriverPending} />
    </div>)}
  </section>;
}
