import { connection } from "next/server";
import { layoutPreviewEnabled } from "@/components/dispatch/layout-preview-policy";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { DispatchConsole } from "@/components/dispatch/DispatchConsole";
import { loadDispatchData } from "@/data/dispatch-repository";
import { getDefaultMotoristAuthState } from "@/server/api-auth";
import { getAppVersion } from "@/server/app-version";
import { getAppRelease } from "@/server/app-release";

export default async function Home() {
  await connection();
  const authState = await getDefaultMotoristAuthState();
  const appRelease = getAppRelease();

  if (!authState.authorized) {
    return <MotoristLogin message={authState.message} appRelease={appRelease} />;
  }

  const dispatchData = await loadDispatchData(authState.profile ? { organizationId: authState.profile.organizationId, profileId: authState.profile.profileId } : undefined, { attendance: false, history: false });

  return (
    <DispatchConsole
      appVersion={getAppVersion()}
      appRelease={appRelease}
      layoutPreviewEnabled={layoutPreviewEnabled(process.env)}
      initialData={dispatchData}
      viewerDisplayName={authState.profile?.displayName}
      viewerEmail={authState.profile?.email}
      viewerOrganizationId={authState.profile?.organizationId}
      viewerProfileId={authState.profile?.profileId}
      viewerRole={authState.profile?.role}
    />
  );
}
