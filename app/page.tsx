import { redirect } from "next/navigation";

/** Entry point: the proxy has already guaranteed a session before we get here. */
export default function HomePage() {
  redirect("/dashboard");
}
