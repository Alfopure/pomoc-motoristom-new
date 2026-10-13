import Link from "next/link";

export function TowingUnavailable({ message }: { message: string }) {
  return <main className="mx-auto max-w-lg p-6 pt-20"><h1 className="text-2xl font-bold">Zákazky sú nedostupné</h1><p className="my-5 text-zinc-600">{message}</p><Link className="inline-flex min-h-11 items-center rounded-lg bg-yellow-400 px-5 font-semibold text-black" href="/">Vstup do aplikácie</Link></main>;
}
