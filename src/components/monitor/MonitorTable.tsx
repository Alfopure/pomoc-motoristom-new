import type { ReactNode } from "react";

export function MonitorTable({ headers, rows, caption }: {
  headers: string[];
  rows: { key: string; cells: ReactNode[]; selected?: boolean }[];
  caption?: string;
}) {
  return <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[600px] text-left text-xs">
    {caption && <caption className="pb-2 text-left font-semibold">{caption}</caption>}
    <thead><tr>{headers.map(label => <th key={label} className="border-b border-zinc-200 p-2 font-medium text-zinc-500">{label}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.key} className={row.selected ? "bg-yellow-50" : undefined}>{row.cells.map((cell, index) => <td key={index} className="border-b border-zinc-100 p-2">{cell}</td>)}</tr>)}</tbody>
  </table></div>;
}
