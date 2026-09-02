import Link from "next/link";

export const metadata = {
  title: "Bez pripojenia",
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-100 p-5 text-zinc-950">
      <section className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-[#FCD703] text-lg font-black">PM</div>
        <h1 className="mt-5 text-xl font-bold">Nie si pripojený k internetu</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Dispečing zámerne neukladá prípady ani údaje klientov do offline cache. Po obnovení spojenia stránku načítaj znova.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex h-10 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white transition hover:bg-zinc-800"
        >
          Skúsiť znova
        </Link>
      </section>
    </main>
  );
}
