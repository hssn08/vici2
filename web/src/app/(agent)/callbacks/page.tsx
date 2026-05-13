import * as React from "react";
import { CallbackListClient } from "@/components/call/CallbackList";

export const metadata = { title: "Callbacks" };

export default function CallbacksPage(): React.ReactElement {
  return <CallbackListClient />;
}
