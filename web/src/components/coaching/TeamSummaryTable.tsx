"use client";

/**
 * TeamSummaryTable — team avg score table for supervisor dashboard.
 * S05 PLAN §8.3
 */

import * as React from "react";
import { ScoreDisplay } from "./ScoreDisplay";

interface AgentRow {
  agent_id: number;
  agent_name: string;
  avg_score: number | null;
  eval_count: number;
}

interface TeamSummaryTableProps {
  agents: AgentRow[];
  isLoading?: boolean;
}

export function TeamSummaryTable({
  agents,
  isLoading = false,
}: TeamSummaryTableProps): React.ReactElement {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-gray-400">
        Loading team summary…
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-gray-400">
        No data for selected period.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label="Team scorecard summary">
        <thead>
          <tr className="border-b border-gray-200">
            <th scope="col" className="py-2 pr-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Agent
            </th>
            <th scope="col" className="py-2 pr-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Avg Score
            </th>
            <th scope="col" className="py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Evals
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {agents.map((row) => (
            <tr key={row.agent_id} className="hover:bg-gray-50 transition-colors">
              <td className="py-2.5 pr-4 text-gray-900">{row.agent_name}</td>
              <td className="py-2.5 pr-4 text-right">
                <ScoreDisplay score={row.avg_score} />
              </td>
              <td className="py-2.5 text-right text-gray-500">{row.eval_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
