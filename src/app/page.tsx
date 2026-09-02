import { connection } from "next/server";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { DispatchConsole } from "@/components/dispatch/DispatchConsole";
import { loadDispatchData } from "@/data/dispatch-repository";
import { getDefaultMotoristAuthState } from "@/server/api-auth";

export default async function Home() {
  await connection();
  const authState = await getDefaultMotoristAuthState();

  if (!authState.authorized) {
    return <MotoristLogin message={authState.message} />;
  }

  const dispatchData = await loadDispatchData();

  return (
    <DispatchConsole
      initialData={dispatchData}
      viewerOrganizationId={authState.profile?.organizationId}
      viewerProfileId={authState.profile?.profileId}
    />
  );
}
