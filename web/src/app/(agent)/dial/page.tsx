"use client";

import { DialShell } from "@/components/dial/DialShell";
import { DialWsSubscriber } from "@/components/dial/DialWsSubscriber";

export default function DialPage(): React.ReactElement {
  return (
    <>
      {/* WS subscriber: drives store from server-push events */}
      <DialWsSubscriber />
      {/* Main pre-call UI */}
      <DialShell />
    </>
  );
}
