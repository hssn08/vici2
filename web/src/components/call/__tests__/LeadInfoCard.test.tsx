import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeadInfoCard } from "../LeadInfoCard";
import { useCallStore } from "@/lib/stores/call";

const mockLead = {
  id: "lead-1",
  firstName: "John",
  lastName: "Smith",
  title: "Mr.",
  phoneE164: "+14155550142",
  phoneAlt: "+14155550143",
  email: "john@example.com",
  address1: "1234 Main St",
  city: "Berkeley",
  state: "CA",
  postalCode: "94703",
  dateOfBirth: "1972-03-14",
  vendorLeadCode: "WEB-2026",
  status: "NEW",
  calledCount: 0,
  tzOffsetMin: -420, // PDT
  listName: "SOLAR-WEB-Q2",
  customData: { policy_number: "POL-123", notes: "test" },
};

describe("LeadInfoCard", () => {
  beforeEach(() => {
    useCallStore.getState().clearCall();
  });

  it("renders no lead message when lead is null", () => {
    render(<LeadInfoCard />);
    expect(screen.getByText(/No lead info available/)).toBeInTheDocument();
  });

  it("renders full name with title", () => {
    useCallStore.setState({ lead: mockLead });
    render(<LeadInfoCard />);
    expect(screen.getByText("Mr. John Smith")).toBeInTheDocument();
  });

  it("formats US phone number", () => {
    useCallStore.setState({ lead: mockLead });
    render(<LeadInfoCard />);
    expect(screen.getByText("+1 (415) 555-0142")).toBeInTheDocument();
  });

  it("shows status and called count", () => {
    useCallStore.setState({ lead: mockLead });
    render(<LeadInfoCard />);
    expect(screen.getByText("NEW")).toBeInTheDocument();
    expect(screen.getByText("0×")).toBeInTheDocument();
  });

  it("shows custom fields disclosure", () => {
    useCallStore.setState({ lead: mockLead });
    render(<LeadInfoCard />);
    expect(screen.getByText(/Custom fields \(2\)/)).toBeInTheDocument();
  });

  it("shows recording OFF when campaign is NEVER", () => {
    useCallStore.setState({
      lead: mockLead,
      campaign: {
        id: 1, name: "Test", recording_mode: "NEVER",
        wrapup_seconds: 60, hangup_grace_seconds: 5,
        hot_keys_active: true, webform_url: null,
      },
      recording: "off",
      consent: null,
    });
    render(<LeadInfoCard />);
    expect(screen.getByText(/Recording: OFF — campaign config/)).toBeInTheDocument();
  });

  it("shows missing fields gracefully", () => {
    useCallStore.setState({
      lead: { id: "l2", phoneE164: "+14155550000" },
    });
    render(<LeadInfoCard />);
    // Should render without crashing
    expect(screen.getByText("+1 (415) 555-0000")).toBeInTheDocument();
  });
});
