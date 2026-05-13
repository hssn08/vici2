import { redirect } from "next/navigation";

// Root path defers to middleware-driven role routing. Without a session
// the middleware will bounce to /login; with one it sends to the role home.
export default function RootRedirect(): never {
  redirect("/home");
}
