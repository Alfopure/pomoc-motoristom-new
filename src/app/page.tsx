import { connection } from "next/server";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { DispatchConsole } from "@/components/dispatch/DispatchConsole";
import { loadDispatchData } from "@/data/dispatch-repository";
import { getDefaultMotoristAuthState } from "@/server/api-auth";
import { getAppVersion } from "@/server/app-version";

export default async function Home() {
  await connection();
  const authState = await getDefaultMotoristAuthState();

  if (!authState.authorized) {
    return <MotoristLogin message={authState.message} />;
  }

  const dispatchData = await loadDispatchData(authState.profile ? { organizationId: authState.profile.organizationId, profileId: authState.profile.profileId } : undefined, { attendance: false, history: false });

  return (
    <DispatchConsole
      appVersion={getAppVersion()}
      initialData={dispatchData}
      viewerDisplayName={authState.profile?.displayName}
      viewerEmail={authState.profile?.email}
      viewerOrganizationId={authState.profile?.organizationId}
      viewerProfileId={authState.profile?.profileId}
      viewerRole={authState.profile?.role}
    />
  );
}
