import LocationShareClient from "./LocationShareClient";

export default async function LocationSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return <LocationShareClient token={token} />;
}
