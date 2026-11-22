import { redirect } from "next/navigation";

/** /phases has no page of its own and opens the progress page. */
export default function Page() {
  redirect("/progress");
}
