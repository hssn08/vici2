// CampaignCard + DropGauge unit tests — S01 supervisor dashboard.
//
// Tests: KPI rendering, drop gauge color thresholds, gated state.
//
// S01 PLAN §10.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CampaignCard } from "@/components/sup/CampaignCard.js";
import { DropGauge } from "@/components/sup/DropGauge.js";
import type { CampaignMetrics } from "@/lib/stores/dashboard.js";

function makeCampaign(overrides: Partial<CampaignMetrics> = {}): CampaignMetrics {
  return {
    campaignId: 1,
    campaignName: "Test Campaign",
    dialLevel: 2.0,
    inFlight: 5,
    agentsReady: 3,
    agentsWaiting: 1,
    queueDepth: 0,
    leadsCallable: 500,
    dropPct30d: 1.0,
    dropGated: false,
    ...overrides,
  };
}

// ─── DropGauge ───────────────────────────────────────────────────────────────

describe("DropGauge", () => {
  it("renders the drop percentage", () => {
    render(<DropGauge pct={1.23} gated={false} />);
    expect(screen.getByText(/1\.23%/)).toBeInTheDocument();
  });

  it("shows GATED label when gated=true", () => {
    render(<DropGauge pct={3.5} gated={true} />);
    expect(screen.getByText(/GATED/)).toBeInTheDocument();
  });

  it("applies green styling when pct < 1.5", () => {
    const { container } = render(<DropGauge pct={0.8} gated={false} />);
    // The progress bar div should have a green class.
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.className).toMatch(/bg-green-500/);
  });

  it("applies amber styling when 1.5 <= pct < 3", () => {
    const { container } = render(<DropGauge pct={2.1} gated={false} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.className).toMatch(/bg-amber-500/);
  });

  it("applies red styling when pct >= 3", () => {
    const { container } = render(<DropGauge pct={3.2} gated={false} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.className).toMatch(/bg-red-500/);
  });

  it("applies red styling when gated regardless of pct", () => {
    const { container } = render(<DropGauge pct={0.5} gated={true} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.className).toMatch(/bg-red-500/);
  });

  it("caps bar width at 100% even when pct > 3", () => {
    const { container } = render(<DropGauge pct={9} gated={false} />);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement | null;
    const width = parseFloat(bar?.style.width ?? "0");
    expect(width).toBeLessThanOrEqual(100);
  });

  it("sets correct aria attributes on the progress bar", () => {
    const { container } = render(<DropGauge pct={1.8} gated={false} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("1.8");
    expect(bar?.getAttribute("aria-valuemin")).toBe("0");
    expect(bar?.getAttribute("aria-valuemax")).toBe("3");
  });
});

// ─── CampaignCard ─────────────────────────────────────────────────────────────

describe("CampaignCard", () => {
  it("renders the campaign name", () => {
    render(<CampaignCard metrics={makeCampaign({ campaignName: "My Campaign" })} />);
    expect(screen.getByText("My Campaign")).toBeInTheDocument();
  });

  it("renders all KPI rows", () => {
    render(
      <CampaignCard
        metrics={makeCampaign({
          dialLevel: 1.8,
          inFlight: 12,
          agentsReady: 3,
          agentsWaiting: 1,
          queueDepth: 4,
          leadsCallable: 2480,
        })}
      />,
    );

    expect(screen.getByText("Dial level")).toBeInTheDocument();
    expect(screen.getByText("1.8")).toBeInTheDocument();
    expect(screen.getByText("In-flight")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Agents ready")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Agents waiting")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("Queue depth")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Leads callable")).toBeInTheDocument();
    expect(screen.getByText("2,480")).toBeInTheDocument();
  });

  it("shows GATED badge when dropGated=true", () => {
    render(<CampaignCard metrics={makeCampaign({ dropGated: true, dropPct30d: 3.5 })} />);
    // Badge in the card header.
    expect(screen.getAllByText(/GATED/).length).toBeGreaterThan(0);
  });

  it("does NOT show GATED badge when dropGated=false", () => {
    render(<CampaignCard metrics={makeCampaign({ dropGated: false, dropPct30d: 1.0 })} />);
    // "GATED" badge in the card header should be absent.
    // Note: DropGauge percentage text won't say "GATED" when gated=false.
    const badges = screen.queryAllByText("GATED");
    expect(badges).toHaveLength(0);
  });

  it("renders the embedded DropGauge with the correct percentage", () => {
    render(<CampaignCard metrics={makeCampaign({ dropPct30d: 2.75 })} />);
    expect(screen.getByText(/2\.75%/)).toBeInTheDocument();
  });
});
