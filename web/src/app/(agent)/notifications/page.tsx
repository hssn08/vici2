import type * as React from "react";
import { NotificationsPage } from "@/components/notifications/NotificationsPage";

export const metadata = {
  title: "Notifications — vici2",
};

export default function NotificationsRoute(): React.ReactElement {
  return <NotificationsPage />;
}
